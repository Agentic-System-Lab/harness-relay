import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  MEMORY_SCOPES,
  PROVIDERS,
  RELAY_TOOL_GROUPS,
  TOOL_LIMITS,
  agentHasTool,
  toolKey,
  type AgentConfig,
  type KeyStorage,
  type MaskedVar,
  type McpServerUpdate,
  type McpServerView,
  type McpTransport,
  type MemoryScope,
  type Provider,
  type RelayToolGroup,
  type SkillCandidate,
  type SkillView,
  type ToolLibraryUpdate,
  type ToolLibraryView,
} from '../shared/types';
import { NO_HTTP_MCP } from './agents/acp';
import type { McpServerSpec } from './agents/types';
import type { Database } from './db';
import { HttpError } from './errors';
import { t } from './i18n';
import { canonicalResource } from './oauth/mcp';
import type { SecretStore } from './secrets';

/*
 * The tool library: MCP servers, skills and memory that Harness Relay gives its agents, the same
 * way for Claude Code, Codex and Grok. Each MCP server and skill is on by default for the agents of
 * the CLIs it lists; the memory has a part for everyone and one per CLI. An agent can make its own
 * exceptions (`AgentConfig.tools`), keyed by a server's id and a skill's folder, so renaming a server
 * or a skill keeps them.
 *
 * The values of an MCP server's environment variables and headers are secrets (tokens): they go to
 * the OS credential store when there is one, else encrypted into the database (secrets.ts), like API
 * keys, and the UI only ever sees them masked.
 * They are kept by the server's id, not its name, so a rename never touches them (a store with
 * case-insensitive names, like Windows', would otherwise see `github` → `GitHub` as one entry).
 *
 * An HTTP server can also sign in itself (MCP's authorization: OAuth, `oauth/mcp.ts`): where it signs in
 * and the client registered there are kept with the server (`oauth`); its refresh token (and a client
 * secret, when its authorization server gave one) go to the credential store as `mcp-oauth.<id>` (a dot,
 * which no server's name has, so no entry of a server named `oauth-…` can be it), and its access token is
 * kept in memory only, by the token broker. Removing the server, changing its URL, or signing it out
 * deletes them (`onMcpOAuthDropped`).
 */

interface StoredServer {
  /** Stays the same when the server is renamed: agents' exceptions are keyed by it. */
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  /** Names only; the values are secrets. */
  env: string[];
  headers: string[];
  providers: Provider[];
  /** An HTTP server's own sign-in, once it signed in. */
  oauth?: StoredMcpOAuth;
}

/**
 * An HTTP server's own sign-in (MCP's authorization), as discovery found it and the sign-in left it:
 * its authorization server and the endpoints it publishes, the client registered there (RFC 7591), what
 * its tokens are for, the host they go to, and its state. Its secrets are in the credential store.
 */
export interface StoredMcpOAuth {
  issuer: string;
  authorize: string;
  token: string;
  revoke?: string;
  /** The registration endpoint the client was registered at. */
  registration: string;
  /** The resource its tokens are for (RFC 8707), and the scopes asked for. */
  resource: string;
  scopes: string[];
  clientId: string;
  /** The redirect addresses the client was registered with: a sign-in needing another registers again. */
  redirectUris: string[];
  /** Its client secret goes in a Basic header (`client_secret_basic`), else in the form. */
  secretBasic?: boolean;
  /** The only host its access token goes to: the server's own, when it signed in. */
  host: string;
  status: 'signed-in' | 'reauth';
  signedInAt: number;
  /** Why it needs a new sign-in. */
  error?: string;
  /** Its sign-in brought no refresh token: it lasts as long as its access token. */
  noRefresh?: boolean;
  /** Its authorization server's redirects bring back `iss` (RFC 9207): one without it is refused. */
  issParameter?: boolean;
  /** Its client was refused at a refresh (`invalid_client`, `unauthorized_client`): the next sign-in registers again. */
  clientRefused?: boolean;
}

/** An HTTP server's sign-in secrets, in the credential store as one entry. */
export interface McpOAuthSecrets {
  refresh?: string;
  clientSecret?: string;
}

