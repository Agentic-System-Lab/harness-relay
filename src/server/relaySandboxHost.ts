/*
 * The relay sandbox's host: one process per sandboxed run, started by the server (`relaySandbox.ts`)
 * through `process.ts`, with a private control channel on its fd 3. It
 *
 * 1. reads the run's rules from the channel (nothing on the command line or in a file);
 * 2. starts sandbox-runtime (`SandboxManager`) with them: its own proxy, which only this run's
 *    sandbox can reach (on macOS, Seatbelt lets the sandbox connect to this proxy's port alone; on
 *    Linux, the sandbox has no network but this proxy's sockets) and which wants a token only this
 *    run's sandbox is given;
 * 3. asks the server over the channel about each host no rule decides (the ask callback), so an
 *    answer always belongs to this run;
 * 4. runs the agent's command in the sandbox, its stdio the host's own (the server's pipes), and the
 *    channel's slot taken by /dev/null so nothing in the sandbox can read or write it;
 * 5. when the agent ends, the server stops it (SIGTERM, SIGINT, SIGHUP) or the channel closes (the
 *    server is gone), stops whatever the agent left in this process group, closes the proxy and
 *    exits.
 *
 * It holds no policy of its own: the server decides every rule and every answer. It is run by Node's
 * own type stripping (no loader, no transform cache a sandboxed command could change), so it is
 * written in erasable TypeScript, imports no other file of Harness Relay and writes nothing to stdout,
 * which belongs to the agent.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

/** What the server sends first. */
interface HostConfig {
  t: 'config';
  /** sandbox-runtime's configuration for this run. */
  srt: SandboxRuntimeConfig;
  /** The shell command to run in the sandbox (it sets the agent's own variables, then execs it). */
  command: string;
  /** The shell sandbox-runtime runs it with, by its full path. */
  binShell: string;
  /** The environment of the processes outside the sandbox that start it (the agent's, made safe). */
  outerEnv: Record<string, string>;
  /** The agent's temporary folder (sandbox-runtime hands it to the command as TMPDIR). */
  tmpdir: string;
  /** A check that the sandbox starts here: run the command, report whether it printed `expect`. */
  probe?: { expect: string };
  /** Loopback ports the agent listens on and connects to itself (macOS: added to the Seatbelt profile). */
  localPorts?: number[];
  /**
   * Loopback ports of this computer the run may reach (a model backend, a server it only connects
   * to), which the proxy allows: macOS lets the run connect to them directly too, never listen on
   * them, for a client that never sends loopback to a proxy (Cline).
   */
  loopbackPorts?: number[];
  /** A marker file every sandboxed process holds a read-only descriptor to, so leftovers are swept (macOS). */
  marker?: string;
}

type ServerMessage = HostConfig | { t: 'answer'; id: number; allow: boolean; reason?: string };

/** Exit codes, besides the agent's own. */
const EXIT_NO_CHANNEL = 70;
const EXIT_FAILED = 71;

