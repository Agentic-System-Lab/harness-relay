import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `opencode` that replays messages recorded from the real CLI (test/fixtures/opencode/),
 * for test/opencode.test.ts. Fixture lines are `{dir:"send"|"recv", msg}` from the client's side.
 * - `opencode acp …`: each message the client sends is matched with the next recorded `send` of the same
 *   method (a request or a notification), or, for an answer to one of the agent's requests, the recorded
 *   answer of the same id; then the recorded `recv` lines up to the next `send` are played back, the
 *   answers' ids put back to the client's. A request the recording does not have gets `{}`.
 *   `FAKE_OC_FIXTURE` names the recording; every message received is appended to `FAKE_OC_LOG` (with
 *   `argv` and the variables named in `FAKE_OC_ENV` on its first line).
 *   With `--port` it also serves what Harness Relay asks of OpenCode's own server, wanting the run's
 *   password: its event stream (`FAKE_OC_FOREIGN`, an event, is sent on it once the prompt arrives, which
 *   is then never answered; `FAKE_OC_NO_EVENTS` refuses the stream) and the pending permissions (none).
 *   `FAKE_OC_SLOW_EXIT` (ms): when its stdin closes it resets the event stream at once and exits that much later.
 * - `opencode models --verbose`, `debug skill`, `agent list`: print `models-verbose.txt`,
 *   `debug-skill.json`, `agent-list.txt` from `FAKE_OC_CLI`; `FAKE_OC_FAIL` makes them fail.
 */
export const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const argv = process.argv.slice(2);
const record = (o) => env.FAKE_OC_LOG && fs.appendFileSync(env.FAKE_OC_LOG, JSON.stringify(o) + '\\n');
const vars = (env.FAKE_OC_ENV || '').split(',').filter(Boolean);
record({ start: true, argv, cwd: process.cwd(), env: Object.fromEntries(vars.map((v) => [v, env[v] === undefined ? null : env[v]])) });

if (argv[0] !== 'acp') {
  if (env.FAKE_OC_FAIL) { process.stderr.write('boom: ' + argv.join(' ') + '\\n'); process.exit(2); }
  const file = argv[0] === 'models' ? 'models-verbose.txt' : argv[0] === 'debug' ? 'debug-skill.json' : 'agent-list.txt';
  process.stdout.write(fs.readFileSync(path.join(env.FAKE_OC_CLI, file), 'utf8'));
  process.exit(0);
}

// Its own server, as \`opencode acp --port\` has one: the event stream (\`FAKE_OC_FOREIGN\`, an event, is sent on it
// once the prompt arrives), the pending permissions (none) and their replies; the run's password wanted.
const port = Number(argv[argv.indexOf('--port') + 1]);
const streams = [];
if (port) {
  const auth = 'Basic ' + Buffer.from('opencode:' + (env.OPENCODE_SERVER_PASSWORD || '')).toString('base64');
  require('node:http').createServer((req, res) => {
    record({ http: req.method + ' ' + req.url.split('?')[0], auth: req.headers.authorization === auth });
    if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
    if (req.url.startsWith('/global/event')) {
      if (env.FAKE_OC_NO_EVENTS) { res.writeHead(500).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ payload: { type: 'server.connected', properties: {} } }) + '\\n\\n');
      streams.push(res);
      return;
    }
    if (req.url.startsWith('/permission') && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('[]'); return; }
    res.writeHead(404).end();
  }).listen(port, '127.0.0.1');
}
const foreign = () => { if (env.FAKE_OC_FOREIGN) for (const s of streams) s.write('data: ' + JSON.stringify({ payload: JSON.parse(env.FAKE_OC_FOREIGN) }) + '\\n\\n'); };

const lines = fs.readFileSync(env.FAKE_OC_FIXTURE, 'utf8').trim().split('\\n').map((l) => JSON.parse(l)).filter((l) => l.dir === 'send' || l.dir === 'recv');
let at = 0;
const ids = new Map();
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
function play() {
  while (at < lines.length && lines[at].dir === 'recv') {
    const m = { ...lines[at].msg };
    if (m.method === undefined && m.id !== undefined && ids.has(m.id)) m.id = ids.get(m.id);
    out(m);
    at++;
  }
}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.method === 'session/prompt' && env.FAKE_OC_FOREIGN) { setTimeout(foreign, 50); return; }
  let j = at;
  if (m.method !== undefined) {
    while (j < lines.length && !(lines[j].dir === 'send' && lines[j].msg.method === m.method)) j++;
    if (j >= lines.length) { if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
    if (m.id !== undefined) ids.set(lines[j].msg.id, m.id);
  } else {
    while (j < lines.length && !(lines[j].dir === 'send' && lines[j].msg.method === undefined && lines[j].msg.id === m.id)) j++;
    if (j >= lines.length) return;
  }
  at = j + 1;
  play();
}).on('close', () => {
  // \`FAKE_OC_SLOW_EXIT\` (ms): as the real CLI can, end the event stream at once (a reset) and exit only later.
  const slow = Number(env.FAKE_OC_SLOW_EXIT || 0);
  if (!slow) process.exit(0);
  for (const s of streams) s.destroy();
  setTimeout(() => process.exit(0), slow);
});
`;

/** Writes the stand-in to `path`, executable. */
export function writeFakeOpencode(path: string): string {
  writeFileSync(path, FAKE_OPENCODE, { mode: 0o755 });
  return path;
}
