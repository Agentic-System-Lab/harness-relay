// Types shared by the server and the web client.

export type Provider = 'claude' | 'codex' | 'grok' | 'cursor' | 'antigravity' | 'copilot' | 'muse' | OpenProvider;

/**
 * The open-source coding agents ("open agents"): they use the model backends set up in Settings
 * (OpenAI, Anthropic, xAI API keys, or the user's own OpenAI-compatible endpoints), never a sign-in
 * of their own (see docs/open-agents.md).
 */
export type OpenProvider = 'opencode' | 'goose' | 'cline' | 'openhands' | 'pi';
export const OPEN_PROVIDERS: OpenProvider[] = ['opencode', 'goose', 'cline', 'openhands', 'pi'];

export const PROVIDERS: Provider[] = ['claude', 'codex', 'grok', 'cursor', 'antigravity', 'copilot', 'muse', ...OPEN_PROVIDERS];

export function isOpenProvider(p: Provider): p is OpenProvider {
  return (OPEN_PROVIDERS as Provider[]).includes(p);
}

/**
 * The CLIs with a sign-in of their own that can also run on one of the user's own endpoints of
 * Settings → Model connections (Claude Code, Codex, Grok, Copilot): a member's model `<endpoint id>/<model>`.
 * Cursor, Antigravity and Muse Code have a sign-in too, but their models run only through their own
 * services (Muse Code's needs the Meta API's own model catalog, `/muse-code/models`, which an
 * OpenAI-compatible server does not serve).
 */
export type EndpointCli = 'claude' | 'codex' | 'grok' | 'copilot';

export function isEndpointCli(p: Provider): p is EndpointCli {
  return p === 'claude' || p === 'codex' || p === 'grok' || p === 'copilot';
}

/**
 * How each of them talks to the user's own endpoint, and the efforts it may send there:
 * - `path`: the API it calls under the endpoint's base URL, which the server must also serve (vLLM,
 *   Ollama, LM Studio and llama.cpp serve all three);
 * - `efforts`: the reasoning efforts its models on an endpoint offer, the levels every such server
 *   takes; Grok takes none for a model it does not know; Copilot sends the one given as
 *   `reasoning_effort` (`--reasoning-effort`);
 * - `fallbackEffort`: what runs instead of another effort, one the member, Settings or the CLI's own
 *   config would give (Codex, whose config cannot be told to send none); without it, none is sent.
 */
export const ENDPOINT_CLI: Record<EndpointCli, { path: string; efforts: string[]; fallbackEffort?: string }> = {
  claude: { path: '/v1/messages', efforts: ['low', 'medium', 'high'] },
  codex: { path: '/v1/responses', efforts: ['none', 'low', 'medium', 'high'], fallbackEffort: 'medium' },
  grok: { path: '/v1/chat/completions', efforts: [] },
  copilot: { path: '/v1/chat/completions', efforts: ['low', 'medium', 'high'] },
};

/**
 * The effort a run of Claude Code, Codex or Grok on an endpoint sends: the one given when its
 * endpoint models offer it, else the CLI's `fallbackEffort` when one was given, else none.
 */
export function endpointEffort(p: EndpointCli, effort: string | undefined): string | undefined {
  const e = effort?.trim();
  if (!e) return undefined;
  return ENDPOINT_CLI[p].efforts.includes(e) ? e : ENDPOINT_CLI[p].fallbackEffort;
}

/** The error `code` (with a 404) for a working directory that does not exist; resend with `createCwd: true` to create it. */
export const CWD_MISSING = 'cwd-missing';

/** Git needed by a user action is missing on the Harness Relay host. */
export const GIT_MISSING = 'git-missing';
export type GitRequirement = 'git' | 'gitBash';

export type AppDependency = 'github' | 'browser' | 'cua';

export interface AppDependencyView {
  available: boolean;
  canInstall: boolean;
  command?: string;
  job?: CliInstallJobView;
}

export interface PreviewDockerView extends AppDependencyView {
  state: 'missing' | 'unavailable' | 'ready';
  detail?: string;
  help?: 'linux-access';
}

export interface GitInstallView {
  available: boolean;
  method?: 'apple' | 'winget' | 'linux';
  command?: string;
  job?: CliInstallJobView;
}

/**
 * The error `code` (with a 502) of the share routes when the GitHub CLI cannot be used: not installed
 * (`GH_MISSING`) or not signed in (`GH_SIGNED_OUT`). The UI then says what to do about it.
 */
export const GH_MISSING = 'gh-missing';
export const GH_SIGNED_OUT = 'gh-signed-out';

/** The oldest GitHub CLI that shares work with: `gh gist delete --yes` came in 2.66.0. */
export const GH_MIN_VERSION = '2.66.0';

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  muse: 'Muse Code',
  opencode: 'OpenCode',
  goose: 'Goose',
  cline: 'Cline',
  openhands: 'OpenHands',
  pi: 'Pi',
};

/** UI languages. The server localizes its messages from the `X-Relay-Lang` request header. */
export type Lang = 'zh-TW' | 'en';
export const LANGS: Lang[] = ['zh-TW', 'en'];

/**
 * How a user message is routed through the team.
 * - roundtable: agents speak one after another, each seeing what earlier speakers said.
 * - parallel:   agents answer simultaneously each round; later rounds see earlier answers.
 * - relay:      one agent at a time; an agent hands off by @mentioning a teammate.
 */
export type Mode = 'roundtable' | 'parallel' | 'relay';

/** File-system permission granted to every agent in a conversation. */
export type Permission = 'read-only' | 'edit' | 'full';

/** The permissions from least to most: a session that last ran below this turn's permission is not resumed. */
export const PERMISSION_ORDER: readonly Permission[] = ['read-only', 'edit', 'full'];

/** Whether `a` is a higher permission than `b`. */
export function permissionAbove(a: Permission, b: Permission): boolean {
  return PERMISSION_ORDER.indexOf(a) > PERMISSION_ORDER.indexOf(b);
}

/**
 * What happens when an agent wants to do something its permission does not cover: the user is asked
 * in the chat (`ask`, the default), the lead agent reviews it first and only what it judges
 * potentially unsafe is asked (`auto`, "Approve for me": with Edit only), or it is refused (`deny`).
 */
export type Approvals = 'ask' | 'auto' | 'deny';

/**
 * The file permission as the UI offers it: the three permissions, and "Approve for me" (`auto`)
 * between Edit and Full access, which is Edit with the lead agent reviewing every request beyond it
 * before the user is asked (`approvals: 'auto'`). The CLIs and their sandboxes run it as Edit.
 */
export type PermissionLevel = 'read-only' | 'edit' | 'auto' | 'full';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'edit', 'auto', 'full'];

/** The level a conversation's (or template's) permission and approvals make. */
export function permissionLevel(s: { permission: Permission; approvals?: Approvals }): PermissionLevel {
  return s.permission === 'edit' && s.approvals === 'auto' ? 'auto' : s.permission;
}

/**
 * The permission and approvals a level sets, from settings `s`: "Approve for me" is Edit reviewed by
 * the lead agent; any other level keeps a choice to refuse, and asks the user again after it.
 */
export function levelSettings(level: PermissionLevel, s: { approvals?: Approvals }): { permission: Permission; approvals?: Approvals } {
  if (level === 'auto') return { permission: 'edit', approvals: 'auto' };
  return { permission: level, approvals: s.approvals === 'deny' ? 'deny' : undefined };
}

/** `approvals` as settings keep it, read or given: `auto` with Edit only, and asking as nothing. */
export function approvalsOf(v: unknown, permission: Permission): { approvals?: 'auto' | 'deny' } {
  if (v === 'deny') return { approvals: 'deny' };
  return v === 'auto' && permission === 'edit' ? { approvals: 'auto' } : {};
}

/**
 * Most members a team may have, set by hand or by the lead agent, unless `RELAY_MAX_TEAM_AGENTS` says
 * otherwise (`src/server/config.ts`; the UI gets the server's from `GET /api/limits`).
 */
export const DEFAULT_MAX_TEAM_AGENTS = 8;

export interface AgentConfig {
  id: string;
  /** Handle used for @mentions. Letters, digits, `_` and `-` only. */
  name: string;
  provider: Provider;
  /** The agent's position / role / persona for this conversation. */
  role: string;
  /** Optional model override; empty means the CLI's default. */
  model?: string;
  /** Optional reasoning-effort override (e.g. low / medium / high / xhigh); empty means default. */
  effort?: string;
  /**
   * The account of its CLI the agent runs as (`ProviderAccountView.id`); absent = the CLI's default
   * account. An account that was removed counts as the default account.
   */
  account?: string;
  /**
   * This agent's exceptions to the tool library's defaults, by tool key (see `toolKey`): true = it
   * gets the tool although the tool is off by default, false = it does not get a tool that is on.
   */
  tools?: Record<string, boolean>;
  /** This member's own limits, for the CLIs that have one (`AGENT_LIMITS`); absent = none. */
  limits?: AgentLimits;
}

// --- A member's own limits: what one turn (or session) of its CLI may spend --------------------

/**
 * A member's limits, each one a CLI's own (`AGENT_LIMITS` says whose): `usd`, the US dollars a turn may
 * cost (Claude Code's `--max-budget-usd`, by its own estimate); `aiCredits`, the AI credits its session
 * may use (Copilot's `--max-ai-credits`, a soft cap: one response can pass it); `steps`, the model calls
 * a turn may make (Goose's `GOOSE_MAX_TURNS`, OpenCode's agent `steps`).
 */
export interface AgentLimits {
  usd?: number;
  aiCredits?: number;
  steps?: number;
}
export type AgentLimitKey = keyof AgentLimits;

/** One CLI's limit: which it is, its least and greatest value, and whether it is a whole number. */
export interface AgentLimitSpec {
  key: AgentLimitKey;
  min: number;
  max: number;
  integer: boolean;
  /** Not given on the user's own endpoint (Claude Code would price its model as one of its own; Copilot bills it no credits). */
  notOnEndpoint?: boolean;
}

/** The CLIs with a limit of their own, and its bounds; the others have none. */
export const AGENT_LIMITS: Partial<Record<Provider, AgentLimitSpec>> = {
  claude: { key: 'usd', min: 0.01, max: 10_000, integer: false, notOnEndpoint: true },
  // Copilot refuses a session limit under 30 AI credits.
  copilot: { key: 'aiCredits', min: 30, max: 1_000_000, integer: true, notOnEndpoint: true },
  goose: { key: 'steps', min: 1, max: 10_000, integer: true },
  opencode: { key: 'steps', min: 1, max: 10_000, integer: true },
};

/** Whether `v` is a value `spec` takes. */
export function agentLimitValid(spec: AgentLimitSpec, v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max && (!spec.integer || Number.isInteger(v));
}

/** The limits of `limits` that `provider` has and takes, or undefined when none is left. */
export function agentLimitsFor(provider: Provider, limits: unknown): AgentLimits | undefined {
  const spec = AGENT_LIMITS[provider];
  if (!spec || !limits || typeof limits !== 'object') return undefined;
  const v = (limits as Record<string, unknown>)[spec.key];
  return agentLimitValid(spec, v) ? { [spec.key]: v } : undefined;
}

// --- Tool library: MCP servers, skills and memory every agent can be given ------------------

/**
 * Tool keys: `mcp:<server id>`, `skill:<skill folder>`, `memory` (the memory for everyone),
 * `memory:<provider>` (the memory for one CLI's agents) or `relay:<group>` (one of Harness Relay's own
 * tool groups). Ids and folders stay when things are renamed.
 */
export type ToolKind = 'mcp' | 'skill' | 'memory' | 'relay';

/**
 * Harness Relay's own tools, which every agent reaches through one MCP server of Harness Relay's (the
 * gateway, `src/server/gateway.ts`), in groups the user gives to the CLIs they choose.
 */
export const RELAY_TOOL_GROUPS = ['browser', 'computer', 'mail', 'calendar', 'drive', 'obsidian', 'github', 'teams', 'slack'] as const;
export type RelayToolGroup = (typeof RELAY_TOOL_GROUPS)[number];

/** The name agents see Harness Relay's gateway under (`mcp__relay__browser_open` in Claude Code). */
export const GATEWAY_SERVER_NAME = 'relay';

/**
 * What a call of one of Harness Relay's tools may do without the user: `read` runs; `act` (it changes
 * something somewhere, as a click on a page does) is asked about below full access; `send` (a proposal in
 * the outbox: mail, invitations and note changes) never runs in the turn but waits for the user.
 */
export type GatewayTier = 'read' | 'act' | 'send';

/** How a mail server is reached: TLS from the start, STARTTLS, or plain (only to this computer: a local bridge). */
export type MailSecurity = 'tls' | 'starttls' | 'none';

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
}

/** A mail account the mail tools use (IMAP to read and save drafts, SMTP to send), as the UI sees it. */
export interface MailAccountView {
  id: string;
  name: string;
  /** The address mail is sent from (`Name <a@b>` or `a@b`). */
  address: string;
  username: string;
  imap: MailServer;
  smtp: MailServer;
  /** The password, masked ('' when none is kept). */
  password: string;
  /**
   * The account that signs in with OAuth this mail account is reached through (its id, `OAuthAccountView`),
   * instead of a password: its provider's own IMAP and SMTP servers, fixed, signed in to with the
   * account's token (SASL XOAUTH2), its address as the user name.
   */
  oauth?: string;
}

/** A calendar the calendar tools use (CalDAV), as the UI sees it. */
export interface CalendarAccountView {
  id: string;
  name: string;
  /** The calendar collection's address (https). */
  url: string;
  username: string;
  /** The address invitations are sent from (the calendar's owner). */
  address?: string;
  password: string;
  /**
   * The account that signs in with OAuth this calendar is reached through (its id, `OAuthAccountView`),
   * instead of a password: Microsoft's calendars over Graph, Google's over CalDAV with its token.
   */
  oauth?: string;
}

/** The providers whose accounts sign in with OAuth (`src/server/oauth/`). */
export const OAUTH_PROVIDERS = ['microsoft', 'google'] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

/**
 * What an account that signs in with OAuth is used for: each use asks for its own scopes (the
 * calendar tools; the mail tools and the mail trigger, over IMAP and SMTP with XOAUTH2).
 */
export const MAIL_CALENDAR_USES = ['calendar', 'mail'] as const;
export const OAUTH_USES = [...MAIL_CALENDAR_USES, 'drive', 'teams', 'documents'] as const;
export type OAuthUse = (typeof OAUTH_USES)[number];

/**
 * The OAuth app (client) Harness Relay signs in to a provider with, as the UI sees it: its id, the
 * user's own or Harness Relay's (`builtIn`), the tenant for Microsoft, whether a client secret is kept
 * (Google's "secret" for desktop apps, masked), and the redirect addresses the app must allow.
 */
export interface OAuthClientView {
  provider: OAuthProviderId;
  clientId: string;
  builtIn: boolean;
  /** The registration and grants are kept, but no services can use them until enabled again. */
  disabled?: boolean;
  /** Microsoft: `common` (work, school and personal accounts), `organizations`, `consumers`, or a tenant's id. */
  tenant?: string;
  /** The client secret, masked ('' when none is kept). */
  secret: string;
  /** The provider has a sign-in on another device, with a code to type at its address (the device code flow): Microsoft does; Google takes no Calendar or Gmail scope there. */
  device: boolean;
}

/** Saving a provider's OAuth app: an empty client id goes back to Harness Relay's own (none yet); without `secret`, the kept one stays. */
export interface OAuthClientUpdate {
  clientId: string;
  tenant?: string;
  secret?: string;
}

/** An account that signs in with OAuth, as the UI sees it: never a token. */
export interface OAuthAccountView {
  id: string;
  provider: OAuthProviderId;
  email: string;
  /** Its name, when the provider says it. */
  name?: string;
  uses: OAuthUse[];
  /** `reauth`: its sign-in no longer works (revoked, expired, its password changed): sign in again. */
  status: 'connected' | 'reauth';
  connectedAt: number;
  /** Why it needs signing in again. */
  error?: string;
}

export interface OAuthView {
  clients: OAuthClientView[];
  accounts: OAuthAccountView[];
  /** Where the sign-ins' refresh tokens are kept. */
  secretStorage: KeyStorage;
}

/**
 * A sign-in under way, as the page that started it sees it: the provider's page to open (or, on
 * another device, a code to type at an address), the redirect address that page goes back to, and
 * how it went. `done` brings the account it signed in. A tool library MCP server's own sign-in
 * (`provider` `mcp`) names the server instead, and brings no account.
 */
export interface OAuthSignInView {
  id: string;
  provider: OAuthProviderId | 'mcp';
  /** An MCP server's own sign-in: the server, by its id and name in the tool library. */
  server?: { id: string; name: string };
  status: 'waiting' | 'done' | 'failed';
  expiresAt: number;
  /** The provider's page to open: not given while `confirm` waits. */
  authorizeUrl?: string;
  /**
   * An MCP server's sign-in whose page (`host`) or token endpoint (`tokenHost`) is not on its
   * authorization server's own origin (`issuer`, its host): the user is shown where they will sign in,
   * and the page is given only once they confirm (`POST /api/oauth/signins/:id/confirm`).
   */
  confirm?: { host: string; issuer: string; tokenHost?: string };
  redirectUri?: string;
  device?: { userCode: string; verificationUri: string };
  account?: OAuthAccountView;
  error?: string;
}

/** A calendar an account that signs in with OAuth has, to add to the calendar tools. */
export interface OAuthCalendar {
  name: string;
  url: string;
  /** The calendar tools use it already: as this calendar (its id in Settings). */
  addedAs?: string;
}

/** The longest a sign-in waits for the provider's page to send the browser back, and how many may wait at once. */
export const OAUTH_LIMITS = { signInMinutes: 10, pending: 10 };

export interface ConnectorsView {
  mail: MailAccountView[];
  calendar: CalendarAccountView[];
  /** Where the passwords are kept. */
  secretStorage: KeyStorage;
}

/** Saving a mail account: without `password`, the kept one stays. */
export type MailAccountUpdate = Omit<MailAccountView, 'id' | 'password'> & { password?: string };
export type CalendarAccountUpdate = Omit<CalendarAccountView, 'id' | 'password'> & { password?: string };

export const CONNECTOR_LIMITS = { accounts: 10, name: 60 };

/** An outbox item: what a `send` call would do, kept until the user sends or discards it. */
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'discarded' | 'failed';

/** What an outbox item shows the user before they send it: each field, as it will go out. */
export interface OutboxPreview {
  fields: { label: string; value: string }[];
  /** The text it sends (a mail's body, an event's description). */
  body?: string;
  /** A local Markdown change. null is a new note; an empty string is an existing empty note. */
  note?: { vault: string; path: string; before: string | null; after: string };
  /** A direct Google Docs creation or literal text edit. A new document has no ID until confirmed. */
  document?: { account: string; title: string; id?: string; tab?: string; tabId?: string; before: string | null; after: string };
}

export interface OutboxItem {
  id: string;
  convId: string;
  /** The reply whose turn put it there, which shows its card. */
  messageId: string;
  agentId: string;
  agentName: string;
  tool: string;
  /** In a line: what sending it does. */
  title: string;
  preview: OutboxPreview;
  status: OutboxStatus;
  /** What happened once it was sent or failed. */
  result?: string;
  createdAt: number;
  decidedAt?: number;
}

export function toolKey(kind: ToolKind, name = ''): string {
  if (kind === 'memory') return name && name !== 'all' ? `memory:${name}` : 'memory';
  return `${kind}:${name}`;
}

/** Whether an agent gets a library tool that is `defaultOn` (or not) for its CLI. */
export function agentHasTool(agent: Pick<AgentConfig, 'tools'>, key: string, defaultOn: boolean): boolean {
  return agent.tools?.[key] ?? defaultOn;
}

/** The shared memory has a part for everyone and a part for each CLI's agents. */
export type MemoryScope = 'all' | Provider;
export const MEMORY_SCOPES: MemoryScope[] = ['all', ...PROVIDERS];

/** MCP server names: they become part of tool names (`mcp__<name>__…`) and config keys. */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const TOOL_LIMITS = { maxMcpServers: 30, maxSkills: 100, maxMemoryChars: 20_000, maxVars: 30 };

export type McpTransport = 'stdio' | 'http';

/** A named secret (an environment variable or HTTP header) as the UI sees it. */
export interface MaskedVar {
  name: string;
  masked: string;
}

/** An MCP server Harness Relay gives its agents, in addition to the ones each CLI is set up with. */
export interface McpServerView {
  app?: keyof typeof import('./apps').APP_SERVERS;
  /** Stays when the server is renamed; agents' exceptions use it. */
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: the program and its arguments. */
  command: string;
  args: string[];
  /** http: the server's URL (Streamable HTTP). */
  url: string;
  /** stdio: environment variables; http: request headers. Their values are kept as secrets. */
  env: MaskedVar[];
  headers: MaskedVar[];
  /**
   * Agents of these CLIs get it unless they turn it off; others only when they turn it on
   * (none = no agent by default).
   */
  providers: Provider[];
  /**
   * An HTTP server's own sign-in (MCP's authorization, OAuth), once it signed in: `signed-in` (since
   * `signedInAt`), or `reauth`, its sign-in no longer works (`error`: why): sign in again. Never a token.
   */
  oauth?: McpOAuthState;
}

/** An HTTP MCP server's own sign-in, as the UI sees it (`McpServerView.oauth`). */
export interface McpOAuthState {
  status: 'signed-in' | 'reauth';
  signedInAt: number;
  error?: string;
}

export interface McpServerUpdate {
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Each name to keep; without a `value`, the value stored for that name stays. */
  env?: { name: string; value?: string }[];
  headers?: { name: string; value?: string }[];
  /** Absent: every CLI. */
  providers?: Provider[];
  /** When renaming: the server's current name (its stored values carry over). */
  previousName?: string;
}

/** A skill: a folder with a SKILL.md, whose front matter names and describes it. */
export interface SkillView {
  path: string;
  name: string;
  description: string;
  /** As for MCP servers: the CLIs whose agents get it by default. */
  providers: Provider[];
  /** Why agents cannot use it right now (no SKILL.md, a name another skill has). */
  problem?: string;
}

/** A skill found under a folder the user picked, before it is added. */
export interface SkillCandidate {
  path: string;
  name: string;
  description: string;
  /** Already in the library. */
  added: boolean;
}

export type TeamsPostingState = { status: 'signing-in'; code?: string; url?: string } | { status: 'error'; message: string };

export type TeamsConnection =
  | { status: 'missing-powershell' | 'missing-module' | 'signed-out' | 'installing' }
  | { status: 'signing-in'; code?: string; url?: string }
  | { status: 'connected'; account: string; canPost?: true; posting?: TeamsPostingState }
  | { status: 'error'; message: string; retry?: 'install' };

export type HostedApp = 'slack';
export type HostedProvider = 'claude' | 'codex';
/** A passive Codex check reports runtime availability. Only its explicit self-profile check can report connected. */
export type HostedAppStatus = 'connected' | 'available' | 'needs-auth' | 'not-found' | 'disabled' | 'unknown';

export type SlackPostingConnection = { status: 'signed-out' } | { status: 'connected'; workspace: string; sender: string };

export type GithubTokenVariable = 'GH_TOKEN' | 'GITHUB_TOKEN';
export type GithubConnection =
  | { status: 'connected'; login: string; tokenSource?: GithubTokenVariable }
  | { status: 'signed-out'; tokenSource?: GithubTokenVariable }
  | { status: 'missing' };

