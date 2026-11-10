import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativePart, Permission } from '../../shared/types';
import { isPublishCommand } from '../commands';
import { runProcess, tail } from '../process';
import { commandPaths, patternPath, protectedReads, realPath } from '../protect';
import { JsonRpcConnection, RpcError } from './acp';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  imageData,
  summarizeInput,
  tailText,
  webSearchDetail,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunOptions,
  type RunResult,
} from './types';
import { t } from '../i18n';

/** ACP prompt blocks: the text, plus attached images (Grok advertises promptCapabilities.image). */
export function grokPrompt(prompt: string, images: RunOptions['images']): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: prompt }];
  for (const img of images ?? []) {
    const data = imageData(img.path);
    if (data) blocks.push({ type: 'image', data, mimeType: img.mimeType });
  }
  return blocks;
}

/*
 * Grok runs as an ACP agent (`grok agent stdio`: JSON-RPC over stdin/stdout), not headless `grok -p`.
 *
 * Headless grok cannot ask for approval: a tool call that would prompt is reported as "User
 * cancelled" and the whole turn ends (`stopReason: "cancelled"`), so one refused command cut a
 * reply off mid-way. Over ACP the permission request comes to us instead, and rejecting it with a
 * `followup_message` hands our reason to the model, which then carries on with the turn.
 *
 * - read-only: grok asks; web fetch runs, anything else goes to the user (or is refused when the
 *   conversation does not ask). Grok still runs its built-in read-only tools and commands without
 *   asking (and bare `mkdir` / `touch`).
 * - edit: grok asks; everything runs except publishing (git push, npm publish…), which goes to
 *   the user.
 * - Both run inside the `workspace` sandbox: the kernel confines writes, Grok's own tools included,
 *   to the working directory, `~/.grok` and the temp dirs (on macOS it cannot block the network).
 * - full: always-approve; no profile is set (one the user set for Grok, if any, still applies).
 *
 * The session's mode is set explicitly (`_meta.yoloMode`) so a user-level
 * `[ui] permission_mode = "always-approve"` in ~/.grok/config.toml cannot widen read-only or edit.
 */

/**
 * The custom sandbox profile Harness Relay keeps in Grok's `sandbox.toml`, for read-only and edit:
 * `workspace` plus a kernel `deny` for the protected paths (`protectedReads()`: the browsers'
 * folders, Harness Relay's database). A custom profile Grok cannot apply makes it refuse to start,
 * where a built-in one might run without a sandbox.
 * - Read-only uses it too, and keeps the project's files to what the user allows: Grok's `read-only`
 *   and `strict` profiles refuse to start on some machines (e.g. a symlinked /var/run/docker.sock),
 *   and a profile cannot be lifted once applied, so a write the user allowed would fail under them.
 * - One profile for both also lets a session resume after the permission changes between them
 *   (Grok refuses to resume a session under a different profile).
 * - A project's own `.grok/sandbox.toml` cannot redefine it: the user's file wins.
 */
export const GROK_PROFILE = 'harness-relay';

/** The profile per permission (`GROK_SANDBOX`): none with full access; on Windows, where Grok has no sandbox, `workspace` as before. */
export function grokSandboxProfile(permission: Permission, platform: NodeJS.Platform = process.platform): string | undefined {
  if (permission === 'full') return undefined;
  return platform === 'win32' ? 'workspace' : GROK_PROFILE;
}

const PROFILE_BEGIN = '# >>> harness-relay: written by Harness Relay before each run; changes here are replaced';
const PROFILE_END = '# <<< harness-relay';

/**
 * Grok's programs in its own folder (`bin`, `downloads`), which its `workspace` sandbox would let its
 * commands write: a changed one would run outside any sandbox the next time Grok starts. Denied to
 * its sandbox (Grok runs from memory once started), with the folder of the program Harness Relay
 * starts (`bins`, from `commandPaths`); those that exist (a sandbox may refuse to start for a path
 * that does not), each also by its real path.
 */
