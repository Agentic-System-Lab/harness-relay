import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { DesktopToServer } from '../src/shared/types';
import { portFree, Supervisor, type ServerChild, type ServerState } from '../desktop/src/supervisor';

/** A fake server process: the test says what it sends and when it exits. */
class FakeServer extends EventEmitter implements ServerChild {
  received: DesktopToServer[] = [];
  killed = false;
  /** Exit by itself when asked to shut down (a well-behaved server). */
  obeys = true;
  /** Exit when killed (a server stuck for good would not). */
  dies = true;
  env?: NodeJS.ProcessEnv;
  postMessage(m: DesktopToServer) {
    this.received.push(m);
    if (m.type === 'shutdown' && this.obeys) setTimeout(() => this.exit(0), 5);
  }
  kill() {
    this.killed = true;
    if (this.dies) setTimeout(() => this.exit(143), 5);
  }
  onMessage(fn: (m: unknown) => void) {
    this.on('message', fn);
  }
  onExit(fn: (code: number) => void) {
    this.once('exit', fn);
  }
  onOutput(fn: (chunk: string) => void) {
    this.on('output', fn);
  }
  listening(port = 8787) {
    this.emit('message', { type: 'listening', host: '127.0.0.1', port });
  }
  exit(code: number) {
    this.emit('exit', code);
  }
}

