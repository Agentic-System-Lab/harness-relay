/*
 * Real checks of Harness Relay's own sandbox (src/server/relaySandbox.ts) on this computer: what a
 * sandboxed process can and cannot write, read and reach, in read-only and edit mode, with each HTTP
 * client, two runs at once, and what is left once a run is stopped or the server is gone. Not part of
 * `npm test` (it starts real sandboxes and reaches the network).
 *
 *   npx tsx scripts/sandbox-check.ts            # everything; a table, exit 1 on a failed check
 *   npx tsx scripts/sandbox-check.ts --only net # checks whose name holds "net"
 *
 * Everything it makes is in a fresh folder it creates (mkdtemp) in the system's temporary folder, or
 * inside $SANDBOX_CHECK_DIR when set (that folder itself is never written to or removed), and only that
 * fresh folder is removed at the end, unless --keep. It runs nothing in, and never removes, any other
 * folder: not the checkout it is run from, not its git data, not the home folder. Programs it does not find (bun, a Rust client named by
 * $RUST_CLIENT) are reported as skipped. It stops only processes it started, by PID.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequest } from '../src/server/agents/types';
import type { ApprovalAnswer } from '../src/shared/types';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
const keep = argv.includes('--keep');

// Always a fresh folder of its own: $SANDBOX_CHECK_DIR is only where it goes, never the folder removed.
// In /tmp by default: the data folder's path must leave room for sandbox-runtime's sockets in it
// (`HOST_TMP_MAX`), and macOS's own temp folder is too deep for that.
const scratch = realpathSync(mkdtempSync(join(process.env.SANDBOX_CHECK_DIR || '/tmp', 'relay-sbx-check-')));
const dataDir = join(scratch, 'data');
mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 });
writeFileSync(join(dataDir, 'relay.db'), 'RELAY-DB-STAND-IN');
// The key the secrets in the database are encrypted with when there is no credential store.
writeFileSync(join(dataDir, 'secrets.key'), 'RELAY-KEY-STAND-IN', { mode: 0o600 });
process.env.RELAY_DATA_DIR = dataDir;

const relayStub = createServer((_q, r) => r.end('RELAY-API'));
const relayPort: number = await new Promise((resolve) => relayStub.listen(0, '127.0.0.1', () => resolve((relayStub.address() as { port: number }).port)));
process.env.PORT = String(relayPort);

const rs = await import('../src/server/relaySandbox');
const { runProcess, killTree } = await import('../src/server/process');

const HOME = homedir();
const node = process.execPath;
const which = (n: string) => spawnSync('/bin/sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim() || undefined;
const bun = which('bun');
const python = which('python3');
const pyHas = (m: string) => Boolean(python && spawnSync(python, ['-c', `import ${m}`]).status === 0);
const rustClient = process.env.RUST_CLIENT && existsSync(process.env.RUST_CLIENT) ? process.env.RUST_CLIENT : undefined;
const ownIp = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

// What the checks work on.
const cwdRo = join(scratch, 'project-ro');
const cwdEdit = join(scratch, 'project-edit');
const state = join(scratch, 'agent-state');
const configFile = join(scratch, 'agent-config', 'config.json');
const outside = join(scratch, 'outside');
const sshLike = join(scratch, 'ssh-like');
const browser = join(scratch, 'browser-profile');
const secret = join(scratch, 'secret.key');
for (const d of [cwdRo, cwdEdit, state, join(scratch, 'agent-config'), outside, sshLike, browser]) mkdirSync(d, { recursive: true });
writeFileSync(configFile, '{"safe":true}\n');
writeFileSync(join(outside, 'f'), 'OUT\n');
writeFileSync(join(sshLike, 'id'), 'KEY\n');
writeFileSync(join(browser, 'Cookies'), 'COOKIES\n');
writeFileSync(secret, 'SECRET\n');
writeFileSync(join(cwdRo, 'README'), 'read me\n');
spawnSync('git', ['init', '-q', cwdEdit]);

const env: NodeJS.ProcessEnv = {
  PATH: [join(node, '..'), bun && join(bun, '..'), python && join(python, '..'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
  HOME,
  LANG: 'en_US.UTF-8',
};

type Spec = import('../src/server/relaySandbox').RelaySandboxSpec;
function baseSpec(permission: Spec['permission'], over: Partial<Spec> = {}): Spec {
  return {
    permission,
    cwd: permission === 'edit' ? cwdEdit : cwdRo,
    writable: [state],
    readOnly: [configFile],
    protectedPaths: [browser, secret],
    allowedHosts: ['example.com'],
    // As real runs have it: other runs' temp folders hidden (open.ts passes this and its agent homes).
    privateRoots: [rs.relaySandboxRoot(dataDir), rs.relaySandboxHostRoot(dataDir)],
    ...over,
  };
}

interface Outcome {
  code: number | null;
  out: string;
  err: string;
  asked: ApprovalRequest[];
  failure?: string;
}

/** Runs one command in a sandbox for `spec` and returns what it printed and what it was asked about. */
async function run(command: string, spec: Spec, approve?: (r: ApprovalRequest) => ApprovalAnswer): Promise<Outcome> {
  const asked: ApprovalRequest[] = [];
  const cmd = await rs.sandboxCommand('/bin/sh', ['-c', command], env, {
    ...spec,
    // No callback (the conversation refuses automatically) when `approve` is omitted.
    ...(approve ? { requestApproval: async (r: ApprovalRequest) => (asked.push(r), approve(r)) } : { requestApproval: undefined }),
  });
  try {
    const res = await runProcess({ bin: cmd.bin, args: cmd.args, env: cmd.env, cwd: spec.cwd, timeoutMs: 60_000, maxCapture: 1 << 16 });
    return { code: res.code, out: res.stdout, err: res.stderr, asked, failure: cmd.failure() };
  } finally {
    await cmd.dispose();
  }
}

