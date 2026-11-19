import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasChecks, hasRules, hookApplies, hookFilePatterns, protectedPatterns } from '../src/shared/checks';
import type { CheckHook } from '../src/shared/types';
import type { CheckCommandDeps } from '../src/server/checkCommands';
import { ToolGateway, type HookHandler } from '../src/server/gateway';
import { HOOK_SHIM_MAX } from '../src/server/hookShim';
import {
  HOOK_CALL_MAX,
  HOOK_INPUT_LIMITS,
  HOOK_NOTICES,
  callLabel,
  callTooLong,
  commandHookHandler,
  hookEnv,
  hookInput,
  shellWords,
  turnHooks,
  type TurnHooks,
} from '../src/server/hooks';
import { withLang } from '../src/server/i18n';
import { runProcess, runShellScript } from '../src/server/process';
import { removeTree } from '../src/server/fsRemove';
import { slow } from './timeouts';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-hooks-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (o: Partial<CheckCommandDeps> = {}): CheckCommandDeps => ({
  platform: process.platform,
  sandboxCommand: vi.fn(),
  runProcess,
  runShellScript,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, SECRET_TOKEN: 'shh' },
  sandboxAvailable: async () => ({ ok: true }),
  makeRunDirs: () => {
    const tmp = join(dir, 'run', 'tmp');
    mkdirSync(tmp, { recursive: true });
    return { tmp, hostTmp: join(dir, 'run', 'host') };
  },
  ...o,
});

const hook = (o: Partial<CheckHook> & Pick<CheckHook, 'run'>): CheckHook => ({
  id: o.run.slice(0, 8),
  when: 'before',
  tools: 'command',
  ...o,
});

/** A turn's hooks, run without a sandbox in the test's folder, with the notes they add. */
function hooksOf(list: CheckHook[], d: CheckCommandDeps = deps()): { hooks: TurnHooks; notes: string[] } {
  const notes: string[] = [];
  const hooks = turnHooks(list, {
    place: { cwds: [dir], unsandboxed: true, protectedPaths: [], privateRoots: [] },
    agent: 'Builder',
    provider: 'claude',
    notice: (t) => notes.push(t),
    deps: d,
  })!;
  return { hooks, notes };
}

