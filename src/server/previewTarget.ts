import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AppPreviewRequest, Conversation } from '../shared/types';
import { HttpError } from './errors';
import { fileRoots, resolveInRoot } from './files';
import { mediaRoots, replyWorktrees } from './media';
import { previewPrivatePath } from './previewFiles';
import type { SettingsStore } from './settings';
import { t } from './i18n';

export interface PreviewTarget {
  root: string;
  folder: string;
  entry: string;
  mode: AppPreviewRequest['mode'];
  isPrivate?: (path: string) => boolean;
}

export function previewTarget(
  conv: Conversation,
  input: Partial<AppPreviewRequest>,
  lookup: (id: string) => Conversation | undefined,
  settings?: SettingsStore,
): PreviewTarget {
  const { folder, mode, root, messageId } = input;
  if (
    typeof folder !== 'string' ||
    folder.length > 4096 ||
    (mode !== 'static' && mode !== 'build' && mode !== 'server') ||
    /[\x00-\x1f]/.test(folder) ||
    folder.split(/[\\/]/).some((p) => p === '..') ||
    (messageId !== undefined && (typeof messageId !== 'string' || root !== undefined))
  )
    throw new HttpError(400, t().previewTarget);
  const entry = input.entry ?? (mode === 'static' ? 'index.html' : 'package.json');
  if (typeof entry !== 'string' || entry.length > 255 || /[\\/:\x00-\x1f]/.test(entry) || entry.startsWith('.'))
    throw new HttpError(400, t().previewTarget);
  const html = /\.html?$/i.test(entry);
  const manifest = entry === 'package.json';
  if ((!html && !manifest) || (messageId === undefined && (mode === 'static' ? !html : !manifest)))
    throw new HttpError(400, t().previewTarget);
  let roots: string[];
  let worktrees: string[] = [];
  if (messageId !== undefined) {
    const msg = conv.messages.find((m) => m.id === messageId && m.author.kind === 'agent');
    if (!msg) throw new HttpError(404, t().previewTarget);
    // The last media root is the conversation's attachments. Only working directories can run apps.
    roots = mediaRoots(conv, msg, lookup).slice(0, -1);
    worktrees = replyWorktrees(conv, msg, lookup).map((w) => w.path);
  } else {
    if (isAbsolute(folder) || /^[a-z]:|^[\\/]/i.test(folder)) throw new HttpError(400, t().previewTarget);
    const selected = fileRoots(conv).find((r) => r.id === (root ?? 'cwd'));
    roots = selected ? [selected.path] : [];
    if (selected?.agentId) worktrees = (conv.worktrees[selected.agentId] ?? []).map((w) => w.path);
  }
  const isPrivate = previewPrivatePath(settings, worktrees);
  for (const dir of roots) {
    try {
      const base = realpathSync.native(dir);
      const sub = isAbsolute(folder) ? relative(base, folder) : folder;
      if (isAbsolute(sub) || /^[a-z]:|^[\\/]/i.test(sub) || sub.split(/[\\/]/).some((p) => p === '..' || (p !== '.' && p.startsWith('.'))))
        continue;
      if (isPrivate(base) || isPrivate(join(base, sub, entry))) continue;
      const inside = resolveInRoot(base, join(sub, entry));
      // A link must never turn a preview of one public directory into a snapshot of another.
      if (relative(join(base, sub, entry), inside.real) || !statSync(inside.real).isFile()) continue;
      const effective = mode === 'static' ? (entry === 'package.json' ? 'index.html' : entry) : 'package.json';
      if (effective !== entry && !statSync(resolveInRoot(base, join(sub, effective)).real).isFile()) continue;
      return { root: base, folder: sub.split(sep).join('/'), entry: effective, mode, isPrivate };
    } catch {
      /* A relative reply link can belong to another of the member's working directories. */
    }
  }
  throw new HttpError(404, t().previewTarget);
}

/** Browser writes show their own Origin. Proxies (including Vite's) preserve the UI Host. */
export function previewParent(host: string, origin: string | undefined): URL {
  let parent: URL;
  try {
    parent = new URL(origin ?? 'http://' + host);
    if (parent.host !== host.toLowerCase() || (origin && parent.origin !== origin) || !['http:', 'https:'].includes(parent.protocol))
      throw new Error();
  } catch {
    throw new HttpError(403, t().previewOrigin);
  }
  return parent;
}

export function previewAddress(parent: URL, port: number, domain?: string): URL {
  const local = ['localhost', '[::1]', '127.0.0.1'].includes(parent.hostname);
  if (
    !local &&
    (!domain ||
      parent.protocol !== 'https:' ||
      domain === parent.hostname ||
      domain.endsWith('.' + parent.hostname) ||
      parent.hostname.endsWith('.' + domain))
  )
    throw new HttpError(400, t().previewRemote);
  const label = 'p-' + randomBytes(24).toString('hex');
  return new URL(local ? 'http://' + label + '.localhost:' + port : 'https://' + label + '.' + domain);
}