export interface ObsidianVault {
  /** Stable for the lifetime of this connection, including across restarts. */
  id: string;
  /** Canonical absolute path on the server. */
  path: string;
}

export interface ToolLibraryView {
  /** Present for compatibility when exactly one vault is connected. */
  obsidianVault?: string;
  /** Older servers only returned obsidianVault. */
  obsidianVaults?: ObsidianVault[];
  mcpServers: McpServerView[];
  skills: SkillView[];
  /** Harness Relay's own tool groups and the CLIs whose agents get each (none at first). */
  relayTools: { group: RelayToolGroup; providers: Provider[] }[];
  /**
   * Whether this server can give agents its own tools: it needs a Node.js to run the gateway's MCP
   * server with (the desktop app's runtime is not one).
   */
  gateway: { available: boolean; reason?: 'not-started' | 'no-node' | 'no-node-path' };
  /**
   * Which browser the browser tools start: `path`, set in Settings, before `env` (`RELAY_BROWSER`),
   * before the system's Chrome, Chromium or Edge and Playwright's Chromium; `using`, the first of them
   * there is now (none: no browser was found).
   */
  browser: { path?: string; env?: string; using?: string };
  /**
   * Notes agents get in their briefing, in every conversation: `all` for every agent, and a part for
   * each CLI's agents. Empty = none.
   */
  memory: Record<MemoryScope, string>;
  /** Where the MCP servers' variable and header values are kept. */
  secretStorage: KeyStorage;
}

export interface ToolLibraryUpdate {
  /** The whole list, replacing the current one. A folder of skills adds each skill in it. */
  skills?: { path: string; providers?: Provider[] }[];
  /** The CLIs whose agents get each of Harness Relay's tool groups named. */
  relayTools?: Partial<Record<RelayToolGroup, Provider[]>>;
  /** The parts to change. */
  memory?: Partial<Record<MemoryScope, string>>;
  /** The browser the browser tools start: its executable, a full path to a file; empty for none (found by itself). */
  browser?: string;
}

// --- Long-term memory: notes the agents keep across conversations ----------------------------
// (src/shared/memory.ts, src/server/memory.ts; docs/architecture.md, "Long-term memory")

/**
 * How a note's author knows what it says: the user said it, an agent checked it, or an agent
 * concluded it without checking.
 */
export const MEMORY_BASES = ['user', 'checked', 'inferred'] as const;
export type MemoryBasis = (typeof MEMORY_BASES)[number];

/**
 * Where a note stands: `active`, agents get it; `pending`, it waits for the user to keep it (agents
 * do not get it yet); `archived`, set aside (forgotten by an agent, removed by tidying or by the user),
 * kept for the user to restore or delete. Nothing an agent does deletes a note.
 */
export const MEMORY_STATES = ['active', 'pending', 'archived'] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

/** Who wrote a note, or last changed it: the user, a conversation's agent, or the lead agent tidying. */
export type MemoryAuthor = { kind: 'user' } | { kind: 'agent'; name: string; provider: Provider } | { kind: 'lead'; provider: Provider };

export interface MemoryNote {
  id: string;
  text: string;
  /** The working directory it holds in (a conversation with it among its folders); absent: every conversation. */
  cwd?: string;
  basis: MemoryBasis;
  state: MemoryState;
  /**
   * In every briefing in its scope, the layer always loaded: `user` when the user pinned it (only the
   * user unpins it), `lead` when tidying chose it.
   */
  pinned?: 'user' | 'lead';
  author: MemoryAuthor;
  /**
   * The notes this one takes the place of: an agent's correction (`pending` until the user keeps it,
   * which sets the old one aside), or the notes tidying merged into it (set aside already).
   */
  replaces?: string[];
  /** Where it was written: the conversation and reply (absent for one the user wrote in Settings, or once that conversation was deleted). */
  conversationId?: string;
  messageId?: string;
  /** Why it was set aside, as its remover said (in the words the agent or the lead agent used). */
  reason?: string;
  createdAt: number;
  updatedAt: number;
  /** When an agent was last given it with a conversation's messages (recall). */
  usedAt?: number;
}

export interface MemorySettings {
  /** Agents read the notes and save new ones. An experiment in Settings → Labs, off by default. */
  enabled: boolean;
  /** Agents' new notes and corrections wait for the user to keep them. */
  review: boolean;
  /** The lead agent tidies the notes in the background now and then (`MEMORY_LIMITS.tidyAfterChanges`, `tidyHours`). */
  autoTidy: boolean;
}

/** The lead agent's last tidying: when it ended, how many changes it made, what it said, or why it failed. */
export interface MemoryTidyReport {
  at: number;
  changes: number;
  summary?: string;
  error?: string;
}

export interface MemoryView {
  settings: MemorySettings;
  /** Every note, the ones waiting for the user first, then the pinned ones, then the newest. */
  notes: MemoryNote[];
  /** The titles of the conversations notes came from, by id (those still there). */
  sources: Record<string, string>;
  lastTidy?: MemoryTidyReport;
  /** The lead agent is tidying the notes now. */
  tidying: boolean;
  /** Notes saved or changed since the last tidying. */
  changedSinceTidy: number;
}

export interface MemoryNoteCreate {
  text: string;
  /** Absent: everywhere. */
  cwd?: string;
  pinned?: boolean;
}

export interface MemoryNoteUpdate {
  text?: string;
  /** Null: everywhere. */
  cwd?: string | null;
  pinned?: boolean;
  /** `active` keeps a waiting note or restores a set-aside one; `archived` sets it aside. */
  state?: 'active' | 'archived';
}

export const MEMORY_LIMITS = {
  /** A note's length. */
  noteChars: 1000,
  /** Notes kept, whatever their state: past it an agent's new note is not saved. */
  maxNotes: 1000,
  /** Blocks taken from one reply. */
  perReply: 8,
  /** The pinned notes in a briefing, in all. */
  pinnedChars: 4000,
  /** Notes tidying may pin. */
  pinnedNotes: 12,
  /** Notes recalled for one turn, and their length in all. */
  recallNotes: 6,
  recallChars: 3000,
  /** The lead agent tidies by itself once this many notes changed, at most once in `tidyHours`. */
  tidyAfterChanges: 5,
  tidyHours: 12,
  /** Notes one tidying reads (the newest), and how much of each source conversation. */
  tidyNotes: 300,
  tidySourceChars: 3000,
} as const;

/** One note a reply saved, corrected or forgot (`MessagePart` `memory`), as its card shows it. */
export interface MemoryPartNote {
  /** The note's id; absent when nothing was saved (`skipped`). */
  id?: string;
  text: string;
  op: 'saved' | 'updated' | 'forgotten';
  /** Where the note stands now (`deleted`: the user deleted it), or `skipped`: the block was not taken. */
  status: MemoryState | 'deleted' | 'skipped';
  cwd?: string;
  basis?: MemoryBasis;
  /**
   * Why a block was not taken: `unknown`, no such note; `user-note`, the user's own note, which only
   * the user changes or removes (a correction of one waits for them); `full`, the memory holds
   * `MEMORY_LIMITS.maxNotes` notes; `empty`, the block had no text.
   */
  skipped?: 'unknown' | 'user-note' | 'full' | 'empty';
}

// --- What each CLI loads by itself (its own skills, MCP servers and memory) -------------------

/**
 * The kinds of things a CLI loads by itself that Harness Relay can leave out of its runs, all of a
 * kind at once. `agents` are the CLI's own subagents (its built-in ones stay); `tools` its built-in
 * tools; `subagents` the CLI's whole subagent feature, its built-in subagents included (Codex's
 * `agents.enabled`, Grok's `GROK_SUBAGENTS`…), which Settings shows as a switch of its own, on by default.
 */
export const NATIVE_PARTS = ['skills', 'mcp', 'tools', 'instructions', 'memory', 'hooks', 'agents', 'plugins', 'subagents'] as const;
export type NativePart = (typeof NATIVE_PARTS)[number];

/**
 * What each CLI can be told to leave out for one run, without changing its own settings. Codex
 * still reads its own ~/.codex/AGENTS.md, and has no setting that leaves out only its own
 * subagents. Grok's switches reach only what it loads from Claude Code and Cursor (its own skills,
 * MCP servers and hooks are turned off in ~/.grok/config.toml), and it has none for instruction
 * files, its own subagents or plugins. Cursor has no switch for any of them over ACP (its run gets a
 * config folder of its own, but its skills, MCP servers and hooks are read from the home folder), and
 * neither has Antigravity (`agy acp` takes no flag or setting for them that a run's own settings could
 * hold). Copilot's run has a home of its own (`prepareCopilotRun`): its skills are left out with its
 * skill tool (`--excluded-tools skill`), its MCP servers by not linking `mcp-config.json` and with
 * `--disable-builtin-mcps`, memory, hooks and plugins by the run's settings; its instruction files have
 * no switch over ACP (`--no-custom-instructions` is not applied there). Muse Code's run has settings of its own, without the MCP servers and hooks left out. Only
 * Claude Code lists its
 * built-in tools.
 */
export const NATIVE_OFF_SUPPORT: Record<Provider, readonly NativePart[]> = {
  // Claude Code: `subagents` denies its `Agent` tool (every subagent, built-in ones too).
  claude: ['skills', 'mcp', 'tools', 'instructions', 'memory', 'hooks', 'agents', 'plugins', 'subagents'],
  // Codex: `subagents` is `agents.enabled=false` with both multi-agent features off.
  codex: ['skills', 'mcp', 'instructions', 'memory', 'hooks', 'plugins', 'subagents'],
  // Grok: `subagents` is `GROK_SUBAGENTS=0`.
  grok: ['skills', 'mcp', 'memory', 'hooks', 'subagents'],
  cursor: [],
  antigravity: [],
  copilot: ['skills', 'mcp', 'memory', 'hooks', 'plugins'],
  // Muse Code: its MCP servers and hooks are its settings', and each run has settings of its own.
  muse: ['mcp', 'hooks'],
  // The open agents: each adapter lists what its CLI can really leave out (one line each, kept apart).
  // OpenCode: skills (denied with `permission.skill`, which turns off its skill tool), the project's instruction files Harness Relay passes on, its subagents (`agent.<name>.disable`), all of them (`permission.task`).
  opencode: ['skills', 'instructions', 'agents', 'subagents'],

  // Goose: `subagents` leaves out its `summon` extension (`delegate`).
  goose: ['mcp', 'instructions', 'plugins', 'subagents'],

  // Cline: its `skills` tool off (`disabledTools` in its global settings, written per run), and its `spawn_agent`.
  cline: ['skills', 'subagents'],

  // OpenHands: its home is Harness Relay's, and the project's files have no switch (docs/open-agents.md); its `task` tool.
  openhands: ['subagents'],

  // Pi: `--no-context-files` leaves out every AGENTS.md / CLAUDE.md it would load (none alone).
  pi: ['instructions'],
};

/** The parts in `parts` that `provider` can leave out, once each, in NATIVE_PARTS order. */
export function nativeOffFor(provider: Provider, parts: readonly string[]): NativePart[] {
  return NATIVE_PARTS.filter((p) => NATIVE_OFF_SUPPORT[provider].includes(p) && parts.includes(p));
}

/**
 * The CLIs whose subagents Harness Relay turns off below full access whatever Settings says
 * (`subagents` left out): Codex's lose the sandbox's `read` entries before 0.170.0 and its approval
 * check sees no path for them; Grok's run in the background and wake it once done, and whether that turn
 * reaches Harness Relay over ACP (which its turn now waits for) still needs a live run;
 * OpenCode's would wait on a question no one is asked; OpenHands' act without asking, and so do
 * Cline's: its `spawn_agent` gives the subagent no tool policy and no approval callback, so its
 * policy check asks about nothing (`@cline/core` and `@cline/agents` in Cline 3.0.75). Settings' switch
 * then reaches their runs at full access only.
 */
export const SUBAGENTS_FULL_ACCESS_ONLY: readonly Provider[] = ['codex', 'grok', 'opencode', 'openhands', 'cline'];

/** The parts a run of `provider` leaves out at `permission`: the account's, and its subagents where they are full access only. */
export function runNativeOff(provider: Provider, permission: Permission, off: readonly NativePart[]): NativePart[] {
  const forced = permission !== 'full' && SUBAGENTS_FULL_ACCESS_ONLY.includes(provider) ? ['subagents'] : [];
  return nativeOffFor(provider, [...off, ...forced]);
}

/**
 * What a CLI can do by itself that Harness Relay's runs leave off unless the account turns it on:
 * `workflows`, scripts of subagents within one turn (Claude Code's `Workflow` tool); `ultracode`,
 * Claude Code planning a workflow for every substantial task (its `"ultracode": true` setting, keeping
 * the member's effort), which needs `workflows`.
 */
export const NATIVE_ON_PARTS = ['workflows', 'ultracode'] as const;
export type NativeOnPart = (typeof NATIVE_ON_PARTS)[number];

/** Which of them each CLI has a switch for. A CLI without one runs as its own default (docs/architecture.md). */
export const NATIVE_ON_SUPPORT: Record<Provider, readonly NativeOnPart[]> = {
  claude: ['workflows', 'ultracode'],
  codex: [],
  // Grok: its background workflows and deep research (`GROK_WORKFLOWS`, Grok 1.0.92's docs).
  grok: ['workflows'],
  cursor: [],
  antigravity: [],
  copilot: [],
  muse: [],
  opencode: [],
  goose: [],
  cline: [],
  openhands: [],
  pi: [],
};

/**
 * What a run of `provider` turns on at `permission`: the account's, but below full access none of the
 * workflows of a CLI whose subagents are full access only (`SUBAGENTS_FULL_ACCESS_ONLY`: Grok's run in
 * the background as its subagents do, and are lost with the turn the same way).
 */
export function runNativeOn(provider: Provider, permission: Permission, on: readonly NativeOnPart[]): NativeOnPart[] {
  const off = permission !== 'full' && SUBAGENTS_FULL_ACCESS_ONLY.includes(provider);
  return nativeOnFor(provider, off ? [] : on);
}

/** The parts in `parts` that `provider` can turn on, once each, in NATIVE_ON_PARTS order; `ultracode` only with `workflows`. */
export function nativeOnFor(provider: Provider, parts: readonly string[]): NativeOnPart[] {
  const on = NATIVE_ON_PARTS.filter((p) => NATIVE_ON_SUPPORT[provider].includes(p) && parts.includes(p));
  return on.includes('workflows') ? on : on.filter((p) => p !== 'ultracode');
}

/**
 * The kinds of single items Harness Relay can leave out of a CLI's runs. `mcp` is an MCP server and
 * `mcpTools` one of its tools; `tools` are built-in tools; `instructions` instruction files.
 */
export const NATIVE_ITEM_KINDS = ['skills', 'mcp', 'mcpTools', 'tools', 'instructions', 'hooks', 'agents', 'plugins'] as const;
export type NativeItemKind = (typeof NATIVE_ITEM_KINDS)[number];

/**
 * Single items left out of a CLI's runs, by kind, each by the id the CLI's answer gave it
 * (`NativeItem.id`), on top of the parts left out whole.
 */
export type NativeItemsOff = Partial<Record<NativeItemKind, string[]>>;

/**
 * Which kinds of single items each CLI can leave out for one run, without changing its own
 * settings. Claude Code: skills by name (`skillOverrides`), MCP servers and their tools and its
 * built-in tools by permission rules (an MCP server still starts: only its tools are taken away),
 * instruction files by path (`claudeMdExcludes`), subagents by name, plugins by id. Codex: skills by
 * path, MCP servers and their tools, hooks by key, plugins by id. Copilot: skills by name
 * (`disabledSkills` in the run's settings), MCP servers by name (`--disable-mcp-server`). Muse Code: MCP servers by name (its
 * run's own settings). Grok, Cursor
 * and Antigravity have no such setting for a single run.
 */
export const NATIVE_ITEM_SUPPORT: Record<Provider, readonly NativeItemKind[]> = {
  claude: ['skills', 'mcp', 'mcpTools', 'tools', 'instructions', 'agents', 'plugins'],
  codex: ['skills', 'mcp', 'mcpTools', 'hooks', 'plugins'],
  grok: [],
  cursor: [],
  antigravity: [],
  copilot: ['skills', 'mcp'],
  // Muse Code: an MCP server of its settings by name.
  muse: ['mcp'],
  // The open agents: each adapter lists what its CLI can leave out alone (one line each, kept apart).
  // OpenCode: a skill by name (its `skill` permission), a subagent by name.
  opencode: ['skills', 'agents'],

  goose: ['plugins'],

  // Cline: built-in tools by name (`disabledTools`) and plugins by path (`disabledPlugins`), per run.
  cline: ['tools', 'plugins'],

  openhands: [], // none

  pi: [],
};

/** The part (and tab) each kind of item belongs to. */
export const NATIVE_ITEM_PART: Record<NativeItemKind, NativePart> = {
  skills: 'skills',
  mcp: 'mcp',
  mcpTools: 'mcp',
  tools: 'tools',
  instructions: 'instructions',
  hooks: 'hooks',
  agents: 'agents',
  plugins: 'plugins',
};

/** At most this many items of one kind are left out, each id at most MAX_NATIVE_ITEM_ID characters. */
export const MAX_NATIVE_ITEMS = 2000;
export const MAX_NATIVE_ITEM_ID = 4096;

/**
 * The items in `items` that `provider` can leave out: kinds it supports, in NATIVE_ITEM_KINDS order,
 * non-empty strings once each (in the order given); kinds left with none are dropped.
 */
export function nativeItemsFor(provider: Provider, items: unknown): NativeItemsOff {
  const out: NativeItemsOff = {};
  if (!items || typeof items !== 'object' || Array.isArray(items)) return out;
  for (const kind of NATIVE_ITEM_KINDS) {
    const list = (items as Record<string, unknown>)[kind];
    if (!NATIVE_ITEM_SUPPORT[provider].includes(kind) || !Array.isArray(list)) continue;
    const ids = [...new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_NATIVE_ITEM_ID))];
    if (ids.length) out[kind] = ids.slice(0, MAX_NATIVE_ITEMS);
  }
  return out;
}

/** The same single items, in any order. */
export function sameNativeItems(a: NativeItemsOff, b: NativeItemsOff): boolean {
  const kinds = new Set([...Object.keys(a), ...Object.keys(b)] as NativeItemKind[]);
  return [...kinds].every((k) => {
    const x = a[k] ?? [];
    const y = b[k] ?? [];
    return x.length === y.length && x.every((id) => y.includes(id));
  });
}

/** How many single items are left out. */
export const nativeItemCount = (items: NativeItemsOff): number => Object.values(items).reduce((n, ids) => n + (ids?.length ?? 0), 0);

/**
 * What every item a CLI reports can say about itself. `leftOut`: the CLI loads it, but not when
 * Harness Relay starts it with what is left out (found by asking it again that way).
 */
interface NativeItem {
  /** False when the CLI has it turned off by itself. */
  enabled?: boolean;
  leftOut?: boolean;
  /** The id this item is left out by (`NativeItemsOff`), when the CLI can leave out this one alone. */
  id?: string;
  /** Picked to be left out, but the CLI, asked again the way Harness Relay starts it, still loads it. */
  stillLoaded?: boolean;
}

export interface NativeSkill extends NativeItem {
  name: string;
  description: string;
  /** Where the CLI found it (user, repo, system, plugin, bundled…), when it says. */
  source?: string;
  path?: string;
}

export interface NativeMcpServer extends NativeItem {
  name: string;
  /** stdio, http… */
  transport?: string;
  /** connected, failed, needs-auth, disabled… when the CLI reports it. */
  status?: string;
  source?: string;
  /** The tools it offers, when the CLI connected to it and says. */
  tools?: NativeTool[];
}

/** A tool: one of an MCP server's (its own name, without the server's), or one built into the CLI. */
export interface NativeTool extends NativeItem {
  name: string;
}

export interface NativeMemoryFile extends NativeItem {
  path: string;
  /** Instructions (CLAUDE.md, AGENTS.md…) or notes the CLI keeps by itself. */
  kind: 'instructions' | 'memory';
}

/** A hook: when it runs and where it comes from (never its command, which may hold a token). */
export interface NativeHook extends NativeItem {
  /** SessionStart, preToolUse… as the CLI names it. */
  event: string;
  /** Which tools it applies to, when it says. */
  matcher?: string;
  /** Where it is set (user settings, a plugin…). */
  source?: string;
  /** The file it is defined in, when the CLI says. */
  file?: string;
}

/** One of the CLI's subagents. */
export interface NativeAgent extends NativeItem {
  name: string;
  description: string;
  /** built-in, user, plugin…, when known. */
  source?: string;
}

export interface NativePlugin extends NativeItem {
  /** The CLI's id for it (Claude Code and Codex: `name@marketplace`). */
  name: string;
  source?: string;
}

/** What one CLI loads by itself for a working directory, asked from the CLI (no prompt is sent). */
export interface NativeSetup {
  provider: Provider;
  cwd: string;
  skills: NativeSkill[];
  mcpServers: NativeMcpServer[];
  memory: NativeMemoryFile[];
  /** Undefined when the CLI does not list them. */
  hooks?: NativeHook[];
  agents?: NativeAgent[];
  plugins?: NativePlugin[];
  /** Claude Code's loaded hook modules, when this version can report them. */
  mods?: NativePlugin[];
  /** Its built-in tools (Claude Code). */
  builtinTools?: NativeTool[];
  /** The memory list comes from reading the files the CLI is known to read, not from the CLI. */
  memoryFromFiles: boolean;
  /**
   * The parts and single items left out of Harness Relay's runs when the CLI was asked. With any,
   * the CLI was asked a second time the way Harness Relay starts it, and `asRun` says whether it
   * answered: items it then left out are marked `leftOut`.
   */
  nativeOff: NativePart[];
  nativeItems: NativeItemsOff;
  asRun: boolean;
  /**
   * Grok: whether the folder is trusted. Untrusted, Grok leaves out the project's own instructions,
   * skills, MCP servers and hooks.
   */
  folderTrusted?: boolean;
  /**
   * Grok: the folder its trust is decided for: the project root (the repository root, links
   * resolved), else the working directory's real path. Trusting it trusts the whole project.
   */
  trustFolder?: string;
  /** Grok: `trustFolder` is above the working directory (its repository root), so trusting it trusts more. */
  trustFolderAbove?: boolean;
  /** What could not be found out, and why. */
  errors: string[];
  checkedAt: number;
}

// --- Browsing a conversation's files ----------------------------------------------------------

/** An app preview starts only when the user asks. Files paths are relative to the selected root;
 * a reply's local link is resolved on the server against the worktrees that reply used. */
export interface AppPreviewRequest {
  /** Canonical folder pinned from Files or from resolving a reply's target. */
  expectedFolder?: string;
  /** `container`: a Dockerfile or compose file, built and run with Docker, with a terminal. */
  mode: 'static' | 'build' | 'server' | 'container';
  folder: string;
  entry?: string;
  root?: string;
  messageId?: string;
}

export interface AppPreviewSession {
  id: string;
  url: string;
  origin: string;
  /**
   * A container preview: it answers before the build, and its terminal (`…/preview/:id/terminal`)
   * says how it goes; its page opens once the app serves one (a `page` event).
   */
  terminal?: boolean;
  /**
   * A static page whose folder could not be copied whole (too large, or a folder in it unreadable):
   * it has only the page and the files it names, so an address a script puts together may not load.
   */
  partial?: boolean;
}

/** The files a container preview starts from, in the order a folder is looked at: compose first, then a Dockerfile. */
export const PREVIEW_RECIPES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml', 'Dockerfile'] as const;