export function grokPrograms(home: string, bins: readonly string[] = []): string[] {
  const paths = [join(home, 'bin'), join(home, 'downloads'), ...bins.map((bin) => dirname(bin))].filter((p) => existsSync(p));
  return [...new Set(paths.flatMap((p) => [p, realPath(p)]))];
}

/**
 * Grok's settings in its own folder that decide what it runs and how (its sandbox profiles, MCP
 * servers, hooks, trust, the managed and required settings). Its sandbox lets its commands write
 * them, and Grok reads them after its sandbox is on, so they cannot be denied: they are checked
 * around each turn instead (`guardGrokSettings`).
 */
export const GROK_SETTINGS = [
  'sandbox.toml',
  'config.toml',
  'managed_config.toml',
  'requirements.toml',
  'trusted_folders.toml',
  'permission.toml',
  'hooks-paths',
];

/** Grok's skills, which are reported when a turn changed them (not put back: they are folders). */
const GROK_SKILLS = 'skills';

/**
 * One of Grok's settings as it was, by its name in Grok's home (a link is not followed to decide
 * what it is): none, a file (its content and mode), a link (where it leads, the real path of that and
 * what it reads there: null when no file is there) or something else, such as a folder or a file it
 * cannot read (taken by its type only).
 */
type GrokEntry =
  | { kind: 'none' }
  | { kind: 'file'; content: Buffer; mode: number }
  | { kind: 'link'; target: string; real: string; content: Buffer | null }
  | { kind: 'other'; type: number };

/** The type of a setting that could not be read. */
const UNREADABLE = -1;

/** What `snapshotGrokSettings` keeps: each setting as it was, and a fingerprint of the skills. */
export interface GrokSettingsSnapshot {
  home: string;
  entries: Map<string, GrokEntry>;
  skills: string;
}

/** Sizes, times and names of what a folder holds, as a fingerprint of it (empty when it is not there). */
function folderFingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(d, name);
      try {
        const st = lstatSync(path);
        out.push(`${path} ${st.size} ${st.mtimeMs} ${st.mode}`);
        if (st.isDirectory() && depth < 6) walk(path, depth + 1);
      } catch {
        out.push(`${path} ?`);
      }
    }
  };
  walk(dir, 0);
  return out.join('\n');
}

/**
 * A setting as it is now. A file of a size other than `size`, or over `max` bytes, is not read: it is
 * then undefined (a link's, too), since it has changed.
 */
function grokEntry(path: string, expect: { size?: number; max?: number } = {}): GrokEntry | undefined {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: 'none' };
  }
  const fits = (bytes: number) => (expect.size === undefined || bytes === expect.size) && (expect.max === undefined || bytes <= expect.max);
  if (st.isSymbolicLink()) {
    let target: Stats | undefined;
    try {
      target = statSync(path);
    } catch {
      // leads nowhere
    }
    if (target?.isFile() && !fits(target.size)) return undefined;
    return { kind: 'link', target: readlinkSync(path), real: realPath(path), content: target?.isFile() ? readFileSync(path) : null };
  }
  if (!st.isFile()) return { kind: 'other', type: st.mode & constants.S_IFMT };
  if (!fits(st.size)) return undefined;
  return { kind: 'file', content: readFileSync(path), mode: st.mode & 0o7777 };
}

/** `sandbox.toml` without Harness Relay's own block, which each run writes again (`withGrokProfile`). */
function outsideProfile(name: string, content: Buffer | null): string | null {
  if (content === null) return null;
  const text = content.toString('latin1');
  if (name !== 'sandbox.toml') return text;
  const start = text.indexOf(PROFILE_BEGIN);
  const end = start < 0 ? -1 : text.indexOf(PROFILE_END, start);
  return end < 0 ? text : text.slice(0, start) + PROFILE_BEGIN + text.slice(end);
}

