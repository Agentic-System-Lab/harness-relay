/*
 * Accounts that sign in with OAuth, in the page (`src/web/oauth.ts`): the redirect addresses a
 * provider's app must allow, what the provider's page sent back to /oauth/callback, and the name an
 * account's calendar gets.
 */
import { describe, expect, it } from 'vitest';
import { calendarName, callbackFrom, redirectAddresses, waiting } from '../src/web/oauth';

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

  it("names an account's calendar after it and whose it is, and knows a sign-in that still waits", () => {
    expect(calendarName({ email: 'ming@contoso.com' }, 'Team')).toBe('Team · ming@contoso.com');
    expect(calendarName({ email: `${'x'.repeat(70)}@contoso.com` }, 'Team')).toHaveLength(60);
    expect(waiting({ id: 'a', provider: 'microsoft', status: 'waiting', expiresAt: 1 })).toBe(true);
    expect(waiting({ id: 'a', provider: 'microsoft', status: 'done', expiresAt: 1 })).toBe(false);
    expect(waiting(undefined)).toBe(false);
  });
});
