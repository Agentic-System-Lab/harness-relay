/*
 * A stand-in for Microsoft's and Google's sign-ins and what their tokens reach, on a local port, for
 * the OAuth tests. Microsoft's: an authorization server (the authorization code with PKCE checked,
 * refresh with rotation, `invalid_grant` and any other answer to a refresh, the device code flow with
 * its pending, `slow_down`, denied and expired answers) and enough of Graph for the calendar tools
 * (`/me`, `/me/calendars`, `calendarView` in pages, `POST …/events`). Google's (under `/google/` and
 * `/caldav/v2/`): its token endpoint (the client secret checked, no rotation), revoke, userinfo, and
 * CalDAV that takes only a Bearer token (discovery from the principal, `REPORT`, `PUT`). The token
 * endpoints can be held (a request in flight), or drop a request (the network failing), and the code
 * exchange can grant other scopes than asked; who signed in can be held too. Microsoft's tokens are
 * each for one resource, as its real ones are: Graph's, or Exchange Online's (`https://outlook.office.com/…`,
 * for IMAP and SMTP), as the `scope` of the code exchange or of a refresh says (the authorize request's
 * first resource when the exchange names none); a request naming both is refused, and so is a refresh
 * for scopes the user never consented to. Google's token covers every scope granted, those granted
 * before too when the sign-in asked with `include_granted_scopes`. Plain HTTP on 127.0.0.1, which
 * Harness Relay allows for a stand-in only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

export interface FakeEvent {
  id: string;
  subject: string;
  isAllDay?: boolean;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees?: { emailAddress: { address: string } }[];
  isCancelled?: boolean;
}

/** An answer of the token endpoint: its status and JSON body. */
export interface FakeAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** What a Microsoft token is for: Graph, or Exchange Online's IMAP and SMTP. */
export type FakeResource = 'graph' | 'outlook';

/** The scopes signing in itself asks for, which go with a token of any resource. */
const OIDC = new Set(['openid', 'email', 'profile', 'offline_access']);

/** The resource a list of scopes is for: one, or `mixed` (Microsoft refuses that), Graph's when none. */
export function resourceOf(scopes: string[]): FakeResource | 'mixed' {
  const own = scopes.filter((s) => !OIDC.has(s));
  const outlook = own.filter((s) => s.startsWith('https://outlook.office.com/'));
  if (outlook.length && outlook.length < own.length) return 'mixed';
  return outlook.length ? 'outlook' : 'graph';
}

export interface FakeGoogle {
  /** Its app: the client id and the secret its token endpoint checks. */
  clientId: string;
  secret: string;
  /** Where its sign-in, userinfo and CalDAV are: what `googleProvider()` takes. */
  urls: { authorize: string; token: string; revoke: string; userinfo: string; drive?: string; caldav: string };
  /** The account that signs in. */
  me: { sub: string; email: string; name: string };
  /** What CalDAV discovery finds: the account's calendars, none, or a server error. */
  calendars: 'list' | 'none' | 'fail';
  /** The iCalendar files a calendar's `REPORT` answers with. */
  events: string[];
  /** The events added (`PUT`): where, what, and with which token. */
  puts: { path: string; ics: string; bearer?: string }[];
  /** The tokens revoked. */
  revoked: string[];
  /** The scopes the account granted the app: a sign-in with `include_granted_scopes` gets them too. Delete one for a grant taken away. */
  granted: Set<string>;
}