const CONFIG_TIMEOUT_MS = 15_000;
/** How long what the agent left behind gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 1_000;

function log(message: string): void {
  process.stderr.write(`[relay-sandbox] ${message}\n`);
}

let channel: Socket;
try {
  // Fails when fd 3 is not there or not a socket: the server always gives one, so the host is not
  // being run as it should, and nothing starts.
  channel = new Socket({ fd: 3, readable: true, writable: true });
} catch (err) {
  log(`no control channel on fd 3 (${(err as Error).message}): the sandbox does not start`);
  process.exit(EXIT_NO_CHANNEL);
}

function send(message: Record<string, unknown>): void {
  if (!channel.destroyed && channel.writable) channel.write(`${JSON.stringify(message)}\n`);
}

let child: ChildProcess | undefined;
let markerPath: string | undefined;
let stopping = false;
let initialized = false;
const pending = new Map<number, (answer: boolean | { allow: false; reason: string }) => void>();
let nextAsk = 1;

/** Ends the channel after what was sent, or gives up waiting. */
function endChannel(): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, 1000);
    channel.end(() => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Fails the run before anything is started in the sandbox, and exits. */
async function fail(code: string, detail: string): Promise<never> {
  log(`the sandbox could not start (${code}): ${detail}`);
  send({ t: 'failed', code, detail });
  await endChannel();
  if (initialized) await SandboxManager.reset().catch(() => undefined);
  process.exit(EXIT_FAILED);
}

/** Each live process on this computer as [pid, ppid, pgid]; a zombie is left out (it is already dead). */
function processTable(): [number, number, number][] {
  const rows: [number, number, number][] = [];
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        // The fields after the command name, which is in parentheses and may hold anything.
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (f[0] !== 'Z') rows.push([Number(name), Number(f[1]), Number(f[2])]);
      } catch {
        /* gone */
      }
    }
  } else {
    const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8', timeout: 2000 });
    for (const line of (r.stdout ?? '').split('\n')) {
      const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
      if (pid && ppid && pgid && !stat?.startsWith('Z')) rows.push([Number(pid), Number(ppid), Number(pgid)]);
    }
  }
  return rows;
}

/**
 * Everything the agent left running: this host's descendants (by parent, which reaches bubblewrap
 * after it has put itself in a session of its own) and whatever is still in the host's process group,
 * minus the host. bubblewrap also ends its sandbox as soon as the host goes (`--die-with-parent`),
 * and its PID namespace takes the rest along; this is the backstop and catches what macOS's Seatbelt,
 * which keeps the tree in the host's group, leaves.
 */
function othersInGroup(): number[] {
  const rows = processTable();
  const group = process.pid;
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const found = new Set<number>();
  const stack = [process.pid];
  while (stack.length) {
    for (const pid of children.get(stack.pop()!) ?? []) {
      if (!found.has(pid)) {
        found.add(pid);
        stack.push(pid);
      }
    }
  }
  for (const [pid, , pgid] of rows) if (pgid === group) found.add(pid);
  found.delete(process.pid);
  return [...found].filter((pid) => pid > 0);
}

function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }
}

/**
 * On macOS, kills what still holds the run's marker descriptor: a sandboxed process that left this
 * host's process group (a backgrounded or re-parented command, a tmux server) still carries the
 * inherited descriptor, so `lsof` finds it however it was re-parented and whatever group it is in now.
 * The host does not hold the descriptor itself (it closes its copy after the spawn), so every holder
 * is the sandbox's. Not on Linux: the PID namespace ends the tree with bubblewrap.
 */
function sweepByMarker(): void {
  if (!markerPath || process.platform !== 'darwin') return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-t', '--', markerPath], { encoding: 'utf8', timeout: 6000, maxBuffer: 1 << 22 });
    const pids = (r.stdout ?? '')
      .split('\n')
      .map((n) => Number(n.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
    if (!pids.length) return;
    signalAll(pids, 'SIGKILL');
  }
}

/**
 * Stops the run: the agent's tree in this process group (SIGTERM, then SIGKILL once the grace is
 * over), then sandbox-runtime (its proxy, its sockets and the mount points it made on Linux), then
 * exits with `code`. On Linux the sandbox is in a session of its own, but bubblewrap ends it as soon
 * as its parent goes (`--die-with-parent`) and its PID namespace takes everything in it along.
 */
async function stop(code: number): Promise<never> {
  if (stopping) return new Promise<never>(() => undefined);
  stopping = true;
  for (const answer of pending.values()) answer(false);
  pending.clear();
  let others = othersInGroup();
  if (others.length) {
    signalAll(others, 'SIGTERM');
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline && (others = othersInGroup()).length) await new Promise((r) => setTimeout(r, 50));
    signalAll(others, 'SIGKILL');
  }
  if (initialized) {
    try {
      SandboxManager.cleanupAfterCommand();
    } catch {
      /* best effort */
    }
    // Closes sandbox-runtime's own proxy and, on Linux, the socat bridge it runs beside the sandbox.
    await SandboxManager.reset().catch((err: Error) => log(`could not stop sandbox-runtime cleanly: ${err.message}`));
    // A last SIGKILL sweep: anything the reset left, or that only now re-parented to this host.
    signalAll(othersInGroup(), 'SIGKILL');
  }
  // And whatever left this host's group but still holds the run's marker (macOS; backgrounded, tmux).
  sweepByMarker();
  channel.destroy();
  process.exit(code);
}

