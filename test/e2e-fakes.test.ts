import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FACTS } from '../e2e/support/clis/all';
import { bundleFakeCli, DEFAULT_CLIS, IMPLEMENTED_FAKES, NOT_YET_FAKED, notInstalledBut, writeFakeLaunchers } from '../e2e/support/fake-cli';
import { FAKE_CLI_DIR } from '../e2e/support/paths';
import { DATA_DIR_MAX } from '../e2e/support/relay';
import { hostTmpRefusal } from '../src/server/relaySandbox';
import { windowsLaunch, type LaunchFs } from '../src/server/winLaunch';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '../src/shared/types';
import { slow } from './timeouts';

// The end-to-end tests' fake CLIs (e2e/fake-cli/), bundled as e2e/support/fake-cli.ts bundles them and
// run as each CLI by its file name (`claude.cjs`, `cursor-agent.cjs`): a module that does not load
// shows here, before an end-to-end run. They run with this Node, so on every system alike.

/** What every fake module exports (`agents/<provider>.cjs`). */
interface FakeModule {
  provider: string;
  bin: string;
  aliases?: string[];
  label: string;
  name: string;
  version: string;
  versionRe: RegExp;
  home(env: NodeJS.ProcessEnv, args: string[]): string;
  apiKey(env: NodeJS.ProcessEnv): 'expected' | 'other' | null;
  main(args: string[]): void;
}

const load = createRequire(import.meta.url);
const fakeModule = (p: Provider) => load(join(FAKE_CLI_DIR, 'agents', `${p}.cjs`)) as FakeModule;

