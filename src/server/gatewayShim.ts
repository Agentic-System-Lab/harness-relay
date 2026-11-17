/*
 * The MCP server every CLI starts for Harness Relay's own tools (`gateway.ts`): a small program the
 * server writes into its data folder at startup (`gateway/relay-mcp.mjs`), so the same file works in
 * `npm start`, `npm run dev` and the desktop app. It speaks MCP over stdio (newline-delimited JSON-RPC)
 * to the CLI and passes `tools/list` and `tools/call` to the server over a local socket (a Unix socket,
 * a named pipe on Windows), named by `RELAY_GATEWAY_SOCKET`, after showing the token of its turn,
 * read from the file `RELAY_GATEWAY_TOKEN_FILE` names (in the server's own temporary folder, which
 * sandboxed commands cannot read). It holds no credentials and decides nothing: the server does.
 * Plain JavaScript with Node's built-ins only, as Node runs it directly.
 */

/** MCP versions it answers in; a client asking for another gets the newest. */
export const GATEWAY_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

/** The longest call the shim passes on (its arguments as JSON): a mail's body fits many times over. */
export const GATEWAY_MAX_CALL = 1024 * 1024;

export const GATEWAY_SHIM_SOURCE = `// Harness Relay's MCP gateway (written by the server; do not edit).
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const PROTOCOLS = ${JSON.stringify(GATEWAY_PROTOCOLS)};
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let token = '';
try {
  token = readFileSync(process.env.RELAY_GATEWAY_TOKEN_FILE || '', 'utf8').trim();
} catch {
  /* the turn is over: every call fails below */
}

// The server: one request at a time is enough for a CLI, but answers are matched by id anyway.
let next = 1;
const waiting = new Map();
let buffer = '';
let open = false;
const queued = [];
const sock = connect(process.env.RELAY_GATEWAY_SOCKET || '');
sock.setEncoding('utf8');
sock.on('connect', () => {
  sock.write(JSON.stringify({ token }) + '\\n');
  open = true;
  for (const line of queued.splice(0)) sock.write(line);
});
sock.on('data', (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf('\\n'); i >= 0; i = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const done = waiting.get(msg.id);
    if (!done) continue;
    waiting.delete(msg.id);
    done(msg);
  }
});
const gone = () => {
  open = false;
  for (const done of waiting.values()) done({ error: 'Harness Relay is not reachable' });
  waiting.clear();
};
sock.on('error', gone);
sock.on('close', gone);

function ask(method, params) {
  return new Promise((resolve) => {
    if (sock.destroyed) return resolve({ error: 'Harness Relay is not reachable' });
    const id = next++;
    const line = JSON.stringify({ id, method, ...params }) + '\\n';
    if (line.length > ${GATEWAY_MAX_CALL}) return resolve({ error: 'The call is too large' });
    waiting.set(id, resolve);
    if (open) sock.write(line);
    else queued.push(line);
  });
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // a notification: nothing to answer
  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[PROTOCOLS.length - 1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'relay', title: 'Harness Relay', version: '1' },
      },
    });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    const r = await ask('list', {});
    return r.error ? fail(id, -32603, r.error) : send({ jsonrpc: '2.0', id, result: { tools: r.result.tools } });
  }
  if (method === 'tools/call') {
    const r = await ask('call', { name: params && params.name, arguments: (params && params.arguments) || {} });
    if (r.error) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.error }], isError: true } });
    return send({ jsonrpc: '2.0', id, result: r.result });
  }
  fail(id, -32601, 'Method not found: ' + method);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (let i = input.indexOf('\\n'); i >= 0; i = input.indexOf('\\n')) {
    const line = input.slice(0, i).trim();
    input = input.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    handle(msg).catch((err) => fail(msg && msg.id !== undefined ? msg.id : null, -32603, String((err && err.message) || err)));
  }
});
process.stdin.on('end', () => {
  sock.end();
  process.exit(0);
});
`;
