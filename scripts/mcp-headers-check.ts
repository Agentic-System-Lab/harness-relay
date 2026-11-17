/**
 * Whether a CLI keeps the headers of an HTTP MCP server it is given in memory only, as Harness Relay's
 * gateway over loopback HTTP needs (#88, `GATEWAY_OVER_HTTP` in `src/server/gateway.ts`): the turn's
 * token travels in such a header, and a CLI that writes it to a file (a session, a log, a config it
 * keeps) would hand it to the commands it runs.
 *
 *   npx tsx scripts/mcp-headers-check.ts <provider> [--bin <path>]
 *
 * It starts the CLI as it is signed in on this computer (its own home), in a scratch project, and gives
 * it an MCP server on 127.0.0.1 (a stand-in that answers `initialize` and `tools/list`) with a marker in
 * its `Authorization` header: in an ACP session (`session/new`, then `session/load` with it again) or
 * in Codex's thread config (`thread/start`, a turn, which may fail without a model, then
 * `thread/resume`). Then it reads every file written while it ran, in the home folder, the system's
 * temporary folder and the project, and lists those that hold the marker. It passes when the CLI sent
 * the header and no file holds it. It sends no prompt to a model but Codex's one turn ("hi"). It runs the
 * CLI as you do, in its own home: Harness Relay's runs move those folders (to the member's own), not what
 * the CLI writes in them.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { runProcess } from '../src/server/process';

const ACP_ARGS: Record<string, string[]> = {
  opencode: ['acp'],
  goose: ['acp'],
  openhands: ['acp'],
  grok: ['agent', '--no-leader', 'stdio'],
  copilot: ['--acp'],
  cursor: ['acp'],
  antigravity: ['acp'],
  muse: ['acp'],
};
const BINS: Record<string, string> = { cursor: 'cursor-agent', antigravity: 'agy', codex: 'codex' };

const argv = process.argv.slice(2);
const provider = argv[0];
if (!provider || (!ACP_ARGS[provider] && provider !== 'codex')) {
  console.error(`Usage: npx tsx scripts/mcp-headers-check.ts <${[...Object.keys(ACP_ARGS), 'codex'].join('|')}> [--bin <path>]`);
  process.exit(2);
}
const bin = argv.includes('--bin') ? argv[argv.indexOf('--bin') + 1]! : (BINS[provider] ?? provider);

const MARK = `RELAY-HEADER-CHECK-${randomBytes(8).toString('hex')}`;
const project = realpathSync(mkdtempSync(join(tmpdir(), 'relay-mcp-check-')));
const cwd = join(project, 'project');
mkdirSync(cwd);

// The stand-in MCP server: Streamable HTTP, answered with JSON.
let requests = 0;
let withMark = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    requests++;
    if (String(req.headers.authorization ?? '').includes(MARK)) withMark++;
    if (req.method !== 'POST') return void res.writeHead(405).end();
    let msg: { id?: number | string; method?: string } = {};
    try {
      msg = JSON.parse(body);
    } catch {
      return void res.writeHead(400).end();
    }
    if (msg.id === undefined) return void res.writeHead(202).end();
    const result =
      msg.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'header-check', version: '1' } }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'hello', description: 'Says hello', inputSchema: { type: 'object', properties: {} } }] }
          : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

// The CLI, over JSON-RPC lines on its stdin and stdout.
const started = Date.now();
let child: ChildProcess | undefined;
let seq = 0;
const waiting = new Map<number, (m: Record<string, any>) => void>();
const stop = new AbortController();
const exited = runProcess({
  bin,
  args: provider === 'codex' ? ['app-server'] : ACP_ARGS[provider]!,
  cwd,
  env: process.env,
  keepStdinOpen: true,
  signal: stop.signal,
  timeoutMs: 180_000,
  onSpawn: (c) => (child = c),
  onLine: (line) => {
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined && waiting.has(m.id)) {
      waiting.get(m.id)!(m);
      waiting.delete(m.id);
    } else if (m.id !== undefined && m.method) {
      // A question of the CLI's own (a permission): declined.
      child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } })}\n`);
    }
  },
}).catch((err: Error) => ({ code: null, error: err.message }));
const call = (method: string, params: unknown, ms = 60_000) =>
  new Promise<Record<string, any>>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => resolve({ error: { message: `no answer to ${method}` } }), ms);
  });
const notify = (method: string) => child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const said = (what: string, r: Record<string, any>) => console.log(`${what}: ${r.error ? `refused (${r.error.message})` : 'ok'}`);

await pause(300);
if (provider === 'codex') {
  said('initialize', await call('initialize', { clientInfo: { name: 'header_check', title: 'Header check', version: '0.1.0' } }));
  notify('initialized');
  const config = { mcp_servers: { relay: { url, http_headers: { Authorization: `Bearer ${MARK}` } } } };
  const thread = { cwd, approvalPolicy: 'never', sandbox: 'read-only', config };
  const t = await call('thread/start', thread);
  said('thread/start', t);
  const threadId = t.result?.thread?.id;
  if (threadId) {
    await pause(3000);
    said('turn/start', await call('turn/start', { threadId, input: [{ type: 'text', text: 'hi' }] }));
    await pause(8000);
    said('thread/resume', await call('thread/resume', { threadId, ...thread }));
    await pause(3000);
  }
} else {
  const init = await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  said('initialize', init);
  console.log(
    `  ${JSON.stringify(init.result?.agentInfo ?? {})}, mcpCapabilities ${JSON.stringify(init.result?.agentCapabilities?.mcpCapabilities ?? {})}`,
  );
  const mcpServers = [{ type: 'http', name: 'relay', url, headers: [{ name: 'Authorization', value: `Bearer ${MARK}` }] }];
  const s = await call('session/new', { cwd, mcpServers });
  said('session/new', s);
  if (s.result?.sessionId) {
    await pause(4000);
    if (init.result?.agentCapabilities?.loadSession)
      said('session/load', await call('session/load', { sessionId: s.result.sessionId, cwd, mcpServers }));
    await pause(3000);
  }
}
child?.stdin?.end();
stop.abort();
await exited;
server.close();

// Every file written while it ran.
// Every folder of the home but these (a CLI's caches and macOS's Library included: a header there is a header on disk).
const SKIP = new Set(['node_modules', '.git', '.Trash', 'proc']);
const holding: string[] = [];
let read = 0;
const walk = (dir: string, depth = 0) => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP.has(name) || depth > 12) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (st.isFile() && st.mtimeMs >= started - 1000 && st.size < 200e6) {
      read++;
      try {
        if (readFileSync(p).includes(MARK)) holding.push(p);
      } catch {
        /* unreadable */
      }
    }
  }
};
for (const root of new Set([homedir(), tmpdir(), project])) walk(root);
rmSync(project, { recursive: true, force: true });

console.log(`MCP requests: ${requests}, with the header: ${withMark}; files written while it ran: ${read}`);
console.log(holding.length ? `Files holding the header:\n${holding.map((p) => `  ${p}`).join('\n')}` : 'No file holds the header.');
const ok = withMark > 0 && holding.length === 0;
console.log(
  ok ? 'PASS' : withMark === 0 ? 'FAIL: the CLI never sent the header (did it connect?)' : 'FAIL: the header was written to a file',
);
process.exit(ok ? 0 : 1);
