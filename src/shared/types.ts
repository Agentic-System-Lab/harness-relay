// Types shared by the server and the web client.

export type Provider = 'claude' | 'codex' | 'grok';
export const PROVIDERS: Provider[] = ['claude', 'codex', 'grok'];

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
}

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
  /** How the latest agent reply ended (absent before the first one). */
  lastStatus?: MessageStatus;
}

/** Events pushed to the browser over SSE for one conversation. */
export type ServerEvent =
  | { type: 'snapshot'; conversation: Conversation; running: boolean; activeAgentIds: string[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'delta'; messageId: string; partIndex: number; text: string }
  | { type: 'status'; running: boolean; activeAgentIds: string[] }
  | {
      type: 'conversation';
      title: string;
      agents: AgentConfig[];
      settings: ConversationSettings;
      worktrees: Record<string, AgentWorktree>;
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
