import type { SpawnSyncReturns } from 'node:child_process';
import { runProcess, runSync, sleepSync } from './process';
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * Finding the processes of one relay-sandbox run on macOS by their sandbox, not by what they inherited.
 *
 * A command an agent backgrounds can leave the host's process group (a double fork re-parents it to
 * launchd, `setsid` gives it a session of its own), and the CLIs close every descriptor but the
 * standard ones when they spawn a command (Node, Bun and Python do), so the run's marker descriptor
 * does not reach it either. What every descendant does keep, and cannot drop, is its Seatbelt profile.
 * The kernel answers, for any process of this user, whether its profile lets it write a given path
 * (libsandbox's `sandbox_check`). Only the run's own profile lets a process write the run's own
 * temporary folder; and a process that may also write the folder around it has a wider sandbox than any
 * run's (another tool's sandbox whose working directory holds Harness Relay's data, say), so it is
 * left alone. This reads no environment and no terminal: only the kernel's answer about the policy.
 *
 * `sandbox_check` is a C function with variadic arguments, which Node cannot call; the small Python
 * program below calls it through ctypes. On Apple silicon a variadic argument goes on the stack, after
 * the eight register arguments, so the path is passed as a ninth argument behind five padding ones.
 * The system's Python (`/usr/bin/python3`) comes with the Xcode command line tools; without them this
 * sweep is not available and the marker sweep is all there is (`runSandboxPids` returns undefined).
 */

/** The Python program: pids on stdin, one per line; prints those sandboxed that may write argv[1] and none of argv[2:]. */
export const SANDBOX_PIDS_PY = String.raw`
import ctypes, platform, sys
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
I, S = ctypes.c_int, ctypes.c_char_p
FLAGS = 1 | 0x40000000  # SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT
sandboxed = ctypes.CFUNCTYPE(I, I, S, I)(('sandbox_check', lib))
if platform.machine() == 'arm64':
    by_path = ctypes.CFUNCTYPE(I, I, S, I, I, I, I, I, I, S)(('sandbox_check', lib))
    may_write = lambda pid, p: by_path(pid, b'file-write-data', FLAGS, 0, 0, 0, 0, 0, p)
else:
    by_path = ctypes.CFUNCTYPE(I, I, S, I, S)(('sandbox_check', lib))
    may_write = lambda pid, p: by_path(pid, b'file-write-data', FLAGS, p)
allow, denies = sys.argv[1].encode(), [d.encode() for d in sys.argv[2:]]
for line in sys.stdin:
    line = line.strip()
    if not line.isdigit():
        continue
    pid = int(line)
    if sandboxed(pid, None, 0) == 1 and may_write(pid, allow) == 0 and all(may_write(pid, d) == 1 for d in denies):
        print(pid)
`;

export type Runner = (cmd: string, args: string[], input?: string) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'error'>;

export interface SandboxProcsDeps {
  platform: NodeJS.Platform;
  uid: number;
  /** Pids never to report (this server, the host). */
  exclude: number[];
  run: Runner;
  /** Whether the system's Python can be run without prompting to install the command line tools. */
  pythonReady: () => boolean;
}

const run: Runner = (cmd, args, input) => runSync(cmd, args, { timeoutMs: 15_000, input });

let pythonChecked: boolean | undefined;
/** `/usr/bin/python3` is a stub that offers to install the command line tools unless they are there. */
function systemPythonReady(): boolean {
  if (pythonChecked !== undefined) return pythonChecked;
  const tools = runSync('/usr/bin/xcode-select', ['-p'], { timeoutMs: 5000 });
  const dir = tools.status === 0 ? tools.stdout.trim() : '';
  pythonChecked = Boolean(dir) && existsSync('/usr/bin/python3') && (existsSync(join(dir, 'usr/bin/python3')) || existsSync(join(dir, 'Library/Frameworks/Python3.framework')));
  return pythonChecked;
}

export const defaultSandboxProcsDeps = (): SandboxProcsDeps => ({
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  exclude: [process.pid],
  run,
  pythonReady: systemPythonReady,
});

/** This user's pids from `ps -A -o pid= -o uid=`, minus pid 1 and the excluded ones. Pure. */
export function userPids(psOut: string, uid: number, exclude: readonly number[]): number[] {
  const out: number[] = [];
  for (const line of psOut.split('\n')) {
    const [pid, owner] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && pid! > 1 && owner === uid && !exclude.includes(pid!)) out.push(pid!);
  }
  return out;
}

/**
 * The folder around a run's temp folder (relay-sandbox/), which no run's profile may write: the
 * discriminator. Both must exist: the kernel answers "denied" for a path that does not.
 */
export function aroundPath(runTmp: string): string {
  return dirname(runTmp);
}

/**
 * Makes `runTmp` a real folder again before the kernel is asked about it: the kernel answers by path
 * ("denied" for a path that is not there, and through a link), and a run's profile lets the run remove
 * its own temp folder or put a link in its place. So a process that did that to hide is still found.
 * False when it cannot be done (the sweep then cannot tell).
 */
