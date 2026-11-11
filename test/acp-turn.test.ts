import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalAnswer, Permission } from '../src/shared/types';
import {
  ACP_REFUSAL_NOTE,
  acpApprovalRequest,
  acpBriefing,
  acpCallInfo,
  acpMcpServers,
  acpPermissionDecision,
  acpPrompt,
  acpTurn,
  acpUsage,
  answerAcpPermission,
  createAcpUpdateHandler,
  defaultAcpDeps,
  type AcpAgentSpec,
  type AcpTurnDeps,
} from '../src/server/agents/acpTurn';
import { startOpenProcess } from '../src/server/agents/open';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type McpServerSpec, type RunOptions } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';
import type { RelaySandboxCommand, RelaySandboxSpec } from '../src/server/relaySandbox';
import { OPEN_AGENT_HOME_ENV } from '../src/server/settings';
import { writeFakeAcp } from './fake-acp';

let root: string;
let bin: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-acp-'));
  bin = writeFakeAcp(join(root, 'fake-acp'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A spec for the fake agent: done, every option set through the session. */
function spec(over: Partial<AcpAgentSpec> = {}): AcpAgentSpec {
  return {
    provider: 'opencode',
    implemented: true,
    args: () => ['acp'],
    home: (home, state) => ({ env: { FAKE_HOME: home }, statePaths: [join(state, 'state')], configPaths: [join(home, 'config.json')] }),
    model: { via: 'set_model' },
    effort: { via: 'config_option' },
    briefing: 'prompt',
    ...over,
  };
}

interface Run {
  o: RunOptions;
  events: AgentEvent[];
  log: () => Record<string, any>[];
  approvals: ApprovalRequest[];
  abort: AbortController;
}

/** Options for one turn against the fake agent; `env` adds FAKE_ACP_* settings. */
function run(env: Record<string, string> = {}, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer): Run {
  const dir = join(root, `run-${++n}`);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, 'log.jsonl');
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const abort = new AbortController();
  const o: RunOptions = {
    bin,
    env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile, [OPEN_AGENT_HOME_ENV]: join(dir, 'home'), ...env },
    prompt: 'What is in a.txt?',
    systemPrompt: 'You are @Ada on a team.',
    cwd: dir,
    permission: 'full',
    model: 'openai/gpt-5.4-nano',
    signal: abort.signal,
    onEvent: (e) => events.push(e),
    backends: { apis: { openai: 'sk-test-openai-0000' }, endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['muse'] }] },
    ...(answer
      ? {
          requestApproval: async (req) => {
            approvals.push(req);
            return answer(req);
          },
        }
      : {}),
    ...over,
  };
  const log = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, any>)
      : [];
  return { o, events, log, approvals, abort };
}

const sent = (r: Run, method: string) => r.log().filter((m) => m.method === method);
const deps = (over: Partial<AcpTurnDeps> = {}): AcpTurnDeps => ({ ...defaultAcpDeps, runTmpDir: join(root, 'run-tmp'), ...over });

/** A relay sandbox that runs the command as it is, recording the spec it was given. */
function fakeSandbox(specs: RelaySandboxSpec[], disposed: string[] = [], failure?: string): Pick<AcpTurnDeps, 'sandboxAvailable' | 'sandboxCommand' | 'makeRunDirs' | 'platform'> {
  return {
    platform: 'darwin',
    sandboxAvailable: async () => ({ ok: true }),
    makeRunDirs: () => {
      const dir = mkdtempSync(join(root, 'sandbox-run-'));
      mkdirSync(join(dir, 'tmp'));
      mkdirSync(join(dir, 'host'));
      return { tmp: join(dir, 'tmp'), hostTmp: join(dir, 'host') };
    },
    sandboxCommand: async (b, args, env, s) => {
      specs.push(s);
      return {
        bin: b,
        args,
        env,
        channel: () => undefined,
        failure: () => failure,
        run: {} as RelaySandboxCommand['run'],
        // As the real sandbox does: it removes the run's folders itself.
        dispose: async () => {
          disposed.push('sandbox');
          for (const d of [s.dirs?.tmp, s.dirs?.hostTmp]) if (d) rmSync(d, { recursive: true, force: true });
        },
      };
    },
  };
}

