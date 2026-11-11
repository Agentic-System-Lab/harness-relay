import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * What a run's marker is for, once the run is over (Specula U1/C6 and T1).
 * - U1: the host sweeps what still holds the marker before it exits, but the server may SIGKILL it first
 *   (3 s after SIGTERM). `dispose` then sweeps the marker itself, and keeps the file while anything still
 *   holds it, so the startup sweep (which finds holders by the marker's name) still can. A process in a
 *   session of its own holding a read-only descriptor to the marker stands in for a sandboxed command
 *   that left the host's group. Real processes, no sandbox; macOS only (the sweep uses lsof there).
 * - T1: a run that fails in sandboxCommand after its folders were made leaves no marker behind.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-leftovers-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
const { RelaySandboxRun, clearRelaySandboxLeftovers, makeRunDirs, relaySandboxRoot } = await import('../src/server/relaySandbox');
const { startOpenProcess } = await import('../src/server/agents/open');
const { OPEN_AGENT_HOME_ENV } = await import('../src/server/settings');

const pids: number[] = [];
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
};

/** A process in a session of its own that keeps a read-only descriptor to `marker` (fd 4), like the host's children. */
function holder(marker: string): number {
  const child = spawn('/bin/sh', ['-c', `exec 4<"${marker}"; exec /bin/sleep 60`], { detached: true, stdio: 'ignore' });
  child.unref();
  pids.push(child.pid!);
  return child.pid!;
}

describe.runIf(process.platform === 'darwin')('a marker still held when the run is disposed', () => {
  it('is swept by the server itself, so a host killed before its own sweep leaves nothing running', async () => {
    const dataDir = join(root, 'data');
    // The startup sweep, with nothing disposed (the server died): it finds and kills the holder.
    const kept = makeRunDirs(dataDir);
    const a = holder(kept.marker!);
    await new Promise((r) => setTimeout(r, 300));
    clearRelaySandboxLeftovers(dataDir, 'darwin');
    await until(() => !alive(a));
    expect(alive(a)).toBe(false);
    // The run's host was killed before its sweep; the server then disposes the run as usual.
    const run = makeRunDirs(dataDir);
    const b = holder(run.marker!);
    await new Promise((r) => setTimeout(r, 300));
    await new RelaySandboxRun(run, {}, { localAddresses: [], platform: 'darwin', arch: 'arm64' }).dispose();
    await until(() => !alive(b));
    expect(alive(b)).toBe(false);
    expect(readdirSync(relaySandboxRoot(dataDir)).filter((n) => n.endsWith('.marker'))).toEqual([]);
  }, 60_000);
});

describe('a run that fails in sandboxCommand', () => {
  it('leaves no marker file in data/relay-sandbox', async () => {
    const dataDir = join(root, 'data-t1');
    mkdirSync(dataDir, { recursive: true });
    const cwd = join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const agent = { provider: 'opencode' as const, implemented: true, home: (_r: string, s: string) => ({ env: {}, statePaths: [join(s, 'd')], configPaths: [] }) };
    let error = '';
    try {
      await startOpenProcess(
        agent,
        {
          bin: 'opencode-not-installed',
          env: { PATH: '/usr/bin:/bin', [OPEN_AGENT_HOME_ENV]: join(root, 'home') },
          prompt: 'hi',
          systemPrompt: '',
          cwd,
          permission: 'edit',
          model: 'openai/gpt-5.4-nano',
          signal: new AbortController().signal,
          onEvent: () => undefined,
          backends: { apis: { openai: 'sk-test-0000' }, endpoints: [] },
        },
        () => [],
        {
          platform: 'darwin',
          sandboxAvailable: async () => ({ ok: true }),
          makeRunDirs: () => makeRunDirs(dataDir),
          sandboxCommand: async () => {
            throw new Error('opencode-not-installed: command not found');
          },
        },
      );
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).not.toBe('');
    expect(readdirSync(relaySandboxRoot(dataDir))).toEqual([]);
  });
});
