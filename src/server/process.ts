import { spawn, spawnSync, type ChildProcess, type SpawnOptions as ChildOptions, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, posix, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { t } from './i18n';
import { windowsLaunch, type WindowsLaunch } from './winLaunch';

/**
 * A private two-way channel a process gets besides its stdio, as its fd 3 (a socket pair the server
 * holds the other end of), and what the server does with its end once the process is spawned. The
 * relay sandbox's host (`relaySandbox.ts`) takes its rules and asks about hosts over it.
 */
export type ControlChannel = (channel: Duplex, child: ChildProcess) => void;

/**
 * Where a `ControlChannel` can also ride along: on the `env` passed to `runProcess`, under this key,
 * which spreading `env` (`{ ...env, X: '1' }`) keeps and `spawn` leaves out (it only takes string
 * keys). So an adapter that passes the env a sandbox command came with passes its channel too.
 */
export const CONTROL_CHANNEL: unique symbol = Symbol.for('harness-relay.controlChannel');

/** The channel a spawn asks for: `channel`, else the one riding on its env. */
function controlChannelOf(o: Pick<SpawnOptions, 'channel' | 'env'>): ControlChannel | undefined {
  if (o.channel) return o.channel;
  const riding = (o.env as Record<PropertyKey, unknown>)[CONTROL_CHANNEL];
  return typeof riding === 'function' ? (riding as ControlChannel) : undefined;
}

export interface SpawnOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. When omitted stdin is /dev/null. */
  stdin?: string | Buffer;
  /** Keep stdin open for a two-way protocol; the caller writes and ends it through `onSpawn`. */
  keepStdinOpen?: boolean;
  /** Called once the child is spawned (before any output is read). */
  onSpawn?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called for every stdout line (without the trailing newline). */
  onLine?: (line: string) => void;
  /** Max bytes of stdout kept in the result (the oldest output is dropped first, unless `keepStart`). */
  maxCapture?: number;
  /** Keep the first `maxCapture` bytes of stdout instead of the last. */
  keepStart?: boolean;
  /** A control channel for the process, on its fd 3 (see `ControlChannel`; also taken from `env`). */
  channel?: ControlChannel;
  /**
   * Two pipes on its fds 3 and 4, as Chromium's `--remote-debugging-pipe` reads its commands from fd 3
   * and writes its answers to fd 4: given the end to write to and the end to read from. Not with `channel`.
   */
  pipes?: (write: Duplex, read: Duplex, child: ChildProcess) => void;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stdout decoded as UTF-8. */
  stdout: string;
  /** stdout exactly as the process wrote it (for patches and other binary-safe output). */
  stdoutBytes: Buffer;
  /** More than `maxCapture` bytes of stdout were written, so some were dropped. */
  stdoutTruncated: boolean;
  /** How many bytes of stdout were written in total. */
  stdoutSize: number;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

const MAX_CAPTURE = 64 * 1024;
/** How long a stopped process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 3000;
const live = new Set<ChildProcess>();
/** Stopped process groups still waiting for their SIGKILL (the CLI may be gone, subprocesses not). */
const stopping = new Set<ChildProcess>();

/** Bytes kept from a stream: the latest `max` bytes, or the first ones with `keepStart`. */
class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  total = 0;
  truncated = false;
  constructor(
    private max = MAX_CAPTURE,
    private keepStart = false,
  ) {}

  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.keepStart) {
      const room = this.max - this.size;
      if (chunk.length > room) this.truncated = true;
      if (room > 0) {
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        this.chunks.push(kept);
        this.size += kept.length;
      }
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max) {
      this.truncated = true;
      const first = this.chunks[0]!;
      const excess = this.size - this.max;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Signal the whole process group so tool subprocesses (shells, test runners…) get it too. The group
 * is signalled even after the CLI itself exited: its subprocesses may still be running.
 */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return; // the group is gone
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

export class CommandNotFoundError extends Error {
  constructor(public bin: string) {
    super(t().commandNotFound(bin));
  }
}

/** A relative executable path (`./bin/claude`) means the same file wherever the agent runs. */
export function resolveBin(bin: string): string {
  return bin.includes('/') && !isAbsolute(bin) ? resolve(bin) : bin;
}

/**
 * What to start for a CLI: on Windows, the program its `.cmd` runs when the CLI is one (npm's
 * cmd-shim, Cursor's launcher; `winLaunch.ts`), since a script would need a shell; elsewhere the CLI
 * itself, or the Node beside it for a Node script (`posixLaunch`). Throws when it is a script whose
 * program cannot be told.
 */
export function launchOf(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): WindowsLaunch {
  const resolved = resolveBin(bin);
  return platform === 'win32' ? windowsLaunch(resolved, args, env) : posixLaunch(resolved, args, env);
}

/** What `posixLaunch` reads of the disk. */
export interface PosixLaunchFs {
  /** Whether the path is a file that may be run. */
  isProgram(path: string): boolean;
  /** The file's first bytes, as text (through a link), or undefined when it cannot be read. */
  head(path: string): string | undefined;
}

const realPosixFs: PosixLaunchFs = {
  isProgram: (p) => {
    try {
      if (!statSync(p).isFile()) return false;
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  head: (p) => {
    let fd: number | undefined;
    try {
      fd = openSync(p, 'r');
      const buf = Buffer.alloc(128);
      return buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

/** A Node script's first line as npm's packages write it, which has `env` look for `node` on the PATH. */
const NODE_SCRIPT = /^#!\/usr\/bin\/env node[ \t]*\r?\n/;

/**
 * What to start for `bin` (a path, or a name the PATH finds) on macOS and Linux: the CLI itself, but
 * for a Node script (`#!/usr/bin/env node`, as npm links a package's program) at a path whose folder
 * holds a `node` while the PATH it would run with has none, for which `env` would find no Node: that
 * runs on the `node` beside it, as npm's own shims run one, and as `windowsLaunch` does on Windows.
 * So does a CLI that Harness Relay installed with Node.js's own build in its folder (npm not being on
 * the PATH): Codex's and Copilot's programs are such scripts, in the folder's `bin` beside its Node.
 * With a `node` on the PATH, everything starts as it is.
 */
export function posixLaunch(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, fs: PosixLaunchFs = realPosixFs): WindowsLaunch {
  const as = { file: bin, args: [...args] };
  if (!posix.isAbsolute(bin)) return as;
  const beside = posix.join(posix.dirname(bin), 'node');
  if (!fs.isProgram(beside)) return as;
  const onPath = (env.PATH ?? '').split(':').some((dir) => posix.isAbsolute(dir) && fs.isProgram(posix.join(dir, 'node')));
  if (onPath || !NODE_SCRIPT.test(fs.head(bin) ?? '')) return as;
  return { file: beside, args: [bin, ...args] };
}

/** The CLI's environment with what its launch needs besides. */
const withLaunchEnv = (env: NodeJS.ProcessEnv, launch: WindowsLaunch): NodeJS.ProcessEnv => (launch.env ? { ...env, ...launch.env } : env);

/**
 * Told of every process `runProcess()` and `runShellScript()` start, and of what passes through their
 * stdin, stdout and stderr. Only `scripts/cli-check.ts` sets one (`recordSpawns`), to record what a
 * CLI and the server's own code say to each other; the server never does. It is told nothing of the
 * environment, where the keys are.
 */
export interface SpawnRecorder {
  start(o: { bin: string; args: readonly string[]; cwd?: string }): SpawnRecording | undefined;
}

export interface SpawnRecording {
  data(stream: 'stdin' | 'stdout' | 'stderr', chunk: Buffer): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
}

let recorder: SpawnRecorder | undefined;

/** Sets the recorder every process started from now on is told of (undefined: none). */
export function recordSpawns(r: SpawnRecorder | undefined): void {
  recorder = r;
}

/** The recording of a process just started, if a recorder is set; a recorder that throws records nothing. */
function recordingOf(bin: string, args: readonly string[], cwd: string | undefined): SpawnRecording | undefined {
  try {
    return recorder?.start({ bin, args, ...(cwd ? { cwd } : {}) });
  } catch {
    return undefined;
  }
}

/** Passes what goes through a child's stdio to a recording, as it goes: what is written to its stdin too. */
function tap(child: ChildProcess, recording: SpawnRecording): void {
  const safe = (stream: 'stdin' | 'stdout' | 'stderr', chunk: unknown) => {
    try {
      if (chunk == null) return;
      recording.data(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
    } catch {
      /* a recording never stops the process */
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => safe('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => safe('stderr', chunk));
  const stdin = child.stdin;
  if (!stdin) return;
  const write = stdin.write.bind(stdin) as (...a: unknown[]) => boolean;
  const end = stdin.end.bind(stdin) as (...a: unknown[]) => typeof stdin;
  stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    safe('stdin', chunk);
    return write(chunk, ...rest);
  }) as typeof stdin.write;
  stdin.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== 'function') safe('stdin', chunk);
    return end(chunk, ...rest);
  }) as typeof stdin.end;
}

/** How runProcess and runShellScript run what they start: everything but the program and its arguments. */
export type RunOptions = Omit<SpawnOptions, 'bin' | 'args'>;

/** Spawn a CLI, stream its stdout line by line, and resolve when it exits. It never runs through a shell. */
export function runProcess(o: SpawnOptions): Promise<SpawnResult> {
  let launch: WindowsLaunch;
  try {
    launch = launchOf(o.bin, o.args, o.env);
  } catch (err) {
    return Promise.reject(err);
  }
  // Not found on Windows: started bare, it would be looked for in the working directory (the agent's
  // project) first. A missing working directory is still said first (by `supervise`).
  if (launch.missing && !(o.cwd && !existsSync(o.cwd))) return Promise.reject(new CommandNotFoundError(o.bin));
  return supervise(o.bin, { ...o, env: withLaunchEnv(o.env, launch) }, (options) => spawn(launch.file, launch.args, options), o.args);
}

/**
 * Runs `script` in `shell` (`<shell> <flags> -c <script>`), streamed, stopped and killed as runProcess
 * does. The script is fixed text: never build it from a path, a name or a setting. Whatever it needs
 * goes in `o.env`, read as a quoted `"$NAME"`. This is the only way here to run a shell script, so no
 * other program is ever started through one.
 */
export function runShellScript(shell: string, flags: readonly string[], script: string, o: RunOptions): Promise<SpawnResult> {
  return supervise(shell, o, (options) => spawn(shell, [...flags, '-c', script], options), [...flags, '-c', script]);
}

/**
 * Whether a child is started detached, in a process group of its own.
 *
 * On macOS and Linux, yes: `killTree` signals the group, so a shell or a test runner the CLI started
 * is stopped with it.
 *
 * On Windows, no. Detached makes Node pass `DETACHED_PROCESS`, and Windows then ignores
 * `CREATE_NO_WINDOW` (`windowsHide`). The child has no console, so each console program it starts
 * (Git Bash, `git`, `node`) is given a window of its own. With Windows Terminal as the default
 * terminal, that window stays open, empty (its output is piped here), titled with the program's path.
 * Started attached and hidden, the child gets a console of its own whose window is not shown, and
 * programs it starts inherit that console instead of opening one. Windows PowerShell is the same: a
 * detached one has no console, runs nothing and exits 0 (seen with Windows PowerShell 5.1 on Windows
 * 11, for `-File` and `-Command` alike). Windows has no process groups; `killTree` ends the child itself.
 */
export function detachedChild(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Starts the child with `start`, follows it to its end, and stops it when asked; `name` is what a missing command is reported as. */
function supervise(
  name: string,
  o: RunOptions,
  start: (options: ChildOptions) => ChildProcess,
  args: readonly string[],
): Promise<SpawnResult> {
  return new Promise((done, reject) => {
    if (o.signal?.aborted) {
      done({
        code: null,
        signal: null,
        stdout: '',
        stdoutBytes: Buffer.alloc(0),
        stdoutTruncated: false,
        stdoutSize: 0,
        stderr: '',
        aborted: true,
        timedOut: false,
      });
      return;
    }
    // spawn() reports a missing cwd as ENOENT too, which would read as "command not found".
    if (o.cwd && !existsSync(o.cwd)) {
      reject(new Error(t().dirNotFound(o.cwd)));
      return;
    }
    const channel = controlChannelOf(o);
    const child = start({
      cwd: o.cwd,
      env: o.env,
      // Own process group on macOS and Linux, which killTree signals. Not on Windows (`detachedChild`):
      // detached there drops the hidden console, and programs the child starts each open a window.
      detached: detachedChild(),
      // On Windows, no window: the child gets a hidden console, which programs it starts inherit.
      windowsHide: true,
      stdio: [
        o.stdin === undefined && !o.keepStdinOpen ? 'ignore' : 'pipe',
        'pipe',
        'pipe',
        ...(channel ? ['pipe' as const] : o.pipes ? ['pipe' as const, 'pipe' as const] : []),
      ],
    });
    live.add(child);
    const recording = recordingOf(name, args, o.cwd);
    if (recording) tap(child, recording);
    if (o.pipes && !channel) {
      const [write, read] = [child.stdio[3] as Duplex | null | undefined, child.stdio[4] as Duplex | null | undefined];
      if (write && read) {
        for (const end of [write, read]) {
          end.on('error', () => {
            /* the process may exit while the server still writes */
          });
        }
        try {
          o.pipes(write, read, child);
        } catch (err) {
          console.error('[process] pipes failed:', err);
        }
      }
    }
    if (channel) {
      const end = child.stdio[3] as Duplex | null | undefined;
      if (end) {
        end.on('error', () => {
          /* the process may exit while the server still writes */
        });
        try {
          channel(end, child);
        } catch (err) {
          console.error('[process] control channel failed:', err);
        }
      }
    }
    if (o.keepStdinOpen) {
      child.stdin!.on('error', () => {
        /* the CLI may exit while we are still writing */
      });
    }

    const stdout = new Capture(o.maxCapture, o.keepStart);
    const stderr = new Capture();
    let aborted = false;
    let timedOut = false;
    let stopRequested = false;

    const stop = () => {
      if (stopRequested) return;
      stopRequested = true;
      killTree(child, 'SIGTERM');
      // Not cleared when the CLI exits: subprocesses that ignore SIGTERM may outlive it. Shutdown
      // (`killAll`) kills these groups too, since this timer does not keep the server alive.
      stopping.add(child);
      setTimeout(() => {
        stopping.delete(child);
        killTree(child, 'SIGKILL');
      }, KILL_GRACE_MS).unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, o.timeoutMs)
      : undefined;

    // Raw bytes: decoding and re-joining lines would corrupt non-UTF-8 bytes and `\r`.
    child.stdout!.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.add(chunk));
    if (o.onLine) {
      const onLine = o.onLine;
      createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
        try {
          onLine(line);
        } catch (err) {
          console.error('[process] line handler failed:', err);
        }
      });
    }

    if (o.stdin !== undefined && !o.keepStdinOpen) {
      child.stdin!.on('error', () => {
        /* the CLI may exit before reading stdin */
      });
      child.stdin!.end(o.stdin);
    }
    o.onSpawn?.(child);

    const cleanup = () => {
      live.delete(child);
      o.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new CommandNotFoundError(name) : err);
    });
    child.on('close', (code, signal) => {
      cleanup();
      try {
        recording?.exit(code, signal);
      } catch {
        /* a recording never stops the run */
      }
      const bytes = stdout.bytes();
      done({
        code,
        signal,
        stdout: bytes.toString('utf8'),
        stdoutBytes: bytes,
        stdoutTruncated: stdout.truncated,
        stdoutSize: stdout.total,
        stderr: stderr.bytes().toString('utf8'),
        aborted,
        timedOut,
      });
    });
  });
}

/** Run a short command and capture its output (for status checks). */
export async function capture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; stdin?: string | Buffer; cwd?: string; maxCapture?: number; keepStart?: boolean } = {},
): Promise<SpawnResult> {
  return runProcess({ ...opts, bin, args, env, timeoutMs: opts.timeoutMs ?? 15000 });
}

