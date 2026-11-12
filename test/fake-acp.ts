import { writeFileSync } from 'node:fs';

/*
 * A stand-in for an ACP agent on stdio (JSON-RPC, one message per line), for tests of the generic ACP
 * turn (src/server/agents/acpTurn.ts) without a real CLI. It speaks ACP as the spec has it:
 * - `initialize` answers with `FAKE_ACP_CAPS` (JSON) as its `agentCapabilities`;
 * - `session/new` answers `fake-1`, with config options (`model` and `effort`, of categories `model` and
 *   `thought_level`), models and modes (`ask`, `code`, `yolo`);
 * - `session/load` first replays the session's history as `session/update`s (an old reply), then answers;
 *   `session/resume` just answers; `FAKE_ACP_RESUME_FAIL` makes both fail;
 * - `session/set_model`, `session/set_config_option`, `session/set_mode` answer `{}`, or fail for the value
 *   named in `FAKE_ACP_REJECT`;
 * - `session/prompt` plays the scenario `FAKE_ACP_SCENARIO`:
 *   - `basic`: a thought, a plan, a read tool call with its output, a usage update, two text chunks;
 *   - `permission`: announces `FAKE_ACP_ANNOUNCE` (JSON, a `tool_call`; default the call below), asks
 *     `session/request_permission` about `FAKE_ACP_CALL` (JSON, the tool call; an edit by default), then
 *     reports the call completed when allowed and failed when not (the announced one too, with
 *     `FAKE_ACP_END_ANNOUNCED`), and says the outcome it got in its reply;
 *   - `client`: asks the client to write a file, read one and start a terminal (as some agents do although
 *     `initialize` said the client does none of these), and says what it got back;
 *   - `hang`: starts a tool call and says something, then waits; a `session/cancel` ends the prompt with
 *     `cancelled` (the tool call gets no closing update, as with some agents);
 *   - `silent`: never answers (for the timeout);
 *   - `crash`: writes to stderr and exits 3 in the middle of the prompt;
 *   - `self-cancel`: a tool call fails, and the prompt ends `cancelled` without being asked to;
 *   - `refusal`: starts a tool call it never closes, and the prompt ends `refusal`.
 * `FAKE_ACP_EXIT_AT_START` makes it exit at once (as when a sandbox stops it before it starts).
 * Every message it receives is appended as a JSON line to `FAKE_ACP_LOG`, with `FAKE_ACP_ENV` (a
 * variable's name) recording that variable's value at start, and `argv` the arguments.
 */
export const FAKE_ACP = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const env = process.env;
const record = (o) => env.FAKE_ACP_LOG && fs.appendFileSync(env.FAKE_ACP_LOG, JSON.stringify(o) + '\\n');
record({ start: true, argv: process.argv.slice(2), env: env.FAKE_ACP_ENV ? env[env.FAKE_ACP_ENV] : undefined, tmp: env.TMPDIR });
if (env.FAKE_ACP_EXIT_AT_START) {
  process.stderr.write('some output of its own\\n');
  process.exit(1);
}
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const caps = env.FAKE_ACP_CAPS ? JSON.parse(env.FAKE_ACP_CAPS) : {};
const scenario = env.FAKE_ACP_SCENARIO || 'basic';
let nextId = 100;
const waiting = new Map();
let cancel;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const rejected = (v) => env.FAKE_ACP_REJECT && v === env.FAKE_ACP_REJECT;