function setup(o: { free?: boolean | (() => Promise<boolean>); startTimeoutMs?: number; stopTimeoutMs?: number; killTimeoutMs?: number } = {}) {
  const servers: FakeServer[] = [];
  const states: ServerState['kind'][] = [];
  const supervisor = new Supervisor({
    fork(env) {
      const s = new FakeServer();
      s.env = env;
      servers.push(s);
      return s;
    },
    portFree: async () => (typeof o.free === 'function' ? o.free() : (o.free ?? true)),
    startTimeoutMs: o.startTimeoutMs,
    stopTimeoutMs: o.stopTimeoutMs,
    killTimeoutMs: o.killTimeoutMs,
  });
  supervisor.on('state', (s) => states.push(s.kind));
  return { supervisor, servers, states };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the server supervisor', () => {
  it('starts the server with its environment and is running once it listens', async () => {
    const { supervisor, servers, states } = setup();
    const started = supervisor.start({ PORT: '8787' }, 8787);
    await tick();
    expect(servers[0]!.env).toEqual({ PORT: '8787' });
    servers[0]!.listening();
    expect(await started).toEqual({ kind: 'running', url: 'http://127.0.0.1:8787', port: 8787 });
    expect(states).toEqual(['starting', 'running']);
  });

  it('does not start a second server while one starts or runs', async () => {
    const { supervisor, servers } = setup();
    const a = supervisor.start({}, 8787);
    const b = supervisor.start({}, 8787);
    await tick();
    servers[0]!.listening();
    await Promise.all([a, b]);
    await supervisor.start({}, 8787);
    expect(servers).toHaveLength(1);
  });

  it('does not start when the port is taken', async () => {
    const { supervisor, servers } = setup({ free: false });
    expect(await supervisor.start({}, 8787)).toEqual({ kind: 'stopped', error: { kind: 'port-in-use', port: 8787 } });
    expect(servers).toHaveLength(0);
  });

  it('reports a port taken between the check and the listen', async () => {
    const { supervisor, servers } = setup();
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.emit('message', { type: 'error', code: 'EADDRINUSE', message: 'listen EADDRINUSE' });
    servers[0]!.exit(1);
    expect(await started).toEqual({ kind: 'stopped', error: { kind: 'port-in-use', port: 8787 } });
  });

  it('keeps the end of the output of a server that exits before it listens', async () => {
    const { supervisor, servers } = setup();
    const output: string[] = [];
    supervisor.on('output', (c) => output.push(c));
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.emit('output', 'Error: something broke\n');
    servers[0]!.exit(1);
    expect(await started).toEqual({ kind: 'stopped', error: { kind: 'exited', code: 1, log: 'Error: something broke\n' } });
    expect(output).toEqual(['Error: something broke\n']);
  });

  it('stops a server that does not listen in time', async () => {
    const { supervisor, servers } = setup({ startTimeoutMs: 20 });
    const state = await supervisor.start({}, 8787);
    expect(state.kind === 'stopped' && state.error?.kind).toBe('timeout');
    expect(servers[0]!.killed).toBe(true);
  });

  it('gives up on a server that neither listens in time nor exits when killed', async () => {
    const { supervisor, servers } = setup({ startTimeoutMs: 20, stopTimeoutMs: 30 });
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.dies = false;
    const state = await started;
    expect(state.kind === 'stopped' && state.error?.kind).toBe('timeout');
    await supervisor.stop(); // and quitting does not wait for it either
  });

  it('asks the server to shut down, and waits for it', async () => {
    const { supervisor, servers, states } = setup();
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.listening();
    await started;
    await supervisor.stop();
    expect(servers[0]!.received).toEqual([{ type: 'shutdown' }]);
    expect(servers[0]!.killed).toBe(false);
    expect(supervisor.state).toEqual({ kind: 'stopped' });
    expect(states.slice(-2)).toEqual(['stopping', 'stopped']);
  });

  it('kills a server that does not stop in time', async () => {
    const { supervisor, servers } = setup({ stopTimeoutMs: 20 });
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.obeys = false;
    servers[0]!.listening();
    await started;
    await supervisor.stop();
    expect(servers[0]!.killed).toBe(true);
    expect(supervisor.state).toEqual({ kind: 'stopped' });
  });

  it('reports a crash, and starts a new server afterwards', async () => {
    const { supervisor, servers } = setup();
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.listening();
    await started;
    servers[0]!.emit('output', 'FATAL\n');
    servers[0]!.exit(1);
    await tick();
    expect(supervisor.state).toEqual({ kind: 'stopped', error: { kind: 'exited', code: 1, log: 'FATAL\n' } });
    const again = supervisor.start({}, 8787);
    await tick();
    servers[1]!.listening();
    expect((await again).kind).toBe('running');
  });

  it('ends a start in progress at once when asked to stop, killing the server that does not listen yet', async () => {
    // Quitting while the server waits for the keychain must not wait for the three-minute start limit.
    const { supervisor, servers } = setup({ startTimeoutMs: 60_000 });
    const started = supervisor.start({}, 8787);
    await tick();
    const before = Date.now();
    await supervisor.stop();
    expect(Date.now() - before).toBeLessThan(1000);
    expect(servers[0]!.killed).toBe(true);
    expect(await started).toEqual({ kind: 'stopped' });
    expect(supervisor.state).toEqual({ kind: 'stopped' });
  });

  it('starts no server when asked to stop during the port check', async () => {
    let free!: (yes: boolean) => void;
    const { supervisor, servers } = setup({ free: () => new Promise((r) => (free = r)) });
    const started = supervisor.start({}, 8787);
    await tick();
    const stopped = supervisor.stop();
    free(true);
    await stopped;
    expect(servers).toHaveLength(0);
    expect(await started).toEqual({ kind: 'stopped' });
  });

  it('stops a server that listened just before the stop the usual way', async () => {
    const { supervisor, servers } = setup();
    void supervisor.start({}, 8787);
    await tick();
    servers[0]!.listening();
    await supervisor.stop();
    expect(servers[0]!.received).toEqual([{ type: 'shutdown' }]);
    expect(servers[0]!.killed).toBe(false);
    expect(supervisor.state).toEqual({ kind: 'stopped' });
  });

  it('stops once when asked twice at the same time (a restart, then quit)', async () => {
    const { supervisor, servers, states } = setup();
    void supervisor.start({}, 8787);
    await tick();
    servers[0]!.listening();
    await tick();
    await Promise.all([supervisor.stop(), supervisor.stop()]);
    expect(servers[0]!.received.filter((m) => m.type === 'shutdown').length).toBeGreaterThanOrEqual(1);
    expect(supervisor.state).toEqual({ kind: 'stopped' });
    expect(states.at(-1)).toBe('stopped');
  });

  it('reports any other listen error as an exit, with the output', async () => {
    const { supervisor, servers } = setup();
    const started = supervisor.start({}, 80);
    await tick();
    servers[0]!.emit('message', { type: 'error', code: 'EACCES', message: 'listen EACCES: permission denied 127.0.0.1:80' });
    servers[0]!.emit('output', '[server] could not listen on http://127.0.0.1:80: permission denied\n');
    servers[0]!.exit(1);
    expect(await started).toEqual({
      kind: 'stopped',
      error: { kind: 'exited', code: 1, log: '[server] could not listen on http://127.0.0.1:80: permission denied\n' },
    });
  });

  it('does not report a crash for an exit while it stops the server', async () => {
    const { supervisor, servers, states } = setup({ stopTimeoutMs: 50 });
    const all: ServerState[] = [];
    supervisor.on('state', (state) => all.push(state));
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.obeys = false;
    servers[0]!.listening();
    await started;
    const stopped = supervisor.stop();
    servers[0]!.exit(0); // it stopped by itself meanwhile
    await stopped;
    await tick();
    expect(supervisor.state).toEqual({ kind: 'stopped' });
    expect(all.filter((state) => state.kind === 'stopped' && state.error)).toEqual([]);
    expect(states.slice(-2)).toEqual(['stopping', 'stopped']);
  });

  it('starts no second server while one stops', async () => {
    const { supervisor, servers } = setup({ stopTimeoutMs: 1000 });
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.listening();
    await started;
    servers[0]!.obeys = false;
    const stopped = supervisor.stop();
    expect(await supervisor.start({}, 8787)).toEqual({ kind: 'stopping' });
    expect(servers).toHaveLength(1);
    servers[0]!.exit(0);
    await stopped;
  });

  it('does nothing when asked to stop with no server', async () => {
    const { supervisor, states } = setup();
    await supervisor.stop();
    expect(states).toEqual([]);
  });
});