/** What signing a server out (or removing it, or changing its URL) took away: to revoke at its authorization server. */
export interface DroppedMcpOAuth {
  oauth: StoredMcpOAuth;
  secrets: McpOAuthSecrets;
}

interface Secrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

interface Stored {
  mcpServers: StoredServer[];
  skills: { path: string; providers: Provider[] }[];
  memory: Record<MemoryScope, string>;
  /** Harness Relay's own tool groups, by the CLIs whose agents get each (none at first). */
  relayTools?: Partial<Record<RelayToolGroup, Provider[]>>;
  /** Without a secret store (tests), or saved by an older version: the secret values, by server id. */
  secrets?: Record<string, Secrets>;
  /** Without a secret store (tests): the servers' sign-in secrets, by server id. */
  oauthSecrets?: Record<string, McpOAuthSecrets>;
  /** The browser the browser tools start (Settings), before `RELAY_BROWSER` and the ones found. */
  browser?: string;
}

/** A skill an agent can use. */
export interface SkillInfo {
  name: string;
  description: string;
  /** The skill's folder and its SKILL.md. */
  dir: string;
  file: string;
}

/** What one agent gets from the library for a turn. */
export interface AgentTools {
  mcpServers: McpServerSpec[];
  skills: SkillInfo[];
  /** The memory parts the agent gets (for everyone, then for its CLI), when there are any. */
  memory?: string;
  /** Harness Relay's own tool groups the agent gets (through the gateway). */
  relayGroups: RelayToolGroup[];
  /**
   * Its HTTP servers that signed in themselves (by name, and id in the library): each turn gives them an
   * access token in their `Authorization` header (`McpOAuth.forTurn()`).
   */
  oauthServers?: { name: string; id: string }[];
  /** The servers left out of this turn, their sign-in needing a new one or not renewed now, with the user's note. */
  leftOut?: { name: string; reason: 'reauth' | 'failed'; note: string }[];
}

const SETTINGS_KEY = 'tool_library';
/** A server's entry in the credential store, named after its id. */
const secretName = (serverId: string) => `mcp-${serverId}`;
/** A server's sign-in secrets' entry: a dot no server's id has (ids are names or hex), so never another server's `mcp-<id>`. */
const oauthSecretName = (serverId: string) => `mcp-oauth.${serverId}`;
const SKILL_FILE = 'SKILL.md';
const MAX_DESCRIPTION = 1024;

const emptyMemory = (): Record<MemoryScope, string> => Object.fromEntries(MEMORY_SCOPES.map((s) => [s, ''])) as Record<MemoryScope, string>;

/** An item's CLIs as stored; data saved before items had them has `enabled` instead. */
function storedProviders(v: { providers?: unknown; enabled?: unknown }): Provider[] {
  if (Array.isArray(v.providers)) return PROVIDERS.filter((p) => (v.providers as unknown[]).includes(p));
  return v.enabled === false ? [] : [...PROVIDERS];
}

/** Whether two URLs name the same MCP server: the same canonical URL (`canonicalResource()`), else the same text. */
function sameMcpUrl(a: string, b: string): boolean {
  try {
    return canonicalResource(a) === canonicalResource(b);
  } catch {
    return a === b;
  }
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

/**
 * Top-level `key: value` pairs of a Markdown file's YAML front matter. Handles quoted values,
 * `|` / `>` block values and indented continuation lines; nested keys are not read.
 */
export function parseFrontMatter(text: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  const indented = (i: number) => i < lines.length && /^\s+\S/.test(lines[i]!);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*)|\s*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    let value = (kv[2] ?? '').trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const block: string[] = [];
      while (i + 1 < lines.length && (indented(i + 1) || lines[i + 1]!.trim() === '')) block.push(lines[++i]!.trim());
      value = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      while (indented(i + 1)) value += ' ' + lines[++i]!.trim();
      if (/^".*"$/.test(value)) {
        try {
          value = JSON.parse(value) as string;
        } catch {
          value = value.slice(1, -1);
        }
      } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    }
    out[key] = value;
  }
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const MAX_SCAN = 300;

/**
 * Every skill folder under `path`, for picking: the folder itself when it holds a SKILL.md (or is
 * one), and skill folders up to two levels down, not looking inside a skill or hidden folders.
 */