/**
 * Runs a CLI that speaks JSON lines on stdin/stdout, for a short exchange: `open` writes the first
 * message, `onMessage` answers and calls `finish` when it has what it needs (which stops the CLI).
 * Resolves on finish, exit, timeout or `signal`.
 */
export async function converse(o: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Stops the CLI from outside, as `finish` does. */
  signal?: AbortSignal;
  open: (write: (msg: unknown) => void) => void;
  onMessage: (msg: Record<string, any>, write: (msg: unknown) => void, finish: () => void) => void;
}): Promise<{ stderr: string; timedOut: boolean }> {
  const stop = linkedAbort(o.signal);
  let write: (msg: unknown) => void = () => undefined;
  const res = await runProcess({
    bin: o.bin,
    args: o.args,
    cwd: o.cwd,
    env: o.env,
    keepStdinOpen: true,
    signal: stop.signal,
    timeoutMs: o.timeoutMs,
    maxCapture: 1024,
    onSpawn: (child) => {
      write = (msg) => {
        if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
      };
      o.open(write);
    },
    onLine: (line) => {
      const text = line.trim();
      if (!text.startsWith('{') || stop.signal.aborted) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(text) as Record<string, any>;
      } catch {
        return;
      }
      o.onMessage(msg, write, () => stop.abort());
    },
  });
  return { stderr: res.stderr, timedOut: res.timedOut };
}

