'use strict';
/*
 * A stand-in for Cua's command-line tool (`cua`), which starts the chats' computers (`src/server/computer/`),
 * for the end-to-end tests. `e2e/support/fake-cli.ts` builds it as `cua-fake/cua` beside the fake CLIs (a
 * script on macOS and Linux; on Windows their single executable, named `cua`), off the PATH: a spec that
 * wants Cua installed links it into the server's own Cua folder (`<data>/clis/cua/`), as Settings' install
 * would put it. It never starts a container.
 *
 * It answers what Harness Relay asks of cua:
 * - `--version`: `cua 0.31.2`;
 * - `--json runtime doctor`: a container engine, ready;
 * - `--json sb info <ref>`, `--json sb ls --local --no-size`: its sandboxes, kept as files in
 *   `$CUA_HOME/fake-cua/<name>.json`; `info` of one it does not have fails, as cua does;
 * - `--json sb create linux --name <name> --wait desktop [--runtime runc]`: makes one, running;
 * - `sb suspend|resume|restart|rm <ref> [--force]`: changes or deletes it;
 * - `--json sb view <ref> --no-open …`: a link to its viewer (below), its ticket with input or, with
 *   `--view-only`, to watch only;
 * - `sb cp <src> <dst>`: a copy into the sandbox is noted; one out of it writes `from the fake computer`;
 * - `--json cache prune --all` (Settings' Remove Cua): nothing to remove;
 * - `--json images info linux`: the desktop image's catalog entry (its reference, what a pull downloads);
 * - `--json image pull <ref>` (Settings' download of the desktop image): with `CUA_LOG` asking for its
 *   Docker client's lines (`bollard::read=debug`), the engine's pull stream as cua logs it, three layers
 *   over about three seconds (`{"stepMs":…}` in `$CUA_HOME/fake-cua-pull.json` slows it), then what was
 *   pulled; it fails while that file says `{"fail":"…"}`, with those words, as cua does;
 * - `--json cache ls --category docker-images`: the desktop image once a pull or a create brought it, until
 *   `cache prune` clears it;
 * - `mcp --sandbox <ref> --permissions computer:all`: an MCP server over stdio with the computer tools.
 *   Its screenshot is a real PNG, 1200 by 750, whose colour changes with each input, so a frame shows
 *   what was done; each tool call goes to the log. Beside it, as cua-spacesd serves one, the computer's
 *   viewer on a loopback port of its own (`viewer()`), which `sb view` links to.
 * Each start and each tool call goes to the test's fake log (`cli: 'cua'`), for the tests to read.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/*
 * Harness Relay gives cua only a few of its variables (`cuaEnv()`), never E2E_FAKE_LOG: what it gives is
 * the Cua home, `$CUA_HOME`, which is `.cua` in the test's own home (`<test>/home/.cua`). Its sandboxes are
 * kept there, and its lines go to the test's log, `<test>/fake-cli.jsonl`, two folders up.
 */
const HOME = process.env.CUA_HOME;
// `--version` (Harness Relay's check that it is cua) runs without it: nothing is kept then.
const LOG = process.env.E2E_FAKE_LOG || (HOME ? path.join(HOME, '..', '..', 'fake-cli.jsonl') : undefined);
const STATE = HOME ? path.join(HOME, 'fake-cua') : undefined;
/** Where each computer's viewer says its port (`<name>.port`): apart from its sandboxes, which `sb ls` reads. */
const VIEWERS = HOME ? path.join(HOME, 'fake-cua-viewers') : undefined;
const args = process.argv.slice(2);

function log(entry) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ cli: 'cua', pid: process.pid, at: Date.now(), ...entry }) + '\n');
}

const nameOf = (ref) => String(ref ?? '').replace(/^local:/, '');
const file = (name) => path.join(STATE, `${name}.json`);
function sandbox(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return undefined;
  }
}
function save(name, state) {
  fs.mkdirSync(STATE, { recursive: true });
  const s = { id: `local:${name}`, name, kind: 'container', location: 'local', runtime: 'runc', ...state };
  fs.writeFileSync(file(name), JSON.stringify(s));
  return s;
}
const running = { state: 'running', status: 'ready', endpoints: { env: 'http://127.0.0.1:41999' }, services: { env: 3211 } };

/** The desktop image's layers in the fake pull, and their sizes (bytes). */
const LAYERS = [
  ['1e6e7ca511b9', 48_000_000],
  ['db1d5603818e', 64_000_000],
  ['0db1ede1885b', 212_000_000],
];
const DESKTOP = 'ghcr.io/trycua/linux:24.04';
const DIGEST = 'sha256:' + '3c'.repeat(32);
/** Whether the desktop image is here (a pull or a create brought it), kept as a file in the Cua home. */
const PULLED = () => path.join(HOME, 'fake-cua-image');
const bringImage = () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(PULLED(), DIGEST);
};

