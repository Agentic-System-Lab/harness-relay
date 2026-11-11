import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_PIDS_PY, answeredPids, deniedPaths, realFolder, aroundPath, runAsync, runSandboxPids, runSandboxPidsAsync, sweepRunSandboxes, sweepRunSandboxesAsync, userPids, type AsyncRunner, type Runner, type SandboxProcsDeps } from '../src/server/sandboxProcs';

const root = mkdtempSync(join(tmpdir(), 'relay-sbprocs-'));
const runTmp = join(root, 'relay-sandbox', '0123456789abcdef');
mkdirSync(runTmp, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PS = ['    1     0', '  101   501', '  102   501', '  103     0', '  104   501', ' 4242   501', 'junk line', ''].join('\n');

/** A fake system: `ps` lists PS, the Python helper answers with `inSandbox` (those it was given). */
function deps(over: Partial<SandboxProcsDeps> = {}, inSandbox: number[] = [102], calls: { cmd: string; args: string[]; input?: string }[] = []): SandboxProcsDeps {
  const run: Runner = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (cmd === '/bin/ps') return { status: 0, stdout: PS, error: undefined };
    const given = (input ?? '').split('\n').filter(Boolean).map(Number);
    return { status: 0, stdout: inSandbox.filter((p) => given.includes(p)).join('\n') + '\n', error: undefined };
  };
  return { platform: 'darwin', uid: 501, exclude: [4242], run, pythonReady: () => true, ...over };
}

