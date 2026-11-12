import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `pi --mode rpc` (JSONL on stdin/stdout, LF only), for tests of the Pi adapter
 * (src/server/agents/pi.ts) without the real CLI. It reads its arguments as Pi does (`--model`,
 * `--thinking`, `--session`, `-e <gate>`), and answers:
 * - `get_state` with the session (from `--session <file>`'s name, else `fake-session-1`), the model of
 *   `--model` and the level of `--thinking`, overridden by `FAKE_PI_STATE` (JSON);
 * - `get_commands` with the gate's command when an `-e` file was given (none with `FAKE_PI_NO_GATE`);
 * - `get_available_thinking_levels` with `FAKE_PI_LEVELS` (JSON; default off…high); `set_thinking_level`
 *   and `set_model` (fails with `FAKE_PI_SET_MODEL_FAIL`); `get_available_models` with the response
 *   recorded in `FAKE_PI_MODELS` (a fixture file; fails with `FAKE_PI_MODELS_FAIL`);
 * - `prompt`: fails with `FAKE_PI_PROMPT_FAIL`; `handled` with `FAKE_PI_HANDLED`; never settles with
 *   `FAKE_PI_HANG`; replays the recorded run of `FAKE_PI_FIXTURE` (a fixture of test/fixtures/pi/: its
 *   records after the first prompt up to `agent_settled`, waiting for the client's answer where the
 *   recording has one, and for `abort` where the recording was aborted); with `FAKE_PI_CALLS` (JSON
 *   tool calls) it loads the real gate extension given with `-e` and runs each call through its
 *   `tool_call` handler, the gate's dialogs going over the RPC as Pi sends them; else says "hi".
 *   `FAKE_PI_UI_OTHER` first sends a notification and a dialog of another extension.
 * `FAKE_PI_CHUNKED` writes each record in three pieces (cut inside multi-byte characters);
 * `FAKE_PI_NOISE` writes lines that are no records first; `FAKE_PI_SLOW` (a command's type) answers that
 * command 400 ms late.
 * `FAKE_PI_EXIT` (with `FAKE_PI_STDERR`) exits at start. Every record received is appended to
 * `FAKE_PI_LOG`, after a first line with the arguments, some variables and the agent folder's files.
 */
export const FAKE_PI = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const env = process.env;
const argv = process.argv.slice(2);
const log = (o) => env.FAKE_PI_LOG && fs.appendFileSync(env.FAKE_PI_LOG, JSON.stringify(o) + '\\n');
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const agentDir = env.PI_CODING_AGENT_DIR;
const files = {};
if (agentDir && fs.existsSync(agentDir)) for (const n of fs.readdirSync(agentDir)) {
  const p = path.join(agentDir, n);
  files[n] = fs.statSync(p).isDirectory() ? 'dir' : fs.readFileSync(p, 'utf8');
}
const vars = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'JITI_FS_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'TMPDIR', 'HARNESS_RELAY_ENDPOINT_API_KEY', 'OPENAI_API_KEY', 'PI_PACKAGE_DIR', 'HARNESS_RELAY_MCP_0_E_0', 'HARNESS_RELAY_MCP_1_H_0'];
log({ start: true, argv, cwd: process.cwd(), env: Object.fromEntries(vars.map((v) => [v, env[v]])), files });
if (env.FAKE_PI_EXIT) { process.stderr.write(env.FAKE_PI_STDERR || 'fake pi failed\\n'); process.exit(Number(env.FAKE_PI_EXIT)); }

const send = (o) => {
  const line = Buffer.from(JSON.stringify(o) + '\\n');
  if (env.FAKE_PI_CHUNKED !== '1') return process.stdout.write(line);
  const a = Math.floor(line.length / 3), b = Math.floor((2 * line.length) / 3) + 1;
  process.stdout.write(line.subarray(0, a));
  process.stdout.write(line.subarray(a, b));
  process.stdout.write(line.subarray(b));
};
const respond = (cmd, data, error) => send(error ? { id: cmd.id, type: 'response', command: cmd.type, success: false, error } : { id: cmd.id, type: 'response', command: cmd.type, success: true, ...(data === undefined ? {} : { data }) });

const sessionArg = arg('--session');
const sessionId = sessionArg ? ((path.basename(sessionArg).match(/_(.+)\\.jsonl$/) || [])[1] || 'unknown') : 'fake-session-1';
const [provider, ...rest] = (arg('--model') || 'openai/gpt-5.4-nano').split('/');
let model = { provider, id: rest.join('/') };
let thinking = arg('--thinking') || 'medium';
const overrides = env.FAKE_PI_STATE ? JSON.parse(env.FAKE_PI_STATE) : {};
const state = () => ({ model, thinkingLevel: thinking, isStreaming: false, sessionFile: sessionArg || path.join(env.PI_CODING_AGENT_SESSION_DIR || '/tmp', 't_' + sessionId + '.jsonl'), sessionId, messageCount: sessionArg ? 4 : 0, ...overrides });
const gatePath = argv.filter((a, i) => argv[i - 1] === '-e' && !a.startsWith('builtin:'))[0];

// Messages from the client the replay waits for.
const received = [];
const waiters = [];
const arrived = (type) => { const w = waiters.findIndex((x) => x.type === type); if (w >= 0) waiters.splice(w, 1)[0].resolve(); else received.push(type); };
const waitFor = (type) => new Promise((resolve) => { const i = received.indexOf(type); if (i >= 0) { received.splice(i, 1); resolve(); } else waiters.push({ type, resolve }); });

// The gate's dialogs, as Pi's RPC mode makes them.
const dialogs = new Map();
let dialogN = 0;
const ui = {
  input: (title, placeholder, opts) => new Promise((resolve) => {
    const id = 'ui-' + ++dialogN;
    dialogs.set(id, resolve);
    send({ type: 'extension_ui_request', id, method: 'input', title, placeholder });
    opts?.signal?.addEventListener('abort', () => { dialogs.delete(id); resolve(undefined); }, { once: true });
  }),
};
let current;

async function gateRun(cmd) {
  const handlers = {};
  const mod = await import(pathToFileURL(gatePath).href);
  mod.default({ registerCommand: () => undefined, on: (ev, h) => (handlers[ev] = h) });
  respond(cmd, { disposition: 'started' });
  send({ type: 'agent_start' });
  if (env.FAKE_PI_UI_OTHER) {
    send({ type: 'extension_ui_request', id: 'other-notify', method: 'notify', message: 'hello', notifyType: 'info' });
    send({ type: 'extension_ui_request', id: 'other-confirm', method: 'confirm', title: 'Something else?', message: 'x' });
  }
  const ac = new AbortController();
  current = ac;
  for (const call of JSON.parse(env.FAKE_PI_CALLS)) {
    send({ type: 'tool_execution_start', toolCallId: call.toolCallId, toolName: call.toolName, args: call.input });
    let result;
    try {
      result = await handlers.tool_call({ type: 'tool_call', toolName: call.toolName, toolCallId: call.toolCallId, input: call.input }, { hasUI: true, signal: ac.signal, ui });
    } catch (err) {
      result = { block: true, reason: 'Extension failed, blocking execution: ' + err.message };
    }
    if (ac.signal.aborted) { send({ type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: call.toolName, result: { content: [{ type: 'text', text: 'Operation aborted' }] }, isError: true }); break; }
    if (result && result.block) send({ type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: call.toolName, result: { content: [{ type: 'text', text: result.reason }], details: {} }, isError: true });
    else send({ type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: call.toolName, result: { content: [{ type: 'text', text: 'ran ' + call.toolName }] }, isError: false, durationMs: 1 });
  }
  const aborted = ac.signal.aborted;
  send({ type: 'message_end', message: { role: 'assistant', content: aborted ? [] : [{ type: 'text', text: 'done' }], stopReason: aborted ? 'aborted' : 'stop', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.001 } } } });
  send({ type: 'agent_settled', aborted });
}