/** `cua image pull`: the engine's pull stream on stderr as cua logs it at debug (when asked), then the result. */
function pull(ref) {
  let steer = {};
  try {
    steer = JSON.parse(fs.readFileSync(path.join(HOME, 'fake-cua-pull.json'), 'utf8'));
  } catch {
    // pulls as asked
  }
  if (steer.fail) {
    process.stderr.write(`cua: provider not configured: ${steer.fail}\n`);
    process.exit(4);
  }
  const debug = /bollard::read=debug/.test(process.env.CUA_LOG ?? '');
  const at = () => new Date().toISOString();
  const say = (event) => {
    if (debug)
      process.stderr.write(
        `\x1b[2m${at()}\x1b[0m \x1b[34mDEBUG\x1b[0m \x1b[2mbollard::read\x1b[0m\x1b[2m:\x1b[0m Decoding JSON line from stream: ${JSON.stringify(event)}\r\n`,
      );
  };
  if (/(^|,)info\b/.test(process.env.CUA_LOG ?? ''))
    process.stderr.write(
      `\x1b[2m${at()}\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mcua_vmm::container\x1b[0m\x1b[2m:\x1b[0m pulling image \x1b[3mimage\x1b[0m\x1b[2m=\x1b[0m"${ref.replace(/:[^:/]+$/, '')}@${DIGEST}"\n`,
    );
  say({ status: 'Pulling from trycua/linux', id: `${ref.replace(/:[^:/]+$/, '')}@${DIGEST}` });
  for (const [id] of LAYERS) say({ status: 'Pulling fs layer', progressDetail: {}, id });
  // The configuration, a blob that is not a layer.
  say({ status: 'Download complete', progressDetail: { hidecounts: true }, id: 'fd18d7b2aa35' });
  const steps = 15;
  const stepMs = Number(steer.stepMs) || 200;
  let step = 0;
  const tick = () => {
    step++;
    for (const [id, size] of LAYERS) {
      const done = Math.min(size, Math.round((size * step) / steps));
      say({ status: 'Downloading', progressDetail: { current: done, total: size }, id });
      if (step === steps) say({ status: 'Download complete', progressDetail: { hidecounts: true }, id });
    }
    if (step < steps) return void setTimeout(tick, stepMs);
    for (const [id] of LAYERS) say({ status: 'Pull complete', progressDetail: { hidecounts: true }, id });
    say({ status: `Digest: ${DIGEST}` });
    const reference = `${ref.replace(/:[^:/]+$/, '')}@${DIGEST}`;
    bringImage();
    process.stdout.write(JSON.stringify({ kind: 'container', location: reference, reference, size_bytes: 1_000_000_000 }) + '\n');
  };
  setTimeout(tick, stepMs);
}

