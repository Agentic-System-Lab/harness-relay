import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_KEY_HEADER, SIGNED_OUT, browserLabel, codeFromBytes, codeFromHash, normalizeCode } from '../src/shared/auth';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-auth-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS, SESSION_COOKIE, SESSION_MAX_AGE_S } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { signInLink } = await import('../src/server/signin');

describe('sign-in codes', () => {
  it('are eight characters of Crockford base 32, shown in two halves and read forgivingly', () => {
    const code = codeFromBytes(new Uint8Array(16).fill(255));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeCode('abcd-efgh')).toBe('ABCDEFGH');
    // O reads as 0, I and L as 1; spaces and dashes do not count.
    expect(normalizeCode(' 0Il1 - oooo ')).toBe('01110000');
    expect(normalizeCode('ABCD-EFG')).toBeUndefined();
    expect(normalizeCode('ABCD-EFGU')).toBeUndefined(); // U is not in the alphabet
  });

  it('come from a link fragment, which the server prints for its own address or for Vite', () => {
    expect(codeFromHash('#code=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(codeFromHash('#/c/abc')).toBeUndefined();
    expect(codeFromHash('')).toBeUndefined();
    expect(codeFromHash('#code=%E0%A4%A')).toBe('%E0%A4%A'); // not an escape: refused as a wrong code, not thrown
    expect(signInLink('ABCD-EFGH', { host: '127.0.0.1', port: 8787 })).toBe('http://127.0.0.1:8787/#code=ABCD-EFGH');
    expect(signInLink('ABCD-EFGH', { host: '0.0.0.0', port: 9000 })).toBe('http://127.0.0.1:9000/#code=ABCD-EFGH');
    expect(signInLink('ABCD-EFGH', { host: '::1', port: 8787 })).toBe('http://[::1]:8787/#code=ABCD-EFGH');
    expect(signInLink('ABCD-EFGH', { host: '127.0.0.1', port: 8787, dev: true })).toBe('http://localhost:5173/#code=ABCD-EFGH');
  });

  it('name a browser by its User-Agent', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    expect(browserLabel(mac)).toBe('Chrome · macOS');
    expect(browserLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone');
    expect(browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge · Windows');
    expect(browserLabel('curl/8.7.1')).toBe('curl/8.7.1');
    expect(browserLabel(undefined)).toBe('?');
  });
});

describe('signed-in browsers', () => {
  let clock = 1_000_000;
  let db: ReturnType<typeof openDatabase>;
  let auth: InstanceType<typeof AuthStore>;
  beforeEach(() => {
    clock = 1_000_000;
    db = openDatabase(':memory:');
    auth = new AuthStore(db, () => clock);
  });

  it('sign in once with a code, which then no longer works, and keep only hashes', () => {
    const { code, expiresAt } = auth.createCode(CODE_TTL_MS.device);
    expect(expiresAt).toBe(clock + 10 * 60_000);
    const s = auth.redeem(code.toLowerCase(), 'Chrome · macOS')!;
    expect(s.cookie.startsWith(`${s.id}.`)).toBe(true);
    expect(auth.redeem(code, 'again')).toBeUndefined();
    // Neither the code, nor the cookie's secret, nor the key is in the database.
    const stored = JSON.stringify([db.prepare('SELECT * FROM auth_sessions').all(), db.prepare('SELECT * FROM auth_codes').all()]);
    for (const secret of [normalizeCode(code)!, s.cookie.split('.')[1]!, s.key]) expect(stored).not.toContain(secret);
  });

  it('keep each code under a slow hash with its own salt, and at most five at once', () => {
    const { code } = auth.createCode(CODE_TTL_MS.device);
    const [row] = db.prepare('SELECT hash FROM auth_codes').all() as { hash: string }[];
    // Not a fast hash someone who reads the database could undo by trying all 2^40 codes.
    expect(row!.hash).not.toContain(createHash('sha256').update(normalizeCode(code)!).digest('hex'));
    expect(row!.hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    const more = Array.from({ length: 5 }, () => auth.createCode(CODE_TTL_MS.device).code);
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_codes').get()).toEqual({ n: 5 });
    expect(auth.redeem(code, 'oldest')).toBeUndefined(); // the oldest went
    expect(auth.redeem(more[0]!, 'newer')).toBeDefined();
  });

  it('refuse an expired code', () => {
    const { code } = auth.createCode(CODE_TTL_MS.device);
    clock += CODE_TTL_MS.device;
    expect(auth.redeem(code, 'late')).toBeUndefined();
  });

  it('need the cookie and the key, or the cookie alone where the browser loads a file', () => {
    const { code } = auth.createCode(CODE_TTL_MS.startup);
    const s = auth.redeem(code, 'x')!;
    expect(auth.check(s.cookie, s.key)).toBe(s.id);
    expect(auth.check(s.cookie, null)).toBe(s.id);
    expect(auth.check(s.cookie, undefined)).toBeUndefined();
    expect(auth.check(s.cookie, 'wrong')).toBeUndefined();
    expect(auth.check(`${s.id}.wrong`, s.key)).toBeUndefined();
    expect(auth.check(undefined, s.key)).toBeUndefined();
    expect(auth.check('no-dot', null)).toBeUndefined();
  });

  it('keep a browser signed in for 400 days at most, as long as its cookie lasts', () => {
    const s = auth.redeem(auth.createCode(CODE_TTL_MS.device).code, 'x')!;
    clock += SESSION_MAX_AGE_S * 1000 - 1;
    expect(auth.check(s.cookie, s.key)).toBe(s.id);
    clock += 1;
    expect(auth.check(s.cookie, s.key)).toBeUndefined();
    auth.createCode(CODE_TTL_MS.device); // and it goes from the list
    expect(auth.sessions()).toEqual([]);
  });

  it('list who signed in, the latest used first, and sign one out', () => {
    const a = auth.redeem(auth.createCode(CODE_TTL_MS.device).code, 'first')!;
    clock += 120_000;
    const b = auth.redeem(auth.createCode(CODE_TTL_MS.device).code, 'second')!;
    clock += 120_000;
    auth.check(a.cookie, a.key); // used again: now the latest
    expect(auth.sessions(b.id).map((s) => [s.label, s.current])).toEqual([
      ['first', false],
      ['second', true],
    ]);
    expect(auth.revoke(a.id)).toBe(true);
    expect(auth.revoke(a.id)).toBe(false);
    expect(auth.check(a.cookie, a.key)).toBeUndefined();
    expect(auth.check(b.cookie, b.key)).toBe(b.id);
  });

  it('refuse more codes after ten wrong ones in a minute', () => {
    for (let i = 0; i < 10; i++) auth.redeem('WRONG-CODE', 'x');
    expect(auth.tooManyFailures()).toBe(true);
    clock += 60_001;
    expect(auth.tooManyFailures()).toBe(false);
  });
});

describe('the API with sign-in', () => {
  const HOST = { host: '127.0.0.1:8787' };
  let app: ReturnType<typeof createApp>;
  let auth: InstanceType<typeof AuthStore>;
  beforeEach(() => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    auth = new AuthStore(db);
    app = createApp({ auth, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers: new ProviderService(settings) });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...HOST, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  /** Signs a browser in with a fresh code: its cookie (as sent back) and key. */
  async function signIn(): Promise<{ cookie: string; key: string; setCookie: string }> {
    const res = await post('/api/auth/login', { code: auth.createCode(CODE_TTL_MS.device).code }, { 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/140.0' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    return { cookie: setCookie.split(';')[0]!, key: ((await res.json()) as { key: string }).key, setCookie };
  }

  it('refuses every request from a browser that has not signed in', async () => {
    const res = await app.request('/api/conversations', { headers: HOST });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: SIGNED_OUT });
    expect(await (await app.request('/api/auth', { headers: HOST })).json()).toEqual({ signedIn: false });
    // Host and Origin are still checked first.
    expect((await app.request('/api/conversations', { headers: { host: 'evil.test' } })).status).toBe(403);
  });

  it('signs a browser in with a code: an HttpOnly, strict cookie for the API, and a key for its requests', async () => {
    expect((await post('/api/auth/login', { code: 'ABCD-EFGH' })).status).toBe(400);
    const { cookie, key, setCookie } = await signIn();
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api/);
    const both = { ...HOST, cookie, [AUTH_KEY_HEADER]: key };
    expect((await app.request('/api/conversations', { headers: both })).status).toBe(200);
    expect(await (await app.request('/api/auth', { headers: both })).json()).toEqual({ signedIn: true });
    // A cookie sent to another port of this computer is not enough, nor the key alone.
    expect((await app.request('/api/conversations', { headers: { ...HOST, cookie } })).status).toBe(401);
    expect((await app.request('/api/conversations', { headers: { ...HOST, [AUTH_KEY_HEADER]: key } })).status).toBe(401);
    expect((await post('/api/conversations', {}, { cookie })).status).toBe(401);
  });

  it('lets the browser load files with the cookie alone, and the live updates with the key in the query', async () => {
    const { cookie, key } = await signIn();
    const made = await post(
      '/api/conversations',
      { agents: [{ name: 'Alice', provider: 'claude', role: '' }], settings: { mode: 'roundtable', permission: 'read-only', cwd: root } },
      { cookie, [AUTH_KEY_HEADER]: key },
    );
    expect(made.status).toBe(200);
    const conv = (await made.json()) as { id: string };
    for (const path of [
      `/api/conversations/${conv.id}/messages/m1/media?path=a.png`,
      `/api/conversations/${conv.id}/messages/m1/download?path=a.txt`,
      `/api/conversations/${conv.id}/attachments/a1`,
      `/api/conversations/${conv.id}/files/raw?root=&path=a.png`,
    ]) {
      expect((await app.request(path, { headers: HOST })).status, path).toBe(401);
      expect((await app.request(path, { headers: { ...HOST, cookie } })).status, path).not.toBe(401);
    }
    const events = `/api/conversations/${conv.id}/events`;
    expect((await app.request(events, { headers: { ...HOST, cookie } })).status).toBe(401);
    const live = await app.request(`${events}?key=${encodeURIComponent(key)}`, { headers: { ...HOST, cookie } });
    expect(live.status).toBe(200);
    await live.body?.cancel();
    // Not every request of the browser's: listing the files is the UI's own request, with the key.
    expect((await app.request(`/api/conversations/${conv.id}/files?root=`, { headers: { ...HOST, cookie } })).status).toBe(401);
  });

  it('gives a signed-in browser a code for another device, lists the browsers and signs one out', async () => {
    expect((await post('/api/auth/codes', {})).status).toBe(401);
    const first = await signIn();
    const firstHeaders = { cookie: first.cookie, [AUTH_KEY_HEADER]: first.key };
    const made = await post('/api/auth/codes', {}, firstHeaders);
    const { code } = (await made.json()) as { code: string };
    const phone = await post('/api/auth/login', { code }, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
    expect(phone.status).toBe(200);
    const list = (await (await app.request('/api/auth/sessions', { headers: { ...HOST, ...firstHeaders } })).json()) as { id: string; label: string; current: boolean }[];
    expect(list.map((s) => s.label).sort()).toEqual(['Firefox · macOS', 'Safari · iPhone']);
    const me = list.find((s) => s.current)!;
    expect(me.label).toBe('Firefox · macOS');
    // Signing this browser out clears its cookie, and it is no longer let in.
    const out = await app.request(`/api/auth/sessions/${me.id}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json', ...firstHeaders } });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
    expect((await app.request('/api/conversations', { headers: { ...HOST, ...firstHeaders } })).status).toBe(401);
  });

  it('refuses more codes for a minute after ten wrong ones', async () => {
    for (let i = 0; i < 10; i++) expect((await post('/api/auth/login', { code: 'WRONG-CODE' })).status).toBe(400);
    const { code } = auth.createCode(CODE_TTL_MS.device);
    expect((await post('/api/auth/login', { code })).status).toBe(429);
  });

  it('counts the wrong codes of requests sent together, also when their bodies come late', async () => {
    const late = (code: string) =>
      new Request('http://127.0.0.1:8787/api/auth/login', {
        method: 'POST',
        headers: { ...HOST, 'content-type': 'application/json' },
        body: new ReadableStream({
          async start(out) {
            await new Promise((r) => setTimeout(r, 20));
            out.enqueue(new TextEncoder().encode(JSON.stringify({ code })));
            out.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
    const statuses = await Promise.all(Array.from({ length: 30 }, async (_, i) => (await app.request(late(`ZZZZ-${String(i).padStart(4, '0')}`))).status));
    expect(statuses.filter((s) => s === 400)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });

  it('replaces the session of a browser that signs in again, rather than adding one', async () => {
    const first = await signIn();
    const again = await post('/api/auth/login', { code: auth.createCode(CODE_TTL_MS.startup).code }, { cookie: first.cookie });
    expect(again.status).toBe(200);
    const cookie = (again.headers.get('set-cookie') ?? '').split(';')[0]!;
    const { key } = (await again.json()) as { key: string };
    expect(auth.sessions()).toHaveLength(1);
    expect((await app.request('/api/conversations', { headers: { ...HOST, cookie: first.cookie, [AUTH_KEY_HEADER]: first.key } })).status).toBe(401);
    expect((await app.request('/api/conversations', { headers: { ...HOST, cookie, [AUTH_KEY_HEADER]: key } })).status).toBe(200);
  });
});