export function scanSkills(path: string): string[] {
  if (basename(path) === SKILL_FILE && isFile(path)) return [dirname(path)];
  if (!isDir(path)) return [];
  const out = isFile(join(path, SKILL_FILE)) ? [path] : [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= MAX_SCAN) return;
      if (n.startsWith('.') || n === 'node_modules') continue;
      const sub = join(dir, n);
      if (!isDir(sub)) continue;
      if (isFile(join(sub, SKILL_FILE))) out.push(sub);
      else if (depth > 1) walk(sub, depth - 1);
    }
  };
  walk(path, 2);
  return out;
}

/** The skill folders adding `path` adds: the skill it names, or every skill under it. */
export function findSkills(path: string): string[] {
  if (basename(path) === SKILL_FILE && isFile(path)) return [dirname(path)];
  return isFile(join(path, SKILL_FILE)) ? [path] : scanSkills(path);
}

/** A skill's name and description from its SKILL.md; undefined when there is none. */
function readSkill(dir: string): { name: string; description: string } | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, SKILL_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const fm = parseFrontMatter(text);
  return {
    name: (fm.name || basename(dir)).trim().slice(0, 100),
    description: (fm.description ?? '').trim().slice(0, MAX_DESCRIPTION),
  };
}

export class ToolLibrary {
  private data: Stored = { mcpServers: [], skills: [], memory: emptyMemory() };
  /** The secret values, by server id. */
  private secrets = new Map<string, Secrets>();
  /** Without a credential store: the servers' sign-in secrets, by server id. */
  private oauthSecrets = new Map<string, McpOAuthSecrets>();

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    if (row) {
      try {
        const v = JSON.parse(row.value) as Partial<Stored> & { memory?: unknown };
        const memory = emptyMemory();
        if (typeof v.memory === 'string') memory.all = v.memory;
        else if (v.memory && typeof v.memory === 'object') {
          for (const scope of MEMORY_SCOPES) {
            const text = (v.memory as Record<string, unknown>)[scope];
            if (typeof text === 'string') memory[scope] = text;
          }
        }
        this.data = {
          mcpServers: (Array.isArray(v.mcpServers) ? v.mcpServers : []).map((s) => ({
            ...s,
            id: typeof s.id === 'string' && s.id ? s.id : s.name,
            providers: storedProviders(s),
          })),
          skills: (Array.isArray(v.skills) ? v.skills : []).map((s) => ({ path: s.path, providers: storedProviders(s) })),
          memory,
          relayTools: storedRelayTools(v.relayTools),
          ...(v.secrets ? { secrets: v.secrets } : {}),
          ...(typeof v.browser === 'string' && v.browser ? { browser: v.browser } : {}),
        };
        if (!keyring && v.oauthSecrets && typeof v.oauthSecrets === 'object')
          for (const [id, secrets] of Object.entries(v.oauthSecrets)) this.oauthSecrets.set(id, secrets);
      } catch {
        /* keep it empty */
      }
    }
    let moved = false;
    for (const s of this.data.mcpServers) {
      let secrets: Secrets | undefined = this.data.secrets?.[s.id];
      if (keyring && secrets) {
        // Saved as they are (by an older version, or with no store): move the values there, or keep them where they are.
        try {
          this.writeSecrets(s.id, secrets);
          moved = true;
        } catch (err) {
          this.leftInDb.add(s.id);
          console.warn(`[tools] could not move the values of MCP server ${s.name} to the credential store: ${(err as Error).message}`);
        }
      } else if (keyring) {
        try {
          const raw = keyring.get(secretName(s.id));
          if (raw) secrets = JSON.parse(raw) as Secrets;
        } catch (err) {
          this.unreadable.add(s.id);
          console.warn(`[tools] could not read the values of MCP server ${s.name}: ${(err as Error).message}`);
        }
      }
      this.secrets.set(s.id, { env: secrets?.env ?? {}, headers: secrets?.headers ?? {} });
    }
    delete this.data.secrets;
    if (moved) {
      this.save();
      // Write the scrubbed page into the database file now; until a checkpoint the old values stay there.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }

  /** With a credential store: servers (ids) whose values are still in the database because moving them failed. */
  private leftInDb = new Set<string>();
  /** Servers (ids) whose values could not be read from the credential store (it may be locked). */
  private unreadable = new Set<string>();

  private save(): void {
    const stored: Stored = {
      mcpServers: this.data.mcpServers,
      skills: this.data.skills,
      memory: this.data.memory,
      relayTools: this.data.relayTools ?? {},
      ...(this.data.browser ? { browser: this.data.browser } : {}),
    };
    const inDb = this.keyring ? [...this.leftInDb] : [...this.secrets.keys()];
    if (inDb.length) stored.secrets = Object.fromEntries(inDb.map((id) => [id, this.secrets.get(id)!]));
    if (!this.keyring && this.oauthSecrets.size) stored.oauthSecrets = Object.fromEntries(this.oauthSecrets);
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTINGS_KEY, JSON.stringify(stored));
  }

