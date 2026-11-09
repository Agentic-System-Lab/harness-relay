import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ChatMessage, Conversation } from '../shared/types';
import { mediaType } from '../shared/media';
import { attachmentsDir } from './attachments';
import { worktreeDir } from './workspace';

export { mediaType };

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The directories a message's images and videos may come from, in the order a relative path is
 * tried: where its agent worked (its own worktree for an isolated turn, else the working
 * directory), then the other one, then the conversation's attachments.
 */
export function mediaRoots(conv: Conversation, msg: ChatMessage): string[] {
  const wt = msg.author.kind === 'agent' ? conv.worktrees[msg.author.agentId] : undefined;
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
      const real = realpathSync(isAbsolute(ref) ? ref : resolve(realRoot, ref));
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
