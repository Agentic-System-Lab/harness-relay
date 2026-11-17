// Accounts that sign in with OAuth, in the page, without React: the redirect addresses a provider's
// app must allow, what the provider's page sent back to /oauth/callback and what that page then does,
// a sign-in's next step, and whether a sign-in page that did not open was blocked.

import type { McpOAuthState, OAuthAccountView, OAuthProviderId, OAuthSignInView } from '../shared/types';
import type { Messages } from './i18n';

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

/**
 * What the provider's page sent the browser back with: the code and state, or its error (capped), and
 * the issuer it names (`iss`, RFC 9207: the server refuses one that is not the sign-in's own).
 */
export function callbackFrom(search: string): { state?: string; code?: string; error?: string; iss?: string } {
  const q = new URLSearchParams(search);
  const error = q.get('error');
  return {
    ...(q.get('state') ? { state: q.get('state')! } : {}),
    ...(q.get('code') ? { code: q.get('code')! } : {}),
    ...(error ? { error: [error.slice(0, 100), q.get('error_description')?.slice(0, 300)].filter(Boolean).join(': ') } : {}),
    ...(q.get('iss') !== null ? { iss: q.get('iss')! } : {}),
  };
}

/** What the callback page shows once the server answered: an account signed in, or a tool library MCP server (`server`). */
export type CallbackOutcome =
  | { kind: 'done'; email: string; server?: string }
  | { kind: 'failed'; error: string }
  /** No sign-in here has its state: another Harness Relay's (on another computer), or one long over. */
  | { kind: 'elsewhere' };

/** The server's answer to the callback page's post: how the sign-in went, or the error and its HTTP status. */
export type CallbackAnswer =
  | { ok: true; status: OAuthSignInView['status']; email?: string; server?: string; error?: string }
  | { ok: false; httpStatus: number; error: string };

/**
 * What the callback page shows for the server's answer, and whether its address then loses its code
 * and state: only once a sign-in here answered (done or failed). One no sign-in here has (a 404 for an
 * address with a state) keeps them, and the page shows the whole address, to paste into the Harness
 * Relay that started the sign-in; any other error keeps them too, for a reload to try again.
 */
export function callbackOutcome(answer: CallbackAnswer, hasState: boolean): { outcome: CallbackOutcome; clearAddress: boolean } {
  if (answer.ok)
    return {
      outcome:
        answer.status === 'done'
          ? { kind: 'done', email: answer.email ?? '', ...(answer.server ? { server: answer.server } : {}) }
          : { kind: 'failed', error: answer.error ?? '' },
      clearAddress: true,
    };
  if (answer.httpStatus === 404 && hasState) return { outcome: { kind: 'elsewhere' }, clearAddress: false };
  return { outcome: { kind: 'failed', error: answer.error }, clearAddress: false };
}

/**
 * Whether to say the browser blocked the sign-in page, `window.open()` having handed back no tab: not
 * in the desktop app's window (`isAppWindow()`), which opens it in the system browser and so hands
 * back none either.
 */
export function sayPopupBlocked(opened: boolean, appWindow: boolean): boolean {
  return !opened && !appWindow;
}

/** Whether a sign-in still waits (its page, or its code on another device). */
export function waiting(v: OAuthSignInView | undefined): boolean {
  return v?.status === 'waiting';
}

/** The name a calendar of an account gets in the calendar tools: its own, then whose it is. */
export function calendarName(account: Pick<OAuthAccountView, 'email'>, calendar: string): string {
  return `${calendar} · ${account.email}`.slice(0, 60);
}

/**
 * Whether two URLs name the same MCP server as the server tells them apart (its canonical URL: scheme and
 * host in lower case, no default port, no fragment, no slash at the end of its path): another one signs
 * a server out.
 */
export function sameServerUrl(a: string, b: string): boolean {
  const canonical = (url: string) => {
    try {
      const u = new URL(url.trim());
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {
      return url.trim();
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * What an MCP server's sign-in asks the user to confirm before its page opens, a line each: its page is
 * on another host than its authorization server's, and (or) its token endpoint is.
 */
export function confirmLines(confirm: NonNullable<OAuthSignInView['confirm']>, t: Messages): string[] {
  const m = t.tools.signIn;
  return [
    ...(confirm.host !== confirm.issuer ? [m.confirmPage(confirm.host, confirm.issuer)] : []),
    ...(confirm.tokenHost ? [m.confirmToken(confirm.tokenHost, confirm.issuer)] : []),
  ];
}

/**
 * What an HTTP MCP server's row says of its own sign-in: signed in (since when, in the page's language),
 * or needing a new one (and why); nothing when it has not signed in.
 */
export function mcpSignInLine(oauth: McpOAuthState | undefined, t: Messages, lang: string): { text: string; warn: boolean } | undefined {
  if (!oauth) return undefined;
  if (oauth.status === 'reauth') return { text: t.tools.signIn.needsAgain(oauth.error ?? ''), warn: true };
  const at = new Date(oauth.signedInAt).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  return { text: t.tools.signIn.signedInAt(at), warn: false };
}
