import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, OutboxItem } from '../src/shared/types';
import { removeTree } from '../src/server/fsRemove';
import { ToolGateway, gatewayDecision, gatewayToolNamed, outboxTool, type GatewayContext, type GatewayTool } from '../src/server/gateway';
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
    expect(gatewayToolNamed(names, other('relay/mail_send'))).toBe('mail_send');
    expect(gatewayToolNamed(names, other('relay__mail_send'))).toBe('mail_send');
    for (const tool of ['mcp__evil__browser_open', 'browser_open', 'mcp__relay__browser_opener', 'mcp__x-relay__browser_open', 'mcp__nonrelay__mail_send', 'https://h/relay/mail_send', undefined]) {
      expect(gatewayToolNamed(names, other(tool))).toBeUndefined();
    }
    // A command, a file or a URL that mentions one is not about it.
    expect(gatewayToolNamed(names, { kind: 'command', tool: 'mcp__relay__browser_open' })).toBeUndefined();
    expect(gatewayToolNamed(names, { kind: 'fetch' })).toBeUndefined();
  });
});

describe('the gateway and the MCP server the CLIs start', () => {
  let gateway: ToolGateway;
  const asked: ApprovalRequest[] = [];
  const outboxed: { tool: string; title: string; args: Record<string, unknown> }[] = [];
  let answer: ApprovalAnswer = { allow: true };
  const children: ChildProcess[] = [];

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
      run: async (a) => ({ text: `Clicked ${String(a.target)}` }),
    },
    {
      name: 'mail_out',
      group: 'mail',
      tier: 'send',
      description: 'Send a mail',
      inputSchema: { type: 'object' },
      describe: (a) => ({ title: `Mail to ${String(a.to)}`, preview: { fields: [{ label: 'To', value: String(a.to) }], body: String(a.body) } }),
      send: async () => 'sent',
    },
    { name: 'broken', group: 'browser', tier: 'read', description: 'x', inputSchema: {}, describe: () => ({ title: 'x' }), run: async () => Promise.reject(new Error('kaput')) },
    { name: 'later', group: 'mail', tier: 'read', description: 'Needs an account', inputSchema: {}, describe: () => ({ title: 'x' }), unavailable: () => 'no mail account', run: async () => ({ text: '' }) },
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
      return { id: 'ob1', convId: 'c1', messageId: 'm1', agentId: 'a', agentName: 'Alice', tool: o2.tool, title: o2.title, preview: o2.preview, status: 'pending', createdAt: 1 } as OutboxItem;
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
    'speaks MCP on stdio: initialize, the granted groups\' tools, and calls passed to the server',
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
      const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
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
      expect((await mcp.request('tools/call', { name: 'mail_out', arguments: {} })).result).toMatchObject({ isError: true, content: [{ text: 'No such tool: mail_out' }] });
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

  it(
    'asks before acting (and not again right after the CLI asked about the same tool), refuses when nobody can be asked, and puts sends in the outbox',
    async () => {
      const call = (name: string, args: Record<string, unknown>, c: GatewayContext) => gateway.call(gateway.tool(name)!, args, c);
      expect(await call('page_click', { target: 'Buy' }, ctx())).toEqual({ text: 'Clicked Buy' });
      expect(asked).toEqual([{ kind: 'other', tool: 'relay:page_click', detail: 'Click Buy', reason: 'on example.com', noLock: true }]);
      answer = { allow: false, note: 'not that one' };
      expect(await call('page_click', { target: 'Buy' }, ctx())).toEqual({ text: 'The user declined page_click: not that one.', isError: true });
      asked.length = 0;
      expect(await call('page_click', { target: 'Buy' }, ctx({ justAllowed: (n) => n === 'page_click' }))).toEqual({ text: 'Clicked Buy' });
      expect(asked).toEqual([]);
      expect(await call('page_click', { target: 'Buy' }, ctx({ permission: 'full' }))).toEqual({ text: 'Clicked Buy' });
      expect((await call('page_click', { target: 'Buy' }, ctx({ ask: undefined }))).isError).toBe(true);

      const sent = await call('mail_out', { to: 'bob@example.com', body: 'Hi' }, ctx({ permission: 'full' }));
      expect(sent.text).toMatch(/^Not sent yet: "Mail to bob@example.com" is waiting in the user's outbox \(item ob1\)/);
      expect(outboxed).toEqual([{ tool: 'mail_out', title: 'Mail to bob@example.com', preview: { fields: [{ label: 'To', value: 'bob@example.com' }], body: 'Hi' }, args: { to: 'bob@example.com', body: 'Hi' } }]);
      expect(await call('later', {}, ctx())).toEqual({ text: 'later cannot be used now: no mail account', isError: true });
    },
  );

  it(
    'answers a shim with a token it does not know with errors, and gives no grant without a Node.js or a group',
    async () => {
      const g = gateway.grant(ctx(), ['browser'])!;
      const shim = join(root, 'shim-copy.mjs');
      writeFileSync(shim, readFileSync(g.spec.args[0]!));
      g.revoke();
      const mcp = client({ command: process.execPath, args: [shim], env: { RELAY_GATEWAY_SOCKET: gateway.socketPath, RELAY_GATEWAY_TOKEN_FILE: join(root, 'nope') } });
      await mcp.request('initialize', { protocolVersion: '2025-06-18' });
      expect((await mcp.request('tools/list')).error.message).toMatch(/turn is over/);
      expect(gateway.grant(ctx(), [])).toBeUndefined();
      const noNode = new ToolGateway(join(root, 'data2'), join(root, 'data2', 'tmp'), () => undefined);
      await noNode.start();
      expect(noNode.unavailable()).toBe('no-node');
      expect(noNode.grant(ctx(), ['browser'])).toBeUndefined();
      await noNode.stop();
      expect(new ToolGateway(join(root, 'data3'), join(root, 'tmp3'), () => process.execPath).unavailable()).toBe('not-started');
    },
    slow(20_000),
  );

  it(
    "serves each token to one connection where data/tmp cannot be protected (Windows): its file goes once the CLI's shim has shown it",
    async () => {
      const once = new ToolGateway(join(root, 'data4'), join(root, 'data4', 'tmp'), () => process.execPath, process.platform, { claimOnce: true, tokenWaitMs: 300 });
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
        // A connection that shows no token is ended, and so is one whose first line is longer than a token's.
        const silent = connect(once.socketPath);
        await new Promise<void>((resolve) => silent.on('close', () => resolve()).on('error', () => undefined));
        const flood = connect(once.socketPath, () => flood.write('x'.repeat(4096)));
        await new Promise<void>((resolve) => flood.on('close', () => resolve()).on('error', () => undefined));
        // The CLI's own shim goes on working.
        expect((await mcp.request('tools/call', { name: 'page_title', arguments: { url: 'https://example.com' } })).result.isError).toBe(false);
        grant.revoke();
      } finally {
        // The shims' connections end first: a server closing waits for them.
        for (const c of children.splice(0)) c.kill();
        await once.stop();
      }
    },
    slow(20_000),
  );

  it("lists the conversation's outbox with the outbox's own tool, given with any group", async () => {
    const tool = outboxTool(() => [
      { id: 'o1', convId: 'c1', messageId: 'm', agentId: 'a', agentName: 'Alice', tool: 'mail_out', title: 'Mail to Bob', preview: { fields: [] }, status: 'sent', result: 'accepted', createdAt: 1 },
    ]);
    expect(tool.group).toBeUndefined();
    expect(await tool.run!({}, ctx())).toEqual({ text: '- o1: Mail to Bob — sent (accepted), asked by @Alice' });
    expect(await outboxTool(() => []).run!({}, ctx())).toEqual({ text: 'The outbox is empty.' });
  });
});