/** Whether a setting is as it was (for `sandbox.toml`, outside Harness Relay's block). */
function sameEntry(name: string, before: GrokEntry, path: string): boolean {
  const content = before.kind === 'file' || before.kind === 'link' ? before.content : null;
  // Harness Relay's own block may change its size by a little; other files are read only when their size is the same.
  const expect = content === null ? { max: 0 } : name === 'sandbox.toml' ? { max: content.length + (1 << 20) } : { size: content.length };
  let now: GrokEntry | undefined;
  try {
    now = grokEntry(path, expect);
  } catch {
    return before.kind === 'other' && before.type === UNREADABLE;
  }
  // An empty file is no setting, as none is: Grok's sandbox makes its settings files, empty, when
  // they are not there (seen with grok 1.0.77), and they must not count as changed.
  const empty = (e: GrokEntry) => e.kind === 'none' || (e.kind === 'file' && e.content.length === 0);
  if (now && empty(now) && empty(before)) return true;
  if (!now || now.kind !== before.kind) return false;
  if (now.kind === 'none') return true;
  if (now.kind === 'other') return before.kind === 'other' && now.type === before.type;
  if (now.kind === 'link' && before.kind === 'link' && now.target !== before.target) return false;
  return outsideProfile(name, now.content) === outsideProfile(name, content);
}