// --- The checks -------------------------------------------------------------------------------
const results: { name: string; ok: boolean; note: string }[] = [];
const skipped: string[] = [];
function check(name: string, ok: boolean, note = '') {
  results.push({ name, ok, note });
  process.stderr.write(`${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? `  — ${note}` : ''}\n`);
}
const uniq = () => randomBytes(4).toString('hex');

async function main() {
  const want = (name: string) => !only || name.includes(only);

  if (want('available')) {
    const a = await rs.sandboxAvailable();
    check('available', a.ok, a.ok ? '' : a.reason);
    if (!a.ok) return;
  }

  // Filesystem: read-only.
  if (want('ro-cwd-write')) {
    const probe = join(cwdRo, `w-${uniq()}`);
    const r = await run(`touch ${probe} 2>&1 || true`, baseSpec('read-only'));
    check('ro: cannot write the working directory', !existsSync(probe), r.out.trim());
  }
  if (want('ro-state-write')) {
    const probe = join(state, `s-${uniq()}`);
    const r = await run(`touch ${probe} && echo WROTE`, baseSpec('read-only'));
    check('ro: can write a state folder', existsSync(probe), r.out.trim());
  }
  if (want('ro-cwd-read')) {
    const r = await run('cat README', baseSpec('read-only'));
    check('ro: can read the working directory', r.out.includes('read me'), r.out.trim().slice(0, 40));
  }

  // Filesystem: edit.
  const editTargets: [string, string, boolean][] = [
    ['working directory', join(cwdEdit, `w-${uniq()}`), true],
    ['home', join(HOME, `relay-nope-${uniq()}`), false],
    ['an ssh-like folder', join(sshLike, `k-${uniq()}`), false],
    ['an outside folder', join(outside, `o-${uniq()}`), false],
    ['the agent config', configFile, false],
  ];
  // Other runs' folders (each conversation member's state): neither readable nor writable, while the
  // run's own folder among them stays both (privateRoots).
  if (want('private-roots')) {
    const priv = join(scratch, 'agent-home', 'private');
    const mine = join(priv, 'conv.mine.a1');
    const theirs = join(priv, 'conv.theirs.a1');
    for (const d of [mine, theirs]) mkdirSync(d, { recursive: true });
    writeFileSync(join(mine, 'session.jsonl'), 'MINE\n');
    writeFileSync(join(theirs, 'session.jsonl'), 'THEIRS\n');
    for (const permission of ['read-only', 'edit'] as const) {
      const spec = baseSpec(permission, { writable: [mine], privateRoots: [priv, rs.relaySandboxRoot(dataDir), rs.relaySandboxHostRoot(dataDir)] });
      const r = await run(
        [
          `cat ${mine}/session.jsonl`,
          `(echo x >> ${mine}/session.jsonl && mkdir -p ${mine}/cache && echo WROTE)`,
          `(cat ${theirs}/session.jsonl 2>/dev/null || echo NO-READ)`,
          `(echo y >> ${theirs}/session.jsonl 2>/dev/null || echo NO-WRITE)`,
          `(ls ${priv} 2>/dev/null || echo NO-LIST)`,
          `(cd ${mine} && pwd -P)`,
        ].join('; '),
        spec,
      );
      check(`private ${permission}: reads and writes its own folder`, r.out.includes('MINE') && r.out.includes('WROTE') && existsSync(join(mine, 'cache')), r.out.trim());
      check(`private ${permission}: cannot read another run's folder`, !r.out.includes('THEIRS') && r.out.includes('NO-READ'), r.out.trim());
      check(`private ${permission}: cannot write another run's folder`, readFileSync(join(theirs, 'session.jsonl'), 'utf8') === 'THEIRS\n', r.out.trim());
      check(`private ${permission}: cannot list the other runs' folders`, !r.out.includes('conv.theirs'), r.out.trim());
    }
  }

  // Goose's layout: the member's config lives in its private state folder, among other members'.
  if (want('private-config')) {
    const priv = join(scratch, 'goose-home', 'private');
    const mine = join(priv, 'conv.mine');
    const cfgDir = join(mine, 'config');
    mkdirSync(join(mine, 'data'), { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.yaml'), 'GOOSE_PROVIDER: relay-stub\n');
    const r = await run(`cat ${cfgDir}/config.yaml; (echo x >> ${cfgDir}/config.yaml) 2>/dev/null || echo NO-WRITE`, baseSpec('read-only', {
      writable: [join(mine, 'data')],
      readOnly: [cfgDir],
      privateRoots: [priv, rs.relaySandboxRoot(dataDir), rs.relaySandboxHostRoot(dataDir)],
    }));
    check('private: a run reads its own config inside the private roots, and cannot write it', r.out.includes('GOOSE_PROVIDER') && r.out.includes('NO-WRITE'), r.out.trim().slice(0, 60));
  }

  for (const target of want('edit-write') ? editTargets : []) {
    const [label, path, allowed] = target;
    const r = await run(`sh -c 'echo x >> "${path}"' 2>&1 || true`, baseSpec('edit'));
    const wrote = label === 'the agent config' ? readText(path).includes('x') : existsSync(path);
    check(`edit: ${allowed ? 'can' : 'cannot'} write ${label}`, wrote === allowed, r.out.trim().slice(-50));
    // Remove what was written: the allowed file, or a probe outside the scratch folder that a failing
    // sandbox let through (a fresh, uniquely named file this run created; never the config file).
    if (wrote && path !== configFile) rmSync(path, { force: true });
  }

  // Reads of protected paths (both modes).
  for (const [label, path] of [
    ['a browser folder', join(browser, 'Cookies')],
    ['a protected file', secret],
    ['the database', join(dataDir, 'relay.db')],
    ["the secrets' key file", join(dataDir, 'secrets.key')],
  ] as [string, string][]) {
    if (!want('protected-read')) break;
    const r = await run(`cat "${path}" 2>&1 || true`, baseSpec('edit'));
    const leaked = /SECRET|COOKIES|RELAY-DB|RELAY-KEY/.test(r.out);
    check(`cannot read ${label}`, !leaked, r.out.trim().slice(0, 40));
  }

  // Network: allowed host, a denied host, a quietly denied host, and the approval path.
  if (want('net-allowed')) {
    const r = await run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com`, baseSpec('read-only'));
    check('net: reaches an allowed host through the proxy (curl)', r.out.trim() === '200', r.out.trim());
  }
  if (want('net-denied-refused')) {
    const r = await run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org 2>&1 || true`, baseSpec('read-only'));
    check('net: a host not allowed is refused when the conversation has no callback', !r.out.includes('200') && r.asked.length === 0, r.out.trim());
  }
  if (want('net-ask-allow')) {
    const r = await run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org`, baseSpec('read-only'), (req) => ({ allow: req.detail === 'example.org' }));
    check('net: a host asked about and allowed reaches it; the ask is tied to this run', r.out.trim() === '200' && r.asked.length === 1 && r.asked[0]!.detail === 'example.org', `${r.out.trim()} asked=${r.asked.map((a) => a.detail).join(',')}`);
  }
  if (want('net-ask-deny')) {
    const r = await run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org 2>&1 || true`, baseSpec('read-only'), () => ({ allow: false, note: 'no' }));
    check('net: a host asked about and declined is refused', !r.out.includes('200') && r.asked.length === 1, r.out.trim());
  }
  if (want('net-quiet')) {
    const r = await run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' https://models.dev 2>&1 || true`, baseSpec('read-only', { quietlyDeniedHosts: ['models.dev'] }), () => ({ allow: true }));
    check('net: a quietly-denied host is refused and never asked', !r.out.includes('200') && r.asked.length === 0, r.out.trim());
  }
  if (want('net-relay')) {
    const r = await run(`curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:${relayPort} 2>&1 || true; curl -sS -m 10 --noproxy '*' -o /dev/null -w ' noproxy=%{http_code}' http://127.0.0.1:${relayPort} 2>&1 || true`, baseSpec('read-only'), () => ({ allow: true }));
    check("net: cannot reach Harness Relay's port, directly or through the proxy", !r.out.includes('200'), r.out.trim());
  }
  if (want('net-own-ip') && ownIp) {
    const r = await run(`curl -sS -m 10 -o /dev/null -w '%{http_code}' http://${ownIp}:${relayPort} 2>&1 || true`, baseSpec('read-only'), () => ({ allow: true }));
    check("net: cannot reach this computer's own address", !r.out.includes('200') && r.asked.length === 0, r.out.trim());
  }
  // A short data folder: the host's temp folder (sandbox-runtime's bridge sockets on Linux) in its
  // hidden `srt/` folder, where the network must still work.
  if (want('net-short-data')) {
    const shortData = mkdtempSync('/tmp/hrd-');
    try {
      const dirs = rs.makeRunDirs(shortData);
      const r = await run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com`, baseSpec('read-only', { dirs, privateRoots: [rs.relaySandboxRoot(shortData), rs.relaySandboxHostRoot(shortData)] }));
      check('net: works when the host temp folder is in the hidden srt folder (short data path)', r.out.trim() === '200', `${dirs.hostTmp.length}-char host temp: ${r.out.trim()}`);
    } finally {
      rmSync(shortData, { recursive: true, force: true });
    }
  }
  // A server of the user's the agent only connects to (Goose's HTTP MCP servers): reachable through the
  // proxy; and on macOS the sandbox may not listen on its port (it could take over one that is down).
  if (want('connect-ports')) {
    const mcp = createServer((_q, r) => r.end('USER-MCP'));
    const mcpPort: number = await new Promise((res) => mcp.listen(0, '127.0.0.1', () => res((mcp.address() as { port: number }).port)));
    const free = await rs.freeLoopbackPort();
    const listen = `node -e 'require("net").createServer().on("error",e=>{console.log("LISTEN-"+e.code);process.exit(0)}).listen(${free},"127.0.0.1",()=>{console.log("LISTEN-OK");process.exit(0)})'`;
    const r = await run(`echo "curl=$(curl -s -m 10 http://127.0.0.1:${mcpPort}/)"; echo "node=$(node -e 'fetch(process.argv[1]).then(r=>r.text()).then(console.log,()=>console.log("ERR"))' http://127.0.0.1:${mcpPort}/)"; ${listen}`, baseSpec('read-only', { connectPorts: [mcpPort, free] }));
    mcp.close();
    check('connect-ports: a server of the user\'s is reached through the proxy (curl, Node)', r.out.includes('curl=USER-MCP') && r.out.includes('node=USER-MCP'), r.out.trim().replace(/\n/g, ' '));
    if (process.platform === 'darwin') check('connect-ports: the sandbox cannot listen on a connect-only port (macOS)', !r.out.includes('LISTEN-OK'), r.out.trim().split('\n').pop() ?? '');
  }
  // Names that resolve to this computer (they need public DNS): Harness Relay never looks a name up
  // (its resolver is outside the sandbox, so that would carry data out in the names), so they are
  // asked about like any other; allowed, sandbox-runtime still refuses them when it dials.
  if (want('net-loopback-names')) {
    const { lookup } = await import('node:dns/promises');
    const names = ['localtest.me', '127.0.0.1.nip.io'];
    const resolvable = (await Promise.all(names.map((n) => lookup(n).then(() => n, () => '')))).filter(Boolean);
    if (!resolvable.length) skipped.push('loopback names (no public DNS)');
    else {
      const lines = resolvable.map((n) => `echo "${n}=$(curl -s -m 10 http://${n}:${relayPort}/ 2>&1 | head -c 30)"`).join('; ');
      const r = await run(lines, baseSpec('read-only'), () => ({ allow: true }));
      check('net: names that lead to this computer never reach it, even when allowed (asked about, refused when dialed)', !r.out.includes('RELAY-API') && r.asked.length === resolvable.length, `${r.out.trim().replace(/\n/g, ' ')} asked=${r.asked.map((a) => a.detail).join(',')}`);
    }
  }

  await clientChecks(want);
  await localPortChecks(want);
  await escapeChecks(want);
  await concurrencyAndCleanup(want);
  await leftoverChecks(want);
}

/** Each HTTP client kind reaches the allowed host through the proxy. */
async function clientChecks(want: (n: string) => boolean) {
  const url = 'https://example.com';
  const ok = (out: string) => out.includes('200');
  if (want('client-node')) {
    const prog = `const r = await fetch(${JSON.stringify(url)}); console.log(r.status);`;
    const r = await run(`${JSON.stringify(node)} --input-type=module -e ${shq(prog)} 2>&1`, baseSpec('read-only'));
    check('client: Node 22 fetch (NODE_USE_ENV_PROXY)', ok(r.out), r.out.trim().slice(-60));
  }
  if (want('client-bun')) {
    if (!bun) skipped.push('Bun (not installed)');
    else {
      const r = await run(`${JSON.stringify(bun)} -e ${shq(`const r = await fetch(${JSON.stringify(url)}); console.log(r.status)`)} 2>&1`, baseSpec('read-only'));
      check('client: Bun fetch', ok(r.out), r.out.trim().slice(-60));
    }
  }
  if (want('client-python-httpx')) {
    if (!pyHas('httpx')) skipped.push('Python httpx (not installed)');
    else {
      const r = await run(`${JSON.stringify(python)} -c ${shq(`import httpx; print(httpx.get(${JSON.stringify(url)}, timeout=20).status_code)`)} 2>&1`, baseSpec('read-only'));
      check('client: Python httpx', ok(r.out), r.out.trim().slice(-60));
    }
  }
  if (want('client-python-requests')) {
    if (!pyHas('requests')) skipped.push('Python requests (not installed)');
    else {
      const r = await run(`${JSON.stringify(python)} -c ${shq(`import requests; print(requests.get(${JSON.stringify(url)}, timeout=20).status_code)`)} 2>&1`, baseSpec('read-only'));
      check('client: Python requests', ok(r.out), r.out.trim().slice(-60));
    }
  }
  if (want('client-rust')) {
    // A Rust reqwest client when $RUST_CLIENT names one; otherwise curl as the documented stand-in.
    const cmd = rustClient ? `${JSON.stringify(rustClient)} ${url}` : `curl -sS ${url}`;
    const label = rustClient ? 'client: Rust ($RUST_CLIENT)' : 'client: curl (Rust stand-in)';
    const r = await run(`${cmd} 2>&1 | head -c 400`, baseSpec('read-only'));
    check(label, /Example Domain/i.test(r.out), r.out.replace(/\s+/g, ' ').trim().slice(0, 60));
  }
}

/**
 * An agent with a server of its own on a loopback port (OpenCode) next to a model backend on loopback
 * (Ollama, a local vLLM): its own port is reachable directly and through the proxy, the backend through
 * the proxy, and Harness Relay's port and any other local port neither way.
 */
async function localPortChecks(want: (n: string) => boolean) {
  if (!want('local-ports')) return;
  const serve = (text: string): Promise<{ port: number; close: () => void }> =>
    new Promise((resolve) => {
      const server = createServer((_q, r) => r.end(text));
      server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
    });
  const backend = await serve('BACKEND');
  const other = await serve('OTHER');
  const own = await rs.freeLoopbackPort();
  const fetchLine = (label: string, url: string) =>
    `echo "${label}=$(node -e 'fetch(process.argv[1]).then(r=>r.text()).then(t=>console.log(t),()=>console.log("ERR"))' ${url} 2>/dev/null)"`;
  const curlLine = (label: string, url: string, extra = '') => `echo "${label}=$(curl -s -m 10 ${extra} ${url} 2>/dev/null || echo ERR)"`;
  const script = [
    `node -e 'require("http").createServer((q,r)=>r.end("OWN")).listen(${own},"127.0.0.1")' & srv=$!`,
    'sleep 1',
    fetchLine('node-own', `http://127.0.0.1:${own}/`),
    fetchLine('node-own-localhost', `http://localhost:${own}/`),
    fetchLine('node-backend', `http://127.0.0.1:${backend.port}/`),
    fetchLine('node-relay', `http://127.0.0.1:${relayPort}/`),
    fetchLine('node-other', `http://127.0.0.1:${other.port}/`),
    ...(bun ? [`echo "bun-own=$(bun -e 'console.log(await (await fetch(process.argv[1])).text())' http://127.0.0.1:${own}/ 2>/dev/null || echo ERR)"`] : []),
    curlLine('curl-own', `http://127.0.0.1:${own}/`),
    curlLine('curl-backend', `http://127.0.0.1:${backend.port}/`),
    curlLine('curl-relay', `http://127.0.0.1:${relayPort}/`),
    curlLine('curl-relay-direct', `http://127.0.0.1:${relayPort}/`, "--noproxy '*'"),
    curlLine('curl-other', `http://127.0.0.1:${other.port}/`),
    // A client that never sends loopback to a proxy (Cline adds loopback to NO_PROXY by itself).
    curlLine('curl-backend-direct', `http://127.0.0.1:${backend.port}/`, "--noproxy '*'"),
    curlLine('curl-backend-direct-localhost', `http://localhost:${backend.port}/`, "--noproxy '*'"),
    curlLine('curl-other-direct', `http://127.0.0.1:${other.port}/`, "--noproxy '*'"),
    'kill $srv 2>/dev/null',
  ].join('\n');
  try {
    // The user would allow anything asked: a local destination must be refused without asking.
    const r = await run(script, baseSpec('read-only', { allowedHosts: [`127.0.0.1:${backend.port}`], localPorts: [own] }), () => ({ allow: true }));
    const got = Object.fromEntries(
      r.out.trim().split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
    );
    const show = (keys: string[]) => keys.map((k) => `${k}=${got[k] ?? '?'}`).join(' ');
    check('local-ports: own server reachable directly next to a loopback backend (Node fetch)', got['node-own'] === 'OWN' && got['node-own-localhost'] === 'OWN', show(['node-own', 'node-own-localhost']));
    if (bun) check('local-ports: own server reachable directly (Bun fetch)', got['bun-own'] === 'OWN', show(['bun-own']));
    if (process.platform === 'darwin') {
      check('local-ports: own server reachable through the proxy (curl, macOS)', got['curl-own'] === 'OWN', show(['curl-own']));
    } else {
      // On Linux the proxy is outside the sandbox's own loopback: curl, which ignores a port in
      // NO_PROXY, cannot reach the agent's server through it, and must not reach this computer's.
      check('local-ports: curl through the proxy reaches nothing on this computer\'s own port (Linux)', got['curl-own'] !== 'OWN', show(['curl-own']));
    }
    check('local-ports: loopback backend reachable through the proxy (Node, curl)', got['node-backend'] === 'BACKEND' && got['curl-backend'] === 'BACKEND', show(['node-backend', 'curl-backend']));
    check(
      `local-ports: loopback backend reachable by a client that skips the proxy for loopback (${process.platform === 'darwin' ? 'allowed directly' : 'relayed'})`,
      got['curl-backend-direct'] === 'BACKEND' && got['curl-backend-direct-localhost'] === 'BACKEND',
      show(['curl-backend-direct', 'curl-backend-direct-localhost']),
    );
    check('local-ports: another local port unreachable directly either', got['curl-other-direct'] !== 'OTHER', show(['curl-other-direct']));
    check(
      "local-ports: Harness Relay's port unreachable (Node, curl via proxy, curl direct)",
      ![got['node-relay'], got['curl-relay'], got['curl-relay-direct']].includes('RELAY-API'),
      show(['node-relay', 'curl-relay', 'curl-relay-direct']),
    );
    check('local-ports: another local port unreachable (Node, curl), and never asked', got['node-other'] !== 'OTHER' && got['curl-other'] !== 'OTHER' && r.asked.length === 0, `${show(['node-other', 'curl-other'])} asked=${r.asked.length}`);
  } finally {
    backend.close();
    other.close();
  }
}

/** Ways out of the sandbox that must not work. */
async function escapeChecks(want: (n: string) => boolean) {
  if (want('escape-child')) {
    const probe = join(outside, `c-${uniq()}`);
    const r = await run(`sh -c '(sh -c "echo x > ${probe}") 2>&1' || true`, baseSpec('edit'));
    check('escape: a child process cannot write outside', !existsSync(probe), r.out.trim().slice(-40));
  }
  if (want('escape-symlink')) {
    const link = join(cwdEdit, `lnk-${uniq()}`);
    const target = join(outside, `t-${uniq()}`);
    const r = await run(`ln -s ${target} ${link} && (echo x > ${link}) 2>&1 || true`, baseSpec('edit'));
    check('escape: a symlink out of the working directory gives nothing', !existsSync(target), r.out.trim().slice(-40));
  }
  if (want('escape-hardlink')) {
    const link = join(cwdEdit, `hl-${uniq()}`);
    const r = await run(`ln ${secret} ${link} 2>&1 && cat ${link} 2>&1 || true`, baseSpec('edit'));
    check('escape: a hard link to a protected file cannot be made or read', !/SECRET/.test(r.out), r.out.trim().slice(-40));
  }
  if (want('escape-git-hookspath')) {
    const hooks = join(state, `hooks-${uniq()}`);
    mkdirSync(hooks, { recursive: true });
    const flag = join(outside, `g-${uniq()}`);
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch ${flag}\n`, { mode: 0o755 });
    const r = await run(`git -c core.hooksPath=${hooks} commit --allow-empty -m x 2>&1 || true`, baseSpec('edit'));
    // The hook runs in the sandbox, so even if git runs it, its write outside fails.
    check('escape: a git hook cannot write outside the sandbox', !existsSync(flag), r.out.trim().slice(-50));
  }
  if (want('escape-git-config')) {
    const r = await run(`git config core.pager "touch ${join(outside, `p-${uniq()}`)}" 2>&1 || true; cat .git/config 2>&1 | grep -c pager || true`, baseSpec('edit'));
    check('escape: .git/config stays read-only', !/pager/.test(r.out) || r.out.includes('not permitted') || r.out.includes('0'), r.out.trim().slice(-60));
  }
  if (want('escape-own-config')) {
    const r = await run(`sh -c 'echo rewrite >> "${configFile}"' 2>&1 || true`, baseSpec('edit'));
    const changed = readText(configFile).includes('rewrite');
    check('escape: the agent cannot rewrite its own config path', !changed, r.out.trim().slice(-40));
  }
}

/** Two runs with different rules stay apart, and a killed run leaves nothing behind. */
async function concurrencyAndCleanup(want: (n: string) => boolean) {
  if (want('concurrent')) {
    const askedA: ApprovalRequest[] = [];
    const askedB: ApprovalRequest[] = [];
    const a = await rs.sandboxCommand('/bin/sh', ['-c', `curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org`], env, {
      ...baseSpec('read-only', { allowedHosts: ['example.com'] }),
      requestApproval: async (r) => (askedA.push(r), { allow: true }),
    });
    const b = await rs.sandboxCommand('/bin/sh', ['-c', `curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org`], env, {
      ...baseSpec('read-only', { allowedHosts: ['example.com'] }),
      requestApproval: async (r) => (askedB.push(r), { allow: false }),
    });
    const [ra, rb] = await Promise.all([
      runProcess({ bin: a.bin, args: a.args, env: a.env, cwd: cwdRo, timeoutMs: 60_000, maxCapture: 1 << 14 }),
      runProcess({ bin: b.bin, args: b.args, env: b.env, cwd: cwdRo, timeoutMs: 60_000, maxCapture: 1 << 14 }),
    ]);
    await a.dispose();
    await b.dispose();
    const apart = ra.stdout.includes('200') && !rb.stdout.includes('200') && askedA.length === 1 && askedB.length === 1;
    check('concurrent: two runs with different rules stay apart', apart, `A=${ra.stdout.trim()} B=${rb.stdout.trim()}`);
  }

  if (want('cleanup-kill')) {
    const before = ls(rs.relaySandboxRoot(dataDir));
    const cmd = await rs.sandboxCommand('/bin/sh', ['-c', 'echo READY; sleep 120'], env, baseSpec('read-only'));
    let pid = 0;
    const done = runProcess({
      cwd: cwdRo,
      bin: cmd.bin,
      args: cmd.args,
      env: cmd.env,
      timeoutMs: 60_000,
      onSpawn: (c) => (pid = c.pid ?? 0),
      onLine: () => undefined,
    });
    await waitFor(() => pid > 0);
    await new Promise((r) => setTimeout(r, 2000));
    const childPids = descendants(pid);
    // Stop it the way the server does: SIGTERM the host's process group, so the host reaps its tree
    // and closes sandbox-runtime, with SIGKILL as the backstop after a grace period.
    if (pid) killTree({ pid } as never, 'SIGTERM');
    await done;
    await cmd.dispose();
    await waitFor(() => childPids.filter(alive).length === 0);
    const stillAlive = childPids.filter(alive);
    const after = ls(rs.relaySandboxRoot(dataDir));
    check('cleanup: a killed run leaves no live process behind', stillAlive.length === 0, stillAlive.length ? `alive: ${stillAlive}` : '');
    check('cleanup: a killed run leaves no temporary folder behind', after.length <= before.length, `before=${before.length} after=${after.length}`);
  }
}

/**
 * Leftovers that leave the host's process group: a backgrounded, re-parented command (Pi's bash runs
 * detached, so a double fork reparents it to launchd), swept when the run ends by the marker; and, at
 * the next server start, a process of a run whose server was killed before its host could stop it.
 */
async function leftoverChecks(want: (n: string) => boolean) {
  if (want('leftover-detached')) {
    const late = join(cwdEdit, `late-${uniq()}.txt`);
    // The writer sleeps past the turn, then writes in the working directory; it is detached and
    // re-parented, so it has left the host's group by the time the run ends.
    const cmd = `(nohup sh -c 'sleep 6; echo LATE > ${late}' >/dev/null 2>&1 &); echo main-done`;
    const r = await run(cmd, baseSpec('edit'));
    // dispose() has run (inside run()): the host stopped, and its marker sweep killed the writer.
    await new Promise((res) => setTimeout(res, 8000)); // past the 6 s the writer wanted
    const wrote = existsSync(late);
    if (wrote) rmSync(late, { force: true });
    check('leftover: a detached, re-parented late writer is swept when the run ends', r.out.includes('main-done') && !wrote, wrote ? 'it wrote after the turn' : '');
  }

  // Background writers started the way the CLIs start commands: with every descriptor but the
  // standard ones closed (Node's spawn, Python's close_fds), so the marker does not reach them, and
  // out of the host's process group (detached, setsid), so the group kill misses them too. They are
  // found by their sandbox (sandboxProcs.ts). Each must fail with that sweep turned off.
  if (want('leftover-closed-fds') && process.platform === 'darwin') {
    const writers: [string, string][] = [];
    const late = (tag: string) => {
      const f = join(cwdEdit, `late-${tag}-${uniq()}.txt`);
      writers.push([tag, f]);
      return f;
    };
    const viaNode = late('node');
    const viaPython = late('python');
    const viaPerl = late('perl');
    // The same daemon after removing the run's temp folder, by which the sweep by sandbox asks.
    const viaPerlRmTmp = late('perl-after-removing-its-temp-folder');
    // Node's spawn closes every descriptor but stdio; detached: a process group of its own.
    const nodeCode = `require('child_process').spawn('/bin/sh',['-c','sleep 20; echo LATE > ${viaNode}'],{detached:true,stdio:'ignore'}).unref()`;
    // Python: a double fork with setsid in between, then every descriptor above stdio closed.
    const pyFile = join(scratch, `daemon-${uniq()}.py`);
    writeFileSync(pyFile, [
      'import os, sys, time',
      'if os.fork() == 0:',
      '    os.setsid()',
      '    if os.fork() == 0:',
      '        os.closerange(0, 1024)',
      '        time.sleep(20)',
      '        open(sys.argv[1], "w").write("LATE")',
      '    os._exit(0)',
      '',
    ].join('\n'));
    // Perl, as a stand-in for any other runtime: fork, setsid, fork, every descriptor closed.
    const perlCode = 'use POSIX; exit if fork; POSIX::setsid(); exit if fork; POSIX::close($_) for 0..255; sleep 20; open(my $f, ">", $ARGV[0]); print $f "LATE";';
    const cmd = [
      `${JSON.stringify(node)} -e ${JSON.stringify(nodeCode)}`,
      python ? `${JSON.stringify(python)} ${JSON.stringify(pyFile)} ${JSON.stringify(viaPython)}` : 'true',
      `/usr/bin/perl -e '${perlCode}' ${JSON.stringify(viaPerl)}`,
      `( rm -rf "$TMPDIR"; /usr/bin/perl -e '${perlCode}' ${JSON.stringify(viaPerlRmTmp)} )`,
      'echo main-done',
    ].join('\n');
    const r = await run(cmd, baseSpec('edit'));
    // The writers wait 20 s, longer than a run's teardown, so none can have written before the sweep.
    const early = writers.filter(([, f]) => existsSync(f)).map(([t]) => t);
    await new Promise((res) => setTimeout(res, 22_000)); // past the 20 s the writers wanted
    for (const [tag, f] of writers) {
      if (tag === 'python' && !python) continue;
      const wrote = existsSync(f);
      if (wrote) rmSync(f, { force: true });
      const ran = r.out.includes('main-done');
      const before = early.includes(tag);
      check(`leftover: a ${tag}-started writer that closed the marker and detached is swept when the run ends`, ran && !wrote && !before, before ? 'it wrote before the run ended (the check is too fast)' : wrote ? 'it wrote after the turn' : ran ? '' : `the run failed: ${(r.failure || r.err || '').slice(0, 300)}`);
    }
  }

  // The sandbox sweep matches this run's profile only: a process in a wider sandbox (one that may
  // write beside the run's folder too, as another tool's sandbox over Harness Relay's data could) lives.
  if (want('leftover-wider-sandbox') && process.platform === 'darwin') {
    const dirs = rs.makeRunDirs(dataDir);
    const profile = join(scratch, `wider-${uniq()}.sb`);
    writeFileSync(profile, `(version 1)(allow default)(deny file-write* (subpath "/"))(allow file-write* (subpath ${JSON.stringify(rs.relaySandboxRoot(dataDir))}))`);
    const wider = spawn('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sleep', '30'], { detached: true, stdio: 'ignore' });
    const own = join(scratch, `own-${uniq()}.sb`);
    writeFileSync(own, `(version 1)(allow default)(deny file-write* (subpath "/"))(allow file-write* (subpath ${JSON.stringify(dirs.tmp)}))`);
    const inRun = spawn('/usr/bin/sandbox-exec', ['-f', own, '/bin/sleep', '30'], { detached: true, stdio: 'ignore' });
    await new Promise((res) => setTimeout(res, 500));
    const { sweepRunSandboxes } = await import('../src/server/sandboxProcs');
    sweepRunSandboxes([dirs.tmp]);
    await new Promise((res) => setTimeout(res, 300));
    const widerLived = alive(wider.pid!);
    const runDied = !alive(inRun.pid!);
    for (const p of [wider.pid!, inRun.pid!]) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    rmSync(dirs.tmp, { recursive: true, force: true });
    check('leftover: the sandbox sweep kills a process in the run\'s own sandbox', runDied, '');
    check('leftover: the sandbox sweep leaves a process in a wider sandbox alone', widerLived, '');
  }

  // A run whose server was killed: its folder is still there, and a process of its sandbox that holds
  // no marker (it closed every descriptor) is found by its profile at the next server start.
  if (want('leftover-startup-sandboxed') && process.platform === 'darwin') {
    const dirs = rs.makeRunDirs(dataDir);
    const own = join(scratch, `crashed-${uniq()}.sb`);
    writeFileSync(own, `(version 1)(allow default)(deny file-write* (subpath "/"))(allow file-write* (subpath ${JSON.stringify(dirs.tmp)}))`);
    const p = spawn('/usr/bin/sandbox-exec', ['-f', own, '/usr/bin/perl', '-e', 'use POSIX; POSIX::setsid(); POSIX::close($_) for 0..255; sleep 40;'], { detached: true, stdio: 'ignore' });
    await new Promise((res) => setTimeout(res, 500));
    const before = alive(p.pid!);
    rs.clearRelaySandboxLeftovers(dataDir);
    await new Promise((res) => setTimeout(res, 300));
    const after = alive(p.pid!);
    if (after) try { process.kill(p.pid!, 'SIGKILL'); } catch { /* gone */ }
    check('leftover: a process of a killed run\'s sandbox that holds no marker is swept at the next server start', before && !after, `before=${before} after=${after}`);
  }

  // The startup sweep looks at the markers only: a shell of the user's that merely sits in the folder lives.
  if (want('leftover-cwd') && process.platform === 'darwin') {
    const root = rs.relaySandboxRoot(dataDir);
    mkdirSync(join(root, 'browsing'), { recursive: true });
    const shell = spawn('/bin/sh', ['-c', 'sleep 30'], { cwd: join(root, 'browsing'), detached: true, stdio: 'ignore' });
    await new Promise((res) => setTimeout(res, 300));
    rs.clearRelaySandboxLeftovers(dataDir);
    await new Promise((res) => setTimeout(res, 300));
    const lived = alive(shell.pid!);
    try {
      process.kill(shell.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
    check('leftover: the startup sweep leaves a shell whose working directory is in the folder alone', lived, '');
  }

  if (want('leftover-startup')) {
    // A run whose server died leaves its folders and a process holding a file under them. Stand in
    // for it without a sandbox: a detached process holding an open descriptor under relay-sandbox/.
    const root = rs.relaySandboxRoot(dataDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const held = join(root, `stale-${uniq()}.marker`);
    writeFileSync(held, '');
    const child = spawnDetachedHolding(held);
    await new Promise((res) => setTimeout(res, 800));
    const before = alive(child);
    // A fresh server's startup step (clearRelaySandboxLeftovers) sweeps and clears.
    rs.clearRelaySandboxLeftovers(dataDir);
    await new Promise((res) => setTimeout(res, 500));
    const after = alive(child);
    if (after) try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }
    if (process.platform === 'darwin') {
      check('leftover: a process from a killed run is swept at the next server start', before && !after, `before=${before} after=${after}`);
    } else {
      // On Linux bubblewrap's PID namespace already ended such a tree; the stand-in is not sandboxed,
      // so the startup sweep leaves it (correctly, it does not kill arbitrary processes on Linux).
      check('leftover: Linux startup clears the folder (the PID namespace already ended the tree)', !existsSync(root) || readdirSync(root).length === 0, '');
    }
  }
}

/** A detached process, re-parented, that holds an open read-only descriptor to `path` and waits. */
function spawnDetachedHolding(path: string): number {
  const fd = openSync(path, 'r');
  const child = spawnSync('/bin/sh', ['-c', 'nohup sleep 40 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore', fd], encoding: 'utf8' });
  closeSync(fd);
  return Number((child.stdout ?? '').trim());
}

// --- helpers ---
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
/** A file's text as this script (outside the sandbox) reads it; empty when it cannot be read. */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function ls(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
// A zombie (defunct, reaped by no one when this process is the container's PID 1) counts as dead.
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    // No /proc (macOS): kill(pid, 0) succeeds on a zombie too, but macOS's init reaps orphans promptly.
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
function descendants(root: number): number[] {
  const out: number[] = [];
  const ps = spawnSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
  const pairs = (ps.stdout || '').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const [pid, ppid] of pairs) if (ppid === p && !out.includes(pid!)) (out.push(pid!), stack.push(pid!));
  }
  return out;
}
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
}

try {
  await main();
} catch (err) {
  check('run', false, (err as Error).message);
} finally {
  relayStub.close();
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}
if (skipped.length) process.stderr.write(`\nskipped: ${skipped.join('; ')}\n`);
const failed = results.filter((r) => !r.ok);
process.stderr.write(`\n${results.length - failed.length}/${results.length} checks passed${keep ? `; kept ${scratch}` : ''}\n`);
process.exit(failed.length ? 1 : 0);
