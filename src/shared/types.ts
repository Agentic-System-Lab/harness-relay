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
 * Settings → Model backends (Claude Code, Codex, Grok, Copilot): a member's model `<endpoint id>/<model>`.
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

/** Where each CLI is installed from: Settings links to it when the CLI is not found. */
export const PROVIDER_INSTALL_URL: Record<Provider, string> = {
  claude: 'https://claude.com/product/claude-code',
  codex: 'https://openai.com/codex/',
  grok: 'https://x.ai/build',
  cursor: 'https://cursor.com/cli',
  antigravity: 'https://antigravity.google/download',
  copilot: 'https://github.com/features/copilot/cli',
  muse: 'https://dev.meta.ai/products/muse-code/',
  opencode: 'https://www.npmjs.com/package/opencode-ai',
  goose: 'https://formulae.brew.sh/formula/block-goose-cli',
  cline: 'https://www.npmjs.com/package/cline',
  openhands: 'https://pypi.org/project/openhands/',
  pi: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
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
  claude: ['skills', 'mcp', 'tools', 'instructions', 'memory', 'hooks', 'agents', 'plugins'],
  codex: ['skills', 'mcp', 'instructions', 'memory', 'hooks', 'plugins'],
  grok: ['skills', 'mcp', 'memory', 'hooks'],
  cursor: [],
  antigravity: [],
  copilot: ['skills', 'mcp', 'memory', 'hooks', 'plugins'],
  // Muse Code: its MCP servers and hooks are its settings', and each run has settings of its own.
  muse: ['mcp', 'hooks'],
  // The open agents: each adapter lists what its CLI can really leave out (one line each, kept apart).
  // OpenCode: skills (denied with `permission.skill`, which turns off its skill tool), the project's instruction files Harness Relay passes on, its subagents (`agent.<name>.disable`).
  opencode: ['skills', 'instructions', 'agents'],

  goose: ['mcp', 'instructions', 'plugins'],

  // Cline: its `skills` tool off (`disabledTools` in its global settings, written per run).
  cline: ['skills'],

  openhands: [], // none: its home is Harness Relay's, and the project's files have no switch (docs/open-agents.md)

  // Pi: `--no-context-files` leaves out every AGENTS.md / CLAUDE.md it would load (none alone).
  pi: ['instructions'],
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

/** A folder that can be browsed: a working directory, or an agent's worktree of one (parallel mode). */
export interface FileRoot {
  /**
   * The first working directory's is `cwd` and an agent's worktree of it the agent's id; for the
   * others, `:` and the working directory's place follow (`cwd:1`, `<agent id>:1`).
   */
  id: string;
  path: string;
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

/**
 * Where a shared conversation can be read: the page (`url`, on gistpreview) and its gist (`id`, and
 * `gistUrl` on GitHub). `filesGist`: the id of the second secret gist that holds the files the page
 * links to, when files went along (GitHub's API cuts a gist's content off in all, in name order, so a
 * large file next to the page would leave gistpreview a blank page: the files are kept apart).
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
 * lead agent's team waits to be confirmed (`confirm`), or an agent asked the user something (`answer`).
 */
export type AlertKind = 'done' | 'error' | 'approval' | 'confirm' | 'answer';

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

export interface TeamPreset {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  agents: AgentConfig[];
  settings: Omit<ConversationSettings, 'cwd' | 'extraCwds'>;
}

export type Author =
  | { kind: 'user' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'system' };

export type ToolStatus = 'running' | 'done' | 'error';

/** What a tool call does, as ACP names it (its `ToolKind`, `switch_mode` as `other`). */
export const TOOL_CALL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'] as const;
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number];

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
   * `kind`: what the call does, when its CLI says (or its adapter can tell from the tool); only
   * AgentsView's record of a member's session uses it (`memberTranscript`).
   */
  | { type: 'tool'; id: string; name: string; detail?: string; kind?: ToolCallKind; status: ToolStatus; error?: string; output?: string }
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
      /** Allowing it runs the command outside the CLI's sandbox. */
      outsideSandbox?: boolean;
      /** Read-only is a boundary here: Harness Relay's sandbox keeps the agent from writing even when allowed. */
      readOnlySandbox?: boolean;
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
 * A per-agent git worktree used in parallel mode so agents don't overwrite each other: one for each
 * repository of the conversation's working directories.
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
  /** Parallel-mode worktrees by agent id: one per repository of the working directories. */
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
  /**
   * The copied messages before the part `fromId` wrote, when they were written further up: each part
   * with the conversation it was written in and its last message here (`afterId`), nearest first.
   * Branching from one of them makes a branch of the conversation that wrote it.
   */
  earlier?: BranchPart[];
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
  /** The lead agent is sorting it into one of the user's groups (by its first message). */
  sorting?: boolean;
  /**
   * It was branched from another conversation: that one's id, its title when it was branched (shown
   * once it has been deleted), and where that one came from once deleted (`ConversationBranch.via`).
   * The sidebar shows it under that conversation.
   */
  branchFrom?: { id: string; title: string; via?: ConversationBranch['via'] };
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
  /** It was branched from another conversation: that one's title (as it was then, once deleted). */
  branchFrom?: string;
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
  installed: boolean;
  bin: string;
  version?: string;
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
  /** How much of it is used, 0–100. */
  usedPercent: number;
  /** When it starts over (ms since the epoch). */
  resetsAt?: number;
  /** A limit of a number of requests (Copilot's premium requests): how many are used, of how many. */
  used?: number;
  total?: number;
}

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
export type UsageProblem = 'timedOut' | 'noAnswer' | 'cliMissing';

