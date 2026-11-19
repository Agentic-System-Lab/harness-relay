import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { calls, conversation, defaultCheckCommandDeps, fake, finish, orchestrator, project, root } from './orchestrator-harness';

const completed = {
  code: 0,
  signal: null,
  stdout: '',
  stdoutBytes: Buffer.alloc(0),
  stdoutSize: 0,
  stdoutTruncated: false,
  stderr: '',
  aborted: false,
  timedOut: false,
};

const call = { kind: 'command', tool: 'Bash', command: 'pwd' } as const;
const hook = { id: 'h', when: 'before', tools: 'command', run: 'pwd' } as const;

it.skipIf(process.platform === 'win32').each(['separate', 'nested'])(
  'runs an absolute hook folder in the worktree of its %s repository',
  async (kind) => {
    const extra = mkdtempSync(join(kind === 'nested' ? project : root, 'hooks-extra-'));
    const subdir = join(extra, 'tools');
    mkdirSync(subdir);
    writeFileSync(join(subdir, 'data.txt'), 'test\n');
    if (kind === 'nested') {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: extra });
      git('init', '-q');
      git('add', 'tools');
      git('commit', '-qm', 'Add test data');
    }
    const conv = conversation({ mode: 'parallel', permission: 'full', extraCwds: [extra], checks: { hooks: [{ ...hook, cwd: subdir }] } });
    conv.agents = conv.agents.slice(0, 1);
    const runShellScript = vi.fn<typeof defaultCheckCommandDeps.runShellScript>().mockResolvedValue(completed);
    orchestrator.checkCommandDeps = { ...defaultCheckCommandDeps, runShellScript };
    fake.inTurn = async (_name, options) => {
      await options.hooks?.before(call);
    };

    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    const agentDirectory = calls.find((c) => c.name === 'Alice')!.addDirs![0]!;
    expect(agentDirectory).not.toBe(extra);
    expect(runShellScript).toHaveBeenCalledExactlyOnceWith(
      '/bin/sh',
      [],
      expect.any(String),
      expect.objectContaining({
        cwd: join(agentDirectory, 'tools'),
      }),
    );
  },
);

it.skipIf(process.platform === 'win32')('cancels and waits for the active hook when its CLI ends early', async () => {
  let markEntered!: () => void;
  let finishCleanup!: () => void;
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  const cleaned = new Promise<void>((resolve) => (finishCleanup = resolve));
  let signal: AbortSignal | undefined;
  const conv = conversation({ mode: 'roundtable', permission: 'full', checks: { hooks: [hook] } });
  orchestrator.checkCommandDeps = {
    ...defaultCheckCommandDeps,
    async runShellScript(_bin, _args, _script, options) {
      signal = options.signal;
      markEntered();
      await cleaned;
      return { ...completed, aborted: Boolean(signal?.aborted) };
    },
  };
  fake.inTurn = async (name, options) => {
    if (name === 'Alice') {
      void options.hooks!.before(call);
      await entered;
    }
  };

  await orchestrator.send(conv.id, 'go');
  try {
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(calls.some((c) => c.name === 'Bob')).toBe(false);
  } finally {
    finishCleanup();
    await finish(conv.id);
  }
  expect(calls.some((c) => c.name === 'Bob')).toBe(true);
});