  private get secretStorage(): KeyStorage {
    return this.keyring?.storage ?? 'database';
  }

  private writeSecrets(id: string, secrets: Secrets): void {
    if (!this.keyring) return;
    const empty = !Object.keys(secrets.env).length && !Object.keys(secrets.headers).length;
    try {
      if (empty) this.keyring.delete(secretName(id));
      else this.keyring.set(secretName(id), JSON.stringify(secrets));
    } catch (err) {
      if (empty) return; // nothing was there
      throw new Error(t().secretsFailed((err as Error).message));
    }
  }

  private deleteSecrets(id: string): void {
    this.secrets.delete(id);
    this.leftInDb.delete(id);
    this.unreadable.delete(id);
    try {
      this.keyring?.delete(secretName(id));
    } catch {
      /* nothing stored */
    }
  }

  view(): ToolLibraryView {
    const masked = (names: string[], values: Record<string, string>): MaskedVar[] =>
      names.map((name) => ({ name, masked: mask(values[name] ?? '') }));
    return {
      mcpServers: this.data.mcpServers.map<McpServerView>((s) => {
        const secrets = this.secrets.get(s.id) ?? { env: {}, headers: {} };
        return {
          id: s.id,
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: [...s.args],
          url: s.url,
          env: masked(s.env, secrets.env),
          headers: masked(s.headers, secrets.headers),
          providers: [...s.providers],
          ...(s.oauth
            ? { oauth: { status: s.oauth.status, signedInAt: s.oauth.signedInAt, ...(s.oauth.error ? { error: s.oauth.error } : {}) } }
            : {}),
        };
      }),
      skills: this.skills().map(({ dir, providers, name, description, problem }) => ({
        path: dir,
        name,
        description,
        providers: [...providers],
        ...(problem ? { problem } : {}),
      })),
      memory: { ...this.data.memory },
      relayTools: RELAY_TOOL_GROUPS.map((group) => ({ group, providers: [...(this.data.relayTools?.[group] ?? [])] })),
      gateway: this.gatewayStatus(),
      browser: { ...(this.data.browser ? { path: this.data.browser } : {}), ...this.browserStatus() },
      secretStorage: this.secretStorage,
    };
  }

  /** Whether the gateway can give agents Harness Relay's tools now (set by the server once it runs one). */
  gatewayStatus: () => ToolLibraryView['gateway'] = () => ({ available: false, reason: 'not-started' });

  /** `RELAY_BROWSER`, and the browser the browser tools would start now (set by the server). */
  browserStatus: () => Pick<ToolLibraryView['browser'], 'env' | 'using'> = () => ({});

  /** The browser set in Settings, if any: the browser tools start it before any other. */
  browserPath(): string | undefined {
    return this.data.browser;
  }

  /** Adds an MCP server (no `previousName`) or replaces one (renaming it when the names differ). */
  saveServer(name: string, u: McpServerUpdate): ToolLibraryView {
    const servers = this.data.mcpServers;
    const prev = u.previousName;
    const index = prev === undefined ? -1 : servers.findIndex((s) => s.name === prev);
    if (prev !== undefined && index < 0) throw new HttpError(404, t().mcpNotFound(prev));
    if (servers.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.name !== prev)) {
      throw new HttpError(409, t().mcpExists(name));
    }
    if (index < 0 && servers.length >= TOOL_LIMITS.maxMcpServers) throw new HttpError(400, t().tooManyMcp(TOOL_LIMITS.maxMcpServers));

