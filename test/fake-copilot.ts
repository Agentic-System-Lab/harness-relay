import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `copilot` in the tests of the Copilot adapter (test/copilot.test.ts), without the real
 * CLI. What it plays back was recorded from copilot 1.0.109 (test/fixtures/copilot/, scrubbed):
 * - `--acp …`: replays a recorded ACP exchange (`FAKE_COPILOT_FIXTURE`, one of
 *   test/fixtures/copilot/*.jsonl, lines `{dir, msg}`). Each recorded message the client sent starts a
 *   segment: the agent's messages recorded after it, up to the next one the client sent. A request it
 *   gets plays the next unplayed segment of a recorded request of that method (its answer takes the id
 *   of the request it got), a notification the next one of that method, and an answer to one of its own
 *   requests (a permission request) the segment recorded after that answer. Without a fixture (or once
 *   a method's segments are played) it plays a short turn of its own: `initialize` (Copilot's
 *   capabilities), `session/new` (`s-1`, with Copilot's options; `allow_all` on with `--allow-all`; an
 *   "Authentication required" error with `FAKE_COPILOT_SIGNED_OUT`, or when neither a GitHub token in its
 *   environment nor its home's `config.json` names a signed-in user; a refused effort with
 *   `FAKE_COPILOT_NO_EFFORT` when `--reasoning-effort` is given; no allow-all option with
 *   `FAKE_COPILOT_NO_ALLOW_ALL`), `session/load` (it replays one old
 *   message first, as Copilot does; "not found" for the session `missing`), `session/prompt` (for
 *   `/sandbox policy`, the policy its home's `settings.json` gives, as Copilot prints it, or that it is
 *   off with `FAKE_COPILOT_POLICY=off`, or, with `FAKE_COPILOT_POLICY_MODEL`, as its model would: a
 *   permission request first, then the policy and usage; its dev-tool access writes the paths in
 *   `FAKE_COPILOT_DEV_WRITES` (path-delimited), and its keychain access is `FAKE_COPILOT_KEYCHAIN`
 *   (else off); else a reply, with `stopReason: "cancelled"` for
 *   `FAKE_COPILOT_CANCELLED`, or a failed model call's error line and no usage for `FAKE_COPILOT_MODEL_DOWN`), `session/set_config_option` and `logout` (an error with
 *   `FAKE_COPILOT_LOGOUT_FAIL`). `/work/app`, the recordings' working directory, is played as
 *   `FAKE_COPILOT_CWD` when that is set.
 * - `login --device-code`: prints GitHub's device link and a code, then records the user as signed in
 *   (`config.json` in `COPILOT_HOME`) and exits 0; with `FAKE_COPILOT_NO_KEYRING`, says the token was
 *   not saved (no credential store) and exits 0 too. `logout` (ACP) leaves no user there.
 * - `--version`: prints Copilot's version line. `<what> list --json` prints `FAKE_COPILOT_CLI/<what>.json`.
 * Every message it receives is appended to `FAKE_COPILOT_LOG` as a JSON line, after a first line with
 * its arguments, its folder, its COPILOT_ variables and its home's files (settings, config, briefing,
 * links), as it found them.
 */
export const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const env = process.env;
const argv = process.argv.slice(2);
const record = (o) => env.FAKE_COPILOT_LOG && fs.appendFileSync(env.FAKE_COPILOT_LOG, JSON.stringify(o) + '\\n');
const home = env.COPILOT_HOME || path.join(env.HOME || '', '.copilot');
const files = {};
try {
  for (const n of fs.readdirSync(home)) {
    const p = path.join(home, n);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) files[n] = { link: fs.readlinkSync(p) };
    else if (st.isFile()) files[n] = fs.readFileSync(p, 'utf8');
    else files[n] = { dir: true };
  }
} catch {}
const vars = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('COPILOT_')));
record({ start: true, argv, cwd: process.cwd(), env: vars, files });

