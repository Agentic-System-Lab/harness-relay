import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentWorktree, ChatMessage, Conversation } from '../shared/types';
import { mediaType } from '../shared/media';
import { attachmentsDir } from './attachments';
import { worktreeDir } from './workspace';

export { mediaType };

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The worktree a reply's agent worked in. For an isolated turn, the one holding the turn's branch: the
 * conversation's own, or for a reply copied into a branch, the one of the conversation it was written
 * in (`lookup` finds a conversation; any its copied messages came from, and further up for a branch of
 * a branch), while that is there. Not the branch's own worktree for that agent, which holds other work.
 * Otherwise the agent's worktree.
 */
export function replyWorktree(
  conv: Conversation,
  msg: ChatMessage,
  lookup: (id: string) => Conversation | undefined = () => undefined,
): AgentWorktree | undefined {
  if (msg.author.kind !== 'agent') return undefined;
  const own = conv.worktrees[msg.author.agentId];
  const changes = msg.changes;
  if (!changes?.isolated || !changes.branch) return own;
  const holds = (w: AgentWorktree) => w.root === changes.root && w.branch === changes.branch;
  if (own && holds(own)) return own;
  const sources = (c: Conversation) => (c.branch ? [c.branch, ...(c.branch.earlier ?? [])].map((p) => p.fromId) : []);
  const seen = new Set([conv.id]);
  const queue = sources(conv);
  for (let i = 0; i < queue.length; i++) {
    const from = !seen.has(queue[i]!) ? lookup(queue[i]!) : undefined;
    seen.add(queue[i]!);
    if (!from) continue;
    const wt = Object.values(from.worktrees).find(holds);
    if (wt) return wt;
    queue.push(...sources(from));
  }
  return undefined;
}

/**
 * The directories a message's images and videos may come from, in the order a relative path is
 * tried: where its agent worked (its own worktree for an isolated turn, see `replyWorktree`, else the
 * working directory), then the other one, then the conversation's attachments.
 */
export function mediaRoots(conv: Conversation, msg: ChatMessage, lookup?: (id: string) => Conversation | undefined): string[] {
  const wt = replyWorktree(conv, msg, lookup);
  let own: string | undefined;
  try {
    own = wt ? worktreeDir(wt.root, conv.settings.cwd, wt.path) : undefined;
  } catch {
    own = undefined;
  }
  const roots = own && msg.changes?.isolated ? [own, conv.settings.cwd] : [conv.settings.cwd, ...(own ? [own] : [])];
  return [...roots, attachmentsDir(conv.id)];
}

/** Whether `real`, inside `root`, is in a `.git` folder (in any letter case: `.GIT` opens `.git` on macOS and Windows). */
function inGit(real: string, root: string): boolean {
  return relative(root, real)
    .split(sep)
    .some((part) => part.toLowerCase() === '.git');
}

/**
 * The real path of the file `ref` names, when it lies inside one of `roots` (after following
 * symlinks), outside `.git`, and `accept`s it. A relative `ref` is resolved against each root in turn.
 */
function resolveIn(ref: string, roots: string[], accept: (real: string) => boolean): string | undefined {
  if (!ref || ref.includes('\0')) return undefined;
  for (const root of roots) {
    try {
      const realRoot = realpathSync(root);
      const target = resolve(realRoot, ref);
      // Look nothing up outside the root, not even to follow a link: on Windows, \\host\… would
      // make this computer connect to another one (and offer it the user's credentials).
      if (!inside(target, realRoot) && !inside(target, resolve(root))) continue;
      const real = realpathSync(target);
      if (inside(real, realRoot) && !inGit(real, realRoot) && accept(real) && statSync(real).isFile()) return real;
    } catch {
      /* not there: try the next root */
    }
  }
  return undefined;
}

/**
 * The real path of the image or video `ref` names, when it is one (by extension, also after
 * following symlinks) and lies inside one of `roots`. A relative `ref` is resolved against each root.
 */
export function resolveMedia(ref: string, roots: string[]): string | undefined {
  return mediaType(ref) ? resolveIn(ref, roots, (real) => Boolean(mediaType(real))) : undefined;
}

/**
 * The real path of the file a reply links to (a PDF, slides, anything), for downloading it: inside
 * one of `roots` after following symlinks, never in `.git`. A relative `ref` is resolved against each root.
 */
export function resolveDownload(ref: string, roots: string[]): string | undefined {
  return resolveIn(ref, roots, () => true);
}

/**
 * Why `resolveDownload` gives no file for `ref`: 'outside' when it names a place outside every root
 * (also by a symlink out of one) or in `.git`; 'missing' when nothing is there or it is a folder. Like
 * resolveDownload, it looks nothing up outside the roots.
 */
export function downloadProblem(ref: string, roots: string[]): 'missing' | 'outside' {
  if (!ref || ref.includes('\0')) return 'missing';
  let within = false;
  for (const root of roots) {
    try {
      const realRoot = realpathSync(root);
      const target = resolve(realRoot, ref);
      const base = inside(target, realRoot) ? realRoot : inside(target, resolve(root)) ? resolve(root) : undefined;
      if (!base) continue;
      if (inGit(target, base)) return 'outside';
      within = true;
      let real: string;
      try {
        real = realpathSync(target);
      } catch {
        continue; // not in this root
      }
      if (!inside(real, realRoot) || inGit(real, realRoot)) return 'outside';
    } catch {
      /* the root is gone */
    }
  }
  return within ? 'missing' : 'outside';
}

/**
 * A Content-Disposition header for a file `name`: `inline` to show it, `attachment` to save it. The
 * name is percent-encoded as RFC 5987 asks (also ' ( ) *), with a plain-ASCII fallback for old clients.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A byte range from a Range header: null when there is none (or it is not a single byte range), 'invalid' when it cannot be met. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}