/** The error code of a folder with no way to preview it: the panel offers to ask an agent for a Dockerfile. */
export const PREVIEW_NO_RECIPE = 'preview-no-recipe';

/** The error code of an app a turn added that cannot run in a preview (`POST …/preview/changed`): the chat says why and offers to ask its author to fix it. */
export const PREVIEW_NOT_READY = 'preview-not-ready';

/**
 * Files whose change says a turn made or changed an app: what runs one (a compose file, a Dockerfile,
 * a package.json), an index page, and the usual entry of a web app or terminal program in another
 * language. A turn that touches none of them made no app, as far as Relay can tell.
 */
const APP_ENTRIES: ReadonlySet<string> = new Set([
  'package.json',
  ...PREVIEW_RECIPES,
  'app.py',
  'main.py',
  'server.py',
  'manage.py',
  'wsgi.py',
  'asgi.py',
  'streamlit_app.py',
  'main.go',
  'server.go',
  'app.rb',
  'config.ru',
  'server.js',
  'server.mjs',
  'server.ts',
  'app.js',
  'app.mjs',
  'app.ts',
]);

export function isAppEntry(name: string): boolean {
  return APP_ENTRIES.has(name) || /^index\.html?$/i.test(name);
}

/** Folders that hold a project's installed dependencies, never an app of its own: a path through one is not one. */
const DEPENDENCY_DIRS: ReadonlySet<string> = new Set(['node_modules', '.venv', 'venv', 'site-packages', 'vendor', '__pycache__']);

export function inDependencies(segments: readonly string[]): boolean {
  return segments.some((s) => DEPENDENCY_DIRS.has(s));
}

/** What a container preview's terminal stream sends (`GET …/preview/:id/terminal`, as SSE). */
export type PreviewTerminalEvent =
  /** Terminal bytes, base64. `replay`: everything so far, sent first to each new stream. */
  | { type: 'output'; data: string; replay?: boolean }
  /** Where the preview is. `command`: the main service's command line while it runs. */
  | {
      type: 'phase';
      phase: 'building' | 'starting' | 'running' | 'exited' | 'failed';
      code?: number;
      error?: string;
      command?: string;
    }
  /** The app accepts connections on its HTTP port: its page can open. */
  | { type: 'page' }
  /** The preview stopped. */
  | { type: 'closed' };

// --- Publishing a previewed app (Render, Neon) --------------------------------------------------

/** Render's regions, in the order Settings lists them. Render's own default is the first. */
export const RENDER_REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'] as const;
export type RenderRegion = (typeof RENDER_REGIONS)[number];

/** The error code of a publish that needs the user's settings first (a key, a workspace, an organization). */
export const PUBLISH_SETUP = 'publish-setup';
/** The error code of a publish whose files changed since the preview started: rebuild it and try it first. */
export const PUBLISH_CHANGED = 'publish-changed';
/** The error code of a Render workspace that cannot read the new repository through its GitHub app. */
export const PUBLISH_REPO_ACCESS = 'publish-repo-access';

/** An account Settings → Publish to the cloud names: a Render workspace, a Neon organization. */
export interface PublishAccount {
  id: string;
  name: string;
}

/** Settings → Publish to the cloud (`GET /api/publish`): never a key, only its masked end. */
export interface PublishSettingsView {
  /** Keys can be kept (the credential store, or the database encrypted). */
  storage: boolean;
  render: {
    keyMasked: string;
    /** The workspaces the key reaches, and the one apps go to. */
    owners: PublishAccount[];
    ownerId?: string;
    region: RenderRegion;
  };
  neon: {
    keyMasked: string;
    orgs: PublishAccount[];
    orgId?: string;
  };
  apps: PublishedApp[];
}

/** What a preview publishes as: the preview's mode, a Dockerfile or a compose file. */
export type PublishKind = 'static' | 'build' | 'server' | 'docker' | 'compose';

/** One step of a publish, in order. `skipped`: not needed this time (the repository exists, say). */
export interface PublishStep {
  id: 'repo' | 'push' | 'database' | 'init' | 'service' | 'build';
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  /** Render's deploy state for `build` (`build_in_progress`…), or what failed. */
  detail?: string;
}

/** An app published from a preview, as Settings and the panel show it. */
export interface PublishedApp {
  id: string;
  name: string;
  conversationId: string;
  /** Its conversation was deleted: the app stays online until it is unpublished. */
  conversationGone?: boolean;
  /** The folder it was published from (the preview's, absolute). */
  folder: string;
  kind: PublishKind;
  serviceType: 'static_site' | 'web_service';
  /** The private GitHub repository it is pushed to, `owner/name`. */
  repo: string;
  repoUrl: string;
  /** Render's service, once made. */
  serviceId?: string;
  dashboardUrl?: string;
  /** Its address on the internet, once Render gave one. */
  url?: string;
  /** The Neon projects of its databases, one per PostgreSQL service. */
  databases: { service: string; projectId: string; name: string }[];
  createdAt: number;
  /** When it last went live. */
  publishedAt?: number;
  state: 'publishing' | 'live' | 'failed';
  error?: string;
  /** The current or last publish's steps (in memory: none after a restart). */
  steps?: PublishStep[];
}

/** A variable the published app gets: from its compose file, its database, or the dialog. */
export interface PublishEnvVar {
  key: string;
  value: string;
  source: 'compose' | 'database' | 'user';
}

/** A Neon database a publish makes: for a compose file's PostgreSQL service, or the checkbox. */
export interface PublishDatabasePlan {
  /** The compose service it stands for; `DATABASE_URL` for the checkbox. */
  service: string;
  database: string;
  role: string;
  pgVersion?: number;
  /** The compose file's init scripts that run on it once, in order. */
  initScripts: string[];
  /** Init scripts that are not run (`.sh`, `.sql.gz`). */
  skippedScripts: string[];
}

/** What publishing a running preview would do (`POST …/preview/:id/publish/plan`). */
export interface PublishPlan {
  kind: PublishKind;
  serviceType: 'static_site' | 'web_service';
  /** The name the dialog starts with: the existing app's, else one from the folder. */
  name: string;
  folder: string;
  /** The app published from this folder already: publishing updates it. */
  existing?: PublishedApp;
  env: PublishEnvVar[];
  databases: PublishDatabasePlan[];
  /** A backend or Dockerfile without compose: a Neon database can be added (`DATABASE_URL`). */
  databaseOptional: boolean;
  /** Render's build and start, as Relay sets them (for the dialog). */
  commands: { build?: string; start?: string; publish?: string; dockerfile?: string };
  /** What Settings still needs for this publish (Neon only when a compose file has PostgreSQL). */
  missing: ('render' | 'render-owner' | 'neon' | 'neon-org')[];
  /** Neon is set up: the checkbox's database can be made. */
  neonReady: boolean;
  github: { login?: string; problem?: typeof GH_MISSING | typeof GH_SIGNED_OUT };
  region: RenderRegion;
}

/** `POST …/preview/:id/publish`. */
export interface PublishRequest {
  name?: string;
  /** The variables the user added or changed (never the database's, which Neon gives). */
  env?: { key: string; value: string }[];
  /** For a backend or Dockerfile without compose: add a Neon database. */
  database?: boolean;
  /** The user confirmed that anyone with its address can open it. */
  public: boolean;
}

/** A folder that can be browsed: a working directory, or an agent's worktree of one (parallel mode). */
export interface FileRoot {
  /**
   * The first working directory's is `cwd` and an agent's worktree of it the agent's id (the team's
   * own, `TEAM_WORKTREE`); for the others, `:` and the working directory's place follow (`cwd:1`,
   * `<agent id>:1`).
   */
  id: string;
  path: string;
  /** Whose worktree it is: an agent's id, or `TEAM_WORKTREE` for the team's own. */
  agentId?: string;
  /** Which working directory it is, or is a worktree of: its place in `cwdsOf()` (absent: 0). */
  cwd?: number;
}

/** Whether Grok trusts a folder (`POST /api/providers/grok/folder-trust`). */
export interface GrokFolderTrust {
  cwd: string;
  /**
   * The folder Grok decides trust for (`NativeSetup.trustFolder`): the repository root when `cwd`
   * is inside one, links resolved. This is the folder that is trusted.
   */
  folder: string;
  /** `folder` is above `cwd` (its repository root): trusting it trusts the whole repository. */
  above: boolean;
  /** Undefined when Grok could not be asked. */
  trusted?: boolean;
}

export interface FileEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mtime: number;
  /** A symbolic link (to a file or folder inside the root). */
  link?: boolean;
}

export interface FileListing {
  canonicalRoot: string;
  roots: FileRoot[];
  root: string;
  /** Relative to the root, with `/`; '' is the root itself. */
  path: string;
  entries: FileEntry[];
  /** The folder has more entries than are listed. */
  truncated: boolean;
  /** The Files panel may change files in this root (edit, new file, upload): never an agent's worktree. */
  writable?: boolean;
  /** Why it may not, when it is a working directory (one that holds Harness Relay, the home folder…). */
  readOnly?: string;
}

export type FilePreviewKind = 'text' | 'image' | 'video' | 'binary';

export interface FilePreview {
  path: string;
  size: number;
  mtime: number;
  kind: FilePreviewKind;
  /** For text: the content (the beginning, when `truncated`). */
  text?: string;
  truncated?: boolean;
  /**
   * The file's version (a hash of its bytes), when the Files panel can edit it: whole, valid UTF-8 text
   * of at most `FILE_EDIT_LIMITS.maxEditBytes`, reached through no link. A save names it (`FileSaveRequest`).
   */
  version?: string;
}

/**
 * `zipItems` / `zipBytes`: the most files and folders together, and bytes before compression, a folder
 * downloaded as a ZIP file may hold (it is streamed, and stays well under ZIP's 4 GB and 65,535 entries).
 */
export const FILE_LIMITS = { maxEntries: 2000, maxPreviewBytes: 512 * 1024, zipItems: 10_000, zipBytes: 1024 * 1024 * 1024 };

/**
 * Changing files from the Files panel. `maxEditBytes`: the largest text file it edits, in UTF-8 bytes:
 * what its preview shows whole (`maxPreviewBytes`), so that a file it saved always opens for editing
 * again; about 10,000 lines of a CSV, which a phone's text box still edits smoothly and a save sends
 * in one JSON body. `maxUploadBytes`: the largest file uploaded, as for an attachment
 * (`ATTACHMENT_LIMITS.maxBytes`): a phone's photo or a PDF, base64 in one JSON body of about 27 MB.
 * `maxUploadFiles`: the most files one pick or drop takes; they go up one at a time.
 */
export const FILE_EDIT_LIMITS = { maxEditBytes: FILE_LIMITS.maxPreviewBytes, maxUploadBytes: 20 * 1024 * 1024, maxUploadFiles: 20 };

/** Saving a text file from the Files panel (`PUT /api/conversations/:id/files/text`). */
export interface FileSaveRequest {
  /** A `FileRoot.id` of a working directory (`cwd` when absent). */
  root?: string;
  /** The file, relative to the root, with `/`. */
  path: string;
  text: string;
  /** The version the text was loaded at (`FilePreview.version`); null makes a new file, refused when one is there. */
  version: string | null;
}

/** Uploading a file into a folder from the Files panel (`POST /api/conversations/:id/files/upload`). */
export interface FileUploadRequest {
  root?: string;
  /** The folder, relative to the root ('' = the root). */
  dir: string;
  name: string;
  /** Base64 contents, as attachments send them. */
  data: string;
  /** Replace a file of that name, which the user agreed to; without it, one there is a 409 `FILE_EXISTS`. */
  replace?: boolean;
}

/** Deleting a file or a folder (with all it holds) from the Files panel (`DELETE /api/conversations/:id/files`). */
export interface FileDeleteRequest {
  /** A `FileRoot.id` of a working directory (`cwd` when absent). */
  root?: string;
  /** The file or folder, relative to the root, with `/`; never the root itself. */
  path: string;
}

/** What the Files panel deleted. */
export interface FileDeleted {
  path: string;
  kind: 'file' | 'dir';
}

/** A file the Files panel wrote. */
export interface FileWritten {
  path: string;
  size: number;
  mtime: number;
  /** Its version now, for the next save (text files the panel edits). */
  version: string;
}

/** The error `code` (409) for a save whose file changed since it was loaded: reload it. */
export const FILE_CHANGED = 'file-changed';
/** The error `code` (409) for a new file or an upload whose name is taken (`replace` not given). */
export const FILE_EXISTS = 'file-exists';
/** The error `code` (409) for a write while a run may be writing in that folder. */
export const FOLDER_BUSY = 'folder-busy';

/** How many files a folder's ZIP holds, and their size before compression. */
export interface ZipSize {
  files: number;
  bytes: number;
}

/**
 * What downloading a folder as a ZIP file would hold (`GET …/files/zip/check`): `all` of it, or null
 * when that is more than FILE_LIMITS allows; then, for a folder in a git repository, only what git
 * does not ignore (`unignored`; null when that is too much too, or the folder is not in a repository).
 */
export interface ZipCheck {
  all: ZipSize | null;
  unignored?: ZipSize | null;
}

/**
 * The largest shared page, in UTF-8 bytes. A shared page is a secret GitHub gist that Harness Relay's
 * viewer reads from GitHub's raw files, which serve a gist's file whole up to 10 MB (a larger one only
 * through git): a page of 9.9 MB went up with `gh gist create` and came back from them the same, also
 * one of nothing but tags. (It was 1 MB while shares were read on gistpreview.github.io, which reads
 * GitHub's API: that cuts a file's content off at 1 MB.)
 */
export const SHARE_MAX_BYTES = 10_000_000;

/**
 * Where a shared conversation can be read: the page (`url`, on Harness Relay's viewer, `shareViewerUrl()`
 * in src/shared/share.ts; on gistpreview.github.io for a share made before it) and its gist (`id`, and
 * `gistUrl` on GitHub). `filesGist`: the id of the
 * second secret gist that holds the files the page links to, when files went along (kept apart from the
 * page: see shareToGist() in src/server/share.ts).
 */
export interface ShareLink {
  id: string;
  url: string;
  gistUrl: string;
  filesGist?: string;
}

/** A browser signed in to Harness Relay (Settings → Signed-in browsers). */
export interface AuthSessionView {
  id: string;
  /** A mobile browser that is still signed in, and whether it has a page in front. */
  phone?: 'paired' | 'online';
  /** Its browser and system, from its User-Agent when it signed in ("Chrome · macOS"). */
  label: string;
  createdAt: number;
  lastUsedAt: number;
  /** The browser asking. */
  current: boolean;
}

/**
 * What a browser is alerted to (`src/shared/notify.ts`): the team's reply ended (`done`) or ended with
 * an error (`error`); an agent asks to do something its permission does not cover (`approval`), the
 * lead agent's team waits to be confirmed (`confirm`), an agent asked the user something (`answer`), or a
 * tracked goal is held up and needs the user (`blocked`). The notification inbox keeps these kinds alone.
 */
