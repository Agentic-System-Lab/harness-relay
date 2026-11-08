import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PROVIDER_LABEL, type NativeMemoryFile, type NativeSetup, type NativeSkill, type Provider } from '../shared/types';
import { parseJsonLine } from './agents/types';
import { t } from './i18n';
import { runProcess } from './process';

/*
 * What each CLI loads by itself — its own skills, MCP servers and memory — asked from the CLI the
 * way an IDE would, without sending a prompt (so no model is called):
 * - Claude Code: stream-json control requests `initialize` (its commands, skills among them) and
 *   `mcp_status`. Starting it runs the user's SessionStart hooks and connects its MCP servers.
 * - Codex: `codex app-server` requests `skills/list` and `config/read` (configured MCP servers).
 * - Grok: `grok inspect --json`.
 * Claude Code and Codex have no list of the instruction and memory files they read, so those come
 * from the files at the places they are documented to read. Only names, descriptions, paths and
 * states are kept: MCP server configs (which can hold tokens) never leave this module.
 */

const PROBE_TIMEOUT_MS = 30_000;

type Json = Record<string, any>;

/**
 * Runs a CLI that speaks JSON lines on stdin/stdout: `open` writes the first message, `onMessage`
 * answers and calls `finish` when it has what it needs. Resolves on finish, exit or timeout.
 */
async function converse(o: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  open: (write: (msg: unknown) => void) => void;
  onMessage: (msg: Json, write: (msg: unknown) => void, finish: () => void) => void;
}): Promise<{ stderr: string; timedOut: boolean }> {
  const stop = new AbortController();
  let write: (msg: unknown) => void = () => undefined;
  const res = await runProcess({
    bin: o.bin,
    args: o.args,
    cwd: o.cwd,
    env: o.env,
    keepStdinOpen: true,
    signal: stop.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxCapture: 1024,
    onSpawn: (child) => {
      write = (msg) => {
        if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
      };
      o.open(write);
    },
    onLine: (line) => {
      const msg = parseJsonLine(line);
      if (msg) o.onMessage(msg, write, () => stop.abort());
    },
  });
  return { stderr: res.stderr, timedOut: res.timedOut };
}

const short = (s: string) => s.trim().split('\n').slice(-3).join(' ').slice(0, 300);

/**
 * Something a probe could not find out. Kept as data, not text: answers are cached, and the text
 * follows the language of each request (`nativeProblemText`).
 */
export type NativeProblem =
  | { kind: 'timeout' }
  | { kind: 'no-answer'; part: 'all' | 'skills' | 'mcp' }
  | { kind: 'failed'; detail: string };

/** A probe's answer before its problems are put into words. */
export type NativeProbe = Omit<NativeSetup, 'errors'> & { problems: NativeProblem[] };

/** What a probe that ended without some answers reports: a timeout, the CLI's own words, or the parts missing. */
function missing(parts: ('skills' | 'mcp')[], all: boolean, res: { stderr: string; timedOut: boolean }): NativeProblem[] {
  if (res.timedOut) return [{ kind: 'timeout' }];
  if (all) return short(res.stderr) ? [{ kind: 'failed', detail: short(res.stderr) }] : [{ kind: 'no-answer', part: 'all' }];
  return parts.map((part) => ({ kind: 'no-answer', part }));
}

// --- Claude Code ---------------------------------------------------------------------------

/** Skills (and the other non-built-in commands) and MCP servers from Claude Code's control responses. */
export function parseClaudeProbe(init: Json | undefined, mcp: Json | undefined): Pick<NativeSetup, 'skills' | 'mcpServers'> {
  const commands: Json[] = Array.isArray(init?.commands) ? init!.commands : [];
  const servers: Json[] = Array.isArray(mcp?.mcpServers) ? mcp!.mcpServers : [];
  return {
    skills: commands
      .filter((c) => !c.builtin && typeof c.name === 'string')
      .map((c) => ({ name: c.name, description: String(c.description ?? '') })),
    mcpServers: servers
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        ...(typeof s.status === 'string' ? { status: s.status } : {}),
        ...(typeof (s.scope ?? s.source) === 'string' ? { source: String(s.scope ?? s.source) } : {}),
        ...(typeof (s.transport ?? s.config?.type) === 'string' ? { transport: String(s.transport ?? s.config?.type) } : {}),
        ...(Array.isArray(s.tools) ? { tools: s.tools.length } : {}),
      })),
  };
}

/** The folders from `cwd` up to the filesystem root, nearest first. */
function upFrom(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) return dirs;
  }
}

/** The repository root above `cwd` (a folder with `.git`), if any. */
function gitRoot(cwd: string): string | undefined {
  return upFrom(cwd).find((d) => existsSync(join(d, '.git')));
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The Markdown files directly in a folder. */
function markdownIn(dir: string, limit = 50): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .sort()
      .slice(0, limit)
      .map((n) => join(dir, n))
      .filter(isFile);
  } catch {
    return [];
  }
}

/** Claude Code's project folder name for a path (every character but letters and digits becomes `-`). */
export const claudeProjectSlug = (path: string) => resolve(path).replace(/[^A-Za-z0-9]/g, '-');

