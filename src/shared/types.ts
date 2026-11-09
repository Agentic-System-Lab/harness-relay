// Types shared by the server and the web client.

export type Provider = 'claude' | 'codex' | 'grok';
export const PROVIDERS: Provider[] = ['claude', 'codex', 'grok'];

/** The error `code` (with a 404) for a working directory that does not exist; resend with `createCwd: true` to create it. */
export const CWD_MISSING = 'cwd-missing';

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

/**
 * The kinds of things a CLI loads by itself that Harness Relay can leave out of its runs, all of a
 * kind at once. `agents` are the CLI's own subagents (its built-in ones stay); `tools` its built-in
 * tools.
 */
export const NATIVE_PARTS = ['skills', 'mcp', 'tools', 'instructions', 'memory', 'hooks', 'agents', 'plugins'] as const;
export type NativePart = (typeof NATIVE_PARTS)[number];

/**
 * What each CLI can be told to leave out for one run, without changing its own settings. Codex
 * still reads its own ~/.codex/AGENTS.md, and has no setting that leaves out only its own
 * subagents. Grok's switches reach only what it loads from Claude Code and Cursor (its own skills,
 * MCP servers and hooks are turned off in ~/.grok/config.toml), and it has none for instruction
 * files, its own subagents or plugins. Only Claude Code lists its built-in tools.
 */
export const NATIVE_OFF_SUPPORT: Record<Provider, readonly NativePart[]> = {
  claude: ['skills', 'mcp', 'tools', 'instructions', 'memory', 'hooks', 'agents', 'plugins'],
  codex: ['skills', 'mcp', 'instructions', 'memory', 'hooks', 'plugins'],
  grok: ['skills', 'mcp', 'memory', 'hooks'],
};

