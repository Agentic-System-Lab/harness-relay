import type { OAuthProviderId, OAuthUse } from '../../shared/types';
import { CONFIG } from '../config';
import { discoverCalendars } from '../connectors/caldav';
import { graphCalendars } from '../connectors/graph';

/*
 * The providers whose accounts sign in with OAuth, as descriptions rather than a class each: where
 * their sign-in is, the app (client) Harness Relay signs in with, the flows they allow, the scopes each
 * use asks for, and the only hosts their access tokens are sent to. What uses the token (Graph, CalDAV)
 * stays in its connector (`connectors/graph.ts`, `connectors/caldav.ts`), behind the calendar tools.
 * Adding a provider is a description here and a test.
 */

/**
 * How a sign-in comes back: the provider's page sends the browser to a redirect address on this
 * computer (an authorization code with PKCE, RFC 8252), or, on another device, the user types a code
 * at the provider's address while Harness Relay asks the provider (the device code flow, RFC 8628).
 */
export type OAuthFlow = 'loopback' | 'device';

/** A request with an account's access token: only to its provider's hosts, never following a redirect (`TokenBroker.fetch`). */
export type AuthorizedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Why an account's token could not be had: it needs signing in again, it is gone, its refresh token
 * cannot be read, or the provider could not renew it now. Told apart from what the service it is for
 * answered, so that nothing falls back over it (Google's primary calendar, say): the account says so.
 */
export class OAuthSignInError extends Error {}

/** Who an account is, from its provider: its id there (which never changes), its address and name. */
export interface OAuthIdentity {
  subject: string;
  email: string;
  name?: string;
}

/**
 * Where a sign-in signs in, and what its tokens are for: a provider's accounts (`AccountProvider`), or a
 * tool library MCP server's own sign-in (`mcp`), whose description is built from what the server and its
 * authorization server publish (`oauth/mcp.ts`). The sign-ins (`signin.ts`) and the token broker
 * (`broker.ts`) take either.
 */
export interface OAuthProvider {
  id: OAuthProviderId | 'mcp';
  label: string;
  endpoints: { authorize: string; token: string; revoke?: string; device?: string };
  clientId: string;
  /** Google's "secret" for a desktop app, which is not one (it ships with the app); none for Microsoft's public clients. */
  clientSecret?: string;
  /** The client secret goes in an `Authorization: Basic` header (`client_secret_basic`) rather than in the form. */
  clientSecretBasic?: boolean;
  flows: OAuthFlow[];
  scopes(uses: readonly OAuthUse[]): string[];
  /** The only hosts (with their port when not the usual one) the access token is sent to. */
  hosts: string[];
  /** What the sign-in page is asked for besides the usual: Google's refresh token (`access_type=offline`), an MCP server's `resource`. */
  extraParams?: Record<string, string>;
  /** What every token request sends besides the usual: an MCP server's `resource` (RFC 8707). */
  tokenParams?: Record<string, string>;
  /** The refresh asks for the scopes again (Microsoft: a token for which resource). */
  refreshWithScopes?: boolean;
  /**
   * A sign-in that brings no refresh token is kept all the same (an MCP server's authorization server
   * may give none): its access token works until it expires, and it then needs a new sign-in.
   */
  refreshOptional?: boolean;
}

/** A provider whose accounts sign in (Microsoft, Google): who signed in, and their calendars. */
export interface AccountProvider extends OAuthProvider {
  id: OAuthProviderId;
  whoami(fetch: AuthorizedFetch): Promise<OAuthIdentity>;
  /** Its calendars, by name, at the addresses the calendar tools use. */
  calendars(fetch: AuthorizedFetch, email: string): Promise<{ name: string; url: string }[]>;
  /** The calendar a new sign-in for the calendar tools adds by itself. */
  defaultCalendar(email: string): { name: string; url: string };
  /** Where the user takes the app's access away, for a provider that cannot revoke one token (Microsoft). */
  permissionsPages?: string[];
}

/** The app a provider is signed in to with: its id and, for Google, its secret; Microsoft's tenant. */
export interface OAuthClient {
  clientId: string;
  tenant?: string;
  secret?: string;
}

/**
 * Harness Relay's own apps, registered once and shipped in the code, by provider; none is registered
 * yet, so each user gives their own (Settings → Tool library). A Microsoft Entra app for work, school
 * and personal accounts, a public client (no secret), is what would go here.
 */
export const BUILT_IN_CLIENTS: Partial<Record<OAuthProviderId, string>> = {};

/** The host a URL's token may go to: its host, with its port when that is not the usual one. */
export function tokenHost(url: string): string {
  return new URL(url).host.toLowerCase();
}

/** The scopes the uses ask for besides signing in (Calendar's, for the calendar tools). */
export function useScopes(provider: OAuthProvider, uses: readonly OAuthUse[]): string[] {
  const signIn = new Set(provider.scopes([]));
  return provider.scopes(uses).filter((s) => !signIn.has(s));
}

/**
 * Those of `needed` a token answer's `scope` (space-separated) does not grant. Compared by name,
 * without case, on the last part of the path: Microsoft names Graph's scopes there with or without
 * their resource (`https://graph.microsoft.com/Calendars.ReadWrite`, `Calendars.ReadWrite`).
 */
export function missingScopes(needed: readonly string[], granted: string): string[] {
  const name = (s: string) => s.toLowerCase().split('/').pop() ?? '';
  const have = new Set(granted.split(/\s+/).filter(Boolean).map(name));
  return needed.filter((s) => !have.has(name(s)));
}

const GLOBAL_GRAPH = 'https://graph.microsoft.com';

/** Microsoft's sign-in and Graph: the global cloud's, or those the environment sets (`config.ts`). */
function microsoftUrls(): { login: string; graph: string } {
  return { login: CONFIG.microsoftLoginUrl ?? 'https://login.microsoftonline.com', graph: CONFIG.microsoftGraphUrl ?? GLOBAL_GRAPH };
}

/** Microsoft 365 and Outlook.com: Microsoft Entra's sign-in (`urls`: another cloud's, or a stand-in's), and Graph. */
export function microsoftProvider(client: OAuthClient, urls = microsoftUrls()): AccountProvider {
  const { login, graph } = urls;
  const tenant = encodeURIComponent(client.tenant?.trim() || 'common');
  // Graph's scopes by their short names in the global cloud; in another, by its own address.
  const graphScope = (name: string) => (graph === GLOBAL_GRAPH ? name : `${graph}/${name}`);
  return {
    id: 'microsoft',
    label: 'Microsoft',
    endpoints: {
      authorize: `${login}/${tenant}/oauth2/v2.0/authorize`,
      token: `${login}/${tenant}/oauth2/v2.0/token`,
      device: `${login}/${tenant}/oauth2/v2.0/devicecode`,
    },
    clientId: client.clientId,
    flows: ['loopback', 'device'],
    scopes: (uses) => [
      'openid',
      'email',
      'profile',
      'offline_access',
      graphScope('User.Read'),
      ...(uses.includes('calendar') ? [graphScope('Calendars.ReadWrite')] : []),
    ],
    hosts: [tokenHost(graph)],
    extraParams: { prompt: 'select_account' },
    refreshWithScopes: true,
    whoami: async (fetch) => {
      const res = await fetch(`${graph}/v1.0/me?$select=id,displayName,mail,userPrincipalName`);
      if (!res.ok) throw new Error(`Microsoft Graph answered ${res.status} for the signed-in account`);
      const me = (await res.json()) as { id?: string; displayName?: string; mail?: string | null; userPrincipalName?: string };
      if (!me.id) throw new Error('Microsoft Graph did not say who signed in');
      return { subject: me.id, email: me.mail || me.userPrincipalName || me.id, ...(me.displayName ? { name: me.displayName } : {}) };
    },
    // Its own calendar at the address a new sign-in adds it as (`defaultCalendar`), so it is listed as added.
    calendars: (fetch) => graphCalendars(fetch, graph),
    defaultCalendar: () => ({ name: 'Calendar', url: `${graph}/v1.0/me/calendar` }),
    permissionsPages: ['https://myapps.microsoft.com', 'https://account.live.com/consent/Manage'],
  };
}

/** Where Google's sign-in, its userinfo and its CalDAV are. */
export interface GoogleUrls {
  authorize: string;
  token: string;
  revoke: string;
  userinfo: string;
  /** CalDAV's base: a calendar is `<caldav>/<its id>/events/`, an account's principal `<caldav>/<address>/user`. */
  caldav: string;
}

const GOOGLE: GoogleUrls = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  caldav: 'https://apidata.googleusercontent.com/caldav/v2',
};

