/*
 * Interactive commands (docs/architecture.md, "Interactive commands"): the `<interactive>` block
 * (`src/shared/handoffs.ts`), the card's logic (`src/web/handoffs.ts`), and a session
 * (`src/server/interactive.ts`) with a real short shell program where there is a `/bin/sh`: its output
 * and what is typed into it, hidden or not, masked; its links and codes; its environment (no `CI`, never
 * the server's other variables); its folder; Cancel and its time limit; and its password helper's round
 * trip through a real gateway's socket (`askpassShim.ts`).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INTERACTIVE_LIMITS } from '../src/shared/types';
import { interactiveLine, splitHandoffs, withoutHandoffBlocks } from '../src/shared/handoffs';
import { interactiveActions, sessionTone, startRequest, startsInWorkdir, wantsHidden, type InteractivePart } from '../src/web/handoffs';
import { handoffSection } from '../src/server/prompt';
import { ASKPASS_SCRIPT } from '../src/server/askpassShim';
import { ToolGateway } from '../src/server/gateway';
import {
  defaultInteractiveDeps,
  hooksPathOf,
  interactiveEnv,
  InteractiveRun,
  terminalText,
  workdirConfigFiles,
  workdirDigest,
  type InteractiveDeps,
} from '../src/server/interactive';
import { removeTree } from '../src/server/fsRemove';
import { slow } from './timeouts';

// A short folder: the gateway's socket goes in it, and a Unix socket's path is short.
const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'relay-ia-')));
afterAll(() => removeTree(root, { restore: true }));
const posix = process.platform !== 'win32';

describe('the <interactive> block', () => {
  it('takes a command for the user to run, with its reason and whether it needs the working directory', () => {
    const text = [
      'Sign in to gcloud, please.',
      '',
      '<interactive reason="To deploy, gcloud needs your sign-in.">gcloud auth login --no-launch-browser</interactive>',
      '<interactive reason="To push" workdir="yes">',
      'git push',
      '</interactive>',
    ].join('\n');
    const { text: rest, blocks } = splitHandoffs(text);
    expect(rest).toBe('Sign in to gcloud, please.');
    expect(blocks).toEqual([
      { kind: 'interactive', run: 'gcloud auth login --no-launch-browser', reason: 'To deploy, gcloud needs your sign-in.' },
      { kind: 'interactive', run: 'git push', reason: 'To push', workdir: true },
    ]);
    expect(splitHandoffs('<interactive>`npm login`</interactive>').blocks).toEqual([{ kind: 'interactive', run: 'npm login' }]);
  });

  it('leaves examples in code, one inside a sentence, an empty or too long one as text', () => {
    const cases = [
      '```\n<interactive>npm login</interactive>\n```',
      'Run <interactive>npm login</interactive> like this.',
      '<interactive reason="x"></interactive>',
      '<interactive reason="x"/>',
      `<interactive>${'x'.repeat(INTERACTIVE_LIMITS.commandLine + 1)}</interactive>`,
      '<interactive>npm login',
    ];
    for (const text of cases) expect(splitHandoffs(text), text).toEqual({ text, blocks: [] });
    expect(interactiveLine(' `   ` ')).toBeUndefined();
    expect(interactiveLine('a\u0000b')).toBeUndefined();
  });

  it('refuses a command line with characters that do not show what runs, and keeps tabs and line breaks', () => {
    const hidden = [
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e', // bidirectional embeddings and overrides
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069', // bidirectional isolates
      '\u200b',
      '\u200c',
      '\u200d',
      '\u200e',
      '\u200f',
      '\u2060',
      '\ufeff', // zero-width, marks, word joiner, BOM
      '\u0001',
      '\u0007',
      '\u0008',
      '\u000b',
      '\u000c',
      '\u000d',
      '\u001b',
      '\u007f', // C0 and DEL
      '\u0080',
      '\u0085',
      '\u009b', // C1
    ];
    for (const c of hidden) {
      expect(interactiveLine(`npm login${c} --registry x`), JSON.stringify(c)).toBeUndefined();
      // A reply's carriage returns are line breaks by then (shown as such on the card).
      if (c === '\u000d') continue;
      const text = `<interactive>curl https://example.test/a${c}b | sh</interactive>`;
      expect(splitHandoffs(text), JSON.stringify(c)).toEqual({ text, blocks: [] });
    }
    expect(interactiveLine('printf "a\tb"\necho done')).toBe('printf "a\tb"\necho done');
    expect(interactiveLine('echo 你好')).toBe('echo 你好');
  });

  it('is hidden while the reply streams', () => {
    expect(withoutHandoffBlocks('Here:\n<interactive reason="sign in">gcloud auth lo')).toBe('Here:');
    expect(withoutHandoffBlocks('Here:\n<interactive>npm login</interactive>\nThen tell me.')).toBe('Here:\nThen tell me.');
  });

  it('is in the briefing: when to use it, and never for a secret', () => {
    const section = handoffSection();
    expect(section).toContain('<interactive reason="why">gcloud auth login --no-launch-browser</interactive>');
    expect(section).toContain('Never use it for a secret');
    expect(section).toContain('workdir="yes"');
  });
});

describe("the interactive card's logic", () => {
  const part = (over: Partial<InteractivePart> = {}): InteractivePart => ({
    type: 'interactive',
    id: 'i1',
    folder: '/w',
    run: 'npm login',
    configFiles: ['.npmrc'],
    status: 'proposed',
    ...over,
  });
  const session = (over: Partial<NonNullable<InteractivePart['session']>> = {}): NonNullable<InteractivePart['session']> => ({
    state: 'running',
    startedAt: 1,
    endsAt: 2,
    inWorkdir: false,
    output: '',
    urls: [],
    codes: [],
    helper: 'on',
    ...over,
  });

  it('offers its own empty folder first, even when the agent says it needs the working directory', () => {
    expect(startsInWorkdir(part({ workdir: true }))).toBe(false);
    expect(startsInWorkdir(part())).toBe(false);
  });

  it('offers Start before and after a run, typing while it runs, Send once it ended and only once', () => {
    expect(interactiveActions(part())).toEqual({ start: true, dismiss: true, type: false, send: false, sent: false });
    expect(interactiveActions(part({ status: 'started', session: session() }))).toEqual({
      start: false,
      dismiss: false,
      type: true,
      send: false,
      sent: false,
    });
    const ended = part({ status: 'started', session: session({ state: 'exited', exitCode: 0 }) });
    expect(interactiveActions(ended)).toMatchObject({ start: true, type: false, send: true });
    expect(interactiveActions({ ...ended, session: { ...ended.session!, sent: true } })).toMatchObject({ send: false, sent: true });
    expect(interactiveActions(part({ blocked: 'automation' }))).toMatchObject({ start: false, dismiss: true });
    expect(interactiveActions(part({ status: 'dismissed' }))).toMatchObject({ start: false, dismiss: false });
  });

  it('sends the configuration files it listed only when it starts in the working directory', () => {
    expect(startRequest(part(), true)).toEqual({ workdir: true, seen: ['.npmrc'] });
    expect(startRequest(part(), false)).toEqual({ workdir: false, seen: [] });
  });

  it('hides what is typed while the program seems to ask for a password, and tells how a run went', () => {
    expect(wantsHidden('Username: jo\nPassword: ')).toBe(true);
    expect(wantsHidden('Enter passphrase for key /home/jo/.ssh/id_ed25519:')).toBe(true);
    expect(wantsHidden('請輸入密碼：')).toBe(true);
    expect(wantsHidden('Username: ')).toBe(false);
    expect(wantsHidden('Enter the code from https://example.com/token?x=1')).toBe(false);
    expect(sessionTone(session({ state: 'exited', exitCode: 0 }))).toBe('ok');
    expect(sessionTone(session({ state: 'exited', exitCode: 1 }))).toBe('bad');
    expect(sessionTone(session({ state: 'cancelled' }))).toBe('warn');
  });
});

describe('what an interactive command runs with', () => {
  it("gets checkEnv()'s variables without CI, never the server's others, and the password helper when there is one", () => {
    const base = { PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'sk-x', CI: 'true', GH_TOKEN: 'g' };
    const env = interactiveEnv(base, 'npm login');
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', RELAY_CHECK_COMMAND: 'npm login', PYTHONUNBUFFERED: '1' });
    expect(env.CI).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SUDO_ASKPASS).toBeUndefined();
    const helper = interactiveEnv(base, 'git push', {
      node: '/n',
      script: '/s/askpass',
      program: '/s/askpass.mjs',
      socket: '/g.sock',
      token: '/s/t',
    });
    expect(helper).toMatchObject({
      SUDO_ASKPASS: '/s/askpass',
      SSH_ASKPASS: '/s/askpass',
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_ASKPASS: '/s/askpass',
      RELAY_ASKPASS_NODE: '/n',
      RELAY_ASKPASS_TOKEN_FILE: '/s/t',
    });
    // The helper's script is fixed text: what it starts comes from the environment.
    expect(ASKPASS_SCRIPT).toContain('exec "$RELAY_ASKPASS_NODE" "$RELAY_ASKPASS_PROGRAM" "$@"');
  });

  it('shows the output as a terminal leaves it', () => {
    expect(terminalText('\u001b[1mbold\u001b[0m\r\nprogress 10%\rprogress 100%\nend\u0007\r')).toBe('bold\nprogress 100%\nend');
  });

  it('lists the configuration files a program may load in the working directory', () => {
    const dir = join(root, 'config-files');
    mkdirSync(join(dir, '.git'), { recursive: true });
    for (const f of ['.npmrc', '.env.local', 'package.json', 'README.md', 'main.py']) writeFileSync(join(dir, f), '');
    writeFileSync(join(dir, '.git', 'config'), '');
    expect(workdirConfigFiles(dir)).toEqual(['.env.local', '.git/config', '.npmrc', 'package.json']);
    expect(workdirConfigFiles(join(root, 'none'))).toEqual([]);
    // The programs a folder installs, and what make or just would read.
    const progs = join(root, 'progs');
    mkdirSync(join(progs, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(progs, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(progs, 'GNUmakefile'), 'all:\n');
    writeFileSync(join(progs, 'justfile'), 'x:\n');
    expect(workdirConfigFiles(progs)).toEqual(['.venv', 'GNUmakefile', 'justfile', 'node_modules']);
    // What they hold: a program the folder installs changing changes it.
    writeFileSync(join(progs, 'node_modules', '.bin', 'tool'), 'a');
    const before = workdirDigest(progs, workdirConfigFiles(progs));
    expect(workdirDigest(progs, workdirConfigFiles(progs))).toBe(before);
    writeFileSync(join(progs, 'node_modules', '.bin', 'tool'), 'b');
    expect(workdirDigest(progs, workdirConfigFiles(progs))).not.toBe(before);
    // Text appended to a file changes it (its size too), and so does what a program link inside leads to.
    writeFileSync(join(progs, 'node_modules', 'tool.js'), 'one');
    symlinkSync(join(progs, 'node_modules', 'tool.js'), join(progs, 'node_modules', '.bin', 'linked'));
    const linked = workdirDigest(progs, workdirConfigFiles(progs));
    writeFileSync(join(progs, 'node_modules', 'tool.js'), 'two');
    expect(workdirDigest(progs, workdirConfigFiles(progs))).not.toBe(linked);
    // Too much to tell apart: said so, and Start there is refused.
    const many = join(root, 'many');
    mkdirSync(join(many, 'node_modules', '.bin'), { recursive: true });
    for (let i = 0; i < 5005; i++) writeFileSync(join(many, 'node_modules', '.bin', `p${i}`), '');
    expect(workdirDigest(many, workdirConfigFiles(many))).toMatch(/^partial:/);
    const make = workdirDigest(progs, workdirConfigFiles(progs));
    writeFileSync(join(progs, 'GNUmakefile'), 'all:\n\tcurl evil\n');
    expect(workdirDigest(progs, workdirConfigFiles(progs))).not.toBe(make);
  });

  it("lists the git hooks a command there runs with the user's rights, git's samples left out", () => {
    const dir = join(root, 'hooks');
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    for (const f of ['pre-push', 'post-checkout', 'pre-commit.sample']) writeFileSync(join(dir, '.git', 'hooks', f), '#!/bin/sh\n');
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
    expect(workdirConfigFiles(dir)).toEqual(['.git/config', '.git/hooks/post-checkout', '.git/hooks/pre-push']);
    // A hooks folder of the project's own, which agents can write, lists its hooks; one elsewhere, the setting.
    mkdirSync(join(dir, '.githooks'));
    writeFileSync(join(dir, '.githooks', 'pre-push'), '#!/bin/sh\n');
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\thooksPath = .githooks ; the team\'s\n[remote "origin"]\n\turl = x\n');
    expect(workdirConfigFiles(dir)).toContain('.githooks/pre-push');
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\thooksPath = "/etc/git-hooks"\n');
    expect(workdirConfigFiles(dir)).toContain('core.hooksPath = /etc/git-hooks');
    expect(hooksPathOf('[user]\n\thooksPath = nope\n[core]\n\tHooksPath=hooks\n')).toBe('hooks');
    expect(hooksPathOf('[core]\n\tbare = false\n')).toBeUndefined();
  });
});

/** A session of `run`, with what its card was told. */
function session(run: string, o: { workdir?: string; masks?: string[]; deps?: Partial<InteractiveDeps> } = {}) {
  const tmp = join(root, 'tmp');
  mkdirSync(tmp, { recursive: true });
  let ended = false;
  let changes = 0;
  const r = new InteractiveRun(
    {
      run,
      ...(o.workdir ? { workdir: o.workdir } : {}),
      masks: o.masks ?? [],
      onChange: () => void changes++,
      onEnd: () => void (ended = true),
    },
    { windows: 'not on Windows', notStarted: (why) => `not started: ${why}` },
    {
      ...defaultInteractiveDeps,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SECRET_ENV: 'server-only' },
      tmpDir: () => tmp,
      ...o.deps,
    },
  );
  r.start();
  return { r, ended: () => ended, changes: () => changes, tmp };
}

