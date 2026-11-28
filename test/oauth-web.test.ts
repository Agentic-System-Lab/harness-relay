/*
 * Accounts that sign in with OAuth, in the page (`src/web/oauth.ts`): the redirect addresses a
 * provider's app must allow, what the provider's page sent back to /oauth/callback and what that page
 * does with the server's answer (an account's sign-in or an MCP server's), the name an account's calendar
 * gets, when a sign-in page that did not open was blocked, what each account offers for calendars and
 * mail, the uses a new sign-in asks for, what an MCP server's row says of its sign-in, what it asks
 * before a page elsewhere opens, and when its form says that a change signs it out.
 */
import { describe, expect, it } from 'vitest';
import {
  accountActions,
  accountServices,
  calendarName,
  callbackFrom,
  callbackBack,
  callbackOutcome,
  confirmLines,
  mcpSignInLine,
  redirectAddresses,
  sameServerUrl,
  sayPopupBlocked,
  toggleUse,
  waiting,
} from '../src/web/oauth';
import { isAppWindow } from '../src/web/update';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

describe('signing in with OAuth, in the page', () => {
  it("names the redirect addresses Microsoft's app must allow (no port: it takes any on this computer), and none for Google", () => {
    expect(redirectAddresses('microsoft', 'http://127.0.0.1:8787')).toEqual([
      'http://127.0.0.1/oauth/callback',
      'http://localhost/oauth/callback',
    ]);
    expect(redirectAddresses('microsoft', 'http://[::1]:8787')).toEqual(['http://localhost/oauth/callback']);
    expect(redirectAddresses('microsoft', 'http://localhost:5173')).toEqual(['http://localhost/oauth/callback']);
    // A page on another computer comes back to localhost here, its address pasted then.
    expect(redirectAddresses('microsoft', 'https://relay-8787.app.github.dev')).toEqual(['http://localhost/oauth/callback']);
    expect(redirectAddresses('google', 'http://127.0.0.1:8787')).toEqual([]);
  });

  it('reads the code and state the provider sent back, or its error, and the issuer it names', () => {
    expect(callbackFrom('?code=abc&state=xyz&session_state=1')).toEqual({ code: 'abc', state: 'xyz' });
    expect(callbackFrom('?error=access_denied&error_description=The+user+said+no&state=xyz')).toEqual({
      state: 'xyz',
      error: 'access_denied: The user said no',
    });
    expect(callbackFrom('')).toEqual({});
    // RFC 9207: forwarded for the server to check, even empty (it is then not the sign-in's issuer).
    expect(callbackFrom('?code=abc&state=xyz&iss=https%3A%2F%2Faccounts.google.com')).toEqual({
      code: 'abc',
      state: 'xyz',
      iss: 'https://accounts.google.com',
    });
    expect(callbackFrom('?code=abc&state=xyz&iss=').iss).toBe('');
    // A long error is capped.
    expect(callbackFrom(`?error=${'e'.repeat(500)}&error_description=${'d'.repeat(500)}`).error).toBe(
      `${'e'.repeat(100)}: ${'d'.repeat(300)}`,
    );
  });

  it('leads the callback page back to the row of Settings the sign-in was for', () => {
    // A server Common apps added: its row there; another library server: the library's MCP servers.
    expect(callbackBack({ ok: true, status: 'done', server: 'notion', app: 'notion' })).toBe('/#/settings/apps/notion');
    expect(callbackBack({ ok: true, status: 'failed', server: 'heptabase', app: 'heptabase', error: 'x' })).toBe(
      '/#/settings/apps/heptabase',
    );
    expect(callbackBack({ ok: true, status: 'done', server: 'linear' })).toBe('/#/settings/tools/mcp');
    // An account, or a sign-in this server does not know: Common apps.
    expect(callbackBack({ ok: true, status: 'done', email: 'ming@contoso.com' })).toBe('/#/settings/apps');
    expect(callbackBack({ ok: false, httpStatus: 404, error: 'No such sign-in' })).toBe('/#/settings/apps');
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

  it('names all services affected by disconnecting each provider’s account in both languages', () => {
    const google = { provider: 'google', uses: ['calendar', 'mail', 'drive', 'documents'] } as const;
    const microsoft = { provider: 'microsoft', uses: ['calendar', 'mail', 'teams'] } as const;
    for (const [messages, googleLabels, msLabels] of [
      [en, ['Google Calendar', 'Gmail', 'Google Drive', 'Google Docs editing'], ['Outlook calendar', 'Outlook mail', 'Microsoft Teams']],
      [zhTW, ['Google Calendar', 'Gmail', 'Google Drive', 'Google 文件編輯'], ['Outlook 行事曆', 'Outlook 郵件', 'Microsoft Teams']],
    ] as const) {
      for (const [account, labels] of [
        [google, googleLabels],
        [microsoft, msLabels],
      ] as const) {
        expect(accountServices({ provider: account.provider, uses: [...account.uses] }, messages)).toBe(
          labels.join(messages.common.listSeparator),
        );
      }
    }
  });

  it('offers each account its calendars or a sign-in for them, and for mail a sign-in, its mail account to add, or nothing once there', () => {
    // A sign-in for a use not granted asks for those it has too, so that none is left without its grant.
    expect(accountActions({ uses: ['calendar'], status: 'connected' }, false)).toEqual({
      calendars: true,
      signInFor: [{ use: 'mail', uses: ['calendar', 'mail'] }],
      addMail: false,
    });
    expect(accountActions({ uses: ['mail'], status: 'connected' }, true)).toEqual({
      calendars: false,
      signInFor: [{ use: 'calendar', uses: ['calendar', 'mail'] }],
      addMail: false,
    });
    // Signed in for mail, its mail account removed since (or not added): added again without a sign-in.
    expect(accountActions({ uses: ['calendar', 'mail'], status: 'connected' }, false)).toEqual({
      calendars: true,
      signInFor: [],
      addMail: true,
    });
    expect(accountActions({ uses: ['calendar', 'mail'], status: 'connected' }, true)).toEqual({
      calendars: true,
      signInFor: [],
      addMail: false,
    });
    // Needing a new sign-in: only Sign in again, for the uses it has (no sign-in for another use, no mail account to add).
    expect(accountActions({ uses: ['calendar'], status: 'reauth' }, false)).toEqual({
      calendars: true,
      signInAgain: ['calendar'],
      signInFor: [],
      addMail: false,
    });
    expect(accountActions({ uses: ['mail', 'calendar'], status: 'reauth' }, false)).toEqual({
      calendars: true,
      signInAgain: ['calendar', 'mail'],
      signInFor: [],
      addMail: false,
    });
  });

  it('keeps the uses a new sign-in asks for in their usual order, each once', () => {
    expect(toggleUse(['calendar'], 'mail', true)).toEqual(['calendar', 'mail']);
    expect(toggleUse(['mail'], 'calendar', true)).toEqual(['calendar', 'mail']);
    expect(toggleUse(['calendar', 'mail'], 'calendar', false)).toEqual(['mail']);
    expect(toggleUse(['mail'], 'mail', true)).toEqual(['mail']);
    expect(toggleUse(['mail'], 'mail', false)).toEqual([]);
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

  it('says where a sign-in page elsewhere is, and its token endpoint, before it opens', () => {
    expect(confirmLines({ host: 'linear.app', issuer: 'evil.example' }, en)).toEqual([
      'You will sign in at linear.app, which is not evil.example.',
    ]);
    expect(confirmLines({ host: 'evil.example', issuer: 'evil.example', tokenHost: 'tokens.example' }, en)).toEqual([
      'The sign-in is finished at tokens.example, which is not evil.example.',
    ]);
    expect(confirmLines({ host: 'linear.app', issuer: 'evil.example', tokenHost: 'tokens.example' }, zhTW)).toEqual([
      '你會在 linear.app 登入，它不是 evil.example。',
      '登入會在 tokens.example 完成，它不是 evil.example。',
    ]);
  });

  it("tells a signed-in server's new URL from the same one written otherwise", () => {
    expect(sameServerUrl('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/')).toBe(true);
    expect(sameServerUrl('HTTPS://MCP.Example.com:443/mcp#x', ' https://mcp.example.com/mcp ')).toBe(true);
    expect(sameServerUrl('https://mcp.example.com/mcp', 'https://mcp.example.com/v2/mcp')).toBe(false);
    expect(sameServerUrl('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp?team=1')).toBe(false);
    expect(sameServerUrl('not a url', 'not a url ')).toBe(true);
  });
});
