/*
 * A stand-in for Microsoft's sign-in and Graph, on a local port, for the OAuth tests: an authorization
 * server (the authorization code with PKCE checked, refresh with rotation, `invalid_grant`, the device
 * code flow, revoke) and enough of Graph for the calendar tools (`/me`, `/me/calendars`, `calendarView`
 * in pages, `POST …/events`). Plain HTTP on 127.0.0.1, which Harness Relay allows for a stand-in only.
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
  /** The user typed a device code on the provider's page. */
  typeCode(userCode: string): void;
  /** Refresh tokens and access tokens it gave out, by token: still good or not. */
  refreshTokens: Map<string, boolean>;
  accessTokens: Map<string, boolean>;
  /** Give a new refresh token on each refresh (Microsoft does), the old one no longer working. */
  rotate: boolean;
  /** An access token's lifetime, in seconds. */
  expiresIn: number;
  /** The account that signs in. */
  me: { id: string; displayName: string; mail: string };
  events: FakeEvent[];
  created: Record<string, unknown>[];
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export async function fakeOAuth(clientId = 'client-1'): Promise<FakeOAuth> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; scope: string }>();
  const devices = new Map<string, { userCode: string; typed: boolean }>();
  const self: FakeOAuth = {
    url: '',
    host: '',
    clientId,
    requests: [],
    refreshTokens: new Map(),
    accessTokens: new Map(),
    rotate: true,
    expiresIn: 3600,
    me: { id: 'subject-ming', displayName: 'Ming', mail: 'ming@contoso.com' },
    events: [],
    created: [],
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
        });
        redirect.searchParams.set('code', code);
      }
      redirect.searchParams.set('state', q.get('state')!);
      return redirect.href;
    },
    typeCode(userCode) {
      for (const d of devices.values()) if (d.userCode === userCode) d.typed = true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const tokens = () => {
    const access = `access-${randomUUID()}`;
    const refresh = `refresh-${randomUUID()}`;
    self.accessTokens.set(access, true);
    self.refreshTokens.set(refresh, true);
    return { access, refresh };
  };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => resolve(body));
    });

  const server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '/';
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    self.requests.push({ method: req.method ?? '', path, body, ...(bearer ? { bearer } : {}) });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const form = new URLSearchParams(body);
    const url = new URL(path, self.url);

    if (req.method === 'POST' && /\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      if (form.get('client_id') !== self.clientId) return json(400, { error: 'invalid_client', error_description: 'Unknown app' });
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!c || c.redirectUri !== form.get('redirect_uri') || c.challenge !== b64url(createHash('sha256').update(verifier).digest()))
          return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The code is not valid' });
        const t = tokens();
        return json(200, {
          access_token: t.access,
          refresh_token: t.refresh,
          expires_in: self.expiresIn,
          scope: c.scope,
          token_type: 'Bearer',
        });
      }
      if (grant === 'refresh_token') {
        const old = form.get('refresh_token') ?? '';
        if (!self.refreshTokens.get(old))
          return json(400, { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired' });
        const t = tokens();
        if (self.rotate) self.refreshTokens.set(old, false);
        else self.refreshTokens.delete(t.refresh);
        return json(200, { access_token: t.access, ...(self.rotate ? { refresh_token: t.refresh } : {}), expires_in: self.expiresIn });
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = devices.get(form.get('device_code') ?? '');
        if (!d) return json(400, { error: 'expired_token' });
        if (!d.typed) return json(400, { error: 'authorization_pending' });
        devices.delete(form.get('device_code')!);
        const t = tokens();
        return json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: self.expiresIn });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && /\/oauth2\/v2\.0\/devicecode$/.test(url.pathname)) {
      const code = `device-${randomUUID()}`;
      const userCode = `UC${devices.size + 1}`;
      devices.set(code, { userCode, typed: false });
      return json(200, {
        device_code: code,
        user_code: userCode,
        verification_uri: `${self.url}/devicelogin`,
        expires_in: 900,
        interval: 1,
      });
    }

    // Graph: a good access token, or 401.
    if (url.pathname.startsWith('/v1.0/')) {
      if (!bearer || !self.accessTokens.get(bearer))
        return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } });
      if (url.pathname === '/v1.0/me') return json(200, self.me);
      if (url.pathname === '/v1.0/me/calendars')
        return json(200, {
          value: [
            { id: 'AAA=', name: 'Calendar', canEdit: true },
            { id: 'BBB/1', name: 'Team', canEdit: true },
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
  return self;
}
