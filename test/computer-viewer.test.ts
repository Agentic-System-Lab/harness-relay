/*
 * Cua's viewer through Harness Relay's proxy (`src/server/computer/viewer.ts`), against a stand-in of Cua's
 * viewer (`test/fake-cua-viewer.ts`): what passes, with which of Cua's tickets, and how a change of control
 * ends what the page had.
 */
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cuaViewerTicket, FOLLOW_SCRIPT, mediaPaths, ViewerProxy, withFollow } from '../src/server/computer/viewer';
import { FakeCua, field, frame, openMediaAnswer, openStream, send } from './fake-cua-viewer';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function setup(o: { input?: boolean; failMint?: boolean } = {}) {
  const cua = await FakeCua.start();
  const state = {
    input: o.input ?? false,
    mints: [] as boolean[],
    used: 0,
    now: 1_000_000,
    failMint: o.failMint ?? false,
    /** Held before a ticket is made. */
    gate: undefined as Promise<void> | undefined,
  };
  const proxy = new ViewerProxy({
    mint: async (input) => {
      state.mints.push(input);
      await state.gate;
      if (state.failMint) throw new Error('cua said no');
      return { origin: cua.origin, ticket: `cua-${input ? 'input' : 'watch'}-${state.mints.length}`, expiresAt: state.now + 30 * 60_000 };
    },
    input: () => state.input,
    used: () => state.used++,
    now: () => state.now,
  });
  cleanup.push(
    () => proxy.close(),
    () => cua.close(),
  );
  const url = await proxy.ready();
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('ticket')!;
  const origin = proxy.origin;
  /** One of Cua's page's calls, as the page makes it. */
  const call = (name: string, headers: Record<string, string> = {}) =>
    send(origin, 'POST', `/cua.env.v1.${name}`, {
      origin,
      'content-type': 'application/grpc-web+proto',
      'x-cua-env-authorization': `Bearer ${token}`,
      cookie: 'relay=secret',
      ...headers,
    });
  /** OpenMedia, and the stream address it gave. */
  const openMedia = async () => {
    const answer = await call('StreamService/OpenMedia');
    return { answer, path: mediaPaths(answer.body)[0]! };
  };
  /** The page's script asking whether control changed, saying whether its tab is in front. */
  const poll = (visible: 0 | 1, auth = `Bearer ${token}`) =>
    send(origin, 'GET', `/viewer/relay-state?visible=${visible}`, { 'x-cua-env-authorization': auth });
  return { cua, proxy, state, url, token, origin, call, openMedia, poll };
}

/** A gate, and its opening. */
function gate(): { held: Promise<void>; open: () => void } {
  let open!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  return { held, open };
}

