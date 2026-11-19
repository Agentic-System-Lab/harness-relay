import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What each start actually passes to `spawn`. `detachedChild()` is only the flag; these tests flip
 * `process.platform` and stand in for `spawn`, so a Windows child that is still started detached
 * (which drops `CREATE_NO_WINDOW`) fails here, on any system.
 */
const recorded = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const { PassThrough } = require('node:stream') as typeof import('node:stream');
  type Call = { file: string; args: readonly string[]; options: import('node:child_process').SpawnOptions };
  const calls: Call[] = [];

  function child(): import('node:child_process').ChildProcess {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      stdio: [stdin, stdout, stderr, null, null],
      // No pid: nothing here may signal a real process group.
      kill: () => true,
      unref() {
        return this;
      },
    }) as unknown as import('node:child_process').ChildProcess;
    // After the caller has attached its listeners (this same turn), then finish.
    queueMicrotask(() => {
      proc.emit('spawn');
      proc.emit('close', 0, null);
    });
    return proc;
  }

  return {
    calls,
    spawn(file: string, args: readonly string[] = [], options: import('node:child_process').SpawnOptions = {}) {
      calls.push({ file, args, options });
      return child();
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn: (file: string, args?: readonly string[], options?: import('node:child_process').SpawnOptions) =>
    recorded.spawn(file, args, options),
  spawnSync: () => {
    throw new Error('spawnSync is not used here');
  },
}));

import { runProcess, runShellScript, spawnDetached, spawnInteractive } from '../src/server/process';

const dir = mkdtempSync(join(tmpdir(), 'relay-console-'));
const exe = join(dir, 'helper.exe');
writeFileSync(exe, '');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  recorded.calls.length = 0;
});

/** The one spawn this call made. Its stdio is not inherited, or Windows ignores `CREATE_NO_WINDOW`. */
function take(): (typeof recorded.calls)[number] {
  expect(recorded.calls).toHaveLength(1);
  const call = recorded.calls[0]!;
  const slots = Array.isArray(call.options.stdio) ? call.options.stdio : [call.options.stdio];
  expect(slots).not.toContain('inherit');
  expect(call.options.shell).toBeUndefined();
  return call;
}

describe('Windows children get a hidden console', () => {
  it('starts a run attached and hidden, with piped output', async () => {
    setPlatform('win32');
    const res = await runProcess({ bin: exe, args: ['--check'], env: { PATH: '', PATHEXT: '.EXE' } });
    expect(res.code).toBe(0);
    const call = take();
    expect(call.file).toBe(exe);
    expect(call.args).toEqual(['--check']);
    expect(call.options.detached).toBe(false);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('starts a fixed shell script the same way', async () => {
    setPlatform('win32');
    const shell = 'C:\\Program Files\\Git\\bin\\bash.exe';
    await runShellScript(shell, ['--noprofile'], 'echo hi', { env: {} });
    const call = take();
    expect(call.file).toBe(shell);
    expect(call.args).toEqual(['--noprofile', '-c', 'echo hi']);
    expect(call.options.detached).toBe(false);
    expect(call.options.windowsHide).toBe(true);
  });

  it('starts a login flow attached and hidden', async () => {
    setPlatform('win32');
    spawnInteractive(exe, ['login'], { PATH: '', PATHEXT: '.EXE' });
    const call = take();
    expect(call.file).toBe(exe);
    expect(call.args).toEqual(['login']);
    expect(call.options.detached).toBe(false);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('leaves the desktop updater detached, so it outlives the server', async () => {
    setPlatform('win32');
    await spawnDetached(exe, ['--install'], {});
    const call = take();
    expect(call.file).toBe(exe);
    expect(call.args).toEqual(['--install']);
    expect(call.options.detached).toBe(true);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.stdio).toBe('ignore');
  });
});

describe('macOS and Linux children stay in their own process group', () => {
  it('detaches a run, a shell script and a login flow, and the updater too', async () => {
    setPlatform('linux');
    await runProcess({ bin: process.execPath, args: ['-e', ''], env: process.env });
    await runShellScript('/bin/sh', [], 'true', { env: process.env });
    spawnInteractive(process.execPath, ['-e', ''], process.env);
    await spawnDetached(process.execPath, [], process.env);
    expect(recorded.calls).toHaveLength(4);
    for (const call of recorded.calls) {
      expect(call.options.detached).toBe(true);
      expect(call.options.windowsHide).toBe(true);
      const slots = Array.isArray(call.options.stdio) ? call.options.stdio : [call.options.stdio];
      expect(slots).not.toContain('inherit');
    }
    await new Promise((resolve) => setImmediate(resolve));
  });
});
