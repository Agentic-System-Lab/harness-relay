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
 * - `--json sb view <ref> --no-open …`: a viewer link on a local port, view-only when asked;
 * - `sb cp <src> <dst>`: a copy into the sandbox is noted; one out of it writes `from the fake computer`;
 * - `--json cache prune --all` (Settings' Remove Cua): nothing to remove;
 * - `--json images info linux`: the desktop image's catalog entry (its reference, what a pull downloads);
 * - `--json image pull <ref>` (Settings' download of the desktop image): with `CUA_LOG` asking for its
 *   Docker client's lines (`bollard::read=debug`), the engine's pull stream as cua logs it, three layers
 *   over about three seconds, then what was pulled; it fails while `$CUA_HOME/fake-cua-pull.json` says
 *   `{"fail":"…"}`, with those words, as cua does;
 * - `mcp --sandbox <ref> --permissions computer:all`: an MCP server over stdio with the computer tools.
 *   Its screenshot is a real PNG, 1200 by 750, whose colour changes with each input, so a frame shows
 *   what was done; each tool call goes to the log.
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
  let step = 0;
  const tick = () => {
    step++;
    for (const [id, size] of LAYERS) {
      const done = Math.min(size, Math.round((size * step) / steps));
      say({ status: 'Downloading', progressDetail: { current: done, total: size }, id });
      if (step === steps) say({ status: 'Download complete', progressDetail: { hidecounts: true }, id });
    }
    if (step < steps) return void setTimeout(tick, 200);
    for (const [id] of LAYERS) say({ status: 'Pull complete', progressDetail: { hidecounts: true }, id });
    say({ status: `Digest: ${DIGEST}` });
    const reference = `${ref.replace(/:[^:/]+$/, '')}@${DIGEST}`;
    process.stdout.write(JSON.stringify({ kind: 'container', location: reference, reference, size_bytes: 1_000_000_000 }) + '\n');
  };
  setTimeout(tick, 200);
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

/** `cua mcp`: newline-delimited JSON-RPC on stdio, the computer tools. */
function mcp(ref) {
  const name = nameOf(ref);
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
  if (cmd === 'cache' && sub === 'prune') return out({ gc: { freed: 0, removed: [] }, reaped: [] });
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
    case 'view':
      if (!sandbox(name)) return fail(`not found: sandbox ${name}`);
      return out({
        name: `local:${name}`,
        url: `http://127.0.0.1:41999/viewer/#ticket=e2e${args.includes('--view-only') ? '&view=1' : ''}`,
        expires_at_unix: Math.floor(Date.now() / 1000) + 1800,
      });
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
