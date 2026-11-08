// Types shared by the server and the web client.

export type Provider = 'claude' | 'codex' | 'grok';
export const PROVIDERS: Provider[] = ['claude', 'codex', 'grok'];

/** The error `code` (with a 404) for a working directory that does not exist; resend with `createCwd: true` to create it. */
export const CWD_MISSING = 'cwd-missing';

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
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
   * This agent's exceptions to the tool library's defaults, by tool key (see `toolKey`): true = it
   * gets the tool although the tool is off by default, false = it does not get a tool that is on.
   */
  tools?: Record<string, boolean>;
}

// --- Tool library: MCP servers, skills and memory every agent can be given ------------------

/**
 * Tool keys: `mcp:<server id>`, `skill:<skill folder>`, `memory` (the memory for everyone) or
 * `memory:<provider>` (the memory for one CLI's agents). Ids and folders stay when things are renamed.
 */
export type ToolKind = 'mcp' | 'skill' | 'memory';

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

export interface ToolLibraryView {
  mcpServers: McpServerView[];
  skills: SkillView[];
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
  /** The parts to change. */
  memory?: Partial<Record<MemoryScope, string>>;
}

// --- What each CLI loads by itself (its own skills, MCP servers and memory) -------------------

export interface NativeSkill {
  name: string;
  description: string;
  /** Where the CLI found it (user, repo, system, plugin, bundled…), when it says. */
  source?: string;
  path?: string;
  /** False when the CLI has it turned off. */
  enabled?: boolean;
}

export interface NativeMcpServer {
  name: string;
  /** stdio, http… */
  transport?: string;
  /** connected, failed, needs-auth, disabled… when the CLI reports it. */
  status?: string;
  source?: string;
  /** How many tools it offers, when the CLI connected to it. */
  tools?: number;
}

export interface NativeMemoryFile {
  path: string;
  /** Instructions (CLAUDE.md, AGENTS.md…) or notes the CLI keeps by itself. */
  kind: 'instructions' | 'memory';
}

/** What one CLI loads by itself for a working directory, asked from the CLI (no prompt is sent). */
export interface NativeSetup {
  provider: Provider;
  cwd: string;
  skills: NativeSkill[];
  mcpServers: NativeMcpServer[];
  memory: NativeMemoryFile[];
  /** The memory list comes from reading the files the CLI is known to read, not from the CLI. */
  memoryFromFiles: boolean;
  /** What could not be found out, and why. */
  errors: string[];
  checkedAt: number;
}

// --- Browsing a conversation's files ----------------------------------------------------------

/** A folder that can be browsed: the working directory, or an agent's worktree (parallel mode). */
export interface FileRoot {
  /** `cwd`, or the agent's id. */
  id: string;
  path: string;
  agentId?: string;
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
  roots: FileRoot[];
  root: string;
  /** Relative to the root, with `/`; '' is the root itself. */
  path: string;
  entries: FileEntry[];
  /** The folder has more entries than are listed. */
  truncated: boolean;
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
}

export const FILE_LIMITS = { maxEntries: 2000, maxPreviewBytes: 512 * 1024 };

export interface ConversationSettings {
  mode: Mode;
  /** Number of rounds for roundtable / parallel mode. */
  rounds: number;
  /** Maximum number of agent turns per user message in relay mode. */
  maxHops: number;
  permission: Permission;
  /** Working directory shared by all agents. */
  cwd: string;
  /**
   * The lead agent (Settings) designs the team from the first message — picking a template or
   * designing a new team — before anyone answers. Cleared once the team is set.
   */
  autoTeam?: boolean;
  /**
   * What happens when an agent wants to do something its permission does not cover:
   * ask the user in the chat (default), or refuse automatically.
   */
  approvals?: 'ask' | 'deny';
}

/** The agent that designs the team for auto-team conversations. */
export interface LeadAgentSettings {
  provider: Provider;
  model?: string;
  effort?: string;
}