/** Writes a file whole beside it and renames it into place: whatever is at `path` (a link too) is replaced, not followed. */
function replaceFile(path: string, content: Buffer, mode = 0o600): void {
  const temp = `${path}.relay-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode });
  try {
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** A name beside `path` that is free now, for the changed setting. */
function asideName(path: string, now: number): string {
  const name = `${path}.changed-${now}`;
  try {
    lstatSync(name);
  } catch {
    return name;
  }
  return `${name}-${randomBytes(4).toString('hex')}`;
}

/** Reads Grok's settings, each by its name in Grok's home (a link as a link). */
export function snapshotGrokSettings(home: string): GrokSettingsSnapshot {
  const entries = new Map<string, GrokEntry>();
  for (const name of GROK_SETTINGS) {
    let entry: GrokEntry | undefined;
    try {
      entry = grokEntry(join(home, name));
    } catch {
      entry = undefined;
    }
    entries.set(name, entry ?? { kind: 'other', type: UNREADABLE });
  }
  return { home, entries, skills: folderFingerprint(join(home, GROK_SKILLS)) };
}

/**
 * Puts back each of Grok's settings that is not as `before` found it: what is there now is moved
 * aside (`<name>.changed-<time>`, for the user to look at; renamed, so nothing is followed or read),
 * and what was there is written again beside it and renamed into place (a link made again, and what
 * it led to written again when that changed). Names what changed, the skills too. Never throws: a
 * setting it cannot put back is still named.
 */
export function restoreGrokSettings(before: GrokSettingsSnapshot, home = before.home, now = Date.now()): string[] {
  const changed: string[] = [];
  for (const [name, was] of before.entries) {
    const path = join(home, name);
    try {
      if (sameEntry(name, was, path)) continue;
    } catch {
      // unreadable now: put back below
    }
    changed.push(name);
    try {
      const current = (() => {
        try {
          return lstatSync(path);
        } catch {
          return undefined;
        }
      })();
      // Only the file a link leads to changed: keep a copy of it, and write it as it was.
      if (was.kind === 'link' && current?.isSymbolicLink() && readlinkSync(path) === was.target) {
        try {
          copyFileSync(path, asideName(path, now), constants.COPYFILE_EXCL);
        } catch {
          // not kept
        }
        if (was.content) replaceFile(was.real, was.content);
        continue;
      }
      if (was.kind === 'other') continue; // a folder or the like: named, not put back
      if (current) renameSync(path, asideName(path, now));
      if (was.kind === 'file') replaceFile(path, was.content, was.mode);
      else if (was.kind === 'link') {
        const temp = `${path}.relay-${randomBytes(6).toString('hex')}.tmp`;
        symlinkSync(was.target, temp);
        renameSync(temp, path);
        if (was.content && !sameEntry(name, was, path)) replaceFile(was.real, was.content);
      }
    } catch (err) {
      console.error(`[grok] could not put back ${path}:`, (err as Error).message);
    }
  }
  if (folderFingerprint(join(home, GROK_SKILLS)) !== before.skills) changed.push(GROK_SKILLS);
  return changed;
}

/**
 * Harness Relay itself wrote one of Grok's settings (its trust store, when the user trusts a folder):
 * the sandboxed turns now running take it as it is now, rather than putting it back.
 */
export function grokSettingWritten(home: string, name: string): void {
  const guard = grokGuards.get(realPath(home));
  if (!guard) return;
  let entry: GrokEntry | undefined;
  try {
    entry = grokEntry(join(home, name));
  } catch {
    entry = undefined;
  }
  guard.snapshot.entries.set(name, entry ?? { kind: 'other', type: UNREADABLE });
}

/** The settings each Grok home had before the first of its sandboxed turns now running started. */
const grokGuards = new Map<string, { snapshot: GrokSettingsSnapshot; turns: number; found: string[] }>();

/**
 * Guards Grok's settings around one sandboxed turn; `write` writes what Harness Relay itself keeps
 * there for the turn (its profile). Turns of the same Grok home at the same time share what the
 * settings were before the first of them: so a turn starting while another runs neither takes a
 * change that one's commands made for the settings as they were (it is put back first), nor puts it
 * back afterwards. Returns what to call once the turn is over: the settings changed during it, which
 * it has put back (`restoreGrokSettings`).
 */
export function guardGrokSettings(home: string, write: () => void = () => undefined): () => string[] {
  const key = realPath(home);
  let guard = grokGuards.get(key);
  if (guard) guard.found.push(...restoreGrokSettings(guard.snapshot, home));
  write();
  if (!guard) {
    guard = { snapshot: snapshotGrokSettings(home), turns: 0, found: [] };
    grokGuards.set(key, guard);
  }
  const g = guard;
  const start = g.found.length;
  g.turns++;
  let over = false;
  return () => {
    if (over) return [];
    over = true;
    g.found.push(...restoreGrokSettings(g.snapshot, home));
    const changed = [...new Set(g.found.slice(start))];
    if (--g.turns === 0) grokGuards.delete(key);
    return changed;
  };
}

/**
 * The block of `sandbox.toml` that defines the profile. A JSON string is a TOML basic string, once
 * DEL, which JSON leaves as it is and TOML does not allow there, is escaped too.
 */
export function grokProfileBlock(deny: readonly string[]): string {
  const toml = (path: string) => JSON.stringify(path).replace(/\u007f/g, '\\u007F');
  return [
    PROFILE_BEGIN,
    `[profiles.${GROK_PROFILE}]`,
    'extends = "workspace"',
    `deny = [${deny.map(toml).join(', ')}]`,
    PROFILE_END,
  ].join('\n');
}

/** `sandbox.toml` with the profile's block in place of the one there was, or after the user's own profiles. */
export function withGrokProfile(existing: string, block: string): string {
  const start = existing.indexOf(PROFILE_BEGIN);
  const end = start < 0 ? -1 : existing.indexOf(PROFILE_END, start);
  if (end >= 0) return existing.slice(0, start) + block + existing.slice(end + PROFILE_END.length);
  const before = existing.trimEnd();
  return `${before ? `${before}\n\n` : ''}${block}\n`;
}

/** Grok's home: the CLIs' own folder for it when Harness Relay gives it one, else ~/.grok. */
export function grokHome(env: NodeJS.ProcessEnv): string {
  return env.GROK_HOME || join(homedir(), '.grok');
}

/**
 * Writes the profile into `<home>/sandbox.toml` when it is not there as it should be. Written beside
 * it and renamed into place, so a Grok starting meanwhile (another agent of a parallel team) reads
 * the old file or the new one, never half of one. A `sandbox.toml` that is a link (to the user's
 * dotfiles, say) stays one: the file it leads to is written.
 */
export function writeGrokProfile(home: string, deny: readonly string[]): void {
  const path = join(home, 'sandbox.toml');
  const file = existsSync(path) ? realpathSync(path) : path;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = withGrokProfile(existing, grokProfileBlock(deny));
  if (next === existing) return;
  mkdirSync(home, { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, next, { flag: 'wx' });
  renameSync(temp, file);
}


/** The `toolCall` of an ACP `session/request_permission`. */
export interface GrokToolCall {
  toolCallId?: string;
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  _meta?: Record<string, any>;
}

export type GrokDecision =
  | { allow: true }
  /** `reason` goes back to the model; `label` is shown under the tool in the chat. */
  | { allow: false; reason: string; label: string };

/** Whether to approve a tool call grok asks about under this conversation's permission. */
export function grokPermissionDecision(permission: Permission, call: GrokToolCall): GrokDecision {
  if (permission === 'full') return { allow: true };
  const tool = String(call._meta?.['x.ai/tool']?.name ?? '');
  const what = call.title || tool || 'this tool call';
  if (permission === 'read-only') {
    if (call.kind === 'fetch' || tool === 'web_fetch' || tool === 'web_search') return { allow: true };
    return {
      allow: false,
      reason:
        `Not run: this conversation is read-only (the user's Harness Relay setting), so "${what}" is not allowed. ` +
        'Do not retry it or try to work around it. Continue with read-only tools (read_file, list_dir, grep, ' +
        'read-only shell commands, web fetch/search) and describe any change you would make instead of making it.',
      label: t().grokRefusedReadOnly,
    };
  }
  const command = typeof call.rawInput?.command === 'string' ? call.rawInput.command : '';
  if (isPublishCommand(command)) {
    return {
      allow: false,
      reason:
        `Not run: "${what}" publishes outside this machine, which this conversation's edit permission does not allow. ` +
        'Leave pushing/publishing to the user and continue with the rest of the task.',
      label: t().grokRefusedPublish,
    };
  }
  return { allow: true };
}