async function prompt(id, p) {
  const s = p.sessionId;
  if (scenario === 'basic') {
    update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking it over.' } });
    update(s, { sessionUpdate: 'plan', entries: [{ content: 'Read the file', status: 'in_progress', priority: 'high' }, { content: 'Answer', status: 'pending', priority: 'low' }] });
    update(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt', kind: 'read', status: 'pending', rawInput: { path: 'a.txt' } });
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file body' } }] });
    update(s, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.0042, currency: 'USD' } });
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    return send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 } } });
  }
  if (scenario === 'permission') {
    const call = env.FAKE_ACP_CALL ? JSON.parse(env.FAKE_ACP_CALL) : { toolCallId: 'e1', title: 'Edit a.txt', kind: 'edit', rawInput: { path: 'a.txt' } };
    update(s, { sessionUpdate: 'tool_call', status: 'pending', ...(env.FAKE_ACP_ANNOUNCE ? JSON.parse(env.FAKE_ACP_ANNOUNCE) : call) });
    const answer = await ask('session/request_permission', {
      sessionId: s,
      toolCall: call,
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = answer && answer.outcome && answer.outcome.optionId === 'yes';
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: allowed ? 'completed' : 'failed', content: allowed ? [{ type: 'content', content: { type: 'text', text: 'done' } }] : [] });
    // FAKE_ACP_END_ANNOUNCED: the announced call (another id than the one asked about) ends the same way.
    if (env.FAKE_ACP_END_ANNOUNCED && env.FAKE_ACP_ANNOUNCE) {
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: JSON.parse(env.FAKE_ACP_ANNOUNCE).toolCallId, status: allowed ? 'completed' : 'failed', content: [] });
    }
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'outcome ' + JSON.stringify(answer) } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (scenario === 'client') {
    const target = require('node:path').join(p.cwd || process.cwd(), 'written-by-client.txt');
    const results = [];
    for (const [method, params] of [
      ['fs/write_text_file', { sessionId: s, path: target, content: 'planted' }],
      ['fs/read_text_file', { sessionId: s, path: '/etc/hosts' }],
      ['terminal/create', { sessionId: s, command: 'touch', args: [target] }],
    ]) results.push(method + ' ' + JSON.stringify(await ask(method, params)));
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: results.join('; ') } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (scenario === 'hang') {
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'h1', title: 'Run tests', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    cancel = () => send({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (scenario === 'silent') return;
  if (scenario === 'crash') {
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to' } });
    process.stderr.write('panic: the fake agent fell over\\n');
    process.exit(3);
  }
  if (scenario === 'self-cancel') {
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'Run tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'x1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no terminal' } }] });
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  if (scenario === 'refusal') {
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read a.txt', kind: 'read', status: 'in_progress', rawInput: { path: 'a.txt' } });
    return send({ id, result: { stopReason: 'refusal' } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.method === undefined) { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r('result' in m ? m.result : { error: m.error }); } return; }
  const { id, method, params: p } = m;
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: caps, authMethods: [] } });
  if (method === 'session/new') {
    return send({ id, result: {
      sessionId: 'fake-1',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openai/gpt-5.4-nano', options: [] },
        { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [] },
      ],
      models: { currentModelId: 'openai/gpt-5.4-nano', availableModels: [{ modelId: 'openai/gpt-5.4-nano', name: 'nano' }] },
      modes: { currentModeId: 'code', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }, { id: 'yolo', name: 'Yolo' }] },
    } });
  }
  if (method === 'session/load' || method === 'session/resume') {
    if (env.FAKE_ACP_RESUME_FAIL) return send({ id, error: { code: -32002, message: 'Resource not found: ' + p.sessionId } });
    if (method === 'session/load') {
      update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } });
    }
    return send({ id, result: {} });
  }
  if (method === 'session/set_model') return rejected(p.modelId) ? send({ id, error: { code: -32602, message: 'unknown model' } }) : send({ id, result: {} });
  if (method === 'session/set_config_option') return rejected(p.value) ? send({ id, error: { code: -32602, message: 'bad value' } }) : send({ id, result: { configOptions: [] } });
  if (method === 'session/set_mode') return rejected(p.modeId) ? send({ id, error: { code: -32602, message: 'no such mode' } }) : send({ id, result: {} });
  if (method === 'session/prompt') return prompt(id, p);
  if (method === 'session/cancel') { if (cancel) cancel(); return; }
  if (id !== undefined) send({ id, error: { code: -32601, message: method + ' not found' } });
});
`;

/** Writes the stand-in to `path`, executable. */
export function writeFakeAcp(path: string): string {
  writeFileSync(path, FAKE_ACP, { mode: 0o755 });
  return path;
}