/** What the lead agent decided for an auto-team conversation (shown as a card in the chat). */
export interface TeamPlan {
  status: 'planning' | 'ready';
  lead: LeadAgentSettings;
  /**
   * template: an existing template, as it is; adapted: a template the lead changed for the question;
   * custom: a team the lead designed from scratch; fallback: planning failed.
   */
  source?: 'template' | 'adapted' | 'custom' | 'fallback';
  /** The template used (template, fallback). */
  presetId?: string;
  /** The template the team was adapted from (adapted). */
  basedOn?: { id: string; name: string };
  name?: string;
  description?: string;
  /** The lead's explanation for the user (or, for a fallback, why planning failed). */
  reason?: string;
  settings?: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>;
  agents?: AgentConfig[];
  /** Set once the user saved a custom team as a template. */
  savedPresetId?: string;
  /**
   * The design waits for the user: nobody answers until they confirm it (or set the team by hand),
   * and then they ask their first question. (Plans from before this step have neither field.)
   */
  awaitingConfirmation?: boolean;
  confirmedAt?: number;
}

/** The lead agent's team design that is waiting for the user's confirmation, if any. */
export function pendingPlan(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((m) => m.plan?.status === 'ready' && m.plan.awaitingConfirmation);
}

/** Only a team the lead designed or adapted is new, and can be saved as a template. */
export function planSavable(plan: Pick<TeamPlan, 'source'>): boolean {
  return plan.source === 'custom' || plan.source === 'adapted';
}

export interface TeamPreset {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  agents: AgentConfig[];
  settings: Omit<ConversationSettings, 'cwd'>;
}

export type Author =
  | { kind: 'user' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'system' };

export type ToolStatus = 'running' | 'done' | 'error';

/** What an agent asks to be allowed to do. */
export type ApprovalKind = 'command' | 'edit' | 'fetch' | 'other';

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired';

/** One step of an agent's plan / to-do list. */
export interface PlanEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type MessagePart =
  | { type: 'text'; text: string }
  /** The agent's reasoning, as far as its CLI shares it. Never forwarded to other agents. */
  | { type: 'thinking'; text: string }
  /** The agent's current plan / to-do list (updated in place). */
  | { type: 'plan'; entries: PlanEntry[] }
  /**
   * `error`: why the call failed or was refused, when the CLI said so.
   * `output`: the end of what the call returned (command output, fetched text…).
   */
  | { type: 'tool'; id: string; name: string; detail?: string; status: ToolStatus; error?: string; output?: string }
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
      status: ApprovalStatus;
      /** Allowed for the rest of the conversation (or by such an earlier answer). */
      always?: boolean;
      /** Answered automatically by an earlier "always allow". */
      auto?: boolean;
      /** The user's message to the agent when declining. */
      note?: string;
    }
  /** A file the user attached to their message (stored under data/attachments). */
  | { type: 'attachment'; id: string; name: string; mimeType: string; size: number };

/** Limits for files attached to one message. */
export const ATTACHMENT_LIMITS = { maxFiles: 10, maxBytes: 20 * 1024 * 1024 };

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

/** Files an agent changed during one turn, as two git commits (diff base..head). */
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

/** A per-agent git worktree used in parallel mode so agents don't overwrite each other. */
export interface AgentWorktree {
  /** Repository root of the conversation's working directory. */
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
  /** Files the agent changed in this turn (only for conversations with edit / full permission). */
  changes?: MessageChanges;
  /** A system message carrying the lead agent's team design (auto-team conversations). */
  plan?: TeamPlan;
  /** A user message sent while the team was replying: it waited in the queue for a later turn. */
  queued?: boolean;
  /** An agent reply that asks the user something (it ended with `ASK_TOKEN`): the team waited for the answer. */
  asked?: boolean;
}

/**
 * Where the team stopped because an agent asked the user something. Once the user replies, the
 * agents that asked answer first and the run goes on from here (`Orchestrator.execute`).
 */
export interface RunPause {
  mode: Mode;
  /** The agents that asked, by id. */
  askers: string[];
  /** Who was still to speak after them: the rest of the round (roundtable), or the relay queue. */
  rest: { agentId: string; handedBy?: string }[];
  /** The run's participants by id: later rounds go on with them. */
  participants: string[];
  round: number;
  rounds: number;
  /** Relay: handoffs left. */
  hopsLeft?: number;
}