/** Google Calendar: Google's sign-in, and its CalDAV with the token (`urls`: a stand-in's, in tests). */
export function googleProvider(client: OAuthClient, urls: GoogleUrls = GOOGLE): AccountProvider {
  const defaultCalendar = (email: string) => ({ name: email, url: `${urls.caldav}/${encodeURIComponent(email)}/events/` });
  return {
    id: 'google',
    label: 'Google',
    endpoints: { authorize: urls.authorize, token: urls.token, revoke: urls.revoke },
    clientId: client.clientId,
    ...(client.secret ? { clientSecret: client.secret } : {}),
    // Google's device flow takes a short list of scopes, without Calendar's.
    flows: ['loopback'],
    scopes: (uses) => ['openid', 'email', 'profile', ...(uses.includes('calendar') ? ['https://www.googleapis.com/auth/calendar'] : [])],
    hosts: [...new Set([tokenHost(urls.caldav), tokenHost(urls.userinfo)])],
    // A refresh token every time, also for an account that signed in before.
    extraParams: { access_type: 'offline', prompt: 'consent' },
    whoami: async (fetch) => {
      const res = await fetch(urls.userinfo);
      if (!res.ok) throw new Error(`Google answered ${res.status} for the signed-in account`);
      const me = (await res.json()) as { sub?: string; email?: string; name?: string };
      if (!me.sub || !me.email) throw new Error('Google did not say who signed in');
      return { subject: me.sub, email: me.email, ...(me.name ? { name: me.name } : {}) };
    },
    // Its CalDAV with the token: the calendars its principal lists, or the primary one when it lists none
    // or cannot be read so. Never over the sign-in's own trouble: an account that needs a new one says so.
    calendars: async (fetch, email) => {
      const primary = defaultCalendar(email);
      try {
        const found = await discoverCalendars(`${urls.caldav}/${encodeURIComponent(email)}/user`, { fetch });
        return found.length ? found : [primary];
      } catch (err) {
        if (err instanceof OAuthSignInError) throw err;
        return [primary];
      }
    },
    defaultCalendar,
  };
}

/** A provider's description, with the app it signs in with. */
export function oauthProvider(id: OAuthProviderId, client: OAuthClient): AccountProvider {
  return id === 'microsoft' ? microsoftProvider(client) : googleProvider(client);
}