// The server stops a run by signalling its whole process group, this host included: the agent got
// the same signal, so this only waits for it and cleans up. (sandbox-runtime's own handlers only reset.)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => void stop(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGINT' ? 2 : 1)));
}

let config: HostConfig | undefined;
let configured: (c: HostConfig) => void = () => undefined;
const configPromise = new Promise<HostConfig>((resolve) => (configured = resolve));

createInterface({ input: channel, crlfDelay: Infinity }).on('line', (line) => {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(line) as ServerMessage;
  } catch {
    return;
  }
  if (msg.t === 'config' && !config) {
    config = msg;
    configured(msg);
  } else if (msg.t === 'answer') {
    const answer = pending.get(msg.id);
    if (!answer) return;
    pending.delete(msg.id);
    // Only `true` allows; a deny carries the reason the model sees.
    answer(msg.allow === true ? true : { allow: false, reason: String(msg.reason ?? 'not allowed') });
  }
});
// The server is gone (or closed its end): nothing may run on without it.
channel.on('close', () => void stop(child ? 143 : EXIT_FAILED));
channel.on('error', () => undefined);

const timer = setTimeout(() => void fail('config', 'no rules came from the server'), CONFIG_TIMEOUT_MS);
const c = await configPromise;
clearTimeout(timer);

// sandbox-runtime reads these when it wraps the command: the agent's temporary folder becomes its
// TMPDIR (and the only temporary folder it may write), and no proxy of the server's environment is
// taken as an upstream (the server starts the host without one).
process.env.CLAUDE_CODE_TMPDIR = c.tmpdir;
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
  delete process.env[name];
}

// An older sandbox-runtime reads `{ allow: false, reason }` from the ask callback as an allow.
if (SandboxManager.askCallbackDenyReason !== true) await fail('version', 'this sandbox-runtime cannot deny with a reason');

const ask = (params: { host: string; port: number | undefined }): Promise<boolean | { allow: false; reason: string }> => {
  if (stopping) return Promise.resolve(false);
  const id = nextAsk++;
  return new Promise((answer) => {
    pending.set(id, answer);
    send({ t: 'ask', id, host: params.host, port: params.port ?? null });
  });
};

try {
  await SandboxManager.initialize(c.srt, ask, false);
  initialized = true;
} catch (err) {
  await fail('init', (err as Error).message);
}

// What sandbox-runtime only warns about would leave a hole here: Unix sockets open on Linux
// (Docker's socket, the SSH agent…), or sandbox-runtime itself writable by the sandbox.
const deps = SandboxManager.checkDependencies();
if (deps.errors.length) await fail('deps', deps.errors.join('; '));
const weak = deps.warnings.find((w) => /seccomp not available|sandbox-runtime is installed/i.test(w));
if (weak) await fail(/seccomp/i.test(weak) ? 'seccomp' : 'install', weak);
for (const warning of deps.warnings) if (warning !== weak) log(warning);
const globs = SandboxManager.getLinuxGlobPatternWarnings();
if (globs.length) await fail('pattern', `read as patterns and skipped: ${globs.join(', ')}`);

let wrapped: string;
try {
  wrapped = await SandboxManager.wrapWithSandbox(c.command, c.binShell);
} catch (err) {
  await fail('wrap', (err as Error).message);
}