export interface AgentSessionState {
  /** CLI-native session / thread id used to resume the agent's own context. */
  sessionId?: string;
  provider?: Provider;
  /** Ids of chat messages this agent has already been shown. */
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
  /** Parallel-mode worktrees by agent id. */
  worktrees: Record<string, AgentWorktree>;
  /** "Always allow" answers given in this conversation. */
  allowRules?: AllowRule[];
  /**
   * The user's messages waiting to be delivered, oldest first: sent while the team replies, they are
   * posted before the next turn of an agent they are for (see `Orchestrator.send`).
   */
  queue?: ChatMessage[];
  /** An agent asked the user something and the team waits for the answer. */
  pause?: RunPause;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  agents: Pick<AgentConfig, 'name' | 'provider'>[];
  running: boolean;
  /** An agent is waiting for the user to approve something. */
  waiting?: boolean;
  /** The lead agent's team design waits for the user to confirm it (auto team). */
  confirmTeam?: boolean;
  /** An agent asked the user something and the team waits for the answer. */
  asking?: boolean;
  /** How the latest agent reply ended (absent before the first one). */
  lastStatus?: MessageStatus;
  /** The sidebar group it is in; absent = the default group, "Other". */
  groupId?: string;
  /** The lead agent is sorting it into one of the user's groups (by its first message). */
  sorting?: boolean;
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
}

/** Events pushed to the browser over SSE for one conversation. */
export type ServerEvent =
  | { type: 'snapshot'; conversation: Conversation; running: boolean; activeAgentIds: string[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'delta'; messageId: string; partIndex: number; text: string }
  | { type: 'status'; running: boolean; activeAgentIds: string[] }
  | { type: 'queue'; queue: ChatMessage[] }
  | {
      type: 'conversation';
      title: string;
      agents: AgentConfig[];
      settings: ConversationSettings;
      worktrees: Record<string, AgentWorktree>;
      pause?: RunPause;
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
  installed: boolean;
  bin: string;
  version?: string;
  auth: ProviderAuth;
  /** An API key is stored in Harness Relay and injected into this CLI's environment. */
  usingStoredApiKey: boolean;
}

/**
 * Where Harness Relay keeps API keys: the operating system's credential store (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service) or, when there is none, its database.
 */
export type KeyStorage = 'keychain' | 'credential-manager' | 'secret-service' | 'database';

export interface ProviderSettingsView {
  provider: Provider;
  /** Custom executable path; empty = use PATH. */
  bin: string;
  /** Masked API key, e.g. "sk-…a1b2", or empty when none is stored. */
  apiKeyMasked: string;
  /** Where this provider's key is (or would be) stored; absent for Codex, which keeps its own. */
  apiKeyStorage?: KeyStorage;
  /** Model used when an agent does not specify one. */
  defaultModel: string;
  /** Reasoning effort used when an agent does not specify one. */
  defaultEffort: string;
}

export interface ModelOption {
  id: string;
  label?: string;
  /** An alias that always points at the newest model of its family (the UI says so). */
  latest?: boolean;
  /** Effort levels this model supports; undefined = use the provider-wide list. */
  efforts?: string[];
  defaultEffort?: string;
}

/** Models and reasoning-effort levels a provider offers, as discovered from its CLI. */
export interface ProviderModels {
  provider: Provider;
  models: ModelOption[];
  efforts: string[];
  /** The CLI's own defaults (from its config or catalog). */
  cliDefaultModel?: string;
  cliDefaultEffort?: string;
  /** What actually runs when an agent leaves the field on "default": Relay setting first, then the CLI default. */
  defaultModel?: string;
  defaultEffort?: string;
  source: 'cli' | 'builtin';
  error?: string;
}

/** Effort levels valid for a model (falls back to the provider-wide list). */
export function effortsFor(pm: Pick<ProviderModels, 'models' | 'efforts'>, model?: string): string[] {
  return pm.models.find((m) => m.id === model)?.efforts ?? pm.efforts;
}

/** The effort that runs when an agent leaves effort on default, for the model it will use. */
export function inheritedEffort(pm: ProviderModels, model?: string): string | undefined {
  return pm.defaultEffort ?? pm.models.find((m) => m.id === (model || pm.defaultModel))?.defaultEffort;
}

export interface SettingsView {
  providers: ProviderSettingsView[];
  defaultCwd: string;
  /** Designs the team in auto-team conversations. */
  lead: LeadAgentSettings;
}

export interface ProviderSettingsUpdate {
  bin?: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** string = set / replace, null = remove. */
  apiKey?: string | null;
}

export type LoginState = 'running' | 'success' | 'failed' | 'cancelled';

export interface LoginSessionView {
  id: string;
  provider: Provider;
  method: string;
  state: LoginState;
  startedAt: number;
  output: string;
  urls: string[];
  codes: string[];
  /** The CLI is waiting for something to be pasted on stdin (e.g. Claude's auth code). */
  wantsInput: boolean;
  exitCode?: number | null;
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