if (argv[0] === '--version') { process.stdout.write('GitHub Copilot CLI 1.0.109.\\nRun \\'copilot update\\' to check for updates.\\n'); process.exit(0); }
if (argv[1] === 'list' && argv.includes('--json')) { process.stdout.write(fs.readFileSync(path.join(env.FAKE_COPILOT_CLI, argv[0] + '.json'), 'utf8')); process.exit(0); }
if (argv[0] === 'login') {
  process.stdout.write('To authenticate, visit https://github.com/login/device and enter code ABCD-1234\\nWaiting for authorization...\\n');
  setTimeout(() => {
    if (env.FAKE_COPILOT_NO_KEYRING) { process.stdout.write('Login succeeded, but the token was not saved. Install a system keychain or rerun login and accept plaintext storage.\\n'); process.exit(0); }
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '// This file is managed automatically.\\n' + JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }], lastLoggedInUser: { host: 'https://github.com', login: 'octocat' } }));
    process.stdout.write('Signed in successfully as octocat.\\n');
    process.exit(0);
  }, 50);
  return;
}
if (argv[0] !== '--acp') { process.stderr.write('unexpected: ' + argv.join(' ') + '\\n'); process.exit(2); }

const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const queues = new Map();
const responses = new Map();
if (env.FAKE_COPILOT_FIXTURE) {
  let seg = null;
  for (const r of fs.readFileSync(env.FAKE_COPILOT_FIXTURE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l))) {
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
const cwdOf = (o) => (env.FAKE_COPILOT_CWD ? JSON.parse(JSON.stringify(o).split('/work/app').join(env.FAKE_COPILOT_CWD.split('\\\\').join('/'))) : o);
function play(s) {
  for (const r of s.items) {
    const m = cwdOf(r.msg);
    if (m.method === undefined && m.id !== undefined && ids.has(m.id)) m.id = ids.get(m.id);
    send(m);
  }
}
const AGENT = 'https://agentclientprotocol.com/protocol/session-modes#agent';
const options = () => [
  { type: 'select', id: 'mode', category: 'mode', currentValue: env.FAKE_COPILOT_MODE || AGENT, options: [{ value: AGENT }, { value: 'https://agentclientprotocol.com/protocol/session-modes#autopilot' }] },
  { type: 'select', id: 'model', category: 'model', currentValue: 'claude-sonnet-5.5', options: [{ value: 'auto' }, { value: 'claude-sonnet-5.5' }, { value: 'claude-haiku-4.5' }] },
  { type: 'select', id: 'reasoning_effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
  ...(env.FAKE_COPILOT_NO_ALLOW_ALL ? [] : [{ type: 'select', id: 'allow_all', category: 'permissions', currentValue: env.FAKE_COPILOT_ALLOW_ALL || (argv.includes('--allow-all') ? 'on' : 'off'), options: [{ value: 'on' }, { value: 'off' }] }]),
];
const MODELS = { availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'auto', name: 'Auto' }, { modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' }, { modelId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' }], currentModelId: 'claude-sonnet-5.5' };
function policy() {
  if (env.FAKE_COPILOT_POLICY === 'off') return 'Command sandboxing is disabled, so no policy is in force and commands run unrestricted.\\n\\nUse /sandbox enable to turn it on.';
  let sb = {};
  try { sb = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).sandbox || {}; } catch {}
  if (!sb.enabled || !argv.includes('--sandbox')) return 'Command sandboxing is disabled, so no policy is in force and commands run unrestricted.';
  const fsp = (sb.userPolicy && sb.userPolicy.filesystem) || {};
  const list = (title, paths) => (paths && paths.length ? '  ' + title + ' (' + paths.length + '):\\n' + paths.map((p) => '    ' + p).join('\\n') + '\\n' : '');
  return 'Effective sandbox policy for ' + process.cwd() + '\\n\\n\\u001b[1mUser-configured paths:\\u001b[22m\\n' + list('Read-write paths', fsp.readwritePaths) + list('Read-only paths', fsp.readonlyPaths) + list('Denied paths', env.FAKE_COPILOT_DROP_DENIED ? [] : fsp.deniedPaths) +
    '\\n\\u001b[1mWorking directory:\\u001b[22m\\n  Read-write paths (1):\\n    ' + process.cwd() + '\\n' + devTools() +
    '\\n\\u001b[1mCapabilities:\\u001b[22m\\n  Allow sandbox bypass: ' + (sb.allowBypass ? 'yes' : 'no') + '\\n  Authenticate git (sandbox setting): ' + (sb.auth && sb.auth.git ? 'on' : 'off') + '\\n  Authenticate gh (sandbox setting): off\\n  Allow keychain access: ' + (env.FAKE_COPILOT_KEYCHAIN || 'off') + '\\n';
  function devTools() {
    const w = (env.FAKE_COPILOT_DEV_WRITES || '').split(path.delimiter).filter(Boolean);
    return w.length ? '\\n\\u001b[1mDev tools:\\u001b[22m\\n  Tools detected in this directory: npm\\n  Read-write paths (' + w.length + '):\\n' + w.map((p) => '    ' + p).join('\\n') + '\\n' : '';
  }
}
/** Signed in with a GitHub token in its environment, or when its home's config.json names a user, as Copilot's does (the token itself it keeps in the credential store). */
function signedIn() {
  if (env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN) return true;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^\\s*\\/\\/[^\\n]*$/gm, ''));
    return Array.isArray(c.loggedInUsers) && c.loggedInUsers.length > 0;
  } catch {
    return false;
  }
}
/** Its own requests (a permission request) waiting for the client's answer: what to do then, by id. */
const waiting = new Map();
const say = (sid, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.method !== undefined && m.id !== undefined) {
    const s = (queues.get('req:' + m.method) || []).shift();
    if (s) { ids.set(s.recordedId, m.id); return play(s); }
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} }, loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { close: {}, list: {} } }, agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.109' }, authMethods: [] } });
    if (m.method === 'logout') {
      if (env.FAKE_COPILOT_LOGOUT_FAIL) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'keychain locked' } });
      try { fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ loggedInUsers: [] })); } catch {}
      return send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
    if (m.method === 'session/new' || m.method === 'session/load') {
      if (env.FAKE_COPILOT_SIGNED_OUT || !signedIn()) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } });
      if (env.FAKE_COPILOT_NO_EFFORT && argv.includes('--reasoning-effort')) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: "Request sessions.open failed with message: session construction failed: Model 'claude-haiku-4.5' does not support reasoning effort configuration." } });
      if (m.method === 'session/load') {
        const sid = m.params && m.params.sessionId;
        if (sid === 'missing') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Resource not found: Session missing not found' } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'an old question' } } } });
        say(sid, 'an old answer');
        return send({ jsonrpc: '2.0', id: m.id, result: { models: MODELS, configOptions: options() } });
      }
      return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's-1', models: MODELS, configOptions: options() } });
    }
    if (m.method === 'session/set_config_option') return send({ jsonrpc: '2.0', id: m.id, result: { configOptions: options() } });
    if (m.method === 'session/prompt') {
      const sid = m.params && m.params.sessionId;
      const text = ((m.params && m.params.prompt) || []).map((b) => b.text || '').join('');
      if (text === '/sandbox policy' && env.FAKE_COPILOT_POLICY_MODEL) {
        waiting.set('p-1', () => { say(sid, policy()); send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 9, outputTokens: 2 } } }); });
        return send({ jsonrpc: '2.0', id: 'p-1', method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 't-1', kind: 'execute', title: 'cat ~/.copilot/settings.json', rawInput: { command: 'cat ~/.copilot/settings.json' } }, options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'allow_always', kind: 'allow_always' }, { optionId: 'reject_once', kind: 'reject_once' }, { optionId: 'reject_always', kind: 'reject_always' }] } });
      }
      if (text === '/sandbox policy') { say(sid, policy()); return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }); }
      if (env.FAKE_COPILOT_CANCELLED) return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'cancelled' } });
      if (env.FAKE_COPILOT_MODEL_DOWN) { say(sid, 'Error: Could not connect to local model provider at http://127.0.0.1:9/v1.'); return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }); }
      say(sid, 'hello');
      return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 1 } } });
    }
    if (m.method.startsWith('session/')) return send({ jsonrpc: '2.0', id: m.id, result: {} });
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: m.method + ' not found' } });
  }
  if (m.method !== undefined) { const s = (queues.get('note:' + m.method) || []).shift(); if (s) play(s); return; }
  const w = waiting.get(String(m.id));
  if (w) { waiting.delete(String(m.id)); return w(); }
  const s = responses.get(String(m.id));
  if (s) { responses.delete(String(m.id)); play(s); }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Writes the stand-in to `path`, executable. */
export function writeFakeCopilot(path: string): string {
  writeFileSync(path, FAKE_COPILOT, { mode: 0o755 });
  return path;
}