/**
 * The instruction and memory files Claude Code reads for `cwd`: CLAUDE.md and rules in its config
 * folder, CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md / .claude/rules in each folder up from
 * `cwd`, and its auto memory for the project.
 */
export function claudeMemoryFiles(cwd: string, configDir: string): NativeMemoryFile[] {
  const instructions = [join(configDir, 'CLAUDE.md'), ...markdownIn(join(configDir, 'rules'))];
  for (const dir of upFrom(cwd).reverse()) {
    instructions.push(join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'), join(dir, '.claude', 'CLAUDE.md'));
    instructions.push(...markdownIn(join(dir, '.claude', 'rules')));
  }
  const roots = [...new Set([resolve(cwd), gitRoot(cwd)].filter((d): d is string => Boolean(d)))];
  const memory = roots.flatMap((d) => markdownIn(join(configDir, 'projects', claudeProjectSlug(d), 'memory')));
  return [
    ...[...new Set(instructions)].filter(isFile).map((path) => ({ path, kind: 'instructions' as const })),
    ...[...new Set(memory)].map((path) => ({ path, kind: 'memory' as const })),
  ];
}

async function probeClaude(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<NativeProbe> {
  let init: Json | undefined;
  let mcp: Json | undefined;
  const problems: NativeProblem[] = [];
  const res = await converse({
    bin,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    cwd,
    env,
    open: (write) => write({ type: 'control_request', request_id: 'relay-init', request: { subtype: 'initialize' } }),
    onMessage: (m, write, finish) => {
      if (m.type !== 'control_response') return;
      const r = m.response ?? {};
      if (r.subtype === 'error') problems.push({ kind: 'failed', detail: String(r.error ?? 'error') });
      if (r.request_id === 'relay-init') {
        init = r.response;
        write({ type: 'control_request', request_id: 'relay-mcp', request: { subtype: 'mcp_status' } });
      } else if (r.request_id === 'relay-mcp') {
        mcp = r.response;
        finish();
      }
    },
  });
  problems.push(...missing([...(init ? [] : ['skills' as const]), ...(mcp ? [] : ['mcp' as const])], !init && !mcp, res));
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return {
    provider: 'claude',
    cwd,
    ...parseClaudeProbe(init, mcp),
    memory: claudeMemoryFiles(cwd, configDir),
    memoryFromFiles: true,
    problems,
    checkedAt: Date.now(),
  };
}

// --- Codex ---------------------------------------------------------------------------------

/** Skills from `skills/list` and the configured MCP servers from `config/read` (names and kinds only). */
export function parseCodexProbe(skills: Json | undefined, config: Json | undefined): Pick<NativeSetup, 'skills' | 'mcpServers'> {
  const entries: Json[] = Array.isArray(skills?.data) ? skills!.data : [];
  const seen = new Set<string>();
  const list: NativeSkill[] = [];
  for (const s of entries.flatMap((e) => (Array.isArray(e.skills) ? e.skills : []))) {
    if (typeof s?.name !== 'string' || seen.has(`${s.name}\0${s.path}`)) continue;
    seen.add(`${s.name}\0${s.path}`);
    list.push({
      name: s.name,
      description: String(s.shortDescription || s.description || ''),
      ...(typeof s.scope === 'string' ? { source: s.scope } : {}),
      ...(typeof s.path === 'string' ? { path: s.path } : {}),
      ...(s.enabled === false ? { enabled: false } : {}),
    });
  }
  const servers = config?.config?.mcp_servers;
  return {
    skills: list,
    mcpServers:
      servers && typeof servers === 'object'
        ? Object.entries(servers as Record<string, Json>).map(([name, c]) => ({
            name,
            transport: c?.url ? 'http' : 'stdio',
            ...(c?.enabled === false ? { status: 'disabled' } : {}),
          }))
        : [],
  };
}

/**
 * The instruction files Codex reads for `cwd`: AGENTS.override.md or AGENTS.md in its home, then in
 * each folder from the repository root down to `cwd`; and the notes in its memories folder.
 */
export function codexMemoryFiles(cwd: string, codexHome: string): NativeMemoryFile[] {
  const pick = (dir: string) => [join(dir, 'AGENTS.override.md'), join(dir, 'AGENTS.md')].find(isFile);
  const root = gitRoot(cwd) ?? resolve(cwd);
  const dirs = upFrom(cwd).filter((d) => d.startsWith(root)).reverse();
  const instructions = [pick(codexHome), ...dirs.map(pick)].filter((p): p is string => Boolean(p));
  return [
    ...instructions.map((path) => ({ path, kind: 'instructions' as const })),
    ...markdownIn(join(codexHome, 'memories')).map((path) => ({ path, kind: 'memory' as const })),
  ];
}

async function probeCodex(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<NativeProbe> {
  let skills: Json | undefined;
  let config: Json | undefined;
  const problems: NativeProblem[] = [];
  const res = await converse({
    bin,
    args: ['app-server'],
    cwd,
    env,
    open: (write) =>
      write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'harness_relay', title: 'Harness Relay', version: '0.1.0' }, capabilities: null } }),
    onMessage: (m, write, finish) => {
      if (m.id === undefined || m.method) return;
      if (m.error) problems.push({ kind: 'failed', detail: String(m.error.message ?? 'error') });
      if (m.id === 1) {
        write({ jsonrpc: '2.0', method: 'initialized' });
        write({ jsonrpc: '2.0', id: 2, method: 'skills/list', params: { cwds: [cwd] } });
        write({ jsonrpc: '2.0', id: 3, method: 'config/read', params: { cwd } });
        return;
      }
      if (m.id === 2) skills = m.result ?? {};
      if (m.id === 3) config = m.result ?? {};
      if (skills && config) finish();
    },
  });
  problems.push(...missing([...(skills ? [] : ['skills' as const]), ...(config ? [] : ['mcp' as const])], !skills && !config, res));
  return {
    provider: 'codex',
    cwd,
    ...parseCodexProbe(skills, config),
    memory: codexMemoryFiles(cwd, env.CODEX_HOME || join(homedir(), '.codex')),
    memoryFromFiles: true,
    problems,
    checkedAt: Date.now(),
  };
}

