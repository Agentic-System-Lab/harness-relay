import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  GATEWAY_SERVER_NAME,
  OPEN_PROVIDERS,
  type ApprovalAnswer,
  type GatewayTier,
  type HandoverPart,
  type OutboxItem,
  type OutboxPreview,
  type Lang,
  type Permission,
  type Provider,
  type RelayToolGroup,
} from '../shared/types';
import { currentLang, t, withLang } from './i18n';
import type { ApprovalRequest, McpServerSpec } from './agents/types';
import { GATEWAY_PROTOCOLS, GATEWAY_SHIM_SOURCE, socketPathMax } from './gatewayShim';
import { HOOK_INLINE_TOKEN_ENV, HOOK_SHIM_SOURCE } from './hookShim';
import { realPath, RUN_TMP_PREFIXES } from './protect';

/*
 * Harness Relay's own tools, for every CLI the same way: one MCP server (`GATEWAY_SERVER_NAME`), in one
 * of two ways. Over loopback HTTP (`GATEWAY_OVER_HTTP`): the CLI connects to this server's endpoint on
 * 127.0.0.1 itself, the turn's token in a header of the MCP server it was given in its session, so only
 * in its memory, never in a file or a variable (#88). Or as a program the CLI starts as it starts any
 * library server, which passes each call to this server over a local socket (`gatewayShim.ts`), its
 * token in a file the sandboxes cannot read. A turn that may use them gets a grant (`ToolGateway.grant()`):
 * a token of its own, for that turn alone, with the tool groups the agent was given and how to ask the user.
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
  /**
   * Shows the card of a hand-over of the chat's browser in the reply (`browser_hand_over`), and keeps it
   * up to date as the hand-over goes; the conversation waits for the user meanwhile. Undefined where nobody
   * may be asked (as `ask`, and in a run nobody may be watching).
   */
  handoverCard?: (part: HandoverPart) => { update(change: Partial<HandoverPart>): void };
  /**
   * Counts tokens a tool spent itself for the turn (RLM's sub-model, `llm_query()`), which go into the
   * turn's reply with the CLI's own (`withSubModelTokens()` in `runCode.ts`).
   */
  usage?: (tokens: { inputTokens: number; outputTokens: number; costUsd?: number }) => void;
  signal: AbortSignal;
}

/** The exact action paired with the preview the user is asked to approve. */
export interface PreparedOutboxCall {
  title: string;
  preview: OutboxPreview;
  args: Record<string, unknown>;
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
  /** `send`: prepare the preview and frozen arguments together when they depend on the same snapshot. */
  prepare?(args: Record<string, unknown>, ctx: GatewayContext): PreparedOutboxCall | Promise<PreparedOutboxCall>;
  /**
   * `read` and `act`: what the call does now. A `scoped` tool is given `scope`: the turn's other tools,
   * which it may call as the turn would.
   */
  run?(args: Record<string, unknown>, ctx: GatewayContext, scope?: GatewayScope): Promise<GatewayResult>;
  /**
   * It calls the turn's other tools (`run_code`, `runCode.ts`), through the `GatewayScope` its `run` is
   * given. Never one of the tools in a scope, so it cannot call itself or another such tool.
   */
  scoped?: boolean;
  /**
   * Whether it is offered now (`run_code`: while Settings → Labs has one of its modes on): one that is not
   * is neither listed nor called. Undefined: always.
   */
  offered?(): boolean;
  /**
   * Only the agent may call it, never code through a scoped tool (`run_code`): it hands something to the
   * user (`browser_hand_over`), whose time no limit of the code's should count.
   */
  direct?: boolean;
  /** `send`: what the user's Send does, outside any turn; returns what happened, in a line. */
  send?(args: Record<string, unknown>, item: OutboxItem, recordProgress?: (result: string) => void): Promise<string>;
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

/**
 * What a `scoped` tool reaches of its turn's grant: the turn's other tools (never a scoped one), each
 * call decided as the turn's own call of it would be (`ToolGateway.call()`: its tier, the user asked
 * below full access, a send put in the outbox), and only while the turn goes on.
 */
export interface GatewayScope {
  tools: GatewayTool[];
  /** Whether the scoped tool's own caller stopped waiting for it (the CLI's MCP call closed): it may stop then. */
  gone?: () => boolean;
  /**
   * `gone`: whether the scoped tool stopped waiting for it, checked as the gateway checks its own caller's.
   * `asking`: wraps each question the call asks the user, an act's and one its tool asks itself (the
   * browser about a new host), every one of them marked on its card as asked by code.
   */
  call(name: string, args: Record<string, unknown>, gone?: () => boolean, asking?: GatewayAsking): Promise<GatewayResult>;
}

/**
 * Wraps one question a call from a scoped tool asks the user (`GatewayContext.ask`): it may answer it
 * without asking (`allow: false`, as a limit says), and knows how long the user takes to answer.
 */
export type GatewayAsking = (ask: () => Promise<ApprovalAnswer>) => Promise<ApprovalAnswer>;

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
  /** Over HTTP: the token is only in the CLI's memory; none of the files below. */
  http?: boolean;
  /** The stdio program's token file and its copy of the program. */
  tokenFile?: string;
  shimFile?: string;
  /** A connection showed its token already (`claimOnce`): no other may. */
  claimed?: boolean;
}

