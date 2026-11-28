// Accounts that sign in with OAuth, in the page, without React: the redirect addresses a provider's
// app must allow, what the provider's page sent back to /oauth/callback and what that page then does,
// a sign-in's next step, whether a sign-in page that did not open was blocked, what each account
// offers for the calendar and mail tools, and a tool library MCP server's own sign-in.

import {
  OAUTH_USES,
  MAIL_CALENDAR_USES,
  type McpOAuthState,
  type OAuthAccountView,
  type OAuthClientView,
  type OAuthProviderId,
  type OAuthSignInView,
  type OAuthUse,
  type McpServerView,
} from '../shared/types';
import type { Messages } from './i18n';
import { itemHref, settingsHref } from './route';

/** Google desktop token exchanges need the client secret. Microsoft desktop clients use PKCE without one. */
export function oauthClientStatus(client: OAuthClientView | undefined): 'disabled' | 'ready' | 'missing' {
  if (client?.disabled) return 'disabled';
  return client?.clientId && (client.provider === 'microsoft' || client.secret) ? 'ready' : 'missing';
}

/** The services this shared sign-in will disconnect, in the order shown by the provider's account view. */
export function accountServices(account: Pick<OAuthAccountView, 'provider' | 'uses'>, t: Messages): string {
  const o = t.connectors.oauth;
  return account.uses
    .map((use) => (use === 'mail' || use === 'calendar' ? o.accountServices[account.provider][use] : o.uses[use]))
    .join(t.common.listSeparator);
}

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
      return /^(127\.0\.0\.1|localhost)$/.test(u.hostname) ? `http://${u.hostname}${CALLBACK_PATH}` : undefined;
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
  | { ok: true; status: OAuthSignInView['status']; email?: string; server?: string; app?: McpServerView['app']; error?: string }
  | { ok: false; httpStatus: number; error: string };

/**
 * Where the callback page's link back to Settings goes: a server Common apps added (Notion, Heptabase,
 * Slack) to its row there; another library server to the tool library's MCP servers; an account (or a
 * sign-in that cannot be told) to Common apps.
 */
export function callbackBack(answer: CallbackAnswer): string {
  if (answer.ok && answer.app) return '/' + itemHref(answer.app);
  return '/' + (answer.ok && answer.server ? itemHref('mcp') : settingsHref('apps'));
}

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
 * What an account offers in Settings: its calendars to list and add (signed in for calendars); a
 * sign-in for each use not granted yet, which asks for the uses it has too (a sign-in for the new one
 * alone could leave them without their grant); for mail, its mail account to add once granted (it was
 * removed, or the sign-in could not add it), nothing more once it is there. While it needs a new
 * sign-in, only that: **Sign in again**, for the uses it has.
 */
export function accountActions(
  account: Pick<OAuthAccountView, 'uses' | 'status'>,
  hasMailAccount: boolean,
): { calendars: boolean; signInAgain?: OAuthUse[]; signInFor: { use: OAuthUse; uses: OAuthUse[] }[]; addMail: boolean } {
  const has = (u: OAuthUse) => account.uses.includes(u);
  if (account.status === 'reauth')
    return { calendars: has('calendar'), signInAgain: OAUTH_USES.filter(has), signInFor: [], addMail: false };
  return {
    calendars: has('calendar'),
    signInFor: MAIL_CALENDAR_USES.filter((u) => !has(u)).map((use) => ({ use, uses: OAUTH_USES.filter((u) => u === use || has(u)) })),
    addMail: has('mail') && !hasMailAccount,
  };
}

/** The uses a new sign-in asks for, with one ticked or unticked, in their usual order. */
export function toggleUse(uses: readonly OAuthUse[], use: OAuthUse, on: boolean): OAuthUse[] {
  return OAUTH_USES.filter((u) => (u === use ? on : uses.includes(u)));
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