    const id = index < 0 ? randomUUID().replace(/-/g, '').slice(0, 12) : servers[index]!.id;
    const old = (index >= 0 && this.secrets.get(id)) || { env: {}, headers: {} };
    const http = u.transport === 'http';
    const vars = (http ? u.headers : u.env) ?? [];
    // Values that could not be read cannot be kept: they would be saved empty over the real ones.
    if (index >= 0 && this.unreadable.has(id) && vars.some((v) => v.value === undefined)) {
      throw new HttpError(409, t().secretsUnreadable(servers[index]!.name));
    }
    const pick = (from: Record<string, string>) => Object.fromEntries(vars.map((v) => [v.name, v.value ?? from[v.name] ?? '']));
    const secrets: Secrets = { env: http ? {} : pick(old.env), headers: http ? pick(old.headers) : {} };
    const server: StoredServer = {
      id,
      name,
      transport: u.transport,
      command: http ? '' : (u.command ?? ''),
      args: http ? [] : (u.args ?? []),
      url: http ? (u.url ?? '') : '',
      env: Object.keys(secrets.env),
      headers: Object.keys(secrets.headers),
      providers: u.providers ?? [...PROVIDERS],
    };
    // Its sign-in stays while it is the same server (renamed, its headers or CLIs changed); another URL,
    // or no longer HTTP, is another server: its tokens go.
    const before = index >= 0 ? servers[index]! : undefined;
    const sameServer = Boolean(before && http && before.transport === 'http' && sameMcpUrl(before.url, server.url));
    if (sameServer && before?.oauth) server.oauth = before.oauth;