/** What a CLI's hook program prints, and the code it exits with (`hookShim.ts`). */
export interface HookReply {
  stdout?: string;
  stderr?: string;
  code: number;
}

/** What answers a turn's hook program: the call as the CLI gave it, before or after it ran. */
export type HookHandler = (when: 'before' | 'after', payload: unknown) => Promise<HookReply>;

/** The program a CLI runs as its hook command, with its arguments; the CLI adds `before` or `after`. */
export interface HookProgram {
  bin: string;
  args: string[];
  /** Passed only to an inline hook command, never to the CLI's process environment. */
  env?: Record<string, string>;
  /** The inline hook's Unix socket directory. Linux must make this directory visible to the hook. */
  socketDir?: string;
}
export type HookProgramMode = 'file' | 'inline';

/**
 * What answers an interactive command's password helper (`askpassShim.ts`): the line the user typed
 * for its prompt, or undefined when they refused (or the session is over).
 */
export type AskpassHandler = (prompt: string) => Promise<string | undefined>;

/** An interactive command's password helper's grant (`ToolGateway.askpassGrant()`). */
export interface AskpassGrant {
  /** Its token, for the file the helper reads it from. */
  token: string;
  /** The gateway's socket, and the Node.js to run the helper with. */
  socketPath: string;
  node: string;
  revoke: () => void;
}

/** A turn's hook grant: its handler, and its program's token file and copy. */
interface HookGrant {
  handle: HookHandler;
  files?: string[];
}

/** How a turn gets the gateway (`ToolGateway.grant()`). */
export interface GrantOptions {
  /** Over the loopback HTTP endpoint, the token only in the CLI's memory, instead of the stdio program. */
  http?: boolean;
  /**
   * With `http`: the stdio program too, made only if the CLI turns out to take no HTTP MCP server
   * (`McpServerSpec.fallback`). Not for a CLI whose sandbox holds the MCP servers it starts below full
   * access, where the program could not run.
   */
  fallback?: boolean;
}

/** Why the gateway cannot be given now: it is not listening, or there is no Node.js to start its MCP program with. */
export type GatewayUnavailable = 'not-started' | 'no-node' | 'no-node-path';

/** The socket's path, under the data folder. */
const SOCKET_IN_DATA = ['gateway', 'relay.sock'];

/** The gateway cannot listen: its socket's path does not fit (`gatewayListenPath`), a setting to change, not a fault. */
export class GatewaySocketPathError extends Error {}

/**
 * Where the gateway listens for its socket in `dataDir`: the socket's own path; or, where that is too
 * long for a Unix socket's (`socketPathMax`: Node on macOS would cut it, so the socket would land
 * under another name, `relay.so`, or outside its folder, and the next start would find it in its way),
 * the same path from the server's working folder (`cwd`, which the server never changes), as
 * `npm run dev` in an agent's worktree has it (`data/gateway/relay.sock`). The programs that connect
 * reach a long path from its own folder (`SOCKET_REACH_SOURCE`). `refusal`, in the log's words, when
 * neither fits. Not for Windows, whose gateway is a named pipe.
 */
export function gatewayListenPath(
  dataDir: string,
  platform: NodeJS.Platform,
  cwd: string | undefined,
): { path: string; refusal?: undefined } | { path?: undefined; refusal: string } {
  const path = join(dataDir, ...SOCKET_IN_DATA);
  const max = socketPathMax(platform);
  // Bytes, not characters: a path in Chinese takes three for each of its characters.
  const bytes = Buffer.byteLength(path);
  if (bytes <= max) return { path };
  const near = cwd === undefined ? '' : relative(cwd, path);
  if (near && !isAbsolute(near) && Buffer.byteLength(near) <= max) return { path: near };
  const folderMax = max - (bytes - Buffer.byteLength(dataDir));
  return {
    refusal: `its socket's path (${path}) is ${bytes} bytes, longer than the ${max} a Unix socket's path may have here, also from the server's working folder: set RELAY_DATA_DIR to a folder whose path is at most ${folderMax} bytes (UTF-8: a character outside ASCII takes 2 to 4), or start Harness Relay from a folder near its data folder, and restart it`,
  };
}