/** An AbortController that also aborts when `outer` does (already aborted: at once). */
function linkedAbort(outer?: AbortSignal): AbortController {
  const stop = new AbortController();
  if (outer?.aborted) stop.abort();
  else outer?.addEventListener('abort', () => stop.abort(), { once: true });
  return stop;
}

/**
 * Reads JSON-RPC messages framed as LSP frames them (`Content-Length: <n>` headers, a blank line,
 * then `n` bytes of body with no newline), from chunks split or joined anywhere. `push` takes a chunk
 * and returns the messages it completed; a frame without a length is skipped, a body that is not a
 * JSON object is dropped.
 */
export class FrameDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Record<string, any>[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Record<string, any>[] = [];
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return out;
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('latin1'))?.[1]);
      if (!Number.isFinite(length)) {
        this.buf = this.buf.subarray(end + 4);
        continue;
      }
      if (this.buf.length < end + 4 + length) return out;
      const body = this.buf.subarray(end + 4, end + 4 + length).toString('utf8');
      this.buf = this.buf.subarray(end + 4 + length);
      try {
        const msg: unknown = JSON.parse(body);
        if (msg && typeof msg === 'object' && !Array.isArray(msg)) out.push(msg as Record<string, any>);
      } catch {
        // not JSON: dropped
      }
    }
  }
}