export const ALERT_KINDS = ['done', 'error', 'approval', 'confirm', 'answer', 'blocked'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * A notification in the inbox (the bell beside the sidebar's collapse button): an alert the team gave
 * (`src/shared/notify.ts`), kept by the server (`src/server/inbox.ts`) whether or not a browser was
 * open, for every signed-in browser alike. The newest first; removed with its conversation.
 */
export interface InboxItem {
  id: string;
  conversationId: string;
  /** The conversation's title now. */
  title: string;
  kind: AlertKind;
  /** The agent it is about (`alertDetail`), when the conversation tells. */
  agent?: string;
  /** What the agent said (a reply, its error, a question) or asks to do (a command, a file), as one short line. */
  text?: string;
  createdAt: number;
  /** Seen: its chat was opened since, or it was marked read. */
  read: boolean;
}

/** What the bell shows without the list (`GET /api/notifications/summary`). */
export interface InboxSummary {
  /** How many are unread. */
  unread: number;
  /** The conversations with unread notifications: opening one's chat marks them read. */
  unreadIn: string[];
  /** The newest notification's id: an open list loads again when it changes. */
  newest?: string;
}

/**
 * Which notifications `POST /api/notifications/read` marks read: these, those of one conversation,
 * or all of them.
 */
export type InboxReadRequest = { ids: string[] } | { conversationId: string } | { all: true };

/**
 * Which alerts a browser wants (Settings → Notifications): replies that ended (`done` and `error`),
 * what needs the user (`approval`, `confirm`, `answer`), and with a sound or without.
 */
export interface AlertPrefs {
  done: boolean;
  needs: boolean;
  sound: boolean;
}

/**
 * The error code of `PUT /api/push/subscription` for a subscription its push service said is gone
 * (409): the browser drops it and subscribes anew.
 */
export const PUSH_GONE = 'push-gone';

/**
 * The same for a subscription another signed-in browser has (409): this browser, signed in anew while
 * its old session lives on, drops it and subscribes anew.
 */
export const PUSH_TAKEN = 'push-taken';

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it (`PUT /api/push/subscription`). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Whether this server can send push notifications (`GET /api/push`): the public key browsers subscribe
 * with (VAPID, base64url), or why it cannot (its key could not be saved in the database, say).
 */
export interface PushStatus {
  publicKey?: string;
  error?: string;
}

/** What a push notification carries (encrypted for its browser), and what the service worker shows. */
export interface AlertPayload {
  title: string;
  body: string;
  /** One notification per conversation: a newer one replaces it. */
  tag: string;
  /** Where clicking it goes (the chat, `#/c/<id>`). */
  url: string;
  /** No sound (sound off in Settings → Notifications). */
  silent: boolean;
  kind: AlertKind | 'test';
}

/** A conversation put on the web, as Harness Relay keeps track of it (Settings lists them to remove). */
export interface SharedPage extends ShareLink {
  conversationId: string;
  /** The conversation's title when it was shared. */
  title: string;
  /** Shared up to and including this agent reply; the whole conversation without it. */
  upTo?: { messageId: string; agentName: string };
  createdAt: number;
  /** The conversation was deleted since (its page is still on the web). */
  conversationGone?: boolean;
  /** How many files its replies link to went along, in the files gist (none: left out). */
  files?: number;
  /**
   * The files went up but the page could not, and their gist could not be deleted either: `id` and
   * `gistUrl` are then the files gist's (`url` is empty, `gistUrl` too when GitHub gave no address).
   */
  unfinished?: boolean;
}

/**
 * A file a shared page links to: the reply whose link it is, and the path as that link has it (what
 * the reply's `…/download?path=` would serve).
 */
export interface ShareFileRef {
  messageId: string;
  path: string;
}

/**
 * Why a linked file cannot go along with a shared page: not there (or a folder), outside the chat's
 * folders (or in `.git`), or larger than SHARE_FILE_MAX_BYTES. Any kind of file can go: text, PDF,
 * slides, images, archives (they are pushed into the files gist with git).
 */
export type ShareFileProblem = 'missing' | 'outside' | 'too-large';

/** The error code of a share refused for a file that can no longer go along (it changed since it was checked). */
export const SHARE_FILE_REFUSED = 'share-file-refused';

/**
 * A file the shared messages link to, as `POST …/share/files` found it: `refs` are the links (their
 * places in the request) that point to it, `name` and `path` as the first of them has it. `size` when
 * it is there; `problem` when it cannot go along.
 */
export interface ShareFileInfo {
  name: string;
  path: string;
  size?: number;
  problem?: ShareFileProblem;
  refs: number[];
}

/**
 * The largest file a shared page can take along, in bytes: the largest file GitHub recommends for a
 * repository (a gist is one), well under the 100 MB it refuses.
 */
export const SHARE_FILE_MAX_BYTES = 50_000_000;

/** The most a shared page can take along in all, in bytes (read into memory to go up), and in files. */
export const SHARE_FILES_MAX_BYTES = 100_000_000;
export const SHARE_FILES_MAX = 20;

/** The most file links one check (`POST …/share/files`) or share looks at. */
export const SHARE_FILE_LINKS_MAX = 100;

/**
 * The room a link to a file in the gist may take on the page, in bytes: the page leaves this much for
 * each one, so it still fits in SHARE_MAX_BYTES once the links point at GitHub.
 */
export const SHARE_FILE_URL_MAX = 512;

export interface ConversationSettings {
  mode: Mode;
  /** Number of rounds for roundtable / parallel mode. */
  rounds: number;
  /** Maximum number of agent turns per user message in relay mode. */
  maxHops: number;
  permission: Permission;
  /** Working directory shared by all agents: the first one, where they start (see `extraCwds`). */
  cwd: string;
  /**
   * The conversation's other working directories, after `cwd` (absent: none). Each is the agents' as
   * `cwd` is: given to every CLI with the same access, made a git repository, snapshotted around
   * each turn, locked while agents write, and in parallel mode given a worktree of its own.
   */
  extraCwds?: string[];
  /**
   * Auto team: before the team answers a new question, the lead agent (Settings) chooses the team for
   * it from the question and the conversation so far — keeping the current team, using a template as
   * it is, adapting one, or designing a new team. Every conversation started in the app has it.
   */
  autoTeam?: boolean;
  /** Auto team: the lead agent's team answers at once, without waiting for the user to confirm it. */
  autoConfirm?: boolean;
  /**
   * Lead review: once the team has answered, the lead agent (Settings) reads its new replies, points out
   * what the user should look at closely, and suggests the next steps (`LeadReview`). Any conversation
   * may have it, with or without auto team. On in every new chat the New chat and New schedule pages
   * make (off for one made through the API without it); only the user switches it (the New
   * chat and New schedule pages, Team settings, the team design card), for the question being answered
   * and the ones after it.
   */
  leadReview?: boolean;
  /**
   * What happens when an agent wants to do something its permission does not cover: ask the user in
   * the chat (default), have the lead agent review it and ask the user only about what it judges
   * potentially unsafe (`auto`, "Approve for me", kept with Edit only: `permissionLevel()`), or refuse
   * automatically.
   */
  approvals?: Approvals;
  /**
   * Steering: a message the user sends while members are working goes into their running turns, as the
   * mode allows and as their CLIs can take one (`STEER_PROVIDERS`), instead of waiting in the queue for
   * the next turn: in roundtable and relay mode into the turn of the member speaking now; in parallel
   * mode into every turn of the round at once, only when all of them are still running and can take it.
   * Otherwise it waits in the queue as before. Off by default; switched in Team settings, any time.
   */
  steer?: boolean;
  /**
   * Team checks: what Harness Relay itself checks the team's work against once the team has answered,
   * whichever CLI each member runs on (`CheckList`). Copied from a template with the team; once the
   * conversation has a list, a new team or template leaves it as it is.
   */
  checks?: CheckList;
}

/**
 * The rules of a conversation's team checks (`ConversationSettings.checks`), each one optional. Harness
 * Relay checks them itself, after the team's turns (and before the lead agent's review), in runs that
 * may write (edit or full access); it reports what it found and never undoes anything.
 */
export interface CheckList {
  /**
   * Files the team may not change, in each working directory, as gitignore-like patterns: `*` and `?`
   * within a name, `**` across folders, a pattern without `/` matching a name at any depth, a trailing
   * `/` a whole folder. Ignored files count too (`.env`, `*.pem`): they are compared on disk.
   */
  protectedPaths?: string[];
  /**
   * A regular expression (JavaScript) every commit's subject the team makes must match. Checked in
   * roundtable and relay mode only (parallel mode applies its results without their commits).
   */
  commitPattern?: string;
  /**
   * Commands that must succeed (a test suite, a linter, a team script), each run once the team has
   * answered, in roundtable and relay mode, after a run that changed something. Below full access they
   * run in Harness Relay's own sandbox (no network), which fails closed; with full access without one,
   * as the agents ran. Not on Windows yet.
   */
  commands?: CheckCommand[];
  /**
   * Commands Harness Relay runs around the members' own tool calls, as they happen (`CheckHook`): before
   * a call, which a failing one refuses, and after it, whose failure goes back to the agent. Each CLI's
   * adapter has its CLI call them as far as it can (`HOOK_PROVIDERS`); below full access they run in
   * Harness Relay's own sandbox, as the commands do. In runs that may write; not on Windows yet.
   */
  hooks?: CheckHook[];
  /**
   * The app the team builds must open in Harness Relay's preview: once the team has answered, every
   * folder a turn of the run added or changed an app's file in (`isAppEntry`) must run as a preview
   * does (a Dockerfile or compose file, an npm project with its lockfile and script, an index page).
   * A run that made no app has nothing to check.
   */
  previewApp?: true;
  /**
   * A result that did not pass goes back to the team by itself: the member whose turn broke it (else
   * the last one that changed files) is asked to fix it, as the card's button asks, at most
   * `CHECK_LIMITS.autoFixes` times in a row; then the card waits for the user. Not in a run a schedule
   * started that nobody watched, nor once the user stopped the team.
   */
  autoFix?: true;
  /**
   * The default from Settings (`SettingsView.checksDefault`), copied into a new chat or automation as it
   * was made and not changed since: a template the lead agent picks that has a list of its own replaces
   * it. Any change to the list drops it; a default, a template and an empty list never have it.
   */
  fromDefault?: true;
}

/** A command a check list runs (`CheckList.commands`). */
export interface CheckCommand {
  /** Stable within its list, for its results. */
  id: string;
  /** What to run: a shell command line (`sh -c`), such as `npm test` or `npm run lint && npm test`. */
  run: string;
  /** Where to run it: a folder relative to the first working directory (absent: that directory), or a full path inside one of them. */
  cwd?: string;
  /** Minutes before it is stopped (`CHECK_LIMITS.timeoutMin` when absent). */
  timeoutMin?: number;
  /**
   * In the sandbox (below full access) on macOS: let it listen on and connect to every local port, which
   * a test with a server of its own needs. It then reaches every service on this computer's own address,
   * Harness Relay's API among them. Off by default; nothing changes on Linux, where the sandbox has a
   * loopback of its own.
   */
  localPorts?: boolean;
  /**
   * In the sandbox on Linux: let it open any Unix socket, which a test with a socket of its own needs. It
   * then reaches every socket it can name (Docker's, an ssh agent's, the session bus). Off by default; on
   * macOS its own temporary folder's sockets are always allowed.
   */
  unixSockets?: boolean;
}

/** Which of a member's tool calls a hook runs around: its commands, its own file changes, or every call. */
export type HookTools = 'command' | 'edit' | 'any';

/**
 * A hook a check list runs around the members' tool calls (`CheckList.hooks`): a shell command line,
 * given the call in its environment (`RELAY_HOOK_*`, `hookEnv()`) and run as a check's command is.
 * `before`: exit 0 lets the call run; anything else (a non-zero exit, a time limit, a sandbox that
 * cannot start) refuses it, its output the reason the agent gets. `after`: the call has run; a non-zero
 * exit sends its output back to the agent, to act on.
 */
export interface CheckHook {
  /** Stable within its list. */
  id: string;
  when: 'before' | 'after';
  tools: HookTools;
  /** What to run (`sh -c`), such as `./scripts/allow-command.sh` or `npx prettier --check "$RELAY_HOOK_FILES"`. */
  run: string;
  /** Where to run it: a folder relative to the first working directory (absent: that directory). */
  cwd?: string;
  /** Seconds before it is stopped (`CHECK_LIMITS.hookTimeoutSec` when absent). */
  timeoutSec?: number;
}

/**
 * The CLIs whose adapters run the team's hooks around their tool calls (`RunOptions.hooks`): the others'
 * members work without them, and the chat says so.
 */
export const HOOK_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot', 'muse', 'pi'];

/**
 * The CLIs whose adapters can send a message into a running turn (steering, `ConversationSettings.steer`,
 * `RunOptions.onSteer`): Claude Code (a user message on its stream-json input, `priority: "next"`), Codex
 * (`turn/steer`), Grok (`x.ai/interject`), Antigravity (another `session/prompt`), Goose
 * (`_goose/unstable/session/steer`) and Pi (its `steer` command). Cursor cannot (a new prompt cancels the
 * running one); OpenCode, Cline, OpenHands, Copilot and Muse Code count as cannot until a run shows otherwise.
 */
export const STEER_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'grok', 'antigravity', 'goose', 'pi'];

/**
 * How many protected path patterns a list may have, the longest pattern and commit pattern, how many
 * commands, the longest command line and folder, and a command's time limit in minutes (default, most);
 * how many hooks, and a hook's time limit in seconds (default, most).
 */
export const CHECK_LIMITS = {
  protectedPaths: 50,
  pattern: 300,
  commitPattern: 500,
  commands: 10,
  command: 1000,
  folder: 500,
  timeoutMin: 10,
  maxTimeoutMin: 60,
  hooks: 10,
  hookTimeoutSec: 60,
  maxHookTimeoutSec: 600,
  autoFixes: 3,
};

/** The commit pattern the Conventional Commits button fills in. */
export const CONVENTIONAL_COMMIT_PATTERN = '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([\\w./-]+\\))?!?: \\S';

/**
 * Where a check stands: `running`; `passed`; `failed`, the team broke the rule; `error`, it could not be
 * checked (a git error, a working directory that is gone: never a pass); `na`, there was nothing to
 * check (no commit was made, the mode does not keep commits).
 */
export type CheckStatus = 'running' | 'passed' | 'failed' | 'error' | 'na';

/** The rules a team check result reports on. */
export type CheckRuleKind = 'paths' | 'commits' | 'command' | 'preview';

/** Something a check found: a protected file changed, or a commit whose subject does not match. */
export interface CheckFinding {
  /** paths: the file, relative to its working directory (`/`-separated). */
  path?: string;
  /** paths: added, changed or removed. */
  change?: 'added' | 'changed' | 'removed';
  /** The working directory it is in (its folder name), when the conversation has more than one. */
  folder?: string;
  /** commits: the commit (abbreviated) and its subject. */
  commit?: string;
  subject?: string;
  /** The member whose turn it happened in, as named then; absent: it cannot be told (parallel mode, between turns). */
  by?: string;
  /** paths: in the member's own worktree (parallel mode), not in the working directory yet: applying its result brings it. */
  worktree?: boolean;
  /** preview: why the app in `path` (its folder) cannot run in a preview. */
  problem?: string;
}

/** One rule's result. */
export interface CheckOutcome {
  rule: CheckRuleKind;
  status: CheckStatus;
  /** Why it could not be checked (`error`) or why there was nothing to check (`na`), in the user's language. */
  reason?: string;
  /** What it found (at most `CHECK_RESULT_LIMITS.findings`; `more` counts the rest). */
  findings?: CheckFinding[];
  more?: number;
  /** command: which one (`CheckCommand.id`), and its command line as it was run. */
  commandId?: string;
  command?: string;
  /** command: how it ended (`exitCode` null: it was stopped), and how long it took. */
  exitCode?: number | null;
  durationMs?: number;
  /** command: the end of what it printed, stdout and stderr together (at most `CHECK_RESULT_LIMITS.output` characters). */
  output?: string;
  /** command: it ran without Harness Relay's sandbox (full access). */
  unsandboxed?: boolean;
  /**
   * command: not run, because the run changed files the checks read (a test configuration, a script
   * the command names): which. The user runs it anyway with Check again; in a run nobody watched it fails.
   */
  configChanged?: string[];
  /** command: files in the working directory it changed itself (not ignored by git): new snapshots, formatted files. */
  wroteFiles?: string[];
  /**
   * command: it could not run for a reason that says nothing of the team's work: stopped (Stop, the
   * server shutting down, the chat deleted), interrupted (the server stopped while it ran), or this
   * system runs no command (native Windows). Never a pass, but it holds nothing, agents are not told to
   * fix it, and a schedule's run does not fail for it.
   */
  notRun?: 'stopped' | 'interrupted' | 'platform';
}

/**
 * The team checks' result a system message carries (`ChatMessage.checks`), shown as a card after the
 * team's replies. `when`: after the team's turns (`run`), when the team stopped to ask the user
 * something (`pause`, what was done until then), the user checked again (`recheck`), or before a
 * parallel-mode result was applied (`apply`).
 */
export interface ChecksResult {
  status: CheckStatus;
  when: 'run' | 'pause' | 'recheck' | 'apply';
  /**
   * `apply`: checked before a member's parallel-mode result was applied, on the working directories as
   * they were with that result in them: whose, and whether it was then applied (not when it did not pass,
   * until the user applies it anyway).
   */
  applyOf?: {
    agentId: string;
    name: string;
    /** The member's worktree heads it checked: Apply anyway applies only that result. */ heads?: string;
  };
  applied?: boolean;
  outcomes: CheckOutcome[];
  /** The replies whose work it checked (message ids), oldest first. */
  replyIds?: string[];
  /** A result copied from another conversation when branching, shown in history only. */
  historical?: true;
  /** When it was checked, and how long that took. */
  checkedAt: number;
  durationMs?: number;
  /**
   * The working directories changed after it was checked (Harness Relay saw them changed: a later
   * turn, an applied result): it says nothing about them as they are now.
   */
  stale?: boolean;
  /** The user went on without it passing: queued messages go, and agents are not told of it any more. Still not a pass. */
  skippedAt?: number;
  /** The user asked a member to fix it (the member's name then). */
  fixBy?: string;
  /**
   * The app preview rule (`CheckList.previewApp`): the replies whose apps it checked, oldest first. This
   * run's, after those of a result whose preview failed and still held the queue.
   */
  appReplies?: string[];
  /** How many automatic fixes (`CheckList.autoFix`) came before it in a row: at `CHECK_LIMITS.autoFixes`, it waits for the user. */
  autoFixes?: number;
  /** Its fix (`fixBy`) was sent by Relay itself, not asked by the user. */
  fixAuto?: true;
}

/** Most findings one rule's result keeps, the most of a command's output it keeps, and the most of it agents are shown. */
export const CHECK_RESULT_LIMITS = { findings: 20, output: 8000, promptOutput: 3000 };

/**
 * The working directories the working directory box offers (`GET /api/cwds`): the default one (Settings)
 * first, then the conversations' own, the most recently used first; only folders that still exist.
 */
export interface WorkingDirectories {
  /** The home folder, so a typed `~` matches it. */
  home: string;
  dirs: { path: string; /** The default working directory (Settings). */ default?: true }[];
  /**
   * This browser can open this computer's own folder dialog (`POST /api/cwds/pick`): it runs on the
   * computer the server runs on, which has one.
   */
  pick?: true;
}

/** The folders chosen in the folder dialog; none when it was cancelled. */
export interface PickedFolders {
  paths: string[];
}

/** The agent that designs the team for auto-team conversations. */
export interface LeadAgentSettings {
  provider: Provider;
  model?: string;
  effort?: string;
  /** The account of its CLI it runs as; absent = the default account (see `AgentConfig.account`). */
  account?: string;
}

/** What the lead agent decided for a question in an auto-team conversation (shown as a card in the chat). */
export interface TeamPlan {
  /** Per-call usage. Older plans kept only the combined figures on the message. */
  usage?: PlanUsage[];
  status: 'planning' | 'ready' | 'failed';
  lead: LeadAgentSettings;
  /** The configured lead could not run for this design. */
  leadUnavailable?: boolean;
  /**
   * kept: the current team, as it is; template: an existing template, as it is; adapted: a template
   * the lead changed for the question; custom: a team the lead designed from scratch; fallback:
   * planning failed (the current team is kept when there is one, otherwise the general template).
   */
  source?: 'kept' | 'template' | 'adapted' | 'custom' | 'fallback';
  /** The template used (template, fallback). */
  presetId?: string;
  /** The template the team was adapted from (adapted). */
  basedOn?: { id: string; name: string };
  name?: string;
  description?: string;
  /** A fallback's original diagnostic and any exhausted window reported by the lead's account.
   * Older cards kept the whole explanation, including the CLI error, in `reason`. Model checks
   * that only changed member assignments have no lead diagnostic. */
  fallback?: { diagnostic?: string; limit?: Pick<UsageLimit, 'span' | 'resetsAt'> };
  /** The lead's explanation, or a note about changes to member assignments. */
  reason?: string;
  settings?: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>;
  agents?: AgentConfig[];
  /** Set once the user saved a custom team as a template. */
  savedPresetId?: string;
  /**
   * The design waits for the user: nobody answers until they confirm it, set the team by hand or
   * decline it (keeping the current team); then the team answers the question. Until then the
   * conversation keeps its current team. (Plans from before this step have none of these fields.)
   */
  awaitingConfirmation?: boolean;
  /** Full-access checks can run after the user confirms this proposed team. */
  checkOnConfirm?: boolean;
  /** The user confirmed it: the team became this one. */
  confirmedAt?: number;
  /** The user declined it: the current team stayed, and answered the question. */
  declinedAt?: number;
  /** Confirmed without asking: the conversation uses the lead agent's team at once (`autoConfirm`). */
  autoConfirmed?: boolean;
  /**
   * The user set the team by hand (the team drawer) after the lead agent designed it, or while it waited
   * for confirmation: `agents` and `settings` are the team as the user set it then, so the card shows
   * the team the conversation has (`planFollowsTeam`).
   */
  adjustedAt?: number;
  /**
   * Designed for the conversation's schedule (its message, which nobody posted): once confirmed, the
   * team answers nothing now; it gets the message when the schedule sends it.
   */
  forSchedule?: boolean;
}

/**
 * What a highlight of the lead agent's review is about: a risk (a bug, data loss, a security or
 * destructive change), a decision the user has to make, members who disagree, a claim or assumption
 * to check before relying on it, or anything else worth a closer look.
 */
export type ReviewKind = 'risk' | 'decision' | 'conflict' | 'verify' | 'note';
export const REVIEW_KINDS: ReviewKind[] = ['risk', 'decision', 'conflict', 'verify', 'note'];

/** A place in the team's replies the lead agent wants the user to look at closely. */
export interface ReviewHighlight {
  kind: ReviewKind;
  /** Why it matters, for the user. */
  note: string;
  /** The reply it is about (its message id); absent: the replies as a whole. */
  messageId?: string;
  /** Who wrote that reply, as the reply names them (members can be renamed later). */
  agentName?: string;
  /** Words of that reply it is about, as the reply has them (marked in the reply when they are found). */
  quote?: string;
}

/** A next step the lead agent suggests: one for the user to do, or one to ask the team for. */
export interface ReviewStep {
  text: string;
  by: 'user' | 'team';
  /** For the team: the message to send it (absent: `text`). */
  message?: string;
}

/**
 * The lead agent's review of the team's replies since its last review (`ConversationSettings.leadReview`),
 * shown as a card after them. `failed`: it could not review them (`error` says why); stopped, the
 * message is `aborted`. Only a `ready` review counts as read: the next one reads from there on.
 */
export interface LeadReview {
  status: 'reviewing' | 'ready' | 'failed';
  lead: LeadAgentSettings;
  /** Where the team got to, in a sentence or two. */
  summary?: string;
  highlights?: ReviewHighlight[];
  nextSteps?: ReviewStep[];
  /** The replies it read (message ids), oldest first. */
  replyIds?: string[];
  /** The first message it read (the id): a review that fails or is stopped leaves the next one to read from there. */
  fromId?: string;
  error?: string;
}

/** Most highlights and next steps one review keeps, and the longest of each part, in characters. */
export const REVIEW_LIMITS = {
  highlights: 8,
  nextSteps: 6,
  summary: 800,
  note: 500,
  quote: 300,
  step: 300,
  message: 2000,
};

/** The lead agent's team design that is waiting for the user's confirmation, if any. */
export function pendingPlan(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((m) => m.plan?.status === 'ready' && m.plan.awaitingConfirmation);
}

/**
 * The lead agent's team design the conversation's team comes from: the latest one that was used
 * (confirmed, or from before confirmation was asked). Designs declined since it, and one still
 * waiting, are passed over: the conversation kept the team it had.
 */
export function currentPlan(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.findLast((m) => m.plan?.status === 'ready' && !m.plan.awaitingConfirmation && !m.plan.declinedAt);
}

/** Only a team the lead designed or adapted is new, and can be saved as a template. */
export function planSavable(plan: Pick<TeamPlan, 'source'>): boolean {
  return plan.source === 'custom' || plan.source === 'adapted';
}

/** Longest request to the lead agent to change a team (the team drawer's "Ask the lead agent"). */
export const REVISE_REQUEST_MAX = 4000;

/**
 * What the team drawer sends to change its team (`POST /api/conversations/:id/revise-team`): the
 * request, the members, how they take turns, and the drawer's permission and working directory (saved
 * or not), which the lead agent only reads.
 */
export interface ReviseTeamRequest {
  request: string;
  agents: AgentConfig[];
  settings: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops' | 'permission' | 'cwd' | 'extraCwds'>;
}

/** The most working directories a conversation may have (`cwd` and `extraCwds` together). */
export const MAX_CWDS = 8;

/** A conversation's working directories: `cwd`, then `extraCwds`. */
export function cwdsOf(s: { cwd: string; extraCwds?: readonly string[] }): string[] {
  return [s.cwd, ...(s.extraCwds ?? [])];
}

/** `cwd` and `extraCwds` for a list of working directories (the first is `cwd`). */
export function cwdSettings(dirs: readonly string[]): { cwd: string; extraCwds?: string[] } {
  const [cwd = '', ...extra] = dirs;
  return extra.length ? { cwd, extraCwds: extra } : { cwd };
}

/**
 * The team being edited in the team drawer, as the lead agent changed it at the user's request. It
 * is not used until the user saves it.
 */
export interface TeamRevision {
  agents: AgentConfig[];
  settings: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>;
  /** What the lead changed and why, for the user. */
  reason: string;
  /** How long the lead agent took, and what it cost. */
  meta?: MessageMeta;
}

/*
 * The lead agent's drafts for the editors that are not a conversation's team (`src/server/leadDrafts.ts`):
 * the user says what they want in the editor, the lead agent answers with the whole thing as it would
 * be, and the editor shows it until the user saves it (or undoes it). Nothing is saved by asking. Each
 * request is at most `REVISE_REQUEST_MAX` characters, as the team drawer's is.
 */

/** What the template editor sends to have the lead agent draft its template (`POST /api/presets/draft`). */
export interface TemplateDraftRequest {
  request: string;
  name: string;
  description: string;
  agents: AgentConfig[];
  settings: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>;
}

/** The template as the lead agent drafted it: its team, and its name and description. */
export interface TemplateRevision extends TeamRevision {
  name: string;
  description: string;
}

/**
 * What the team checks editor sends to have the lead agent draft its rules (`POST /api/checks/draft`):
 * the list as the editor holds it, and where the team works, when the editor knows: a conversation's
 * (`convId`, with the team drawer's working directories when they are not saved yet) or a new chat's
 * (`cwd`, `extraCwds`). None for a template or Settings' default, which no project has yet.
 */
export interface ChecksDraftRequest {
  request: string;
  /** Whose list it is: a conversation's or a new chat's (`team`), a template's, or Settings' default. */
  variant: 'team' | 'template' | 'defaults';
  checks?: CheckList;
  convId?: string;
  cwd?: string;
  extraCwds?: string[];
}

/** The team checks as the lead agent drafted them. */
export interface ChecksRevision {
  checks: CheckList;
  reason: string;
  /** The folder the lead agent read the project in; absent when it had none to read. */
  readIn?: string;
  meta?: MessageMeta;
}

/**
 * What the schedule form sends to have the lead agent draft the schedule (`POST /api/schedules/draft`):
 * the form as it stands (anything in it may be missing or unfinished), and the browser's time zone, which
 * the form's times are in. `convId`: the conversation whose schedule it is (the schedule drawer's).
 */
export interface ScheduleDraftRequest {
  request: string;
  schedule?: Partial<ScheduleUpdate>;
  timeZone: string;
  convId?: string;
}

/** The schedule as the lead agent drafted it, checked as a saved one is (`validateSchedule()`). */
export interface ScheduleRevision {
  schedule: ScheduleUpdate;
  reason: string;
  meta?: MessageMeta;
}

/**
 * A schedule an agent proposed in a reply (its `<schedule>` block, `src/shared/scheduleProposal.ts`):
 * nothing is scheduled until the user creates it from the reply's card, as it is or once changed in the
 * schedule's form. Its times are wall-clock ones, in the user's time zone when it is created (a `once`
 * time as `YYYY-MM-DDTHH:MM`); a mail or calendar trigger's account may be missing (`''`), for the user
 * to pick in the form.
 */
export interface ScheduleProposal {
  text: string;
  repeat: ScheduleProposalRepeat;
  goal?: string;
  newChat?: boolean;
  missed?: ConversationSchedule['missed'];
  /**
   * The name of a fixed command of the working directory that Harness Relay runs first, each time
   * (`ConversationSchedule.command`, which holds its id once the user creates the schedule).
   */
  command?: string;
  /** With `command`: only it runs, never the team (`ConversationSchedule.commandOnly`). */
  commandOnly?: boolean;
}

export type ScheduleProposalRepeat = Exclude<ScheduleRepeat, { kind: 'once' }> | { kind: 'once'; at: string };

/** What the user did with a proposed schedule: created it (from the card or the form), or dismissed it. */
export type ScheduleProposalStatus = 'created' | 'dismissed';

/**
 * What the sidebar's groups dialog sends to have the lead agent suggest how to organize the
 * conversations (`POST /api/groups/suggest`): what the user wants, if they say (by topic, by client…).
 */
export interface GroupSuggestionRequest {
  request?: string;
}

/**
 * The lead agent's suggestions for the sidebar's groups, each for the user to take or leave: groups to
 * make (by a key the moves name them by), groups to rename, and conversations to move (the top of each
 * family of branches, which moves with its branches). `to`: a group's id, a new group's key, or null for
 * the default group ("Other").
 */
export interface GroupSuggestion {
  create: { key: string; name: string }[];
  rename: { id: string; from: string; name: string }[];
  move: { convId: string; title: string; from: string | null; to: string | null }[];
  reason: string;
  meta?: MessageMeta;
}

/** The suggestions the user took (`POST /api/groups/reorganize`), applied together. */
export interface GroupReorganize {
  create: { key: string; name: string }[];
  rename: { id: string; name: string }[];
  move: { convId: string; to: string | null }[];
}

export interface TeamPreset {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  agents: AgentConfig[];
  settings: Omit<ConversationSettings, 'cwd' | 'extraCwds'>;
}

export type Author = { kind: 'user' } | { kind: 'agent'; agentId: string } | { kind: 'system' };

export type ToolStatus = 'running' | 'done' | 'error';

/** What a tool call does, as ACP names it (its `ToolKind`, `switch_mode` as `other`). */
export const TOOL_CALL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'] as const;
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number];

/** What an agent asks to be allowed to do. */
export type ApprovalKind = 'command' | 'edit' | 'fetch' | 'other';

/**
 * Where an approval request stands. `expired`: the turn ended before anyone answered. `withdrawn`: the
 * agent's CLI stopped waiting for the answer while the turn went on (it decided by itself, through its
 * own hook or rule, say, or the call it asked about ended): nothing the user answers reaches it.
 */
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'withdrawn';