describe('sign-in links', () => {
  /** A server that answers a request for a sign-in link with a numbered one. */
  async function running(o: { answers?: boolean } = {}) {
    const ctx = setup();
    const started = ctx.supervisor.start({}, 8787);
    await tick();
    const server = ctx.servers[0]!;
    let n = 0;
    const post = server.postMessage.bind(server);
    server.postMessage = (m) => {
      post(m);
      if (m.type === 'sign-in-link' && o.answers !== false) setTimeout(() => server.emit('message', { type: 'sign-in-link', link: `http://127.0.0.1:8787/#code=C${++n}` }), 1);
    };
    server.listening();
    await started;
    return { ...ctx, server };
  }

  it('asks the server for a new one each time', async () => {
    const { supervisor, server } = await running();
    expect(await supervisor.signInLink()).toBe('http://127.0.0.1:8787/#code=C1');
    expect(await supervisor.signInLink()).toBe('http://127.0.0.1:8787/#code=C2');
    expect(server.received).toEqual([{ type: 'sign-in-link' }, { type: 'sign-in-link' }]);
  });

  it('gives none when the server does not answer in time, and a late answer goes to that request', async () => {
    const { supervisor, server } = await running({ answers: false });
    expect(await supervisor.signInLink(10)).toBeUndefined();
    const second = supervisor.signInLink(1000);
    server.emit('message', { type: 'sign-in-link', link: 'late, for the first request' });
    server.emit('message', { type: 'sign-in-link', link: 'http://127.0.0.1:8787/#code=SECOND' });
    expect(await second).toBe('http://127.0.0.1:8787/#code=SECOND');
  });

  it('gives none when the server does not run, or stops before it answers', async () => {
    const { supervisor: idle } = setup();
    expect(await idle.signInLink()).toBeUndefined();
    const { supervisor, server } = await running({ answers: false });
    const pending = supervisor.signInLink(5000);
    server.exit(1);
    expect(await pending).toBeUndefined();
  });

  it("does not let a server that exits late cancel the next server's requests", async () => {
    // The first server ignores both the shutdown and the kill, so the stop gives up on it.
    const { supervisor, servers } = setup({ stopTimeoutMs: 10, killTimeoutMs: 10 });
    void supervisor.start({}, 8787);
    await tick();
    const old = servers[0]!;
    old.obeys = false;
    old.dies = false;
    old.listening();
    await tick();
    await supervisor.stop();
    const started = supervisor.start({}, 8787);
    await tick();
    const next = servers[1]!;
    next.listening();
    await started;
    const link = supervisor.signInLink(1000);
    old.exit(137); // the old server goes at last
    next.emit('message', { type: 'sign-in-link', link: 'http://127.0.0.1:8787/#code=NEXT' });
    expect(await link).toBe('http://127.0.0.1:8787/#code=NEXT');
  });

  it('does not mistake a link for the end of the start', async () => {
    const { supervisor, servers } = setup();
    const started = supervisor.start({}, 8787);
    await tick();
    servers[0]!.emit('message', { type: 'sign-in-link', link: 'x' });
    servers[0]!.listening();
    expect((await started).kind).toBe('running');
  });
});

describe('conversations with agents at work', () => {
  async function running() {
    const ctx = setup();
    const started = ctx.supervisor.start({}, 8787);
    await tick();
    const server = ctx.servers[0]!;
    server.listening();
    await started;
    return { ...ctx, server };
  }

  it('asks the server how many there are, each time', async () => {
    const { supervisor, server } = await running();
    let busy = 3;
    const post = server.postMessage.bind(server);
    server.postMessage = (m) => {
      post(m);
      if (m.type === 'busy') setTimeout(() => server.emit('message', { type: 'busy', conversations: busy-- }), 1);
    };
    expect(await supervisor.busy()).toBe(3);
    expect(await supervisor.busy()).toBe(2);
    expect(server.received).toEqual([{ type: 'busy' }, { type: 'busy' }]);
  });

  it('does not take a sign-in link for the answer, nor the answer for a link', async () => {
    const { supervisor, server } = await running();
    const busy = supervisor.busy(1000);
    const link = supervisor.signInLink(1000);
    server.emit('message', { type: 'sign-in-link', link: 'http://127.0.0.1:8787/#code=C1' });
    server.emit('message', { type: 'busy', conversations: 0 });
    expect(await busy).toBe(0);
    expect(await link).toBe('http://127.0.0.1:8787/#code=C1');
  });

  it('gives no number when the server does not run, does not answer in time, or stops first', async () => {
    const { supervisor: idle } = setup();
    expect(await idle.busy()).toBeUndefined();
    const { supervisor, server } = await running();
    expect(await supervisor.busy(10)).toBeUndefined();
    const pending = supervisor.busy(5000);
    server.emit('message', { type: 'busy', conversations: 4 }); // late, for the first question
    const last = supervisor.busy(5000);
    server.exit(1);
    expect(await pending).toBeUndefined();
    expect(await last).toBeUndefined();
  });
});

describe('checking the port', () => {
  it('is free until something listens on it', async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = (taken.address() as { port: number }).port;
    expect(await portFree(port)).toBe(false);
    await new Promise((r) => taken.close(r));
    expect(await portFree(port)).toBe(true);
  });
});
