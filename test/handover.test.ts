/*
 * Taking over the chat's browser (`browser_hand_over`), without a browser: where a window can open, what
 * the user's input becomes, the hand-over's ticket (the user's answers, the time limits, the turn's end),
 * what the agent is told, the browser's launch for a window, the tool's refusals, and the routes the
 * card and the screencast panel use. With a real Chromium: test/browser.test.ts.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { Conversation, HandoverInput, HandoverScreenEvent } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-handover-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const {
  Handovers,
  HANDOVER_UNASKED,
  SELECTION_SCRIPT,
  USER_BROWSERS_MAX,
  cardUrl,
  checkInputs,
  handoverOutcome,
  handoverWindowAt,
  inputCalls,
  keyCodeOf,
  ownerAllows,
} = await import('../src/server/browser/handover');
const { BrowserService, cookieParams, launchArgs, launchEnv, profilePrefs } = await import('../src/server/browser/session');
const { browserTools } = await import('../src/server/browser/tools');
const { ToolGateway } = await import('../src/server/gateway');
const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');

describe('where a hand-over can show the page', () => {
  const at = (o: Partial<Parameters<typeof handoverWindowAt>[0]>) =>
    handoverWindowAt({ desktop: false, platform: 'linux', env: {}, macGui: () => false, ...o });

  it('opens a window beside the desktop app, on a Mac signed in at its screen, on Linux with a display, and on Windows', () => {
    expect(at({ desktop: true, platform: 'darwin' })).toBe('desktop');
    expect(at({ platform: 'darwin', macGui: () => true })).toBe('server');
    expect(at({ platform: 'linux', env: { DISPLAY: ':0' } })).toBe('server');
    expect(at({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })).toBe('server');
    expect(at({ platform: 'win32' })).toBe('server');
  });

  it('offers the screencast alone where it cannot: a Mac reached over SSH, Linux with no display (a codespace, a homelab)', () => {
    expect(at({ platform: 'darwin', macGui: () => false })).toBeUndefined();
    expect(at({ platform: 'linux', env: { SSH_CONNECTION: '1 2 3 4' } })).toBeUndefined();
    expect(at({ platform: 'aix' })).toBeUndefined();
  });

  it("shows the page's address on its card without its query or fragment, which may carry a token", () => {
    expect(cardUrl('https://accounts.example.com/signin/v2?code=secret#token=x')).toBe('https://accounts.example.com/signin/v2');
    expect(cardUrl('about:blank')).toBeUndefined();
    expect(cardUrl('file:///etc/hosts')).toBeUndefined();
    expect(cardUrl('not a url')).toBeUndefined();
  });
});

describe("the window's browser", () => {
  it('starts with every argument the headless one has but --headless=new: the same proxy, no bypass but loopback, no UDP of its own', () => {
    const headless = launchArgs({ profile: '/data/browser/c1', proxyPort: 4321, platform: 'darwin' });
    const windowed = launchArgs({ profile: '/data/browser/c1', proxyPort: 4321, platform: 'darwin', window: true });
    expect(headless[0]).toBe('--headless=new');
    expect(windowed).toEqual(headless.slice(1));
    for (const args of [headless, windowed]) {
      expect(args).toContain('--proxy-server=http://127.0.0.1:4321');
      expect(args).toContain('--proxy-bypass-list=<-loopback>');
      expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      expect(args).toContain('--remote-debugging-pipe');
      expect(args).toContain('--disable-extensions');
      expect(args.at(-1)).toBe('about:blank');
    }
    // On Linux, a window on Wayland where the session has one; Chromium's sandbox off only as root.
    const linux = launchArgs({ profile: '/p', proxyPort: 1, platform: 'linux', window: true, root: true });
    expect(linux).toContain('--ozone-platform-hint=auto');
    expect(linux).toContain('--no-sandbox');
    expect(launchArgs({ profile: '/p', proxyPort: 1, platform: 'linux' })).not.toContain('--ozone-platform-hint=auto');
  });

  it("gets the display of the server's session for a window, and nothing more of its environment", () => {
    const server = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      DISPLAY: ':1',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/x',
      DBUS_SESSION_BUS_ADDRESS: 'unix:x',
      OPENAI_API_KEY: 'k',
    };
    const env = launchEnv(server, '/data/browser/c1', 'linux', { window: true });
    expect(env).toMatchObject({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/x', PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS');
    // Headless, no display at all.
    expect(launchEnv(server, '/data/browser/c1', 'linux')).not.toHaveProperty('DISPLAY');
  });

  it('keeps no password, autofill or browser sign-in in the profile, sends nothing typed in the address bar, and preloads nothing', () => {
    const prefs = profilePrefs({ net: { other: 1 }, profile: { name: 'x' }, kept: true });
    expect(prefs).toMatchObject({
      kept: true,
      net: { other: 1, network_prediction_options: 2 },
      credentials_enable_service: false,
      profile: { name: 'x', password_manager_enabled: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
      signin: { allowed: false },
      search: { suggest_enabled: false },
    });
  });

  it('carries cookies from one start to the next, session cookies without an expiry', () => {
    expect(
      cookieParams([
        {
          name: 'sid',
          value: 'a',
          domain: 'example.com',
          path: '/',
          expires: -1,
          session: true,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          size: 4,
        },
        {
          name: 'keep',
          value: 'b',
          domain: '.example.com',
          path: '/app',
          expires: 1900000000,
          session: false,
          priority: 'Medium',
          sourcePort: 443,
        },
        { name: 'broken', domain: 'example.com' },
      ]),
    ).toEqual([
      { name: 'sid', value: 'a', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
      {
        name: 'keep',
        value: 'b',
        domain: '.example.com',
        path: '/app',
        secure: false,
        httpOnly: false,
        expires: 1900000000,
        priority: 'Medium',
        sourcePort: 443,
      },
    ]);
  });
});

describe("the screencast panel's input", () => {
  it('takes clicks, wheels, keys, text, an address, history and a size, each checked', () => {
    const events: HandoverInput[] = [
      { type: 'mouse', action: 'down', x: 0.5, y: 0.25, button: 'left', clicks: 2, modifiers: 8 },
      { type: 'wheel', x: 0.1, y: 0.9, dx: 0, dy: 120 },
      { type: 'key', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' },
      { type: 'key', key: 'a', modifiers: 4, command: 'selectAll' },
      { type: 'text', text: '注音輸入' },
      { type: 'navigate', url: 'https://example.com/a b' },
      { type: 'history', to: 'back' },
      { type: 'viewport', width: 390, height: 700, scale: 2 },
    ];
    const checked = checkInputs(events);
    expect(Array.isArray(checked) && checked.length).toBe(8);
    expect((checked as HandoverInput[])[5]).toEqual({ type: 'navigate', url: 'https://example.com/a%20b' });
  });

  it('refuses what is out of range or of a kind it does not know', () => {
    const bad: unknown[] = [
      undefined,
      [],
      [{ type: 'mouse', action: 'down', x: 1.5, y: 0 }],
      [{ type: 'mouse', action: 'drag', x: 0, y: 0 }],
      [{ type: 'mouse', action: 'down', x: 0, y: 0, clicks: 9 }],
      [{ type: 'wheel', x: 0, y: 0, dx: 1e9, dy: 0 }],
      [{ type: 'key', key: '' }],
      [{ type: 'key', key: 'x'.repeat(40) }],
      [{ type: 'key', key: 'a', command: 'copy' }],
      [{ type: 'key', key: 'a', modifiers: 99 }],
      [{ type: 'text', text: 'x'.repeat(2001) }],
      [{ type: 'navigate', url: 'file:///etc/passwd' }],
      [{ type: 'navigate', url: 'javascript:alert(1)' }],
      [{ type: 'history', to: 'home' }],
      [{ type: 'viewport', width: 10, height: 700 }],
      [{ type: 'script', code: 'x' }],
      Array.from({ length: 101 }, () => ({ type: 'text', text: 'a' })),
    ];
    for (const raw of bad) expect(typeof checkInputs(raw)).toBe('string');
  });

  it("becomes Chromium's input on the frame's own pixels: a click, a drag, the wheel", () => {
    const frame = { width: 400, height: 800 };
    expect(inputCalls({ type: 'mouse', action: 'down', x: 0.5, y: 0.25, clicks: 2, modifiers: 8 }, frame)).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 200, y: 200, button: 'left', buttons: 1, clickCount: 2, modifiers: 8 },
      },
    ]);
    expect(inputCalls({ type: 'mouse', action: 'move', x: 1, y: 1, button: 'left' }, frame)[0]!.params).toEqual({
      type: 'mouseMoved',
      x: 400,
      y: 800,
      button: 'left',
      buttons: 1,
      modifiers: 0,
    });
    expect(inputCalls({ type: 'mouse', action: 'up', x: 0, y: 0 }, frame)[0]!.params).toMatchObject({ type: 'mouseReleased', buttons: 0 });
    expect(inputCalls({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -300 }, frame)[0]!.params).toEqual({
      type: 'mouseWheel',
      x: 200,
      y: 400,
      deltaX: 0,
      deltaY: -300,
      modifiers: 0,
    });
  });

  it('types a key with its text, presses one without as a raw key, Enter as a carriage return, and inserts text as an input method does', () => {
    const frame = { width: 1, height: 1 };
    expect(inputCalls({ type: 'key', key: 'é', code: 'KeyE', text: 'é', modifiers: 1 }, frame)).toEqual([
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: 'é',
          code: 'KeyE',
          windowsVirtualKeyCode: 0,
          nativeVirtualKeyCode: 0,
          modifiers: 1,
          text: 'é',
          unmodifiedText: 'é',
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'é', code: 'KeyE', windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0, modifiers: 1 },
      },
    ]);
    expect(inputCalls({ type: 'key', key: 'Backspace' }, frame)[0]!.params).toMatchObject({ type: 'rawKeyDown', windowsVirtualKeyCode: 8 });
    expect(inputCalls({ type: 'key', key: 'Enter' }, frame)[0]!.params).toMatchObject({
      type: 'keyDown',
      text: '\r',
      windowsVirtualKeyCode: 13,
    });
    expect(inputCalls({ type: 'key', key: 'a', modifiers: 4, command: 'selectAll' }, frame)[0]!.params).toMatchObject({
      type: 'rawKeyDown',
      commands: ['selectAll'],
      windowsVirtualKeyCode: 65,
    });
    expect(inputCalls({ type: 'text', text: '注音' }, frame)).toEqual([{ method: 'Input.insertText', params: { text: '注音' } }]);
    expect(inputCalls({ type: 'navigate', url: 'https://example.com/' }, frame)).toEqual([]);
    expect([keyCodeOf('z'), keyCodeOf('7'), keyCodeOf('ArrowDown'), keyCodeOf('x', 200), keyCodeOf('€')]).toEqual([90, 55, 40, 200, 0]);
  });
});

describe("a hand-over's ticket", () => {
  const never = new AbortController().signal;

  it('starts in a mode it offers, takes the first answer of each step only, and is done once the user hands it back', async () => {
    const all = new Handovers();
    const t = all.create('c1', ['screencast']);
    expect(all.answer('c1', t.id, { action: 'start', mode: 'window' })).toBe('mode');
    expect(all.answer('c2', t.id, { action: 'start', mode: 'screencast' })).toBe('missing');
    expect(all.answer('c1', t.id, { action: 'done' })).toBe('state');
    const first = t.wait(10_000, never);
    expect(all.answer('c1', t.id, { action: 'start', mode: 'screencast' })).toBeUndefined();
    // Another browser on the chat answering at the same time: too late.
    expect(all.answer('c1', t.id, { action: 'cancel' })).toBe('state');
    expect(await first).toEqual({ action: 'start', mode: 'screencast' });
    t.status = 'active';
    // What came before anyone waited is kept for the next wait.
    expect(all.answer('c1', t.id, { action: 'done', note: 'Signed in' })).toBeUndefined();
    expect(await t.wait(10_000, never)).toEqual({ action: 'done', note: 'Signed in' });
    all.remove(t);
    expect(all.get('c1', t.id)).toBeUndefined();
    expect(all.answer('c1', t.id, { action: 'done' })).toBe('missing');
  });

  it('ends at its time limit, with the turn, and when its conversation is deleted', async () => {
    vi.useFakeTimers();
    try {
      const all = new Handovers();
      const t = all.create('c1', ['screencast']);
      const late = t.wait(60_000, never);
      vi.advanceTimersByTime(60_000);
      expect(await late).toEqual({ action: 'timeout' });
      const turn = new AbortController();
      const ended = t.wait(60_000, turn.signal);
      turn.abort();
      expect(await ended).toEqual({ action: 'turn' });
      const deleted = t.wait(60_000, never);
      all.endAll('c1');
      expect(await deleted).toEqual({ action: 'turn' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the screencast's watchers the latest frame and address first, then each event, and says when it ended", async () => {
    const all = new Handovers();
    const t = all.create('c1', ['screencast']);
    t.status = 'active';
    expect(all.watch('c1', t.id, () => undefined)).toBe('state');
    t.mode = 'screencast';
    t.emit({ type: 'frame', data: 'old', width: 1, height: 1 });
    t.emit({ type: 'location', url: 'https://example.com/', back: false, forward: false });
    t.emit({ type: 'frame', data: 'new', width: 1, height: 1 });
    const seen: HandoverScreenEvent[] = [];
    expect(typeof all.watch('c1', t.id, (e) => seen.push(e))).toBe('function');
    t.emit({ type: 'notice', kind: 'popup', url: 'https://example.com/w' });
    const inputs: HandoverInput[][] = [];
    expect(await all.input('c1', t.id, [{ type: 'text', text: 'a' }])).toBe('state');
    t.screen = { input: async (events) => void inputs.push(events) };
    expect(await all.input('c1', t.id, [{ type: 'text', text: 'a' }])).toBeUndefined();
    all.remove(t);
    expect(seen.map((e) => (e.type === 'frame' ? `frame ${e.data}` : e.type))).toEqual(['location', 'frame new', 'notice', 'ended']);
    expect(inputs).toEqual([[{ type: 'text', text: 'a' }]]);
    expect(await all.input('c1', t.id, [{ type: 'text', text: 'a' }])).toBe('missing');
  });
});

describe('a browser for the user alone', () => {
  it("asks nobody about a host: one on the internet opens, one here only at an address the user typed (or the card's)", () => {
    expect(ownerAllows(false, false)).toBe(true);
    expect(ownerAllows(true, true)).toBe(true);
    expect(ownerAllows(true, false)).toBe(false);
  });

  it('reads the selection in a field, else on the page, else a focused field but a password', () => {
    // The script itself runs in a real Chromium (test/browser.test.ts); here, what it never reads.
    expect(SELECTION_SCRIPT).toContain("field.type !== 'password'");
    expect(SELECTION_SCRIPT).toContain('getSelection()');
    expect(USER_BROWSERS_MAX).toBeGreaterThan(0);
  });
});

describe('what the agent is told', () => {
  it('says how it ended and the note, never what the user typed or the page, and where the page is now', () => {
    const minutes = { start: 15, use: 30 };
    expect(handoverOutcome({ end: { action: 'done', note: 'Signed in\nas Bob "admin"' }, started: true, page: 'kept', minutes })).toEqual({
      text: `The user took over the browser and handed it back, saying: "Signed in as Bob 'admin'". The page is open as they left it. What they signed in to stays in this conversation's browser: read the page with browser_snapshot before going on.`,
    });
    expect(handoverOutcome({ end: { action: 'closed' }, started: true, page: 'reopened', minutes }).text).toMatch(
      /^The user took over the browser and handed it back\. The browser opened again without a window/,
    );
    expect(handoverOutcome({ end: { action: 'cancel' }, started: false, page: 'kept', minutes })).toEqual({
      text: 'The user declined to take over the browser.',
      isError: true,
    });
    expect(handoverOutcome({ end: { action: 'cancel', note: 'not now' }, started: true, page: 'closed', minutes }).text).toBe(
      'The user stopped the hand-over before finishing, saying: "not now". The browser closed with its window: open the page again with browser_open.',
    );
    expect(handoverOutcome({ end: { action: 'timeout' }, started: false, page: 'kept', minutes }).text).toBe(
      'The user did not take over the browser within 15 minutes.',
    );
    expect(handoverOutcome({ end: { action: 'timeout' }, started: true, page: 'kept', minutes }).text).toMatch(
      /^The hand-over ended after 30 minutes/,
    );
    expect(handoverOutcome({ end: { action: 'failed', error: 'no display' }, started: true, page: 'closed', minutes })).toEqual({
      text: 'The browser could not be shown to the user: no display. Open the page again with browser_open.',
      isError: true,
    });
  });
});

describe('the browser_hand_over tool', () => {
  const browser = new BrowserService({ dataDir: join(root, 'data'), executable: () => '/no/browser', relayPorts: () => [] });
  const tool = browserTools(browser).find((t) => t.name === 'browser_hand_over')!;
  const ctx = (o: Record<string, unknown> = {}) =>
    ({
      convId: 'c1',
      agentId: 'a',
      agentName: 'Alice',
      messageId: 'm',
      cwd: root,
      permission: 'edit',
      unattended: false,
      ask: async () => ({ allow: true }),
      handoverCard: () => ({ update: () => undefined }),
      signal: new AbortController().signal,
      ...o,
    }) as never;

  it('runs at once (its own card is the question) and only for the agent itself, never from code through run_code', () => {
    expect(tool).toMatchObject({ group: 'browser', tier: 'read', direct: true });
    expect(tool.inputSchema).toMatchObject({ required: ['reason'] });
    expect(tool.description).toMatch(/Never ask the user for a password/);
  });

  it('is refused at once where nobody can be asked: a run nobody watches, a conversation that refuses requests', async () => {
    for (const o of [{ unattended: true }, { handoverCard: undefined }, { ask: undefined }])
      expect(await browser.handOver(ctx(o), 'Sign in')).toEqual({ text: HANDOVER_UNASKED, isError: true });
    expect(await tool.run!({ reason: '  ' }, ctx())).toMatchObject({ isError: true, text: expect.stringMatching(/reason is required/) });
  });

  it('is left out of the tools a scoped tool (run_code) may call', async () => {
    const gateway = new ToolGateway(join(root, 'gw'), join(root, 'gw-tmp'), () => undefined);
    let reached: string[] = [];
    gateway.register([
      ...browserTools(browser),
      {
        name: 'run_code',
        tier: 'read',
        scoped: true,
        description: '',
        inputSchema: {},
        describe: () => ({ title: '' }),
        run: async (_a, _c, scope) => ((reached = scope!.tools.map((t) => t.name)), { text: '' }),
      },
    ]);
    await gateway.start();
    try {
      const grant = gateway.grant(ctx(), ['browser'], { http: true })!;
      const res = await fetch(grant.spec.url, {
        method: 'POST',
        headers: { ...grant.spec.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_code', arguments: {} } }),
      });
      expect(res.status).toBe(200);
      expect(reached).toContain('browser_open');
      expect(reached).not.toContain('browser_hand_over');
      grant.revoke();
    } finally {
      await gateway.stop();
    }
  });
});

describe('the hand-over routes', () => {
  const HOST = { host: '127.0.0.1:8787' };
  const conversation: Conversation = {
    id: 'c1',
    title: 'Sign in',
    createdAt: 1,
    updatedAt: 1,
    agents: [{ id: 'a1', name: 'Claude', provider: 'claude', role: '' }],
    settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'edit', cwd: root },
    messages: [],
    agentState: {},
    worktrees: {},
  };
  const setup = async () => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const auth = new AuthStore(db);
    const handovers = new Handovers();
    const app = createApp({
      auth,
      store,
      settings,
      hub,
      orchestrator: new Orchestrator(store, hub, settings),
      providers: new ProviderService(settings),
      handovers,
    });
    store.create(structuredClone(conversation));
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const headers = { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key };
    const post = (path: string, body: unknown, h: Record<string, string> = headers) =>
      app.request(path, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { app, handovers, headers, post };
  };

  it('are for signed-in browsers only, through the API checks', async () => {
    const { app, handovers, post } = await setup();
    const t = handovers.create('c1', ['screencast']);
    expect((await post(`/api/conversations/c1/handovers/${t.id}`, { action: 'cancel' }, HOST)).status).toBe(401);
    expect((await app.request(`/api/conversations/c1/handovers/${t.id}/screen`, { headers: HOST })).status).toBe(401);
    expect((await post(`/api/conversations/c1/handovers/${t.id}/input`, { events: [{ type: 'text', text: 'a' }] }, HOST)).status).toBe(401);
    expect(t.status).toBe('pending');
  });

  it("start, decline, hand back and cancel a hand-over, saying why an answer is not taken, in the user's language", async () => {
    const { handovers, headers, post } = await setup();
    const t = handovers.create('c1', ['window', 'screencast']);
    const path = `/api/conversations/c1/handovers/${t.id}`;
    expect((await post(path, { action: 'start' })).status).toBe(400);
    expect((await post(path, { action: 'fly' })).status).toBe(400);
    expect((await post('/api/conversations/c1/handovers/nope', { action: 'cancel' })).status).toBe(404);
    expect((await post(`/api/conversations/missing/handovers/${t.id}`, { action: 'cancel' })).status).toBe(404);
    const woke = t.wait(10_000, new AbortController().signal);
    const started = await post(path, { action: 'start', mode: 'window' });
    expect(started.status).toBe(200);
    expect(await woke).toEqual({ action: 'start', mode: 'window' });
    const late = await post(path, { action: 'cancel' }, { ...headers, 'x-relay-lang': 'en' });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: expect.stringMatching(/cannot do that now/) });
    expect(await (await post(path, { action: 'cancel' }, { ...headers, 'x-relay-lang': 'zh-TW' })).json()).toMatchObject({
      error: expect.stringMatching(/交接/),
    });
    t.status = 'active';
    const done = t.wait(10_000, new AbortController().signal);
    expect((await post(path, { action: 'done', note: `  ${'n'.repeat(3000)}  ` })).status).toBe(200);
    expect(await done).toEqual({ action: 'done', note: 'n'.repeat(2000) });
  });

  it("stream a screencast's frames (the latest only, for a browser that falls behind) and take its input in order", async () => {
    const { app, handovers, headers, post } = await setup();
    const t = handovers.create('c1', ['screencast']);
    t.mode = 'screencast';
    t.status = 'active';
    const got: HandoverInput[] = [];
    t.screen = { input: async (events) => void got.push(...events) };
    t.emit({ type: 'location', url: 'https://example.com/', back: false, forward: false });
    t.emit({ type: 'frame', data: 'AAA', width: 10, height: 20 });
    t.emit({ type: 'frame', data: 'BBB', width: 10, height: 20 });
    const res = await app.request(`/api/conversations/c1/handovers/${t.id}/screen`, { headers });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    const readUntil = async (s: string) => {
      while (!text.includes(s)) text += (await reader.read()).value ?? '';
    };
    await readUntil('BBB');
    expect(text).not.toContain('AAA');
    expect(text.indexOf('location')).toBeLessThan(text.indexOf('BBB'));
    const events = [
      { type: 'mouse', action: 'down', x: 0.5, y: 0.5 },
      { type: 'text', text: 'hello' },
    ];
    expect((await post(`/api/conversations/c1/handovers/${t.id}/input`, { events })).status).toBe(200);
    expect(got).toEqual(events);
    expect((await post(`/api/conversations/c1/handovers/${t.id}/input`, { events: [{ type: 'script' }] })).status).toBe(400);
    handovers.remove(t);
    await readUntil('ended');
    expect((await post(`/api/conversations/c1/handovers/${t.id}/input`, { events })).status).toBe(404);
    expect((await app.request(`/api/conversations/c1/handovers/${t.id}/screen`, { headers })).status).toBe(404);
  });
});