export interface FakeOAuth {
  /** `http://127.0.0.1:<port>`: the sign-in's and Graph's base. */
  url: string;
  host: string;
  clientId: string;
  /** Every request: its method, path (and query), its form or JSON body, and its Bearer token. */
  requests: { method: string; path: string; body: string; bearer?: string }[];
  /** The provider's page, the user allowing it (or not): the address it sends the browser to. */
  allow(authorizeUrl: string, deny?: boolean): string;
  /** The user typed a device code on the provider's page; or refused it (`deny`). */
  typeCode(userCode: string, deny?: boolean): void;
  /** A device code expires: the provider no longer knows it. */
  expireCode(userCode: string): void;
  /** Refresh tokens and access tokens it gave out, by token: still good or not. */
  refreshTokens: Map<string, boolean>;
  accessTokens: Map<string, boolean>;
  /** What each access token it gave is for: a Microsoft resource, or `google`; and the scopes it carries. */
  resources: Map<string, FakeResource | 'google'>;
  scopesOf: Map<string, string[]>;
  /** The scopes the Microsoft user consented to (each sign-in's): a refresh for any other is refused. Delete one for consent taken away. */
  consented: Set<string>;
  /** While set, what a refresh says it granted (`scope`), from what it asked; undefined: what it asked. */
  refreshScope?: (asked: string) => string | undefined;
  /** Give a new refresh token on each refresh (Microsoft does), the old one no longer working. */
  rotate: boolean;
  /** An access token's lifetime, in seconds. */
  expiresIn: number;
  /** What a refresh is answered instead of a token, while set (`invalid_grant`, `consent_required`, a 500…). */
  refreshAnswer?: FakeAnswer;
  /** What a device code's next asks are answered first (`slow_down`, a 500), one each, before as usual. */
  deviceAnswers: FakeAnswer[];
  /** The interval the device endpoint gives, in seconds. */
  deviceInterval: number;
  /** The device endpoint fails: a 500, with no code. */
  deviceDown: boolean;
  /** While set, the token endpoints wait for `until` before they answer a request of this grant: one in flight. */
  hold?: { grant: Grant; until: Promise<void> };
  /** The next token request of each grant listed gets no answer: its connection is closed (the network failing), once each. */
  drop: Grant[];
  /** While set, what the code exchange says it granted (`scope`), from what was asked; undefined: no `scope` in the answer. */
  grantScope?: (asked: string) => string | undefined;
  /** While set, who signed in (Graph's `/me`, Google's userinfo) waits for it before it answers. */
  holdWhoami?: Promise<void>;
  /** The Microsoft account that signs in. */
  me: { id: string; displayName: string; mail: string };
  events: FakeEvent[];
  created: Record<string, unknown>[];
  google: FakeGoogle;
  close(): Promise<void>;
}

type Grant = 'refresh_token' | 'authorization_code' | 'urn:ietf:params:oauth:grant-type:device_code';

const b64url = (b: Buffer) => b.toString('base64url');

