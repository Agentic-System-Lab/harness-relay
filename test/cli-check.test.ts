import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTES_SOURCES,
  notesFromMarkdown,
  notesFromReleases,
  notesFromText,
  pickLines,
  releaseNotes,
} from '../scripts/cli-check/changelog';
import { SHAPES_DIR, liveCommands } from '../scripts/cli-check/layers';
import {
  MUSE_MODEL,
  callsOf,
  decide,
  marker,
  scenarioOf,
  shellArgs,
  shellTool,
  startModel,
  toolsOf,
  type ScriptedModel,
} from '../scripts/cli-check/model';
import { HELP_ARGS } from '../scripts/cli-check/probe';
import { NO_RUN, SCENARIOS } from '../scripts/cli-check/scenarios';
import { cliEnv } from '../scripts/cli-check/scratch';
import {
  describeDiff,
  diffShapes,
  flagsIn,
  flagsOf,
  kindsOf,
  memoryRecorder,
  messagesOf,
  pathsOf,
  sameShape,
  shapeOf,
  type Shape,
} from '../scripts/cli-check/shape';
import {
  VERSION_SOURCES,
  compareVersions,
  fetchLatest,
  githubRepo,
  issueBody,
  issueMarker,
  latestFrom,
  normalizeVersion,
  npmName,
  parseMarker,
  planIssues,
  sourceUrl,
  versionStatus,
  versionTable,
  type VersionRow,
} from '../scripts/cli-check/versions';
import { CLI_RECIPES } from '../src/server/cliInstall';
import { CHECKED_VERSIONS } from '../src/shared/cliVersions';
import { PROVIDERS, isOpenProvider, type Provider } from '../src/shared/types';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** A fetch that answers each address from a table, and keeps what it was asked. */
function fakeFetch(answers: Record<string, { status?: number; body: string }>) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const a = answers[url];
    return new Response(a?.body ?? 'not here', { status: a ? (a.status ?? 200) : 404 });
  };
  return { f, asked };
}