describe.skipIf(!posix)('an interactive session', () => {
  it('shows its output with links and codes, takes what is typed as it is, and masks what was typed hidden', async () => {
    const { r, ended, tmp } = session(
      `printf 'Open https://example.test/device and enter ABCD-1234\\nUsername: '; IFS= read -r u; printf 'Password: '; IFS= read -r p; printf 'user=[%s] pass=[%s] token=%s env=%s ci=%s\\n' "$u" "$p" tok-123456 "\${SECRET_ENV:-none}" "\${CI:-none}"; pwd`,
      { masks: ['tok-123456'] },
    );
    await vi.waitFor(() => expect(r.view().output).toContain('Username: '));
    expect(r.view()).toMatchObject({ state: 'running', urls: ['https://example.test/device'], codes: ['ABCD-1234'], helper: 'off' });
    expect(r.write(' jo ', false)).toBe(true);
    await vi.waitFor(() => expect(r.view().output).toContain('Password: '));
    expect(r.write('hunter2-pass', true)).toBe(true);
    await vi.waitFor(() => expect(ended()).toBe(true), { timeout: slow(5000) });
    const view = r.view();
    expect(view).toMatchObject({ state: 'exited', exitCode: 0, inWorkdir: false });
    // Typed as it is (not trimmed), shown when visible; hidden, masked wherever it shows.
    expect(view.output).toContain('Username:  jo \n');
    expect(view.output).toContain('user=[ jo ] pass=[••••] token=•••• env=none ci=none');
    expect(view.output).not.toContain('hunter2-pass');
    // It ran in an empty folder of its own, gone with it.
    expect(view.output).toMatch(/interactive-[^/\n]+\/work/);
    expect(readdirSync(tmp).filter((n) => n.startsWith('interactive-'))).toEqual([]);
    expect(r.write('late', false)).toBe(false);
  });

  it('ends at its exit even while a process it left in another process group holds its output', async () => {
    // A child of its own session (as `setsid` or ssh's ControlPersist leave one) keeps the pipe open.
    const leave = `require('child_process').spawn('sleep', ['20'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref()`;
    const { r, ended, tmp } = session(`'${process.execPath}' -e "${leave}"; echo left`);
    const started = Date.now();
    await vi.waitFor(() => expect(ended()).toBe(true), { timeout: slow(5000) });
    expect(Date.now() - started).toBeLessThan(slow(4000));
    expect(r.view()).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(r.view().output).toContain('left');
    expect(readdirSync(tmp).filter((n) => n.startsWith('interactive-'))).toEqual([]);
  });

  it('runs in the working directory when asked, and a failing command says its exit code', async () => {
    const dir = join(root, 'workdir');
    mkdirSync(dir, { recursive: true });
    const { r, ended } = session('pwd; exit 3', { workdir: dir });
    await vi.waitFor(() => expect(ended()).toBe(true), { timeout: slow(5000) });
    expect(r.view()).toMatchObject({ state: 'exited', exitCode: 3, inWorkdir: true });
    expect(r.view().output.trim()).toBe(realpathSync(dir));
  });

  it('stops on Cancel and at its time limit, and refuses to start on Windows', async () => {
    const a = session('sleep 30');
    await vi.waitFor(() => expect(a.r.running).toBe(true));
    a.r.stop('cancelled');
    await vi.waitFor(() => expect(a.ended()).toBe(true), { timeout: slow(5000) });
    expect(a.r.view().state).toBe('cancelled');

    const b = session('sleep 30', { deps: { timeoutMs: 300 } });
    await vi.waitFor(() => expect(b.ended()).toBe(true), { timeout: slow(5000) });
    expect(b.r.view().state).toBe('timedOut');

    const w = session('true', { deps: { platform: 'win32' } });
    expect(w.ended()).toBe(true);
    expect(w.r.view()).toMatchObject({ state: 'failed', reason: 'not on Windows' });
  });

  it('keeps the end of a long output', async () => {
    const { r, ended } = session(`i=0; while [ $i -lt 3000 ]; do echo "line $i of a long output"; i=$((i+1)); done`);
    await vi.waitFor(() => expect(ended()).toBe(true), { timeout: slow(10_000) });
    const out = r.view().output;
    expect(out.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.output + 2);
    expect(out.startsWith('…\nline ')).toBe(true);
    expect(out).toContain('line 2999 of a long output');
  });
});