    // First: when the credential store fails, nothing changes. A rename keeps the same entry.
    this.writeSecrets(id, secrets);
    this.secrets.set(id, secrets);
    this.leftInDb.delete(id);
    this.unreadable.delete(id);
    if (index < 0) servers.push(server);
    else servers[index] = server;
    const dropped = before && !sameServer ? this.dropOAuth(before) : undefined;
    this.save();
    if (before && !sameServer) this.onMcpOAuthDropped(id, dropped);
    return this.view();
  }

  deleteServer(name: string): ToolLibraryView {
    const index = this.data.mcpServers.findIndex((s) => s.name === name);
    if (index < 0) throw new HttpError(404, t().mcpNotFound(name));
    const [server] = this.data.mcpServers.splice(index, 1);
    this.deleteSecrets(server!.id);
    const dropped = this.dropOAuth(server!);
    this.save();
    this.onMcpOAuthDropped(server!.id, dropped);
    return this.view();
  }

  /**
   * Told when a server's sign-in is gone (it was removed, its URL changed, or it signed out), with what it
   * had, if it had signed in: its access token is forgotten, its sign-ins under way end, and its tokens are
   * revoked (set by `McpOAuth`). Also for a server that never signed in, whose sign-in may be under way.
   */
  onMcpOAuthDropped: (serverId: string, dropped: DroppedMcpOAuth | undefined) => void = () => undefined;

  /** Takes a server's sign-in off it, and its secrets out of the credential store; what it had, to revoke. */
  private dropOAuth(server: StoredServer): DroppedMcpOAuth | undefined {
    const oauth = server.oauth;
    const secrets = this.mcpOAuthSecrets(server.id);
    delete server.oauth;
    this.oauthSecrets.delete(server.id);
    try {
      this.keyring?.delete(oauthSecretName(server.id));
    } catch {
      /* nothing stored */
    }
    return oauth ? { oauth, secrets } : undefined;
  }

  /** A server, by its name. */
  mcpServer(name: string): Readonly<StoredServer> | undefined {
    return this.data.mcpServers.find((s) => s.name === name);
  }

  /** A server, by its id. */
  mcpServerById(id: string): Readonly<StoredServer> | undefined {
    return this.data.mcpServers.find((s) => s.id === id);
  }

  /** A server's sign-in secrets (none when it has none, or the credential store cannot be read now). */
  mcpOAuthSecrets(id: string): McpOAuthSecrets {
    if (!this.keyring) return { ...this.oauthSecrets.get(id) };
    try {
      const raw = this.keyring.get(oauthSecretName(id));
      return raw ? (JSON.parse(raw) as McpOAuthSecrets) : {};
    } catch {
      return {};
    }
  }

  /** Writes a server's sign-in secrets (none: deletes them); a credential store that refuses is a 503 that says so. */
  private setMcpOAuthSecrets(id: string, secrets: McpOAuthSecrets): void {
    const kept: McpOAuthSecrets = {
      ...(secrets.refresh ? { refresh: secrets.refresh } : {}),
      ...(secrets.clientSecret ? { clientSecret: secrets.clientSecret } : {}),
    };
    const empty = !kept.refresh && !kept.clientSecret;
    if (!this.keyring) {
      if (empty) this.oauthSecrets.delete(id);
      else this.oauthSecrets.set(id, kept);
      return;
    }
    try {
      if (empty) this.keyring.delete(oauthSecretName(id));
      else this.keyring.set(oauthSecretName(id), JSON.stringify(kept));
    } catch (err) {
      throw new HttpError(503, t().oauthTokenNotSaved((err as Error).message));
    }
  }

  /**
   * A server's sign-in that worked: where it signed in, its client and state, and its secrets. The
   * secrets are written first: when the credential store refuses them, nothing changes.
   */
  mcpSignedIn(id: string, oauth: StoredMcpOAuth, secrets: McpOAuthSecrets): void {
    const server = this.data.mcpServers.find((s) => s.id === id);
    if (!server) throw new HttpError(404, t().mcpNotFound(id));
    this.setMcpOAuthSecrets(id, secrets);
    server.oauth = oauth;
    this.save();
  }

  /** The provider's new refresh token (it rotates them), in place of the one kept. */
  setMcpRefreshToken(id: string, token: string): void {
    this.setMcpOAuthSecrets(id, { ...this.mcpOAuthSecrets(id), refresh: token });
  }

  /** Its sign-in no longer works: it needs a new one (Settings and the turns' notes say so). */
  mcpNeedsSignIn(id: string, why: string): void {
    const server = this.data.mcpServers.find((s) => s.id === id);
    if (!server?.oauth) return;
    server.oauth = { ...server.oauth, status: 'reauth', error: why };
    this.save();
  }

  /** Its client was refused (expired, purged): it needs a new sign-in, which registers a client again. */
  mcpClientRefused(id: string, why: string): void {
    const server = this.data.mcpServers.find((s) => s.id === id);
    if (!server?.oauth) return;
    server.oauth = { ...server.oauth, status: 'reauth', error: why, clientRefused: true };
    this.save();
  }

  /** Signs a server out: its sign-in and its secrets go; what it had comes back, for the caller to revoke (`McpOAuth.signOut()`). */
  mcpSignOut(id: string): DroppedMcpOAuth | undefined {
    const server = this.data.mcpServers.find((s) => s.id === id);
    if (!server) throw new HttpError(404, t().mcpNotFound(id));
    const dropped = this.dropOAuth(server);
    this.save();
    return dropped;
  }

  /** Replaces the skill list and / or the memory. New skill paths are checked; known ones are kept as they are. */
  update(u: ToolLibraryUpdate): ToolLibraryView {
    if (u.skills) {
      const known = new Set(this.data.skills.map((s) => s.path));
      const next: { path: string; providers: Provider[] }[] = [];
      const seen = new Set<string>();
      for (const s of u.skills) {
        const paths = known.has(s.path) ? [s.path] : findSkills(s.path);
        if (!paths.length) throw new HttpError(400, t().noSkillsIn(s.path));
        for (const path of paths) {
          if (seen.has(path)) continue;
          seen.add(path);
          next.push({ path, providers: s.providers ?? [...PROVIDERS] });
        }
      }
      if (next.length > TOOL_LIMITS.maxSkills) throw new HttpError(400, t().tooManySkills(TOOL_LIMITS.maxSkills));
      this.data.skills = next;
    }
    if (u.memory) this.data.memory = { ...this.data.memory, ...u.memory };
    if (u.relayTools) {
      const next = { ...(this.data.relayTools ?? {}) };
      for (const group of RELAY_TOOL_GROUPS) {
        const providers = u.relayTools[group];
        if (providers) next[group] = PROVIDERS.filter((p) => providers.includes(p));
      }
      this.data.relayTools = next;
    }
    if (u.browser !== undefined) {
      if (u.browser) this.data.browser = u.browser;
      else delete this.data.browser;
    }
    this.save();
    return this.view();
  }

  /** The skills under `path`, to pick from before adding them. */
  scanSkills(path: string): SkillCandidate[] {
    const added = new Set(this.data.skills.map((s) => s.path));
    return scanSkills(path).flatMap((dir) => {
      const skill = readSkill(dir);
      return skill ? [{ path: dir, ...skill, added: added.has(dir) }] : [];
    });
  }

  /** The skills as they are on disk now, in list order; later ones with a name taken are marked. */
  private skills(): (SkillInfo & { providers: Provider[]; problem?: string })[] {
    const names = new Set<string>();
    return this.data.skills.map(({ path, providers }) => {
      const skill = readSkill(path);
      const name = skill?.name ?? basename(path);
      let problem: string | undefined;
      if (!skill) problem = t().skillMissing;
      else if (names.has(name.toLowerCase())) problem = t().skillDuplicate(name);
      if (!problem) names.add(name.toLowerCase());
      return { name, description: skill?.description ?? '', dir: path, file: join(path, SKILL_FILE), providers, problem };
    });
  }

  /** Tries again to read values the credential store would not give at startup (it may be unlocked now). */
  private readAgain(): void {
    if (!this.keyring) return;
    for (const id of [...this.unreadable]) {
      try {
        const raw = this.keyring.get(secretName(id));
        const secrets = raw ? (JSON.parse(raw) as Partial<Secrets>) : {};
        this.secrets.set(id, { env: secrets.env ?? {}, headers: secrets.headers ?? {} });
        this.unreadable.delete(id);
      } catch {
        /* still locked */
      }
    }
  }

  /**
   * The library items `agent` gets, with the MCP servers' secret values. A server whose values
   * cannot be read is left out: started without its token it would only fail.
   */
  forAgent(agent: Pick<AgentConfig, 'tools' | 'provider'>): AgentTools {
    this.readAgain();
    const on = (key: string, providers: Provider[]) => agentHasTool(agent, key, providers.includes(agent.provider));
    const given = this.data.mcpServers.filter((s) => !this.unreadable.has(s.id) && on(toolKey('mcp', s.id), s.providers));
    // Not for a CLI that takes no HTTP MCP server (they are left out of its runs): no token, no refresh, no note.
    const oauthServers = NO_HTTP_MCP.includes(agent.provider)
      ? []
      : given.filter((s) => s.transport === 'http' && s.oauth).map((s) => ({ name: s.name, id: s.id }));
    const mcpServers = given.map<McpServerSpec>((s) => {
      const secrets = this.secrets.get(s.id) ?? { env: {}, headers: {} };
      return {
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: [...s.args],
        url: s.url,
        env: { ...secrets.env },
        headers: { ...secrets.headers },
      };
    });
    const skills = this.skills()
      .filter((s) => !s.problem && on(toolKey('skill', s.dir), s.providers))
      .map(({ name, description, dir, file }) => ({ name, description, dir, file }));
    const memory = (['all', agent.provider] as const)
      .filter((scope) => agentHasTool(agent, toolKey('memory', scope), true))
      .map((scope) => this.data.memory[scope].trim())
      .filter(Boolean)
      .join('\n\n');
    const relayGroups = RELAY_TOOL_GROUPS.filter((g) => on(toolKey('relay', g), this.data.relayTools?.[g] ?? []));
    return { mcpServers, skills, ...(memory ? { memory } : {}), relayGroups, ...(oauthServers.length ? { oauthServers } : {}) };
  }
}

/** The tool groups' CLIs as stored, leaving out what cannot be read. */
function storedRelayTools(v: unknown): Partial<Record<RelayToolGroup, Provider[]>> {
  if (!v || typeof v !== 'object') return {};
  const out: Partial<Record<RelayToolGroup, Provider[]>> = {};
  for (const group of RELAY_TOOL_GROUPS) {
    const list = (v as Record<string, unknown>)[group];
    if (Array.isArray(list)) out[group] = PROVIDERS.filter((p) => list.includes(p));
  }
  return out;
}