describe('the versions checked (src/shared/cliVersions.ts)', () => {
  it('has one for every CLI', () => {
    expect(Object.keys(CHECKED_VERSIONS).sort()).toEqual([...PROVIDERS].sort());
  });

  it('is what Settings installs for the open agents, whose versions are pinned', () => {
    for (const p of PROVIDERS.filter(isOpenProvider)) {
      const r = CLI_RECIPES[p];
      const pinned = r.method === 'script' ? JSON.stringify(r.posix?.env?.('/x')) : r.package;
      expect(pinned, p).toContain(CHECKED_VERSIONS[p]);
    }
  });

  it('is what the user guide says each CLI was checked with, in both languages', () => {
    const commands: Record<Provider, string> = {
      claude: 'claude',
      codex: 'codex',
      grok: 'grok',
      cursor: 'cursor-agent',
      antigravity: 'agy',
      copilot: 'copilot',
      muse: 'muse',
      opencode: 'opencode',
      goose: 'goose',
      cline: 'cline',
      openhands: 'openhands',
      pi: 'pi',
    };
    for (const doc of ['docs/user-guide.md', 'docs/user-guide.zh-TW.md']) {
      const lines = read(doc).split('\n');
      for (const p of PROVIDERS) {
        // The CLI's line in "Installing the agent CLIs": a list item or a table row naming its command.
        const line = lines.find((l) => /^(- \[|\| \[)/.test(l) && new RegExp(`[（(]\`${commands[p]}\``).test(l));
        expect(line, `${doc}: ${p}`).toBeDefined();
        expect(line, `${doc}: ${p}`).toContain(CHECKED_VERSIONS[p]);
      }
    }
  });

  it('is the version each saved shape was recorded with', () => {
    for (const p of PROVIDERS) {
      for (const layer of ['probe', 'run']) {
        const f = join(SHAPES_DIR, p, `${layer}.json`);
        if (!existsSync(f)) continue;
        expect(JSON.parse(readFileSync(f, 'utf8')).version, `${p} ${layer}`).toBe(CHECKED_VERSIONS[p]);
      }
    }
  });

  it('saves shapes only for known CLIs and layers', () => {
    for (const p of readdirSync(SHAPES_DIR)) {
      expect(PROVIDERS as readonly string[]).toContain(p);
      for (const f of readdirSync(join(SHAPES_DIR, p))) expect(['probe.json', 'run.json']).toContain(f);
    }
  });
});

describe('layer 1: the newest versions', () => {
  it('reads each kind of source as its maker publishes it', () => {
    expect(latestFrom(VERSION_SOURCES.claude, JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.327' }))).toBe('2.1.327');
    expect(latestFrom(VERSION_SOURCES.openhands, JSON.stringify({ info: { version: '1.16.0' } }))).toBe('1.16.0');
    expect(latestFrom(VERSION_SOURCES.goose, JSON.stringify({ tag_name: 'v1.60.1', prerelease: false }))).toBe('1.60.1');
    expect(latestFrom(VERSION_SOURCES.goose, JSON.stringify({ tag_name: 'v1.61.0', prerelease: true }))).toBeUndefined();
    expect(latestFrom(VERSION_SOURCES.grok, '1.0.88\n')).toBe('1.0.88');
    const cursorScript = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.17-f532c45/${OS}/${ARCH}/agent-cli-package.tar.gz"';
    expect(latestFrom(VERSION_SOURCES.cursor, cursorScript)).toBe('2026.11.17-f532c45');
    expect(latestFrom(VERSION_SOURCES.antigravity, JSON.stringify({ version: '1.5.10', url: 'https://x', sha512: 'f1' }))).toBe('1.5.10');
    expect(latestFrom(VERSION_SOURCES.muse, JSON.stringify({ channel: 'muse-stable', version: '1.4.23-R8977.1' }))).toBe('1.4.23-R8977.1');
    expect(latestFrom(VERSION_SOURCES.claude, 'not json')).toBeUndefined();
  });

  it('encodes every name it puts in an address, a scoped npm package as npm asks for it', () => {
    expect(npmName('@anthropic-ai/claude-code')).toBe('@anthropic-ai%2Fclaude-code');
    // Every slash and anything else an address would read, not only the first slash.
    expect(npmName('@a/b/c?d#e')).toBe('@a%2Fb%2Fc%3Fd%23e');
    expect(npmName('../x')).toBe('..%2Fx');
    expect(githubRepo('aaif-goose/goose')).toBe('aaif-goose/goose');
    expect(githubRepo('a b/c?d')).toBe('a%20b/c%3Fd');
    expect(() => githubRepo('a/b/c')).toThrow('not a GitHub repository');
    expect(() => githubRepo('a')).toThrow('not a GitHub repository');
    expect(sourceUrl({ kind: 'pypi', package: 'open hands' })).toBe('https://pypi.org/pypi/open%20hands/json');
  });

  it('asks npm for a scoped package with its slash escaped', () => {
    expect(sourceUrl(VERSION_SOURCES.claude)).toBe('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');
    expect(sourceUrl(VERSION_SOURCES.openhands)).toBe('https://pypi.org/pypi/openhands/json');
    expect(sourceUrl(VERSION_SOURCES.goose)).toBe('https://api.github.com/repos/aaif-goose/goose/releases/latest');
  });

  it("writes versions as Harness Relay does: no leading v, Muse Code's without its build", () => {
    expect(normalizeVersion('goose', 'v1.60.1')).toBe('1.60.1');
    expect(normalizeVersion('muse', '1.4.23-R8977.1')).toBe('1.4.23');
    expect(normalizeVersion('cursor', '2026.11.17-f532c45')).toBe('2026.11.17-f532c45');
  });

  it('compares versions part by part, as numbers', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('0.167.0', '0.170.0')).toBeLessThan(0);
    expect(compareVersions('2026.11.17-f532c45', '2026.11.11-043ef28')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('says whether a CLI is behind', () => {
    expect(versionStatus('claude', '2.1.322', '2.1.327')).toBe('behind');
    expect(versionStatus('claude', '2.1.322', '2.1.322')).toBe('current');
    expect(versionStatus('muse', '1.4.18', '1.4.18-R8587.1')).toBe('current');
    expect(versionStatus('claude', '2.1.330', '2.1.327')).toBe('ahead');
    // Another build of the same day: neither is known to be newer, so it is checked.
    expect(versionStatus('cursor', '2026.11.11-043ef28', '2026.11.11-ffffff0')).toBe('behind');
    expect(versionStatus('claude', '2.1.322', undefined)).toBe('unknown');
  });

  it("reads a source through fetch, with GitHub's token only for GitHub, and says why one could not be read", async () => {
    const { f, asked } = fakeFetch({
      'https://api.github.com/repos/aaif-goose/goose/releases/latest': { body: JSON.stringify({ tag_name: 'v1.60.1' }) },
      'https://registry.npmjs.org/cline/latest': { body: JSON.stringify({ version: '3.0.75' }) },
      'https://pypi.org/pypi/openhands/json': { status: 503, body: 'down' },
    });
    const env = { GITHUB_TOKEN: 'tok' };
    expect(await fetchLatest('goose', f, env)).toEqual({ latest: '1.60.1' });
    expect(await fetchLatest('cline', f, env)).toEqual({ latest: '3.0.75' });
    expect((await fetchLatest('openhands', f, env)).error).toContain('HTTP 503');
    expect(asked[0]!.headers.authorization).toBe('Bearer tok');
    expect(asked[1]!.headers.authorization).toBeUndefined();
  });

  it('prints the rows as a table', () => {
    const rows: VersionRow[] = [
      { provider: 'claude', checked: '2.1.322', latest: '2.1.327', installed: '2.1.327', status: 'behind' },
      { provider: 'cline', checked: '3.0.74', latest: '3.0.74', status: 'current' },
      { provider: 'muse', checked: '1.4.18', error: 'HTTP 500', status: 'unknown' },
    ];
    const t = versionTable(rows).split('\n');
    expect(t[0]).toMatch(/^CLI\s+checked\s+newest\s+here\s+status$/);
    expect(t[1]).toMatch(/^Claude Code\s+2\.1\.322\s+2\.1\.327\s+2\.1\.327\s+behind$/);
    expect(t[2]).toMatch(/^Cline\s+3\.0\.74\s+3\.0\.74\s+-\s+current$/);
    expect(t[3]).toContain('unknown (HTTP 500)');
  });
});

describe("layer 1: the CLI versions workflow's issues", () => {
  const behind = (p: Provider, latest: string): VersionRow => ({ provider: p, checked: CHECKED_VERSIONS[p], latest, status: 'behind' });
  const issue = (number: number, p: Provider, latest: string) => ({ number, title: `Check ${p}`, body: `text\n${issueMarker(p, latest)}` });

  it('marks its issues with the CLI and the version they tell of', () => {
    expect(parseMarker(issueMarker('copilot', '1.0.113'))).toEqual({ provider: 'copilot', latest: '1.0.113' });
    expect(parseMarker('<!-- cli-check provider=nobody latest=1 -->')).toBeUndefined();
    const body = issueBody(behind('claude', '2.1.327'));
    expect(body).toContain('npx tsx scripts/cli-check.ts claude --bin');
    expect(body).toContain(CHECKED_VERSIONS.claude);
    expect(parseMarker(body)).toEqual({ provider: 'claude', latest: '2.1.327' });
  });

  it('opens one for a CLI that is behind and has none', () => {
    const actions = planIssues([behind('claude', '2.1.327')], []);
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'create',
        provider: 'claude',
        title: `Check Claude Code 2.1.327 (checked with ${CHECKED_VERSIONS.claude})`,
      }),
    ]);
  });

  it('leaves one that tells of the newest as it is, and updates one when a newer version came out', () => {
    expect(planIssues([behind('claude', '2.1.327')], [issue(7, 'claude', '2.1.327')])).toEqual([]);
    const [a] = planIssues([behind('claude', '2.1.330')], [issue(7, 'claude', '2.1.327')]);
    expect(a).toMatchObject({ kind: 'update', number: 7, title: expect.stringContaining('2.1.330') });
    expect(a!.kind === 'update' && a!.comment).toContain('2.1.330 is out now');
    expect(a!.kind === 'update' && parseMarker(a!.body)?.latest).toBe('2.1.330');
  });

  it('closes it once the version checked is the newest, and closes a second one for the same CLI', () => {
    const current: VersionRow = { provider: 'claude', checked: '2.1.327', latest: '2.1.327', status: 'current' };
    expect(planIssues([current], [issue(7, 'claude', '2.1.327')])).toEqual([expect.objectContaining({ kind: 'close', number: 7 })]);
    const actions = planIssues([behind('codex', '0.170.0')], [issue(9, 'codex', '0.170.0'), issue(12, 'codex', '0.170.0')]);
    expect(actions).toEqual([expect.objectContaining({ kind: 'close', number: 12, comment: 'Kept in #9.' })]);
  });

  it("leaves a CLI whose source could not be read, and issues that are not the workflow's", () => {
    const unknown: VersionRow = { provider: 'grok', checked: '1.0.77', error: 'HTTP 500', status: 'unknown' };
    expect(planIssues([unknown], [issue(3, 'grok', '1.0.88'), { number: 4, title: 'Something else', body: 'no marker' }])).toEqual([]);
  });

  it('runs daily on this repository only, reading versions and writing issues, and starts no CLI', () => {
    const wf = read('.github/workflows/cli-versions.yml');
    expect(wf).toMatch(/schedule:\s*\n\s*#.*\n\s*- cron: /);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toContain("if: github.repository == 'Agentic-System-Lab/harness-relay'");
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
    expect(wf).toContain('npx tsx scripts/cli-check.ts versions --issues');
  });
});

describe('the shapes of what a CLI says (scripts/cli-check/shape.ts)', () => {
  it('reads JSON lines and Content-Length frames, and passes over text', () => {
    expect(messagesOf('{"a":1}\nnot json\n  {"b":2}\n[1]\n')).toEqual([{ a: 1 }, { b: 2 }]);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { é: 'ü' } });
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}Content-Length: 2\r\n\r\n{}`;
    expect(messagesOf(framed)).toEqual([JSON.parse(body), {}]);
  });

  it('keeps keys, value types and the words that say what a message is, never text', () => {
    const paths = [
      ...pathsOf({
        type: 'text',
        text: 'Hello there',
        n: 1,
        ok: true,
        none: null,
        list: [],
        obj: {},
        parts: [{ kind: 'edit' }],
        role: 'a long free text',
      }),
    ];
    expect(paths.sort()).toEqual(
      ['list:[]', 'n:number', 'none:null', 'obj:{}', 'ok:boolean', 'parts[].kind=edit', 'role:string', 'text:string', 'type=text'].sort(),
    );
  });

  it('keeps a map of names (sessions, files, models) as one key', () => {
    expect([...pathsOf({ models: { 'gpt-5/mini': { id: 1 }, 'claude@x': { id: 2 } } })]).toEqual(['models.*.id:number']);
    expect([...pathsOf({ permissions: { 'harness-relay-a910fda871b7f117': { extends: ':workspace' } } })]).toEqual([
      'permissions.*.extends:string',
    ]);
  });

  it('names an answer after the request it answers, from either side, and an ACP update after its kind', () => {
    const kinds = kindsOf([
      { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 1, result: {} } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 0, method: 'session/request_permission' } },
      { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 0, result: { outcome: {} } } },
      { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 2, method: 'session/load' } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 2, error: { code: -32000 } } },
    ]);
    expect(kinds).toEqual([
      'to-cli initialize',
      'from-cli initialize result',
      'from-cli session/update:agent_message_chunk',
      'from-cli session/request_permission',
      'to-cli session/request_permission result',
      'to-cli session/load',
      'from-cli session/load error',
    ]);
  });

  it("names Claude Code's control responses after the request they answer, and its messages by type and subtype", () => {
    const kinds = kindsOf([
      { dir: 'to-cli', msg: { type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } } },
      { dir: 'from-cli', msg: { type: 'system', subtype: 'init' } },
      { dir: 'from-cli', msg: { type: 'control_response', response: { subtype: 'success', request_id: 'r1' } } },
      { dir: 'from-cli', msg: { type: 'control_request', request_id: 'c1', request: { subtype: 'can_use_tool' } } },
      { dir: 'to-cli', msg: { type: 'control_response', response: { subtype: 'error', request_id: 'c1' } } },
    ]);
    expect(kinds).toEqual([
      'to-cli control_request:initialize',
      'from-cli system:init',
      'from-cli control_response:initialize',
      'from-cli control_request:can_use_tool',
      'to-cli control_response:can_use_tool:error',
    ]);
  });

  it('records processes through a recorder and gives their shape, a request before its answer', () => {
    const { recorder, spawned } = memoryRecorder();
    const r = recorder.start({ bin: 'cli', args: ['acp'] })!;
    // The answer arrives in stdout before the next request is written: streams are apart.
    r.data('stdout', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    r.data('stdin', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'));
    r.exit(0, null);
    expect(spawned[0]).toMatchObject({ bin: 'cli', args: ['acp'], exit: { code: 0, signal: null } });
    expect(shapeOf(spawned).kinds).toEqual({
      'from-cli initialize result': ['id:number', 'jsonrpc:string', 'result.protocolVersion:number'],
      'to-cli initialize': ['id:number', 'jsonrpc:string', 'method=initialize', 'params:{}'],
    });
  });

  it('says what changed between two shapes, what is gone first', () => {
    const saved: Shape = { kinds: { 'from-cli a': ['x:string', 'y:number'], 'from-cli gone': ['z:string'] }, flags: ['--acp', '--model'] };
    const now: Shape = { kinds: { 'from-cli a': ['x:number', 'y:number'], 'from-cli new': ['w:string'] }, flags: ['--acp', '--yolo'] };
    const d = diffShapes(saved, now);
    expect(sameShape(d)).toBe(false);
    expect(describeDiff(d)).toEqual([
      '- flag --model (its help no longer lists it)',
      '- from-cli gone (not seen this time)',
      '- from-cli a: x:string',
      '+ from-cli new (new)',
      '+ from-cli a: x:number',
      '+ flag --yolo',
    ]);
    expect(sameShape(diffShapes(saved, saved))).toBe(true);
  });

  it('finds the flags a help lists and an argument list passes', () => {
    expect(flagsOf('Usage: cli [options]\n  -m, --model <name>  The model\n  --acp\n  [--resume=<id>] (--no-color)\n')).toEqual([
      '--acp',
      '--model',
      '--no-color',
      '--resume',
    ]);
    expect(flagsIn(['--acp', '--model', 'x', '--sandbox=on', 'prompt'])).toEqual(['--acp', '--model', '--sandbox']);
  });
});

describe('layer 3: the scripted model (scripts/cli-check/model.ts)', () => {
  let model: ScriptedModel | undefined;
  afterEach(async () => {
    await model?.close();
    model = undefined;
  });

  const bash = {
    name: 'Bash',
    schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
  };
  const post = (path: string, body: unknown) =>
    fetch(`${model!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const events = (sse: string) =>
    sse
      .split('\n\n')
      .map((b) =>
        b
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6),
      )
      .filter((d): d is string => !!d && d !== '[DONE]')
      .map((d) => JSON.parse(d));

  it("finds each CLI's shell tool, by its name or its command parameter", () => {
    const tools = [{ name: 'read', schema: { properties: { path: {} } } }, bash];
    expect(shellTool(tools)?.name).toBe('Bash');
    expect(shellTool([{ name: 'developer__shell', schema: { properties: { command: {} } } }])?.name).toBe('developer__shell');
    expect(shellTool([{ name: 'my_runner_exec', schema: { properties: { cmd: {} } } }])?.name).toBe('my_runner_exec');
    expect(shellTool([{ name: 'read', schema: { properties: { path: {} } } }])).toBeUndefined();
  });

  it("fills a shell tool's arguments from its schema: its command, and each other one it requires", () => {
    const tool = {
      name: 'execute_bash',
      schema: {
        properties: {
          command: { type: 'array' },
          security_risk: { type: 'string', enum: ['LOW', 'HIGH'] },
          is_input: { type: 'boolean' },
          timeout_ms: { type: 'integer' },
          workdir: { type: 'string' },
          optional: { type: 'string' },
        },
        required: ['command', 'security_risk', 'is_input', 'timeout_ms', 'workdir'],
      },
    };
    expect(shellArgs(tool, 'echo hi')).toEqual({
      command: ['bash', '-lc', 'echo hi'],
      security_risk: 'LOW',
      is_input: false,
      timeout_ms: 10_000,
      workdir: '.',
    });
    // Antigravity's: its command in `CommandLine`, and how long to wait before it goes to the background.
    const agy = {
      name: 'run_command',
      schema: {
        properties: { CommandLine: { type: 'string' }, WaitMsBeforeAsync: { type: 'integer', maximum: 5000 } },
        required: ['CommandLine', 'WaitMsBeforeAsync'],
      },
    };
    expect(shellTool([agy])?.name).toBe('run_command');
    expect(shellArgs(agy, 'ls')).toEqual({ CommandLine: 'ls', WaitMsBeforeAsync: 5000 });
  });

  it("reads a request's tools and earlier tool calls in each API", () => {
    expect(toolsOf('chat', { tools: [{ type: 'function', function: { name: 'shell', parameters: { a: 1 } } }] })).toEqual([
      { name: 'shell', schema: { a: 1 } },
    ]);
    expect(
      toolsOf('responses', {
        tools: [
          { type: 'function', name: 'exec_command', parameters: {} },
          { type: 'custom', name: 'apply_patch' },
        ],
      }),
    ).toEqual([{ name: 'exec_command', schema: {} }]);
    expect(
      toolsOf('gemini', { tools: [{ functionDeclarations: [{ name: 'run_shell_command', parametersJsonSchema: { b: 2 } }] }] }),
    ).toEqual([{ name: 'run_shell_command', schema: { b: 2 } }]);
    expect(callsOf('chat', { messages: [{ role: 'assistant', tool_calls: [{}] }, { role: 'tool' }] })).toBe(1);
    expect(callsOf('responses', { input: [{ type: 'function_call' }, { type: 'function_call_output' }] })).toBe(1);
    expect(callsOf('anthropic', { messages: [{ role: 'assistant', content: [{ type: 'tool_use' }] }] })).toBe(1);
    expect(callsOf('gemini', { contents: [{ parts: [{ functionCall: {} }] }] })).toBe(0 + 1);
  });

  it('answers from the scenario the last marker names: a call first, then a reply; a request without one gets a short reply', () => {
    const scenarios = { command: { command: 'echo hi' }, reply: {} };
    expect(scenarioOf(`${marker('reply', 'aaa')} then ${marker('command', 'bbb')}`)).toEqual({ name: 'command', nonce: 'bbb' });
    expect(decide(scenarios, { scenario: { name: 'command', nonce: 'b' }, calls: 0 }, [bash])).toEqual({
      call: { name: 'Bash', args: { command: 'echo hi' } },
    });
    expect(decide(scenarios, { scenario: { name: 'command', nonce: 'b' }, calls: 1 }, [bash]).text).toBe('cli-check command b done.');
    expect(decide(scenarios, { scenario: { name: 'command', nonce: 'b' }, calls: 0 }, []).text).toContain('no shell tool');
    expect(decide(scenarios, { calls: 0 }, [bash])).toEqual({ text: 'cli-check' });
  });

  it('speaks Chat Completions, streamed: the call, then the reply once the call has its result', async () => {
    model = await startModel({ command: { command: 'echo hi', thinking: true } });
    const tools = [
      { type: 'function', function: { name: 'shell', parameters: { properties: { command: { type: 'string' } }, required: ['command'] } } },
    ];
    const first = events(
      await (
        await post('/v1/chat/completions', {
          model: 'm',
          stream: true,
          tools,
          messages: [{ role: 'user', content: marker('command', 'n1') }],
        })
      ).text(),
    );
    expect(first.map((e) => e.choices[0]?.delta).filter(Boolean)).toContainEqual({
      tool_calls: [{ index: 0, id: 'call_cli_check', type: 'function', function: { name: 'shell', arguments: '{"command":"echo hi"}' } }],
    });
    expect(first.find((e) => e.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(first.some((e) => e.choices[0]?.delta?.reasoning_content)).toBe(true);
    const second = events(
      await (
        await post('/v1/chat/completions', {
          stream: true,
          tools,
          messages: [
            { role: 'user', content: marker('command', 'n1') },
            { role: 'assistant', tool_calls: [{ id: 'c' }] },
            { role: 'tool', content: 'hi' },
          ],
        })
      ).text(),
    );
    expect(second.map((e) => e.choices[0]?.delta?.content ?? '').join('')).toBe('cli-check command n1 done.');
    expect(model.requests.map((r) => [r.api, r.calls, r.scenario?.nonce])).toEqual([
      ['chat', 0, 'n1'],
      ['chat', 1, 'n1'],
    ]);
  });

  it('speaks the Responses API and the Anthropic Messages API, streamed and not', async () => {
    model = await startModel({ command: { command: 'ls' } });
    const responses = events(
      await (
        await post('/v1/responses', {
          stream: true,
          tools: [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }],
          input: [{ role: 'user', content: [{ type: 'input_text', text: marker('command', 'r') }] }],
        })
      ).text(),
    );
    expect(responses[0].type).toBe('response.created');
    expect(responses.at(-1).type).toBe('response.completed');
    expect(responses.at(-1).response.output[0]).toMatchObject({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' });
    const anthropic = (await (
      await post('/v1/messages', {
        tools: [{ name: 'Bash', input_schema: bash.schema }],
        messages: [{ role: 'user', content: marker('command', 'a') }],
      })
    ).json()) as any;
    expect(anthropic).toMatchObject({
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
    });
    const streamed = events(
      await (await post('/v1/messages', { stream: true, messages: [{ role: 'user', content: 'title please' }] })).text(),
    );
    expect(streamed.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect((await (await post('/v1/messages/count_tokens', {})).json()) as any).toEqual({ input_tokens: 12 });
  });

  it('speaks the Gemini API, serves the model lists and catalogs, and keeps what it does not serve', async () => {
    model = await startModel({ reply: {} });
    const gem = events(
      await (
        await post(`/v1beta/models/gemini-x:streamGenerateContent?alt=sse`, {
          contents: [{ role: 'user', parts: [{ text: marker('reply', 'g') }] }],
        })
      ).text(),
    );
    expect(gem.map((e) => e.candidates[0].content.parts.map((p: any) => p.text).join('')).join('')).toBe('cli-check reply g done.');
    expect(model.requests[0]).toMatchObject({ api: 'gemini', model: 'gemini-x', stream: true });
    expect(((await (await fetch(`${model.url}/v1/models`)).json()) as any).data[0].id).toBe('cli-check-model');
    expect(((await (await fetch(`${model.url}/muse-code/models`)).json()) as any).data[0].id).toBe(MUSE_MODEL);
    expect((await fetch(`${model.url}/api/hello`, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(`${model.url}/nothing`)).status).toBe(404);
    expect(model.unknown).toEqual(['GET /nothing']);
  });
});

describe('layers 2 and 3: what they run', () => {
  it('asks every CLI for its help, and runs the scenarios on every CLI that can be put on a model of its own', () => {
    expect(Object.keys(HELP_ARGS).sort()).toEqual([...PROVIDERS].sort());
    expect(Object.keys(NO_RUN).sort()).toEqual(['cursor', 'grok']);
    expect(SCENARIOS.map((s) => s.name)).toEqual(['reply', 'command', 'read-only-write', 'outside-write', 'protected-read', 'stop']);
  });

  it('tells only Antigravity it is over SSH (Cursor refuses to start so where the keychain is out of reach)', () => {
    expect(cliEnv('antigravity', {}).SSH_CONNECTION).toBeTruthy();
    expect(cliEnv('cursor', {}).SSH_CONNECTION).toBeUndefined();
  });

  it("names the live tests' commands, with the cloud ones for the CLIs that have models of their own", () => {
    expect(liveCommands('opencode')).toHaveLength(1);
    expect(liveCommands('claude')[1]).toContain('E2E_LIVE_CLOUD=1');
  });
});

describe('layer 4: release notes (scripts/cli-check/changelog.ts)', () => {
  it('has a source, or says where they are, for every CLI', () => {
    expect(Object.keys(NOTES_SOURCES).sort()).toEqual([...PROVIDERS].sort());
  });

  it("reads a CHANGELOG.md's versions after the one checked, up to the new one, newest first", () => {
    const md = '# Changelog\n\n## [Unreleased]\n- later\n\n## [1.5.3] - x\n- three\n\n## [1.5.2] - x\n- two\n\n## [1.5.1] - x\n- one\n';
    expect(notesFromMarkdown(md, /^## \[(\d+\.\d+\.\d+)\]/, '1.5.1', '1.5.2')).toEqual([{ version: '1.5.2', lines: ['- two'] }]);
    expect(notesFromMarkdown(md, /^## \[(\d+\.\d+\.\d+)\]/, '1.5.1').map((n) => n.version)).toEqual(['1.5.3', '1.5.2']);
  });

  it("reads GitHub's releases, leaving prereleases and other tags out", () => {
    const releases = [
      { tag_name: 'rust-v0.170.0', body: 'a\nb' },
      { tag_name: 'rust-v0.170.0-alpha.4', body: 'x', prerelease: true },
      { tag_name: 'rust-v0.169.1', body: 'c' },
      { tag_name: 'rust-v0.167.0', body: 'old' },
      { tag_name: 'other-v9.0.0', body: 'no' },
    ];
    expect(notesFromReleases(releases, /^rust-v(\d+\.\d+\.\d+)$/, '0.167.0')).toEqual([
      { version: '0.170.0', lines: ['a', 'b'] },
      { version: '0.169.1', lines: ['c'] },
    ]);
  });

  it('reads the notes a CLI prints itself', () => {
    expect(notesFromText('1.5.10\n- new sandbox flag\n\n1.5.6\n- old\n', '1.5.6')).toEqual([
      { version: '1.5.10', lines: ['- new sandbox flag'] },
    ]);
  });

  it('picks out the lines about how it runs, those about permissions, sandboxes, hooks and flags first', () => {
    const { strong, weak } = pickLines([
      '### Fixed',
      '- Fixed the sandbox letting a command write outside',
      '- Added `--yolo`',
      '- Reads `COPILOT_HOME` now',
      '- Sessions resume faster',
      '- Nicer colours',
    ]);
    expect(strong).toEqual(['- Fixed the sandbox letting a command write outside', '- Added `--yolo`', '- Reads `COPILOT_HOME` now']);
    expect(weak).toEqual(['- Sessions resume faster']);
  });

  it('prints them for the versions since the one checked, and says where they are for a CLI that publishes none it can read', async () => {
    const url = 'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md';
    const { f } = fakeFetch({ [url]: { body: '## [1.5.2] - x\n- Sessions now resume with `--fork`\n- Nicer\n## [1.5.1] - x\n- old\n' } });
    const lines = await releaseNotes('pi', '1.5.1', undefined, undefined, f);
    expect(lines[0]).toMatch(/^1\.5\.2: 1 lines about permissions.*0 about settings.*\(of 2\)$/);
    expect(lines[1]).toBe('  ! - Sessions now resume with `--fork`');
    expect(await releaseNotes('grok', '1.0.77', undefined, undefined, f)).toEqual([
      expect.stringMatching(/^release notes: no release notes are published/),
    ]);
  });
});
