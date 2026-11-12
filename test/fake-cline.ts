import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `cline` in the tests of the Cline adapter (test/cline.test.ts), without the real CLI:
 * - `--acp`: replays a recorded ACP exchange (`FAKE_CLINE_FIXTURE`, one of test/fixtures/cline/*.jsonl,
 *   or by `CLINE_PROVIDER` from the JSON map `FAKE_CLINE_CATALOG`). Each recorded message the client
 *   sent starts a segment: the agent's messages recorded after it, up to the next one the client sent.
 *   A request the stand-in gets plays the next unplayed segment of a recorded request of that method
 *   (its answer takes the id of the request it got), a notification the next one of that method, and
 *   an answer to one of its own requests (a permission request) the segment recorded after that
 *   answer. A request with no recorded segment left gets `{}` (`set_config_option`:
 *   `{ configOptions: [] }`, an unknown method: "method not found"). So the adapter's own order of
 *   requests drives the recording, as the real CLI's answers would.
 *   With `FAKE_CLINE_USAGE` (JSON `{inputTokens, outputTokens, totalCost}`) it writes that usage to the
 *   session's record (`<CLINE_DATA_DIR>/sessions/<id>/<id>.json`) just before it answers the prompt.
 * - `[--cwd <dir>] config <kind> --json`: prints `FAKE_CLINE_NATIVE_DIR/config-<kind>.json`, or a broken answer for
 *   the kind named in `FAKE_CLINE_NATIVE_BAD`.
 * `FAKE_CLINE_HANG` makes it never answer; `FAKE_CLINE_EXIT_ON` (a method) makes it exit 3 when it gets one.
 * Every message it receives is appended to `FAKE_CLINE_LOG` as a JSON line, after a first line with
 * its arguments and the variables the adapter sets.
 */
export const FAKE_CLINE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const env = process.env;
const argv = process.argv.slice(2);
const record = (o) => env.FAKE_CLINE_LOG && fs.appendFileSync(env.FAKE_CLINE_LOG, JSON.stringify(o) + '\\n');
const VARS = ['CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_API_KEY', 'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_GLOBAL_SETTINGS_PATH', 'CLINE_MCP_SETTINGS_PATH',
  'CLINE_PROVIDER_SETTINGS_PATH', 'CLINE_SESSION_BACKEND_MODE', 'E2E_TEST', 'CLINE_NO_AUTO_UPDATE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH', 'TMPDIR', 'CLINE_HOOKS_DIR', 'CLINE_BIN_PATH', 'CLINE_JS_RUNTIME_PATH', 'CLINE_PLUGIN_BOOTSTRAP_PATH', 'CLINE_LANGFUSE_PUBLIC_KEY'];
record({ start: true, argv, cwd: process.cwd(), env: Object.fromEntries(VARS.map((k) => [k, env[k]])) });

if (env.FAKE_CLINE_HANG) { setInterval(() => undefined, 1000); return; }
if (argv.includes('config')) {
  const kind = argv[argv.indexOf('config') + 1];
  if (env.FAKE_CLINE_NATIVE_BAD === kind) { if (!env.FAKE_CLINE_NATIVE_QUIET) process.stderr.write('config: cannot list ' + kind + '\\n'); process.stdout.write('not json'); process.exit(1); }
  process.stdout.write(fs.readFileSync(path.join(env.FAKE_CLINE_NATIVE_DIR, 'config-' + kind + '.json'), 'utf8'));
  process.exit(0);
}

let fixture = env.FAKE_CLINE_FIXTURE;
if (env.FAKE_CLINE_CATALOG) fixture = JSON.parse(env.FAKE_CLINE_CATALOG)[env.CLINE_PROVIDER];
if (!fixture) { process.stderr.write('no recording for ' + env.CLINE_PROVIDER + '\\n'); process.exit(2); }
const rows = fs.readFileSync(fixture, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const queues = new Map();
const responses = new Map();
let seg = null;
for (const r of rows) {
  if (r.dir === 'client->agent') {
    const m = r.msg;
    seg = { recordedId: m.id, items: [] };
    if (m.method !== undefined && m.id !== undefined) { const k = 'req:' + m.method; if (!queues.has(k)) queues.set(k, []); queues.get(k).push(seg); }
    else if (m.method !== undefined) { const k = 'note:' + m.method; if (!queues.has(k)) queues.set(k, []); queues.get(k).push(seg); }
    else responses.set(m.id, seg);
  } else if (seg && (r.dir === 'agent->client' || r.dir === 'agent stderr')) seg.items.push(r);
}
const ids = new Map();
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
function writeUsage(sessionId) {
  if (!env.FAKE_CLINE_USAGE || !env.CLINE_DATA_DIR || !sessionId) return;
  const dir = path.join(env.CLINE_DATA_DIR, 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify({ session_id: sessionId, metadata: { aggregateUsage: JSON.parse(env.FAKE_CLINE_USAGE) } }));
}
let sessionId;
function play(s) {
  for (const r of s.items) {
    if (r.dir === 'agent stderr') { process.stderr.write(r.text); continue; }
    const m = JSON.parse(JSON.stringify(r.msg));
    if (m.result && typeof m.result.sessionId === 'string') sessionId = m.result.sessionId;
    if (m.method === undefined && m.id !== undefined && ids.has(m.id)) {
      if (m.result && m.result.stopReason) writeUsage(sessionId);
      m.id = ids.get(m.id);
    }
    send(m);
  }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (env.FAKE_CLINE_EXIT_ON && m.method === env.FAKE_CLINE_EXIT_ON) { process.stderr.write('crashed on ' + m.method + '\\n'); process.exit(3); }
  if (m.method === 'session/load' && m.params) sessionId = m.params.sessionId;
  if (m.method !== undefined && m.id !== undefined) {
    const s = (queues.get('req:' + m.method) || []).shift();
    if (s) { ids.set(s.recordedId, m.id); return play(s); }
    if (m.method === 'session/set_config_option') return send({ jsonrpc: '2.0', id: m.id, result: { configOptions: [] } });
    if (m.method.startsWith('session/')) return send({ jsonrpc: '2.0', id: m.id, result: {} });
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: m.method + ' not found' } });
  }
  if (m.method !== undefined) { const s = (queues.get('note:' + m.method) || []).shift(); if (s) play(s); return; }
  const s = responses.get(m.id);
  if (s) { responses.delete(m.id); play(s); }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Writes the stand-in to `path`, executable. */
export function writeFakeCline(path: string): string {
  writeFileSync(path, FAKE_CLINE, { mode: 0o755 });
  return path;
}
