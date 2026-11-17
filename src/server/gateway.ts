import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  GATEWAY_SERVER_NAME,
  OPEN_PROVIDERS,
  type ApprovalAnswer,
  type GatewayTier,
  type OutboxItem,
  type OutboxPreview,
  type Lang,
  type Permission,
  type Provider,
  type RelayToolGroup,
} from '../shared/types';
import { withLang } from './i18n';
import type { ApprovalRequest, McpServerSpec } from './agents/types';
import { GATEWAY_SHIM_SOURCE } from './gatewayShim';

/*
 * Harness Relay's own tools, for every CLI the same way: one MCP server (`GATEWAY_SERVER_NAME`) that
 * the CLI starts as it starts any library server, which passes each call to this server over a local
 * socket (`gatewayShim.ts`). A turn that may use them gets a grant (`ToolGateway.grant()`): a token
 * of its own, for that turn alone, with the tool groups the agent was given and how to ask the user.
 * The tools' credentials (a mail account's password) stay in this server; the CLI sees only the
 * results. What a call may do without the user is its tier (`gatewayDecision()`): `read` runs, `act`
 * is asked about below full access, `send` waits in the outbox until the user sends it (`outbox.ts`).
 */

/** What a tool's call returns to the agent: text (data from elsewhere, never instructions), and images. */
export interface GatewayResult {
  text: string;
  isError?: boolean;
  images?: { data: string; mimeType: string }[];
}

/** The turn a call comes from. */
export interface GatewayContext {
  convId: string;
  agentId: string;
  agentName: string;
  messageId: string;
  /** The conversation's working directory, where a tool may write what the chat shows (a screenshot). */
  cwd: string;
  permission: Permission;
  /** The turn's language: what a call shows the user (approval and outbox cards) is written in it. */
  lang?: Lang;
  /** Nobody may be watching: approvals are refused unless always allowed (`ask` says so itself). */
  unattended: boolean;
  /**
   * Asks the user in the chat, as the CLI's own requests are asked (the turn's `requestApproval`):
   * undefined when the conversation refuses automatically.
   */
  ask?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** Puts a `send` call in the outbox, for the user to send; returns the item (an equal one waiting is returned instead). */
  toOutbox?: (item: Pick<OutboxItem, 'tool' | 'title' | 'preview'> & { args: Record<string, unknown> }) => OutboxItem;
  signal: AbortSignal;
}

/** One of Harness Relay's tools. */
export interface GatewayTool {
  /** As agents see it (`mcp__relay__<name>` in Claude Code). */
  name: string;
  /** The group it comes with; none: with any group (the outbox's own tool). */
  group?: RelayToolGroup;
  tier: GatewayTier;
  description: string;
  /** JSON Schema of its arguments. */
  inputSchema: Record<string, unknown>;
  /** What a call does, for the approval card or the outbox: a line, and what it will send. */
  describe(args: Record<string, unknown>, ctx?: GatewayContext): { title: string; detail?: string; preview?: OutboxPreview };
  /** `read` and `act`: what the call does now. */
  run?(args: Record<string, unknown>, ctx: GatewayContext): Promise<GatewayResult>;
  /** `send`: what the user's Send does, outside any turn; returns what happened, in a line. */
  send?(args: Record<string, unknown>, item: OutboxItem): Promise<string>;
  /**
   * `send`: the arguments kept with the outbox item, with what the card showed pinned (the account
   * it is sent from), so that Send does what the card said even if the settings change meanwhile.
   */
  bind?(args: Record<string, unknown>): Record<string, unknown>;
  /** Why it cannot be used now (no account set up), or undefined when it can. */
  unavailable?(): string | undefined;
  /**
   * `act`: called while the user is asked about a call; returns what to call once they answered (the
   * browser keeps the conversation's browser open meanwhile, so the page they approved a click on is
   * still there).
   */
  asking?(ctx: GatewayContext): () => void;
}

/** What a call of `tier` does in a turn with `permission`, given whether the turn can ask the user. */
export function gatewayDecision(tier: GatewayTier, permission: Permission, canAsk: boolean): 'run' | 'ask' | 'refuse' | 'outbox' {
  if (tier === 'send') return 'outbox';
  if (tier === 'read' || permission === 'full') return 'run';
  return canAsk ? 'ask' : 'refuse';
}

