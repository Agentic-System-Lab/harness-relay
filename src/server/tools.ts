import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  MEMORY_SCOPES,
  PROVIDERS,
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
  type SkillCandidate,
  type SkillView,
  type ToolLibraryUpdate,
  type ToolLibraryView,
} from '../shared/types';
import type { McpServerSpec } from './agents/types';
import type { Database } from './db';
import { HttpError } from './errors';
import { t } from './i18n';
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
}

interface Secrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

interface Stored {
  mcpServers: StoredServer[];
  skills: { path: string; providers: Provider[] }[];
  memory: Record<MemoryScope, string>;
  /** Without a secret store (tests), or saved by an older version: the secret values, by server id. */
  secrets?: Record<string, Secrets>;
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
}

const SETTINGS_KEY = 'tool_library';
/** A server's entry in the credential store, named after its id. */
const secretName = (serverId: string) => `mcp-${serverId}`;
const SKILL_FILE = 'SKILL.md';
const MAX_DESCRIPTION = 1024;

const emptyMemory = (): Record<MemoryScope, string> => Object.fromEntries(MEMORY_SCOPES.map((s) => [s, ''])) as Record<MemoryScope, string>;

/** An item's CLIs as stored; data saved before items had them has `enabled` instead. */
function storedProviders(v: { providers?: unknown; enabled?: unknown }): Provider[] {
  if (Array.isArray(v.providers)) return PROVIDERS.filter((p) => (v.providers as unknown[]).includes(p));
  return v.enabled === false ? [] : [...PROVIDERS];
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
          ...(v.secrets ? { secrets: v.secrets } : {}),
        };
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
    const stored: Stored = { mcpServers: this.data.mcpServers, skills: this.data.skills, memory: this.data.memory };
    const inDb = this.keyring ? [...this.leftInDb] : [...this.secrets.keys()];
    if (inDb.length) stored.secrets = Object.fromEntries(inDb.map((id) => [id, this.secrets.get(id)!]));
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
      secretStorage: this.secretStorage,
    };
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

    // First: when the credential store fails, nothing changes. A rename keeps the same entry.
    this.writeSecrets(id, secrets);
    this.secrets.set(id, secrets);
    this.leftInDb.delete(id);
    this.unreadable.delete(id);
    if (index < 0) servers.push(server);
    else servers[index] = server;
    this.save();
    return this.view();
  }

  deleteServer(name: string): ToolLibraryView {
    const index = this.data.mcpServers.findIndex((s) => s.name === name);
    if (index < 0) throw new HttpError(404, t().mcpNotFound(name));
    const [server] = this.data.mcpServers.splice(index, 1);
    this.deleteSecrets(server!.id);
    this.save();
    return this.view();
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
    const mcpServers = this.data.mcpServers
      .filter((s) => !this.unreadable.has(s.id) && on(toolKey('mcp', s.id), s.providers))
      .map<McpServerSpec>((s) => {
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
    return { mcpServers, skills, ...(memory ? { memory } : {}) };
  }
}