describe('Cua’s viewer through Harness Relay’s proxy', () => {
  it('gives the page its own address and token, never Cua’s ticket', async () => {
    const { url, token, origin, state } = await setup();
    expect(url).toBe(`${origin}/viewer/#ticket=${token}`);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).not.toContain('cua-');
    // Its ticket for the powers there are now, made at once: Cua's failure is the link's.
    expect(state.mints).toEqual([false]);
  });

  it('serves Cua’s page with its own script first, never from the browser’s copy, and Cua’s files, passing on no cookie or origin', async () => {
    const { cua, origin, state, poll } = await setup();
    const page = await send(origin, 'GET', '/viewer/', {
      cookie: 'relay=secret',
      'accept-encoding': 'gzip',
      'if-none-match': '"cua-page"',
      'if-modified-since': 'Sat, 28 Nov 2026 00:00:00 GMT',
    });
    expect(page.status).toBe(200);
    const html = page.body.toString();
    expect(html).toContain('<head><script type="module" src="./relay-follow.js?mode=watch"></script>');
    expect(html.indexOf('relay-follow.js')).toBeLessThan(html.indexOf('viewer.js'));
    expect(Number(page.headers['content-length'])).toBe(page.body.length);
    expect(page.headers['content-security-policy']).toBe("default-src 'self'");
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    // The page differs with the powers it is served with: Cua's validators are not its own.
    expect(page.headers.etag).toBeUndefined();
    expect(page.headers['last-modified']).toBeUndefined();
    expect(page.headers['cache-control']).toBe('no-store');
    const asked = cua.requests.at(-1)!;
    expect(asked.url).toBe('/viewer/');
    expect(asked.headers.cookie).toBeUndefined();
    expect(asked.headers.origin).toBeUndefined();
    expect(asked.headers['if-none-match']).toBeUndefined();
    expect(asked.headers['if-modified-since']).toBeUndefined();
    // Asked as it is, to be changed.
    expect(asked.headers['accept-encoding']).toBeUndefined();
    expect(asked.headers.host).toBe(new URL(cua.origin).host);

    const js = await send(origin, 'GET', '/viewer/viewer.js', { cookie: 'relay=secret', 'accept-encoding': 'gzip' });
    expect(js.body.toString()).toBe('export {};');
    expect(cua.requests.at(-1)!.headers['accept-encoding']).toBe('gzip');

    expect((await send(origin, 'GET', '/viewer/relay-follow.js?mode=watch')).body.toString()).toBe(FOLLOW_SCRIPT);
    expect(JSON.parse((await poll(1)).body.toString())).toEqual({ mode: 'watch' });
    state.input = true;
    expect(JSON.parse((await poll(1)).body.toString())).toEqual({ mode: 'input' });
    expect((await send(origin, 'GET', '/viewer/')).body.toString()).toContain('relay-follow.js?mode=input');
  });

  it('counts a tab of it in front as use of the computer, never one behind, nor its streams', async () => {
    const { origin, state, poll, openMedia } = await setup({ input: true });
    expect((await poll(1, 'Bearer nope')).status).toBe(401);
    expect((await send(origin, 'GET', '/viewer/relay-state?visible=1')).status).toBe(401);
    expect(state.used).toBe(0);
    await poll(0);
    expect(state.used).toBe(0);
    await poll(1);
    expect(state.used).toBe(1);
    // What a stream carries (the page acknowledges every frame) says nothing of whether anyone looks.
    const stream = await openStream(origin, (await openMedia()).path);
    stream.socket!.write(frame('frame_ack'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.used).toBe(1);
  });

  it('refuses a call without its token, from another page or host, and every call Cua’s page never makes', async () => {
    const { cua, origin, token, call } = await setup();
    const before = cua.requests.length;
    expect((await call('SystemService/GetCapabilities', { 'x-cua-env-authorization': '' })).status).toBe(401);
    expect((await call('SystemService/GetCapabilities', { 'x-cua-env-authorization': `Bearer ${token}x` })).status).toBe(401);
    expect((await call('SystemService/GetCapabilities', { origin: 'http://127.0.0.1:1' })).status).toBe(403);
    expect((await call('SystemService/GetCapabilities', { host: `localhost:${new URL(origin).port}` })).status).toBe(403);
    // Calls that would make a ticket, read files or drive the computer around the stream: never passed on.
    for (const name of [
      'SystemService/CreateViewerTicket',
      'SystemService/Shutdown',
      'FilesystemService/ReadFile',
      'ComputerService/Keyboard',
      'WindowsService/LaunchApp',
    ])
      expect((await call(name)).status).toBe(404);
    expect((await send(origin, 'GET', '/cua.env.v1.SystemService/GetCapabilities')).status).toBe(404);
    expect((await send(origin, 'OPTIONS', '/viewer/')).status).toBe(404);
    expect((await send(origin, 'GET', '/healthz')).status).toBe(404);
    expect((await send(origin, 'GET', '/viewer/../media?ticket=x')).status).toBe(404);
    expect((await send(origin, 'GET', '/viewer/', { host: 'evil.example' })).status).toBe(403);
    expect(cua.requests.length).toBe(before);
  });

  it('passes the page’s calls on with Cua’s ticket for who has control, made again before it expires', async () => {
    const { cua, call, state } = await setup();
    expect((await call('SystemService/GetCapabilities')).status).toBe(200);
    const asked = cua.requests.at(-1)!;
    expect(asked.headers['x-cua-env-authorization']).toBe('Bearer cua-watch-1');
    expect(asked.headers.cookie).toBeUndefined();
    expect(asked.headers.origin).toBeUndefined();

    state.input = true;
    await Promise.all([call('ComputerService/GetClipboard'), call('PresenceService/Join')]);
    expect(cua.requests.slice(-2).map((r) => r.headers['x-cua-env-authorization'])).toEqual(['Bearer cua-input-2', 'Bearer cua-input-2']);
    expect(state.mints).toEqual([false, true]);

    // Still kept 25 minutes on; made again in its last two.
    state.now += 25 * 60_000;
    await call('ComputerService/GetClipboard');
    expect(state.mints).toEqual([false, true]);
    state.now += 4 * 60_000;
    await call('ComputerService/GetClipboard');
    expect(cua.requests.at(-1)!.headers['x-cua-env-authorization']).toBe('Bearer cua-input-3');

    state.input = false;
    await call('PresenceService/UpdateCursor');
    expect(cua.requests.at(-1)!.headers['x-cua-env-authorization']).toBe('Bearer cua-watch-4');
  });

  it('shares the computer’s clipboard only while the user has control', async () => {
    const { cua, call, state } = await setup();
    const before = cua.requests.length;
    expect((await call('ComputerService/GetClipboard')).status).toBe(403);
    expect((await call('ComputerService/SetClipboard')).status).toBe(403);
    expect(cua.requests.length).toBe(before);
    state.input = true;
    expect((await call('ComputerService/SetClipboard')).status).toBe(200);
    expect(cua.requests.at(-1)!.headers['x-cua-env-authorization']).toMatch(/^Bearer cua-input-/);
    state.input = false;
    expect((await call('ComputerService/SetClipboard')).status).toBe(403);
    expect(cua.requests.length).toBe(before + 1);
  });

  it('asks Cua for OpenMedia’s answer as it is, to read its addresses', async () => {
    const { cua, call } = await setup();
    await call('StreamService/OpenMedia', { 'accept-encoding': 'gzip' });
    expect(cua.requests.at(-1)!.headers['accept-encoding']).toBeUndefined();
    await call('PresenceService/Join', { 'accept-encoding': 'gzip' });
    expect(cua.requests.at(-1)!.headers['accept-encoding']).toBe('gzip');
  });

  it('refuses a call whose control changed while its ticket was made, and passes nothing of it on', async () => {
    const { cua, call, state, proxy } = await setup();
    // The ticket with input is made only once the user has control: held there.
    const held = gate();
    state.gate = held.held;
    state.input = true;
    const asked = call('PresenceService/Join');
    await vi.waitFor(() => expect(state.mints).toEqual([false, true]));
    const before = cua.requests.length;
    state.input = false;
    proxy.sync();
    held.open();
    expect((await asked).status).toBe(401);
    expect(cua.requests.length).toBe(before);
  });

  it('says Cua’s failure to make a ticket, and keeps nothing of it', async () => {
    const { call, state } = await setup();
    state.input = true;
    state.failMint = true;
    expect((await call('SystemService/GetCapabilities')).status).toBe(502);
    state.failMint = false;
    expect((await call('SystemService/GetCapabilities')).status).toBe(200);
  });

  it('lets a stream attach only to an address OpenMedia gave since control last changed, and ends it when control changes', async () => {
    const { cua, origin, state, proxy, openMedia } = await setup();
    const { answer, path } = await openMedia();
    expect(path).toMatch(/^\/media\?ticket=v1\.watchx+\.1$/);
    // The answer reaches the page as Cua gave it.
    expect(answer.body.equals(openMediaAnswer('media-1', path))).toBe(true);

    const stream = await openStream(origin, path);
    expect(stream.socket).toBeDefined();
    stream.socket!.write(frame('watching'));
    await vi.waitFor(() => expect(cua.received).toContainEqual({ path, text: 'watching' }));
    expect(cua.requests.at(-1)!.headers.cookie).toBeUndefined();
    expect(cua.requests.at(-1)!.headers.origin).toBe(cua.origin);

    // An address Cua did not give is answered with 4401: the page asks for another.
    const made = await openStream(origin, '/media?ticket=v1.made-up');
    expect(made.closeCode).toBe(4401);
    expect(cua.upgrades).not.toContain('/media?ticket=v1.made-up');

    // The user takes control: what the page sends on its stream after that never reaches Cua, even before
    // the proxy is told.
    state.input = true;
    stream.socket!.write(frame('typed after'));
    await stream.ended;
    expect(cua.received.map((r) => r.text)).not.toContain('typed after');
    // Its address is refused now; a new one, under the ticket with input, takes input.
    expect((await openStream(origin, path)).closeCode).toBe(4401);
    const next = await openMedia();
    expect(next.path).toMatch(/^\/media\?ticket=v1\.inputx+\.2$/);
    const typing = await openStream(origin, next.path);
    typing.socket!.write(frame('click'));
    await vi.waitFor(() => expect(cua.received).toContainEqual({ path: next.path, text: 'click' }));

    // Handed back (the computer's state tells the proxy): the stream ends at once, the page sending nothing.
    state.input = false;
    proxy.sync();
    await typing.ended;
    expect((await openStream(origin, next.path)).closeCode).toBe(4401);
  });

  it('allows no stream from an OpenMedia answer that came after control changed', async () => {
    const { cua, origin, state, proxy, call } = await setup();
    let release!: () => void;
    cua.hold = new Promise((resolve) => (release = resolve));
    const asked = call('StreamService/OpenMedia');
    await vi.waitFor(() => expect(cua.requests.at(-1)!.url).toBe('/cua.env.v1.StreamService/OpenMedia'));
    state.input = true;
    proxy.sync();
    release();
    const path = mediaPaths((await asked).body)[0]!;
    expect(path).toMatch(/watch/);
    expect((await openStream(origin, path)).closeCode).toBe(4401);
  });

  it('refuses a stream whose control changed while its ticket was made', async () => {
    const { cua, origin, state, proxy, openMedia } = await setup({ input: true });
    const { path } = await openMedia();
    // The ticket with input about to expire: the stream waits for a new one, held there.
    state.now += 29 * 60_000;
    const held = gate();
    state.gate = held.held;
    const opening = openStream(origin, path);
    await vi.waitFor(() => expect(state.mints).toEqual([true, true]));
    state.input = false;
    proxy.sync();
    held.open();
    expect((await opening).closeCode).toBe(4401);
    expect(cua.upgrades).not.toContain(path);
  });

  it('refuses a stream from another page or host', async () => {
    const { cua, origin, openMedia } = await setup();
    const { path } = await openMedia();
    const upgrades = cua.upgrades.length;
    expect((await openStream(origin, path, { origin: 'http://evil.example' })).status).toBe(0);
    expect((await openStream(origin, path, { host: 'evil.example' })).status).toBe(0);
    expect(cua.upgrades.length).toBe(upgrades);
  });

  it('closes its port, its streams and its requests to Cua; a request ends at Cua when its browser goes', async () => {
    const { cua, origin, proxy, openMedia } = await setup();
    // The browser leaves a request Cua never finishes: Cua's end of it closes too.
    const at = new URL(origin);
    const left = request({ host: at.hostname, port: at.port, path: '/viewer/hang.js', headers: { host: at.host } });
    left.on('error', () => undefined);
    left.on('response', () => left.destroy());
    left.end();
    await vi.waitFor(() => expect(cua.hungUp).toBe(1));

    const stream = await openStream(origin, (await openMedia()).path);
    const hanging = request({ host: at.hostname, port: at.port, path: '/viewer/hang.js', headers: { host: at.host } });
    hanging.on('error', () => undefined);
    hanging.end();
    await vi.waitFor(() => expect(cua.requests.filter((r) => r.url === '/viewer/hang.js').length).toBe(2));
    proxy.close();
    await stream.ended;
    await vi.waitFor(() => expect(cua.hungUp).toBe(2));
    await expect(send(origin, 'GET', '/viewer/')).rejects.toThrow(/ECONNREFUSED/);
    expect(proxy.closed).toBe(true);
  });

  it('says it is closed to a link asked for before it listened', async () => {
    const proxy = new ViewerProxy({ mint: async () => ({ origin: 'http://127.0.0.1:1', ticket: 't' }), input: () => false });
    proxy.close();
    await expect(proxy.ready()).rejects.toThrow(/closed/);
  });
});