/*
 * What a tool returns from elsewhere (a page, a mail, a calendar) goes to the agent inside a block
 * that says it is data (`<web_page …>`, `<mail …>`): these keep that text from ending the block early
 * or making rows of its own, whatever it holds.
 */

/**
 * Text for inside a data block: a tag of one of `tags` in it, closing or opening (`</mail>`,
 * `<tracked_goal>`), is written with a backslash after its `<` (`<\/mail>`, `<\tracked_goal>`), so it
 * neither ends the block nor starts another.
 */
export function dataBody(text: string, tags: readonly string[]): string {
  if (!tags.length) return text;
  const names = tags.map((t) => t.replace(/[^A-Za-z0-9_-]/g, '')).join('|');
  return text.replace(new RegExp(`<(?=\\s*\\/?\\s*(?:${names})(?![A-Za-z0-9_-]))`, 'gi'), '<\\');
}

/** One row or header line of a data block: its line breaks become spaces. */
export function dataLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
}

/** A value for an attribute of a data block's opening tag: on one line, with no double quote. */
export function dataAttr(text: string): string {
  return dataLine(text).replace(/"/g, "'").replace(/[<>]/g, '');
}

/** A grant: what one turn may call. */
interface Grant {
  ctx: GatewayContext;
  groups: Set<RelayToolGroup>;
  tokenFile: string;
  shimFile: string;
  /** A connection showed its token already (`claimOnce`): no other may. */
  claimed?: boolean;
}

/** Why the gateway cannot be given now: it is not listening, or there is no Node.js to start its MCP program with. */
export type GatewayUnavailable = 'not-started' | 'no-node' | 'no-node-path';

/** A line the server and the shim exchange, after the token. */
type Request = { id: number; method: 'list' } | { id: number; method: 'call'; name?: unknown; arguments?: unknown };

/** How long a connection may take to show its token. */
const TOKEN_WAIT_MS = 10_000;

/** The longest first line (the token's): what a connection may send before it is known. */
const TOKEN_LINE_MAX = 512;

/** The most connections at once with a token of a turn going on: a few CLIs' shims, many times over. */
const MAX_CONNECTIONS = 256;

/**
 * The most connections at once that have shown no such token yet (each for `tokenWaitMs` at most, and
 * one answer once known not to have one), apart from those, so they cannot keep the shims out.
 */
const MAX_PENDING = 256;

/** Longest line the server reads from a socket (the shim refuses a call longer than `GATEWAY_MAX_CALL` itself). */
const MAX_LINE = 4 * 1024 * 1024;

export class ToolGateway {
  private server?: Server;
  private readonly grants = new Map<string, Grant>();
  private readonly tools = new Map<string, GatewayTool>();
  readonly socketPath: string;
  /**
   * Each token serves one connection, its file removed once the shim showed it: on Windows, where
   * Harness Relay gives the sandboxes no protected paths, a sandboxed command could read the file in
   * `data/tmp`. The CLIs start their MCP servers when their session starts, before any command of the
   * agent's runs, so the shim has taken the token by then and nothing is left to read.
   */
  private readonly claimOnce: boolean;
  private readonly tokenWaitMs: number;
  /** The shims' connections, ended when the gateway stops. */
  private readonly sockets = new Set<Socket>();
  /** Of `sockets`, those with no token of a turn going on (yet). */
  private readonly pending = new Set<Socket>();

  constructor(
    /** The data folder: the shim and the socket go in `gateway/` there. */
    private dataDir: string,
    /** Where each turn's token file goes: a folder sandboxed commands cannot read (`relayTmpDir`). */
    private tokenDir: string,
    /** The Node.js the CLIs start the shim with, or undefined when there is none (the desktop app without one). */
    private node: () => string | undefined,
    private platform: NodeJS.Platform = process.platform,
    o: { claimOnce?: boolean; tokenWaitMs?: number } = {},
  ) {
    this.claimOnce = o.claimOnce ?? platform === 'win32';
    this.tokenWaitMs = o.tokenWaitMs ?? TOKEN_WAIT_MS;
    this.socketPath =
      platform === 'win32'
        ? `\\\\.\\pipe\\harness-relay-gateway-${process.pid}-${randomBytes(6).toString('hex')}`
        : join(dataDir, 'gateway', 'relay.sock');
  }

  /** Adds tools (by name; a later one with the same name replaces an earlier one). */
  register(tools: readonly GatewayTool[]): void {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  tool(name: string): GatewayTool | undefined {
    return this.tools.get(name);
  }

  /** The names of every tool: a CLI's request about one of them (`mcp__relay__<name>`) is told apart by these. */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Why agents cannot get the gateway now, or undefined when they can: not started, or no Node.js to
   * start the program with (`no-node-path` on Windows, where Settings → Sandboxes installs none).
   */
  unavailable(): GatewayUnavailable | undefined {
    // No Node.js first: without one nothing could start the program, and that is what to fix.
    if (!this.node()) return this.platform === 'win32' ? 'no-node-path' : 'no-node';
    if (!this.server) return 'not-started';
    return undefined;
  }

  /** Listens on the socket, in a folder only the owner may enter. */
  async start(): Promise<void> {
    if (this.server) return;
    const dir = join(this.dataDir, 'gateway');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
    if (!this.socketPath.startsWith('\\\\') && existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
    const server = createServer((sock) => this.serve(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const token of [...this.grants.keys()]) this.revoke(token);
    for (const sock of this.sockets) sock.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!this.socketPath.startsWith('\\\\')) rmSync(this.socketPath, { force: true });
  }

  /**
   * A grant for one turn: the MCP server to give the CLI (a copy of the shim, with the socket and the
   * token's file in its environment), and a way to end it once the turn is over. The shim and the token
   * go in Harness Relay's own temporary folder, which sandboxed commands can neither read nor write (on
   * macOS and Linux), so no command can change what the CLI starts. Undefined when agents cannot get
   * the gateway now.
   */
  grant(ctx: GatewayContext, groups: readonly RelayToolGroup[]): { spec: McpServerSpec; revoke: () => void } | undefined {
    const node = this.node();
    if (!this.server || !node || !groups.length) return undefined;
    const token = randomBytes(32).toString('base64url');
    const name = `gateway-${randomBytes(8).toString('hex')}`;
    const tokenFile = join(this.tokenDir, `${name}.token`);
    const shimFile = join(this.tokenDir, `${name}.mjs`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(shimFile, GATEWAY_SHIM_SOURCE, { mode: 0o600 });
    this.grants.set(token, { ctx, groups: new Set(groups), tokenFile, shimFile });
    return {
      spec: {
        name: GATEWAY_SERVER_NAME,
        transport: 'stdio',
        command: node,
        args: [shimFile],
        url: '',
        env: { RELAY_GATEWAY_SOCKET: this.socketPath, RELAY_GATEWAY_TOKEN_FILE: tokenFile },
        headers: {},
      },
      revoke: () => this.revoke(token),
    };
  }

  private revoke(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    rmSync(grant.tokenFile, { force: true });
    rmSync(grant.shimFile, { force: true });
  }

  /** The tools a grant can call now. */
  private toolsFor(grant: Grant): GatewayTool[] {
    return [...this.tools.values()].filter((t) => !t.group || grant.groups.has(t.group));
  }

  /** One connection from a shim: its token first, then requests, each answered on a line of its own. */
  private serve(sock: Socket): void {
    sock.setEncoding('utf8');
    let buffer = '';
    let grant: Grant | undefined;
    let authed = false;
    let taken = false;
    const reply = (msg: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
    };
    if (this.pending.size >= MAX_PENDING) return void sock.destroy();
    this.sockets.add(sock);
    this.pending.add(sock);
    sock.on('close', () => {
      this.sockets.delete(sock);
      this.pending.delete(sock);
    });
    sock.on('error', () => {
      /* the shim went away */
    });
    // The shim shows its token at once: a connection that does not is ended.
    const hello = setTimeout(() => {
      if (!authed) sock.destroy();
    }, this.tokenWaitMs);
    hello.unref();
    sock.on('data', (chunk: string) => {
      // Ended after its answer: nothing more is read.
      if (sock.writableEnded) return;
      buffer += chunk;
      // Before its token, a connection is nobody's: it may send no more than that line.
      if (!authed && buffer.length > TOKEN_LINE_MAX && !buffer.slice(0, TOKEN_LINE_MAX).includes('\n')) return sock.destroy();
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) return sock.destroy();
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return sock.destroy();
        }
        if (!authed) {
          const token = (msg as { token?: unknown })?.token;
          grant = typeof token === 'string' ? this.grants.get(token) : undefined;
          authed = true;
          clearTimeout(hello);
          if (grant && this.claimOnce) {
            // Taken by the CLI's own shim already: another connection with it is refused.
            if (grant.claimed) {
              grant = undefined;
              taken = true;
            } else {
              grant.claimed = true;
              rmSync(grant.tokenFile, { force: true });
            }
          }
          if (grant) {
            this.pending.delete(sock);
            if (this.sockets.size - this.pending.size > MAX_CONNECTIONS) return sock.destroy();
          } else {
            // A token the server does not know (its turn is over) or already serves: its first request is
            // answered with why, and the connection ends; one that asks nothing ends after the token's wait.
            setTimeout(() => sock.destroy(), this.tokenWaitMs).unref();
          }
          continue;
        }
        const req = msg as Request;
        if (typeof req?.id !== 'number') continue;
        // Looked up again for each request: a turn that ended takes its tools with it.
        const live = grant && [...this.grants.values()].includes(grant) ? grant : undefined;
        if (!live) {
          reply({
            id: req.id,
            error: taken
              ? "This turn's tools are in use by its own MCP server already"
              : 'This turn is over: Harness Relay has no tools for it any more',
          });
          return void sock.end();
        }
        void this.handle(live, req).then(
          (result) => reply({ id: req.id, result }),
          (err: Error) => reply({ id: req.id, error: err.message }),
        );
      }
    });
  }

  private async handle(grant: Grant, req: Request): Promise<unknown> {
    if (req.method === 'list') {
      return {
        tools: this.toolsFor(grant).map((t) => ({
          name: t.name,
          description: t.unavailable?.() ? `${t.description} (Not available now: ${t.unavailable()})` : t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.tier === 'read', destructiveHint: t.tier !== 'read', openWorldHint: true },
        })),
      };
    }
    if (req.method !== 'call') throw new Error('Unknown request');
    const tool = typeof req.name === 'string' ? this.tools.get(req.name) : undefined;
    if (!tool || (tool.group && !grant.groups.has(tool.group)))
      return toolResult({ text: `No such tool: ${String(req.name)}`, isError: true });
    const args =
      req.arguments && typeof req.arguments === 'object' && !Array.isArray(req.arguments) ? (req.arguments as Record<string, unknown>) : {};
    const ctx = grant.ctx;
    return toolResult(await (ctx.lang ? withLang(ctx.lang, () => this.call(tool, args, ctx)) : this.call(tool, args, ctx)));
  }

  /** A call, as its tier and the turn allow. */
  async call(tool: GatewayTool, args: Record<string, unknown>, ctx: GatewayContext): Promise<GatewayResult> {
    const missing = tool.unavailable?.();
    if (missing) return { text: `${tool.name} cannot be used now: ${missing}`, isError: true };
    const decision = gatewayDecision(tool.tier, ctx.permission, Boolean(ctx.ask));
    if (decision === 'refuse')
      return {
        text: `The user's settings refuse ${tool.name} in this conversation without asking; do not try it another way.`,
        isError: true,
      };
    if (decision === 'outbox') {
      if (!ctx.toOutbox) return { text: `${tool.name} cannot be used in this run.`, isError: true };
      let described: ReturnType<GatewayTool['describe']>;
      try {
        described = tool.describe(args, ctx);
      } catch (err) {
        return { text: (err as Error).message, isError: true };
      }
      const item = ctx.toOutbox({
        tool: tool.name,
        title: described.title,
        preview: described.preview ?? { fields: [] },
        args: tool.bind ? tool.bind(args) : args,
      });
      return {
        text: `Not sent yet: "${item.title}" is waiting in the user's outbox (item ${item.id}). Only the user can send it, with its Send button in the chat; it may happen later. Do not try to send it another way. Tell the user it is waiting for them.`,
      };
    }
    if (decision === 'ask') {
      let described: ReturnType<GatewayTool['describe']>;
      try {
        described = tool.describe(args, ctx);
      } catch (err) {
        return { text: (err as Error).message, isError: true };
      }
      // Keyed as the gateway's own (`relay:<tool>`), so "always allow" is never another server's tool of that name;
      // no folder lock either: the call writes nothing in the working directory.
      const answered = tool.asking?.(ctx);
      const answer = await ctx.ask!({
        kind: 'other',
        tool: gatewayApprovalTool(tool.name),
        detail: described.title,
        ...(described.detail ? { reason: described.detail } : {}),
        noLock: true,
      }).finally(() => answered?.());
      if (!answer.allow) return { text: `The user declined ${tool.name}${answer.note ? `: ${answer.note}` : ''}.`, isError: true };
    }
    if (ctx.signal.aborted) return { text: 'The turn was stopped.', isError: true };
    try {
      return await tool.run!(args, ctx);
    } catch (err) {
      return { text: `${tool.name} failed: ${(err as Error).message}`, isError: true };
    }
  }
}

