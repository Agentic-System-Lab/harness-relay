/**
 * Starts, watches and stops the server process. The desktop app runs it in an Electron utility
 * process; the process is passed in (`fork`), so the tests can use a fake one.
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { DesktopToServer, ServerToDesktop } from '../../src/shared/types';

/** The parts of Electron's UtilityProcess the supervisor uses. */
export interface ServerChild {
  postMessage(message: DesktopToServer): void;
  kill(): void;
  onMessage(fn: (message: unknown) => void): void;
  onExit(fn: (code: number) => void): void;
  /** stdout and stderr, as they come. */
  onOutput(fn: (chunk: string) => void): void;
}

export type StartError =
  /** Something else listens on the port (a server started with `npm start`, say). */
  | { kind: 'port-in-use'; port: number }
  /** The process ended before it listened, or after, without being asked to. */
  | { kind: 'exited'; code: number; log: string }
  /** It did not start listening in time (and was stopped). */
  | { kind: 'timeout'; log: string };

export type ServerState =
  | { kind: 'stopped'; error?: StartError }
  | { kind: 'starting' }
  | { kind: 'running'; url: string; port: number }
  | { kind: 'stopping' };

export interface SupervisorOptions {
  fork(env: NodeJS.ProcessEnv): ServerChild;
  portFree(port: number): Promise<boolean>;
  /** How long a start may take before it is given up on. */
  startTimeoutMs?: number;
  /** How long the server gets to stop by itself (its own limit is 10 s) before it is killed. */
  stopTimeoutMs?: number;
  /** How long a killed server is waited for before it is given up on. */
  killTimeoutMs?: number;
}

/** The last bytes of the server's output, shown when it fails. */
const LOG_TAIL = 4000;

interface LinkRequest {
  settled: boolean;
  done: (link: string | undefined) => void;
}

export class Supervisor extends EventEmitter<{ state: [ServerState]; output: [string] }> {
  state: ServerState = { kind: 'stopped' };
  private child?: ServerChild;
  private exited?: Promise<number>;
  private tail = '';
  private starting?: Promise<ServerState>;
  /** Set by stop() while a start is under way: the start then ends without a server. */
  private cancelled = false;
  /** Ends the start under way at once (the server has run no agent yet), killing its process. */
  private cancelStart?: () => void;
  /**
   * Each server's requests for a sign-in link, in the order they were sent (it answers in order). Kept
   * per process, so that a server that exits late cannot cancel the requests of the one after it.
   */
  private links = new WeakMap<ServerChild, LinkRequest[]>();

  constructor(private o: SupervisorOptions) {
    super();
  }

  private set(state: ServerState): void {
    this.state = state;
    this.emit('state', state);
  }

  /** Starts the server unless it runs; resolves once it listens, or with why it did not. */
  start(env: NodeJS.ProcessEnv, port: number): Promise<ServerState> {
    if (this.starting) return this.starting;
    if (this.state.kind !== 'stopped') return Promise.resolve(this.state);
    this.starting = this.run(env, port).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async run(env: NodeJS.ProcessEnv, port: number): Promise<ServerState> {
    this.cancelled = false;
    this.set({ kind: 'starting' });
    if (!(await this.o.portFree(port))) {
      this.set({ kind: 'stopped', error: { kind: 'port-in-use', port } });
      return this.state;
    }
    if (this.cancelled) {
      this.set({ kind: 'stopped' });
      return this.state;
    }
    this.tail = '';
    const child = this.o.fork(env);
    this.child = child;
    child.onOutput((chunk) => {
      this.tail = (this.tail + chunk).slice(-LOG_TAIL);
      this.emit('output', chunk);
    });
    this.exited = new Promise((done) => child.onExit(done));
    const links: LinkRequest[] = [];
    this.links.set(child, links);
    child.onMessage((m) => {
      if ((m as ServerToDesktop)?.type !== 'sign-in-link') return;
      const request = links.shift();
      if (request && !request.settled) request.done((m as Extract<ServerToDesktop, { type: 'sign-in-link' }>).link);
    });
    void this.exited.then(() => {
      for (const request of links.splice(0)) if (!request.settled) request.done(undefined);
    });

    const outcome = await new Promise<ServerState>((done) => {
      let settled = false;
      const finish = (state: ServerState) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(state);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ kind: 'stopped', error: { kind: 'timeout', log: this.tail } });
      }, this.o.startTimeoutMs ?? 60_000);
      // Quitting while the server starts (waiting for the keychain, say) ends the start at once: it has
      // not listened, so it runs no agent and has nothing to finish.
      this.cancelStart = () => {
        if (settled) return;
        finish({ kind: 'stopped' });
        child.kill();
      };
      child.onMessage((m) => {
        const msg = m as ServerToDesktop;
        if (msg?.type === 'listening') {
          finish({ kind: 'running', url: `http://127.0.0.1:${msg.port}`, port: msg.port });
        } else if (msg?.type === 'error' && msg.code === 'EADDRINUSE') {
          // Taken between the check and the listen; the server exits next.
          finish({ kind: 'stopped', error: { kind: 'port-in-use', port } });
        }
      });
      void this.exited!.then((code) => finish({ kind: 'stopped', error: { kind: 'exited', code, log: this.tail } }));
    });
    this.cancelStart = undefined;

    if (outcome.kind === 'running') {
      this.set(outcome);
      // From now on an exit nobody asked for is a crash.
      void this.exited.then((code) => {
        if (this.child !== child || this.state.kind === 'stopping') return;
        this.child = undefined;
        this.set({ kind: 'stopped', error: { kind: 'exited', code, log: this.tail } });
      });
    } else {
      // A server killed after a timeout normally exits at once; never wait for it for good.
      await Promise.race([this.exited, new Promise((done) => setTimeout(done, this.o.stopTimeoutMs ?? 20_000).unref?.())]);
      this.child = undefined;
      this.set(outcome);
    }
    return this.state;
  }

  /**
   * A link that signs a browser in, with a new one-time code from the server; undefined when the
   * server does not run or does not answer in time.
   */
  signInLink(timeoutMs = 5000): Promise<string | undefined> {
    const child = this.child;
    if (!child || this.state.kind !== 'running') return Promise.resolve(undefined);
    return new Promise((done) => {
      const request: LinkRequest = {
        settled: false,
        done: (link: string | undefined) => {
          request.settled = true;
          clearTimeout(timer);
          done(link);
        },
      };
      // A late answer still goes to this request (it stays in line), not to the next one.
      const timer = setTimeout(() => request.done(undefined), timeoutMs);
      this.links.get(child)?.push(request);
      child.postMessage({ type: 'sign-in-link' });
    });
  }

  /**
   * Asks the server to stop (it stops the agents first), and kills it if it does not in time. A
   * server still starting is killed at once: it runs no agent yet.
   */
  async stop(): Promise<void> {
    if (this.starting) {
      this.cancelled = true;
      this.cancelStart?.();
      await this.starting;
    }
    const child = this.child;
    if (!child || !this.exited) return;
    this.set({ kind: 'stopping' });
    child.postMessage({ type: 'shutdown' });
    const timeout = (ms: number) => new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), ms).unref?.());
    if ((await Promise.race([this.exited, timeout(this.o.stopTimeoutMs ?? 20_000)])) === 'timeout') {
      child.kill();
      await Promise.race([this.exited, timeout(this.o.killTimeoutMs ?? 5000)]);
    }
    this.child = undefined;
    this.set({ kind: 'stopped' });
  }
}

/** Whether nothing listens on `port` of 127.0.0.1 yet. */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, host, () => probe.close(() => done(true)));
  });
}