/** What to show the user when grok asks about a call the permission does not cover. */
export function grokApprovalRequest(call: GrokToolCall): ApprovalRequest {
  const tool = String(call._meta?.['x.ai/tool']?.name ?? '');
  const input = call.rawInput ?? {};
  const reason = typeof input.description === 'string' && input.description ? input.description : call.title;
  if (call.kind === 'execute' || typeof input.command === 'string') {
    return { kind: 'command', detail: String(input.command ?? ''), reason };
  }
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' || /write|replace|edit/i.test(tool)) {
    return { kind: 'edit', detail: input.file_path ?? input.path ?? input.target_file, reason: call.title };
  }
  if (call.kind === 'fetch') return { kind: 'fetch', detail: input.url, reason: call.title };
  return { kind: 'other', tool: tool || call.title, detail: summarizeInput(input, { wholePaths: true }), reason: call.title };
}

/** The decision after the user declined (their note, if any, goes to the model). */
function declined(call: GrokToolCall, note?: string): GrokDecision {
  const what = call.title || String(call._meta?.['x.ai/tool']?.name ?? 'this tool call');
  return {
    allow: false,
    reason:
      `Not run: the user declined "${what}".${note ? ` Their message: ${note}` : ''} ` +
      'Do not retry it; continue without it, or explain in your reply why it is needed.',
    label: note ? `${t().approvalDeclined} ${note}` : t().approvalDeclined,
  };
}

