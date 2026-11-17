/*
 * Accounts that sign in with OAuth, in the page (`src/web/oauth.ts`): the redirect addresses a
 * provider's app must allow, what the provider's page sent back to /oauth/callback and what that page
 * does with the server's answer (an account's sign-in or an MCP server's), the name an account's calendar
 * gets, when a sign-in page that did not open was blocked, and what an MCP server's row says of its sign-in.
 */
import { describe, expect, it } from 'vitest';
import { calendarName, callbackFrom, callbackOutcome, mcpSignInLine, redirectAddresses, sayPopupBlocked, waiting } from '../src/web/oauth';
import { isAppWindow } from '../src/web/update';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

describe('signing in with OAuth, in the page', () => {
  it("names the redirect addresses Microsoft's app must allow (no port: it takes any on this computer), and none for Google", () => {
    expect(redirectAddresses('microsoft', 'http://127.0.0.1:8787')).toEqual([
      'http://127.0.0.1/oauth/callback',
      'http://localhost/oauth/callback',
    ]);
    expect(redirectAddresses('microsoft', 'http://localhost:5173')).toEqual(['http://localhost/oauth/callback']);
    // A page on another computer comes back to localhost here, its address pasted then.
    expect(redirectAddresses('microsoft', 'https://relay-8787.app.github.dev')).toEqual(['http://localhost/oauth/callback']);
    expect(redirectAddresses('google', 'http://127.0.0.1:8787')).toEqual([]);
  });

  it('reads the code and state the provider sent back, or its error', () => {
    expect(callbackFrom('?code=abc&state=xyz&session_state=1')).toEqual({ code: 'abc', state: 'xyz' });
    expect(callbackFrom('?error=access_denied&error_description=The+user+said+no&state=xyz')).toEqual({
      state: 'xyz',
      error: 'access_denied: The user said no',
    });
    expect(callbackFrom('')).toEqual({});
  });

  it('takes the code and state off the callback page’s address only once a sign-in here answered', () => {
    expect(callbackOutcome({ ok: true, status: 'done', email: 'ming@contoso.com' }, true)).toEqual({
      outcome: { kind: 'done', email: 'ming@contoso.com' },
      clearAddress: true,
    });
    // An MCP server's own sign-in is named by the server.
    expect(callbackOutcome({ ok: true, status: 'done', server: 'linear' }, true).outcome).toEqual({
      kind: 'done',
      email: '',
      server: 'linear',
    });
    expect(callbackOutcome({ ok: true, status: 'failed', error: 'invalid_grant' }, true)).toEqual({
      outcome: { kind: 'failed', error: 'invalid_grant' },
      clearAddress: true,
    });
    // No sign-in here has its state: another computer's Harness Relay started it. The address stays, to copy.
    expect(callbackOutcome({ ok: false, httpStatus: 404, error: 'No such sign-in' }, true)).toEqual({
      outcome: { kind: 'elsewhere' },
      clearAddress: false,
    });
    // An address with no state at all is no sign-in's; a refusal or a network error keeps the address for a reload.
    expect(callbackOutcome({ ok: false, httpStatus: 404, error: 'No such sign-in' }, false)).toEqual({
      outcome: { kind: 'failed', error: 'No such sign-in' },
      clearAddress: false,
    });
    expect(callbackOutcome({ ok: false, httpStatus: 429, error: 'Too many' }, true).clearAddress).toBe(false);
    expect(callbackOutcome({ ok: false, httpStatus: 0, error: 'Failed to fetch' }, true).clearAddress).toBe(false);
  });

  it("says a sign-in page was blocked only in a browser, not in the desktop app's window (it opens the system browser)", () => {
    const electron =
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HarnessRelay/2026.11.18 Chrome/138.0 Electron/37.2.0 Safari/537.36';
    const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';
    expect(sayPopupBlocked(false, isAppWindow(chrome))).toBe(true);
    expect(sayPopupBlocked(false, isAppWindow(electron))).toBe(false);
    expect(sayPopupBlocked(true, isAppWindow(chrome))).toBe(false);
  });

  it("names an account's calendar after it and whose it is, and knows a sign-in that still waits", () => {
    expect(calendarName({ email: 'ming@contoso.com' }, 'Team')).toBe('Team · ming@contoso.com');
    expect(calendarName({ email: `${'x'.repeat(70)}@contoso.com` }, 'Team')).toHaveLength(60);
    expect(waiting({ id: 'a', provider: 'microsoft', status: 'waiting', expiresAt: 1 })).toBe(true);
    expect(waiting({ id: 'a', provider: 'microsoft', status: 'done', expiresAt: 1 })).toBe(false);
    expect(waiting(undefined)).toBe(false);
  });

  it("says when an MCP server signed in, in the page's language, or that it needs a new sign-in and why; nothing before it signs in", () => {
    const at = Date.UTC(2026, 10, 18, 8, 30);
    expect(mcpSignInLine(undefined, en, 'en')).toBeUndefined();
    const line = mcpSignInLine({ status: 'signed-in', signedInAt: at }, en, 'en')!;
    expect(line.warn).toBe(false);
    expect(line.text).toMatch(/^Signed in on .*2026.*\.$/);
    expect(mcpSignInLine({ status: 'signed-in', signedInAt: at }, zhTW, 'zh-TW')!.text).toMatch(/2026.*登入。$/);
    expect(mcpSignInLine({ status: 'reauth', signedInAt: at, error: 'invalid_grant' }, en, 'en')).toEqual({
      text: "Its sign-in no longer works (invalid_grant): members' turns go without it until it signs in again.",
      warn: true,
    });
  });
});