describe('the viewer proxy’s parts', () => {
  it('reads OpenMedia’s media address by its length, whatever follows it', () => {
    const short = '/media?ticket=abc';
    const long = `/media?ticket=v1.${'y'.repeat(200)}`;
    expect(mediaPaths(openMediaAnswer('m', short))).toEqual([short]);
    expect(mediaPaths(openMediaAnswer('m', long))).toEqual([long]);
    // A length that runs past the answer, or an address with other characters, gives nothing.
    expect(mediaPaths(Buffer.concat([Buffer.from([0x22, 0x40]), Buffer.from('/media?ticket=cut')]))).toEqual([]);
    expect(mediaPaths(field(0x22, '/media?ticket=a b'))).toEqual([]);
    expect(mediaPaths(Buffer.from('no address'))).toEqual([]);
  });

  it('puts its script first in the page’s head', () => {
    expect(withFollow('<html><head lang="x"><title>t</title></head></html>', 'input')).toBe(
      '<html><head lang="x"><script type="module" src="./relay-follow.js?mode=input"></script><title>t</title></head></html>',
    );
    expect(withFollow('<p>no head</p>', 'watch')).toBe('<script type="module" src="./relay-follow.js?mode=watch"></script><p>no head</p>');
    // Its script sets the clipboard for the page's powers before Cua's runs, and reloads it when control changes.
    expect(FOLLOW_SCRIPT).toMatch(/clipboard', start === 'input' \? 'view' : '0'/);
    expect(FOLLOW_SCRIPT).toMatch(/location\.reload\(\)/);
  });

  it('takes Cua’s viewer link only for a page on a loopback port with a ticket', () => {
    expect(cuaViewerTicket('http://127.0.0.1:41234/viewer/#ticket=v1.abc_-.x&clipboard=view', 2000)).toEqual({
      origin: 'http://127.0.0.1:41234',
      ticket: 'v1.abc_-.x',
      expiresAt: 2_000_000,
    });
    expect(cuaViewerTicket('http://[::1]:9/viewer/#ticket=t')).toEqual({ origin: 'http://[::1]:9', ticket: 't' });
    expect(cuaViewerTicket('https://evil.example/viewer/#ticket=t')).toBeUndefined();
    expect(cuaViewerTicket('http://127.0.0.1:41234/other/#ticket=t')).toBeUndefined();
    expect(cuaViewerTicket('http://127.0.0.1:41234/viewer/#clipboard=view')).toBeUndefined();
    expect(cuaViewerTicket('http://127.0.0.1:41234/viewer/#ticket=a%0Db')).toBeUndefined();
    expect(cuaViewerTicket(undefined)).toBeUndefined();
  });
});