/** The parts in `parts` that `provider` can leave out, once each, in NATIVE_PARTS order. */
export function nativeOffFor(provider: Provider, parts: readonly string[]): NativePart[] {
  return NATIVE_PARTS.filter((p) => NATIVE_OFF_SUPPORT[provider].includes(p) && parts.includes(p));
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
 * path, MCP servers and their tools, hooks by key, plugins by id. Grok has no such setting for a
 * single run.
 */
export const NATIVE_ITEM_SUPPORT: Record<Provider, readonly NativeItemKind[]> = {
  claude: ['skills', 'mcp', 'mcpTools', 'tools', 'instructions', 'agents', 'plugins'],
  codex: ['skills', 'mcp', 'mcpTools', 'hooks', 'plugins'],
  grok: [],
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

/** A folder that can be browsed: the working directory, or an agent's worktree (parallel mode). */
export interface FileRoot {
  /** `cwd`, or the agent's id. */
  id: string;
  path: string;
  agentId?: string;
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

/**
 * `zipItems` / `zipBytes`: the most files and folders together, and bytes before compression, a folder
 * downloaded as a ZIP file may hold (it is streamed, and stays well under ZIP's 4 GB and 65,535 entries).
 */
export const FILE_LIMITS = { maxEntries: 2000, maxPreviewBytes: 512 * 1024, zipItems: 10_000, zipBytes: 1024 * 1024 * 1024 };

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
 * The largest shared page, in UTF-8 bytes. A shared page is a secret GitHub gist that
 * gistpreview.github.io shows, and it reads the gist's file through GitHub's API, which cuts a file's
 * content off at 1 MB.
 */
export const SHARE_MAX_BYTES = 1_000_000;

/** Where a shared conversation can be read: the page (`url`, on gistpreview) and the gist (`id`) itself. */
export interface ShareLink {
  id: string;
  url: string;
  gistUrl: string;
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
   * Auto team: before the team answers a new question, the lead agent (Settings) chooses the team for
   * it from the question and the conversation so far — keeping the current team, using a template as
   * it is, adapting one, or designing a new team. Every conversation started in the app has it.
   */
  autoTeam?: boolean;
  /** Auto team: the lead agent's team answers at once, without waiting for the user to confirm it. */
  autoConfirm?: boolean;
  /**
   * What happens when an agent wants to do something its permission does not cover:
   * ask the user in the chat (default), or refuse automatically.
   */
  approvals?: 'ask' | 'deny';
}

/**
 * The working directories the working directory box offers (`GET /api/cwds`): the default one (Settings)
 * first, then the conversations' own, the most recently used first; only folders that still exist.
 */
export interface WorkingDirectories {
  /** The home folder, so a typed `~` matches it. */
  home: string;
  dirs: { path: string; /** The default working directory (Settings). */ default?: true }[];
}

/** The agent that designs the team for auto-team conversations. */
export interface LeadAgentSettings {
  provider: Provider;
  model?: string;
  effort?: string;
}

/** What the lead agent decided for a question in an auto-team conversation (shown as a card in the chat). */
export interface TeamPlan {
  status: 'planning' | 'ready';
  lead: LeadAgentSettings;
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
  /** The lead's explanation for the user (or, for a fallback, why planning failed). */
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
  /** The user confirmed it: the team became this one. */
  confirmedAt?: number;
  /** The user declined it: the current team stayed, and answered the question. */
  declinedAt?: number;
  /** Confirmed without asking: the conversation uses the lead agent's team at once (`autoConfirm`). */
  autoConfirmed?: boolean;
  /**
   * Designed for the conversation's schedule (its message, which nobody posted): once confirmed, the
   * team answers nothing now; it gets the message when the schedule sends it.
   */
  forSchedule?: boolean;
}

/** The lead agent's team design that is waiting for the user's confirmation, if any. */
export function pendingPlan(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((m) => m.plan?.status === 'ready' && m.plan.awaitingConfirmation);
}

/** Only a team the lead designed or adapted is new, and can be saved as a template. */
export function planSavable(plan: Pick<TeamPlan, 'source'>): boolean {
  return plan.source === 'custom' || plan.source === 'adapted';
}

/** Longest request to the lead agent to change a team (the team drawer's "Ask the lead agent"). */
export const REVISE_REQUEST_MAX = 4000;

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
  /** A user message the conversation's schedule sent (see `ConversationSchedule`), not one the user typed. */
  scheduled?: boolean;
}

/**
 * When a schedule sends its message. `daily` and `weekly` times are wall-clock times ("HH:MM") in the
 * schedule's time zone; `days` are weekdays, 0 = Sunday. `interval` repeats every so many hours from
 * when the schedule was saved; `once` is a moment (epoch ms).
 */
export type ScheduleRepeat =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'interval'; hours: number };

export const SCHEDULE_KINDS: ScheduleRepeat['kind'][] = ['once', 'daily', 'weekly', 'interval'];

/**
 * How the last time a schedule came due went: its message started a run (`sent`), waited in the queue
 * while the team replied (`queued`), was not sent because Harness Relay was not running then
 * (`missed`), was held back because the team could not take it (`skipped`: it waited for the user's
 * answer, had no confirmed team, or the previous scheduled message was still waiting), or could not
 * start (`failed`). `lastError` says why for the last two.
 */
export type ScheduleResult = 'sent' | 'queued' | 'missed' | 'skipped' | 'failed';

/** Longest scheduled message, and the longest interval in hours. */
export const SCHEDULE_LIMITS = { maxText: 4000, maxHours: 168 };

/**
 * A conversation's schedule: a message the team is sent at set times, as if the user had sent it (it
 * is marked `scheduled`): in this conversation, or (`newChat`) in a new one each time. One per
 * conversation.
 */
export interface ConversationSchedule {
  text: string;
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
export type ScheduleUpdate = Pick<ConversationSchedule, 'text' | 'repeat' | 'timeZone' | 'enabled' | 'approvals' | 'missed' | 'newChat'>;

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
  /** A message the team is sent at set times. */
  schedule?: ConversationSchedule;
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
  /**
   * It has a schedule: whether it is on, when it sends next, how the last time went, and the time zone
   * its times are shown in (a daily or weekly schedule's own; absent: the browser's).
   */
  schedule?: Pick<ConversationSchedule, 'enabled' | 'nextRunAt' | 'lastResult'> & { timeZone?: string };
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
  /** What this CLI loads by itself that Harness Relay's runs leave out, all of a kind (see NATIVE_OFF_SUPPORT). */
  nativeOff: NativePart[];
  /** Single items Harness Relay's runs leave out (see NATIVE_ITEM_SUPPORT). */
  nativeItems: NativeItemsOff;
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
}

/** `PUT /api/settings`: only the fields given change. */
export interface SettingsUpdate {
  defaultCwd?: string;
  /** Create `defaultCwd` when it does not exist. */
  createCwd?: boolean;
  lead?: LeadAgentSettings;
  /** Empty = the CLIs use their usual homes again. */
  agentHome?: string;
  /** Empty = off. */
  agentsViewUrl?: string;
  /** Empty = the link opens `agentsViewUrl`. */
  agentsViewLink?: string;
}

/** Suggested folder for the CLIs' own homes. */
export const SUGGESTED_AGENT_HOME = '~/.relay-agents';
/** AgentsView's default address (`agentsview serve`). */
export const AGENTSVIEW_DEFAULT_URL = 'http://127.0.0.1:8080';

export interface ProviderSettingsUpdate {
  bin?: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** string = set / replace, null = remove. */
  apiKey?: string | null;
  /** The whole list, replacing the current one; parts the CLI cannot leave out are dropped. */
  nativeOff?: NativePart[];
  /** All the single items, replacing the current ones; kinds the CLI cannot leave out are dropped. */
  nativeItems?: NativeItemsOff;
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
