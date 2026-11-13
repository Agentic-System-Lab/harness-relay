import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `muse` in the tests of the Muse Code adapter (test/muse.test.ts) and of its sign-in
 * (test/providers.test.ts), without the real CLI. What it plays back was recorded from muse 1.4.18
 * (test/fixtures/muse/, scrubbed):
 * - `acp …`: replays a recorded ACP exchange (`FAKE_MUSE_FIXTURE`, one of test/fixtures/muse/*.jsonl,
 *   lines `{dir, msg}`). Each recorded message the client sent starts a segment: the agent's messages
 *   recorded after it, up to the next one the client sent. A request it gets plays the next unplayed
 *   segment of a recorded request of that method (its answer takes the id of the request it got), a
 *   notification the next one of that method, and an answer to one of its own requests (a permission
 *   request) the segment recorded after that answer. The recordings' folders are played as the test's:
 *   `/work/app` (the working directory) as `FAKE_MUSE_CWD`, `/work/outside` as `FAKE_MUSE_OUTSIDE`,
 *   `/work/extra` as `FAKE_MUSE_EXTRA`, each when set. Without a fixture (or past its segments) it plays
 *   a short turn of its own: `initialize` (muse's capabilities, or `FAKE_MUSE_CAPS`), `session/new`
 *   (`s-1`; none with `FAKE_MUSE_NO_SESSION`), `session/resume` (`s-1` and the ids in
 *   `FAKE_MUSE_SESSIONS`; any other fails as muse's does, `sessionNotFound`),
 *   `session/set_config_option` (an error for the value `FAKE_MUSE_REJECT`), `session/prompt` (a reply,
 *   after an update of another session with `FAKE_MUSE_FOREIGN`; `stopReason: "cancelled"` with
 *   `FAKE_MUSE_CANCELLED`). With `FAKE_MUSE_REFRESH` it replaces its config folder's `auth.json` (a link
 *   to the account's) with a file of its own holding that text, as muse does when it refreshes a sign-in;
 *   with `FAKE_MUSE_MOUNTS`, at `session/new` it leaves an empty `.agents`, `.muse`, `.hg`, `.sl` and
 *   `.eden` in each working directory, as its bubblewrap sandbox does on Linux.
 * - `--version`: muse 1.4.18's. `usage`: prints `FAKE_MUSE_CLI/<FAKE_MUSE_USAGE>` (default: signed out;
 *   a file named `*signed-out*` goes to stderr and exits 1). `login`: prints its device link and code,
 *   and exits 0 after `FAKE_MUSE_LOGIN_MS` (as muse does once the code is approved). `logout`,
 *   `skills list --json` and `mcp list --json` print their recorded answers.
 * Every message it receives is appended to `FAKE_MUSE_LOG` as a JSON line, after a first line with its
 * arguments, its folder, the variables the adapter sets (`META_API_KEY` as whether it is set), and its
 * config folder (`$XDG_CONFIG_HOME/muse`, else `~/.config/muse`) as it found it: the run's settings,
 * whether `auth.json` is a link (and to where) or a file, its `trust.json` (or null), and what else is
 * in `$XDG_CONFIG_HOME`.
 */
export const FAKE_MUSE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const env = process.env;
const argv = process.argv.slice(2);
const record = (o) => env.FAKE_MUSE_LOG && fs.appendFileSync(env.FAKE_MUSE_LOG, JSON.stringify(o) + '\\n');
const VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MUSE_DISABLE_APPROVAL_JUDGE', 'HARNESS_RELAY_MUSE_HOME', 'HARNESS_RELAY_MUSE_KEY_ONLY'];
const config = env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config');
const own = path.join(config, 'muse');
let settings = null;
try { settings = JSON.parse(fs.readFileSync(path.join(own, 'settings.json'), 'utf8')); } catch {}
let auth = null;
try {
  const file = path.join(own, 'auth.json');
  auth = fs.lstatSync(file).isSymbolicLink() ? { link: fs.readlinkSync(file) } : { file: fs.readFileSync(file, 'utf8') };
} catch {}
let trust = null;
try { trust = JSON.parse(fs.readFileSync(path.join(own, 'trust.json'), 'utf8')); } catch {}
let entries = [];
try { entries = fs.readdirSync(config).sort(); } catch {}
const vars = Object.fromEntries(VARS.map((k) => [k, env[k] === undefined ? null : env[k]]));
vars.META_API_KEY = Boolean(env.META_API_KEY);
record({ start: true, argv, cwd: process.cwd(), env: vars, settings, auth, trust, entries });

const cli = (name) => fs.readFileSync(path.join(env.FAKE_MUSE_CLI, name), 'utf8');
const sub = argv.join(' ');
if (argv[0] === '--version') { process.stdout.write('Muse Code 1.4.18 (1.4.18-R8587.1)\\n'); process.exit(0); }
if (argv[0] === 'usage') {
  const name = env.FAKE_MUSE_USAGE || 'usage-signed-out.txt';
  if (/signed-out/.test(name)) { process.stderr.write(cli(name)); process.exit(1); }
  process.stdout.write(cli(name));
  process.exit(0);
}
if (argv[0] === 'login') {
  process.stdout.write(cli('login.txt'));
  setTimeout(() => { process.stdout.write('\\nlogged in\\n'); process.exit(0); }, Number(env.FAKE_MUSE_LOGIN_MS || 0));
  return;
}
if (argv[0] === 'logout') { process.stdout.write(cli('logout-none.txt')); process.exit(0); }
if (sub === 'skills list --json') { process.stdout.write(cli('skills.json')); process.exit(0); }
if (sub === 'mcp list --json') { process.stdout.write(cli('mcp-list.json')); process.exit(0); }
if (argv[0] !== 'acp') { process.stderr.write('unexpected: ' + sub + '\\n'); process.exit(2); }

if (env.FAKE_MUSE_REFRESH) {
  const file = path.join(own, 'auth.json');
  try { fs.unlinkSync(file); } catch {}
  fs.writeFileSync(file, env.FAKE_MUSE_REFRESH);
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const queues = new Map();
const responses = new Map();
if (env.FAKE_MUSE_FIXTURE) {
  let seg = null;
  for (const r of fs.readFileSync(env.FAKE_MUSE_FIXTURE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l))) {
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
const slash = (p) => p.split('\\\\').join('/');
const PLACES = [['/work/app', env.FAKE_MUSE_CWD], ['/work/outside', env.FAKE_MUSE_OUTSIDE], ['/work/extra', env.FAKE_MUSE_EXTRA]].filter(([, to]) => to);
const placed = (o) => {
  let s = JSON.stringify(o);
  for (const [from, to] of PLACES) s = s.split(from).join(slash(to));
  return JSON.parse(s);
};
function play(s) {
  for (const r of s.items) {
    const m = placed(r.msg);
    if (m.method === undefined && m.id !== undefined && ids.has(m.id)) m.id = ids.get(m.id);
    send(m);
  }
}
const MODES = ['allowAll', 'promptUnmatched', 'onRequest', 'denyUnmatched'];
const OPTIONS = [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'onRequest', options: MODES.map((value) => ({ value, name: value })) }];
const CAPS = { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { list: {}, resume: {}, additionalDirectories: {} } };
// As its bubblewrap sandbox does on Linux: an empty folder to mount over, in each working directory.
const mountPoints = (p) => {
  if (!env.FAKE_MUSE_MOUNTS) return;
  for (const d of [p.cwd, ...(p.additionalDirectories || [])]) for (const m of ['.agents', '.muse', '.hg', '.sl', '.eden']) fs.mkdirSync(path.join(d, m), { recursive: true });
};
const known = ['s-1', ...(env.FAKE_MUSE_SESSIONS || '').split(',').filter(Boolean)];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.method !== undefined && m.id !== undefined) {
    const p = m.params || {};
    if (m.method === 'session/new') mountPoints(p);
    const s = (queues.get('req:' + m.method) || []).shift();
    if (s) { ids.set(s.recordedId, m.id); return play(s); }
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: env.FAKE_MUSE_CAPS ? JSON.parse(env.FAKE_MUSE_CAPS) : CAPS, authMethods: [{ id: 'muse-login', name: 'Log in to Muse' }], agentInfo: { name: 'muse', version: '1.4.18' } } });
    if (m.method === 'session/new') return send({ jsonrpc: '2.0', id: m.id, result: env.FAKE_MUSE_NO_SESSION ? {} : { sessionId: 's-1', modes: { currentModeId: 'onRequest', availableModes: MODES.map((id) => ({ id, name: id })) }, configOptions: OPTIONS } });
    if (m.method === 'session/resume') {
      if (!known.includes(p.sessionId)) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32020, message: 'session ' + p.sessionId + ' not found', data: { kind: 'sessionNotFound', retryable: false, sessionId: p.sessionId } } });
      return send({ jsonrpc: '2.0', id: m.id, result: { configOptions: OPTIONS } });
    }
    if (m.method === 'session/set_config_option') {
      if (env.FAKE_MUSE_REJECT && p.value === env.FAKE_MUSE_REJECT) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown value ' + p.value } });
      return send({ jsonrpc: '2.0', id: m.id, result: { configOptions: OPTIONS } });
    }
    if (m.method === 'session/prompt') {
      if (env.FAKE_MUSE_FOREIGN) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } } });
      if (env.FAKE_MUSE_CANCELLED) return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'cancelled' } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
      return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
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
export function writeFakeMuse(path: string): string {
  writeFileSync(path, FAKE_MUSE, { mode: 0o755 });
  return path;
}