/**
 * "Approve for me" (`approvals: 'auto'`): the lead agent's review of a request, before the user is
 * asked. `reviewing`: under way, and the user may answer meanwhile; `approved`: judged safe, and
 * allowed; `flagged`: judged potentially unsafe, so the user is asked (or, in a run nobody may be
 * watching, it is refused); `failed`: the lead agent could not review it, so the user is asked;
 * `skipped`: never reviewed (pushing and publishing, more access for the turn), so the user is asked.
 */
export interface ApprovalReview {
  status: 'reviewing' | 'approved' | 'flagged' | 'failed' | 'skipped';
  /** The lead agent's reason, in the user's language; or Harness Relay's, when it failed or was skipped. */
  reason?: string;
}

/*
 * Taking over the chat's browser (`browser_hand_over`, `src/server/browser/handover.ts`): an agent hands
 * the page to the user when it needs them (a sign-in, a two-factor code, a CAPTCHA, a consent screen),
 * and the call waits until the user hands it back.
 */

/**
 * How the user is shown the page: in a window of the browser itself on the computer Harness Relay runs
 * on, or in the chat, as Chromium's screencast, with the user's clicks and keys sent back. `computer`: not
 * the browser but the chat's Cua computer (`computer_hand_over`), which the user takes control of in its
 * panel (`ComputerView`).
 */
export type HandoverMode = 'window' | 'screencast' | 'computer';

/**
 * Where a hand-over stands: waiting for the user to start it (or decline), in the user's hands, or over:
 * handed back (`done`), declined before it started, cancelled once started, or over by itself (`expired`:
 * the time ran out, the turn ended, or the window could not open, `HandoverPart.ended` says which).
 */
export type HandoverStatus = 'pending' | 'active' | 'done' | 'declined' | 'cancelled' | 'expired';

/**
 * How a hand-over ended by itself: its time ran out, the turn ended, the browser could not be shown, or
 * the agent's CLI stopped waiting for the call (its own time limit).
 */
export type HandoverEnded = 'timeout' | 'turn' | 'failed' | 'gone';

/**
 * Where a hand-over's window opens, when it can: beside the desktop app (`desktop`), or on the computer
 * the server runs on (`server`: a Mac signed in at its screen, Linux with a display, Windows).
 */
export type HandoverWindowAt = 'desktop' | 'server';

/**
 * A hand-over's limits: the minutes the user has to start it, then to hand it back; the longest note to
 * the agent, text typed at once, and events in one request of the screencast's.
 */
export const HANDOVER_LIMITS = {
  startMinutes: 15,
  useMinutes: 30,
  noteMax: 2000,
  textMax: 2000,
  eventsMax: 100,
  wheelMax: 10_000,
} as const;

/**
 * What the screencast panel is told (`GET /api/conversations/:id/handovers/:handoverId/screen`): a frame
 * of the page (a JPEG, its size in the page's own pixels), where the page is now, a new window the page
 * opened (closed: the browser keeps to one tab) or a page it was refused, and that the hand-over is over.
 */
export type HandoverScreenEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'location'; url: string; back: boolean; forward: boolean }
  | { type: 'notice'; kind: 'popup' | 'refused'; url?: string }
  | { type: 'ended' };

/** Modifier keys as Chromium's input takes them: Alt 1, Ctrl 2, Meta (⌘) 4, Shift 8. */
export type HandoverModifiers = number;

/**
 * What the user does in the screencast panel (`POST /api/conversations/:id/handovers/:handoverId/input`),
 * in order. `x` and `y` are fractions (0 to 1) of the frame shown, which the server turns into the
 * page's own pixels. A key with `text` types it (a key of a hardware keyboard); `text` alone inserts it
 * as typed (an on-screen keyboard, an input method's composed text, a paste). `command`: an editing
 * command a shortcut stands for. `viewport`: the panel's size, which the page is laid out to (as a desktop
 * browser's window of that size: no phone emulation, whose zoomed-out pages take input elsewhere than
 * where the frame shows them).
 */
export type HandoverInput =
  | {
      type: 'mouse';
      action: 'down' | 'up' | 'move';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right' | 'none';
      clicks?: number;
      modifiers?: HandoverModifiers;
    }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; modifiers?: HandoverModifiers }
  | {
      type: 'key';
      key: string;
      code?: string;
      keyCode?: number;
      text?: string;
      modifiers?: HandoverModifiers;
      command?: 'selectAll' | 'undo' | 'redo';
    }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'history'; to: 'back' | 'forward' | 'reload' }
  | { type: 'viewport'; width: number; height: number; scale?: number };

/** The user's answer to a hand-over: start it (one of its modes), hand it back, or decline or cancel it. */
export type HandoverAnswer =
  { action: 'start'; mode: HandoverMode } | { action: 'done'; note?: string } | { action: 'cancel'; note?: string };

// --- The chat's computer: a Cua desktop the agents and the user share -------------------------
// (src/server/computer/; docs/architecture.md, "The computer")

/**
 * Where a chat's computer stands: none yet (`off`), being made or started (`starting`), on (`ready`), being
 * stopped (`stopping`), or it could not start (`failed`, with why).
 */
export type ComputerStatus = 'off' | 'starting' | 'ready' | 'stopping' | 'failed';

/** Who acts on the computer: the agents (the user watches), or the user, who took control (the agents wait). */
export type ComputerControl = 'agents' | 'user';

/**
 * One thing done on the computer, as its panel lists it: when, who (an agent, by its name; the user; or
 * Harness Relay itself, making or waking it) and what, in a line.
 */
export interface ComputerAction {
  at: number;
  who: 'agent' | 'user' | 'relay';
  /** The agent's name. */
  by?: string;
  what: string;
}

/** A chat's computer, as its panel shows it (`GET /api/conversations/:id/computer`). */
export interface ComputerView {
  status: ComputerStatus;
  /** Why it could not start or stopped (`failed`), in a line. */
  error?: string;
  /** When it began starting (`starting`): the first start downloads for minutes. */
  startedAt?: number;
  control: ComputerControl;
  /** The newest things done on it, oldest first (at most `COMPUTER_LIMITS.recent`). */
  recent: ComputerAction[];
  /** An agent asked the user to take over (`computer_hand_over`), in a chat (`convId`): waiting for them, or theirs now. */
  handover?: { id: string; convId: string; agentName: string; reason: string; status: 'pending' | 'active' };
  /** The working directory whose chats share it: one computer per folder. */
  folder?: string;
  /** Cua is installed here, so the computer can be started. */
  available: boolean;
}

/** What the computer's panel is told (`GET /api/conversations/:id/computer/screen`): a frame of its screen, or its state. */
export type ComputerScreenEvent =
  { type: 'frame'; data: string; mimeType: string; width: number; height: number } | { type: 'state'; view: ComputerView };

/**
 * What the user does in the computer's panel while they have control (`POST …/computer/input`), in order.
 * `x` and `y` are fractions (0 to 1) of the frame shown, which the server turns into the screen's pixels; a
 * key is Cua's name for it, with modifiers joined by `+` (`ctrl+c`, `enter`); text is typed as it is.
 */
export type ComputerInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right'; double?: boolean }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number }
  | { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { type: 'key'; keys: string }
  | { type: 'text'; text: string };

/**
 * The computer's limits: things its panel lists, input events in one request, text typed at once, lines of
 * one scroll, the minutes a computer stays on unused before it is stopped (its disk kept), and a command's
 * output kept for the agent.
 */
export const COMPUTER_LIMITS = {
  recent: 20,
  eventsMax: 50,
  textMax: 2000,
  scrollMax: 25,
  idleMinutes: 30,
  outputMax: 20_000,
} as const;

/** Settings → Common apps → Computer: Cua as found here, whether its computers can run, and the chats' computers. */
export interface ComputerSettingsView {
  /** The `cua` the computer tools start: its version, and whether Harness Relay installed it. */
  cua?: { version: string; own: boolean; path: string };
  /** The user's own `cua`, too old for the computer tools. */
  tooOld?: { version?: string; path: string };
  /** The version Settings installs. */
  installs: string;
  /** Whether a Linux computer can run here, in `cua runtime doctor`'s words; undefined until checked. */
  runtime?: { ready: boolean; detail: string };
  /**
   * This server's computers, on or suspended: one per working directory, with the chats there (none for one
   * whose chats were all deleted, or one of an older Harness Relay, kept until deleted here).
   */
  computers: { name: string; folder?: string; chats: string[]; status: ComputerStatus }[];
}

/** One step of an agent's plan / to-do list. */
export interface PlanEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * One step a reply asks the user to take outside Harness Relay (its `<steps>` block, `src/shared/steps.ts`):
 * the agent's words (Markdown), and whether the user ticked it.
 */
export interface StepItem {
  text: string;
  done?: boolean;
}

/**
 * The user's answer to a steps card, once sent (`POST …/steps/answer`): when, the step they are stuck at
 * (its index), and their note. The steps they did are the items ticked then; the card no longer changes.
 */
export interface StepsAnswer {
  at: number;
  stuckAt?: number;
  note?: string;
}

/**
 * A steps block: at most `steps` steps, `blockChars` characters in all (past either, the block stays
 * text); the user's note at most `noteChars`.
 */
export const STEPS_LIMITS = { steps: 30, blockChars: 8000, noteChars: 2000 };

export type MessagePart =
  | {
      type: 'text';
      text: string;
      /** The source reply and the recipient's name at the time this user follow-up was sent. */
      followUp?: { replyId: string; name: string };
    }
  /** The agent's reasoning, as far as its CLI shares it. Never forwarded to other agents. */
  | { type: 'thinking'; text: string }
  /** The agent's current plan / to-do list (updated in place). */
  | { type: 'plan'; entries: PlanEntry[] }
  /**
   * `error`: why the call failed or was refused, when the CLI said so.
   * `output`: the end of what the call returned (command output, fetched text…).
   * `kind`: what the call does, when its CLI says (or its adapter can tell from the tool); only
   * AgentsView's record of a member's session uses it (`memberTranscript`).
   */
  | {
      type: 'tool';
      id: string;
      name: string;
      detail?: string;
      kind?: ToolCallKind;
      status: ToolStatus;
      error?: string;
      output?: string;
      /**
       * The call it was made under, when a subagent (or another call that runs calls, like `run_code`)
       * made it: the id of the tool part that started that subagent. The chat shows it inside that one.
       */
      parentId?: string;
      /** On a call that starts a subagent: the subagent's name and model, when the CLI says. */
      agent?: string;
      model?: string;
    }
  /** The agent asked to do something its permission does not cover; the user decides. */
  | {
      type: 'approval';
      id: string;
      kind: ApprovalKind;
      /** The tool's name (shown for kind "other"). */
      tool?: string;
      /** The command, file or URL. */
      detail?: string;
      /** Why, when the agent said. */
      reason?: string;
      /** What "always allow in this conversation" would cover, e.g. "npm install". */
      ruleLabel?: string;
      /** That rule is this exact command line only (it sets what decides what runs, `PATH=…`, say). */
      ruleExact?: boolean;
      /** Allowing it runs the command outside the CLI's sandbox. */
      outsideSandbox?: boolean;
      /** Read-only is a boundary here: Harness Relay's sandbox keeps the agent from writing even when allowed. */
      readOnlySandbox?: boolean;
      status: ApprovalStatus;
      /** Allowed for the rest of the conversation (or by such an earlier answer). */
      always?: boolean;
      /** Answered automatically by an earlier "always allow". */
      auto?: boolean;
      /** "Approve for me": the lead agent's review of it (`ApprovalReview`). */
      review?: ApprovalReview;
      /** The user's message to the agent when declining. */
      note?: string;
    }
  /**
   * A file the user attached to their message (stored under data/attachments), or a folder of files
   * (`files` set, its `mimeType` `FOLDER_MIME_TYPE` and its `size` all its files' together).
   */
  | { type: 'attachment'; id: string; name: string; mimeType: string; size: number; files?: number }
  /** What the reply said about the goal its schedule tracks (its `<progress>` block, taken out of its text). */
  | { type: 'progress'; status: ProgressStatus; text: string }
  /** Something the agent asked to send (a `send` call of Harness Relay's tools): it waits in the outbox for the user. */
  | {
      type: 'outbox';
      id: string;
      tool: string;
      title: string;
      preview: OutboxPreview;
      status: OutboxStatus;
      result?: string;
      /**
       * How it ended, for the agent that asked (in English): given in its next turn's prompt, once (as
       * `outbox:<id>` in its `seen`); a fixed command's run with its output, secrets masked.
       */
      forAgent?: string;
      /**
       * A fixed command's run (`FIXED_COMMAND_TOOL`): the command (its id), and, while its code changed
       * since the user saved or approved it, the files that did: Send waits until the user approved them,
       * which the card offers.
       */
      command?: { id: string; changed?: string[] };
    }
  /** What the reply saved to long-term memory (its `<remember>` and `<forget>` blocks, taken out of its text). */
  | { type: 'memory'; notes: MemoryPartNote[] }
  /** A schedule the agent proposed (its `<schedule>` block, taken out of its text), for the user to create or dismiss. */
  | { type: 'schedule'; proposal: ScheduleProposal; status?: ScheduleProposalStatus }
  /**
   * Steps the reply asks the user to take outside Harness Relay (its `<steps>` block, taken out of its
   * text): the reply asks, and the team waits as for `ASK_TOKEN`. Each step is ticked as the user goes;
   * `answer`: what they sent, after which the card no longer changes.
   */
  | { type: 'steps'; items: StepItem[]; answer?: StepsAnswer }
  /**
   * The agent handed the chat's browser to the user (`browser_hand_over`): why, in its words; the page;
   * how it can be shown (`modes`, the window's only where this computer can show one, and where it opens);
   * where it stands, and the user's note when they wrote one.
   */
  | {
      type: 'handover';
      id: string;
      reason: string;
      /** The page open when it was asked (its address without the query, as the card shows it). */
      url?: string;
      modes: HandoverMode[];
      windowAt?: HandoverWindowAt;
      status: HandoverStatus;
      /** How the user took it over, once they did. */
      mode?: HandoverMode;
      /** When it ends by itself unless the user starts it or hands it back first (milliseconds since the epoch). */
      deadline?: number;
      /** The user's words to the agent, as they handed it back, declined or cancelled. */
      note?: string;
      /** Why it ended by itself (`expired`). */
      ended?: HandoverEnded;
    }
  /**
   * What Harness Relay noted about the turn, not the agent's words (never forwarded as them): a tool
   * library MCP server left out of it, its sign-in needing renewal, cards left out of the reply.
   * `forAgent`: what the agent is told about it on its next turn, in English (`TurnInfo.notes`).
   */
  | { type: 'notice'; text: string; forAgent?: string }
  /**
   * The secrets the reply asked the user for (its `<secret>` blocks, taken out of its text): their
   * names and why, never a value. `folder`: the working directory they are kept for.
   */
  | {
      type: 'secrets';
      id: string;
      folder: string;
      asks: SecretAsk[];
      /** Harness Relay asks, not the agent: secrets a fixed command the reply proposed names, which the reply left out. */
      byRelay?: boolean;
    }
  /**
   * A fixed command the reply proposed (its `<command>` block, taken out of its text): the user saves
   * it for the working directory, or not. `run`: its last run from this card.
   */
  | {
      type: 'command';
      id: string;
      folder: string;
      proposal: CommandProposal;
      status: 'proposed' | 'saved' | 'dismissed';
      commandId?: string;
      run?: FixedCommandRun;
      /** A saved command of the same name existed when it was proposed: saving replaces it. */
      replaces?: boolean;
      /** What the agent suggests typing in Try it's input box (its block's `input`), which the box starts with. */
      input?: string;
      /**
       * The run the user sent to the team as their answer (its `at`, Send the result to the team): the chat
       * has it, so it is not told again (`commandRunNotes()`).
       */
      sharedAt?: number;
      /** Dismissed by Harness Relay, not the user: a later reply proposed a command of the same name, which is the one to save. */
      superseded?: boolean;
      /**
       * It cannot be saved from this card: an automation's run proposed it, which nobody watched; or it
       * was proposed on native Windows, where Harness Relay's own sandbox that runs it does not run.
       */
      blocked?: 'automation' | 'windows';
    }
  /**
   * A fixed command did not run because its code changed since the user saved or approved it (a run
   * its schedule started; the note in the chat holds it): its name, the files that changed, and a way
   * to look at them and approve them. `approved`: the user did, here or on another card of it.
   */
  | { type: 'command-changed'; commandId: string; name: string; changed: string[]; approved?: boolean }
  /**
   * A command the reply asks the user to run themselves (its `<interactive>` block, taken out of its
   * text): a sign-in, a CLI's login with a device code. Only the user starts it, from this card; it runs
   * with their rights, outside the agents' sandboxes, and its output reaches the team only when they send it.
   */
  | {
      type: 'interactive';
      id: string;
      /** The conversation's working directory: where it runs when the user chooses so. */
      folder: string;
      /** The command line, as the agent wrote it. */
      run: string;
      /** Why, in the agent's words. */
      reason?: string;
      /** The agent says it needs the working directory (`workdir="yes"`): the card offers it first. */
      workdir?: boolean;
      /**
       * The configuration files in the working directory a program may load there (`.npmrc`, `.env`…),
       * which agents can write: the card lists them, and starting there is refused when others appeared since.
       */
      configFiles: string[];
      /** What those files held when the card listed them (`workdirDigest()`): Start there is refused once it changed. */
      configDigest?: string;
      /** It cannot be started from this card: proposed in an automation's run, or on native Windows. */
      blocked?: 'automation' | 'windows';
      status: 'proposed' | 'started' | 'dismissed';
      /** Its latest run from this card. */
      session?: InteractiveSession;
    };

/** How an interactive command's run from its card goes (`src/server/interactive.ts`), as the card shows it. */
export interface InteractiveSession {
  /**
   * `running`, then how it ended: `exited` (by itself, `exitCode`), `cancelled` (the user stopped it),
   * `timedOut` (its time limit), `failed` (it could not start: `reason`), `stopped` (the server stopped).
   */
  state: 'running' | 'exited' | 'cancelled' | 'timedOut' | 'failed' | 'stopped';
  startedAt: number;
  /** When its time limit stops it, if it still runs. */
  endsAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** It ran in the working directory, not in an empty folder of its own. */
  inWorkdir: boolean;
  /**
   * What it printed and what the user typed into it (not what they typed hidden), its end only, with
   * the folder's secret values and everything typed hidden replaced by dots.
   */
  output: string;
  /** The links and codes in its output (a device sign-in's). */
  urls: string[];
  codes: string[];
  /** Its password helper (`sudo -A`, ssh, git) asks for a line: the card asks the user, hidden. */
  asking?: { id: string; prompt: string };
  /** Whether it had the password helper; why not otherwise (no Node.js to run it with, or no way to reach it). */
  helper: 'on' | 'no-node' | 'off';
  reason?: string;
  /** The user sent its output to the team. */
  sent?: boolean;
}

/** Limits of interactive commands (`<interactive>` blocks). */
export const INTERACTIVE_LIMITS = {
  /** Characters of the command line, and of the agent's reason. */
  commandLine: 2000,
  reason: 500,
  /** Interactive commands a reply may propose. */
  perReply: 2,
  /** Minutes one may run, waiting for the user included (a device code lasts about as long). */
  timeoutMin: 15,
  /** Characters of its output a card keeps (its end). */
  output: 16_000,
  /** Bytes of one line the user types into it. */
  input: 4096,
  /** Characters of a password helper's prompt shown. */
  prompt: 300,
  /** Interactive commands running at once on this server. */
  running: 4,
} as const;

/**
 * A secret an agent asked the user for (a `<secret>` block, `src/shared/handoffs.ts`). The value is
 * kept in the credential store for the working directory and given only to the fixed commands that
 * name it: never to an agent, the chat or the database.
 */
export interface SecretAsk {
  name: string;
  /** What the agent calls it, for the card. */
  label?: string;
  /** Why it needs it, in the agent's words. */
  reason?: string;
  /** `saved`: the user gave it; `declined`: they said no. */
  status: 'waiting' | 'saved' | 'declined';
  /** The folder had a value for this name already when it was asked: saving replaces it. */
  had?: boolean;
  /**
   * The page where the user gets it (a token generator), which the agent named (`url` on the block): the
   * card links to it, for the user to open in their own browser and paste the value on the card.
   */
  url?: string;
}

/** What a `<command>` block proposes: a command line for the working directory, the hosts it reaches and the secrets it gets. */
export interface CommandProposal {
  name: string;
  run: string;
  hosts: string[];
  secrets: string[];
  /** Where it runs: a folder relative to the working directory (its top when absent). */
  cwd?: string;
  /**
   * Its runs publish, post or send something (`publishes="yes"`): Try it on its card asks the user to
   * confirm first, as such a try would really do it.
   */
  publishes?: boolean;
}

/**
 * One file of the code a fixed command would run, or of what changed in it since it was saved, as the
 * server shows it (`codeView()`, `pinDiff()` in `src/server/fixedCommands.ts`): its entry (a path in the
 * folder, `named:` and a path for a script the command line names outside it, `git config <key>`, `git
 * hook <name>`); `diff`, git's diff of it (a new, changed or removed file); `now`, its text as it is now;
 * `names`, a file of secrets by its names alone; `git`, a git setting or hook as it is now. Its text,
 * secrets masked; `cut` when it was too long to show all of it. Kept apart so that a file's own lines
 * that read like a diff's or a header's never start another one where the card lists them.
 */
export interface CodeViewFile {
  entry: string;
  kind: 'diff' | 'now' | 'names' | 'git';
  text: string;
  cut?: boolean;
}

/** How one run of a fixed command went, as its card shows it. Its output has every secret it holds masked. */
export interface FixedCommandRun {
  at: number;
  source: 'try' | 'schedule' | 'outbox';
  /**
   * `passed`: exit code 0; `news`: `FIXED_COMMAND_NEWS`, something new for the team; `failed`: any
   * other code; `error`: it could not run (`reason`); `changed`: not run, its pinned code changed since
   * it was saved (`changed`); `running`: under way.
   */
  status: 'running' | 'passed' | 'news' | 'failed' | 'error' | 'changed';
  exitCode?: number | null;
  durationMs?: number;
  /** What it printed (its end), secrets masked: while it runs, what it printed so far, a second behind at most. */
  output?: string;
  reason?: string;
  /** `changed`: the pinned files that changed, added or went since it was saved, relative to its folder. */
  changed?: string[];
  /** `running`: when its time limit stops it (`HANDOFF_LIMITS.timeoutMin`), milliseconds since the epoch. */
  endsAt?: number;
  /**
   * `error`: it was stopped (Stop on its card, its conversation deleted, the server stopping or stopped
   * during it), not a failure of its own.
   */
  stopped?: boolean;
  /**
   * The hosts the sandbox refused it, not among its own (at most 20, secrets masked), whatever its exit
   * code: a client that retries a refused connection, or gives up on it, may still end with 0.
   */
  refusedHosts?: string[];
}

/**
 * A fixed command the user saved for a working directory (docs/architecture.md, "Fixed commands"):
 * run by Harness Relay itself in its own sandbox, reaching only its hosts, with its secrets in a file,
 * pinned to the code in its folder.
 */
export interface FixedCommand extends CommandProposal {
  id: string;
  /** The working directory it belongs to (its real path). */
  folder: string;
  createdAt: number;
  /** When its code was last pinned (saved, or changes approved). */
  pinnedAt: number;
  lastRun?: FixedCommandRun;
}

/** The exit code a fixed command uses to say it found something new for the team (in a schedule, its output goes to them). */
export const FIXED_COMMAND_NEWS = 10;

/** Limits of secrets and fixed commands. */
export const HANDOFF_LIMITS = {
  /** Secrets a reply may ask for, and a working directory may keep. */
  secretsPerReply: 5,
  secretsPerFolder: 30,
  /** Characters of a secret's name, its label, an agent's reason, and bytes of its value. */
  secretName: 64,
  label: 80,
  reason: 500,
  secretValue: 16 * 1024,
  /** Characters of the address a `<secret>` block names (the card's link to it). */
  secretUrl: 2000,
  /** Fixed commands a working directory may keep, and a reply may propose. */
  commandsPerFolder: 20,
  commandsPerReply: 3,
  commandName: 40,
  commandLine: 2000,
  /** Hosts and secrets one command may name. */
  hosts: 10,
  commandSecrets: 10,
  /** What one run may take on its standard input (an outbox run), in bytes. */
  input: 16 * 1024,
  /** Characters of the input a `<command>` block suggests for Try it (its `input`). */
  sampleInput: 500,
  /** Minutes a run may take. */
  timeoutMin: 10,
  /** Characters of a run's output kept. */
  output: 8000,
  /** Milliseconds between two updates of a running run's card (its output so far, the hosts refused it). */
  progressMs: 1000,
  /** Pinned files a command's folder may have. */
  pinnedFiles: 5000,
} as const;

/** A secret's name: an environment variable's (upper case, digits and `_`, not starting with a digit). */
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** A fixed command's name: lower case letters, digits, `-` and `_`. */
export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A working directory's secrets and fixed commands, for Settings: names only, never a value. */
export interface FolderHandoffs {
  folder: string;
  secrets: { name: string; setAt: number }[];
  commands: FixedCommand[];
}

/** A hand-over's card in a reply (`browser_hand_over`). */
export type HandoverPart = Extract<MessagePart, { type: 'handover' }>;

/**
 * Limits for what one message attaches (an automation's message too): `maxFiles` files and folders,
 * each file at most `maxBytes` (also in a folder), a folder at most `maxFolderFiles` files, and all of
 * it together at most `maxTotalBytes`: what ten of the largest files were before folders came, sent
 * as base64 in one JSON body.
 */
export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxBytes: 20 * 1024 * 1024,
  maxFolderFiles: 1000,
  maxTotalBytes: 200 * 1024 * 1024,
};