async function replay(cmd) {
  const recs = fs.readFileSync(env.FAKE_PI_FIXTURE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.dir !== 'note');
  const at = recs.findIndex((r) => r.dir === 'client' && r.msg.type === 'prompt');
  const resp = recs.slice(at).find((r) => r.dir === 'pi' && r.msg.type === 'response' && r.msg.command === 'prompt');
  send({ ...resp.msg, id: cmd.id });
  if (!resp.msg.success) return;
  for (const r of recs.slice(at + 1)) {
    if (r.dir === 'client') {
      if (r.msg.type === 'extension_ui_response') await waitFor('extension_ui_response');
      else if (r.msg.type === 'abort') await waitFor('abort');
      continue;
    }
    if (r.msg.type === 'response') continue;
    send(r.msg);
    if (r.msg.type === 'agent_settled') break;
  }
}

async function handle(cmd) {
  log(cmd);
  if (env.FAKE_PI_SLOW === cmd.type) await new Promise((res) => setTimeout(res, 400));
  switch (cmd.type) {
    case 'get_state': return respond(cmd, state());
    case 'get_commands':
      return respond(cmd, { commands: gatePath && !env.FAKE_PI_NO_GATE ? [{ name: 'harness-relay-gate', source: 'extension', sourceInfo: { path: gatePath, source: 'cli', scope: 'temporary', origin: 'top-level' } }] : [] });
    case 'get_available_thinking_levels': return respond(cmd, { levels: env.FAKE_PI_LEVELS ? JSON.parse(env.FAKE_PI_LEVELS) : ['off', 'minimal', 'low', 'medium', 'high'] });
    case 'set_thinking_level': thinking = cmd.level; return respond(cmd);
    case 'set_model':
      if (env.FAKE_PI_SET_MODEL_FAIL) return respond(cmd, undefined, env.FAKE_PI_SET_MODEL_FAIL);
      model = { provider: cmd.provider, id: cmd.modelId };
      return respond(cmd, model);
    case 'get_available_models': {
      if (env.FAKE_PI_MODELS_FAIL) return respond(cmd, undefined, env.FAKE_PI_MODELS_FAIL);
      const rec = fs.readFileSync(env.FAKE_PI_MODELS, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.dir === 'pi' && r.msg.command === 'get_available_models');
      return respond(cmd, rec.msg.data);
    }
    case 'abort':
      current?.abort();
      arrived('abort');
      return respond(cmd);
    case 'extension_ui_response': {
      const resolve = dialogs.get(cmd.id);
      dialogs.delete(cmd.id);
      resolve?.(cmd.cancelled ? undefined : cmd.value);
      return arrived('extension_ui_response');
    }
    case 'prompt':
      if (env.FAKE_PI_PROMPT_FAIL) return respond(cmd, undefined, env.FAKE_PI_PROMPT_FAIL);
      if (env.FAKE_PI_HANDLED) return respond(cmd, { disposition: 'handled' });
      if (env.FAKE_PI_HANG) return respond(cmd, { disposition: 'started' });
      if (env.FAKE_PI_FIXTURE) return replay(cmd);
      if (env.FAKE_PI_CALLS) return gateRun(cmd);
      respond(cmd, { disposition: 'started' });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi \\u2028 there ü' } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop', usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
      return send({ type: 'agent_settled', aborted: false });
    default:
      return respond(cmd, undefined, 'Unknown command: ' + cmd.type);
  }
}

if (env.FAKE_PI_NOISE) process.stdout.write('not a record\\n[1,2]\\n');
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
    const line = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    if (line.trim()) handle(JSON.parse(line)).catch((err) => process.stderr.write(String(err && err.stack || err) + '\\n'));
  }
});
process.stdin.on('end', () => { log({ stdinClosed: true }); setTimeout(() => process.exit(0), 10); });
`;

/** Writes the fake as an executable ES module at `path` (which should end in `.mjs`). */
export function writeFakePi(path: string): string {
  writeFileSync(path, FAKE_PI, { mode: 0o755 });
  return path;
}
