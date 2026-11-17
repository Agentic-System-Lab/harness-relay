// Accounts that sign in with OAuth, in the page, without React: the redirect addresses a provider's
// app must allow, what the provider's page sent back to /oauth/callback, and a sign-in's next step.

import type { OAuthAccountView, OAuthProviderId, OAuthSignInView } from '../shared/types';

/** Where the provider's page sends the browser back: this web app's own page for it. */
export const CALLBACK_PATH = '/oauth/callback';

/**
 * The redirect addresses a provider's app must allow, for a page at `origin`: Microsoft takes any port
 * on this computer for a desktop app's (so none is written), and its own host's, as the page is
 * reached (`localhost` or `127.0.0.1`), plus `localhost`'s, which a browser on another computer goes
 * to (its address is then pasted). Google's desktop apps take any address on this computer: none.
 */
export function redirectAddresses(provider: OAuthProviderId, origin: string): string[] {
  if (provider === 'google') return [];
  const own = (() => {
    try {
      const u = new URL(origin);
      return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) ? `http://${u.hostname}${CALLBACK_PATH}` : undefined;
    } catch {
      return undefined;
    }
  })();
  return [...new Set([...(own ? [own] : []), `http://localhost${CALLBACK_PATH}`])];
}

/** What the provider's page sent the browser back with: the code and state, or its error. */
export function callbackFrom(search: string): { state?: string; code?: string; error?: string } {
  const q = new URLSearchParams(search);
  const error = q.get('error');
  return {
    ...(q.get('state') ? { state: q.get('state')! } : {}),
    ...(q.get('code') ? { code: q.get('code')! } : {}),
    ...(error ? { error: [error, q.get('error_description')].filter(Boolean).join(': ') } : {}),
  };
}

/** Whether a sign-in still waits (its page, or its code on another device). */
export function waiting(v: OAuthSignInView | undefined): boolean {
  return v?.status === 'waiting';
}

/** The name a calendar of an account gets in the calendar tools: its own, then whose it is. */
export function calendarName(account: Pick<OAuthAccountView, 'email'>, calendar: string): string {
  return `${calendar} · ${account.email}`.slice(0, 60);
}