/** The server's working folder, or undefined when it is gone. */
function workingFolder(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/** A line the server and the shim exchange, after the token. */
type Request =
  | { id: number; method: 'list' }
  | { id: number; method: 'call'; name?: unknown; arguments?: unknown }
  | { id: number; method: 'hook'; when?: unknown; payload?: unknown }
  | { id: number; method: 'askpass'; prompt?: unknown };

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

/** The HTTP endpoint's path. */
export const GATEWAY_HTTP_PATH = '/mcp';

export class ToolGateway {
  private server?: Server;
  private readonly grants = new Map<string, Grant>();
  /** The turns' hook programs' grants, by token: each program connects once per call, and the token stays. */
  private readonly hookGrants = new Map<string, HookGrant>();
  /** The interactive commands' password helpers' grants, by token: one a session, for each of its prompts. */
  private readonly askGrants = new Map<string, AskpassHandler>();
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
  /** The HTTP endpoint's connections that have shown a turn's token, and those that have not yet (`MAX_PENDING`, `tokenWaitMs`). */
  private readonly httpKnown = new Set<Socket>();
  private readonly httpUnknown = new Set<Socket>();
  /** The loopback HTTP endpoint (127.0.0.1, a port of its own). */
  private http?: HttpServer;
  private httpAt?: number;

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
        : join(dataDir, ...SOCKET_IN_DATA);
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
   * Why the stdio program cannot be given now, or undefined when it can: not started, or no Node.js to
   * start it with (`no-node-path` on Windows, where Settings → Sandboxes installs none). The CLIs that
   * connect over HTTP need no Node.js (`httpPort()`).
   */
  unavailable(): GatewayUnavailable | undefined {
    // No Node.js first: without one nothing could start the program, and that is what to fix.
    if (!this.node()) return this.platform === 'win32' ? 'no-node-path' : 'no-node';
    if (!this.server) return 'not-started';
    return undefined;
  }

  /** Whether it is listening (its socket and its HTTP endpoint). */
  listening(): boolean {
    return Boolean(this.server);
  }

  /** The HTTP endpoint's port, while it listens: Harness Relay's own, which its browser never opens. */
  httpPort(): number | undefined {
    return this.httpAt;
  }

  /**
   * Listens on the socket, in a folder only the owner may enter: by a path short enough for a Unix
   * socket's (`gatewayListenPath`), or not at all (`GatewaySocketPathError`, before it makes anything),
   * never on a cut one somewhere else.
   */
  async start(): Promise<void> {
    if (this.server) return;
    let listenAt = this.socketPath;
    if (!this.socketPath.startsWith('\\\\')) {
      const at = gatewayListenPath(this.dataDir, this.platform, workingFolder());
      if (at.refusal !== undefined) throw new GatewaySocketPathError(at.refusal);
      listenAt = at.path;
    }
    const dir = join(this.dataDir, SOCKET_IN_DATA[0]!);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
    if (!this.socketPath.startsWith('\\\\') && existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
    const server = createServer((sock) => this.serve(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenAt, () => {
        server.off('error', reject);
        resolve();
      });
    });
    // The HTTP endpoint, on loopback only. A request must come at once, as an MCP client sends it (its
    // answer may wait for the user as long as it takes: these limits are for receiving it only), and a
    // connection that has shown no turn's token counts apart, as on the socket, so such connections
    // cannot keep the CLIs out (`httpUnknown`, `MAX_PENDING`), and ends after the token's wait.
    const http = createHttpServer((req, res) => this.serveHttp(req, res));
    http.headersTimeout = this.tokenWaitMs;
    http.requestTimeout = Math.max(this.tokenWaitMs, 30_000);
    http.maxConnections = MAX_CONNECTIONS + MAX_PENDING;
    http.on('connection', (sock: Socket) => {
      // Full: the oldest gives way. A CLI sends its request as it connects, so it is known within moments,
      // while connections that never show a token cannot hold every place and turn new ones away.
      if (this.httpUnknown.size >= MAX_PENDING) this.httpUnknown.values().next().value?.destroy();
      this.httpUnknown.add(sock);
      const timer = setTimeout(() => this.httpUnknown.has(sock) && sock.destroy(), this.tokenWaitMs);
      timer.unref();
      sock.on('close', () => {
        clearTimeout(timer);
        this.httpUnknown.delete(sock);
        this.httpKnown.delete(sock);
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
    this.http = http;
    this.httpAt = (http.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const http = this.http;
    this.server = undefined;
    this.http = undefined;
    this.httpAt = undefined;
    for (const token of [...this.grants.keys()]) this.revoke(token);
    for (const token of [...this.hookGrants.keys()]) this.revokeHook(token);
    this.askGrants.clear();
    for (const sock of this.sockets) sock.destroy();
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
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
  grant(
    ctx: GatewayContext,
    groups: readonly RelayToolGroup[],
    o: GrantOptions = {},
  ): { spec: McpServerSpec; revoke: () => void } | undefined {
    if (!this.server || !groups.length) return undefined;
    if (o.http && this.httpAt) {
      // Over HTTP: nothing written anywhere; the token goes to the CLI in its session's MCP servers alone.
      const token = randomBytes(32).toString('base64url');
      this.grants.set(token, { ctx, groups: new Set(groups), http: true });
      const tokens = [token];
      let over = false;
      const fallback =
        o.fallback && this.node()
          ? () => {
              if (over) return undefined;
              const g = this.stdioGrant(ctx, groups);
              if (g) tokens.push(g.token);
              return g?.spec;
            }
          : undefined;
      return {
        spec: {
          name: GATEWAY_SERVER_NAME,
          transport: 'http',
          command: '',
          args: [],
          url: `http://127.0.0.1:${this.httpAt}${GATEWAY_HTTP_PATH}`,
          env: {},
          headers: { Authorization: `Bearer ${token}` },
          ...(fallback ? { fallback } : {}),
        },
        revoke: () => {
          over = true;
          for (const t of tokens) this.revoke(t);
        },
      };
    }
    const g = this.stdioGrant(ctx, groups);
    return g && { spec: g.spec, revoke: () => this.revoke(g.token) };
  }

  /** A grant for the stdio program: its copy and its token's file in `data/tmp`; none without Node.js. */
  private stdioGrant(ctx: GatewayContext, groups: readonly RelayToolGroup[]): { token: string; spec: McpServerSpec } | undefined {
    const node = this.node();
    if (!this.server || !node) return undefined;
    const token = randomBytes(32).toString('base64url');
    const name = `gateway-${randomBytes(8).toString('hex')}`;
    const tokenFile = join(this.tokenDir, `${name}.token`);
    const shimFile = join(this.tokenDir, `${name}.mjs`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(shimFile, GATEWAY_SHIM_SOURCE, { mode: 0o600 });
    this.grants.set(token, { ctx, groups: new Set(groups), tokenFile, shimFile });
    return {
      token,
      spec: {
        name: GATEWAY_SERVER_NAME,
        transport: 'stdio',
        command: node,
        args: [shimFile],
        url: '',
        env: { RELAY_GATEWAY_SOCKET: this.socketPath, RELAY_GATEWAY_TOKEN_FILE: tokenFile },
        headers: {},
      },
    };
  }

  /**
   * A turn's hook program (`hookShim.ts`): a copy and its token's file in `data/tmp`, where sandboxed
   * commands cannot reach them, and `handle` to answer each call it passes on. Its token serves every
   * connection until `revoke`, as the CLI runs the program once for each call. The inline program
   * carries its token in the hook-specific environment, so it can run inside Copilot's sandbox without
   * opening the temporary folder. Undefined when the program cannot
   * be given now (not listening, no Node.js to start it with).
   */
  hookProgram(handle: HookHandler, mode: HookProgramMode = 'file'): { program: HookProgram; revoke: () => void } | undefined {
    const node = this.node();
    if (!this.server || !node) return undefined;
    const token = randomBytes(32).toString('base64url');
    const revoke = () => this.revokeHook(token);
    const lang = currentLang();
    const run: HookHandler = (when, payload) => withLang(lang, () => handle(when, payload));
    if (mode === 'inline') {
      const socketDir = realPath(dirname(this.socketPath));
      const socketPath = join(socketDir, basename(this.socketPath));
      this.hookGrants.set(token, { handle: run });
      return {
        program: {
          bin: node,
          args: ['--input-type=module', '-e', HOOK_SHIM_SOURCE, '--', 'relay-hook', socketPath, ''],
          env: { [HOOK_INLINE_TOKEN_ENV]: token },
          socketDir,
        },
        revoke,
      };
    }
    const name = `${RUN_TMP_PREFIXES.hook}${randomBytes(8).toString('hex')}`;
    const tokenFile = join(this.tokenDir, `${name}.token`);
    const shimFile = join(this.tokenDir, `${name}.mjs`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    try {
      writeFileSync(shimFile, HOOK_SHIM_SOURCE, { mode: 0o600 });
    } catch (err) {
      rmSync(tokenFile, { force: true });
      rmSync(shimFile, { force: true });
      throw err;
    }
    this.hookGrants.set(token, { handle: run, files: [tokenFile, shimFile] });
    return { program: { bin: node, args: [shimFile, this.socketPath, tokenFile] }, revoke };
  }

  /**
   * A grant for one interactive command's password helper (`askpassShim.ts`, `src/server/interactive.ts`):
   * a token for that session alone, serving each run of the helper (one connection, one prompt each)
   * until `revoke`, its prompts answered by `ask`. Its program and token's file are the session's own
   * to write. Undefined when it cannot be given now (not listening, no Node.js to start it with).
   */
  askpassGrant(ask: AskpassHandler): AskpassGrant | undefined {
    const node = this.node();
    if (!this.server || !node || this.platform === 'win32') return undefined;
    const token = randomBytes(32).toString('base64url');
    const lang = currentLang();
    this.askGrants.set(token, (prompt) => withLang(lang, () => ask(prompt)));
    return { token, socketPath: this.socketPath, node, revoke: () => void this.askGrants.delete(token) };
  }

  private revokeHook(token: string): void {
    const grant = this.hookGrants.get(token);
    if (!grant) return;
    this.hookGrants.delete(token);
    for (const file of grant.files ?? []) rmSync(file, { force: true });
  }

  private revoke(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    if (grant.tokenFile) rmSync(grant.tokenFile, { force: true });
    if (grant.shimFile) rmSync(grant.shimFile, { force: true });
  }

  /** The tools a grant can call now. */
  private toolsFor(grant: Grant): GatewayTool[] {
    return [...this.tools.values()].filter((t) => (!t.group || grant.groups.has(t.group)) && t.offered?.() !== false);
  }

  /** One connection from a shim: its token first, then requests, each answered on a line of its own. */
  private serve(sock: Socket): void {
    sock.setEncoding('utf8');
    let buffer = '';
    let grant: Grant | undefined;
    let hookToken: string | undefined;
    let askToken: string | undefined;
    let hookAsked = false;
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
          // The program's tokens only: one given over HTTP never works here.
          grant = typeof token === 'string' ? this.grants.get(token) : undefined;
          if (grant?.http) grant = undefined;
          // A hook program's: its token serves each call's own connection.
          if (!grant && typeof token === 'string' && this.hookGrants.has(token)) hookToken = token;
          // An interactive command's password helper's: one prompt on each connection, as a hook's call.
          if (!grant && !hookToken && typeof token === 'string' && this.askGrants.has(token)) askToken = token;
          authed = true;
          clearTimeout(hello);
          if (grant && this.claimOnce) {
            // Taken by the CLI's own shim already: another connection with it is refused.
            if (grant.claimed) {
              grant = undefined;
              taken = true;
            } else {
              grant.claimed = true;
              if (grant.tokenFile) rmSync(grant.tokenFile, { force: true });
            }
          }
          if (grant || hookToken || askToken) {
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
        if (askToken) {
          if (hookAsked) return;
          hookAsked = true;
          // Looked up again: a session that ended takes its helper with it.
          const ask = this.askGrants.get(askToken);
          const finish = (message: unknown) => {
            reply(message);
            sock.end();
          };
          if (!ask || req.method !== 'askpass' || typeof req.prompt !== 'string') {
            finish({ id: req.id, error: ask ? 'Unknown request' : 'This command is over: Harness Relay asks nothing for it any more' });
            continue;
          }
          void ask(req.prompt).then(
            (line) => finish(line === undefined ? { id: req.id, error: 'Refused' } : { id: req.id, result: { line } }),
            (err: Error) => finish({ id: req.id, error: err.message }),
          );
          continue;
        }
        if (hookToken) {
          // Each invocation makes one call on its own connection.
          if (hookAsked) return;
          hookAsked = true;
          // Looked up again: a turn that ended takes its hooks with it.
          const hook = this.hookGrants.get(hookToken);
          if (!hook || req.method !== 'hook' || (req.when !== 'before' && req.when !== 'after')) {
            reply({ id: req.id, error: hook ? 'Unknown request' : 'This turn is over: Harness Relay has no hooks for it any more' });
            return void sock.end();
          }
          const finish = (message: unknown) => {
            reply(message);
            sock.end();
          };
          void hook.handle(req.when, req.payload).then(
            (result) => finish({ id: req.id, result }),
            (err: Error) => finish({ id: req.id, error: err.message }),
          );
          continue;
        }
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
        void this.handle(live, req, () => sock.destroyed).then(
          (result) => reply({ id: req.id, result }),
          (err: Error) => reply({ id: req.id, error: err.message }),
        );
      }
    });
  }

  private async handle(grant: Grant, req: Request, gone?: () => boolean): Promise<unknown> {
    if (req.method === 'list') {
      return {
        tools: this.toolsFor(grant).map((t) => ({
          name: t.name,
          description: t.unavailable?.() ? `${t.description} (Not available now: ${t.unavailable()})` : t.description,
          inputSchema: t.inputSchema,
          // A scoped tool reads nothing itself, but the calls it makes may act or send: never marked read-only.
          annotations: {
            readOnlyHint: t.tier === 'read' && !t.scoped,
            destructiveHint: t.tier !== 'read' || Boolean(t.scoped),
            openWorldHint: true,
          },
        })),
      };
    }
    if (req.method !== 'call') throw new Error('Unknown request');
    const tool = typeof req.name === 'string' ? this.tools.get(req.name) : undefined;
    if (!tool || (tool.group && !grant.groups.has(tool.group)) || tool.offered?.() === false)
      return toolResult({ text: `No such tool: ${String(req.name)}`, isError: true });
    const args =
      req.arguments && typeof req.arguments === 'object' && !Array.isArray(req.arguments) ? (req.arguments as Record<string, unknown>) : {};
    const ctx = grant.ctx;
    const run = () => this.call(tool, args, ctx, gone, tool.scoped ? { scope: this.scopeOf(grant, gone) } : {});
    return toolResult(await (ctx.lang ? withLang(ctx.lang, run) : run()));
  }

  /**
   * What a scoped tool called in `grant`'s turn reaches: its other tools but the scoped ones, each call
   * as the turn's own (`call()`), its approval card saying that code asked; nothing once the turn is over.
   */
  private scopeOf(grant: Grant, gone?: () => boolean): GatewayScope {
    const tools = this.toolsFor(grant).filter((t) => !t.scoped && !t.direct);
    return {
      tools,
      gone: () => Boolean(gone?.()),
      call: async (name, args, callGone, asking) => {
        // Looked up again for each call: a turn that ended takes its tools with it.
        if (![...this.grants.values()].includes(grant))
          return { text: 'This turn is over: Harness Relay has no tools for it any more', isError: true };
        const tool = tools.find((t) => t.name === name);
        if (!tool) return { text: `No such tool: ${name}`, isError: true };
        // Every question the call asks goes through the scoped tool (an act's, and one its tool asks
        // itself, as the browser about a new host does), its card saying that code asked.
        const ask = grant.ctx.ask;
        const ctx: GatewayContext = ask
          ? {
              ...grant.ctx,
              ask: (req) => {
                const asked = () => ask({ ...req, reason: [t().gatewayFromCode, req.reason].filter(Boolean).join(' ') });
                return asking ? asking(asked) : asked();
              },
            }
          : grant.ctx;
        return this.call(tool, args, ctx, () => Boolean(gone?.() || callGone?.()));
      },
    };
  }

  /**
   * One request to the HTTP endpoint (MCP's Streamable HTTP, answered with JSON, no event stream):
   * only from this computer's programs (its own address as Host, so a name that rebinds to 127.0.0.1
   * does not do; no Origin, so a page in a browser never does), only POST, only JSON, with the
   * `Authorization: Bearer` token of a turn going on, given over HTTP. A token it does not know (its
   * turn is over) gets a 404, as a path it does not serve does.
   */
  private serveHttp(req: IncomingMessage, res: ServerResponse): void {
    const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers });
      res.end(text);
    };
    // A refused request ends its connection (what is left of its body is read and dropped meanwhile).
    const refuse = (status: number, message: string, headers: Record<string, string> = {}) => {
      req.resume();
      answer(status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } }, { ...headers, Connection: 'close' });
    };
    const port = this.httpAt;
    const host = req.headers.host;
    if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return refuse(403, 'Forbidden');
    if (req.headers.origin !== undefined) return refuse(403, 'Forbidden');
    if ((req.url ?? '').split('?')[0] !== GATEWAY_HTTP_PATH) return refuse(404, 'Not found');
    if (req.method !== 'POST') return refuse(405, 'Method not allowed', { Allow: 'POST' });
    const bearer = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? '')?.[1];
    const found = bearer ? this.grants.get(bearer) : undefined;
    if (!found?.http) return refuse(404, 'This turn is over: Harness Relay has no tools for it any more');
    const grant = found;
    // Known from now on: it counts with the CLIs' own connections.
    const sock = req.socket;
    if (this.httpUnknown.delete(sock)) {
      if (this.httpKnown.size >= MAX_CONNECTIONS) return refuse(503, 'Too many connections');
      this.httpKnown.add(sock);
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return refuse(415, 'Unsupported media type');
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size > MAX_LINE) return;
      size += chunk.length;
      if (size > MAX_LINE) {
        chunks.length = 0;
        // Said before the connection ends, rather than cut off with the rest of the body unread.
        refuse(413, 'The request is too large');
        res.once('finish', () => setTimeout(() => sock.destroy(), 1000).unref());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (size > MAX_LINE) return;
      let msg: unknown;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return answer(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(msg);
      const list = (batch ? msg : [msg]) as unknown[];
      // A client that gives up waiting (its own time limit) closes the request: an act the user allows
      // after that is not done, since the agent was told it failed and may try it again.
      const gone = () => !res.writableFinished && (res.destroyed || sock.destroyed);
      void Promise.all(list.map((m) => this.mcpAnswer(grant, m, gone))).then(
        (answers) => {
          const out = answers.filter((a) => a !== undefined);
          // Notifications and responses only: accepted, nothing to answer.
          if (!out.length) return answer(202);
          answer(200, batch ? out : out[0]);
        },
        () => answer(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }),
      );
    });
  }

  /** One JSON-RPC message of an HTTP request, as the stdio program answers it; undefined for a notification. */
  private async mcpAnswer(grant: Grant, raw: unknown, gone?: () => boolean): Promise<unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const { id, method, params } = raw as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    // A notification, or the client's answer to something: nothing to say.
    if (id === undefined || id === null || typeof method !== 'string') return undefined;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion:
          typeof asked === 'string' && GATEWAY_PROTOCOLS.includes(asked) ? asked : GATEWAY_PROTOCOLS[GATEWAY_PROTOCOLS.length - 1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: GATEWAY_SERVER_NAME, title: 'Harness Relay', version: '1' },
      });
    }
    if (method === 'ping') return ok({});
    // Looked up again for each request: a turn that ended takes its tools with it.
    if (![...this.grants.values()].includes(grant)) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: 'This turn is over: Harness Relay has no tools for it any more' } };
    }
    try {
      if (method === 'tools/list') return ok(await this.handle(grant, { id: 0, method: 'list' }));
      if (method === 'tools/call') {
        const args = params?.arguments;
        return ok(await this.handle(grant, { id: 0, method: 'call', name: params?.name, arguments: args ?? {} }, gone));
      }
    } catch (err) {
      return ok({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  /**
   * A call, as its tier and the turn allow. `gone`: whether the client stopped waiting for it (its
   * connection closed), checked once the user has answered about an act. `scope`: for a scoped tool, the
   * turn's other tools.
   */
  async call(
    tool: GatewayTool,
    args: Record<string, unknown>,
    ctx: GatewayContext,
    gone?: () => boolean,
    o: { scope?: GatewayScope } = {},
  ): Promise<GatewayResult> {
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
      let proposal: PreparedOutboxCall;
      try {
        if (tool.prepare) {
          proposal = await tool.prepare(args, ctx);
        } else {
          const described = tool.describe(args, ctx);
          proposal = { title: described.title, preview: described.preview ?? { fields: [] }, args: tool.bind ? tool.bind(args) : args };
        }
      } catch (err) {
        return { text: (err as Error).message, isError: true };
      }
      if (ctx.signal.aborted || gone?.()) return { text: 'The turn ended before the item could be queued.', isError: true };
      const item = ctx.toOutbox({ tool: tool.name, ...proposal });
      if (item.preview.document)
        return {
          text: `No Google document has been written. Proposal ${item.id} is ready for the user to review and confirm in the chat. Do not perform the change another way.`,
        };
      if (item.preview.note) {
        return {
          text: `No note has been written. "${item.title}" is waiting for the user to review and save in the chat (item ${item.id}). Tell the user the preview is ready. Do not write the note another way.`,
        };
      }
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
      const reason = described.detail;
      const answer = await ctx.ask!({
        kind: 'other',
        tool: gatewayApprovalTool(tool.name),
        detail: described.title,
        ...(reason ? { reason } : {}),
        noLock: true,
      }).finally(() => answered?.());
      if (!answer.allow) return { text: `The user declined ${tool.name}${answer.note ? `: ${answer.note}` : ''}.`, isError: true };
      if (gone?.()) return { text: `${tool.name} was not done: its caller stopped waiting before the user answered.`, isError: true };
    }
    if (ctx.signal.aborted) return { text: 'The turn ended.', isError: true };
    try {
      return await tool.run!(args, ctx, o.scope);
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
 * The CLIs given the gateway over loopback HTTP, the turn's token only in their memory (#88): each
 * passes it from its session's MCP servers (OpenCode's and Copilot's ACP `session/new` and
 * `session/load`, Codex's thread config, all over its stdin) to its own MCP client, and writes it
 * nowhere. Checked with the real CLIs (OpenCode 1.19.5, Codex 0.169, Copilot 1.0.112;
 * `scripts/mcp-headers-check.ts`): every request carried the header, and no file they wrote (sessions,
 * rollouts, databases, logs) held it, after a new session, a turn and a resume. Copilot has no other
 * way: it takes only HTTP and SSE MCP servers over ACP ("Rejecting non-http/sse MCP server" in its log),
 * so the stdio program never reached it. The others stay as they are until the same check passes for them:
 * - Grok and Cursor pass it too, signed in (Grok in full access only, see `GATEWAY_SANDBOXED_MCP`), but
 *   start the stdio program for now. Antigravity (1.5.10) fails it: it writes an HTTP server's headers to
 *   its conversation database (`~/.gemini/antigravity-cli/conversations/<id>.db`), so it keeps the
 *   program, which is given the token file's path, never the token. Muse Code's is inconclusive: it
 *   opened no connection to the server without a prompt.
 * - Goose keeps the extensions a session was given, to start them again when it is loaded, in its
 *   session database: in its state folder, which its commands can read.
 * - OpenHands writes its MCP servers to `mcp.json` when it resumes a session.
 * - Cline and Pi take no HTTP MCP server Harness Relay could give them so (Pi's would put the token in
 *   a variable).
 * - Claude Code reads its MCP servers from a file, so it keeps the stdio program (on Windows its token
 *   serves one connection and is deleted at once).
 */
export const GATEWAY_OVER_HTTP: readonly Provider[] = ['opencode', 'codex', 'copilot'];

/**
 * The CLIs whose sandbox holds the MCP servers they start below full access, with their commands (Grok's
 * and Muse Code's own, and Harness Relay's around the open agents): the stdio program could not run there
 * (it denies them `data/tmp`, where the program and its token are, and opening it would open the token to
 * every command too), so they get no stdio stand-in for HTTP (`GrantOptions.fallback`) below full access.
 * Muse Code (1.4.23) was seen to: below full access its session had neither the stdio program's tools nor
 * an HTTP server's, in full access the program's.
 */
export const GATEWAY_SANDBOXED_MCP: readonly Provider[] = ['grok', 'muse', ...OPEN_PROVIDERS];

/** The CLIs that get the gateway in full access only: sandboxed MCP servers (above), and no HTTP way to the gateway. */
export const GATEWAY_FULL_ACCESS_ONLY: readonly Provider[] = GATEWAY_SANDBOXED_MCP.filter((p) => !GATEWAY_OVER_HTTP.includes(p));

/** How the gateway's own approval names a tool (and keys "always allow" for it): `relay:<tool>`. */
export const gatewayApprovalTool = (name: string) => `${GATEWAY_SERVER_NAME}:${name}`;

/**
 * The gateway's tool a CLI's own approval request is about, if it is one: a request for a tool (kind
 * `other`) named exactly as the CLI names the gateway's (`mcp__relay__browser_open` in Claude Code,
 * `relay:browser_open` in Codex, `relay_browser_open` in OpenCode, `relay/browser_open`,
 * `relay__browser_open`, `relay.browser_open`; and only from Antigravity, `mcp_relay_browser_open`, as
 * agy 1.5.10 names it in its `session/request_permission`: in OpenCode's `<server>_<tool>` that name is a
 * library server `mcp`'s tool `relay_browser_open`), never a command, a path or a URL with such words in it,
 * nor another server's tool of the same name. OpenCode's one underscore could join a library server's
 * name and its tool into the same words (`relay_mail` and `search`), so no library server may be named
 * so (`reservedMcpName()`), and a run that has the gateway is given none that is. The turn answers such
 * a request yes, and the gateway decides by the tool's tier (`Orchestrator`).
 */
export function gatewayToolNamed(
  names: readonly string[],
  req: Pick<ApprovalRequest, 'kind' | 'tool'>,
  provider?: Provider,
): string | undefined {
  if (req.kind !== 'other' || !req.tool) return undefined;
  const s = GATEWAY_SERVER_NAME;
  return names.find((n) =>
    [
      `mcp__${s}__${n}`,
      `${s}:${n}`,
      `${s}_${n}`,
      `${s}__${n}`,
      `${s}/${n}`,
      `${s}.${n}`,
      ...(provider === 'antigravity' ? [`mcp_${s}_${n}`] : []),
    ].includes(req.tool!),
  );
}

/** Whether a library MCP server's name is the gateway's (`relay`), or starts as its tools' names do in a CLI that joins them with `_` (`relay_…`). */
export const reservedMcpName = (name: string): boolean => {
  const n = name.toLowerCase();
  return n === GATEWAY_SERVER_NAME || n.startsWith(`${GATEWAY_SERVER_NAME}_`);
};

/** The outbox's own tool, given with any group: what this conversation's outbox holds and what became of it. */
export function outboxTool(list: (convId: string) => OutboxItem[]): GatewayTool {
  return {
    name: 'outbox_status',
    tier: 'read',
    description:
      "List what is in this conversation's outbox: messages and invitations to send, and Google Docs or Obsidian changes to save. Shows which are waiting, completed, failed or discarded.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => ({ title: 'List the outbox' }),
    run: async (_args, ctx) => {
      const items = list(ctx.convId);
      if (!items.length) return { text: 'The outbox is empty.' };
      return {
        text: items
          .map(
            (i) =>
              `- ${i.id}: ${i.title} — ${(i.preview.note || i.preview.document) && i.status === 'sent' ? 'saved' : i.status}${i.result ? ` (${i.result})` : ''}, asked by @${i.agentName}`,
          )
          .join('\n'),
      };
    },
  };
}