export function realFolder(runTmp: string): boolean {
  try {
    if (lstatSync(runTmp).isDirectory()) return true;
    unlinkSync(runTmp); // a link or a file in its place
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    mkdirSync(runTmp, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/** Whether the sweep by sandbox can run here at all (macOS, this user, the system's Python). */
function sweepAvailable(deps: SandboxProcsDeps): boolean {
  return deps.platform === 'darwin' && deps.uid >= 0 && deps.pythonReady();
}

/**
 * The pids of this user's processes inside the relay sandbox of the run whose temp folder is
 * `runTmp`: sandboxed, allowed to write `runTmp`, not allowed to write the folder around it. Undefined when that
 * cannot be told here (not macOS, no system Python); an empty list when there are none.
 */
export function runSandboxPids(runTmp: string, deps: SandboxProcsDeps = defaultSandboxProcsDeps()): number[] | undefined {
  if (deps.platform !== 'darwin' || deps.uid < 0 || !deps.pythonReady()) return undefined;
  if (!realFolder(runTmp)) return undefined;
  const ps = deps.run('/bin/ps', ['-A', '-o', 'pid=', '-o', 'uid=']);
  if (ps.error || ps.status !== 0) return undefined;
  const pids = userPids(ps.stdout ?? '', deps.uid, deps.exclude);
  if (!pids.length) return [];
  const py = deps.run('/usr/bin/python3', pythonArgs(runTmp), pids.join('\n') + '\n');
  if (py.error || py.status !== 0) return undefined;
  return answeredPids(py.stdout ?? '', pids);
}

/**
 * What a process of the run may not write: the folder around its temp folder, and its marker file
 * beside it (which no run's profile lets write). A process that may write either has a wider or an
 * odd sandbox, not the run's, and is left alone. Both must exist to discriminate (the kernel answers
 * "denied" for a path that does not); a missing marker only drops that second test.
 */
export function deniedPaths(runTmp: string): string[] {
  const marker = `${runTmp}.marker`;
  return [aroundPath(runTmp), ...(existsSync(marker) ? [marker] : [])];
}

const pythonArgs = (runTmp: string) => ['-I', '-c', SANDBOX_PIDS_PY, runTmp, ...deniedPaths(runTmp)];

/** The pids in the helper's answer that it was asked about (a stray line is ignored). Pure. */
export function answeredPids(stdout: string, asked: readonly number[]): number[] {
  return stdout
    .split('\n')
    .map((n) => Number(n.trim()))
    .filter((pid) => Number.isInteger(pid) && asked.includes(pid));
}

/** `Runner`, without blocking the server: for a run's teardown while other runs go on. */
export type AsyncRunner = (cmd: string, args: string[], input?: string) => Promise<Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'error'>>;

export const runAsync: AsyncRunner = async (cmd, args, input) => {
  // Through process.ts, like every child process of the server: tracked, and killed on shutdown.
  try {
    const r = await runProcess({
      bin: cmd,
      args,
      cwd: '/',
      env: process.env,
      timeoutMs: 15_000,
      maxCapture: 1 << 22,
      stdin: input ?? '',
    });
    return r.timedOut ? { status: null, stdout: r.stdout, error: new Error(`${cmd} timed out`) } : { status: r.code, stdout: r.stdout, error: undefined };
  } catch (error) {
    return { status: null, stdout: '', error: error as Error };
  }
};

/** `runSandboxPids`, without blocking the server. */
export async function runSandboxPidsAsync(runTmp: string, deps: SandboxProcsDeps = defaultSandboxProcsDeps(), run: AsyncRunner = runAsync): Promise<number[] | undefined> {
  if (deps.platform !== 'darwin' || deps.uid < 0 || !deps.pythonReady()) return undefined;
  if (!realFolder(runTmp)) return undefined;
  const ps = await run('/bin/ps', ['-A', '-o', 'pid=', '-o', 'uid=']);
  if (ps.error || ps.status !== 0) return undefined;
  const pids = userPids(ps.stdout ?? '', deps.uid, deps.exclude);
  if (!pids.length) return [];
  const py = await run('/usr/bin/python3', pythonArgs(runTmp), pids.join('\n') + '\n');
  if (py.error || py.status !== 0) return undefined;
  return answeredPids(py.stdout ?? '', pids);
}

/** `sweepRunSandboxes`, without blocking the server (a run's teardown). */
export async function sweepRunSandboxesAsync(
  runTmps: readonly string[],
  deps: SandboxProcsDeps = defaultSandboxProcsDeps(),
  kill: (pid: number) => void = killPid,
  run: AsyncRunner = runAsync,
): Promise<boolean> {
  if (!runTmps.length || !sweepAvailable(deps)) return true; // not here: the marker sweep is all there is
  for (let round = 0; round < 6; round++) {
    let found: number[] = [];
    for (const tmp of runTmps) {
      const pids = await runSandboxPidsAsync(tmp, deps, run);
      if (pids === undefined) return false; // could not tell (ps, Python or the folder failed): held
      found = [...found, ...pids];
    }
    if (!found.length) return true;
    if (round === 5) return false;
    for (const pid of new Set(found)) kill(pid);
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Kills, in a few rounds (a process may fork while it is being killed), every process inside the
 * relay sandbox of these runs. True once none is left, or when this sweep is not available here (the
 * marker sweep is then all there is); false when one still was after the last round, or the sweep failed.
 */
export function sweepRunSandboxes(runTmps: readonly string[], deps: SandboxProcsDeps = defaultSandboxProcsDeps(), kill: (pid: number) => void = killPid): boolean {
  if (!runTmps.length || !sweepAvailable(deps)) return true; // not here: the marker sweep is all there is
  for (let round = 0; round < 6; round++) {
    let found: number[] = [];
    for (const tmp of runTmps) {
      const pids = runSandboxPids(tmp, deps);
      if (pids === undefined) return false; // could not tell (ps, Python or the folder failed): held
      found = [...found, ...pids];
    }
    if (!found.length) return true;
    if (round === 5) return false;
    for (const pid of new Set(found)) kill(pid);
    sleepSync(100);
  }
  return false;
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}