describe('the generic ACP turn', () => {
  it('turns session updates into events, sets the model and effort, and reports usage', async () => {
    const r = run({}, { effort: 'high', model: 'openai/gpt-5.4' });
    const result = await acpTurn(r.o, spec(), deps());
    expect(result).toEqual({ sessionId: 'fake-1', inputTokens: 12, outputTokens: 34, costUsd: 0.0042 });
    expect(r.events).toEqual([
      { type: 'session', sessionId: 'fake-1' },
      { type: 'thinking', text: 'Thinking it over.' },
      { type: 'plan', entries: [{ text: 'Read the file', status: 'in_progress' }, { text: 'Answer', status: 'pending' }] },
      { type: 'tool_start', id: 't1', name: 'Read a.txt', detail: 'a.txt' },
      { type: 'tool_end', id: 't1', ok: true, output: 'file body' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'text_end' },
    ]);
    // A new session, in the working directory; the model by session/set_model, the effort by its option.
    expect(sent(r, 'session/new')[0]!.params).toMatchObject({ cwd: r.o.cwd, mcpServers: [] });
    expect(sent(r, 'session/set_model')[0]!.params).toEqual({ sessionId: 'fake-1', modelId: 'openai/gpt-5.4' });
    expect(sent(r, 'session/set_config_option')[0]!.params).toEqual({ sessionId: 'fake-1', configId: 'effort', value: 'high' });
    // The briefing goes first in the prompt when the CLI takes it there.
    const text = sent(r, 'session/prompt')[0]!.params.prompt[0].text as string;
    expect(text).toMatch(/^<harness-relay-briefing>\nYou are @Ada on a team\.\n<\/harness-relay-briefing>\n\nWhat is in a\.txt\?$/);
    // ACP's initialize: no file system or terminal of ours, Harness Relay named.
    expect(sent(r, 'initialize')[0]!.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'harness-relay' } });
  });

  it('sets only what differs, as a config option of its category, or not at all when the config sets it', async () => {
    const r = run({}, { effort: 'medium' });
    await acpTurn(r.o, spec({ model: { via: 'config_option' }, effort: { via: 'config_option' } }), deps());
    // Both are what the session has already.
    expect(sent(r, 'session/set_config_option')).toEqual([]);

    const other = run({}, { model: 'homelab/muse', effort: 'low' });
    await acpTurn(other.o, spec({ model: { via: 'config_option', id: (b) => b.model } }), deps());
    expect(sent(other, 'session/set_config_option').map((m) => m.params)).toEqual([
      { sessionId: 'fake-1', configId: 'model', value: 'muse' },
      { sessionId: 'fake-1', configId: 'effort', value: 'low' },
    ]);

    const config = run({}, { effort: 'high' });
    await acpTurn(config.o, spec({ model: { via: 'config' }, effort: { via: 'config' }, briefing: 'custom' }), deps());
    expect(sent(config, 'session/set_model')).toEqual([]);
    expect(sent(config, 'session/set_config_option')).toEqual([]);
    expect(sent(config, 'session/prompt')[0]!.params.prompt).toEqual([{ type: 'text', text: 'What is in a.txt?' }]);
  });

  it('sets the session mode for the permission, and fails with a clear message when a value is refused', async () => {
    const mode = (p: Permission) => (p === 'full' ? 'yolo' : 'ask');
    const r = run();
    await acpTurn(r.o, spec({ mode }), deps());
    expect(sent(r, 'session/set_mode')[0]!.params).toEqual({ sessionId: 'fake-1', modeId: 'yolo' });

    const refused = run({ FAKE_ACP_REJECT: 'openai/gpt-5.4' }, { model: 'openai/gpt-5.4' });
    await expect(withLang('en', () => acpTurn(refused.o, spec(), deps()))).rejects.toThrow(/OpenCode does not accept the model "openai\/gpt-5\.4": unknown model/);
  });

  it('passes the run its model backend keys and home, and the extra fields of the session', async () => {
    const r = run({ FAKE_ACP_ENV: 'OPENAI_API_KEY' });
    await acpTurn(r.o, spec({ sessionParams: (ctx, method) => ({ _meta: { method, rules: ctx.o.systemPrompt } }) }), deps());
    const start = r.log().find((m) => m.start)!;
    expect(start.argv).toEqual(['acp']);
    expect(start.env).toBe('sk-test-openai-0000');
    expect(sent(r, 'session/new')[0]!.params._meta).toEqual({ method: 'new', rules: 'You are @Ada on a team.' });
  });

  it('resumes with session/resume or session/load as the agent advertises, and ignores the replayed history', async () => {
    const resume = run({ FAKE_ACP_CAPS: JSON.stringify({ loadSession: true, sessionCapabilities: { resume: {} } }) }, { sessionId: 'old-7' });
    expect((await acpTurn(resume.o, spec(), deps())).sessionId).toBe('old-7');
    expect(sent(resume, 'session/resume')[0]!.params).toMatchObject({ sessionId: 'old-7', cwd: resume.o.cwd });
    expect(sent(resume, 'session/new')).toEqual([]);

    const load = run({ FAKE_ACP_CAPS: JSON.stringify({ loadSession: true }) }, { sessionId: 'old-8' });
    await acpTurn(load.o, spec(), deps());
    expect(sent(load, 'session/load')[0]!.params.sessionId).toBe('old-8');
    const texts = load.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['Hello ', 'world']); // not "old reply"
  });

  it("fails before saying anything when it cannot resume, so the orchestrator starts a fresh session", async () => {
    const none = run({}, { sessionId: 'old-9' });
    await expect(withLang('en', () => acpTurn(none.o, spec(), deps()))).rejects.toThrow(/offers no way to resume a session/);
    const failing = run({ FAKE_ACP_CAPS: JSON.stringify({ loadSession: true }), FAKE_ACP_RESUME_FAIL: '1' }, { sessionId: 'gone' });
    await expect(withLang('en', () => acpTurn(failing.o, spec(), deps()))).rejects.toThrow(/could not resume the earlier session: Resource not found/);
    expect(failing.events.filter((e) => e.type !== 'session')).toEqual([]);
  });

  it('asks the user about a call the permission does not cover, and hands a declined note to the model', async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' }, () => ({ allow: false, note: 'Only read it.' }));
    await withLang('en', () => acpTurn(r.o, spec({ rejection: (reason) => ({ _meta: { followup_message: reason } }) }), deps(fakeSandbox([]))));
    expect(r.approvals).toEqual([{ kind: 'edit', detail: 'a.txt', reason: 'Edit a.txt', readOnlySandbox: true }]);
    const answer = r.log().find((m) => m.id === 100 && m.result)!.result;
    expect(answer.outcome).toEqual({ outcome: 'selected', optionId: 'no' });
    expect(answer._meta.followup_message).toMatch(/^Not run: the user declined "Edit a\.txt"\. Their message: Only read it\./);
    expect(r.events).toContainEqual({ type: 'tool_end', id: 'e1', ok: false, error: 'The user declined this action. Only read it.' });
  });

  it('tells the model in the briefing what a refusal means when the agent cannot pass the reason on', async () => {
    const plain = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' });
    await acpTurn(plain.o, spec(), deps(fakeSandbox([])));
    expect(sent(plain, 'session/prompt')[0]!.params.prompt[0].text).toContain(ACP_REFUSAL_NOTE);
    const feedback = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' });
    await acpTurn(feedback.o, spec({ rejection: (reason) => ({ _meta: { followup_message: reason } }) }), deps(fakeSandbox([])));
    expect(sent(feedback, 'session/prompt')[0]!.params.prompt[0].text).not.toContain(ACP_REFUSAL_NOTE);
  });

  it('gives describeCall what the agent said of the call before it asked about it', async () => {
    const announce = JSON.stringify({ toolCallId: 'd1', title: 'Write /outside/x.txt', kind: 'edit', rawInput: { filepath: '/outside/x.txt' } });
    const ask = JSON.stringify({ toolCallId: 'd1', title: '/outside', kind: 'other', rawInput: { filepath: '/outside/x.txt', parentDir: '/outside' } });
    const r = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'edit' }, () => ({ allow: false }));
    const seen: unknown[] = [];
    const describeCall: AcpAgentSpec['describeCall'] = (call, earlier) => {
      seen.push(earlier?.kind);
      return earlier?.kind === 'edit' ? { kind: 'edit', path: String(call.rawInput?.filepath) } : {};
    };
    await acpTurn(r.o, spec({ describeCall }), deps(fakeSandbox([])));
    expect(seen).toEqual(['edit']);
    // Edit lets edits run: an edit outside the project is the sandbox's to refuse, so nothing was asked.
    expect(r.approvals).toEqual([]);
  });

  it("never does what an agent asks of the client (files, terminals): refused, or answered as its spec says", async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'client' });
    await acpTurn(r.o, spec(), deps());
    const reply = r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(reply).toContain('fs/write_text_file {"error":{"code":-32601');
    expect(reply).toContain('terminal/create {"error":{"code":-32601');
    expect(existsSync(join(r.o.cwd, 'written-by-client.txt'))).toBe(false);

    const tolerant = run({ FAKE_ACP_SCENARIO: 'client' });
    const clientRequest: AcpAgentSpec['clientRequest'] = (method) => (method === 'fs/write_text_file' ? { result: null } : undefined);
    await acpTurn(tolerant.o, spec({ clientRequest }), deps());
    const text = tolerant.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(text).toContain('fs/write_text_file null');
    expect(text).toContain('fs/read_text_file {"error"');
    expect(existsSync(join(tolerant.o.cwd, 'written-by-client.txt'))).toBe(false);
  });

  it('describes a permission request that names no call from the calls updated just before it', async () => {
    const announce = JSON.stringify({ toolCallId: 'a1', title: 'Write notes.md', kind: 'edit', rawInput: { path: 'notes.md' } });
    const ask = JSON.stringify({ toolCallId: 'confirmation-fake-1', title: 'Confirm Agent Actions', kind: 'other' });
    const r = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'read-only' }, () => ({ allow: false }));
    const turns: { sessionId?: string; cwd: string }[] = [];
    const describeCall: AcpAgentSpec['describeCall'] = (_call, _earlier, recent, turn) => {
      turns.push({ sessionId: turn.sessionId, cwd: turn.ctx.o.cwd });
      const c = recent[0];
      return c ? { kind: c.kind ?? 'other', title: c.title ?? 'tool', path: c.rawInput?.path } : {};
    };
    await acpTurn(r.o, spec({ describeCall }), deps(fakeSandbox([])));
    expect(r.approvals).toEqual([{ kind: 'edit', detail: 'notes.md', reason: 'Write notes.md', readOnlySandbox: true }]);
    // It is told the run and the session the request came in.
    expect(turns).toEqual([{ sessionId: expect.any(String), cwd: r.o.cwd }]);
  });

  it("takes the adapter's own refusal as final (the user is not asked), and shows it on the calls the request covered", async () => {
    const announce = JSON.stringify({ toolCallId: 'a1', title: 'Start a subagent', kind: 'other', rawInput: { kind: 'TaskAction' } });
    const ask = JSON.stringify({ toolCallId: 'confirmation-fake-1', title: 'Confirm Agent Actions', kind: 'other' });
    const r = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'edit' }, () => ({ allow: true }));
    const describeCall: AcpAgentSpec['describeCall'] = (_call, _earlier, recent) => ({ kind: 'other', title: recent[0]?.title ?? 'tool', tool: 'task' });
    const decide: AcpAgentSpec['decide'] = (permission, info) => (permission !== 'full' && info.tool === 'task' ? { allow: false, reason: 'no subagents', label: 'subagents are refused' } : undefined);
    await acpTurn(r.o, spec({ describeCall, decide }), deps(fakeSandbox([])));
    expect(r.approvals).toEqual([]);
    expect(r.events.find((e) => e.type === 'text')).toMatchObject({ text: expect.stringContaining('"optionId":"no"') });
    // A refusal that says `ask` goes to the user, as for a call the permission does not cover.
    const asking = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'edit' }, () => ({ allow: true }));
    await acpTurn(asking.o, spec({ describeCall, decide: () => ({ allow: false, ask: true, reason: 'not all covered', label: 'asked' }) }), deps(fakeSandbox([])));
    expect(asking.approvals).toHaveLength(1);
    expect(asking.events.find((e) => e.type === 'text')).toMatchObject({ text: expect.stringContaining('"optionId":"yes"') });
    // Left to the permission when it returns nothing: edit allows the call.
    const allowed = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'edit' }, () => ({ allow: false }));
    await acpTurn(allowed.o, spec({ describeCall, decide: () => undefined }), deps(fakeSandbox([])));
    expect(allowed.events.find((e) => e.type === 'text')).toMatchObject({ text: expect.stringContaining('"optionId":"yes"') });
  });

  it('labels each covered call by what the decision says of it, the others by its label', async () => {
    const announce = JSON.stringify({ toolCallId: 'a1', title: 'Push', kind: 'execute', rawInput: { command: 'git push' } });
    const ask = JSON.stringify({ toolCallId: 'confirmation-fake-1', title: 'Confirm Agent Actions', kind: 'other' });
    const r = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask, FAKE_ACP_END_ANNOUNCED: '1' }, { permission: 'edit' });
    const labelled: [string, string | undefined][] = [];
    const describeCall: AcpAgentSpec['describeCall'] = () => ({ kind: 'execute', title: 'Push', command: 'git push' });
    const decide: AcpAgentSpec['decide'] = () => ({ allow: false, reason: 'no', label: 'whole batch', labels: { a1: 'this one' } });
    const filterUpdate: AcpAgentSpec['filterUpdate'] = (p) => p.update;
    await acpTurn(r.o, spec({ describeCall, decide, filterUpdate }), deps(fakeSandbox([])));
    for (const e of r.events) if (e.type === 'tool_end') labelled.push([e.id, e.error]);
    expect(labelled).toEqual([['a1', 'this one']]);
  });

  it('fails a turn the agent ended without finishing it, as its spec reads it (endTurn)', async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' });
    const seen: string[] = [];
    const endTurn: AcpAgentSpec['endTurn'] = (_result, ctx, sessionId) => {
      seen.push(`${sessionId}|${ctx.o.cwd === r.o.cwd}`);
      throw new AgentRunError('it got stuck');
    };
    await expect(acpTurn(r.o, spec({ endTurn }), deps(fakeSandbox([])))).rejects.toThrow('it got stuck');
    expect(seen).toEqual([expect.stringMatching(/\|true$/)]);
    // Its tool rows still open close as not finished, not as done.
    const announce = JSON.stringify({ toolCallId: 'a1', title: 'Run a command', kind: 'execute', rawInput: { command: 'ls' } });
    const ask = JSON.stringify({ toolCallId: 'confirmation-fake-1', title: 'Confirm Agent Actions', kind: 'other' });
    const open = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'full' });
    await expect(acpTurn(open.o, spec({ endTurn }), deps(fakeSandbox([])))).rejects.toThrow('it got stuck');
    expect(open.events.filter((e) => e.type === 'tool_end')).toEqual([{ type: 'tool_end', id: 'a1', ok: false, error: expect.any(String) }]);
    // The same turn ending normally closes it as done.
    const fine = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_ANNOUNCE: announce, FAKE_ACP_CALL: ask }, { permission: 'full' });
    await acpTurn(fine.o, spec({ endTurn: () => undefined }), deps(fakeSandbox([])));
    expect(fine.events.filter((e) => e.type === 'tool_end')).toEqual([{ type: 'tool_end', id: 'a1', ok: true }]);
  });

  it('passes a refusal on with a request of the agent’s own once it is answered, and runs steps after the session starts', async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' });
    const order: string[] = [];
    const afterRefusal: AcpAgentSpec['afterRefusal'] = async (conn, refusal, ctx) => {
      order.push(`refusal ${refusal.call.toolCallId} ${String(ctx.state.run)}`);
      conn.notify('_fake/steer', { sessionId: refusal.sessionId, text: refusal.reason });
    };
    const afterSession: AcpAgentSpec['afterSession'] = async (conn, session, ctx) => {
      ctx.state.run = 'r1';
      order.push(`session ${session.method}`);
      conn.notify('_fake/system-prompt', { sessionId: session.sessionId, text: ctx.o.systemPrompt });
    };
    await acpTurn(r.o, spec({ afterRefusal, afterSession }), deps(fakeSandbox([])));
    expect(order).toEqual(['session new', 'refusal e1 r1']);
    const methods = r.log().map((m) => m.method ?? (m.id === 100 ? 'answer' : undefined)).filter(Boolean);
    expect(methods.indexOf('_fake/system-prompt')).toBeLessThan(methods.indexOf('session/prompt'));
    expect(methods.indexOf('answer')).toBeLessThan(methods.indexOf('_fake/steer'));
    // The briefing does not explain refusals to an agent that is told each reason.
    expect(sent(r, 'session/prompt')[0]!.params.prompt[0].text).not.toContain(ACP_REFUSAL_NOTE);
  });

  it('lets the spec filter each update, set variables to empty on purpose, and stop an agent that does not exit', async () => {
    const r = run({ FAKE_ACP_ENV: 'OPENAI_BASE_URL', OPENAI_BASE_URL: 'https://from-a-dotenv.example' });
    const filterUpdate: AcpAgentSpec['filterUpdate'] = ({ update }) =>
      update.sessionUpdate === 'agent_thought_chunk' ? undefined : update.sessionUpdate === 'tool_call_update' ? { ...update, status: 'failed' } : update;
    const started = Date.now();
    await acpTurn(r.o, spec({ filterUpdate, emptyEnv: ['OPENAI_BASE_URL'], exitGraceMs: 0 }), deps());
    expect(r.events.some((e) => e.type === 'thinking')).toBe(false);
    expect(r.events).toContainEqual({ type: 'tool_end', id: 't1', ok: false, error: 'file body' });
    expect(r.log().find((m) => m.start)!.env).toBe('');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('ends the rows of tool calls a stopped turn left open, as not finished', async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'hang' });
    const turn = withLang('en', () => acpTurn(r.o, spec(), deps()));
    await vi.waitFor(() => expect(r.events).toContainEqual({ type: 'text', text: 'working' }), { timeout: 5000 });
    r.abort.abort();
    await turn.catch(() => undefined);
    expect(r.events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end')).toEqual([
      { type: 'tool_start', id: 'h1', name: 'Run tests', detail: 'npm test' },
      { type: 'tool_end', id: 'h1', ok: false, error: 'Did not finish' },
    ]);
    // After a turn the agent ended itself, a row it never closed counts as done.
    const events: AgentEvent[] = [];
    const h = createAcpUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Run', kind: 'execute', status: 'in_progress' });
    h.closeOpen(true);
    expect(events.at(-1)).toEqual({ type: 'tool_end', id: 'x', ok: true });
  });

  it('says when a tool failed because the relay sandbox refused the write, never twice and never in full access', () => {
    const fail = (h: ReturnType<typeof createAcpUpdateHandler>, id: string, text: string) => {
      h.handle({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Write notes.txt', kind: 'edit', status: 'in_progress' });
      h.handle({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }] });
    };
    const events: AgentEvent[] = [];
    const note = "Harness Relay's sandbox refused it: this conversation is read-only.";
    const h = createAcpUpdateHandler((e) => events.push(e), { sandboxRefusal: () => note });
    fail(h, 'a', 'Failed to write notes.txt: Operation not permitted (os error 1)');
    fail(h, 'b', 'apply_patch failed: EPERM: operation not permitted');
    fail(h, 'c', "Harness Relay's sandbox refused it: this conversation is read-only. EPERM");
    fail(h, 'd', 'No such file or directory');
    const errors = events.filter((e) => e.type === 'tool_end').map((e) => (e as { error?: string }).error);
    expect(errors).toEqual([
      `${note} Failed to write notes.txt: Operation not permitted (os error 1)`,
      `${note} apply_patch failed: EPERM: operation not permitted`,
      "Harness Relay's sandbox refused it: this conversation is read-only. EPERM",
      'No such file or directory',
    ]);
    // Full access: no sandbox, nothing added.
    const plain: AgentEvent[] = [];
    fail(createAcpUpdateHandler((e) => plain.push(e)), 'e', 'EPERM: operation not permitted');
    expect((plain.at(-1) as { error?: string }).error).toBe('EPERM: operation not permitted');
  });

  it('runs what the user allows, and refuses on its own when the conversation does not ask', async () => {
    const allowed = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' }, () => ({ allow: true }));
    await acpTurn(allowed.o, spec(), deps(fakeSandbox([])));
    expect(allowed.log().find((m) => m.id === 100)!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(allowed.events).toContainEqual({ type: 'tool_end', id: 'e1', ok: true, output: 'done' });

    // No requestApproval: the conversation refuses automatically; no rejection hook, a plain reject_once.
    const refused = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' });
    await withLang('en', () => acpTurn(refused.o, spec(), deps(fakeSandbox([]))));
    expect(refused.log().find((m) => m.id === 100)!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(refused.events).toContainEqual({ type: 'tool_end', id: 'e1', ok: false, error: 'Not allowed in read-only mode; OpenCode was told to use tools that only read' });
  });

  it('lets edit run commands, except pushing and publishing, which ask', async () => {
    const push = JSON.stringify({ toolCallId: 'c1', title: 'git push', kind: 'execute', rawInput: { command: 'git push origin main' } });
    const r = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_CALL: push }, { permission: 'edit' }, () => ({ allow: true }));
    await acpTurn(r.o, spec(), deps(fakeSandbox([])));
    expect(r.approvals).toEqual([{ kind: 'command', detail: 'git push origin main', reason: 'git push' }]);

    const test = JSON.stringify({ toolCallId: 'c2', title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } });
    const quiet = run({ FAKE_ACP_SCENARIO: 'permission', FAKE_ACP_CALL: test }, { permission: 'edit' }, () => ({ allow: false }));
    await acpTurn(quiet.o, spec(), deps(fakeSandbox([])));
    expect(quiet.approvals).toEqual([]);
    expect(quiet.log().find((m) => m.id === 100)!.result.outcome.optionId).toBe('yes');
  });

  it('stops when the user stops it: session/cancel, then the turn ends as stopped', async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'hang' });
    const turn = acpTurn(r.o, spec(), deps());
    await vi.waitFor(() => expect(r.events).toContainEqual({ type: 'text', text: 'working' }), { timeout: 5000 });
    r.abort.abort();
    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect((err as AgentRunError).aborted).toBe(true);
    expect(sent(r, 'session/cancel')[0]!.params).toEqual({ sessionId: 'fake-1' });
  });

  it('stops at whichever step on the way to the prompt a stop comes: the prompt is never sent', async () => {
    const steps: Record<string, (stop: () => void) => { s?: Partial<AcpAgentSpec>; d?: Partial<AcpTurnDeps>; o?: Partial<RunOptions> }> = {
      'the sandbox check': (stop) => ({
        o: { permission: 'edit' },
        d: {
          ...fakeSandbox([]),
          sandboxAvailable: async () => {
            stop();
            return { ok: true };
          },
        },
      }),
      prepare: (stop) => ({ s: { prepare: async () => stop() } }),
      afterInitialize: (stop) => ({ s: { afterInitialize: async () => stop() } }),
      'session/new': (stop) => ({
        s: {
          sessionParams: () => {
            stop();
            return {};
          },
        },
      }),
      afterSession: (stop) => ({ s: { afterSession: async () => stop() } }),
      'session/set_mode': (stop) => ({
        s: {
          mode: () => {
            stop();
            return 'yolo';
          },
        },
      }),
      'session/set_model': (stop) => ({
        s: {
          model: {
            via: 'set_model',
            id: () => {
              stop();
              return 'xai/grok-4.3';
            },
          },
        },
      }),
      'session/set_config_option': (stop) => ({
        s: {
          model: {
            via: 'config_option',
            id: () => {
              stop();
              return 'xai/grok-4.3';
            },
          },
        },
      }),
    };
    for (const [step, make] of Object.entries(steps)) {
      const r = run();
      const { s, d, o } = make(() => r.abort.abort());
      const err = await acpTurn({ ...r.o, ...o }, spec(s), deps(d)).catch((e: unknown) => e);
      expect(err, step).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).aborted, step).toBe(true);
      expect(sent(r, 'session/prompt'), step).toEqual([]);
    }
  }, 30_000);

  it('answers a permission request the user was asked about as cancelled when the turn is stopped meanwhile', async () => {
    let refusals = 0;
    const r = run({ FAKE_ACP_SCENARIO: 'permission' }, { permission: 'read-only' });
    r.o.requestApproval = async () => {
      r.abort.abort(); // stopped while the card was up; the late answer is not the user's decision
      return { allow: false, note: 'no' };
    };
    const err = await acpTurn(r.o, spec({ afterRefusal: async () => void refusals++ }), deps(fakeSandbox([]))).catch((e: unknown) => e);
    expect((err as AgentRunError).aborted).toBe(true);
    expect(r.log().find((m) => m.id === 100)!.result).toEqual({ outcome: { outcome: 'cancelled' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(refusals).toBe(0);
  });

  it('fails with what the agent said when it crashes, and with its last failure when it ends the turn itself', async () => {
    const crash = run({ FAKE_ACP_SCENARIO: 'crash' });
    await expect(acpTurn(crash.o, spec(), deps())).rejects.toThrow(/panic: the fake agent fell over/);
    const self = run({ FAKE_ACP_SCENARIO: 'self-cancel' });
    await expect(withLang('en', () => acpTurn(self.o, spec(), deps()))).rejects.toThrow('OpenCode ended the turn while running "Run tests" (no terminal).');
  });

  it('times out a turn that never ends', async () => {
    const r = run({ FAKE_ACP_SCENARIO: 'silent' });
    await expect(withLang('en', () => acpTurn(r.o, spec(), deps({ timeoutMs: 1500 })))).rejects.toThrow('Timed out');
  }, 15_000);

  it('refuses a run of an adapter that is not done, and one without a usable model, before anything starts', async () => {
    const r = run();
    await expect(withLang('en', () => acpTurn(r.o, spec({ implemented: false }), deps()))).rejects.toThrow(/its adapter is not implemented yet/);
    await expect(withLang('en', () => acpTurn({ ...r.o, model: undefined }, spec(), deps()))).rejects.toThrow(/OpenCode has no model/);
    await expect(withLang('en', () => acpTurn({ ...r.o, model: 'xai/grok-4.3' }, spec(), deps()))).rejects.toThrow(/no xAI API key is set up/);
    await expect(withLang('en', () => acpTurn({ ...r.o, model: 'lab/x' }, spec(), deps()))).rejects.toThrow(/no custom endpoint with the id "lab"/);
    expect(r.log()).toEqual([]);
  });
});

describe('the open agent process', () => {
  it('runs below full access only in the relay sandbox: its folders, the protected paths and the run’s hosts', async () => {
    const specs: RelaySandboxSpec[] = [];
    const disposed: string[] = [];
    const r = run({ FAKE_ACP_ENV: 'TMPDIR' }, { permission: 'edit', model: 'homelab/muse', attachmentsDir: join(root, 'attachments'), protectedPaths: ['/secret/db'], stateKey: 'conv.c1.a1' });
    const prepared: string[] = [];
    await acpTurn(r.o, spec({ proxyEnv: { NODE_USE_ENV_PROXY: '1' }, prepare: (ctx) => void prepared.push(ctx.home.root, ctx.run.endpoint!.baseUrl) }), deps(fakeSandbox(specs, disposed)));
    const home = r.o.env[OPEN_AGENT_HOME_ENV]!;
    const tmp = r.log().find((m) => m.start)!.tmp as string;
    expect(specs).toEqual([
      {
        permission: 'edit',
        cwd: r.o.cwd,
        // The member's own state folder, and nothing else of the home.
        writable: [join(home, 'private', 'conv.c1.a1', 'state'), tmp],
        readOnly: [join(home, 'config.json')],
        privateRoots: expect.any(Array),
        protectedPaths: ['/secret/db'],
        allowedHosts: ['10.0.0.5:8000'],
        attachmentsDir: join(root, 'attachments'),
        dirs: { tmp, hostTmp: expect.any(String) },
      },
    ]);
    expect(prepared).toEqual([home, 'http://10.0.0.5:8000/v1']);
    // Each run has its own temp folder (the sandbox's), gone once the run is over.
    expect(tmp.startsWith(join(root, 'sandbox-run-'))).toBe(true);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(specs[0]!.dirs!.hostTmp)).toBe(false);
    expect(disposed).toEqual(['sandbox']);
  });

  it('hands the adapter’s sandbox opt-ins to the relay sandbox, below full access only', async () => {
    const specs: RelaySandboxSpec[] = [];
    const needs = { localPorts: [41234], allowPty: true, allowUnixSocketsInTmp: true, allowTlsTrustd: true, quietlyDeniedHosts: ['models.dev'] };
    const o = run({}, { permission: 'read-only' }).o;
    const a = await startOpenProcess(spec({ sandbox: () => needs }), o, () => [], { ...fakeSandbox(specs), runTmpDir: join(root, 'run-tmp') });
    expect(specs[0]).toMatchObject(needs);
    await a.dispose();
    const asked: string[] = [];
    const full = await startOpenProcess(spec({ sandbox: () => void asked.push('asked') as never }), { ...o, permission: 'full' }, () => [], { ...fakeSandbox(specs), runTmpDir: join(root, 'run-tmp') });
    expect(asked).toEqual([]);
    expect(full.failure()).toBeUndefined();
    await full.dispose();
  });

  it('reports why the relay sandbox stopped a run instead of the agent’s own output', async () => {
    const r = run({ FAKE_ACP_EXIT_AT_START: '1' }, { permission: 'edit' });
    await expect(acpTurn(r.o, spec(), deps(fakeSandbox([], [], 'the sandbox refused to start: no bubblewrap')))).rejects.toThrow('the sandbox refused to start: no bubblewrap');
  });

  it('gives each run its own temp folder in its environment and sets the proxy variables only in the sandbox', async () => {
    const o = run({}, { permission: 'read-only', attachmentsDir: join(root, 'attachments') }).o;
    const specs: RelaySandboxSpec[] = [];
    const a = await startOpenProcess(spec({ proxyEnv: { NODE_USE_ENV_PROXY: '1' } }), o, () => [], { ...fakeSandbox(specs), runTmpDir: join(root, 'run-tmp') });
    const b = await startOpenProcess(spec({ proxyEnv: { NODE_USE_ENV_PROXY: '1' } }), { ...o, permission: 'full' }, () => [], { ...fakeSandbox([]), runTmpDir: join(root, 'run-tmp') });
    expect(a.env.TMPDIR).not.toBe(b.env.TMPDIR);
    expect([a.env.TMP, a.env.TEMP]).toEqual([a.env.TMPDIR, a.env.TMPDIR]);
    // Sandboxed, the run's temp folder is the sandbox's own, handed to it with the spec.
    expect(specs[0]!.dirs?.tmp).toBe(a.env.TMPDIR);
    expect(specs[0]!.writable).toContain(a.env.TMPDIR);
    const sandboxTmp = a.env.TMPDIR!;
    expect(a.env.NODE_USE_ENV_PROXY).toBe('1');
    expect(b.env.NODE_USE_ENV_PROXY).toBeUndefined();
    // The attachments folder goes to the sandbox, which lets edit mode alone write it.
    expect(specs[0]!.writable).not.toContain(join(root, 'attachments'));
    expect(specs[0]!.attachmentsDir).toBe(join(root, 'attachments'));
    expect(specs[0]!.permission).toBe('read-only');
    await Promise.all([a.dispose(), b.dispose()]);
    expect(readdirSync(join(root, 'run-tmp')).filter((f) => f.startsWith('opencode-'))).toEqual([]);
    expect(existsSync(sandboxTmp)).toBe(false);
  });

  it('fails closed when the relay sandbox cannot start, and refuses native Windows below full access', async () => {
    const o = run({}, { permission: 'read-only' }).o;
    const unavailable = { ...fakeSandbox([]), sandboxAvailable: async () => ({ ok: false as const, reason: 'no bubblewrap' }) };
    // The sandbox's own reason, which says what failed and how to fix it, is passed on once, unwrapped.
    await expect(withLang('en', () => startOpenProcess(spec(), o, () => [], unavailable))).rejects.toThrow(/^no bubblewrap$/);
    await expect(withLang('en', () => startOpenProcess(spec(), o, () => [], { ...fakeSandbox([]), platform: 'win32' }))).rejects.toThrow(/On Windows/);
    // Full access needs no sandbox.
    const full = await startOpenProcess(spec(), { ...o, permission: 'full' }, () => ['acp'], { ...unavailable, runTmpDir: join(root, 'run-tmp') });
    expect(full.args).toEqual(['acp']);
    await full.dispose();
  });

  it("cleans up what the CLI left running before the run's temp folder goes, also when preparing failed; a failing cleanup is only logged", async () => {
    const o = run({}, { permission: 'edit' }).o;
    const seen: string[] = [];
    const cleanup = (ctx: { tmpDir: string }) => void seen.push(existsSync(ctx.tmpDir) ? 'tmp still there' : 'tmp gone');
    for (const permission of ['edit', 'full'] as Permission[]) {
      const p = await startOpenProcess(spec({ cleanup }), { ...o, permission }, () => [], { ...fakeSandbox([]), runTmpDir: join(root, 'run-tmp') });
      await p.dispose();
    }
    await expect(startOpenProcess(spec({ cleanup, prepare: () => { throw new Error('disk full'); } }), o, () => [], { ...fakeSandbox([]), runTmpDir: join(root, 'run-tmp') })).rejects.toThrow(/disk full/);
    expect(seen).toEqual(['tmp still there', 'tmp still there', 'tmp still there']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = await startOpenProcess(spec({ cleanup: async () => { throw new Error('no tmux'); } }), { ...o, permission: 'full' }, () => [], { ...fakeSandbox([]), runTmpDir: join(root, 'run-tmp') });
    await failing.dispose();
    expect(warn.mock.calls.some((c) => /could not clean up after the run/.test(String(c[0])) && c[1] === 'no tmux')).toBe(true);
    warn.mockRestore();
  });
});

describe('ACP pieces', () => {
  it('decides by the permission: reading and the web in read-only, everything but publishing in edit', () => {
    const info = (kind: string, rawInput: Record<string, any> = {}) => acpCallInfo({ kind, title: kind, rawInput });
    expect(acpPermissionDecision('read-only', info('read'), 'X')).toEqual({ allow: true });
    expect(acpPermissionDecision('read-only', info('fetch', { url: 'https://example.com' }), 'X')).toEqual({ allow: true });
    expect(acpPermissionDecision('read-only', info('execute', { command: 'ls' }), 'X').allow).toBe(false);
    expect(acpPermissionDecision('read-only', info('edit'), 'X').allow).toBe(false);
    expect(acpPermissionDecision('read-only', info('switch_mode'), 'X').allow).toBe(false);
    expect(acpPermissionDecision('edit', info('execute', { command: 'npm publish' }), 'X').allow).toBe(false);
    expect(acpPermissionDecision('edit', info('execute', { command: ['git', 'status'] }), 'X')).toEqual({ allow: true });
    expect(acpPermissionDecision('full', info('execute', { command: 'git push' }), 'X')).toEqual({ allow: true });
    // A command as an argument list is read as the command line it runs: pushing still asks.
    expect(acpPermissionDecision('edit', info('execute', { command: ['git', 'push', 'origin', 'main'] }), 'X').allow).toBe(false);
    expect(acpPermissionDecision('edit', info('execute', { command: ['bash', '-lc', 'git push origin main'] }), 'X').allow).toBe(false);
    expect(acpCallInfo({ kind: 'execute', title: 'Run', rawInput: { command: ['echo', 'a b'] } }).command).toBe("echo 'a b'");
    // A command without a kind is a command; a file editor's `command` is not a shell command.
    expect(acpCallInfo({ rawInput: { cmd: 'make' } })).toMatchObject({ kind: 'execute', command: 'make' });
    expect(acpCallInfo({ kind: 'edit', title: 'Edit', rawInput: { command: 'create', path: 'a.txt' } })).toEqual({ kind: 'edit', title: 'Edit', path: 'a.txt', input: { command: 'create', path: 'a.txt' } });
    expect(acpPermissionDecision('read-only', acpCallInfo({ kind: 'read', title: 'View', rawInput: { command: 'view', path: 'a' } }), 'X')).toEqual({ allow: true });
    // The path of an edit may only come in its locations.
    expect(acpCallInfo({ kind: 'edit', title: 'Edit', locations: [{ path: '/w/a.ts' }] }).path).toBe('/w/a.ts');
    expect(acpCallInfo({ kind: 'other', title: 'x' }, () => ({ kind: 'read' })).kind).toBe('read');
  });

  it('builds the approval card: the command, the file or the URL, and says read-only stays a boundary', () => {
    expect(acpApprovalRequest(acpCallInfo({ kind: 'delete', title: 'Delete b', rawInput: { file_path: 'b' } }), 'read-only')).toEqual({ kind: 'edit', detail: 'b', reason: 'Delete b', readOnlySandbox: true });
    expect(acpApprovalRequest(acpCallInfo({ kind: 'fetch', title: 'Fetch', rawInput: { url: 'https://x.dev' } }), 'read-only')).toEqual({ kind: 'fetch', detail: 'https://x.dev', reason: 'Fetch' });
    expect(acpApprovalRequest(acpCallInfo({ kind: 'execute', title: 'Run', rawInput: { command: 'git push', description: 'Push it' } }), 'edit')).toEqual({ kind: 'command', detail: 'git push', reason: 'Push it' });
    expect(acpApprovalRequest(acpCallInfo({ kind: 'other', title: 'mcp: search' }), 'edit')).toEqual({ kind: 'other', tool: 'mcp: search', detail: undefined, reason: 'mcp: search' });
    // A request that says nothing of what it is about can be allowed once, never always (that would allow every such request).
    expect(acpApprovalRequest(acpCallInfo({ kind: 'other' }), 'edit')).toMatchObject({ kind: 'other', noRule: true });
    expect(acpApprovalRequest(acpCallInfo({}), 'edit')).toMatchObject({ noRule: true });
    expect(acpApprovalRequest(acpCallInfo({ kind: 'execute', rawInput: { command: 'ls' } }), 'read-only').noRule).toBeUndefined();
  });

  it('answers with the allow-once or reject-once option, never an "always" one, or as the spec chooses', () => {
    const options = [
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'no', kind: 'reject_once' },
      { optionId: 'never', kind: 'reject_always' },
    ];
    expect(answerAcpPermission({ allow: true }, options)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    const refusal = { allow: false as const, reason: 'why', label: 'l' };
    expect(answerAcpPermission(refusal, options, { rejection: (reason) => ({ _meta: { note: reason } }) })).toEqual({ outcome: { outcome: 'selected', optionId: 'no' }, _meta: { note: 'why' } });
    // Only "always" options: allowing once is impossible, so it is refused (cancelled).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(answerAcpPermission({ allow: true }, [options[0]!, options[3]!])).toEqual({ outcome: { outcome: 'cancelled' } });
    warn.mockRestore();
    // OpenHands-style ids, chosen by id; an id the agent did not offer is not sent.
    const oh = [{ optionId: 'accept', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }, { optionId: 'risk_based', kind: 'allow_once' }];
    const chooseOption = (allow: boolean) => (allow ? 'accept' : 'reject');
    expect(answerAcpPermission({ allow: true }, oh, { chooseOption })).toEqual({ outcome: { outcome: 'selected', optionId: 'accept' } });
    expect(answerAcpPermission(refusal, oh, { chooseOption: () => 'always_proceed' })).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('hands the tool library its servers in ACP’s form, HTTP ones only when the agent takes them', () => {
    const servers: McpServerSpec[] = [
      { name: 'gh', transport: 'stdio', command: 'npx', args: ['gh'], url: '', env: { TOKEN: 't' }, headers: {} },
      { name: 'web', transport: 'http', command: '', args: [], url: 'https://mcp.example', env: {}, headers: { Authorization: 'Bearer x' } },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(acpMcpServers(servers, {})).toEqual([{ name: 'gh', command: 'npx', args: ['gh'], env: [{ name: 'TOKEN', value: 't' }] }]);
    warn.mockRestore();
    expect(acpMcpServers(servers, { mcpCapabilities: { http: true } })[1]).toEqual({ type: 'http', name: 'web', url: 'https://mcp.example', headers: [{ name: 'Authorization', value: 'Bearer x' }] });
  });

  it('reads usage from the answer and the cost from the last usage update, in USD only', () => {
    expect(acpUsage({ usage: { inputTokens: 3, outputTokens: 4 } }, { cost: { amount: 0.5, currency: 'USD' } })).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 0.5 });
    expect(acpUsage({ _meta: { usage: { inputTokens: 1 } } }, { cost: { amount: 9, currency: 'EUR' } })).toEqual({ inputTokens: 1, outputTokens: undefined, costUsd: undefined });
  });

  it('puts the briefing in the prompt only when asked, and images only when the agent takes them', () => {
    const o = { prompt: 'Q', systemPrompt: 'B', images: [{ path: '/nowhere.png', mimeType: 'image/png' }] };
    expect(acpPrompt(o, undefined, true)).toEqual([{ type: 'text', text: 'Q' }]); // a missing image is left out
    // A prompt that would read as one of the agent's own commands does not.
    expect(acpPrompt({ prompt: '/confirm always-approve' }, undefined, false)).toEqual([{ type: 'text', text: 'Message: /confirm always-approve' }]);
    expect(acpPrompt({ prompt: '/x' }, undefined, false, (text) => text.replace(/^\//, '\\/'))).toEqual([{ type: 'text', text: '\\/x' }]);
    expect((acpPrompt(o, 'B', false)[0] as { text: string }).text).toContain('<harness-relay-briefing>\nB\n');
    // An agent that cannot pass a refusal's reason to its model gets told what a refusal means.
    expect(acpBriefing({ systemPrompt: 'B', permission: 'edit' }, {})).toBe(`B\n\n${ACP_REFUSAL_NOTE}`);
    expect(acpBriefing({ systemPrompt: 'B', permission: 'edit' }, { rejection: () => ({}) })).toBe('B');
    expect(acpBriefing({ systemPrompt: 'B', permission: 'full' }, {})).toBe('B');
  });

  it('shows a tool call whose input comes later with what it was about, and hides the tools the spec hides', () => {
    const events: AgentEvent[] = [];
    const h = createAcpUpdateHandler((e) => events.push(e), { hideTool: (u) => u.title === 'todo', toolName: (u) => `[${u.kind}] ${u.title}` });
    h.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: '1', title: 'grep', kind: 'search', status: 'pending', rawInput: {} });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', rawInput: { pattern: 'TODO' } });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: '2', title: 'todo', status: 'pending' });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: '2', status: 'completed' });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: '3', status: 'completed' }); // never announced, nothing to show
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: '4', title: 'Late', kind: 'read', status: 'failed' });
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text_end' },
      { type: 'tool_start', id: '1', name: '[search] grep' },
      { type: 'tool_end', id: '1', ok: true, detail: 'TODO' },
      { type: 'tool_start', id: '4', name: '[read] Late' },
      { type: 'tool_end', id: '4', ok: false },
    ]);
    expect(h.lastFailure).toEqual({ tool: '[read] Late', reason: undefined });
    expect(h.call('1')).toMatchObject({ title: 'grep', kind: 'search', status: 'completed', rawInput: { pattern: 'TODO' } });
  });

  it('takes the plan from a to-do tool whose list only comes as its input, and shows no row for it', () => {
    const events: AgentEvent[] = [];
    const todos = (u: Record<string, any>) =>
      Array.isArray(u.rawInput?.todos) ? u.rawInput.todos.map((t: any) => ({ text: t.content, status: t.status })) : undefined;
    const h = createAcpUpdateHandler((e) => events.push(e), { hideTool: (u) => u.title === 'todowrite', planOf: todos });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'p', title: 'todowrite', kind: 'other', status: 'pending', rawInput: {} });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'p', status: 'in_progress', rawInput: { todos: [{ content: 'Read', status: 'in_progress' }] } });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'p', status: 'completed' });
    expect(events).toEqual([{ type: 'plan', entries: [{ text: 'Read', status: 'in_progress' }] }]);
  });
});