/** Builds the reply to `session/request_permission`. */
function answerPermission(decision: GrokDecision, options: { optionId: string; kind: string }[]) {
  const pick = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
  if (decision.allow) {
    const optionId = pick('allow_once') ?? pick('allow_always');
    if (optionId) return { outcome: { outcome: 'selected', optionId } };
  } else {
    const optionId = pick('reject_once') ?? pick('reject_always');
    // grok treats a rejection carrying a follow-up message as feedback for the model, not a cancel.
    if (optionId) return { outcome: { outcome: 'selected', optionId }, _meta: { followup_message: decision.reason } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/** Text of an ACP tool-call `content` array (e.g. the reason a call failed). */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (typeof c?.content?.text === 'string' ? c.content.text : typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || undefined;
}

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/**
 * What a search xAI runs on its side looked up, from the completed call's `rawOutput` (grok 1.0.77):
 * - web search: `{ id, status, action: { type: 'search', query, sources } | { type: 'open_page', url } | … }`
 * - X search: `{ call_id, id, name: 'x_keyword_search', input: '{"query":"…","limit":"3","mode":"Latest"}' }`
 */
export function grokBackendDetail(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  let input: unknown = r.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = undefined;
    }
  }
  return webSearchDetail(r.action) ?? (input && typeof input === 'object' ? summarizeInput(input) : undefined);
}

/** Turns ACP `session/update` payloads into AgentEvents. */
export function createGrokUpdateHandler(emit: (e: AgentEvent) => void) {
  const open = new Set<string>();
  /** To-do updates arrive as `plan` updates too, so their tool calls are not shown as rows. */
  const hidden = new Set<string>();
  const names = new Map<string, string>();
  /** Searches xAI runs on its side (web, X): what they searched for only comes with the result. */
  const backend = new Set<string>();
  const refused = new Map<string, string>();
  let inText = false;
  let lastFailure: { tool: string; reason?: string } | undefined;

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  const finishTool = (id: string, u: Record<string, any>) => {
    open.delete(id);
    const ok = u.status === 'completed';
    const text = contentText(u.content);
    let error: string | undefined;
    if (!ok) {
      lastFailure = { tool: names.get(id) ?? 'tool', reason: text };
      error = refused.get(id) ?? text;
    }
    const output = ok && text ? tailText(text) : undefined;
    const detail = backend.delete(id) ? grokBackendDetail(u.rawOutput) : undefined;
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}), ...(output ? { output } : {}), ...(detail ? { detail } : {}) });
  };

  function handle(u: Record<string, any> | undefined): void {
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string' && text) {
          inText = true;
          emit({ type: 'text', text });
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string' && text) {
          closeText();
          emit({ type: 'thinking', text });
        }
        break;
      }
      case 'plan': {
        const entries = Array.isArray(u.entries) ? u.entries : [];
        emit({
          type: 'plan',
          entries: entries.map((e: any) => ({
            text: String(e?.content ?? ''),
            status: e?.status === 'completed' || e?.status === 'in_progress' ? e.status : 'pending',
          })),
        });
        break;
      }
      case 'tool_call': {
        closeText();
        const id = String(u.toolCallId ?? '');
        if (!id || hidden.has(id)) break;
        if (u._meta?.['x.ai/tool']?.name === 'todo_write' || u.title === 'todo_write') {
          hidden.add(id);
          break;
        }
        if (!open.has(id)) {
          open.add(id);
          let name = String(u.title || u._meta?.['x.ai/tool']?.name || u.kind || 'tool');
          if (u._meta?.backend || u.rawInput?.backend) {
            // Titled "Web search:" / "X search:", a label for a query that only comes with the result.
            backend.add(id);
            name = name.replace(/:\s*$/, '') || 'tool';
          }
          names.set(id, String(u._meta?.['x.ai/tool']?.name || name));
          emit({ type: 'tool_start', id, name, detail: summarizeInput(u.rawInput) });
        }
        if (DONE.has(u.status)) finishTool(id, u);
        break;
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        if (open.has(id) && DONE.has(u.status)) finishTool(id, u);
        break;
      }
      case 'response_completed': // one per model response
        closeText();
        break;
    }
  }

  return {
    handle,
    /** Remember why we refused a call, to show that instead of grok's generic "not executed". */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    finish: closeText,
    /** The most recent tool call that did not complete, with grok's stated reason. */
    get lastFailure() {
      return lastFailure;
    },
  };
}

/** Explains a turn grok ended itself (`stopReason: "cancelled"`) without us cancelling it. */
export function describeGrokCancel(failure: { tool: string; reason?: string } | undefined, permission: Permission): string {
  const m = t();
  if (!failure) return m.grokCancelledNoReason;
  const hint = permission === 'full' ? '' : m.grokCancelHint(m.permission[permission]);
  return m.grokCancelled(failure.tool, failure.reason) + hint;
}

/**
 * The tool library's MCP servers in ACP's form. Grok adds the ones from its own config files. HTTP
 * servers only go to an agent that says it takes them (`mcpCapabilities.http`); ACP forbids them otherwise.
 */