/** How much of an account's plan is used, as its CLI reports it (`GET /api/providers/:provider/usage`). */
export interface AccountUsage {
  provider: Provider;
  /** Empty for the default account. */
  account: string;
  /** The plan, as the CLI names it ("max", "prolite", "SuperGrok"). */
  plan?: string;
  limits: UsageLimit[];
  /** Credits beside the plan's limits (Codex's), when the account has some. */
  credits?: { balance?: number; unlimited?: boolean };
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
 * Whether an account signs in with its API key only: Cursor's, Antigravity's and Muse Code's accounts
 * besides the default one. Cursor keeps one sign-in per computer user (on macOS, in the keychain)
 * whatever its config folder; Antigravity keeps its Google sign-in in the system keyring too, and Muse
 * Code its Meta sign-in in the login keychain on macOS, under names their folders do not change, so
 * another account's sign-in could replace the default one's.
 */
export function keyOnlyAccount(p: Provider, account: string | undefined): boolean {
  return (p === 'cursor' || p === 'antigravity' || p === 'muse') && Boolean(account);
}

/**
 * Accounts per CLI, the default one included, unless `RELAY_MAX_ACCOUNTS` says otherwise
 * (`src/server/config.ts`; the UI gets the server's from `GET /api/limits`). Each account other than
 * the default has a folder of its own for the CLI (its sign-in, settings and sessions) and may have an
 * API key of its own.
 */
export const DEFAULT_MAX_ACCOUNTS = 10;
/** Each agent turn's safety timeout in minutes, unless `RELAY_TURN_TIMEOUT_MIN` says otherwise. */
export const DEFAULT_TURN_TIMEOUT_MIN = 45;

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
   * Settings → Model backends): it runs only an effort of `efforts`, and another one it would inherit
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
}

/** `PUT /api/settings`: only the fields given change. */
export interface SettingsUpdate {
  defaultCwd?: string;
  /** The default's other working directories; given with `defaultCwd` (absent then: none). */
  defaultExtraCwds?: string[];
  /** Create `defaultCwd` and `defaultExtraCwds` when they do not exist. */
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
}

// --- Model backends: what the open agents run their models on --------------------------------

/**
 * The model APIs the open agents reach with an API key kept in Settings (Settings → Model backends).
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
  /** The model names it serves, as typed by the user (Harness Relay never asks the server). */
  models: string[];
  /** Masked API key; empty = none (many local servers take none). */
  keyMasked: string;
  keyStorage: KeyStorage;
  keyUnreadable?: boolean;
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

/** `PUT /api/backends/endpoints/:id`: the endpoint as it should be. */
export interface ModelEndpointUpdate {
  name: string;
  baseUrl: string;
  models: string[];
  /** string = set / replace, null = remove, absent = keep. */
  apiKey?: string | null;
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

/** `<backend>/<model>`. */
export const backendModelId = (backend: string, model: string): string => `${backend}/${model}`;

export type LoginState = 'running' | 'success' | 'failed' | 'cancelled';

export interface LoginSessionView {
  id: string;
  provider: Provider;
  /** The account signing in; empty = the default account. */
  account: string;
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
  | { type: 'update-install' };