/** The `mimeType` of an attached folder. */
export const FOLDER_MIME_TYPE = 'inode/directory';

/** Whether an attachment is a folder of files. */
export function isFolderAttachment(a: { mimeType: string }): boolean {
  return a.mimeType === FOLDER_MIME_TYPE;
}

/** An attachment's name as a list of them shows it: a folder's ends with `/`. */
export function attachmentLabel(a: { name: string; mimeType: string }): string {
  return isFolderAttachment(a) ? `${a.name}/` : a.name;
}

/** Image types shown inline in the chat and passed to the agents as images. */
export function isInlineImage(mimeType: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mimeType);
}

/** "Always allow in this conversation": requests of this kind with this key are allowed without asking. */
export interface AllowRule {
  kind: ApprovalKind;
  key: string;
}

/** The user's answer to an approval request. */
export interface ApprovalAnswer {
  allow: boolean;
  /** Allow requests like this for the rest of the conversation. */
  always?: boolean;
  /** Message to the agent when declining. */
  note?: string;
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted';

export type ReportedUsage = Pick<MessageMeta, 'costUsd' | 'inputTokens' | 'outputTokens'>;
export type PlanUsage = ReportedUsage & ({ kind: 'planning' | 'combined' } | { kind: 'modelCheck'; provider: Provider; model?: string });

export interface MessageMeta {
  round?: number;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FileChange {
  path: string;
  /** A = added, M = modified, D = deleted. */
  status: 'A' | 'M' | 'D';
  /** Line counts; null for binary files. */
  added: number | null;
  deleted: number | null;
}

/**
 * Files an agent changed during one turn in one repository, as two git commits (diff base..head). A
 * turn has one for each repository of the conversation's working directories it changed.
 */
export interface MessageChanges {
  /** Repository root the commits live in. */
  root: string;
  base: string;
  head: string;
  files: FileChange[];
  /** The changes live in the agent's own worktree and are not in the working directory yet. */
  isolated: boolean;
  branch?: string;
}

/**
 * The key of a conversation's own worktrees in `Conversation.worktrees` (no agent id has an `@`): the
 * team's, which every member works in, taking turns, when its run started while another conversation
 * was writing in its working directories. It stays there until its result is applied (or the chat is
 * rewound past it); its replies' changes are on its branch, and applied as an agent's are.
 */
export const TEAM_WORKTREE = '@team';

/**
 * A per-agent git worktree used in parallel mode so agents don't overwrite each other: one for each
 * repository of the conversation's working directories (or the team's own, `TEAM_WORKTREE`).
 */
export interface AgentWorktree {
  /** Repository root of the working directory (or directories) it is a worktree of. */
  root: string;
  path: string;
  branch: string;
  /** Snapshot of the working directory the worktree started from. */
  base: string;
  /** The working directory changed (e.g. a result was applied); recreate before the next parallel turn. */
  needsReset: boolean;
}

export interface ChatMessage {
  id: string;
  author: Author;
  createdAt: number;
  parts: MessagePart[];
  status: MessageStatus;
  /** The agent replied with [PASS]. */
  passed?: boolean;
  error?: string;
  meta?: MessageMeta;
  /** Snapshot of the agent at the time of the message (agents can be edited later). */
  agentName?: string;
  provider?: Provider;
  /**
   * Files the agent changed in this turn (only for conversations with edit / full permission): one
   * entry per repository it changed, in the order of the working directories.
   */
  changes?: MessageChanges[];
  /** A system message carrying the lead agent's team design (auto-team conversations). */
  plan?: TeamPlan;
  /** A system message carrying the lead agent's review of the team's replies (`ConversationSettings.leadReview`). */
  review?: LeadReview;
  /** A system message carrying the team checks' result (`ConversationSettings.checks`). */
  checks?: ChecksResult;
  /** A user message sent while the team was replying: it waited in the queue for a later turn. */
  queued?: boolean;
  /** The initiating message for this stage of a team's answer. */
  usageQuestionId?: string;
  /**
   * A user message that went into running turns (steering, `ConversationSettings.steer`): the ids of the
   * members whose turn took it, who count it as seen. It is `queued` too (it joined a discussion under way).
   */
  steered?: string[];
  /** An agent reply that asks the user something (it ended with `ASK_TOKEN`, or with steps for them to take): the team waited for the answer. */
  asked?: boolean;
  /** A user message the conversation's schedule sent (see `ConversationSchedule`), not one the user typed. */
  scheduled?: boolean;
  /** A user message Relay sent by itself to fix the team checks (`CheckList.autoFix`): which attempt, of how many. */
  autoFix?: { attempt: number; of: number };
  /**
   * A scheduled message a program sent through the schedule's webhook: the JSON body it posted (at most
   * `TRACKING_LIMITS.eventBytes`), which the agents get as data in an `<event>` block, never as instructions.
   */
  event?: string;
  /**
   * Where `event` came from when it was not the schedule's webhook: an automation that starts when
   * something happens found it (`ScheduleTrigger`), such as new mail. Absent: the webhook.
   */
  eventSource?: EventSource;
  /**
   * The run of a schedule that tracks a goal this message belongs to (`TrackedRun`): a scheduled message
   * that waited in the queue carries it to the run that sends it; a reply written in such a run keeps it,
   * so a Retry or Continue after it goes on with the goal.
   */
  tracked?: TrackedRun;
}

/**
 * A run a schedule that tracks a goal started: the schedule's conversation (`sourceId`, the same one or
 * the one whose schedule opened this chat), the time it came due, which try that is (0 = the first), and
 * whether a run that fails is tried again (not for a webhook's call, whose body would be lost, nor for a
 * run the user carries on: they are there).
 */
export interface TrackedRun {
  sourceId: string;
  due: number;
  attempt: number;
  retries: boolean;
}

/**
 * When a schedule sends its message. `daily` and `weekly` times are wall-clock times ("HH:MM") in the
 * schedule's time zone; `days` are weekdays, 0 = Sunday. `interval` repeats every so many hours from
 * when the schedule was saved; `once` is a moment (epoch ms); `manual` has no times of its own.
 */
export type ScheduleRepeat =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'interval'; hours: number }
  /** No set times: sent only when the user clicks Run once now, or a program calls the schedule's webhook. */
  | { kind: 'manual' }
  /**
   * When something happens: Harness Relay checks each trigger's source itself, apart from the others,
   * and sends the message when one finds something new (1 to `WATCH_LIMITS.triggers`, no two with the
   * same `triggerKey()`: any of them starts it).
   */
  | { kind: 'event'; triggers: ScheduleTrigger[] };

/** In the order the schedule form offers them: no set times first, something happening last. */
export const SCHEDULE_KINDS: ScheduleRepeat['kind'][] = ['manual', 'once', 'daily', 'weekly', 'interval', 'event'];

/**
 * What an automation that starts when something happens watches (`ScheduleRepeat` `event`), checked by
 * Harness Relay itself: no address, no token, and the server still listens on 127.0.0.1 only.
 * - `mail`: a new mail in a folder of an account from Settings (by its id), whose sender and subject
 *   contain the words given (any case), when given.
 * - `calendar`: an event of a calendar from Settings (by its id) about to begin, `minutes` before it
 *   does, whose title contains the words given, when given; all-day events are left out.
 * - `github`: in a repository (`owner/name`), through the user's own `gh`: a pull request opened
 *   (`pr`), or a CI run that failed, timed out or could not start (`ci`, on `branch` when given).
 * - `file`: a file in the conversation's working directory, whose path there matches `pattern` (`*`
 *   within a folder, `**` across folders, `?` one character), appearing or changing; not while a run
 *   writes in that folder (what the team writes is its own).
 */
export type ScheduleTrigger =
  | { source: 'mail'; account: string; folder: string; from?: string; subject?: string }
  | { source: 'calendar'; account: string; minutes: number; title?: string }
  | { source: 'github'; repo: string; on: 'pr' | 'ci'; branch?: string }
  | { source: 'file'; pattern: string };

/** The sources an automation can wait for, in the order the form offers them. */
export const TRIGGER_SOURCES: ScheduleTrigger['source'][] = ['mail', 'calendar', 'github', 'file'];

/** Where a scheduled message's `<event>` block came from: the schedule's webhook, or what a trigger found. */
/** `command`: what a schedule's fixed command found (its output), sent to the team. */
export type EventSource = 'webhook' | 'command' | ScheduleTrigger['source'];

/**
 * What an automation that starts when something happens keeps of one trigger's source between checks,
 * with the schedule (so a restart never fires twice): for which trigger (`key`, `triggerKey()`; another
 * trigger starts afresh), what it has seen of the source, when it was checked and is checked next, and
 * the last check's error. Each trigger of an automation has its own (`ConversationSchedule.watches`),
 * checked on its own schedule. The first check only records what is there.
 */
export interface ScheduleWatch {
  key: string;
  nextCheckAt: number;
  checkedAt?: number;
  /**
   * When what it keeps of its source (`lastUid`) was last recorded as seen: a check that found nothing
   * new, or whose message went. Held or failing checks leave it, so mail they could not send is still
   * new mail later, however long it waited.
   */
  seenAt?: number;
  /** `mail`: the folder's UIDVALIDITY, and the highest UID seen. */
  uidValidity?: number;
  lastUid?: number;
  /** `github` pull requests: the highest number seen. */
  lastId?: number;
  /**
   * `calendar`: the events already seen about to begin (`<uid>@<start>`), those not long past.
   * `github` CI runs: the failed runs seen (`<run id>:<attempt>`), those still among the newest first.
   */
  seen?: string[];
  /** `calendar`: when its last check that worked was (its window starts there, an hour back at most). */
  lookedAt?: number;
  /** `file`: each matching file's path in the working directory, with its size and when it changed (`<mtime>:<size>`). */
  files?: Record<string, string>;
  /** `file`: the working directory those files were found in (another one starts afresh). */
  filesIn?: string;
  /**
   * `file`: a run was writing in the working directory at a check (or a check held or failed while one
   * did): what changed there is the team's own, so the next check with the folder free only records too.
   */
  teamWrote?: boolean;
  /**
   * `file`: the files a check found and held for the team (it could not take them), as they were
   * then: while they stay so, a check that only records (the team writes) keeps them unseen, so that
   * they are still listed once the folder is free. No clock is compared: what the team moves, renames
   * or extracts keeps an old time, and is its own all the same.
   */
  heldFiles?: Record<string, string>;
  /**
   * `file`: how often its folder had been locked for writing at the last check (`Orchestrator.folderWrites()`):
   * changed since, a run wrote there between the checks, and the next check only records.
   */
  writes?: string;
  /** The last check failed: why, and how many checks failed in a row (they come slower). */
  error?: string;
  failures?: number;
  /** Something new was found but the team could not take it: why. Sent at a later check, with what came since. */
  held?: string;
  /** At its last check, the mail server was telling Harness Relay when mail arrives (IMAP IDLE): checked at once then. */
  listening?: boolean;
}

/** What a check keeps of an automation's source (`ScheduleWatch`), apart from when and how it went. */
export type WatchState = Pick<ScheduleWatch, 'uidValidity' | 'lastUid' | 'lastId' | 'seen' | 'lookedAt' | 'files' | 'filesIn'>;

/**
 * The checks of an automation that starts when something happens: every `checkMinutes`, slower after
 * errors (`backoffMinutes`, one more step for each in a row), at most `items` new items listed in the
 * run's message (the newest; how many more came is said), `excerptChars` of each mail's text, a
 * condition or other text field of at most `field` characters, an event's `minutes` before it begins
 * from 1 to `maxMinutes`, at most `files` files matching a file trigger's pattern, and a file listed
 * once it has not changed for `settleSeconds` (it may still be being written).
 */
export const WATCH_LIMITS = {
  /** The most things one automation waits for (`ScheduleRepeat` `event`'s `triggers`). */
  triggers: 5,
  checkMinutes: 2,
  /** While the mail server tells Harness Relay when mail arrives (IMAP IDLE), checks come this often all the same. */
  idleCheckMinutes: 15,
  backoffMinutes: [5, 15, 30, 60],
  items: 10,
  excerptChars: 500,
  field: 200,
  maxMinutes: 1440,
  files: 2000,
  settleSeconds: 30,
};

/**
 * How the last time a schedule came due went: its message started a run (`sent`), waited in the queue
 * while the team replied (`queued`), was not sent because Harness Relay was not running then
 * (`missed`), was held back because the team could not take it (`skipped`: it waited for the user's
 * answer, had no confirmed team, or the previous scheduled message was still waiting), or could not
 * start (`failed`). `lastError` says why for the last two.
 */
/** `ran`: its fixed command ran and found nothing for the team (exit code 0), so no message went. */
/**
 * How a schedule's time went: its message sent, or queued for the team; missed, skipped, failed; its fixed
 * command ran and found nothing (`ran`); or, running only its command, found something it noted in the chat (`noted`).
 */
export type ScheduleResult = 'sent' | 'queued' | 'missed' | 'skipped' | 'failed' | 'ran' | 'noted';

/** Longest scheduled message, and the longest interval in hours; `maxGoal`: the longest goal a schedule tracks. */
export const SCHEDULE_LIMITS = { maxText: 4000, maxHours: 168, maxGoal: 2000 };

/** Where a tracked goal stands: still being worked on, reached, or held up by something only the user can settle. */
export type ProgressStatus = 'working' | 'done' | 'blocked';

export const PROGRESS_STATUSES: readonly ProgressStatus[] = ['working', 'done', 'blocked'];

/** What a reply said about a tracked goal (its `<progress>` block). */
export interface ProgressNote {
  at: number;
  status: ProgressStatus;
  text: string;
  /** The agent that wrote it. */
  agent?: string;
  /** The conversation it was written in, when that is not the schedule's own (`newChat`). */
  chatId?: string;
}

/**
 * The limits of tracking a goal: `notes` kept with the schedule (the oldest go first), `shown` given to
 * the agents in their briefing, `noteChars` of one note, `retryMinutes` between the tries of a time
 * whose run failed (one more try for each), and `eventBytes` of a webhook call's body in the message.
 */
export const TRACKING_LIMITS = {
  notes: 30,
  shown: 12,
  noteChars: 1000,
  retryMinutes: [5, 30, 120],
  eventBytes: 20_000,
  hookIntervalMs: 10_000,
};

/**
 * How a schedule that tracks a goal (`ConversationSchedule.goal`) is getting on: what the agents said
 * about it, the newest last, and the run it started that has not ended yet, which a restart of the
 * server tries again.
 */
export interface ScheduleTracking {
  status: ProgressStatus;
  notes: ProgressNote[];
  /** A run the schedule started that has not ended: the time it came due, its try (0 = the first), and where it runs. */
  inFlight?: { due: number; attempt: number; chatId: string };
  /** A time whose run failed, tried again at `at` (the schedule's `nextRunAt`): the time it came due, and which retry that is (1 = the first). */
  retry?: { due: number; attempt: number; at: number };
}

/** A schedule's webhook, as the UI sees it: never its token, which is shown once, nor the token's hash. */
export interface ScheduleHook {
  createdAt: number;
  /** When a program last called it. */
  lastAt?: number;
}

/** A webhook just made: its token (shown this once; only its hash is kept), the address to call, and the server's system (for the example). */
export interface NewScheduleHook {
  token: string;
  url: string;
  hook: ScheduleHook;
  platform: string;
}

/**
 * A conversation's schedule: a message the team is sent at set times, as if the user had sent it (it
 * is marked `scheduled`): in this conversation, or (`newChat`) in a new one each time. One per
 * conversation.
 */
export interface ConversationSchedule {
  text: string;
  /** Files sent with every run. Only their metadata goes to the browser. */
  attachments?: Extract<MessagePart, { type: 'attachment' }>[];
  repeat: ScheduleRepeat;
  /** IANA time zone the times are in (the browser's when it was saved). */
  timeZone: string;
  /** Language of the notes it writes in the chat (the UI's when it was saved). */
  lang: Lang;
  enabled: boolean;
  /**
   * In runs the schedule starts, what happens when an agent wants to do something its permission
   * does not cover: refused automatically (default), or asked in the chat like in any run.
   */
  approvals: 'deny' | 'ask';
  /** A time missed while Harness Relay was not running (or the computer slept): skipped, or run once as soon as it can. */
  missed: 'skip' | 'run';
  /**
   * Each time, open a new conversation with the same team, settings, "always allow" answers and sidebar
   * group, and send the message there, instead of in this one: every run starts with a clean context.
   */
  newChat: boolean;
  /** When its times (`repeat`, `timeZone`) were last set: where an interval's cadence starts. */
  updatedAt: number;
  /** When it sends next; absent while it is off, or when it will not send again. */
  nextRunAt?: number;
  /** The time it last came due. */
  lastRunAt?: number;
  lastResult?: ScheduleResult;
  /** Why it was skipped or failed last time. */
  lastError?: string;
  /** The conversation the last time opened (`newChat`), when it was sent. */
  lastChatId?: string;
  /**
   * What done means, in the user's words: the schedule then tracks this goal. Its runs are told where it
   * stands, the agents report on it (`<progress>`), a run that fails is tried again, and once an agent
   * says it is done the schedule switches off.
   */
  goal?: string;
  /** How the goal is getting on (only with a `goal`). */
  tracking?: ScheduleTracking;
  /** The schedule's webhook, when it has one: a program on this computer can send its message now. */
  hook?: ScheduleHook;
  /**
   * An automation that starts when something happens: what it keeps of each trigger's source between
   * checks, one for each trigger by its key (in the triggers' order; a trigger not checked yet has none).
   */
  watches?: ScheduleWatch[];
  /**
   * A fixed command of the conversation's working directory (its id) that Harness Relay runs first,
   * each time: the message goes to the team only when it found something new (`FIXED_COMMAND_NEWS`) or
   * failed, with its output; when it exits 0 nothing goes (`ran`), and no model runs.
   */
  command?: string;
  /**
   * With `command`: only it runs, never the team. What it found (`FIXED_COMMAND_NEWS`) or how it failed
   * goes into the chat as a note with its output, and nothing goes to the team: no model runs, nor does
   * the team's state (a question waiting for the user, a run under way) hold it. No goal is tracked.
   */
  commandOnly?: boolean;
}

/** A moment's wall-clock date and time in a time zone (`zonedParts()`). */
export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

/** What the browser sends to save a schedule (`PUT /api/conversations/:id/schedule`). */
export type ScheduleUpdate = Pick<
  ConversationSchedule,
  'text' | 'repeat' | 'timeZone' | 'enabled' | 'approvals' | 'missed' | 'newChat' | 'goal' | 'command' | 'commandOnly'
>;

/**
 * Where the team stopped because an agent asked the user something. Once the user replies, the
 * agents that asked answer first and the run goes on from here (`Orchestrator.execute`).
 */
export interface RunPause {
  /** The user directed this exchange to a single member. */
  followUp?: boolean;
  mode: Mode;
  /** The agents that asked, by id. */
  askers: string[];
  /**
   * Who was still to speak after them: the rest of the round (roundtable), or the relay queue with the
   * teammates the asking reply handed to (they speak once the one that asked has answered).
   */
  rest: { agentId: string; handedBy?: string }[];
  /** The run's participants by id: later rounds go on with them. */
  participants: string[];
  round: number;
  rounds: number;
  /** The run that asked was one a schedule that tracks a goal started: the answer's run goes on with the goal. */
  tracked?: TrackedRun;
}

export interface AgentSessionState {
  /** CLI-native session / thread id used to resume the agent's own context. */
  sessionId?: string;
  provider?: Provider;
  /** The account the session was made with (empty = the default account): another account starts a new one. */
  account?: string;
  /**
   * For Claude Code, Codex and Grok: the backend the session was made on, one of the user's endpoints
   * (its id), or the CLI's own service (absent): a turn on another one starts a fresh session.
   */
  backend?: string;
  /**
   * The permission of this member's latest run in the conversation (Harness Relay's own record).
   */
  permission?: Permission;
  /**
   * Per CLI the member ran on (each open agent keeps a state folder of its own for it): the permission
   * of that CLI's latest run, the open agent's home that run was in (`home`), and `mustEmpty` while its
   * state folder still has to be emptied before it runs again (set when the permission went up or the
   * home moved, cleared once the folder is empty). A turn with a higher permission than its CLI's
   * latest, or in another home, starts a fresh session.
   */
  byCli?: Partial<Record<Provider, { permission: Permission; home?: string; mustEmpty?: boolean }>>;
  /**
   * What this agent's session has heard: the ids of the chat messages it was shown, and keys of the rest
   * (`memory:<id>`, `notice:<id>`, `outbox:<id>`, `command-run:<commandId>:<at>`, `handoffs:<digest>`).
   */
  seen: string[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agents: AgentConfig[];
  settings: ConversationSettings;
  messages: ChatMessage[];
  agentState: Record<string, AgentSessionState>;
  /**
   * Parallel-mode worktrees by agent id: one per repository of the working directories. Under
   * `TEAM_WORKTREE`, the conversation's own, which all its members share (see there).
   */
  worktrees: Record<string, AgentWorktree[]>;
  /** "Always allow" answers given in this conversation. */
  allowRules?: AllowRule[];
  /**
   * The user's messages waiting to be delivered, oldest first: sent while the team replies, they are
   * posted before the next turn of an agent they are for (see `Orchestrator.send`).
   */
  queue?: ChatMessage[];
  /** An agent asked the user something and the team waits for the answer. */
  pause?: RunPause;
  /** A message the team is sent at set times. */
  schedule?: ConversationSchedule;
  /** It was branched from another conversation (see `ConversationBranch`). */
  branch?: ConversationBranch;
}

/**
 * Where a branched conversation comes from: "Branch conversation" under an agent's reply copies the
 * conversation up to and including that reply into a new one, which goes on from there on its own.
 * It is a branch of the conversation that reply was written in: from a reply that a branch had copied
 * (up to its branch point), it is a branch of the conversation the reply was copied from, or of one
 * further up (`earlier`), as if it had been branched there.
 */
export interface ConversationBranch extends BranchPart {
  /** A new topic keeps its source for context but starts a separate sidebar family. */
  independent?: true;
  /** For copied isolated changes, their git branch and the conversation whose worktree holds it. */
  worktreeSources?: Record<string, string>;
  /**
   * The copied messages before the part `fromId` wrote, when they were written further up: each part
   * with the conversation it was written in and its last message here (`afterId`), nearest first.
   * Branching from one of them makes a branch of the conversation that wrote it.
   */
  earlier?: BranchPart[];
}

export type ConversationBranchKind = 'child' | 'topic';

/** The exact reply shown before copying history. Its id is also required when creating the copy. */
export interface BranchPoint {
  id: string;
  createdAt: number;
  excerpt: string;
}

/** Copied messages of a branch, up to `afterId`, and the conversation they were written in. */
export interface BranchPart {
  /** The conversation they were written in (it may have been deleted since). */
  fromId: string;
  /** That conversation's title when they were copied (shown once it has been deleted). */
  fromTitle: string;
  /** The last of them, by its id here: the messages after it come from further down, or were written here. */
  afterId: string;
  /**
   * Once the conversation they were written in is deleted: where that one had been branched from, and
   * so on while those are deleted too, nearest first, each with its title when it was deleted (or
   * when it was branched from). The last one may still exist. It keeps a family together in the
   * sidebar when a conversation in the middle of it is deleted.
   */
  via?: { id: string; title: string }[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agents: Pick<AgentConfig, 'name' | 'provider'>[];
  running: boolean;
  /** An agent is waiting for the user to approve something. */
  waiting?: boolean;
  /** The lead agent's team design waits for the user to confirm it (auto team). */
  confirmTeam?: boolean;
  /** An agent asked the user something and the team waits for the answer. */
  asking?: boolean;
  /**
   * The latest agent reply says its tracked goal is held up (`<progress status="blocked">`): it needs the
   * user until a later reply (to the user's answer, or the automation's next run) says otherwise.
   */
  blocked?: boolean;
  /** How the latest agent reply ended (absent before the first one). */
  lastStatus?: MessageStatus;
  /**
   * The latest agent reply's id: another one since the last look means the team replied, also in a
   * run shorter than the time between two looks (the alerts, `src/shared/notify.ts`).
   */
  lastReplyId?: string;
  /**
   * The sidebar group it is in; absent = the default group, "Other". A family of branched
   * conversations is in one group: its oldest conversation's (see `src/shared/family.ts`).
   */
  groupId?: string;
  /**
   * When the user pinned it (absent: not pinned). The sidebar lists the pinned conversations above
   * the groups, the one pinned last first; each stays in its group too.
   */
  pinnedAt?: number;
  /** The lead agent is sorting it into one of the user's groups (by its first message). */
  sorting?: boolean;
  /**
   * It was branched from another conversation: that one's id, its title when it was branched (shown
   * once it has been deleted), and where that one came from once deleted (`ConversationBranch.via`).
   * The sidebar shows it under that conversation unless it starts an independent topic.
   */
  branchFrom?: { id: string; title: string; independent?: true; via?: ConversationBranch['via'] };
  /**
   * It has a schedule: whether it is on, when it sends next, how the last time went, the time zone its
   * times are shown in (a daily or weekly schedule's own; absent: the browser's), and whether it has
   * no set times.
   */
  schedule?: Pick<ConversationSchedule, 'enabled' | 'nextRunAt' | 'lastResult'> & {
    timeZone?: string;
    /** No set times: only Run once now and the webhook send it (`ScheduleRepeat` `manual`). */
    manual?: boolean;
    /** It starts when something happens: what it waits for (`ScheduleRepeat` `event`), any of them. */
    triggers?: ScheduleTrigger[];
    /** The last check of something it waits for failed. */
    watchError?: boolean;
  };
}

/**
 * A group of conversations in the sidebar, made by the user. Conversations in no group are in the
 * default group, "Other", which always exists and is not stored.
 */
export interface ConversationGroup {
  id: string;
  name: string;
}

/** The longest group name, and the most groups there can be. */
export const GROUP_LIMITS = { maxName: 40, maxGroups: 50 };

/** A conversation that matches a search (`GET /api/search`). */
export interface SearchResult {
  id: string;
  title: string;
  updatedAt: number;
  groupId?: string;
  /** The text around the first match in its messages; absent when only the title matched. */
  snippet?: string;
  /** How many of its messages match. */
  matches: number;
  /** It was branched from another conversation: that one's title (as it was then, once deleted). */
  branchFrom?: string;
}

/** Events pushed to the browser over SSE for one conversation. */
export type ServerEvent =
  /**
   * `commandRunning`: a fixed command's run whose cards this conversation follows holds its folder (the
   * chat's Stop stops it). `folderHeld`: a fixed or interactive command holds its folder and no run goes,
   * so nothing can be sent there until it ends (the composer says so, and sends nothing).
   */
  | {
      type: 'snapshot';
      conversation: Conversation;
      running: boolean;
      activeAgentIds: string[];
      commandRunning?: boolean;
      folderHeld?: boolean;
    }
  | { type: 'message'; message: ChatMessage }
  | { type: 'delta'; messageId: string; partIndex: number; text: string }
  | { type: 'status'; running: boolean; activeAgentIds: string[]; commandRunning?: boolean; folderHeld?: boolean }
  | { type: 'queue'; queue: ChatMessage[] }
  | {
      type: 'conversation';
      title: string;
      agents: AgentConfig[];
      settings: ConversationSettings;
      worktrees: Record<string, AgentWorktree[]>;
      pause?: RunPause;
      schedule?: ConversationSchedule;
    };

// ---------------------------------------------------------------------------
// Provider settings, health and login

export interface ProviderAuth {
  /** null = could not determine. */
  loggedIn: boolean | null;
  method?: string;
  account?: string;
  detail?: string;
}

export interface ProviderStatus {
  provider: Provider;
  /** Found, and new enough to be started: a CLI that is too old (`tooOld`) is not, as one that is missing. */
  installed: boolean;
  bin: string;
  version?: string;
  /**
   * Found, but older than Harness Relay supports (`MIN_VERSIONS` in src/shared/cliVersions.ts): the
   * oldest version it needs. Nothing else is asked of it, and no agent runs on it until it is updated.
   */
  tooOld?: string;
  /** The default account's sign-in (also `accounts[0]`). */
  auth: ProviderAuth;
  /** An API key is stored in Harness Relay for the default account and injected into this CLI's environment. */
  usingStoredApiKey: boolean;
  /** Every account of this CLI, the default account first: each one signs in on its own. */
  accounts: AccountStatus[];
  /**
   * When the server began this check (ms since the epoch, later for each check even if the clock is
   * set back); an answer from its cache keeps the time of the check it came from. The chat shows, for
   * each CLI, the status checked last (`newerStatuses()`).
   */
  checkedAt?: number;
}

/** One account of a CLI and its sign-in. */
export interface AccountStatus {
  /** Empty for the default account. */
  id: string;
  /** The name the user gave it; empty = none (the UI then calls the default account "Default"). */
  label: string;
  auth: ProviderAuth;
  usingStoredApiKey: boolean;
}

/** Whether agents can run as this account: signed in (or it could not be told), or with an API key. */
export function accountUsable(a: Pick<AccountStatus, 'auth' | 'usingStoredApiKey'>): boolean {
  return a.auth.loggedIn !== false || a.usingStoredApiKey;
}

// --- Installing a CLI from Settings (src/server/cliInstall.ts) ---------------------------------

/**
 * How Harness Relay installs a CLI, always into a folder of its own in the data folder: with npm
 * (`npm install -g --prefix`), with its maker's installer script (run with that folder as its home), or
 * with uv (`uv tool install`, its tools and Python in that folder).
 */
export type CliInstallMethod = 'npm' | 'script' | 'uv';

/**
 * Why Harness Relay cannot install a CLI here: a program its install needs is not found (npm, which
 * comes with Node.js, where Node.js's own build cannot go into the folder instead (an open agent's
 * install, or no build of it for this computer); curl, and bash or on Windows Git for Windows' bash
 * (`gitBash`) or Windows PowerShell, for a maker's script, uv's own installer included; curl and tar
 * for Node.js's build), or Harness Relay runs no installer of it on this system (`system`: neither
 * macOS, Linux nor Windows).
 */
export type CliInstallBlock = 'npm' | 'curl' | 'tar' | 'bash' | 'gitBash' | 'powershell' | 'system';

/** An install under way or done: what its installer printed (the end of it), and how it ended. */
export interface CliInstallJobView {
  state: LoginState;
  startedAt: number;
  finishedAt?: number;
  /** How much of a download is done, in bytes, of how much in all (when known). */
  progress?: { done: number; total?: number };
  /** The installer's output, its last lines (colours and progress bars taken out). */
  log: string;
  error?: string;
}

/** How Harness Relay can install one CLI on this computer, and what it installed of it. */
export interface CliInstallView {
  provider: Provider;
  method: CliInstallMethod;
  /** What the install runs, as one would type it (`npm install -g @openai/codex`); it goes into `dir`. */
  command: string;
  /** Why it cannot be installed here; absent when it can. */
  blocked?: CliInstallBlock;
  /** npm is not on the PATH: the version of Node.js whose build its install puts into `dir` first, for its npm. */
  node?: string;
  /** The folder of its own it is installed in (removing it deletes this folder). */
  dir: string;
  /**
   * Installed by Harness Relay: its program, its version, when, and whether the CLI's executable path
   * is that program (an install sets it so; the user may set another one since).
   */
  installed?: { bin: string; version?: string; at: number; inUse: boolean };
  /** The latest install since the server started, while it runs and after it ended. */
  job?: CliInstallJobView;
}

/**
 * What the agents' OS sandboxes need that this computer lacks (Settings → Sandboxes, and the dialog New
 * chat opens while something is missing; `src/server/sandboxSetup.ts`):
 * - `packages`: the Linux packages the sandboxes run (bubblewrap, socat, ripgrep; slirp4netns,
 *   iproute2, iptables and util-linux for Copilot's), installed with the system's package manager;
 * - `apparmor`: on Ubuntu 23.10 or later, which keeps programs from making user namespaces, the
 *   AppArmor profile that lets `/usr/bin/bwrap` make them;
 * - `node`: in the desktop app, a Node.js for Harness Relay's own sandbox (the open agents'), which
 *   finds none on the PATH: Node.js's own build in Harness Relay's data folder.
 */
export type SandboxNeedKind = 'packages' | 'apparmor' | 'node';

/**
 * Why Harness Relay cannot install a need here: no way to get administrator rights (`admin`: not root,
 * no sudo without a password, no desktop session for pkexec's prompt), no package manager it knows
 * (`packageManager`: apt, dnf, pacman, zypper), or what Node.js's build takes (curl, tar, a build for
 * this computer: `node`; on Linux the libatomic it runs with: `libatomic`).
 */
export type SandboxSetupBlock = 'admin' | 'packageManager' | 'curl' | 'tar' | 'node' | 'libatomic';

/** Who a need is for: a CLI's sandbox, or Harness Relay's own (`open`, the open agents'). */
export type SandboxUser = Provider | 'open';

export interface SandboxNeedView {
  kind: SandboxNeedKind;
  /** `packages`: the packages; `apparmor`: the profile's file; `node`: Node.js's version. */
  items: string[];
  /** Whose sandboxes need it. */
  for: SandboxUser[];
  /** What installing it runs, as one would type it in a terminal (to do it by hand). */
  command: string;
  /** Why Harness Relay cannot install it here; absent when it can. */
  blocked?: SandboxSetupBlock;
}

export interface SandboxSetupView {
  /** The server's system (`process.platform`): on Windows nothing is ever missing, as nothing Harness Relay installs helps there. */
  platform: string;
  /** What is missing; empty when the sandboxes have everything they need here (always on Windows). */
  needs: SandboxNeedView[];
  /** How an install gets administrator rights for `packages` and `apparmor`: as root, sudo without a password, or pkexec (the desktop's password prompt). */
  admin?: 'root' | 'sudo' | 'pkexec';
  /** The latest install since the server started, while it runs and after it ended. */
  job?: CliInstallJobView;
  /** While it runs: whether it can be stopped (not once the system's package manager runs as administrator). */
  cancellable?: boolean;
}

/** How long one of a plan's limits runs before it starts over, when it is one of the usual spans. */
export type UsageSpan = 'fiveHour' | 'day' | 'week' | 'month';

/** What one of a plan's limits counts, when the UI names it: Copilot's premium requests, chat messages and code completions. */
export type UsageKind = 'premiumRequests' | 'chat' | 'completions';

/** One limit of an account's plan, as its CLI reports it: how much of it is used, and when it starts over. */
export interface UsageLimit {
  span?: UsageSpan;
  /** Its length in minutes, when the CLI says and it is none of the usual spans. */
  minutes?: number;
  /** What it counts, when that is one of the kinds the UI names (Copilot's premium requests, chat, completions). */
  kind?: UsageKind;
  /** What it is for, when not the whole plan: a model ("Fable"), or the CLI's own name for the limit. */
  scope?: string;
  /** A model ID associated with the quota, when the CLI reports one separately from the display scope. */
  model?: string;
  /** How much of it is used, 0–100. */
  usedPercent: number;
  /** When it starts over (ms since the epoch). */
  resetsAt?: number;
  /** A limit of a number of requests (Copilot's premium requests): how many are used, of how many. */
  used?: number;
  total?: number;
  /**
   * Once it is used up, the account's `payer` pays for what goes past it, so it does not stop the CLI:
   * set only for the limits that payer covers as the CLI reports it (Codex's credits pay past the plan's
   * own limit, not a model's), and only while the account has one (`AccountUsage.payer`).
   */
  paidPast?: true;
}

/**
 * What a CLI keeps running on, billed by use, once its plan's included usage is used up: purchased
 * credits (Codex's, Grok's prepaid credits), Claude Code's usage credits (extra usage), Copilot's
 * additional paid usage, Grok's pay-as-you-go.
 */
export type UsagePayer = 'credits' | 'usageCredits' | 'additionalUsage' | 'payAsYouGo';

/**
 * Why an account has no plan limits to show: it runs on an API key the provider bills by use (no
 * limits, and no balance the key can read), it is signed out, its plan has no allowance, its plan has
 * no limits at all, its CLI has no usage yet in this window, its CLI reports no plan limits for how
 * the account signs in (Claude Code on a token from `claude setup-token`, Bedrock or Vertex), or its
 * CLI does not report usage (not at all, or not outside its own terminal UI).
 */
export type UsageNone = 'apiKey' | 'signedOut' | 'noAllowance' | 'unlimited' | 'noData' | 'unavailable' | 'notReported';

/**
 * Why Harness Relay could not tell an account's usage, in its own words (the UI words it in its
 * language): the CLI took too long, gave no answer it could read, or was not found.
 */
export type UsageProblem = 'timedOut' | 'noAnswer' | 'cliMissing' | 'cliTooOld';

/** How much of an account's plan is used, as its CLI reports it (`GET /api/providers/:provider/usage`). */
export interface AccountUsage {
  provider: Provider;
  /** Empty for the default account. */
  account: string;
  /** The plan, as the CLI names it ("max", "prolite", "SuperGrok"). */
  plan?: string;
  limits: UsageLimit[];
  /** The CLI explicitly says ordinary usage on this plan is blocked (its included usage; `payer` may still pay past it). */
  planUsageBlocked?: boolean;
  /** Credits beside the plan's limits (Codex's), when the account has some: for display. */
  credits?: { balance?: number; unlimited?: boolean };
  /**
   * What pays once the plan's included usage is used up, when the CLI keeps running then: past the limits
   * marked `paidPast` and past `planUsageBlocked`. Set only while it can pay now (credits left or
   * unlimited, extra usage turned on and below its spend limits, additional usage allowed); unset, a
   * limit used up stops the CLI until it resets.
   */
  payer?: UsagePayer;
  /** No limits to show, and why. */
  none?: UsageNone;
  /** The CLI could not be asked, or refused: in its own words. */
  error?: string;
  /** The CLI could not be asked, or did not answer, in Harness Relay's words (`UsageProblem`). */
  problem?: UsageProblem;
  /** When the CLI was asked (ms since the epoch). */
  checkedAt: number;
}

/**
 * Whether an account signs in with its API key only: every Antigravity account, the default one too,
 * and Cursor's and Muse Code's accounts besides the default one. Antigravity runs on a Gemini API key
 * alone: Google's terms for it do not allow a third-party app to run it on a Google sign-in (a Google AI
 * plan), so Harness Relay neither signs agy in with Google nor runs it on the sign-in agy keeps. Cursor
 * keeps one sign-in per computer user (on macOS, in the keychain) whatever its config folder, and Muse
 * Code its Meta sign-in in the login keychain on macOS, under names their folders do not change, so
 * another account's sign-in could replace the default one's.
 */
export function keyOnlyAccount(p: Provider, account: string | undefined): boolean {
  return p === 'antigravity' || ((p === 'cursor' || p === 'muse') && Boolean(account));
}

/**
 * Accounts per CLI, the default one included, unless `RELAY_MAX_ACCOUNTS` says otherwise
 * (`src/server/config.ts`; the UI gets the server's from `GET /api/limits`). Each account other than
 * the default has a folder of its own for the CLI (its sign-in, settings and sessions) and may have an
 * API key of its own.
 */
export const DEFAULT_MAX_ACCOUNTS = 10;
/** Each agent turn's safety timeout in minutes (1 day), unless `RELAY_TURN_TIMEOUT_MIN` says otherwise. */
export const DEFAULT_TURN_TIMEOUT_MIN = 24 * 60;

/** `GET /api/limits`: what the server's environment sets that the UI keeps to or shows. */
export interface ServerLimits {
  /** Accounts per CLI, the default one included. */
  maxAccounts: number;
  /** Most members a team may have. */
  maxTeamAgents: number;
  /** Each agent turn's safety timeout, in minutes (a turn waiting for the user's answer included). */
  turnTimeoutMinutes: number;
}

/** The limits when the environment sets none; the UI shows these until the server's arrive. */
export const DEFAULT_LIMITS: ServerLimits = {
  maxAccounts: DEFAULT_MAX_ACCOUNTS,
  maxTeamAgents: DEFAULT_MAX_TEAM_AGENTS,
  turnTimeoutMinutes: DEFAULT_TURN_TIMEOUT_MIN,
};
/** Longest name of an account. */
export const MAX_ACCOUNT_LABEL = 40;
/** Account ids: made by the server (8 hex digits); `default` names the default account in URLs. */
export const ACCOUNT_ID_RE = /^[a-z0-9]{1,32}$/;
export const DEFAULT_ACCOUNT = 'default';

/**
 * What the server says about itself (`GET /api/about`), for a problem report: no paths, no names.
 * `version`: the release (or dev build) the desktop app was built as, else `source (<commit>)`.
 */
export interface AboutInfo {
  version: string;
  /** Started by the desktop app, not `npm start`. */
  desktop: boolean;
  /** "darwin 25.6.0 (arm64)". */
  os: string;
  /** "v24.1.0". */
  node: string;
}

/** A problem report's screenshots: at most this many, each this large (`POST /api/report/screenshots`). */
export const REPORT_SCREENSHOT_LIMITS = { maxFiles: 5, maxBytes: 10 * 1024 * 1024 };

/**
 * The kinds of image a report's screenshot may be: the usual ones for screenshots and photos (the server
 * goes by its bytes, not by what it says it is). Not GIF, nor a JPEG saved as .jfif.
 */
export const REPORT_SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** The file name endings a report's screenshot may have, for the file picker (a pasted image has none). */
export const REPORT_SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/** A problem report's screenshots, uploaded: their secret gist, and its page on GitHub (which shows them). */
export interface ReportScreenshots {
  id: string;
  url: string;
}

/**
 * Where Harness Relay keeps API keys: the operating system's credential store (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service) or, when there is none, its database, encrypted
 * with a key in a file of its own (`encrypted`). `database`: as they are, only where one could not be
 * moved out of it.
 */
export type KeyStorage = 'keychain' | 'credential-manager' | 'secret-service' | 'encrypted' | 'database';

export interface ProviderSettingsView {
  provider: Provider;
  /** Custom executable path; empty = use PATH. */
  bin: string;
  /** Masked API key, e.g. "sk-…a1b2", or empty when none is stored. */
  apiKeyMasked: string;
  /** Where this provider's key is (or would be) stored; absent for Codex, which keeps its own. */
  apiKeyStorage?: KeyStorage;
  /**
   * Every account of this CLI, the default account first (its key is `apiKeyMasked` above too). Each
   * has its own defaults and its own choice of what Harness Relay's runs leave out.
   */
  accounts: ProviderAccountView[];
  /**
   * The user lets this CLI's commands use a terminal (a pseudo-terminal) inside the relay sandbox, where
   * on macOS they can then print into and read from the user's other terminal windows (typing into them
   * stays blocked). Without it, a CLI that needs one does not run below full access there. Only for
   * `SANDBOX_TERMINAL_SUPPORT`; false for the others.
   */
  sandboxTerminal: boolean;
  /** Which variables of the server's environment this CLI's runs sign in with or are not given; absent for an open agent. */
  environment?: ProviderEnvView;
}

/**
 * Settings → a CLI's card → Environment variables: names only, never a value. The server copies the
 * environment it was started with into each CLI it starts, but another model provider's keys
 * (`MODEL_KEY_VARS` in `src/server/agentEnv.ts`) only to the CLI they belong to, or to a CLI the user
 * passes them on to.
 */
export interface ProviderEnvView {
  /**
   * The variable of the server's environment the CLI's default account signs in with, ahead of the
   * sign-in kept in its home: the first one set in the order the CLI reads them (Claude Code's cloud
   * providers, then `ANTHROPIC_AUTH_TOKEN`…); absent when there is none, or when an API key saved in
   * Settings comes first.
   */
  signIn?: string;
  /** Other model providers' keys set in the server's environment that this CLI's runs are not given. */
  withheld: string[];
  /** The names the user passes on to this CLI's runs all the same (whether or not they are set now). */
  pass: string[];
}

/**
 * How Harness Relay runs a CLI as one of its accounts. Each account has a home of its own, with its
 * own settings, skills, MCP servers, hooks and memory, so each one has its own of these too.
 */
export interface AccountRunSettings {
  /** Model used when an agent of this account does not specify one; empty = the CLI's own default. */
  defaultModel: string;
  /** Reasoning effort used when an agent of this account does not specify one; empty = the CLI's own. */
  defaultEffort: string;
  /** What the CLI loads by itself in this account's home that Harness Relay's runs leave out, all of a kind (see NATIVE_OFF_SUPPORT). */
  nativeOff: NativePart[];
  /** Single items Harness Relay's runs leave out (see NATIVE_ITEM_SUPPORT). */
  nativeItems: NativeItemsOff;
  /** What Harness Relay's runs turn on that they otherwise leave off (see NATIVE_ON_SUPPORT). */
  nativeOn: NativeOnPart[];
}

/** One account of a CLI as Settings shows it. */
export interface ProviderAccountView extends AccountRunSettings {
  /** Empty for the default account. */
  id: string;
  /** The name the user gave it; empty = none. */
  label: string;
  /** Masked API key of this account, or empty when none is stored. */
  apiKeyMasked: string;
  /** Where its key is (or would be) stored; absent for Codex, which keeps its own. */
  apiKeyStorage?: KeyStorage;
  /** The folder the CLI keeps this account's sign-in, settings and sessions in; absent = the CLI's usual home. */
  home?: string;
}

/** `PUT /api/settings/providers/:provider/accounts/:account`: only the fields given change. */
export interface ProviderAccountUpdate {
  label?: string;
  /** string = set / replace, null = remove (Codex: signs the account in with it, and keeps nothing). */
  apiKey?: string | null;
  defaultModel?: string;
  defaultEffort?: string;
  /** The whole list, replacing the current one; parts the CLI cannot leave out are dropped. */
  nativeOff?: NativePart[];
  /** All the single items, replacing the current ones; kinds the CLI cannot leave out are dropped. */
  nativeItems?: NativeItemsOff;
  /** The whole list, replacing the current one; parts the CLI cannot turn on are dropped. */
  nativeOn?: NativeOnPart[];
}

/**
 * The CLIs whose runs need a terminal in the relay sandbox (OpenHands: it runs every command in one),
 * which the user must allow (`ProviderSettingsView.sandboxTerminal`) for them to run below full access
 * on macOS. On Linux the sandbox has terminals of its own (a private `/dev/pts`), so no switch is needed.
 */
export const SANDBOX_TERMINAL_SUPPORT: readonly Provider[] = ['openhands'];

export interface ModelOption {
  id: string;
  label?: string;
  /** An alias that always points at the newest model of its family (the UI says so). */
  latest?: boolean;
  /** Effort levels this model supports; undefined = use the provider-wide list. */
  efforts?: string[];
  defaultEffort?: string;
  /**
   * The id of the user's own endpoint this model is on, for Claude Code, Codex and Grok (a model of
   * Settings → Model connections): it runs only an effort of `efforts`, and another one it would inherit
   * becomes `defaultEffort`, or none (`endpointEffort`).
   */
  endpoint?: string;
}

/**
 * Models and reasoning-effort levels a provider offers, as discovered from its CLI in one account's
 * home (`GET /api/models` lists every account of every CLI, each CLI's default account first).
 */
export interface ProviderModels {
  provider: Provider;
  /** The account asked (its home holds the CLI's own config); absent or empty = the default account. */
  account?: string;
  models: ModelOption[];
  efforts: string[];
  /** The CLI's own defaults (from its config or catalog in the account's home). */
  cliDefaultModel?: string;
  cliDefaultEffort?: string;
  /** What actually runs when an agent leaves the field on "default": the account's Relay setting first, then the CLI default. */
  defaultModel?: string;
  defaultEffort?: string;
  source: 'cli' | 'builtin';
  error?: string;
}

/**
 * The models of a CLI as one of its accounts runs it: that account's entry, else (an account removed
 * since, or not listed yet) the default account's, else the CLI's first.
 */
export function catalogFor(catalog: readonly ProviderModels[], provider: Provider, account?: string): ProviderModels | undefined {
  const mine = catalog.filter((c) => c.provider === provider);
  return mine.find((c) => (c.account ?? '') === (account ?? '')) ?? mine.find((c) => !c.account) ?? mine[0];
}

/** Effort levels valid for a model (falls back to the provider-wide list). */
export function effortsFor(pm: Pick<ProviderModels, 'models' | 'efforts'>, model?: string): string[] {
  return pm.models.find((m) => m.id === model)?.efforts ?? pm.efforts;
}

/** The effort that runs when an agent leaves effort on default, for the model it will use. */
export function inheritedEffort(pm: ProviderModels, model?: string): string | undefined {
  const m = pm.models.find((x) => x.id === (model || pm.defaultModel));
  // On an endpoint, an effort its models do not offer is not sent as it is (`endpointEffort`).
  if (m?.endpoint) return pm.defaultEffort && !m.efforts?.includes(pm.defaultEffort) ? m.defaultEffort : pm.defaultEffort;
  return pm.defaultEffort ?? m?.defaultEffort;
}

export interface SettingsView {
  providers: ProviderSettingsView[];
  defaultCwd: string;
  /** The default's other working directories, after `defaultCwd` (empty: none). */
  defaultExtraCwds: string[];
  /** Designs the team in auto-team conversations. */
  lead: LeadAgentSettings;
  /**
   * The folder the CLIs keep their own sign-in, settings and sessions in when Harness Relay runs
   * them (a subfolder per CLI: `claude`, `codex`, `grok`); empty = each CLI's usual home.
   */
  agentHome: string;
  /** AgentsView (a local viewer of agent sessions) that each conversation is sent to as one thread; empty = off. */
  agentsViewUrl: string;
  /**
   * Where "Open AgentsView" goes, when not to `agentsViewUrl`: an address other devices can open,
   * such as the one `tailscale serve` gives it. Conversations are still sent to `agentsViewUrl`.
   */
  agentsViewLink: string;
  /** Why the last update of AgentsView failed; absent after a success. */
  agentsViewError?: string;
  /** The lead agent names each new conversation after its first message, in a few words (on unless turned off). */
  chatTitles: boolean;
  /**
   * The team checks a new chat or automation starts with (Settings → Tool library), there to change or
   * remove; absent: none. Chats and automations made before keep their own.
   */
  checksDefault?: CheckList;
}

/** `PUT /api/settings`: only the fields given change. */
export interface SettingsUpdate {
  defaultCwd?: string;
  /** The default's other working directories; given with `defaultCwd` (absent then: none). */
  defaultExtraCwds?: string[];
  /** Create `defaultCwd` and `defaultExtraCwds` when they do not exist. */
  createCwd?: boolean;
  lead?: LeadAgentSettings;
  /** Whether the lead agent names new conversations (`SettingsView.chatTitles`). */
  chatTitles?: boolean;
  /** Empty = the CLIs use their usual homes again. */
  agentHome?: string;
  /** Empty = off. */
  agentsViewUrl?: string;
  /** Empty = the link opens `agentsViewUrl`. */
  agentsViewLink?: string;
  /** The team checks new chats and automations start with; `null` or a list without rules: none. */
  checksDefault?: CheckList | null;
}

/** Suggested folder for the CLIs' own homes. */
export const SUGGESTED_AGENT_HOME = '~/.relay-agents';
/** AgentsView's default address (`agentsview serve`). */
export const AGENTSVIEW_DEFAULT_URL = 'http://127.0.0.1:8080';

/**
 * `PUT /api/settings/providers/:provider`: what a CLI has once for all its accounts. Each account's
 * defaults and what its runs leave out go to its own route (`ProviderAccountUpdate`).
 */
export interface ProviderSettingsUpdate {
  bin?: string;
  /** The default account's key: string = set / replace, null = remove. */
  apiKey?: string | null;
  /** Ignored for a CLI not in `SANDBOX_TERMINAL_SUPPORT`. */
  sandboxTerminal?: boolean;
  /**
   * The whole list of variables passed on to this CLI's runs although they are another provider's keys
   * (`ProviderEnvView.pass`), replacing the current one; refused for an open agent.
   */
  passEnv?: string[];
}

// --- Model backends: what the open agents run their models on --------------------------------

/**
 * The model APIs the open agents reach with an API key kept in Settings (Settings → Model connections).
 * The Claude subscription and Grok's sign-in cannot be used by these CLIs.
 */
export const API_BACKENDS = ['openai', 'anthropic', 'xai'] as const;
export type ApiBackend = (typeof API_BACKENDS)[number];
export const API_BACKEND_LABEL: Record<ApiBackend, string> = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI' };

export function isApiBackend(id: string): id is ApiBackend {
  return (API_BACKENDS as readonly string[]).includes(id);
}

/**
 * A custom endpoint's id: a lowercase slug that starts its models' ids (`homelab/<model>`), which
 * stays when the endpoint is renamed. Never one of API_BACKENDS.
 */
export const ENDPOINT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Most endpoints, models per endpoint, and characters of a model id, a name and a base URL. */
export const BACKEND_LIMITS = { maxEndpoints: 20, maxModels: 100, maxModelId: 200, maxName: 60, maxUrl: 500 };

/** One of API_BACKENDS as the UI sees it (its key masked). */
export interface ApiBackendView {
  id: ApiBackend;
  /** Masked API key; empty = not set up. */
  keyMasked: string;
  /** Where its key is (or would be) kept. */
  keyStorage: KeyStorage;
  /** A key may be stored, but the credential store could not be read at startup (locked, say). */
  keyUnreadable?: boolean;
}

/** The user's own OpenAI-compatible server (vLLM, Ollama, LM Studio, llama.cpp…). */
export interface ModelEndpointView {
  id: string;
  name: string;
  /** Its OpenAI-compatible base URL, such as `http://10.0.0.5:8000/v1`. */
  baseUrl: string;
  /** The model IDs the user selected from its catalog or entered in Settings. */
  models: string[];
  /** Masked API key; empty = none (many local servers take none). */
  keyMasked: string;
  keyStorage: KeyStorage;
  keyUnreadable?: boolean;
  /** Its models' context windows and output limits, by model id: only the models that have one. */
  limits?: Record<string, ModelLimits>;
}

export interface ModelBackendsView {
  apis: ApiBackendView[];
  endpoints: ModelEndpointView[];
  /**
   * The ids of endpoints deleted (and not added again): a Claude Code, Codex or Grok model `<id>/…`
   * fails instead of going to the CLI's own service, until the id is forgotten
   * (`DELETE /api/backends/deleted-endpoints/:id`).
   */
  deletedEndpoints: string[];
}

export const ENDPOINT_METADATA_UNAVAILABLE = 'endpoint-metadata-unavailable';

/** `PUT /api/backends/endpoints/:id`: the endpoint as it should be. */
export interface ModelEndpointUpdate {
  /** Verify model metadata before saving this endpoint. The Settings form requests this on every save. */
  verifyModels?: boolean;
  /** The user accepted a save when neither metadata route was available. Verification still runs. */
  allowMissingMetadata?: boolean;
  name: string;
  baseUrl: string;
  models: string[];
  /** string = set / replace, null = remove, absent = keep. */
  apiKey?: string | null;
  /**
   * The context windows and output limits the user set, by model id (models it lists only); the
   * server's own figures are kept apart (`ModelLimits.reported`). Absent: those set before are kept.
   */
  limits?: Record<string, TokenLimits>;
}

/**
 * An endpoint model's token limits: its context window (the most tokens one request may hold, its
 * answer's included) and the most tokens one answer may have (`docs/open-agents.md`, "Context windows").
 */
export interface TokenLimits {
  context?: number;
  output?: number;
}

/**
 * One endpoint model's limits as kept (`model_backends.model_limits`, JSON by model id): what the user
 * set in Settings (`context`, `output`), which wins, and what the server reported the last time the
 * endpoint was saved with a check of its models (`reported`: vLLM's `max_model_len`, llama.cpp's
 * `meta.n_ctx`).
 */
export interface ModelLimits extends TokenLimits {
  reported?: TokenLimits;
}

/** An open agent's model id, `<backend>/<model>`, taken apart. */
export interface BackendModel {
  /** One of API_BACKENDS, or an endpoint's id. */
  backend: string;
  /** The model's own name (it may hold `/` too: `homelab/Qwen/Qwen3-30B-A3B`). */
  model: string;
}

/**
 * Reads an open agent's model id: `openai/gpt-5.4-nano`, `anthropic/claude-haiku-5-5`, `xai/grok-4.3`,
 * `homelab/muse-glimmer-30b-nvfp4`. The backend is everything before the first `/`. Undefined when it
 * is not one (no `/`, nothing on either side, or a backend that is not a valid id).
 */
export function parseBackendModel(id: string): BackendModel | undefined {
  const text = id.trim();
  const at = text.indexOf('/');
  if (at <= 0 || at === text.length - 1) return undefined;
  const backend = text.slice(0, at);
  if (!isApiBackend(backend) && !ENDPOINT_ID_RE.test(backend)) return undefined;
  return { backend, model: text.slice(at + 1) };
}

/**
 * The CLIs RLM mode's sub-model can be asked through (Settings → Labs), as one of their accounts, with
 * their plan rather than a model connection's key: those whose runs Harness Relay can give no tool at all
 * (`RunOptions.toolless`), seen in the requests they send their model (Claude Code 2.1.330, Copilot
 * 1.0.112, Muse Code 1.4.23). Codex keeps `apply_patch` whatever its settings, Grok signed in may run the
 * agent that would remove its tools as its default one, and Antigravity and Cursor have no switch for
 * their tools (docs/architecture.md, "Code that calls the tools").
 */
export const SUB_MODEL_CLIS = ['claude', 'copilot', 'muse'] as const satisfies readonly Provider[];
export type SubModelCli = (typeof SUB_MODEL_CLIS)[number];
export const isSubModelCli = (p: string): p is SubModelCli => (SUB_MODEL_CLIS as readonly string[]).includes(p);

/** RLM's sub-model through a CLI: `cli:<provider>[:<account>][/<model>]`. */
export interface CliSubModel {
  provider: SubModelCli;
  /** One of its accounts besides the default one; empty: the default account. */
  account: string;
  /** The model, as the CLI names it; absent: the account's default model, else the CLI's own. */
  model?: string;
}

const CLI_SUB_MODEL_RE = /^cli:([a-z]+)(?::([a-z0-9]{1,32}))?(?:\/(.+))?$/;

/**
 * Reads RLM's sub-model through a CLI: `cli:claude/haiku`, `cli:copilot:work`, `cli:muse/muse-spark-1.3`.
 * Undefined when it is not one (a model connection's `<backend>/<model>` among them: an endpoint's id
 * has no `:`), or its CLI is not one of `SUB_MODEL_CLIS`.
 */
export function parseCliSubModel(id: string): CliSubModel | undefined {
  const m = CLI_SUB_MODEL_RE.exec(id.trim());
  if (!m || !isSubModelCli(m[1]!)) return undefined;
  const model = m[3]?.trim();
  return { provider: m[1], account: m[2] ?? '', ...(model ? { model } : {}) };
}

/** RLM's sub-model through a CLI as Settings keeps it (`parseCliSubModel()` reads it back). */
export function cliSubModelId(m: CliSubModel): string {
  return `cli:${m.provider}${m.account ? `:${m.account}` : ''}${m.model?.trim() ? `/${m.model.trim()}` : ''}`;
}

/**
 * Settings → Labs: an experimental way for agents to use Harness Relay's own tools, one at a time
 * (`runCode.ts`). `code`: `run_code`, code that calls the tools; `rlm`: the same with a `state` kept for
 * the turn and `llm_query()` to a sub-model (`rlmModel`: `<backend>/<model>` on a model connection, or
 * `cli:<provider>[:<account>][/<model>]` through a CLI, `parseCliSubModel()`).
 */
export const LAB_MODES = ['off', 'code', 'rlm'] as const;
export type LabMode = (typeof LAB_MODES)[number];
export interface LabSettings {
  mode: LabMode;
  /** With `rlm`: the sub-model, as `<backend>/<model>` or `cli:<provider>[:<account>][/<model>]`. */
  rlmModel?: string;
}
/** `GET /api/labs`: the mode on now, and where it comes from. */
export interface LabsView extends LabSettings {
  /** Saved in Settings; the environment's (`RELAY_RUN_CODE`, `RELAY_RLM`) until changed there; or neither (off). */
  source: 'saved' | 'env' | 'default';
  /** Why the modes cannot run on this computer (no sandbox for the code), in the request's language; undefined when they can. */
  unavailable?: string;
}

/** `<backend>/<model>`. */
export const backendModelId = (backend: string, model: string): string => `${backend}/${model}`;

export type LoginState = 'running' | 'success' | 'failed' | 'cancelled';

/** A CLI's own sign-in as it runs (`CliLogin`): what it printed, and the links and codes in it. */
export interface CliLoginView {
  id: string;
  state: LoginState;
  startedAt: number;
  output: string;
  urls: string[];
  codes: string[];
  /** The CLI is waiting for something to be pasted on stdin (e.g. Claude's auth code). */
  wantsInput: boolean;
  exitCode?: number | null;
}

/** An account's sign-in in Settings. */
export interface LoginSessionView extends CliLoginView {
  provider: Provider;
  /** The account signing in; empty = the default account. */
  account: string;
  method: string;
}

export interface LoginMethod {
  id: string;
  label: string;
  description: string;
}

// --- Voice input (whisper.cpp, on this computer) -----------------------------------

/** Speech-recognition models users can pick from (multilingual ggml models of whisper.cpp). */
export const VOICE_MODELS = ['base', 'small', 'large-v3-turbo-q5_0', 'large-v3-turbo', 'large-v3-q5_0'] as const;
export type VoiceModelId = (typeof VOICE_MODELS)[number];

/** `follow`: the UI language (zh-TW → Chinese written in Traditional characters, en → English). */
export const VOICE_LANGUAGES = ['follow', 'auto', 'zh', 'en'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** The longest recording that is transcribed, in seconds. */
export const VOICE_MAX_SECONDS = 120;

export interface VoiceModelInfo {
  id: VoiceModelId;
  /** Download size in bytes. */
  size: number;
  downloaded: boolean;
  /** The model suggested for this computer. */
  recommended: boolean;
}

/**
 * Where the whisper.cpp engine came from: the path set in Settings, downloaded by Harness Relay,
 * installed with Homebrew, or found on PATH.
 */
export type VoiceEngineSource = 'custom' | 'relay' | 'homebrew' | 'path';

export interface VoiceEngineInfo {
  installed: boolean;
  /** `whisper-server` that runs the model. */
  path?: string;
  source?: VoiceEngineSource;
  version?: string;
  /** How Harness Relay installs the engine on this platform; `none` when it cannot. */
  installer: 'homebrew' | 'download' | 'none';
  /** Why the engine cannot be installed automatically (when `installer` is `none`). */
  installerNote?: string;
  /** Why the engine set in Settings cannot be used (its path does not exist). */
  problem?: string;
  /** Bytes downloaded to install the engine (the prebuilt Linux and Windows builds). */
  downloadSize?: number;
  /** Metal (GPU) on macOS; the prebuilt Linux and Windows engines run on the CPU. */
  accel: 'metal' | 'cpu' | 'unknown';
}

export type VoiceJobStep = 'engine' | 'model' | 'check';

/** A background install: the engine (when missing), then the model, then a check that it runs. */
export interface VoiceJobView {
  id: string;
  model: VoiceModelId;
  state: LoginState;
  steps: VoiceJobStep[];
  step: VoiceJobStep;
  /** Bytes of the current download so far, its size, and the recent speed. */
  received?: number;
  total?: number;
  bytesPerSecond?: number;
  startedAt: number;
  finishedAt?: number;
  /** Output of the installer (Homebrew, tar). */
  log: string;
  error?: string;
}

export interface VoiceStatus {
  /** The engine is installed and the selected model is downloaded. */
  ready: boolean;
  engine: VoiceEngineInfo;
  models: VoiceModelInfo[];
  /** The selected model. */
  model: VoiceModelId;
  language: VoiceLanguage;
  /** `whisper-server` path set in Settings ('' = find it automatically). */
  bin: string;
  /** Where models (and the engine Harness Relay downloads) are kept. */
  dir: string;
  platform: string;
  /** The current or last install. */
  job?: VoiceJobView;
  /** The engine process: started on first use, stopped after a while without use. */
  server: 'stopped' | 'starting' | 'running';
}

export interface VoiceSettingsUpdate {
  model?: VoiceModelId;
  language?: VoiceLanguage;
  bin?: string;
}

// --- The desktop app (desktop/) and the server it runs in an Electron utility process ---------

/** An update of the desktop app under way: downloading, being checked and put in place, or waiting for the conversations. */
export type UpdateProgress = { kind: 'downloading'; percent: number } | { kind: 'installing' } | { kind: 'waiting' };

/** What the desktop app says of its updates (desktop/src/update.ts), each time that changes. */
export interface DesktopUpdate {
  /** Whether this copy updates itself (a packaged app, RELAY_UPDATES not off): nothing else is set when not. */
  updates: boolean;
  /**
   * A newer release with an installer for this system: its version, and where what changed since the
   * running version is read (GitHub's comparison of the two; the release's page for a build of your own).
   */
  available?: { version: string; changes: string };
  progress?: UpdateProgress;
  /** GitHub is being asked now. */
  checking?: boolean;
  /** When GitHub last answered (ms since the epoch). */
  checkedAt?: number;
  /** The last check could not reach GitHub (offline, or its hourly limit): the next one tries again. */
  checkFailed?: boolean;
  /**
   * The chat's checks (`update-check`, by id) this state answers: told once they were checked (or
   * refused, asked too soon). A state already on its way when one was asked for never answers it.
   */
  answered?: number[];
}

/** This Harness Relay's version, and its updates when the desktop app runs it (`GET /api/update`). */
export interface UpdateStatus extends DesktopUpdate {
  /** As a problem report names it: the release, a `-dev` build of the day, or `source (<commit>)`. */
  current: string;
}

/** What the desktop app tells the server it started. */
export type DesktopToServer =
  | { type: 'shutdown' }
  /** A link that signs a browser in (a new one-time code), to open the chat with. */
  | { type: 'sign-in-link' }
  /** How many conversations have agents at work (an update waits until none has). */
  | { type: 'busy' }
  /** Its updates, each time that changes, and once the server listens. */
  | { type: 'update'; update: DesktopUpdate };

/** What the server tells the desktop app that started it. */
export type ServerToDesktop =
  | { type: 'listening'; host: string; port: number }
  | { type: 'sign-in-link'; link: string }
  | { type: 'busy'; conversations: number }
  /** The server could not start listening (`code` is the error code, such as EADDRINUSE); it exits next. */
  | { type: 'error'; code: string; message: string }
  /** The user asks from the chat: check GitHub for a new release now (Settings' "Check again"); answered by its id. */
  | { type: 'update-check'; id: number }
  /** The user asks from the chat: update to the newer release (the app asks first, as from its menu). */
  | { type: 'update-install' }
  /**
   * The language the chat in the app's own window shows, as it opens and when the user picks another
   * there: the app's menus and dialogs follow it.
   */
  | { type: 'lang'; lang: Lang };

/** A hand-off block of a reply (`<secret>`, `<command>`, `<command-run>`, `<interactive>`), as `splitHandoffs()` reads it. */
export type HandoffBlock =
  | { kind: 'secret'; name: string; label?: string; reason?: string; url?: string }
  | ({ kind: 'command'; input?: string } & CommandProposal)
  | { kind: 'command-run'; name: string; input: string }
  | { kind: 'interactive'; run: string; reason?: string; workdir?: boolean };

/** A steps card (`<steps>`). */
export type StepsPart = Extract<MessagePart, { type: 'steps' }>;

/** The words of the user's answer, in their language (the server's `t().steps`). */
export interface StepsWords {
  /** Its first line: who gave the steps (`@name`), how many the user did of how many, and the step they are stuck at (from 1). */
  summary: (o: { agent: string; done: number; total: number; stuckAt?: number }) => string;
  done: string;
  notDone: string;
  stuck: string;
  /** Before the user's note, with what separates it ("Note: "). */
  note: string;
}

/** Why a name the user typed for a new file is not one (`fileNameProblem()` in `src/shared/fileNames.ts`). */
export type FileNameProblem = 'empty' | 'separator' | 'dots' | 'control' | 'reserved' | 'git' | 'tooLong';