export function grokMcpServers(servers: McpServerSpec[], http = true): Record<string, unknown>[] {
  const list = (vars: Record<string, string>) => Object.entries(vars).map(([name, value]) => ({ name, value }));
  const skipped = http ? [] : servers.filter((s) => s.transport === 'http');
  if (skipped.length) console.warn(`[grok] this grok does not take HTTP MCP servers; left out: ${skipped.map((s) => s.name).join(', ')}`);
  return servers.filter((s) => http || s.transport !== 'http').map((s) =>
    s.transport === 'http'
      ? { type: 'http', name: s.name, url: s.url, headers: list(s.headers) }
      : { name: s.name, command: s.command, args: s.args, env: list(s.env) },
  );
}

/** `costUsdTicks` are 1e-10 USD. */
const TICKS_PER_USD = 1e10;

/**
 * Variables that make Grok leave out, for one run, the skills, MCP servers and hooks it loads from
 * Claude Code's and Cursor's settings (Claude Code plugins' skills too, but not their hooks), and
 * its memory. Its own skills, MCP servers and hooks have no such switch (they are turned off in
 * ~/.grok/config.toml), and neither have instruction files, its own subagents or plugins.
 */
export function grokNativeEnv(off: readonly NativePart[] = []): Record<string, string> {
  return {
    ...(off.includes('skills') ? { GROK_CLAUDE_SKILLS_ENABLED: 'false', GROK_CURSOR_SKILLS_ENABLED: 'false' } : {}),
    ...(off.includes('mcp') ? { GROK_CLAUDE_MCPS_ENABLED: 'false', GROK_CURSOR_MCPS_ENABLED: 'false' } : {}),
    ...(off.includes('memory') ? { GROK_MEMORY: '0' } : {}),
    ...(off.includes('hooks') ? { GROK_CLAUDE_HOOKS_ENABLED: 'false', GROK_CURSOR_HOOKS_ENABLED: 'false' } : {}),
  };
}

/** The environment of one run: the user's, what leaves out Grok's own setup, and the sandbox for the permission. */
export function grokEnv(o: Pick<RunOptions, 'env' | 'nativeOff' | 'permission'>, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const sandbox = grokSandboxProfile(o.permission, platform);
  return { ...o.env, ...grokNativeEnv(o.nativeOff), ...(sandbox ? { GROK_SANDBOX: sandbox } : {}) };
}

export const grokRunner: AgentRunner = {
  provider: 'grok',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    // Model and effort are set per session below: `grok agent --reasoning-effort` does not reach ACP sessions.
    const args = ['agent', '--no-leader', 'stdio'];
    const sandbox = grokSandboxProfile(o.permission);
    const env = grokEnv(o);
    if (sandbox === GROK_PROFILE) {
      const deny = o.protectedPaths ?? protectedReads();
      // A path its sandbox would read as a pattern would be left unprotected: the run does not start.
      const pattern = patternPath(deny);
      if (pattern) throw new AgentRunError(t().protectedPattern(pattern));
      const home = grokHome(env);
      // Grok reads its settings after its sandbox is on, so they cannot be denied: they are checked
      // around the turn instead, and put back when a command changed them.
      let settle: () => string[];
      try {
        settle = guardGrokSettings(home, () => writeGrokProfile(home, [...deny, ...grokPrograms(home, commandPaths(o.bin, env))]));
      } catch (err) {
        throw new AgentRunError(t().grokSandbox((err as Error).message));
      }
      let result: RunResult;
      try {
        result = await grokTurn(o, args, sandbox, env);
      } finally {
        const changed = settle();
        // Thrown from here, it takes the place of the turn's own result or error.
        // eslint-disable-next-line no-unsafe-finally
        if (changed.length) throw new AgentRunError(t().grokSettingsChanged(changed.join(', ')));
      }
      return result;
    }
    return grokTurn(o, args, sandbox, env);
  },
};