describe('a list with hooks', () => {
  it('has rules with a hook alone, but nothing to check once the team has answered', () => {
    const list = { hooks: [hook({ run: 'true' })] };
    expect(hasRules(list)).toBe(true);
    expect(hasChecks(list)).toBe(false);
    expect(hasRules({})).toBe(false);
  });

  it("protects the scripts a hook's command runs from the working directory, which a member could otherwise change to switch it off", () => {
    const of = (run: string, cwd?: string) => hookFilePatterns([hook({ run, ...(cwd ? { cwd } : {}) })]);
    // The program of a command named by a path, and the script an interpreter is given, from the hook's folder.
    expect(of('./scripts/allow.sh "$RELAY_HOOK_COMMAND"')).toEqual(['/scripts/allow.sh']);
    expect(of('node tools/check.js --config=ci/rules.json && python3 lint.py', 'web')).toEqual(['/web/tools/check.js', '/web/lint.py']);
    expect(of("sh './my scripts/allow.sh'")).toEqual(['/my scripts/allow.sh']);
    expect(of('FOO=1 env BAR=2 bash -eu ci/a.sh src/')).toEqual(['/ci/a.sh']);
    expect(of('test -f a/b || ./bin/fail; cat list.txt | ./filter.py > out/log.txt')).toEqual(['/bin/fail', '/filter.py']);
    expect(of('bun run tools/x.ts')).toEqual(['/tools/x.ts']);
    expect(of('../shared/x.sh', 'web')).toEqual(['/shared/x.sh']);
    // Never a command's other arguments: a folder to lint or a pattern would protect what the team works on.
    expect(of('npx eslint src/ --max-warnings 0')).toEqual([]);
    expect(of('grep -v "^docs/"')).toEqual([]);
    expect(of('npx prettier --check $RELAY_HOOK_FILES')).toEqual([]);
    expect(of('echo "lint: $(basename $RELAY_HOOK_FILES)"; exit 1')).toEqual([]);
    // Nor an interpreter's subcommand, an option's value, or the folder or files a test runner is given.
    expect(of('bun test; deno test; deno lint; bun run lint; node --test test/; node --test test/a.test.js')).toEqual([]);
    expect(of('tsx --tsconfig tsconfig.json scripts/c.ts; python3 -m pytest tests/; ./tools/ x')).toEqual([]);
    // A cd before it is followed; after one that cannot be, nothing is told.
    expect(of('cd tools && ./check.sh; sh ../ci/a.sh')).toEqual(['/tools/check.sh', '/ci/a.sh']);
    expect(of('cd "$DIR" && ./check.sh')).toEqual([]);
    expect(of('cd && ./check.sh')).toEqual([]);
    expect(of('cd ../.. && ./check.sh')).toEqual([]);
    // Nor a program on the PATH, a full path, one that leaves the folder, one only the shell knows, or a program given as text.
    expect(of('npm run allow; /usr/bin/true; ~/x.sh; ../up.sh; sh "$PWD/scripts/allow.sh"; sh -c "scripts/x.sh"; node -e "a/b"')).toEqual(
      [],
    );
    expect(of('./x.sh', '/abs/folder')).toEqual([]);
    const list = {
      protectedPaths: ['.env', '/scripts/allow.sh'],
      hooks: [hook({ run: './scripts/allow.sh' }), hook({ run: 'sh ci/a.sh' })],
    };
    expect(protectedPatterns(list)).toEqual(['.env', '/scripts/allow.sh', '/ci/a.sh']);
    // With such a file, a list of hooks alone has something to check once the team has answered.
    expect(hasChecks({ hooks: [hook({ run: './scripts/allow.sh' })] })).toBe(true);
    expect(hasChecks({ hooks: [hook({ run: 'npm test' })] })).toBe(false);
  });

  it("runs a hook around the calls of its kind: commands, its CLI's own file changes, or every call", () => {
    expect(hookApplies({ tools: 'command' }, 'command')).toBe(true);
    expect(hookApplies({ tools: 'command' }, 'edit')).toBe(false);
    expect(hookApplies({ tools: 'edit' }, 'edit')).toBe(true);
    expect(hookApplies({ tools: 'any' }, 'other')).toBe(true);
    expect(hookApplies({ tools: 'edit' }, 'other')).toBe(false);
  });
});