/**
 * On macOS, lets the sandbox listen on the agent's own loopback ports and connect to them, and to no
 * other local port: sandbox-runtime's `allowLocalBinding` would open every one (Harness Relay's own
 * API, other local services, other runs' servers). The rules go right after the one for the proxy's
 * port, in the profile sandbox-runtime wrote, which must hold that rule exactly once. On Linux the
 * sandbox has a loopback of its own, so nothing is added.
 */
function withLocalPorts(command: string, ports: readonly number[], proxyPort: number | undefined, connectOnly: readonly number[] = []): string {
  const outbound = connectOnly.filter((p) => !ports.includes(p));
  if ((!ports.length && !outbound.length) || process.platform !== 'darwin') return command;
  if (proxyPort === undefined) throw new Error('no proxy port to add the local ports beside');
  const anchor = `(allow network-outbound (remote ip "localhost:${proxyPort}"))`;
  const at = command.indexOf(anchor);
  if (at < 0 || command.indexOf(anchor, at + 1) >= 0) throw new Error('the sandbox profile is not as expected');
  const rules = [
    ...ports.map((p) => `(allow network-bind (local ip "localhost:${p}"))(allow network-inbound (local ip "localhost:${p}"))(allow network-outbound (remote ip "localhost:${p}"))`),
    ...outbound.map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
  ].join('');
  return command.slice(0, at + anchor.length) + rules + command.slice(at + anchor.length);
}

const port = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;

try {
  wrapped = withLocalPorts(wrapped!, (c.localPorts ?? []).filter(port), SandboxManager.getProxyPort(), (c.loopbackPorts ?? []).filter(port));
} catch (err) {
  await fail('wrap', (err as Error).message);
}

if (c.probe) {
  const expect = c.probe.expect;
  const probe = spawn('/bin/sh', ['-c', wrapped!], { env: c.outerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  probe.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  probe.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const code = await new Promise<number | null>((done) => {
    probe.on('error', (e) => {
      err += e.message;
      done(null);
    });
    probe.on('close', (status) => done(status));
  });
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    /* best effort */
  }
  if (code === 0 && out.trim() === expect) {
    send({ t: 'probe', ok: true });
    await endChannel();
    await SandboxManager.reset().catch(() => undefined);
    process.exit(0);
  }
  await fail('probe', (err.trim() || `exit ${code}`).slice(-600));
}

send({ t: 'ready', proxyPort: SandboxManager.getProxyPort() ?? null, socksPort: SandboxManager.getSocksProxyPort() ?? null });

// The channel's slot (fd 3) is /dev/null for the sandboxed processes: on Linux an inherited fd 3
// would otherwise stay open in them.
const devNull = openSync('/dev/null', 'r');
// Every sandboxed process inherits a read-only descriptor to the run's marker (fd 4), so a leftover
// that kept it is found by `lsof` at stop and at the next server start, however it was re-parented.
const stdio: Array<'inherit' | number> = ['inherit', 'inherit', 'inherit', devNull];
let markerFd: number | undefined;
if (c.marker && process.platform === 'darwin') {
  try {
    markerFd = openSync(c.marker, 'r');
    markerPath = c.marker;
    stdio.push(markerFd);
  } catch (err) {
    log(`could not open the marker ${c.marker}: ${(err as Error).message}`);
  }
}
child = spawn('/bin/sh', ['-c', wrapped!], { env: c.outerEnv, stdio });
// The child has its own copy now; the host keeps none, so every later holder is the sandbox's.
if (markerFd !== undefined) {
  try {
    closeSync(markerFd);
  } catch {
    /* already closed */
  }
}
child.on('error', (err) => void fail('spawn', err.message));
child.on('exit', (code, signal) => {
  send({ t: 'exit', code, signal });
  void stop(code ?? (signal === 'SIGKILL' ? 137 : 143));
});