/** A result as MCP's `tools/call` gives it. */
function toolResult(r: GatewayResult): { content: unknown[]; isError: boolean } {
  return {
    content: [{ type: 'text', text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))],
    isError: Boolean(r.isError),
  };
}

/**
 * The CLIs that get the gateway in full access only: below it one sandbox holds both the commands they
 * run and the MCP servers they start, and it denies them the protected paths, Harness Relay's `data/tmp`
 * among them, where each turn's copy of the program and its token are. There the program could not even
 * start, and opening `data/tmp` to it would open the token to every command too. Grok's own sandbox (its
 * kernel `deny`), and the open agents' (Harness Relay's own sandbox, around the whole process, which
 * does not open the gateway's socket either).
 */
export const GATEWAY_FULL_ACCESS_ONLY: readonly Provider[] = ['grok', ...OPEN_PROVIDERS];

/** How the gateway's own approval names a tool (and keys "always allow" for it): `relay:<tool>`. */
export const gatewayApprovalTool = (name: string) => `${GATEWAY_SERVER_NAME}:${name}`;

/**
 * The gateway's tool a CLI's own approval request is about, if it is one: a request for a tool (kind
 * `other`) named exactly as the CLI names the gateway's (`mcp__relay__browser_open` in Claude Code,
 * `relay:browser_open` in Codex, `relay/browser_open`, `relay__browser_open`, `relay.browser_open`),
 * never a command, a path or a URL with such words in it, nor another server's tool of the same name.
 * The turn answers such a request yes, and the gateway decides by the tool's tier (`Orchestrator`).
 */
export function gatewayToolNamed(names: readonly string[], req: Pick<ApprovalRequest, 'kind' | 'tool'>): string | undefined {
  if (req.kind !== 'other' || !req.tool) return undefined;
  const s = GATEWAY_SERVER_NAME;
  return names.find((n) => [`mcp__${s}__${n}`, `${s}:${n}`, `${s}__${n}`, `${s}/${n}`, `${s}.${n}`].includes(req.tool!));
}

/** The outbox's own tool, given with any group: what this conversation's outbox holds and what became of it. */
export function outboxTool(list: (convId: string) => OutboxItem[]): GatewayTool {
  return {
    name: 'outbox_status',
    tier: 'read',
    description:
      "List what is in this conversation's outbox: what you or a teammate asked to send (a mail, an invitation) and whether the user sent it, discarded it, or it is still waiting for them.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => ({ title: 'List the outbox' }),
    run: async (_args, ctx) => {
      const items = list(ctx.convId);
      if (!items.length) return { text: 'The outbox is empty.' };
      return {
        text: items
          .map((i) => `- ${i.id}: ${i.title} — ${i.status}${i.result ? ` (${i.result})` : ''}, asked by @${i.agentName}`)
          .join('\n'),
      };
    },
  };
}