/** A PNG of one colour, `w` by `h`. */
function png(w, h, [r, g, b]) {
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const COLOURS = [
  [24, 34, 52],
  [30, 90, 140],
  [40, 120, 80],
  [140, 60, 40],
  [110, 40, 120],
];

/*
 * The computer's viewer, as cua-spacesd serves Cua's: its page (whose policy runs only its own origin's
 * scripts), which keeps the link's ticket in its storage and takes it out of the address, its gRPC-web calls
 * with the ticket in `x-cua-env-authorization`, OpenMedia's answer with the stream's address as a protobuf
 * string, and the stream (`rcdp.v2`), whose first message says whether its ticket takes input. The page sends
 * each key pressed on its stream, whatever its ticket (Cua would drop a watcher's); the viewer logs each call
 * with the kind of ticket it came with, and each key with its stream's: the tests see what reached it.
 */
const VIEWER_PAGE =
  '<!doctype html>\n<html lang="en">\n<head>\n<title>Cua viewer</title>\n<script type="module" src="./viewer.js"></script>\n</head>\n<body><p id="status">connecting</p></body>\n</html>\n';
const VIEWER_SCRIPT = `const key = 'cua.viewer.ticket:' + location.origin + '/';
const hash = new URLSearchParams(location.hash.slice(1));
let ticket = hash.get('ticket');
if (ticket) {
  sessionStorage.setItem(key, ticket);
  hash.delete('ticket');
  history.replaceState(null, '', location.pathname + '#' + hash);
} else ticket = sessionStorage.getItem(key);
document.title = 'Cua viewer, clipboard ' + hash.get('clipboard');
const status = document.getElementById('status');
const call = (name) =>
  fetch('/cua.env.v1.' + name, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-cua-env-authorization': 'Bearer ' + ticket },
    credentials: 'omit',
    body: new Uint8Array(5),
  });
let socket;
addEventListener('keydown', (e) => socket?.readyState === 1 && socket.send('key:' + e.key));
const open = async () => {
  const answer = await call('StreamService/OpenMedia');
  if (!answer.ok) return void (status.textContent = 'refused ' + answer.status);
  const text = new TextDecoder('latin1').decode(await answer.arrayBuffer());
  const where = /\\/media\\?ticket=[A-Za-z0-9._~-]+/.exec(text)[0];
  socket = new WebSocket(new URL(where, location.href).href.replace(/^http/, 'ws'), ['rcdp.v2']);
  socket.onmessage = (e) => (status.textContent = 'streaming ' + e.data);
  socket.onclose = (e) => {
    status.textContent = 'closed ' + e.code;
    if (e.code === 4401 || e.code === 1006) setTimeout(open, 300);
  };
};
call('SystemService/GetCapabilities').then(open);
`;

function viewer(name) {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const policy = {
    'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    'access-control-allow-origin': '*',
  };
  let streams = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'GET' && req.url === '/viewer/') {
      log({ viewer: 'page', cookie: Boolean(req.headers.cookie), sandbox: name });
      return res.writeHead(200, { ...policy, 'content-type': 'text/html; charset=utf-8' }).end(VIEWER_PAGE);
    }
    if (req.method === 'GET' && req.url === '/viewer/viewer.js')
      return res.writeHead(200, { ...policy, 'content-type': 'text/javascript; charset=utf-8' }).end(VIEWER_SCRIPT);
    const call = /^\/cua\.env\.v1\.(\w+\/\w+)$/.exec(req.url ?? '')?.[1];
    if (req.method !== 'POST' || !call) return res.writeHead(404).end();
    const kind = /^Bearer e2e-(input|watch)-\d+$/.exec(String(req.headers['x-cua-env-authorization'] ?? ''))?.[1];
    log({ viewer: 'call', call, ticket: kind ?? 'none', cookie: Boolean(req.headers.cookie), sandbox: name });
    if (!kind) return res.writeHead(401).end();
    if (call !== 'StreamService/OpenMedia')
      return res.writeHead(200, { 'content-type': 'application/grpc-web+proto' }).end(Buffer.alloc(5));
    const where = Buffer.from(`/media?ticket=e2e.${kind}.${++streams}`);
    // Its field (4, a string), then another (5, a varint), as Cua's answer has more after it.
    const message = Buffer.concat([Buffer.from([0x22, where.length]), where, Buffer.from([0x28, 0x01])]);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(message.length, 1);
    res.writeHead(200, { 'content-type': 'application/grpc-web+proto' }).end(Buffer.concat([head, message]));
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => undefined);
    const kind = /^\/media\?ticket=e2e\.(input|watch)\.\d+$/.exec(req.url ?? '')?.[1];
    if (!kind) return socket.destroy();
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: rcdp.v2\r\n\r\n`,
    );
    socket.write(Buffer.concat([Buffer.from([0x81, kind.length]), Buffer.from(kind)]));
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        const op = buf[0] & 0x0f;
        const len = buf[1] & 0x7f;
        if (len > 125 || buf.length < 6 + len) break;
        const mask = buf.subarray(2, 6);
        const text = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
        buf = buf.subarray(6 + len);
        if (op === 1) log({ viewer: 'input', text, ticket: kind, sandbox: name });
        else if (op === 8) socket.end();
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    fs.mkdirSync(VIEWERS, { recursive: true });
    fs.writeFileSync(path.join(VIEWERS, `${name}.port`), String(server.address().port));
  });
}

/** `cua mcp`: newline-delimited JSON-RPC on stdio, the computer tools; and the computer's viewer beside it. */
function mcp(ref) {
  const name = nameOf(ref);
  viewer(name);
  let inputs = 0;
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const text = (id, t, isError = false) => reply(id, { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const tools = [
    'computer_screenshot',
    'computer_click',
    'computer_double_click',
    'computer_move_cursor',
    'computer_type',
    'computer_key',
    'computer_hotkey',
    'computer_scroll',
    'computer_drag',
    'computer_launch',
    'computer_shell',
  ];
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id === undefined) continue;
      if (m.method === 'initialize')
        reply(m.id, {
          protocolVersion: m.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'cua', version: '0.31.2' },
        });
      else if (m.method === 'tools/list') reply(m.id, { tools: tools.map((t) => ({ name: t, inputSchema: { type: 'object' } })) });
      else if (m.method === 'tools/call') {
        const tool = m.params?.name;
        const a = m.params?.arguments ?? {};
        log({ tool, arguments: a, sandbox: name });
        if (sandbox(name)?.state !== 'running') text(m.id, `error: invalid argument: sandbox ${name} is not running`, true);
        else if (tool === 'computer_screenshot')
          reply(m.id, {
            content: [{ type: 'image', data: png(1200, 750, COLOURS[inputs % COLOURS.length]).toString('base64'), mimeType: 'image/png' }],
          });
        else if (tool === 'computer_shell') text(m.id, `ran: ${a.command}\n[exit 0]`);
        else if (tools.includes(tool)) {
          inputs++;
          text(m.id, JSON.stringify({ success: true, message: tool.replace('computer_', '') }));
        } else text(m.id, `unknown tool ${tool}`, true);
      } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not faked' } }) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function main() {
  log({ args });
  const json = args[0] === '--json';
  const rest = json ? args.slice(1) : args;
  const [cmd, sub, ...more] = rest;
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  const fail = (message, code = 1) => {
    process.stderr.write(`cua: ${message}\n`);
    process.exit(code);
  };
  if (args[0] === '--version') return process.stdout.write('cua 0.31.2\n');
  if (!STATE) return fail('CUA_HOME is not set');
  if (cmd === 'runtime' && sub === 'doctor')
    return out({ backends: [{ backend: 'container', ready: true, detail: 'Fake container engine', missing: [], provisionable: false }] });
  if (cmd === 'mcp') return mcp(rest[rest.indexOf('--sandbox') + 1]);
  if (cmd === 'cache' && sub === 'prune') {
    fs.rmSync(PULLED(), { force: true });
    return out({ gc: { freed: 0, removed: [] }, reaped: [] });
  }
  if (cmd === 'cache' && sub === 'ls')
    return out(
      fs.existsSync(PULLED())
        ? [{ name: `ghcr.io/trycua/linux@${DIGEST}`, category: 'docker-images', kind: 'pulled-image', orphan: false }]
        : [],
    );
  if (cmd === 'images' && sub === 'info' && more[0] === 'linux')
    return out({
      ref: DESKTOP,
      os: 'linux',
      sizes: { platforms: ['amd64', 'arm64'].map((arch) => ({ arch, download: 324_000_000 })) },
    });
  if ((cmd === 'image' || cmd === 'img') && sub === 'pull') {
    log({ pull: more[0], cuaLog: process.env.CUA_LOG ?? '' });
    return pull(more[0]);
  }
  if (cmd !== 'sb' && cmd !== 'sandbox') return fail(`not faked: ${args.join(' ')}`);
  const name = nameOf(more.find((a) => !a.startsWith('-')));
  switch (sub) {
    case 'info': {
      const s = sandbox(name);
      return s ? out(s) : fail(`not found: sandbox ${name}`);
    }
    case 'ls':
      fs.mkdirSync(STATE, { recursive: true });
      return out(fs.readdirSync(STATE).map((f) => JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8'))));
    case 'create': {
      const created = rest[rest.indexOf('--name') + 1];
      bringImage();
      return out(save(created, { ...running, image: 'ghcr.io/trycua/linux:24.04' }));
    }
    case 'suspend':
    case 'resume':
    case 'restart': {
      const s = sandbox(name);
      if (!s) return fail(`not found: sandbox ${name}`);
      save(name, sub === 'suspend' ? { state: 'suspended', status: 'stopped' } : running);
      return process.stdout.write(`Sandbox 'local:${name}' is ${sub === 'suspend' ? 'suspending' : 'resuming'}.\n`);
    }
    case 'rm': {
      if (!sandbox(name)) return fail(`not found: sandbox ${name}`);
      fs.rmSync(file(name), { force: true });
      return process.stdout.write(`Sandbox 'local:${name}' is being deleted.\n`);
    }
    case 'view': {
      if (!sandbox(name)) return fail(`not found: sandbox ${name}`);
      let port;
      try {
        port = fs.readFileSync(path.join(VIEWERS, `${name}.port`), 'utf8');
      } catch {
        return fail(`sandbox ${name} has no viewer running`);
      }
      const watch = args.includes('--view-only');
      // As Cua's own link has them: watching, `clipboard=0` first (the page reads the first).
      return out({
        name: `local:${name}`,
        url: `http://127.0.0.1:${port}/viewer/#ticket=e2e-${watch ? 'watch' : 'input'}-${Date.now()}${watch ? '&clipboard=0' : ''}&clipboard=view`,
        expires_at_unix: Math.floor(Date.now() / 1000) + 1800,
      });
    }
    case 'cp': {
      const [from, to] = more;
      if (/^local:[^:]+:\//.test(from)) fs.writeFileSync(to, 'from the fake computer');
      return process.stdout.write(`${from} -> ${to}\n`);
    }
    default:
      return fail(`not faked: ${args.join(' ')}`);
  }
}

main();