describe('finding a run’s processes by their sandbox (macOS)', () => {
  it('lists this user’s processes, never pid 1 or the excluded ones', () => {
    expect(userPids(PS, 501, [4242])).toEqual([101, 102, 104]);
    expect(userPids(PS, 0, [])).toEqual([103]);
    expect(userPids('', 501, [])).toEqual([]);
  });

  it('asks the kernel through Python about the run’s folder against the folder around it', () => {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    expect(runSandboxPids(runTmp, deps({}, [102], calls))).toEqual([102]);
    const py = calls.find((c) => c.cmd === '/usr/bin/python3')!;
    expect(py.args).toEqual(['-I', '-c', SANDBOX_PIDS_PY, runTmp, join(root, 'relay-sandbox')]);
    // With the run's marker beside its folder, a process must not be able to write that either.
    writeFileSync(`${runTmp}.marker`, '');
    expect(deniedPaths(runTmp)).toEqual([join(root, 'relay-sandbox'), `${runTmp}.marker`]);
    rmSync(`${runTmp}.marker`);
    expect(py.input).toBe('101\n102\n104\n');
    expect(aroundPath(runTmp)).toBe(join(root, 'relay-sandbox'));
  });

  it('keeps only pids it asked about (a stray line in the answer is ignored)', () => {
    const run: Runner = (cmd) => (cmd === '/bin/ps' ? { status: 0, stdout: PS, error: undefined } : { status: 0, stdout: '102\n999\nnot-a-pid\n1\n', error: undefined });
    expect(runSandboxPids(runTmp, deps({ run }))).toEqual([102]);
  });

  it('cannot tell (undefined) off macOS, without the system Python, or when ps or Python fails', () => {
    expect(runSandboxPids(runTmp, deps({ platform: 'linux' }))).toBeUndefined();
    expect(runSandboxPids(runTmp, deps({ pythonReady: () => false }))).toBeUndefined();
    expect(runSandboxPids(runTmp, deps({ uid: -1 }))).toBeUndefined();
    const psFails: Runner = (cmd) => (cmd === '/bin/ps' ? { status: 1, stdout: '', error: undefined } : { status: 0, stdout: '', error: undefined });
    expect(runSandboxPids(runTmp, deps({ run: psFails }))).toBeUndefined();
    const pyFails: Runner = (cmd) => (cmd === '/bin/ps' ? { status: 0, stdout: PS, error: undefined } : { status: 1, stdout: '', error: new Error('no python') });
    expect(runSandboxPids(runTmp, deps({ run: pyFails }))).toBeUndefined();
  });

  it('makes the run’s folder real again before asking (a run may remove it or put a link in its place)', () => {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const gone = join(root, 'relay-sandbox', 'feedfacefeedface');
    expect(runSandboxPids(gone, deps({}, [102], calls))).toEqual([102]);
    expect(lstatSync(gone).isDirectory()).toBe(true);
    // A link in its place is removed (never followed) and the folder made again.
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    const linked = join(root, 'relay-sandbox', 'cafebabecafebabe');
    symlinkSync(target, linked);
    expect(realFolder(linked)).toBe(true);
    expect(lstatSync(linked).isDirectory() && !lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    // Where it cannot be made (no parent folder), the sweep cannot tell.
    expect(runSandboxPids(join(root, 'no-such-parent', 'x'), deps())).toBeUndefined();
  });

  it('kills what it finds, round after round, until none is left', () => {
    let alive = [102, 104];
    const run: Runner = (cmd, _args, input) =>
      cmd === '/bin/ps'
        ? { status: 0, stdout: PS, error: undefined }
        : { status: 0, stdout: alive.filter((p) => (input ?? '').split('\n').map(Number).includes(p)).join('\n'), error: undefined };
    const killed: number[] = [];
    // 104 forks a new 101 while it is killed: the next round finds and kills that too.
    const kill = (pid: number) => {
      killed.push(pid);
      alive = alive.filter((p) => p !== pid);
      if (pid === 104 && !killed.includes(101)) alive.push(101);
    };
    expect(sweepRunSandboxes([runTmp], deps({ run }), kill)).toBe(true);
    expect(killed.sort()).toEqual([101, 102, 104]);
    expect(alive).toEqual([]);
  });

  it('reports a process it could not kill, and is a no-op where it cannot tell', () => {
    const run: Runner = (cmd) => (cmd === '/bin/ps' ? { status: 0, stdout: PS, error: undefined } : { status: 0, stdout: '102\n', error: undefined });
    const killed: number[] = [];
    expect(sweepRunSandboxes([runTmp], deps({ run }), (pid) => void killed.push(pid))).toBe(false);
    expect(killed.length).toBe(5); // five rounds of kills, then the sixth look gives up
    expect(sweepRunSandboxes([runTmp], deps({ platform: 'linux' }), () => expect.unreachable())).toBe(true);
    // Without the system's Python: nothing to sweep with. A run's teardown has the marker sweep left;
    // the server's start cannot tell its leftover folders free, so they count as held.
    expect(sweepRunSandboxes([runTmp], deps({ pythonReady: () => false }), () => expect.unreachable())).toBe(true);
    expect(sweepRunSandboxes([runTmp], deps({ pythonReady: () => false }), () => expect.unreachable(), false)).toBe(false);
    expect(sweepRunSandboxes([], deps({ pythonReady: () => false }), () => expect.unreachable(), false)).toBe(true);
    // Available here, but ps (or Python) failed: it could not tell, so it counts as held.
    const psFails: Runner = (cmd) => (cmd === '/bin/ps' ? { status: 1, stdout: '', error: undefined } : { status: 0, stdout: '', error: undefined });
    expect(sweepRunSandboxes([runTmp], deps({ run: psFails }), () => expect.unreachable())).toBe(false);
    expect(sweepRunSandboxes([], deps(), () => expect.unreachable())).toBe(true);
  });

  it('passes the path as the ninth argument on Apple silicon (variadic arguments go on the stack)', () => {
    expect(SANDBOX_PIDS_PY).toContain("ctypes.CFUNCTYPE(I, I, S, I, I, I, I, I, I, S)(('sandbox_check', lib))");
    expect(SANDBOX_PIDS_PY).toContain("by_path(pid, b'file-write-data', FLAGS, 0, 0, 0, 0, 0, p)");
    expect(SANDBOX_PIDS_PY).toContain('FLAGS = 1 | 0x40000000');
    expect(SANDBOX_PIDS_PY).toContain('may_write(pid, allow) == 0 and all(may_write(pid, d) == 1 for d in denies)');
  });
});

describe('the same sweep without blocking the server (a run’s teardown)', () => {
  const asyncOf = (run: Runner): AsyncRunner => async (cmd, args, input) => run(cmd, args, input);

  it('gives the same answers as the blocking one', async () => {
    const d = deps();
    expect(await runSandboxPidsAsync(runTmp, d, asyncOf(d.run))).toEqual([102]);
    expect(await runSandboxPidsAsync(runTmp, deps({ platform: 'linux' }), asyncOf(d.run))).toBeUndefined();
    expect(await runSandboxPidsAsync(join(root, 'no-such-parent', 'gone'), d, asyncOf(d.run))).toBeUndefined();
    expect(answeredPids('102\n7\nx\n', [102, 104])).toEqual([102]);
  });

  it('kills in rounds until none is left, and reports one it could not kill', async () => {
    let alive = [102, 104];
    const run: AsyncRunner = async (cmd, _a, input) =>
      cmd === '/bin/ps' ? { status: 0, stdout: PS, error: undefined } : { status: 0, stdout: alive.filter((p) => (input ?? '').split('\n').map(Number).includes(p)).join('\n'), error: undefined };
    const killed: number[] = [];
    expect(await sweepRunSandboxesAsync([runTmp], deps(), (pid) => (killed.push(pid), (alive = alive.filter((p) => p !== pid))), run)).toBe(true);
    expect(killed.sort()).toEqual([102, 104]);
    const stuck: AsyncRunner = async (cmd) => (cmd === '/bin/ps' ? { status: 0, stdout: PS, error: undefined } : { status: 0, stdout: '102\n', error: undefined });
    expect(await sweepRunSandboxesAsync([runTmp], deps(), () => undefined, stuck)).toBe(false);
  });

  it('runs a program with input and returns its output (or its failure)', async () => {
    expect(await runAsync('/bin/cat', [], 'hello\n')).toMatchObject({ status: 0, stdout: 'hello\n' });
    const missing = await runAsync('/no/such/program', []);
    expect(missing.error).toBeDefined();
  });
});