/** A JSON-RPC message framed as LSP frames it (`FrameDecoder` reads it back). */
export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * `converse()` for a CLI that frames its JSON-RPC messages as LSP does (Copilot's headless server):
 * `open` writes the first message, `onMessage` answers and calls `finish` when it has what it needs.
 * Resolves on finish, exit, timeout or `signal`. A handler that throws is logged, not let out.
 */
export async function converseFramed(o: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  open: (write: (msg: unknown) => void) => void;
  onMessage: (msg: Record<string, any>, write: (msg: unknown) => void, finish: () => void) => void;
}): Promise<{ stderr: string; timedOut: boolean }> {
  const stop = linkedAbort(o.signal);
  const res = await runProcess({
    bin: o.bin,
    args: o.args,
    cwd: o.cwd,
    env: o.env,
    keepStdinOpen: true,
    signal: stop.signal,
    timeoutMs: o.timeoutMs,
    maxCapture: 1024,
    onSpawn: (child) => {
      const write = (msg: unknown) => {
        if (child.stdin?.writable) child.stdin.write(frame(msg));
      };
      const frames = new FrameDecoder();
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const msg of frames.push(chunk)) {
          if (stop.signal.aborted) return;
          try {
            o.onMessage(msg, write, () => stop.abort());
          } catch (err) {
            console.error('[process] message handler failed:', err);
          }
        }
      });
      o.open(write);
    },
  });
  return { stderr: res.stderr, timedOut: res.timedOut };
}