describe('what a hook is given', () => {
  it('gets the call in its environment, never in its command line: kind, tool, command, files, input, member and CLI', () => {
    const env = hookEnv(
      'before',
      { kind: 'edit', tool: 'Write', files: ['/w/a.ts', '/w/b.ts'], input: { file_path: '/w/a.ts' } },
      'Builder',
      'claude',
    );
    expect(env).toEqual({
      RELAY_HOOK_WHEN: 'before',
      RELAY_HOOK_KIND: 'edit',
      RELAY_HOOK_TOOL: 'Write',
      RELAY_HOOK_COMMAND: '',
      RELAY_HOOK_FILES: '/w/a.ts\n/w/b.ts',
      RELAY_HOOK_INPUT: '{"file_path":"/w/a.ts"}',
      RELAY_HOOK_AGENT: 'Builder',
      RELAY_HOOK_CLI: 'claude',
    });
    const after = hookEnv('after', { kind: 'command', tool: 'Bash', command: 'npm test', output: 'ok', failed: true }, 'QA', 'pi');
    expect(after).toMatchObject({
      RELAY_HOOK_WHEN: 'after',
      RELAY_HOOK_COMMAND: 'npm test',
      RELAY_HOOK_OUTPUT: 'ok',
      RELAY_HOOK_FAILED: '1',
    });
  });

  it("cuts a call's long arguments (a whole file's content) and keeps the whole within its limit", () => {
    const long = 'x'.repeat(HOOK_INPUT_LIMITS.value + 50);
    const one = JSON.parse(hookInput({ content: long, path: 'a' }));
    expect(one.content).toHaveLength(HOOK_INPUT_LIMITS.value + 1);
    expect(one.path).toBe('a');
    // Too long as a whole: its values are cut shorter, never the JSON itself, which a hook must be able to read.
    const many = hookInput({ edits: Array.from({ length: 40 }, () => ({ old: long, new: long })) });
    expect(many.length).toBeLessThanOrEqual(HOOK_INPUT_LIMITS.total);
    expect(JSON.parse(many).edits).toHaveLength(40);
    const huge = hookInput(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, Array.from({ length: 50 }, () => long)])));
    expect(JSON.parse(huge)).toEqual({ truncated: true });
    expect(hookInput(undefined)).toBe('{}');
  });

  it('cuts a command too long for one variable after the call, and says before it that it is too long', () => {
    const long = 'x'.repeat(HOOK_CALL_MAX + 10);
    expect(callTooLong({ kind: 'command', tool: 'Bash', command: long })).toBe(true);
    expect(callTooLong({ kind: 'edit', tool: 'Edit', files: [long] })).toBe(true);
    expect(callTooLong({ kind: 'command', tool: 'Bash', command: 'ls' })).toBe(false);
    const env = hookEnv('after', { kind: 'command', tool: 'Bash', command: `${long}é` }, 'a', 'claude');
    expect(Buffer.byteLength(env.RELAY_HOOK_COMMAND!)).toBe(HOOK_CALL_MAX);
  });

  it('names a call in a few words for the user: its command, its files or its tool', () => {
    expect(callLabel({ kind: 'command', tool: 'Bash', command: 'npm  test\n--run' })).toBe('`npm test --run`');
    expect(callLabel({ kind: 'edit', tool: 'Edit', files: ['/a/x.ts', '/a/y.ts', '/a/z.ts', '/a/w.ts'] })).toBe('x.ts, y.ts, z.ts (+1)');
    expect(callLabel({ kind: 'other', tool: 'WebFetch' })).toBe('WebFetch');
  });

  it('quotes each word of a hook program for a shell, a quote in it too', () => {
    expect(shellWords(['/usr/bin/node', "/Library/Application Support/it's/hook.mjs", 'before'])).toBe(
      `'/usr/bin/node' '/Library/Application Support/it'\\''s/hook.mjs' 'before'`,
    );
  });
});