/** One Grok turn over ACP, in its sandbox for the permission (`sandbox`, set in `env`). */
async function grokTurn(o: RunOptions, args: string[], sandbox: string | undefined, env: NodeJS.ProcessEnv): Promise<RunResult> {

  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let userAborted = false;
  // Ends the grok process: once the turn is over, or when a cancel is not honoured in time.
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

  const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
  const updates = createGrokUpdateHandler(o.onEvent);
  conn.onNotification = (method, params) => {
    if (method !== 'session/update' && method !== '_x.ai/session_notification') return;
    if (!sessionId || params?.sessionId !== sessionId) return; // sub-agents and pre-session noise
    updates.handle(params.update);
  };
  conn.onRequest = async (method, params) => {
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
    const call: GrokToolCall = params?.toolCall ?? {};
    let decision = grokPermissionDecision(o.permission, call);
    // Not covered by the permission: the user decides, when the conversation asks.
    if (!decision.allow && o.requestApproval) {
      const answer = await o.requestApproval(grokApprovalRequest(call));
      decision = answer.allow ? { allow: true } : declined(call, answer.note);
    }
    if (!decision.allow && call.toolCallId) updates.refused(call.toolCallId, decision.label);
    return answerPermission(decision, Array.isArray(params?.options) ? params.options : []);
  };

  const onAbort = () => {
    userAborted = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
    stopSoon(2000);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });

  const exited = runProcess({
    bin: o.bin,
    args,
    cwd: o.cwd,
    env,
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    keepStdinOpen: true,
    onSpawn: (c) => (child = c),
    onLine: conn.handleLine,
  }).then(
    (res) => {
      const why = res.timedOut
        ? t().timedOut
        : tail(res.stderr) || t().exitedWithoutTurn('grok', res.code);
      conn.close(new AgentRunError(sandbox && /sandbox/i.test(res.stderr) ? t().grokSandbox(why) : why));
      return res;
    },
    (err: Error) => {
      conn.close(err);
      throw err;
    },
  );
  exited.catch(() => undefined); // surfaced through the pending requests instead

  try {
    const init = await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const mcpServers = grokMcpServers(o.mcpServers ?? [], Boolean(init?.agentCapabilities?.mcpCapabilities?.http));
    const sessionMeta = { rules: o.systemPrompt, yoloMode: o.permission === 'full' };
    let configOptions: any[] | undefined;
    if (o.sessionId) {
      const r = await conn.request('session/resume', { sessionId: o.sessionId, cwd: o.cwd, mcpServers, _meta: sessionMeta });
      sessionId = o.sessionId;
      configOptions = r?.configOptions;
    } else {
      const r = await conn.request('session/new', { cwd: o.cwd, mcpServers, _meta: sessionMeta });
      sessionId = String(r?.sessionId ?? '');
      if (!sessionId) throw new AgentRunError(t().grokNoSession);
      configOptions = r?.configOptions;
    }
    o.onEvent({ type: 'session', sessionId });
    if (userAborted) throw new AgentRunError(t().stopped, true);

    for (const [configId, value, rejected] of [
      ['model', o.model, t().grokRejectedModel],
      ['reasoning_effort', o.effort, t().grokRejectedEffort],
    ] as const) {
      const current = configOptions?.find((c: any) => c?.id === configId)?.currentValue;
      if (!value || value === current) continue;
      await conn
        .request('session/set_config_option', { sessionId, configId, value })
        .catch((err: Error) => {
          throw new AgentRunError(rejected(value, err.message));
        });
    }

    const result = await conn.request('session/prompt', { sessionId, prompt: grokPrompt(o.prompt, o.images) });
    updates.finish();
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (result?.stopReason === 'cancelled') throw new AgentRunError(describeGrokCancel(updates.lastFailure, o.permission));

    const u = result?._meta?.usage ?? {};
    return {
      sessionId,
      costUsd: typeof u.costUsdTicks === 'number' ? u.costUsdTicks / TICKS_PER_USD : undefined,
      inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : undefined,
      outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : undefined,
    };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // grok exits when its stdin closes
    stopSoon(3000);
    await exited.catch(() => undefined);
  }
}