/** Spawn a long-lived interactive process (used for login flows). */
export function spawnInteractive(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const launch = launchOf(bin, args, env);
  const child = spawn(launch.file, launch.args, {
    env: withLaunchEnv(env, launch),
    detached: detachedChild(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.add(child);
  child.on('close', () => live.delete(child));
  child.on('error', () => live.delete(child));
  return child;
}

/**
 * Starts a program that must outlive this process, and is not waited for (the desktop app's update
 * starts the installer, or waits for the app to exit before opening the new one). It is left out of
 * `killAll`, and its own process group keeps it from the signals sent to this one. It stays detached
 * on Windows too, so it is not killed when this process exits; that also means `windowsHide` does not
 * hide a console there (`detachedChild`). `bin` is a full path. Resolves once it started, or rejects
 * when it could not.
 */
export function spawnDetached(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { env, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      done();
    });
  });
}

/**
 * Stop every process this server started (on shutdown): SIGTERM to each process group, then SIGKILL
 * to the groups after a grace period, including subprocesses whose CLI already exited.
 */
export async function killAll(graceMs = KILL_GRACE_MS): Promise<void> {
  const children = [...live];
  for (const child of children) killTree(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  // Including groups stopped earlier whose CLI exited but whose SIGKILL is still pending.
  for (const child of new Set([...children, ...live, ...stopping])) killTree(child, 'SIGKILL');
  stopping.clear();
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
/**
 * A short program the server waits for, such as a probe (`lsof`, `ps`, `chflags`, `node --version`):
 * started directly, never through a shell, and killed (SIGKILL, so one that ignores SIGTERM cannot hold
 * the server) after `timeoutMs`. It cannot outlive the call, so it needs no tracking for shutdown; it
 * blocks every conversation while it runs, so keep it to quick ones and use `runProcess` for the rest.
 */
export function runSync(
  bin: string,
  args: readonly string[],
  o: { timeoutMs: number; input?: string; maxBuffer?: number; quiet?: boolean; env?: NodeJS.ProcessEnv },
): SpawnSyncReturns<string> {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    env: o.env,
    timeout: o.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: o.maxBuffer ?? 1 << 22,
    ...(o.input !== undefined ? { input: o.input } : {}),
    ...(o.quiet ? { stdio: 'ignore' as const } : {}),
    windowsHide: true,
  });
}

/** Waits `ms` without starting a process (between the rounds of a sweep). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function tail(s: string, n = 600): string {
  const t = stripAnsi(s).trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
}
