import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `agy` in the tests of the Antigravity adapter (test/antigravity.test.ts), without the
 * real CLI. What it plays back was recorded from agy 1.5.6 (test/fixtures/antigravity/, scrubbed):
 * - `acp …`: replays a recorded ACP exchange (`FAKE_AGY_FIXTURE`, one of test/fixtures/antigravity/*.jsonl,
 *   lines `{dir, msg}`). Each recorded message the client sent starts a segment: the agent's messages
 *   recorded after it, up to the next one the client sent. A request it gets plays the next unplayed
 *   segment of a recorded request of that method (its answer takes the id of the request it got), a
 *   notification the next one of that method, and an answer to one of its own requests (a permission
 *   request) the segment recorded after that answer. A request with no recorded segment left gets `{}`
 *   (`set_config_option`: `{ configOptions: [] }`). Without a fixture it plays a short turn of its own:
 *   `initialize` (agy's capabilities, or `FAKE_AGY_CAPS`), `session/new` (`s-1`, with a model and a
 *   thinking-level option; none with `FAKE_AGY_NO_SESSION`), `session/resume`, `session/set_config_option`
 *   (an error for the value `FAKE_AGY_REJECT`), `session/prompt` (a reply, after an update of another
 *   session with `FAKE_AGY_FOREIGN`; `stopReason: "cancelled"` with `FAKE_AGY_CANCELLED`) and `logout`
 *   (an error with `FAKE_AGY_LOGOUT_FAIL`). `/work/app`, the recordings' working directory, is played as
 *   `FAKE_AGY_CWD` when that is set.
 * - `acp --login`: prints agy's sign-in link and prompt, and exits 0 once it reads a line.
 * - `--version`: prints 1.5.6. `--settings <json>` before a subcommand is skipped (its first line records it).
 * - `models`: prints `FAKE_AGY_CLI/<FAKE_AGY_MODELS or models.txt>` (a file named `*signed-out*` exits 1).
 * - `-p /<command> --output-format json`: prints `FAKE_AGY_CLI/<command>.json`; `plugin list --json`
 *   prints `FAKE_AGY_CLI/plugins.json`.
 * Every message it receives is appended to `FAKE_AGY_LOG` as a JSON line, after a first line with its
 * arguments, its folder, the variables the adapter sets and the run's own settings
 * (`<--gemini-dir or HOME/.gemini>/antigravity-cli/<--cli_dir_name>/settings.json`), as it found them.
 */
export const FAKE_ANTIGRAVITY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const env = process.env;
const argv = process.argv.slice(2);
const record = (o) => env.FAKE_AGY_LOG && fs.appendFileSync(env.FAKE_AGY_LOG, JSON.stringify(o) + '\\n');
const VARS = ['HOME', 'USERPROFILE', 'SSH_CONNECTION', 'GEMINI_API_KEY', 'HARNESS_RELAY_ANTIGRAVITY_HOME'];
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
let settings;
const runDir = flag('--cli_dir_name');
if (runDir) {
  const gemini = flag('--gemini-dir') || path.join(env.HOME || '', '.gemini');
  try { settings = JSON.parse(fs.readFileSync(path.join(gemini, 'antigravity-cli', runDir, 'settings.json'), 'utf8')); } catch { settings = null; }
}
record({ start: true, argv, cwd: process.cwd(), env: Object.fromEntries(VARS.map((k) => [k, env[k] === undefined ? null : env[k]])), settings });

const cli = (name) => fs.readFileSync(path.join(env.FAKE_AGY_CLI, name), 'utf8');
// Settings for one command (agy --settings <json> models) come before the subcommand.
if (argv[0] === '--settings') argv.splice(0, 2);
if (argv[0] === '--version') { process.stdout.write('1.5.6\\n'); process.exit(0); }
if (argv[0] === 'models') {
  const name = env.FAKE_AGY_MODELS || 'models.txt';
  process.stdout.write(cli(name));
  process.exit(/signed-out/.test(name) ? 1 : 0);
}
if (argv[0] === '-p') { process.stdout.write(cli(argv[1].replace(/^\\//, '') + '.json')); process.exit(0); }
if (argv[0] === 'plugin') { process.stdout.write(cli('plugins.json')); process.exit(0); }
if (argv[0] !== 'acp') { process.stderr.write('unexpected: ' + argv.join(' ') + '\\n'); process.exit(2); }
if (argv.includes('--login')) {
  process.stdout.write('Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test\\n\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => { record({ code: line }); process.exit(0); });
  return;
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const queues = new Map();
const responses = new Map();
if (env.FAKE_AGY_FIXTURE) {
  let seg = null;
  for (const r of fs.readFileSync(env.FAKE_AGY_FIXTURE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l))) {
    if (r.dir === 'client->agent') {
      const m = r.msg;
      seg = { recordedId: m.id, items: [] };
      if (m.method !== undefined && m.id !== undefined) { const k = 'req:' + m.method; if (!queues.has(k)) queues.set(k, []); queues.get(k).push(seg); }
      else if (m.method !== undefined) { const k = 'note:' + m.method; if (!queues.has(k)) queues.set(k, []); queues.get(k).push(seg); }
      else responses.set(String(m.id), seg);
    } else if (seg && r.dir === 'agent->client') seg.items.push(r);
  }
}
const ids = new Map();
const cwdOf = (o) => (env.FAKE_AGY_CWD ? JSON.parse(JSON.stringify(o).split('/work/app').join(env.FAKE_AGY_CWD.split('\\\\').join('/'))) : o);
function play(s) {
  for (const r of s.items) {
    const m = cwdOf(r.msg);
    if (m.method === undefined && m.id !== undefined && ids.has(m.id)) m.id = ids.get(m.id);
    send(m);
  }
}
const OPTIONS = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.1-pro', options: [{ value: 'gemini-3.1-pro' }, { value: 'gemini-3.8-flash' }] },
  { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: env.FAKE_AGY_MODE || 'default', options: [{ value: 'default' }, { value: 'accept-edits' }, { value: 'plan' }] },
];
const CAPS = { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }, auth: { logout: {} }, _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.method !== undefined && m.id !== undefined) {
    const s = (queues.get('req:' + m.method) || []).shift();
    if (s) { ids.set(s.recordedId, m.id); return play(s); }
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: env.FAKE_AGY_CAPS ? JSON.parse(env.FAKE_AGY_CAPS) : CAPS, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.6' }, authMethods: [] } });
    if (m.method === 'logout') return env.FAKE_AGY_LOGOUT_FAIL ? send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'keyring locked' } }) : send({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'session/new') return send({ jsonrpc: '2.0', id: m.id, result: env.FAKE_AGY_NO_SESSION ? {} : { sessionId: 's-1', configOptions: OPTIONS } });
    if (m.method === 'session/resume') return send({ jsonrpc: '2.0', id: m.id, result: { configOptions: OPTIONS } });
    if (m.method === 'session/set_config_option') {
      if (env.FAKE_AGY_REJECT && m.params && m.params.value === env.FAKE_AGY_REJECT) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown value ' + m.params.value } });
      return send({ jsonrpc: '2.0', id: m.id, result: { configOptions: OPTIONS } });
    }
    if (m.method === 'session/prompt') {
      const sid = m.params && m.params.sessionId;
      if (env.FAKE_AGY_FOREIGN) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } } });
      if (env.FAKE_AGY_CANCELLED) return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'cancelled' } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
      return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 1 } } });
    }
    if (m.method.startsWith('session/')) return send({ jsonrpc: '2.0', id: m.id, result: {} });
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: m.method + ' not found' } });
  }
  if (m.method !== undefined) { const s = (queues.get('note:' + m.method) || []).shift(); if (s) play(s); return; }
  const s = responses.get(String(m.id));
  if (s) { responses.delete(String(m.id)); play(s); }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Writes the stand-in to `path`, executable. */
export function writeFakeAntigravity(path: string): string {
  writeFileSync(path, FAKE_ANTIGRAVITY, { mode: 0o755 });
  return path;
}
