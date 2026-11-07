import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface SpawnOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. When omitted stdin is /dev/null. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called for every stdout line (without the trailing newline). */
  onLine?: (line: string) => void;
  /** Max bytes of stdout / stderr kept in the result (oldest output is dropped first). */
  maxCapture?: number;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

const MAX_CAPTURE = 64 * 1024;
const live = new Set<ChildProcess>();

function appendCapped(buf: string, chunk: string, max = MAX_CAPTURE): string {
  const next = buf + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Kill the whole process group so tool subprocesses (shells, test runners…) die too. */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

export class CommandNotFoundError extends Error {
  constructor(public bin: string) {
    super(`找不到指令「${bin}」。請確認已安裝，或在「設定」頁指定執行檔路徑。`);
  }
}

/** Spawn a CLI, stream its stdout line by line, and resolve when it exits. */
export function runProcess(o: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', aborted: true, timedOut: false });
      return;
    }
    const child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: [o.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    live.add(child);

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 3000);
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

    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      stdout = appendCapped(stdout, line + '\n', o.maxCapture);
      try {
        o.onLine?.(line);
      } catch (err) {
        console.error('[process] line handler failed:', err);
      }
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    if (o.stdin !== undefined) {
      child.stdin!.on('error', () => {
        /* the CLI may exit before reading stdin */
      });
      child.stdin!.end(o.stdin);
    }

    const cleanup = () => {
      live.delete(child);
      o.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new CommandNotFoundError(o.bin) : err);
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ code, signal, stdout, stderr, aborted, timedOut });
    });
  });
}

/** Run a short command and capture its output (for status checks). */
export async function capture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; stdin?: string; cwd?: string; maxCapture?: number } = {},
): Promise<SpawnResult> {
  return runProcess({ bin, args, env, timeoutMs: opts.timeoutMs ?? 15000, stdin: opts.stdin, cwd: opts.cwd, maxCapture: opts.maxCapture });
}

/** Spawn a long-lived interactive process (used for login flows). */
export function spawnInteractive(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(bin, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(child);
  child.on('close', () => live.delete(child));
  child.on('error', () => live.delete(child));
  return child;
}

export function killAll(): void {
  for (const child of live) killTree(child, 'SIGTERM');
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function tail(s: string, n = 600): string {
  const t = stripAnsi(s).trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
}