describe.skipIf(!posix)("an interactive session's password helper", () => {
  let gateway: ToolGateway;
  beforeAll(async () => {
    gateway = new ToolGateway(join(root, 'data'), join(root, 'data', 'tmp'), () => process.execPath);
    await gateway.start();
  });
  afterAll(() => gateway.stop());

  it('asks the card for one hidden line, as sudo -A, ssh and git run it, and masks the answer', async () => {
    const { r, ended } = session(
      `a=$("$SUDO_ASKPASS" '[sudo] password for jo:'); echo "helper said [$a]"; b=$("$GIT_ASKPASS" "Password for 'https://github.com':") || echo "refused: $?"; echo "b=[$b]"`,
      { deps: { askpass: (ask) => gateway.askpassGrant(ask) ?? 'off' } },
    );
    await vi.waitFor(() => expect(r.view().asking?.prompt).toBe('[sudo] password for jo:'), { timeout: slow(10_000) });
    const view = r.view();
    expect(view.helper).toBe('on');
    expect(r.answer('another question', 'x')).toBe(false);
    expect(r.answer(view.asking!.id, 'open-sesame-9')).toBe(true);
    await vi.waitFor(() => expect(r.view().asking?.prompt).toBe("Password for 'https://github.com':"), { timeout: slow(10_000) });
    expect(r.view().output).toContain('helper said [••••]');
    r.answer(r.view().asking!.id, undefined);
    await vi.waitFor(() => expect(ended()).toBe(true), { timeout: slow(10_000) });
    const out = r.view().output;
    expect(out).toContain('[sudo] password for jo:');
    expect(out).toContain('refused: 1');
    expect(out).toContain('b=[]');
    expect(out).not.toContain('open-sesame-9');
  });

  it('refuses once its session is over, and says when there is no Node.js', async () => {
    let grant: ReturnType<ToolGateway['askpassGrant']>;
    const { r, ended } = session('echo done', {
      deps: {
        askpass: (ask) => {
          grant = gateway.askpassGrant(ask);
          return grant ?? 'off';
        },
      },
    });
    await vi.waitFor(() => expect(ended()).toBe(true), { timeout: slow(5000) });
    expect(r.view().output.trim()).toBe('done');
    // Its token served this session alone: revoked with it.
    const askAfter = await new Promise<string>((done) => {
      const sock = connect(grant!.socketPath);
      let got = '';
      sock.on('connect', () =>
        sock.write(`${JSON.stringify({ token: grant!.token })}\n${JSON.stringify({ id: 1, method: 'askpass', prompt: 'p' })}\n`),
      );
      sock.on('data', (d: Buffer) => (got += d.toString()));
      sock.on('close', () => done(got));
      sock.on('error', () => done(got));
    });
    expect(askAfter).not.toContain('"result"');

    const n = session('echo hi', { deps: { askpass: () => 'no-node' } });
    await vi.waitFor(() => expect(n.ended()).toBe(true), { timeout: slow(5000) });
    expect(n.r.view().helper).toBe('no-node');
    expect(existsSync(join(root, 'tmp'))).toBe(true);
  });
});
