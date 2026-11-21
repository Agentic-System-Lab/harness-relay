import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, OutboxItem } from '../src/shared/types';
import { removeTree } from '../src/server/fsRemove';
import {
  GatewaySocketPathError,
  ToolGateway,
  gatewayDecision,
  gatewaySocketTooLong,
  gatewayToolNamed,
  outboxTool,
  reservedMcpName,
  type GatewayContext,
  type GatewayTool,
} from '../src/server/gateway';
import { GATEWAY_PROTOCOLS } from '../src/server/gatewayShim';
import type { ApprovalRequest } from '../src/server/agents/types';
import { slow } from './timeouts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-gw-')));
afterAll(() => removeTree(root));

describe('what a call of each tier does', () => {
  it('runs reads, asks before acting below full access (refused when nobody can be asked), and never sends in the turn', () => {
    expect(gatewayDecision('read', 'read-only', false)).toBe('run');
    expect(gatewayDecision('act', 'edit', true)).toBe('ask');
    expect(gatewayDecision('act', 'read-only', false)).toBe('refuse');
    expect(gatewayDecision('act', 'full', false)).toBe('run');
    expect(gatewayDecision('send', 'full', true)).toBe('outbox');
  });

  it("tells a CLI's request about one of the gateway's tools only by the tool's exact name, never by a command, path or URL", () => {
    const names = ['browser_open', 'mail_send'];
    const other = (tool?: string) => ({ kind: 'other' as const, tool });
    expect(gatewayToolNamed(names, other('mcp__relay__browser_open'))).toBe('browser_open');
    expect(gatewayToolNamed(names, other('relay:mail_send'))).toBe('mail_send');
    expect(gatewayToolNamed(names, other('relay/mail_send'))).toBe('mail_send');
    expect(gatewayToolNamed(names, other('relay__mail_send'))).toBe('mail_send');
    // OpenCode's `<server>_<tool>`, as the real `opencode acp` titles an MCP call.
    expect(gatewayToolNamed(names, other('relay_mail_send'))).toBe('mail_send');
    // Antigravity's `mcp_<server>_<tool>`, as the real agy 1.5.10 names it in its question; from no other CLI,
    // where it could be a library server `mcp`'s tool `relay_browser_open` (OpenCode's `<server>_<tool>`).
    expect(gatewayToolNamed(names, other('mcp_relay_browser_open'), 'antigravity')).toBe('browser_open');
    expect(gatewayToolNamed(names, other('mcp_relay_browser_open'), 'opencode')).toBeUndefined();
    expect(gatewayToolNamed(names, other('mcp_relay_browser_open'))).toBeUndefined();
    for (const tool of [
      'mcp__evil__browser_open',
      'browser_open',
      'mcp__relay__browser_opener',
      'mcp__x-relay__browser_open',
      'mcp__nonrelay__mail_send',
      'evil:mail_send',
      'relay:mail_sender',
      'relay_mail_sender',
      'relay_x_mail_send',
      'mcp_relay_browser_opener',
      'mcp_evil_browser_open',
      'mcp_relay_x_mail_send',
      'https://h/relay/mail_send',
      undefined,
    ]) {
      expect(gatewayToolNamed(names, other(tool))).toBeUndefined();
    }
    // A command, a file or a URL that mentions one is not about it.
    expect(gatewayToolNamed(names, { kind: 'command', tool: 'mcp__relay__browser_open' })).toBeUndefined();
    // So no library server may take a name that OpenCode would join with its tool into one of these.
    for (const name of ['relay', 'Relay', 'relay_mail', 'RELAY__x', 'relay_']) expect(reservedMcpName(name)).toBe(true);
    for (const name of ['relayx', 'my-relay', 'relay-mail', 'gh']) expect(reservedMcpName(name)).toBe(false);
    expect(gatewayToolNamed(names, { kind: 'fetch' })).toBeUndefined();
  });
});