describe.skipIf(process.platform === 'win32')('running the hooks of a turn', () => {
  it('lets a call go on when every before hook succeeds, and refuses it with the first that does not, its output the reason', async () => {
    const ran = join(dir, 'ran');
    const { hooks, notes } = hooksOf([
      hook({ run: 'test "$RELAY_HOOK_COMMAND" != "rm -rf /"' }),
      hook({ run: `echo "no network: $RELAY_HOOK_COMMAND"; exit 1` }),
      hook({ run: `touch ${ran}` }),
    ]);
    const call = { kind: 'command' as const, tool: 'Bash', command: 'curl example.com' };
    const said = await hooks.before(call);
    expect(said).toContain('Refused by the team\'s hook `echo "no network: $RELAY_HOOK_COMMAND"; exit 1`');
    expect(said).toContain('no network: curl example.com');
    // The first refusal stands: the hooks after it are not run.
    expect(existsSync(ran)).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('`curl example.com`');
    expect(await hooksOf([hook({ run: 'true' })]).hooks.before(call)).toBeUndefined();
  });

  it('runs only the hooks of the kind of call, at the moment they are for', async () => {
    const { hooks } = hooksOf([hook({ run: 'exit 1', tools: 'edit' }), hook({ run: 'exit 1', when: 'after' })]);
    expect(await hooks.before({ kind: 'command', tool: 'Bash', command: 'ls' })).toBeUndefined();
    expect(await hooks.before({ kind: 'edit', tool: 'Edit', files: [join(dir, 'a')] })).toContain('Refused');
    expect(await hooks.after({ kind: 'edit', tool: 'Edit', files: [join(dir, 'a')] })).toBeUndefined();
    expect(await hooks.after({ kind: 'command', tool: 'Bash', command: 'ls', output: 'a' })).toContain('did not pass');
  });

  it('fails closed before a call: a hook past its time limit, or one that cannot run, refuses it', async () => {
    const timed = hooksOf([hook({ run: 'sleep 5', timeoutSec: 1 })]);
    await withLang('en', async () => {
      expect(await timed.hooks.before({ kind: 'command', tool: 'Bash', command: 'ls' })).toContain(
        'Stopped at its time limit of 1 seconds',
      );
    });
    const outside = hooksOf([hook({ run: 'true', cwd: '../elsewhere' })]);
    expect(await outside.hooks.before({ kind: 'command', tool: 'Bash', command: 'ls' })).toContain('Refused');
    const windows = hooksOf([hook({ run: 'true' })], deps({ platform: 'win32' }));
    expect(await windows.hooks.before({ kind: 'command', tool: 'Bash', command: 'ls' })).toContain('Refused');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a call too long for a hook to read, without running one, rather than deciding about part of it',
    async () => {
      const ran = join(dir, 'ran');
      const { hooks, notes } = hooksOf([hook({ run: `touch ${ran}` })]);
      const said = await withLang('en', () =>
        hooks.before({ kind: 'command', tool: 'Bash', command: `echo ${'x'.repeat(HOOK_CALL_MAX)}; git push` }),
      );
      expect(said).toContain("too long for the team's hooks to read");
      expect(existsSync(ran)).toBe(false);
      expect(notes).toEqual([expect.stringContaining('too long')]);
      // No hook covers an edit here: such a call goes on, whatever its length.
      expect(await hooks.before({ kind: 'edit', tool: 'Write', files: ['x'.repeat(HOOK_CALL_MAX + 1)] })).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'has a deadline of its own: hooks still running then are stopped, a call before them refused, one after them left alone',
    async () => {
      const notes: string[] = [];
      const late = turnHooks([hook({ run: 'sleep 30' }), hook({ run: 'sleep 30', when: 'after' })], {
        place: { cwds: [dir], unsandboxed: true, protectedPaths: [], privateRoots: [] },
        agent: 'a',
        provider: 'muse',
        notice: (t) => notes.push(t),
        deps: deps(),
        // The hooks' 60 s and the 30 s after them, as 0.9 s.
        deadlineScale: 0.01,
      })!;
      const started = Date.now();
      const said = await withLang('en', () => late.before({ kind: 'command', tool: 'bash', command: 'ls' }));
      expect(said).toBe("Refused: the team's hooks did not finish in time.");
      expect(notes).toEqual([expect.stringContaining('did not finish in time')]);
      expect(await late.after({ kind: 'command', tool: 'bash', command: 'ls', output: '' })).toBeUndefined();
      // A CLI that waits less gives a shorter deadline (10 s here, as 0.1 s).
      const t0 = Date.now();
      expect(await late.before({ kind: 'command', tool: 'bash', command: 'ls' }, 10)).toContain('did not finish in time');
      expect(Date.now() - t0).toBeLessThan(800);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    slow(20_000),
  );

  it('tells the agent what each after hook that failed said, and the user in a note', async () => {
    const { hooks, notes } = hooksOf([
      hook({ when: 'after', tools: 'any', run: 'echo "lint: 2 problems in $RELAY_HOOK_FILES"; exit 1' }),
      hook({ when: 'after', tools: 'any', run: 'true' }),
      hook({ when: 'after', tools: 'any', run: 'echo "$RELAY_HOOK_OUTPUT" | grep -q written' }),
    ]);
    const said = await hooks.after({ kind: 'edit', tool: 'Write', files: [join(dir, 'a.ts')], output: 'written' });
    expect(said).toContain(`lint: 2 problems in ${join(dir, 'a.ts')}`);
    expect(said).not.toContain('grep -q written');
    expect(notes).toEqual([expect.stringContaining('a.ts')]);
  });

  it("runs a hook with a check command's environment: none of the server's secrets, CI=1", async () => {
    const { hooks } = hooksOf([hook({ run: 'test -z "$SECRET_TOKEN" && test "$CI" = 1 && test "$RELAY_HOOK_AGENT" = Builder' })]);
    expect(await hooks.before({ kind: 'command', tool: 'Bash', command: 'ls' })).toBeUndefined();
  });

  it('notes at most a few refusals in one reply, then says that later ones are not listed', async () => {
    const { hooks, notes } = hooksOf([hook({ run: 'exit 1' })]);
    for (let i = 0; i < HOOK_NOTICES + 3; i++) await hooks.before({ kind: 'command', tool: 'Bash', command: `ls ${i}` });
    expect(notes).toHaveLength(HOOK_NOTICES + 1);
  });

  it('knows the kinds each moment covers, and how long a call may wait for its hooks', () => {
    const { hooks } = hooksOf([
      hook({ run: 'a', timeoutSec: 30 }),
      hook({ run: 'b', tools: 'edit' }),
      hook({ run: 'c', when: 'after', tools: 'any', timeoutSec: 5 }),
    ]);
    expect([...hooks.kinds('before')].sort()).toEqual(['command', 'edit']);
    expect([...hooks.kinds('after')]).toEqual(['any']);
    expect(hooks.budgetSec('before')).toBe(90);
    expect(hooks.budgetSec('after')).toBe(5);
    expect(
      turnHooks([], {
        place: { cwds: [dir], unsandboxed: true, protectedPaths: [], privateRoots: [] },
        agent: 'a',
        provider: 'claude',
        notice: () => undefined,
      }),
    ).toBeUndefined();
  });
});

describe('the answers to a hook program of a CLI that takes Claude Code’s', () => {
  const fake = (refuse?: string, tell?: string): TurnHooks => ({
    kinds: () => new Set(['any']),
    budgetSec: () => 60,
    before: async () => refuse,
    after: async () => tell,
    program: () => undefined,
    dispose: () => undefined,
  });
  const toCall = (p: Record<string, any>) => ({
    kind: 'command' as const,
    tool: String(p.tool_name),
    command: String(p.tool_input?.command ?? ''),
  });

  it('refuses with permissionDecision deny and its reason, says nothing to let it go on, and answers after it as the CLI takes it', async () => {
    const handle = commandHookHandler(fake('no'), toCall, (said) => ({ decision: 'block', reason: said }));
    expect(await handle('before', { tool_name: 'bash', tool_input: { command: 'ls' } })).toEqual({
      code: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
      }),
    });
    expect(await commandHookHandler(fake(), toCall, () => ({}))('before', {})).toEqual({ code: 0 });
    const after = commandHookHandler(fake(undefined, 'fix it'), toCall, (said) => ({ decision: 'block', reason: said }));
    expect(await after('after', { tool_name: 'bash' })).toEqual({ code: 0, stdout: '{"decision":"block","reason":"fix it"}' });
    expect(await commandHookHandler(fake(), toCall, () => ({ x: 1 }))('after', 'not an object')).toEqual({ code: 0 });
  });
});

describe.skipIf(process.platform === 'win32')('the hook program through the gateway', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-hookgw-')));
  afterAll(() => removeTree(root));
  let gateway: ToolGateway;
  beforeEach(async () => {
    gateway = new ToolGateway(join(root, `d${Math.random().toString(36).slice(2, 6)}`), join(root, 'tmp'), () => process.execPath);
    await gateway.start();
  });
  afterEach(() => gateway.stop());

  /** Runs the program as a CLI runs its hook command: the call on stdin, `when` after its arguments. */
  const runProgram = (args: string[], when: string, input: string, env?: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, when ? [...args, when] : args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

  it(
    'passes each call to its turn, and prints what the server answers with its exit code',
    async () => {
      const seen: unknown[] = [];
      const handle: HookHandler = async (when, payload) => {
        seen.push({ when, payload });
        return when === 'before' ? { code: 0, stdout: '{"ok":true}' } : { code: 0, stderr: 'noted' };
      };
      const grant = gateway.hookProgram(handle)!;
      const { args } = grant.program;
      expect(args[0]!.startsWith(join(root, 'tmp'))).toBe(true);
      expect(await runProgram(args, 'before', '{"tool_name":"bash","tool_input":{"command":"ls"}}')).toEqual({
        code: 0,
        stdout: '{"ok":true}',
        stderr: '',
      });
      // Each call connects again with the same token.
      expect(await runProgram(args, 'after', '{"tool_name":"bash"}')).toMatchObject({ code: 0, stderr: 'noted' });
      expect(seen).toEqual([
        { when: 'before', payload: { tool_name: 'bash', tool_input: { command: 'ls' } } },
        { when: 'after', payload: { tool_name: 'bash' } },
      ]);
      grant.revoke();
      expect(existsSync(args[0]!)).toBe(false);
      expect(existsSync(args[2]!)).toBe(false);
    },
    slow(20_000),
  );

  it('runs the inline program with a hook-only token and revokes it with the turn', async () => {
    const grant = gateway.hookProgram(async () => ({ code: 0, stdout: 'inline acknowledged' }), 'inline')!;
    const { args, env } = grant.program;
    expect(JSON.stringify(args)).not.toContain(env!.RELAY_HOOK_TOKEN);
    expect(await runProgram(args, 'before', '{}', env)).toEqual({ code: 0, stdout: 'inline acknowledged', stderr: '' });
    expect((await runProgram(args, 'before', '{}')).code).toBe(2);
    grant.revoke();
    expect((await runProgram(args, 'before', '{}', env)).code).toBe(2);
  });

  it(
    'refuses the call before it when it gets no answer (the turn is over, input that is not JSON), and says nothing after it',
    async () => {
      const grant = gateway.hookProgram(async () => ({ code: 0 }))!;
      const { args } = grant.program;
      const bad = await runProgram(args, 'before', 'not json');
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("Refused: the team's hook could not be asked");
      // A copy kept past its turn: the server no longer knows its token.
      const kept = join(root, 'kept.mjs');
      const { copyFileSync } = await import('node:fs');
      copyFileSync(args[0]!, kept);
      const token = join(root, 'kept.token');
      copyFileSync(args[2]!, token);
      grant.revoke();
      const over = await runProgram([kept, args[1]!, token], 'before', '{}');
      expect(over.code).toBe(2);
      expect(over.stderr).toContain('This turn is over');
      expect(await runProgram([kept, args[1]!, token], 'after', '{}')).toEqual({ code: 0, stdout: '', stderr: '' });
    },
    slow(20_000),
  );

  it(
    'refuses on its own when no answer comes within its time limit, before the CLI gives up on it; and a call too large before it runs',
    async () => {
      const grant = gateway.hookProgram(() => new Promise(() => undefined))!;
      const started = Date.now();
      const late = await runProgram([...grant.program.args, 'before', '1'], '', '{"tool_name":"bash"}');
      expect(late.code).toBe(2);
      expect(late.stderr).toContain('no answer in time');
      expect(Date.now() - started).toBeLessThan(8_000);
      expect((await runProgram([...grant.program.args, 'after', '1'], '', '{}')).code).toBe(0);
      // Never cut before a call: the hooks would decide about a command they did not see all of.
      const seen: unknown[] = [];
      const real = gateway.hookProgram(async (_when, payload) => {
        seen.push(payload);
        return { code: 0 };
      })!;
      const big = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'x'.repeat(HOOK_SHIM_MAX) } });
      const refused = await runProgram(real.program.args, 'before', big);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('too large');
      expect(seen).toEqual([]);
      // A long command within the limit arrives whole.
      const long = 'y'.repeat(200_000);
      expect((await runProgram(real.program.args, 'before', JSON.stringify({ tool_input: { command: long } }))).code).toBe(0);
      expect(seen).toEqual([{ tool_input: { command: long } }]);
    },
    slow(30_000),
  );

  it('gives no program while it is not listening, or without Node.js', async () => {
    const none = new ToolGateway(join(root, 'n1'), join(root, 'n1', 'tmp'), () => process.execPath);
    expect(none.hookProgram(async () => ({ code: 0 }))).toBeUndefined();
    const noNode = new ToolGateway(join(root, 'n2'), join(root, 'n2', 'tmp'), () => undefined);
    await noNode.start();
    expect(noNode.hookProgram(async () => ({ code: 0 }))).toBeUndefined();
    await noNode.stop();
  });

  it('ends the grants a turn took when the turn is over', async () => {
    const hooks = turnHooks([hook({ run: 'true' })], {
      place: { cwds: [dir], unsandboxed: true, protectedPaths: [], privateRoots: [] },
      agent: 'a',
      provider: 'muse',
      notice: () => undefined,
      program: (h) => gateway.hookProgram(h),
      deps: deps(),
    })!;
    const program = hooks.program(async () => ({ code: 0 }))!;
    expect(existsSync(program.args[0]!)).toBe(true);
    hooks.dispose();
    expect(existsSync(program.args[0]!)).toBe(false);
    expect(hooks.program(async () => ({ code: 0 }))).toBeUndefined();
  });
});
