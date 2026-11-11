import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OPEN_PROVIDERS, type OpenProvider } from '../src/shared/types';

/*
 * What a run of an open agent may write is its own: each conversation member's state (sessions,
 * logs, caches) in a folder of its own state key, which no run of another key can read or write; a
 * member that last ran with a lower permission starts with it emptied; the run's environment holds
 * only its own backend's key. See docs/open-agents.md, "Agent homes".
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-open-state-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { startOpenProcess, stateFolder, stateFolderName, emptyStateFolder, PRIVATE_DIR, PROBE_STATE, privateRoots, removeConversationState, clearOpenRunLeftovers, sealedFolder } = await import(
  '../src/server/agents/open'
);
const { stateKeys } = await import('../src/server/agents/types');
const { acpApprovalRequest, acpCallInfo, inputDetail } = await import('../src/server/agents/acpTurn');
const { relaySandboxPaths } = await import('../src/server/relaySandbox');
const { OPEN_AGENT_HOME_ENV, OPEN_AGENT_ROOTS_ENV } = await import('../src/server/settings');
const { withLang } = await import('../src/server/i18n');
const { validateAgents } = await import('../src/server/validate');
const { opencodeAcp } = await import('../src/server/agents/opencode');
const { gooseAcp } = await import('../src/server/agents/goose');
const { clineAcp } = await import('../src/server/agents/cline');
const { openhandsAcp } = await import('../src/server/agents/openhands');
const { piProcess } = await import('../src/server/agents/pi');
type Spec = import('../src/server/relaySandbox').RelaySandboxSpec;
type Process = import('../src/server/agents/open').OpenAgentProcess;
type Options = import('../src/server/agents/types').RunOptions;

afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = join(root, 'agent-homes');
let n = 0;

/** A done adapter whose CLI keeps its sessions in `<state>/sessions`. */
const agent = (over: Partial<Process> = {}): Process => ({
  provider: 'opencode',
  implemented: true,
  home: (_root, state) => ({ env: { SESSIONS: join(state, 'sessions') }, statePaths: [join(state, 'sessions')], configPaths: [] }),
  ...over,
});

function options(over: Partial<Options> = {}): Options {
  const cwd = join(root, `cwd-${++n}`);
  mkdirSync(cwd, { recursive: true });
  return {
    bin: 'opencode',
    env: { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: join(base, 'opencode') },
    prompt: 'hi',
    systemPrompt: '',
    cwd,
    permission: 'edit',
    model: 'openai/gpt-5.4-nano',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    backends: { apis: { openai: 'sk-test-openai-0000', anthropic: 'sk-ant-test-0000' }, endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['m'], apiKey: 'lab-key-0000' }] },
    ...over,
  };
}

/** A relay sandbox that records the spec it is given and runs nothing. */
function sandbox(specs: Spec[]) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    sandboxAvailable: async () => ({ ok: true as const }),
    makeRunDirs: () => {
      const dir = mkdtempSync(join(root, 'run-'));
      mkdirSync(join(dir, 'tmp'));
      mkdirSync(join(dir, 'host'));
      return { tmp: join(dir, 'tmp'), hostTmp: join(dir, 'host') };
    },
    sandboxCommand: async (bin: string, args: string[], env: NodeJS.ProcessEnv, spec: Spec) => {
      specs.push(spec);
      return { bin, args, env, channel: () => undefined, failure: () => undefined, run: {} as never, dispose: async () => { for (const d of [spec.dirs?.tmp, spec.dirs?.hostTmp]) if (d) rmSync(d, { recursive: true, force: true }); } };
    },
    runTmpDir: join(root, 'full-tmp'),
  };
}

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