describe('the gateway and the MCP server the CLIs start', () => {
  let gateway: ToolGateway;
  const asked: ApprovalRequest[] = [];
  const outboxed: { tool: string; title: string; args: Record<string, unknown> }[] = [];
  let answer: ApprovalAnswer = { allow: true };
  const children: ChildProcess[] = [];

  /** What the act tool's `asking` hook and its run did, in order. */
  const holding: string[] = [];
  const tools: GatewayTool[] = [
    {
      name: 'page_title',
      group: 'browser',
      tier: 'read',
      description: 'Read a title',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      describe: (a) => ({ title: `Read ${String(a.url)}` }),
      run: async (a) => ({ text: `Title of ${String(a.url)}`, images: [{ data: 'aGk=', mimeType: 'image/png' }] }),
    },
    {
      name: 'page_click',
      group: 'browser',
      tier: 'act',
      description: 'Click',
      inputSchema: { type: 'object' },
      describe: (a) => ({ title: `Click ${String(a.target)}`, detail: 'on example.com' }),
      // What it keeps while the user is asked (the browser, so the page is still there for the click).
      asking: () => (holding.push('held'), () => holding.push('let go')),
      run: async (a) => (holding.push('ran'), { text: `Clicked ${String(a.target)}` }),
    },
    {
      name: 'mail_out',
      group: 'mail',
      tier: 'send',
      description: 'Send a mail',
      inputSchema: { type: 'object' },
      describe: (a) => ({
        title: `Mail to ${String(a.to)}`,
        preview: { fields: [{ label: 'To', value: String(a.to) }], body: String(a.body) },
      }),
      send: async () => 'sent',
    },
    {
      name: 'broken',
      group: 'browser',
      tier: 'read',
      description: 'x',
      inputSchema: {},
      describe: () => ({ title: 'x' }),
      run: async () => Promise.reject(new Error('kaput')),
    },
    {
      name: 'later',
      group: 'mail',
      tier: 'read',
      description: 'Needs an account',
      inputSchema: {},
      describe: () => ({ title: 'x' }),
      unavailable: () => 'no mail account',
      run: async () => ({ text: '' }),
    },
  ];

  const ctx = (o: Partial<GatewayContext> = {}): GatewayContext => ({
    convId: 'c1',
    agentId: 'a',
    agentName: 'Alice',
    messageId: 'm1',
    cwd: root,
    permission: 'edit',
    unattended: false,
    ask: async (req) => {
      asked.push(req);
      return answer;
    },
    toOutbox: (o2) => {
      outboxed.push(o2);
      return {
        id: 'ob1',
        convId: 'c1',
        messageId: 'm1',
        agentId: 'a',
        agentName: 'Alice',
        tool: o2.tool,
        title: o2.title,
        preview: o2.preview,
        status: 'pending',
        createdAt: 1,
      } as OutboxItem;
    },
    signal: new AbortController().signal,
    ...o,
  });

  beforeAll(async () => {
    gateway = new ToolGateway(join(root, 'data'), join(root, 'data', 'tmp'), () => process.execPath);
    gateway.register(tools);
    await gateway.start();
  });
  afterAll(() => gateway.stop());
  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
    asked.length = 0;
    outboxed.length = 0;
    answer = { allow: true };
  });

  /** Start the MCP server as a CLI would, from the spec a grant gives: a client that sends requests and reads answers by id. */
  function client(spec: { command: string; args: string[]; env: Record<string, string> }) {
    const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let buffer = '';
    const answers = new Map<number, (msg: any) => void>();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        answers.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const request = (method: string, params: unknown = {}) =>
      new Promise<any>((resolve) => {
        const n = ++id;
        answers.set(n, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      });
    return { request, notify: (method: string) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), child };
  }

  it(
    "speaks MCP on stdio: initialize, the granted groups' tools, and calls passed to the server",
    async () => {
      const grant = gateway.grant(ctx(), ['browser'])!;
      expect(grant.spec).toMatchObject({ name: 'relay', transport: 'stdio', command: process.execPath });
      // Its own copy of the program, beside its token, in the folder sandboxed commands cannot reach.
      const shim = grant.spec.args[0]!;
      expect(shim.startsWith(join(root, 'data', 'tmp', 'gateway-'))).toBe(true);
      expect(readFileSync(shim, 'utf8')).toContain("Harness Relay's MCP gateway");
      // The token is in a file of its own, never in the environment or on the command line.
      const tokenFile = grant.spec.env.RELAY_GATEWAY_TOKEN_FILE!;
      expect(Object.values(grant.spec.env).join(' ')).not.toContain(readFileSync(tokenFile, 'utf8'));
      if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

      const mcp = client(grant.spec);
      const init = await mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'relay' } });
      mcp.notify('notifications/initialized');
      expect((await mcp.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe(GATEWAY_PROTOCOLS.at(-1));
      expect((await mcp.request('ping')).result).toEqual({});

      const list = await mcp.request('tools/list');
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['page_title', 'page_click', 'broken']);
      expect(list.result.tools[0]).toMatchObject({ annotations: { readOnlyHint: true } });

      const read = await mcp.request('tools/call', { name: 'page_title', arguments: { url: 'https://example.com' } });
      expect(read.result).toEqual({
        content: [
          { type: 'text', text: 'Title of https://example.com' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
        isError: false,
      });
      expect(asked).toEqual([]);
      const failed = await mcp.request('tools/call', { name: 'broken', arguments: {} });
      expect(failed.result).toMatchObject({ isError: true, content: [{ text: 'broken failed: kaput' }] });
      // A group it was not given is not there.
      expect((await mcp.request('tools/call', { name: 'mail_out', arguments: {} })).result).toMatchObject({
        isError: true,
        content: [{ text: 'No such tool: mail_out' }],
      });
      expect((await mcp.request('unknown/method')).error).toMatchObject({ code: -32601 });

      // Once the turn is over, its token is gone, and so are its tools.
      // Bad lines do not stop it.
      mcp.child.stdin!.write('null\n[1]\n');
      expect((await mcp.request('ping')).result).toEqual({});

      grant.revoke();
      expect(existsSync(tokenFile)).toBe(false);
      expect(existsSync(shim)).toBe(false);
      const after = await mcp.request('tools/call', { name: 'page_title', arguments: { url: 'x' } });
      expect(after.result).toMatchObject({ isError: true });
      expect(after.result.content[0].text).toMatch(/turn is over/);
    },
    slow(20_000),
  );

  it('asks before acting, holding what the call needs meanwhile, refuses when nobody can be asked, and puts sends in the outbox', async () => {
    const call = (name: string, args: Record<string, unknown>, c: GatewayContext) => gateway.call(gateway.tool(name)!, args, c);
    holding.length = 0;
    expect(await call('page_click', { target: 'Buy' }, ctx())).toEqual({ text: 'Clicked Buy' });
    expect(holding).toEqual(['held', 'let go', 'ran']);
    expect(asked).toEqual([{ kind: 'other', tool: 'relay:page_click', detail: 'Click Buy', reason: 'on example.com', noLock: true }]);
    answer = { allow: false, note: 'not that one' };
    expect(await call('page_click', { target: 'Buy' }, ctx())).toEqual({
      text: 'The user declined page_click: not that one.',
      isError: true,
    });
    expect(await call('page_click', { target: 'Buy' }, ctx({ permission: 'full' }))).toEqual({ text: 'Clicked Buy' });
    expect((await call('page_click', { target: 'Buy' }, ctx({ ask: undefined }))).isError).toBe(true);

    const sent = await call('mail_out', { to: 'bob@example.com', body: 'Hi' }, ctx({ permission: 'full' }));
    expect(sent.text).toMatch(/^Not sent yet: "Mail to bob@example.com" is waiting in the user's outbox \(item ob1\)/);
    expect(outboxed).toEqual([
      {
        tool: 'mail_out',
        title: 'Mail to bob@example.com',
        preview: { fields: [{ label: 'To', value: 'bob@example.com' }], body: 'Hi' },
        args: { to: 'bob@example.com', body: 'Hi' },
      },
    ]);
    expect(await call('later', {}, ctx())).toEqual({ text: 'later cannot be used now: no mail account', isError: true });
  });

  it(
    'answers a shim with a token it does not know with errors, and gives no grant without a Node.js or a group',
    async () => {
      const g = gateway.grant(ctx(), ['browser'])!;
      const shim = join(root, 'shim-copy.mjs');
      writeFileSync(shim, readFileSync(g.spec.args[0]!));
      g.revoke();
      const mcp = client({
        command: process.execPath,
        args: [shim],
        env: { RELAY_GATEWAY_SOCKET: gateway.socketPath, RELAY_GATEWAY_TOKEN_FILE: join(root, 'nope') },
      });
      await mcp.request('initialize', { protocolVersion: '2025-06-18' });
      expect((await mcp.request('tools/list')).error.message).toMatch(/turn is over/);
      expect(gateway.grant(ctx(), [])).toBeUndefined();
      const noNode = new ToolGateway(join(root, 'data2'), join(root, 'data2', 'tmp'), () => undefined);
      await noNode.start();
      expect(noNode.unavailable()).toBe(process.platform === 'win32' ? 'no-node-path' : 'no-node');
      expect(noNode.grant(ctx(), ['browser'])).toBeUndefined();
      await noNode.stop();
      // Node.js is checked first, so neither needs a server: on macOS and Linux Settings can install one;
      // on Windows, where it installs none, the hint names the PATH alone.
      expect(new ToolGateway(join(root, 'data6'), join(root, 'data6', 'tmp'), () => undefined, 'linux').unavailable()).toBe('no-node');
      expect(new ToolGateway(join(root, 'data5'), join(root, 'data5', 'tmp'), () => undefined, 'win32').unavailable()).toBe('no-node-path');
      expect(new ToolGateway(join(root, 'data3'), join(root, 'tmp3'), () => process.execPath).unavailable()).toBe('not-started');
    },
    slow(20_000),
  );

  it('refuses a data folder too long for its socket, before it makes anything, rather than listen on a cut path', async () => {
    // `/gateway/relay.sock` takes 19 bytes: a data folder of 84 fits on macOS (103 in all), of 88 on Linux (107).
    const folder = (bytes: number) => '/' + 'd'.repeat(bytes - 1);
    expect(gatewaySocketTooLong(folder(84), 'darwin')).toBeUndefined();
    expect(gatewaySocketTooLong(folder(85), 'darwin')).toMatch(/104 bytes, longer than the 103 .*RELAY_DATA_DIR .*at most 84 bytes/);
    expect(gatewaySocketTooLong(folder(85), 'freebsd')).toMatch(/at most 84 bytes/);
    expect(gatewaySocketTooLong(folder(88), 'linux')).toBeUndefined();
    expect(gatewaySocketTooLong(folder(89), 'linux')).toMatch(/at most 88 bytes/);
    // Bytes, not characters: 28 Chinese characters take 84.
    expect(gatewaySocketTooLong('/' + '資'.repeat(28), 'darwin')).toMatch(/at most 84 bytes/);
    // A named pipe on Windows: any data folder.
    expect(gatewaySocketTooLong(folder(500), 'win32')).toBeUndefined();

    const dataDir = join(root, 'd'.repeat(Math.max(1, 120 - root.length)));
    const long = new ToolGateway(dataDir, join(dataDir, 'tmp'), () => process.execPath, 'darwin');
    await expect(long.start()).rejects.toThrow(GatewaySocketPathError);
    expect(long.listening()).toBe(false);
    expect(long.unavailable()).toBe('not-started');
    expect(existsSync(dataDir)).toBe(false);
  });

  it(
    "serves each token to one connection where data/tmp cannot be protected (Windows): its file goes once the CLI's shim has shown it",
    async () => {
      const once = new ToolGateway(join(root, 'data4'), join(root, 'data4', 'tmp'), () => process.execPath, process.platform, {
        claimOnce: true,
        tokenWaitMs: 300,
      });
      once.register(tools);
      await once.start();
      try {
        const grant = once.grant(ctx(), ['browser'])!;
        const tokenFile = grant.spec.env.RELAY_GATEWAY_TOKEN_FILE!;
        // A command that read the token before the CLI started its shim, and copied it.
        const stolen = join(root, 'stolen.token');
        writeFileSync(stolen, readFileSync(tokenFile));
        const mcp = client(grant.spec);
        await mcp.request('initialize', { protocolVersion: '2025-06-18' });
        expect((await mcp.request('tools/list')).result.tools.length).toBeGreaterThan(0);
        expect(existsSync(tokenFile)).toBe(false);
        // Another connection with the same token gets nothing.
        const thief = client({ ...grant.spec, env: { ...grant.spec.env, RELAY_GATEWAY_TOKEN_FILE: stolen } });
        await thief.request('initialize', { protocolVersion: '2025-06-18' });
        expect((await thief.request('tools/list')).error.message).toMatch(/in use by its own MCP server already/);
        const call = await thief.request('tools/call', { name: 'page_title', arguments: { url: 'x' } });
        expect(call.result).toMatchObject({ isError: true });
        // A connection with a token the server does not know is ended too, asking or not, so none stays.
        const stranger = connect(once.socketPath, () => stranger.write('{"token":"not-one-of-ours"}\n'));
        await new Promise<void>((resolve) => stranger.on('close', () => resolve()).on('error', () => undefined));
        // A connection that shows no token is ended, and so is one whose first line is longer than a token's.
        const silent = connect(once.socketPath);
        await new Promise<void>((resolve) => silent.on('close', () => resolve()).on('error', () => undefined));
        const flood = connect(once.socketPath, () => flood.write('x'.repeat(4096)));
        await new Promise<void>((resolve) => flood.on('close', () => resolve()).on('error', () => undefined));
        // The CLI's own shim goes on working.
        expect((await mcp.request('tools/call', { name: 'page_title', arguments: { url: 'https://example.com' } })).result.isError).toBe(
          false,
        );
        grant.revoke();
      } finally {
        // The shims' connections end first: a server closing waits for them.
        for (const c of children.splice(0)) c.kill();
        await once.stop();
      }
    },
    slow(20_000),
  );

  /** A POST to the HTTP endpoint, as an MCP client sends it (headers it may override). */
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('serves a turn over loopback HTTP, its token only in the MCP server it gives: nothing written, the same tools and tiers', async () => {
    const before = readdirSync(join(root, 'data', 'tmp')).length;
    const grant = gateway.grant(ctx(), ['browser', 'mail'], { http: true })!;
    const { spec } = grant;
    expect(spec).toMatchObject({ name: 'relay', transport: 'http', command: '', args: [], env: {} });
    expect(spec.url).toBe(`http://127.0.0.1:${gateway.httpPort()}/mcp`);
    expect(spec.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(spec.fallback).toBeUndefined();
    // No program, no token file: the token is only in what the CLI is given.
    expect(readdirSync(join(root, 'data', 'tmp'))).toHaveLength(before);
    const auth = { Authorization: spec.headers.Authorization! };

    const init = (await (
      await post(spec.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth)
    ).json()) as any;
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'relay' }, capabilities: { tools: {} } });
    // A notification is accepted, with nothing to answer.
    const note = await post(spec.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
    const list = (await (await post(spec.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)).json()) as any;
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'broken',
      'later',
      'mail_out',
      'page_click',
      'page_title',
    ]);
    const read = (await (
      await post(
        spec.url,
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'page_title', arguments: { url: 'https://example.com' } } },
        auth,
      )
    ).json()) as any;
    expect(read.result.content[0]).toEqual({ type: 'text', text: 'Title of https://example.com' });
    expect(read.result.content[1]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
    // The same tiers: an act is asked about, a send waits in the outbox.
    await post(
      spec.url,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'page_click', arguments: { target: 'Buy' } } },
      auth,
    );
    expect(asked.at(-1)).toMatchObject({ tool: 'relay:page_click', detail: 'Click Buy' });
    const sent = (await (
      await post(
        spec.url,
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'mail_out', arguments: { to: 'bob@x.com', body: 'hi' } } },
        auth,
      )
    ).json()) as any;
    expect(sent.result.content[0].text).toMatch(/^Not sent yet/);
    expect(outboxed).toHaveLength(1);
    // A batch is answered as one, its notifications left out.
    const batch = (await (
      await post(
        spec.url,
        [
          { jsonrpc: '2.0', id: 6, method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/x' },
        ],
        auth,
      )
    ).json()) as any;
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 6, result: {} }]);
    const unknown = (await (await post(spec.url, { jsonrpc: '2.0', id: 7, method: 'resources/list' }, auth)).json()) as any;
    expect(unknown.error.code).toBe(-32601);

    // Once the turn is over, its token opens nothing.
    grant.revoke();
    const over = await post(spec.url, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, auth);
    expect(over.status).toBe(404);
  });

  it("answers only this computer's programs over HTTP: its own address as Host, no Origin, POST, JSON, a live token of its own kind", async () => {
    const grant = gateway.grant(ctx(), ['browser'], { http: true })!;
    const { url, headers } = grant.spec;
    const auth = { Authorization: headers.Authorization! };
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const port = gateway.httpPort()!;
    const raw = (h: Record<string, string>, method = 'POST', body = JSON.stringify(list)) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', ...h } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on('error', reject);
        req.end(method === 'POST' ? body : undefined);
      });
    expect(await raw({ ...auth })).toBe(200);
    expect(await raw({ ...auth, Host: `localhost:${port}` })).toBe(200);
    // A name that rebinds to 127.0.0.1 is not its own address; a page in a browser sends an Origin.
    expect(await raw({ ...auth, Host: `evil.example:${port}` })).toBe(403);
    expect(await raw({ ...auth, Origin: 'https://evil.example' })).toBe(403);
    expect(await raw({ ...auth }, 'GET')).toBe(405);
    expect(await raw({ ...auth, 'Content-Type': 'text/plain' })).toBe(415);
    expect(await raw({})).toBe(404);
    expect(await raw({ Authorization: 'Bearer ' + 'x'.repeat(43) })).toBe(404);
    expect((await post(url.replace('/mcp', '/other'), list, auth)).status).toBe(404);
    expect((await post(url, '{not json', auth)).status).toBe(400);
    // A stdio program's token is no good here, nor the HTTP one on the program's socket.
    const stdio = gateway.grant(ctx(), ['browser'])!;
    const fileToken = readFileSync(stdio.spec.env.RELAY_GATEWAY_TOKEN_FILE!, 'utf8').trim();
    expect(await raw({ Authorization: `Bearer ${fileToken}` })).toBe(404);
    const shim = client({ ...stdio.spec, env: { ...stdio.spec.env, RELAY_GATEWAY_TOKEN_FILE: join(root, 'http-token') } });
    writeFileSync(join(root, 'http-token'), headers.Authorization!.slice('Bearer '.length));
    await shim.request('initialize', { protocolVersion: '2025-06-18' });
    expect((await shim.request('tools/list')).error.message).toMatch(/turn is over/);
    stdio.revoke();
    grant.revoke();
  });

  it('does not do an act the user allows after its HTTP caller stopped waiting (its own time limit), and says why', async () => {
    let allow!: (a: ApprovalAnswer) => void;
    let started!: () => void;
    const waiting = new Promise<void>((r) => (started = r));
    const grant = gateway.grant(
      ctx({ ask: (req) => (asked.push(req), started(), new Promise<ApprovalAnswer>((r) => (allow = r))) }),
      ['browser'],
      { http: true },
    )!;
    const stop = new AbortController();
    void fetch(grant.spec.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: grant.spec.headers.Authorization! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'page_click', arguments: { target: 'Buy' } } }),
      signal: stop.signal,
    }).catch(() => undefined);
    // The client gives up while the user is asked.
    await waiting;
    stop.abort();
    await new Promise((r) => setTimeout(r, 200));
    const before = holding.length;
    allow({ allow: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(asked.at(-1)).toMatchObject({ tool: 'relay:page_click' });
    expect(holding.slice(before)).not.toContain('ran');
    // Through call() itself: the same answer, said to whoever still listens.
    const tool = { ...tools.find((t) => t.name === 'page_click')!, run: async () => ({ text: 'ran' }) };
    expect(await gateway.call(tool, { target: 'Buy' }, ctx(), () => true)).toMatchObject({
      isError: true,
      text: expect.stringMatching(/was not done: its caller stopped waiting/),
    });
    expect((await gateway.call(tool, { target: 'Buy' }, ctx(), () => false)).text).toBe('ran');
    // Its turn ended meanwhile, however it ended (stopped, or its CLI done or timed out): not done either.
    const ended = new AbortController();
    ended.abort();
    expect(await gateway.call(tool, { target: 'Buy' }, ctx({ signal: ended.signal }), () => false)).toEqual({
      isError: true,
      text: 'The turn ended.',
    });
  });

  it('answers a request too large with 413 before it ends the connection, and connections that never show a token keep no CLI out', async () => {
    const grant = gateway.grant(ctx(), ['browser'], { http: true })!;
    const auth = { Authorization: grant.spec.headers.Authorization! };
    const big = await post(grant.spec.url, `{"jsonrpc":"2.0","id":1,"method":"ping","x":"${'a'.repeat(4 * 1024 * 1024 + 10)}"}`, auth);
    expect(big.status).toBe(413);
    // Many connections that send part of their headers and wait (a command trying to fill the endpoint):
    // more than the endpoint keeps for them, so the oldest give way, and a CLI's request still goes through.
    const port = gateway.httpPort()!;
    const stalled = Array.from({ length: 300 }, () => {
      const c = connect(port, '127.0.0.1', () => c.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
      c.on('error', () => undefined);
      return c;
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const list = await post(grant.spec.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
      expect(list.status).toBe(200);
      expect(stalled.filter((c) => c.destroyed).length).toBeGreaterThanOrEqual(300 - 256);
    } finally {
      for (const c of stalled) c.destroy();
      grant.revoke();
    }
  });

  it('makes the stdio program only if the CLI takes no HTTP MCP server (its fallback), and ends both with the turn', async () => {
    const tmp = join(root, 'data', 'tmp');
    const before = readdirSync(tmp).length;
    const grant = gateway.grant(ctx(), ['browser'], { http: true, fallback: true })!;
    expect(grant.spec.transport).toBe('http');
    expect(readdirSync(tmp)).toHaveLength(before);
    const program = grant.spec.fallback!()!;
    expect(program).toMatchObject({ name: 'relay', transport: 'stdio', command: process.execPath });
    expect(existsSync(program.env.RELAY_GATEWAY_TOKEN_FILE!)).toBe(true);
    grant.revoke();
    expect(existsSync(program.env.RELAY_GATEWAY_TOKEN_FILE!)).toBe(false);
    expect(readdirSync(tmp)).toHaveLength(before);
    // Once the turn is over, no program is made.
    expect(grant.spec.fallback!()).toBeUndefined();
    // Without a Node.js the HTTP way still works, with no program to fall back on; the program's way does not.
    const noNode = new ToolGateway(join(root, 'data7'), join(root, 'data7', 'tmp'), () => undefined);
    await noNode.start();
    try {
      const http = noNode.grant(ctx(), ['browser'], { http: true, fallback: true })!;
      expect(http.spec.transport).toBe('http');
      expect(http.spec.fallback).toBeUndefined();
      expect(noNode.grant(ctx(), ['browser'])).toBeUndefined();
      expect(noNode.listening()).toBe(true);
      http.revoke();
    } finally {
      await noNode.stop();
    }
    expect(noNode.httpPort()).toBeUndefined();
  });

  it("lists the conversation's outbox with the outbox's own tool, given with any group", async () => {
    const tool = outboxTool(() => [
      {
        id: 'o1',
        convId: 'c1',
        messageId: 'm',
        agentId: 'a',
        agentName: 'Alice',
        tool: 'mail_out',
        title: 'Mail to Bob',
        preview: { fields: [] },
        status: 'sent',
        result: 'accepted',
        createdAt: 1,
      },
    ]);
    expect(tool.group).toBeUndefined();
    expect(await tool.run!({}, ctx())).toEqual({ text: '- o1: Mail to Bob — sent (accepted), asked by @Alice' });
    expect(await outboxTool(() => []).run!({}, ctx())).toEqual({ text: 'The outbox is empty.' });
  });
});