// --- Grok ----------------------------------------------------------------------------------

/** Skills, MCP servers and instruction files from `grok inspect --json`. */
export function parseGrokInspect(d: Json | undefined): Pick<NativeSetup, 'skills' | 'mcpServers' | 'memory' | 'folderTrusted'> {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
  const source = (s: Json | undefined) => (s?.plugin_name ? `plugin: ${s.plugin_name}` : typeof s?.type === 'string' ? s.type : undefined);
  return {
    skills: list(d?.skills)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        description: String(s.description ?? ''),
        ...(source(s.source) ? { source: source(s.source) } : {}),
        ...(typeof s.source?.path === 'string' ? { path: s.source.path } : {}),
      })),
    mcpServers: list(d?.mcpServers)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        ...(typeof s.transport === 'string' ? { transport: s.transport } : {}),
        ...(source(s.source) ? { source: source(s.source) } : {}),
      })),
    memory: list(d?.projectInstructions)
      .filter((p) => typeof p.path === 'string')
      .map((p) => ({ path: p.path, kind: 'instructions' as const })),
    ...(typeof d?.projectTrusted === 'boolean' ? { folderTrusted: d.projectTrusted } : {}),
  };
}

async function probeGrok(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<NativeProbe> {
  let data: Json | undefined;
  const res = await runProcess({ bin, args: ['inspect', '--json'], cwd, env, timeoutMs: PROBE_TIMEOUT_MS, maxCapture: 20 * 1024 * 1024 });
  try {
    data = JSON.parse(res.stdout) as Json;
  } catch {
    data = undefined;
  }
  const problems = data ? [] : missing([], true, res);
  return { provider: 'grok', cwd, ...parseGrokInspect(data), memoryFromFiles: false, problems, checkedAt: Date.now() };
}

const PROBES: Record<Provider, (bin: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<NativeProbe>> = {
  claude: probeClaude,
  codex: probeCodex,
  grok: probeGrok,
};

const CACHE_MS = 60_000;

/** Asks each CLI what it loads by itself; answers are kept for a minute per CLI, executable and folder. */
export class NativeSetupService {
  private cache = new Map<string, { at: number; result: Promise<NativeProbe> }>();

  constructor(private settings: { bin(p: Provider): string; env(p: Provider): NodeJS.ProcessEnv }) {}

  get(provider: Provider, cwd: string, refresh = false): Promise<NativeProbe> {
    const bin = this.settings.bin(provider);
    const key = `${provider}\0${bin}\0${cwd}`;
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit.result;
    const result = PROBES[provider](bin, this.settings.env(provider), cwd).catch(
      (err: Error): NativeProbe => ({
        provider,
        cwd,
        skills: [],
        mcpServers: [],
        memory: [],
        memoryFromFiles: provider !== 'grok',
        problems: [{ kind: 'failed', detail: err.message }],
        checkedAt: Date.now(),
      }),
    );
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }
}

/**
 * Whether `path` is one of the files the probe reported (an instruction or memory file, or a
 * skill's SKILL.md): only those can be previewed, so no other file on the computer can be read.
 */
export function listedFile(probe: Pick<NativeSetup, 'memory' | 'skills'>, path: string): boolean {
  return probe.memory.some((m) => m.path === path) || probe.skills.some((s) => s.path === path);
}

/** A probe's answer for the client, its problems in the language of this request. */
export function nativeForClient(probe: NativeProbe): NativeSetup {
  const { problems, ...rest } = probe;
  return { ...rest, errors: problems.map((p) => nativeProblemText(probe.provider, p)) };
}

export function nativeProblemText(provider: Provider, p: NativeProblem): string {
  const m = t();
  const cli = PROVIDER_LABEL[provider];
  if (p.kind === 'timeout') return m.nativeTimeout(cli);
  if (p.kind === 'failed') return m.nativeFailed(cli, p.detail);
  return m.nativeNoAnswer(cli, p.part);
}