describe("a conversation member's own state", () => {
  it('keeps each key in a folder of its own, which another conversation’s sandboxed run can neither read nor write', async () => {
    const specs: Spec[] = [];
    const a = await startOpenProcess(agent(), options({ stateKey: 'conv.c1.a1' }), () => [], sandbox(specs));
    const b = await startOpenProcess(agent(), options({ stateKey: 'conv.c2.a1', permission: 'read-only' }), () => [], sandbox(specs));
    const home = join(base, 'opencode');
    const stateA = join(home, PRIVATE_DIR, 'conv.c1.a1');
    const stateB = join(home, PRIVATE_DIR, 'conv.c2.a1');
    expect([a.ctx.home.state, b.ctx.home.state]).toEqual([stateA, stateB]);
    expect(a.env.SESSIONS).toBe(join(stateA, 'sessions'));
    // What each may write: its own state and temp folder; nothing of the other's, nothing else of the home.
    expect(specs[0]!.writable).toEqual([join(stateA, 'sessions'), a.ctx.tmpDir]);
    expect(specs[1]!.writable).toEqual([join(stateB, 'sessions'), b.ctx.tmpDir]);
    // Every open agent's private folder is kept from reading, its own part excepted.
    for (const p of OPEN_PROVIDERS) expect(specs[0]!.privateRoots).toContain(join(base, p, PRIVATE_DIR));
    const ctx = { home: join(root, 'user-home'), dataDir: join(root, 'data') };
    const paths = relaySandboxPaths(specs[0]!, ctx, { tmp: a.ctx.tmpDir, hostTmp: join(root, 'h') });
    expect(paths.denyRead).toContain(join(home, PRIVATE_DIR));
    expect(paths.allowRead).toContain(join(stateA, 'sessions'));
    expect(paths.allowRead.some((p) => inside(p, stateB))).toBe(false);
    // What the server sealed for the key itself (Goose's extension list) is in the private root, and
    // not among the run's own folders: neither readable nor writable.
    const sealed = sealedFolder(home, 'conv.c1.a1');
    expect(paths.denyRead.some((p) => inside(sealed, p))).toBe(true);
    expect([...paths.allowRead, ...paths.allowWrite].some((p) => inside(sealed, p) || inside(p, sealed))).toBe(false);
    expect(paths.allowWrite.some((p) => inside(p, stateB))).toBe(false);
    // The other way round as well.
    const other = relaySandboxPaths(specs[1]!, ctx, { tmp: b.ctx.tmpDir, hostTmp: join(root, 'h') });
    expect(other.allowRead.some((p) => inside(p, stateA))).toBe(false);
    expect(other.allowWrite.some((p) => inside(p, stateA))).toBe(false);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('keeps a key’s folder from one run to the next, so the session resumes; empties it with freshState', async () => {
    const first = await startOpenProcess(agent(), options({ stateKey: 'conv.c3.a1' }), () => [], sandbox([]));
    mkdirSync(join(first.ctx.home.state, 'sessions'), { recursive: true });
    writeFileSync(join(first.ctx.home.state, 'sessions', 's1.jsonl'), 'session\n');
    await first.dispose();
    const again = await startOpenProcess(agent(), options({ stateKey: 'conv.c3.a1' }), () => [], sandbox([]));
    expect(again.ctx.home.state).toBe(first.ctx.home.state);
    expect(readFileSync(join(again.ctx.home.state, 'sessions', 's1.jsonl'), 'utf8')).toBe('session\n');
    await again.dispose();
    // The member's previous run had a lower permission: nothing it wrote is left.
    const raised = await startOpenProcess(agent(), options({ stateKey: 'conv.c3.a1', freshState: true }), () => [], sandbox([]));
    expect(existsSync(join(raised.ctx.home.state, 'sessions', 's1.jsonl'))).toBe(false);
    expect(existsSync(raised.ctx.home.state)).toBe(true);
    await raised.dispose();
  });

  it('gives a run without a key a folder of its own, removed after it', async () => {
    const run = await startOpenProcess(agent(), options(), () => [], sandbox([]));
    expect(run.ctx.home.state.startsWith(join(base, 'opencode', PRIVATE_DIR, 'run-'))).toBe(true);
    expect(existsSync(run.ctx.home.state)).toBe(true);
    await run.dispose();
    expect(existsSync(run.ctx.home.state)).toBe(false);
  });

  it('does not run sandboxed when an adapter would write outside the state folder (shared with other runs)', async () => {
    const shared = agent({ home: (home) => ({ env: {}, statePaths: [join(home, 'sessions')], configPaths: [] }) });
    await expect(withLang('en', () => startOpenProcess(shared, options({ stateKey: 'conv.c4.a1' }), () => [], sandbox([])))).rejects.toThrow(/not in this member's own folder/);
    // With full access there is no sandbox to keep: it runs.
    const full = await startOpenProcess(shared, options({ stateKey: 'conv.c4.a1', permission: 'full' }), () => [], sandbox([]));
    await full.dispose();
  });

  it('names a key’s folder by the key when it is a plain name, else by a hash, never outside private/', () => {
    expect(stateFolderName('conv.0b7d2c1e-1d2a-4c5b-9a8e-1234567890ab.a1')).toBe('conv.0b7d2c1e-1d2a-4c5b-9a8e-1234567890ab.a1');
    for (const key of ['../escape', 'a/b', '..', '.hidden', 'x'.repeat(300)]) {
      const name = stateFolderName(key);
      expect(name).toMatch(/^key-[0-9a-f]{40}$/);
      expect(stateFolderName(key)).toBe(name); // stable
    }
    expect(stateFolderName('../a')).not.toBe(stateFolderName('../b'));
  });

  it('lists every open agent’s private folder, and the run-temp folders once they exist', () => {
    const home = join(root, 'homes2', 'pi');
    const data = join(root, 'data2');
    const roots = privateRoots(home, [join(data, 'relay-sandbox'), join(data, 'run-tmp')]);
    expect(roots[0]).toBe(join(home, PRIVATE_DIR));
    expect(new Set(roots)).toEqual(new Set(OPEN_PROVIDERS.map((p) => join(root, 'homes2', p, PRIVATE_DIR))));
    for (const r of roots) expect(existsSync(r)).toBe(true);
    mkdirSync(join(data, 'run-tmp'), { recursive: true });
    expect(privateRoots(home, [join(data, 'relay-sandbox'), join(data, 'run-tmp')])).toContain(join(data, 'run-tmp'));
  });

  it("keeps a run from reading what runs kept in the folders the homes were in before, and makes none there", async () => {
    const before = join(root, 'homes-before');
    mkdirSync(join(before, 'goose', PRIVATE_DIR), { recursive: true });
    const roots = privateRoots(join(root, 'homes3', 'opencode'), [], [before, join(root, 'homes-gone')]);
    expect(roots).toContain(join(before, 'goose', PRIVATE_DIR));
    // Only what is there: nothing is made in an earlier folder.
    expect(roots).not.toContain(join(before, 'opencode', PRIVATE_DIR));
    expect(existsSync(join(root, 'homes-gone'))).toBe(false);
    // A run learns them from its environment (SettingsStore.env).
    const specs: Spec[] = [];
    await startOpenProcess(agent(), options({ stateKey: 'conv.c9.a1', env: { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: join(base, 'opencode'), [OPEN_AGENT_ROOTS_ENV]: JSON.stringify([before]) } }), () => [], sandbox(specs));
    expect(specs[0]!.privateRoots).toContain(join(before, 'goose', PRIVATE_DIR));
  });
});

describe("each open agent's layout", () => {
  const adapters: [OpenProvider, Process][] = [
    ['opencode', opencodeAcp],
    ['goose', gooseAcp],
    ['cline', clineAcp],
    ['openhands', openhandsAcp],
    ['pi', piProcess],
  ];
  /** Each CLI's variables that say where it keeps its sessions. */
  const sessionVars: Record<OpenProvider, string[]> = {
    opencode: ['XDG_DATA_HOME', 'XDG_STATE_HOME'],
    goose: ['GOOSE_PATH_ROOT'],
    cline: ['CLINE_DATA_DIR'],
    openhands: ['OPENHANDS_CONVERSATIONS_DIR'],
    pi: ['PI_CODING_AGENT_SESSION_DIR'],
  };

  it.each(adapters)('%s keeps everything a run writes in the state folder, and points the CLI there', (p, process) => {
    const home = join(root, 'layout', p);
    const state = join(home, PRIVATE_DIR, 'conv.c1.a1');
    const layout = process.home(home, state);
    expect(layout.statePaths.length).toBeGreaterThan(0);
    for (const path of layout.statePaths) expect(inside(path, state), path).toBe(true);
    for (const name of sessionVars[p]) expect(inside(layout.env[name]!, state), name).toBe(true);
  });
});

describe('the keys in a run’s environment', () => {
  it("holds only the run's own backend's key, not one the server holds or inherited", async () => {
    const o = options({ stateKey: 'conv.c5.a1', permission: 'full' });
    // Keys and addresses of other providers, which these CLIs read from the environment too.
    const others = {
      GEMINI_API_KEY: 'g',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
      OPENROUTER_API_KEY: 'or',
      AZURE_OPENAI_API_KEY: 'az',
      MISTRAL_API_KEY: 'm',
      HF_TOKEN: 'hf',
      OLLAMA_HOST: 'http://10.0.0.9:11434',
      AWS_BEARER_TOKEN_BEDROCK: 'b',
      CLAUDE_CODE_OAUTH_TOKEN: 'c',
    };
    o.env = { ...o.env, ...others, XAI_API_KEY: 'xai-from-the-shell', OPENAI_BASE_URL: 'https://elsewhere.example', ANTHROPIC_API_KEY: 'sk-ant-from-settings-env', GITHUB_TOKEN: 'gh', AWS_PROFILE: 'dev' };
    const own = await startOpenProcess(agent(), o, () => [], sandbox([]));
    expect([own.env.OPENAI_API_KEY, own.env.ANTHROPIC_API_KEY, own.env.XAI_API_KEY, own.env.OPENAI_BASE_URL]).toEqual(['sk-test-openai-0000', undefined, undefined, undefined]);
    for (const name of Object.keys(others)) expect(own.env[name], name).toBeUndefined();
    // What is not a model backend's still passes (a CLI's own tools may use it).
    expect([own.env.GITHUB_TOKEN, own.env.AWS_PROFILE]).toEqual(['gh', 'dev']);
    await own.dispose();
    // On an endpoint: no API backend's key at all (the adapter places the endpoint's own).
    const lab = await startOpenProcess(agent(), { ...o, model: 'homelab/m' }, () => [], sandbox([]));
    expect([lab.env.OPENAI_API_KEY, lab.env.ANTHROPIC_API_KEY]).toEqual([undefined, undefined]);
    expect(lab.ctx.run.endpoint?.apiKey).toBe('lab-key-0000');
    await lab.dispose();
    // An adapter that says why it needs them all gets them.
    const all = await startOpenProcess(agent({ allBackendKeys: 'its config lists every provider' }), o, () => [], sandbox([]));
    expect([all.env.OPENAI_API_KEY, all.env.ANTHROPIC_API_KEY]).toEqual(['sk-test-openai-0000', 'sk-ant-test-0000']);
    await all.dispose();
  });
});

describe('what a deleted conversation and a stopped server leave', () => {
  const homes = OPEN_PROVIDERS.map((p) => join(root, 'left', p));
  const leave = (home: string, key: string) => {
    const dir = stateFolder(home, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session'), 'x');
    return dir;
  };

  it("removes every open agent's state of a deleted conversation: its members', its lead agent's and its sorter's", () => {
    const gone = [
      leave(homes[0]!, stateKeys.member('c1', 'a')),
      leave(homes[1]!, stateKeys.member('c1', 'b')),
      leave(homes[2]!, stateKeys.lead('c1')),
      leave(homes[3]!, stateKeys.revise('c1')),
      leave(homes[4]!, stateKeys.sort('c1')),
    ];
    const kept = [leave(homes[0]!, stateKeys.member('c2', 'a')), leave(homes[0]!, stateKeys.member('c10', 'a'))];
    removeConversationState(homes, 'c1', ['a', 'b']);
    for (const dir of gone) expect(existsSync(dir), dir).toBe(false);
    for (const dir of kept) expect(existsSync(dir), dir).toBe(true);
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('empties a state folder whatever the run did to it, and never touches what a link in it points to', () => {
    const home = homes[0]!;
    const dir = leave(home, stateKeys.member('c4', 'a'));
    // A folder the run made unreadable, one with a read-only file, and links to a folder and a file outside.
    mkdirSync(join(dir, 'locked', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'locked', 'deeper', 'f'), 'x');
    chmodSync(join(dir, 'locked'), 0o000);
    mkdirSync(join(dir, 'ro'));
    writeFileSync(join(dir, 'ro', 'file'), 'x', { mode: 0o444 });
    chmodSync(join(dir, 'ro'), 0o555);
    const outside = join(root, 'outside-state');
    mkdirSync(join(outside, 'sub'), { recursive: true });
    writeFileSync(join(outside, 'keep'), 'keep');
    chmodSync(join(outside, 'sub'), 0o500);
    symlinkSync(outside, join(dir, 'to-outside'));
    symlinkSync(join(outside, 'keep'), join(dir, 'to-file'));
    chmodSync(dir, 0o000); // the state folder itself too
    try {
      emptyStateFolder(home, stateKeys.member('c4', 'a'));
      // Gone: the next run starts with a new folder. While the server runs, permissions are not
      // changed (a surviving process could swap a folder for a link), so what the run locked stays
      // set aside, and the next start removes it, giving the owner's permissions back first.
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(join(home, PRIVATE_DIR)).filter((n) => n.startsWith('.gone-')).length).toBeLessThanOrEqual(1);
      clearOpenRunLeftovers([home], join(root, 'no-run-tmp'));
      expect(readdirSync(join(home, PRIVATE_DIR)).filter((n) => n.startsWith('.gone-'))).toEqual([]);
      // What the links pointed to is untouched, its permissions too.
      expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
      expect(statSync(join(outside, 'sub')).mode & 0o777).toBe(0o500);
      // A folder that is not there is nothing to empty.
      expect(() => emptyStateFolder(home, stateKeys.member('c4', 'none'))).not.toThrow();
    } finally {
      chmodSync(join(outside, 'sub'), 0o700);
    }
  });

  it.runIf(process.platform === 'darwin')('empties a state folder a run made immutable (chflags uchg), now and at the next start', () => {
    const home = homes[0]!;
    const dir = leave(home, stateKeys.member('c5', 'a'));
    mkdirSync(join(dir, 'inner'));
    writeFileSync(join(dir, 'inner', 'f'), 'x');
    spawnSync('/usr/bin/chflags', ['uchg', join(dir, 'inner', 'f')]);
    spawnSync('/usr/bin/chflags', ['uchg', dir]);
    try {
      emptyStateFolder(home, stateKeys.member('c5', 'a'));
      expect(existsSync(dir)).toBe(false);
      // What stays aside (the immutable file) goes at the next start.
      clearOpenRunLeftovers([home], join(root, 'no-run-tmp'));
      expect(readdirSync(join(home, PRIVATE_DIR)).filter((n) => n.startsWith('.gone-'))).toEqual([]);
    } finally {
      spawnSync('/usr/bin/chflags', ['-R', 'nouchg', join(home, PRIVATE_DIR)]);
    }
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')("clears at start what runs of a stopped server left: run temp folders and keyless runs' state, not a key's", () => {
    const runTmp = join(root, 'left-run-tmp');
    mkdirSync(join(runTmp, 'opencode-1a2b'), { recursive: true });
    const keyless = join(homes[1]!, PRIVATE_DIR, 'run-0123abcd');
    mkdirSync(keyless, { recursive: true });
    const keyed = leave(homes[1]!, stateKeys.member('c3', 'a'));
    const probe = join(homes[1]!, PRIVATE_DIR, PROBE_STATE);
    mkdirSync(probe, { recursive: true });
    // A folder set aside to be removed that could not be (its run had locked a folder in it).
    const aside = join(homes[1]!, PRIVATE_DIR, '.gone-0123abcd');
    mkdirSync(join(aside, 'locked'), { recursive: true });
    writeFileSync(join(aside, 'locked', 'f'), 'x');
    chmodSync(join(aside, 'locked'), 0o000);
    // While something a stopped run left may still be running, no permission is given back: what it
    // locked stays for a later start, and the rest goes.
    clearOpenRunLeftovers([...homes, join(root, 'no-such-home')], runTmp, { restore: false });
    expect(readdirSync(runTmp)).toEqual([]);
    expect(existsSync(keyless)).toBe(false);
    expect(statSync(join(aside, 'locked')).mode & 0o777).toBe(0o000);
    mkdirSync(join(runTmp, 'opencode-1a2b'), { recursive: true });
    clearOpenRunLeftovers([...homes, join(root, 'no-such-home')], runTmp);
    expect(readdirSync(runTmp)).toEqual([]);
    expect(existsSync(keyless)).toBe(false);
    expect(existsSync(aside)).toBe(false);
    expect([existsSync(keyed), existsSync(probe)]).toEqual([true, true]);
  });
});

describe('a tool library exception for an open agent’s memory', () => {
  it('is kept for every CLI, and dropped for an unknown one', () => {
    const [member] = validateAgents([{ name: 'Pia', provider: 'pi', role: '', tools: { 'memory:pi': true, 'memory:opencode': false, 'memory:gemini': true, memory: false } }]);
    expect(member!.tools).toEqual({ 'memory:pi': true, 'memory:opencode': false, memory: false });
  });
});

describe('the approval card of a tool with no command, file or URL (an MCP tool)', () => {
  it('shows what the tool is given, and says in read-only that the sandbox still holds', () => {
    const card = (rawInput: Record<string, unknown>, permission: 'read-only' | 'edit' = 'edit') =>
      acpApprovalRequest(acpCallInfo({ kind: 'other', title: 'github__create_issue', rawInput }), permission);
    // Its usual fields first, a path whole.
    expect(card({ query: 'is:open label:bug' })).toEqual({ kind: 'other', tool: 'github__create_issue', detail: 'is:open label:bug', reason: 'github__create_issue' });
    // Else its input as JSON, shortened.
    expect(card({ repo: 'acme/web', title: 'Crash on start', labels: ['bug'] }).detail).toBe('{"repo":"acme/web","title":"Crash on start","labels":["bug"]}');
    expect(inputDetail({ body: 'x'.repeat(1000) })!.length).toBeLessThanOrEqual(300);
    // Nothing given: nothing shown.
    expect(card({})).not.toHaveProperty('detail');
    // In read-only its server runs in the relay sandbox too: a write it tries fails all the same.
    expect(card({ repo: 'acme/web' }, 'read-only')).toMatchObject({ kind: 'other', readOnlySandbox: true });
  });
});