let dir = '';
/** A fake's script, named as `name` runs it. */
const script = (name: string) => join(dir, `${name}.cjs`);
/** Runs the fake named `name`; `env` replaces the fakes' own variables of the test's environment. */
const run = (name: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', env: { ...withoutFakeVars(process.env), ...env }, timeout: slow(15_000) });

/** Runs it without waiting (this process's own servers answer it meanwhile): its exit code and output. */
function runAsync(name: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script(name), ...args], { env: { ...withoutFakeVars(process.env), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

function withoutFakeVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('E2E_') && k !== 'CURSOR_INVOKED_AS') out[k] = v;
  return out;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-fakes-'));
  const bundle = bundleFakeCli();
  for (const p of PROVIDERS) writeFileSync(script(FACTS[p].bin), bundle);
  writeFileSync(script('nobody'), bundle);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the fake CLIs', () => {
  it('are a module for each CLI, named and labelled as Harness Relay and the tests name it', () => {
    expect([...IMPLEMENTED_FAKES, ...NOT_YET_FAKED].sort()).toEqual([...PROVIDERS].sort());
    for (const p of PROVIDERS) {
      const m = fakeModule(p);
      expect(m.provider).toBe(p);
      expect(m.bin).toBe(FACTS[p].bin);
      expect(m.label).toBe(PROVIDER_LABEL[p]);
      expect(FACTS[p].label).toBe(PROVIDER_LABEL[p]);
      expect(m.name).toBe(FACTS[p].name);
      // A valid @mention, as the fake lead agent names its members.
      expect(m.name).toMatch(/^[A-Za-z0-9_-]+$/);
      for (const f of ['home', 'apiKey', 'main'] as const) expect(typeof m[f]).toBe('function');
      // What Settings shows: `v` and the version Harness Relay reads from `--version` (`parseVersion`).
      expect(`v${/\d+\.\d+\.\d+[\w.-]*/.exec(m.version)?.[0].replace(/[.-]+$/, '')}`).toBe(FACTS[p].version);
      expect(m.versionRe.test(m.version)).toBe(true);
    }
  });

  it("run each CLI's own tests on Linux, and name no system the tests do not run on", () => {
    for (const p of PROVIDERS) {
      expect(FACTS[p].testedOn, p).toContain('linux');
      for (const s of FACTS[p].testedOn) expect(['linux', 'darwin', 'win32'], p).toContain(s);
      expect(new Set(FACTS[p].testedOn).size, p).toBe(FACTS[p].testedOn.length);
    }
  });

  it('are installed in a test server as Claude Code, Codex and Grok, and the CLIs a test names', () => {
    expect(DEFAULT_CLIS).toEqual(['claude', 'codex', 'grok']);
    const installed = (missing: readonly Provider[]) => PROVIDERS.filter((p) => !missing.includes(p));
    expect(installed(notInstalledBut())).toEqual(DEFAULT_CLIS.filter((p) => !NOT_YET_FAKED.includes(p)));
    expect(installed(notInstalledBut(['cursor', 'pi']))).toEqual(PROVIDERS.filter((p) => ['claude', 'codex', 'grok', 'cursor', 'pi'].includes(p) && !NOT_YET_FAKED.includes(p)));
    // A CLI whose fake is not written is never installed, named or not.
    for (const p of NOT_YET_FAKED) expect(notInstalledBut([p])).toContain(p);
  });

  it('stream a slow reply over about ten seconds, or the seconds `e2e:slow=` gives', () => {
    const plan = load(join(FAKE_CLI_DIR, 'lib', 'plan.cjs')) as { slowMs(v: unknown): number; pieceDelay(slow: number): number; pieces(text: string, slow: number): string[] };
    expect(plan.slowMs(undefined)).toBe(0);
    expect(plan.slowMs(true)).toBe(10_000);
    expect(plan.slowMs('5')).toBe(5_000);
    expect(plan.slowMs('0.5')).toBe(500);
    expect(plan.slowMs('soon')).toBe(10_000);
    const ms = plan.slowMs('5');
    expect(plan.pieces('Hello', ms).length * plan.pieceDelay(ms)).toBe(5_000);
    expect(plan.pieceDelay(0)).toBe(15);
  });

  it.each(IMPLEMENTED_FAKES.map((p) => [p]))('%s answers --version as its module says', (p) => {
    const r = run(FACTS[p].bin, ['--version']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(fakeModule(p).versionRe);
    expect(r.stdout).toContain(FACTS[p].version.slice(1));
  });

  it.each(NOT_YET_FAKED.map((p) => [p]))('%s says it is not written yet, and exits with code 2', (p) => {
    for (const args of [['--version'], ['acp']]) {
      const r = run(FACTS[p].bin, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`fake ${p}: not implemented yet`);
      expect(r.stdout).toBe('');
    }
  });

  it('refuses to run under a name that is no CLI', () => {
    const r = run('nobody', ['--version']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/run me as claude, codex, grok, cursor-agent, agy, .* \(not nobody\)/);
  });

  it("logs each start by the CLI's provider id, with its home", () => {
    const log = join(dir, 'start.jsonl');
    const home = join(dir, 'claude-home');
    const r = run('claude', ['--version'], { E2E_FAKE_LOG: log, CLAUDE_CONFIG_DIR: home });
    expect(r.status).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ cli: 'claude', args: ['--version'], home, apiKey: null })]);
    expect(lines[0]!.sandboxed).toBeUndefined();
  });

  it("names the lead agent's members of every CLI as the tests do", async () => {
    const question = 'Who answers? e2e:team=claude,cursor,opencode,openhands,nobody';
    const prompt = `Reply with only one of these JSON objects.\n<question>\n${question}\n</question>`;
    const r = await runAsync('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], {}, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    expect(r.code, r.stderr).toBe(0);
    const result = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; result?: string })
      .find((m) => m.type === 'result');
    const team = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result!.result!)![1]!) as { agents: { name: string; provider: string }[] };
    expect(team.agents.map((a) => [a.name, a.provider])).toEqual([
      ['Claude', 'claude'],
      ['Cursor', 'cursor'],
      ['OpenCode', 'opencode'],
      ['OpenHands', 'openhands'],
    ]);
  });

  describe('where the log file may not be written, as in Harness Relay’s own sandbox', () => {
    let server: Server;
    const got: Record<string, unknown>[] = [];
    let url = '';
    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (d: Buffer) => (body += d.toString('utf8')));
        req.on('end', () => {
          got.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/e2e-log`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    // A folder it may not write in: the permission bits, which Windows does not have, and which root ignores.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('sends its lines to the fake endpoint, and waits for them before it exits', async () => {
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        const r = await runAsync('codex', ['--version'], { E2E_FAKE_LOG: join(locked, 'fake-cli.jsonl'), E2E_FAKE_LOG_URL: url, CODEX_HOME: join(dir, 'codex-home') });
        expect(r.code, r.stderr).toBe(0);
        expect(existsSync(join(locked, 'fake-cli.jsonl'))).toBe(false);
        expect(got).toEqual([expect.objectContaining({ cli: 'codex', args: ['--version'], sandboxed: true })]);
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  });
});

describe("the fakes as launchers start them on Windows (e2e/specs/windows.spec.ts)", () => {
  // The launchers' folder seen as Windows sees it, at C:\e2e: Harness Relay's own reading of a
  // launcher (winLaunch.ts) says what it would start, which then runs here with this Node.
  const WIN = 'C:\\e2e';
  let folder = '';
  let bins: ReturnType<typeof writeFakeLaunchers>;
  const local = (p: string) => join(folder, ...p.slice(WIN.length + 1).split('\\'));
  const win = (p: string) => `${WIN}\\${p.slice(folder.length + 1).split(/[\\/]/).join('\\')}`;
  const stat = (p: string) => {
    try {
      return p.startsWith(`${WIN}\\`) ? statSync(local(p)) : undefined;
    } catch {
      return undefined;
    }
  };
  const fs: LaunchFs = {
    isFile: (p) => Boolean(stat(p)?.isFile()),
    isDir: (p) => Boolean(stat(p)?.isDirectory()),
    read: (p) => (stat(p)?.isFile() ? readFileSync(local(p), 'utf8') : undefined),
    list: (p) => (stat(p)?.isDirectory() ? readdirSync(local(p)) : []),
  };
  const env = (dir: string) => ({ PATH: `${WIN}\\${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

  beforeAll(() => {
    folder = join(dir, 'launchers');
    writeFileSync(join(dir, 'node.exe'), 'a stand-in for node.exe');
    writeFileSync(join(dir, 'opencode.exe'), 'a stand-in for the fakes’ executable');
    bins = writeFakeLaunchers(folder, { script: bundleFakeCli(), node: join(dir, 'node.exe'), program: join(dir, 'opencode.exe') });
  });

  /** What running the script `args[0]` as Harness Relay would says it is: its version, or that its fake is not written yet. */
  function says(p: Provider, args: string[], extra: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [local(args[0]!), ...args.slice(1)], { encoding: 'utf8', env: { ...withoutFakeVars(process.env), ...extra }, timeout: slow(15_000) });
    if (FACTS[p].implemented) expect(r.stdout).toMatch(fakeModule(p).versionRe);
    else expect(r.stderr).toContain(`fake ${p}: not implemented yet`);
  }

  it("starts Cursor's launcher as its Node and its script, which runs as Cursor", () => {
    expect(win(bins.cursor)).toBe(`${WIN}\\cursor\\cursor-agent.cmd`);
    const launch = windowsLaunch('cursor-agent', ['--version'], env('cursor'), fs, null);
    const version = `${WIN}\\cursor\\versions\\2026.11.11-e2e0001`;
    expect(launch).toEqual({ file: `${version}\\node.exe`, args: [`${version}\\index.js`, '--version'], env: { CURSOR_INVOKED_AS: 'cursor-agent.cmd' } });
    says('cursor', launch.args, launch.env);
  });

  it("starts Muse Code's launcher as the binary its .muse-version names, which runs as Muse Code", () => {
    expect(win(bins.muse)).toBe(`${WIN}\\muse\\muse.cmd`);
    const launch = windowsLaunch('muse', ['--version'], env('muse'), fs, null);
    expect(launch).toEqual({ file: `${WIN}\\muse\\muse-bin-1.4.999-R1.exe`, args: ['--version'] });
    expect(readFileSync(local(launch.file), 'utf8')).toBe('a stand-in for the fakes’ executable');
    // The fakes' executable under that name is Muse Code's fake.
    writeFileSync(script('muse-bin-1.4.999-R1'), bundleFakeCli());
    const r = run('muse-bin-1.4.999-R1', ['--version']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(fakeModule('muse').versionRe);
  });

  it.each([['cline'], ['pi']] as const)("starts %s's npm shim as the PATH's Node with its script", (p) => {
    const launch = windowsLaunch(p, ['--version'], env('npm'), fs, 'C:\\relay\\node.exe');
    expect(launch).toEqual({ file: 'C:\\relay\\node.exe', args: [`${WIN}\\npm\\node_modules\\${p}\\${p}.cjs`, '--version'] });
    says(p, launch.args);
  });

  it("starts OpenCode's npm shim as the program it names, the fakes' executable", () => {
    const launch = windowsLaunch('opencode', ['--version'], env('npm'), fs, null);
    expect(launch).toEqual({ file: `${WIN}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe`, args: ['--version'] });
    expect(readFileSync(local(launch.file), 'utf8')).toBe('a stand-in for the fakes’ executable');
  });
});

describe("the e2e servers' data folders", () => {
  it("fit Harness Relay's own sandbox's sockets, as the server counts them", () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const max = DATA_DIR_MAX[platform]!;
      const path = (bytes: number) => '/' + 'd'.repeat(bytes - 1);
      expect(hostTmpRefusal(path(max), platform)).toBeUndefined();
      expect(hostTmpRefusal(path(max + 1), platform)).toBeDefined();
    }
  });
});