export async function fakeOAuth(clientId = 'client-1'): Promise<FakeOAuth> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; scope: string; include: boolean }>();
  const devices = new Map<string, { userCode: string; typed: boolean; denied: boolean; scope: string }>();
  const google: FakeGoogle = {
    clientId: 'google-client.apps.googleusercontent.com',
    secret: 'GOCSPX-stand-in',
    urls: { authorize: '', token: '', revoke: '', userinfo: '', caldav: '' },
    me: { sub: 'google-sub-ming', email: 'ming@gmail.com', name: 'Ming' },
    calendars: 'list',
    events: [],
    puts: [],
    revoked: [],
    granted: new Set(),
  };
  const self: FakeOAuth = {
    url: '',
    host: '',
    clientId,
    requests: [],
    refreshTokens: new Map(),
    accessTokens: new Map(),
    resources: new Map(),
    scopesOf: new Map(),
    consented: new Set(),
    rotate: true,
    expiresIn: 3600,
    deviceAnswers: [],
    drop: [],
    deviceInterval: 1,
    deviceDown: false,
    me: { id: 'subject-ming', displayName: 'Ming', mail: 'ming@contoso.com' },
    events: [],
    created: [],
    google,
    allow(authorizeUrl, deny = false) {
      const u = new URL(authorizeUrl);
      const q = u.searchParams;
      const redirect = new URL(q.get('redirect_uri')!);
      if (deny) {
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', 'The user said no');
      } else {
        const code = `code-${randomUUID()}`;
        codes.set(code, {
          challenge: q.get('code_challenge')!,
          redirectUri: q.get('redirect_uri')!,
          clientId: q.get('client_id')!,
          scope: q.get('scope') ?? '',
          include: q.get('include_granted_scopes') === 'true',
        });
        redirect.searchParams.set('code', code);
      }
      redirect.searchParams.set('state', q.get('state')!);
      return redirect.href;
    },
    typeCode(userCode, deny = false) {
      for (const d of devices.values()) {
        if (d.userCode !== userCode) continue;
        if (deny) d.denied = true;
        else d.typed = true;
      }
    },
    expireCode(userCode) {
      for (const [code, d] of devices) if (d.userCode === userCode) devices.delete(code);
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const tokens = (resource: FakeResource | 'google', scopes: string[]) => {
    const access = `access-${randomUUID()}`;
    const refresh = `refresh-${randomUUID()}`;
    self.accessTokens.set(access, true);
    self.resources.set(access, resource);
    self.scopesOf.set(access, scopes);
    self.refreshTokens.set(refresh, true);
    return { access, refresh };
  };
  const split = (scope: string | null | undefined) => (scope ?? '').split(/\s+/).filter(Boolean);
  const mixed = {
    status: 400,
    body: {
      error: 'invalid_scope',
      error_description:
        'AADSTS28000: Provided value for the input parameter scope is not valid because it contains more than one resource.',
    },
  };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => resolve(body));
    });

  /** A token endpoint's answer, for Microsoft's app (any rotation) or Google's (its secret, no rotation). */
  const token = (form: URLSearchParams, app: 'microsoft' | 'google'): FakeAnswer => {
    if (app === 'microsoft' && form.get('client_id') !== self.clientId)
      return { status: 400, body: { error: 'invalid_client', error_description: 'Unknown app' } };
    if (app === 'google' && (form.get('client_id') !== google.clientId || form.get('client_secret') !== google.secret))
      return { status: 401, body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } };
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const c = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!c || c.redirectUri !== form.get('redirect_uri') || c.challenge !== b64url(createHash('sha256').update(verifier).digest()))
        return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000: The code is not valid' } };
      let carried: string[];
      let resource: FakeResource | 'google';
      if (app === 'google') {
        // One token for every scope granted; with include_granted_scopes, those granted before too.
        if (!c.include) google.granted.clear();
        for (const s of split(c.scope)) google.granted.add(s);
        carried = [...google.granted];
        resource = 'google';
      } else {
        // The token is for the resource the exchange names, else the authorize request's first one.
        for (const s of split(c.scope)) self.consented.add(s);
        const named = form.get('scope');
        const asked = named ? split(named) : split(c.scope);
        const first = asked.find((s) => !OIDC.has(s));
        const r = named ? resourceOf(asked) : first ? resourceOf([first]) : 'graph';
        if (r === 'mixed') return mixed;
        resource = r;
        carried = split(c.scope).filter((s) => OIDC.has(s) || resourceOf([s]) === r);
      }
      const t = tokens(resource, carried);
      const scope = self.grantScope ? self.grantScope(c.scope) : carried.join(' ');
      return {
        status: 200,
        body: {
          access_token: t.access,
          refresh_token: t.refresh,
          expires_in: self.expiresIn,
          ...(scope !== undefined ? { scope } : {}),
          token_type: 'Bearer',
        },
      };
    }
    if (grant === 'refresh_token') {
      if (self.refreshAnswer) return self.refreshAnswer;
      const old = form.get('refresh_token') ?? '';
      if (!self.refreshTokens.get(old))
        return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired' } };
      // Microsoft: a token for the resource the refresh's scopes name, consented to; Google's carries every scope granted.
      const asked = split(form.get('scope'));
      let resource: FakeResource | 'google' = 'google';
      let carried = [...google.granted];
      if (app === 'microsoft') {
        const r = resourceOf(asked);
        if (r === 'mixed') return mixed;
        const notConsented = asked.filter((s) => !OIDC.has(s) && !self.consented.has(s));
        if (notConsented.length)
          return {
            status: 400,
            body: {
              error: 'invalid_grant',
              error_description: `AADSTS65001: The user or administrator has not consented to use the application (${notConsented.join(' ')}).`,
            },
          };
        resource = r;
        carried = asked.length ? asked : [...self.consented].filter((s) => resourceOf([s]) === 'graph');
      }
      const t = tokens(resource, carried);
      const rotate = app === 'microsoft' && self.rotate;
      if (rotate) self.refreshTokens.set(old, false);
      else self.refreshTokens.delete(t.refresh);
      const granted = self.refreshScope
        ? self.refreshScope(asked.join(' '))
        : app === 'microsoft' && asked.length
          ? asked.filter((s) => !OIDC.has(s)).join(' ')
          : undefined;
      return {
        status: 200,
        body: {
          access_token: t.access,
          ...(rotate ? { refresh_token: t.refresh } : {}),
          expires_in: self.expiresIn,
          ...(granted !== undefined ? { scope: granted } : {}),
        },
      };
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const next = self.deviceAnswers.shift();
      if (next) return next;
      const d = devices.get(form.get('device_code') ?? '');
      if (!d) return { status: 400, body: { error: 'expired_token' } };
      if (d.denied) return { status: 400, body: { error: 'access_denied', error_description: 'The user declined' } };
      if (!d.typed) return { status: 400, body: { error: 'authorization_pending' } };
      devices.delete(form.get('device_code')!);
      // The first resource the device code asked for (Graph's, as Harness Relay names it first).
      for (const s of split(d.scope)) self.consented.add(s);
      const first = split(d.scope).find((s) => !OIDC.has(s));
      const r = first ? resourceOf([first]) : 'graph';
      const t = tokens(r === 'mixed' ? 'graph' : r, split(d.scope));
      return { status: 200, body: { access_token: t.access, refresh_token: t.refresh, expires_in: self.expiresIn } };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  };

  const server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '/';
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    self.requests.push({ method: req.method ?? '', path, body, ...(bearer ? { bearer } : {}) });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const xml = (status: number, inner: string) => {
      res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`);
    };
    const form = new URLSearchParams(body);
    const url = new URL(path, self.url);
    const goodToken = Boolean(bearer && self.accessTokens.get(bearer));
    // Graph takes a token for Graph only, not Exchange Online's (one a test set by hand, with no resource, as Graph's).
    const graphToken = goodToken && (self.resources.get(bearer!) ?? 'graph') === 'graph';
    if (self.holdWhoami && (url.pathname === '/v1.0/me' || url.pathname === '/google/userinfo')) await self.holdWhoami;

    if (req.method === 'POST' && (/\/oauth2\/v2\.0\/token$/.test(url.pathname) || url.pathname === '/google/token')) {
      if (self.hold && form.get('grant_type') === self.hold.grant) await self.hold.until;
      const dropped = self.drop.indexOf(form.get('grant_type') as Grant);
      if (dropped >= 0) {
        self.drop.splice(dropped, 1);
        return req.socket.destroy();
      }
      const a = token(form, url.pathname === '/google/token' ? 'google' : 'microsoft');
      return json(a.status, a.body);
    }
    if (req.method === 'POST' && /\/oauth2\/v2\.0\/devicecode$/.test(url.pathname)) {
      if (self.deviceDown) return json(500, {});
      const code = `device-${randomUUID()}`;
      const userCode = `UC${devices.size + 1}`;
      devices.set(code, { userCode, typed: false, denied: false, scope: form.get('scope') ?? '' });
      return json(200, {
        device_code: code,
        user_code: userCode,
        verification_uri: `${self.url}/devicelogin`,
        expires_in: 900,
        interval: self.deviceInterval,
      });
    }

    // Google: revoke (a refresh token), userinfo and CalDAV with a good access token, or 401.
    if (req.method === 'POST' && url.pathname === '/google/revoke') {
      const t = form.get('token') ?? '';
      google.revoked.push(t);
      self.refreshTokens.set(t, false);
      return json(200, {});
    }
    if (url.pathname === '/google/userinfo') return goodToken ? json(200, google.me) : json(401, { error: 'invalid_token' });
    if (url.pathname === '/drive/v3/files' && goodToken) return json(200, { files: [{ name: 'Notebook', id: 'doc' }] });
    if (url.pathname === '/drive/v3/files/doc/export' && goodToken) return res.end('Meeting summary');
    if (url.pathname.startsWith('/caldav/v2/')) {
      if (!goodToken) {
        res.writeHead(401, { 'www-authenticate': 'Bearer realm="https://accounts.google.com/"' });
        return res.end();
      }
      const own = `/caldav/v2/${encodeURIComponent(google.me.email)}`;
      if (req.method === 'PROPFIND' && url.pathname === `${own}/user`) {
        if (google.calendars === 'fail') return json(500, {});
        return xml(
          207,
          `<d:response><d:href>${own}/user</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${own}/user</d:href></d:current-user-principal><cal:calendar-home-set><d:href>${own}/</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response>`,
        );
      }
      if (req.method === 'PROPFIND' && url.pathname === `${own}/`) {
        const calendar = (href: string, name: string) =>
          `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>`;
        return xml(
          207,
          `<d:response><d:href>${own}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>` +
            (google.calendars === 'list'
              ? calendar(`${own}/events/`, google.me.email) +
                calendar(`/caldav/v2/${encodeURIComponent('team@group.calendar.google.com')}/events/`, 'Team')
              : ''),
        );
      }
      if (req.method === 'REPORT' && /\/events\/$/.test(url.pathname)) {
        const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
        return xml(
          207,
          google.events
            .map(
              (f, i) =>
                `<d:response><d:href>${url.pathname}${i}.ics</d:href><d:propstat><d:prop><d:getetag>"${i}"</d:getetag><cal:calendar-data>${escape(f)}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            )
            .join(''),
        );
      }
      if (req.method === 'PUT' && /\/events\/[^/]+\.ics$/.test(url.pathname)) {
        google.puts.push({ path: url.pathname, ics: body, ...(bearer ? { bearer } : {}) });
        res.writeHead(201);
        return res.end();
      }
      res.writeHead(405);
      return res.end();
    }

    // Graph: a good access token for it, or 401.
    if (url.pathname.startsWith('/v1.0/')) {
      if (!graphToken)
        return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } });
      if (url.pathname === '/v1.0/me/joinedTeams') return json(200, { value: [{ id: 'team1', displayName: 'Product' }] });
      if (url.pathname === '/v1.0/teams/team1/channels') return json(200, { value: [{ id: 'channel1', displayName: 'General' }] });
      if (url.pathname === '/v1.0/teams/team1/channels/channel1/messages')
        return json(200, { value: [{ body: { content: 'Friday update' } }] });
      if (url.pathname === '/v1.0/me') return json(200, self.me);
      if (url.pathname === '/v1.0/me/calendars')
        return json(200, {
          value: [
            { id: 'AAA=', name: 'Calendar', canEdit: true, isDefaultCalendar: true },
            { id: 'BBB/1', name: 'Team', canEdit: true, isDefaultCalendar: false },
            { id: 'CCC', name: 'Holidays', canEdit: false },
          ],
        });
      if (/\/calendarView$/.test(url.pathname)) {
        // Two pages: the first event, then the rest behind @odata.nextLink.
        const page = Number(url.searchParams.get('page') ?? 0);
        const value = page === 0 ? self.events.slice(0, 1) : self.events.slice(1);
        const next = page === 0 && self.events.length > 1 ? { '@odata.nextLink': `${self.url}${url.pathname}?page=1` } : {};
        return json(200, { value, ...next });
      }
      if (req.method === 'POST' && /\/events$/.test(url.pathname)) {
        const event = JSON.parse(body) as Record<string, unknown>;
        self.created.push({ ...event, calendar: url.pathname });
        return json(201, { id: `new-${self.created.length}`, ...event });
      }
      if (url.pathname === '/v1.0/redirect') {
        res.writeHead(302, { location: 'https://elsewhere.example/' });
        return res.end();
      }
      return json(404, { error: { code: 'NotFound', message: 'No such thing' } });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  self.url = `http://127.0.0.1:${port}`;
  self.host = `127.0.0.1:${port}`;
  google.urls = {
    authorize: `${self.url}/google/auth`,
    token: `${self.url}/google/token`,
    revoke: `${self.url}/google/revoke`,
    userinfo: `${self.url}/google/userinfo`,
    caldav: `${self.url}/caldav/v2`,
    drive: `${self.url}/drive/v3`,
  };
  return self;
}
