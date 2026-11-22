import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseModule } from 'es-module-lexer/minimal/js';
import type { AppPreviewRequest, Conversation } from '../shared/types';
import { PREVIEW_NO_RECIPE, PREVIEW_RECIPES } from '../shared/types';
import { HttpError } from './errors';
import { fileRoots, readPreview, resolveInRoot } from './files';
import { mediaRoots, replyWorktrees } from './media';
import { hasPreviewScript, parsePreviewPackage, previewNpmFileProblem } from './previewDockerPackages';
import { isPreviewAsset, previewFolderParts, previewPrivatePath } from './previewFiles';
import type { SettingsStore } from './settings';
import { t } from './i18n';

export interface PreviewTarget {
  root: string;
  folder: string;
  entry: string;
  mode: AppPreviewRequest['mode'];
  isPrivate?: (path: string) => boolean;
  /** For a member of an npm workspace: the workspace root's folder, which holds the lockfile.
   * The preview copies that folder and runs the member's script there. */
  npmRoot?: string;
}

type PreviewLocation = Pick<PreviewTarget, 'root' | 'folder'> & { isPrivate: (path: string) => boolean };
/** What a container preview starts from, in the order a folder is looked at: compose first, then a Dockerfile. */
export const CONTAINER_ENTRIES: readonly string[] = PREVIEW_RECIPES;
const isContainerEntry = (entry: string) => CONTAINER_ENTRIES.includes(entry);
type Lookup = (id: string) => Conversation | undefined;
const missing = () => new HttpError(404, t().previewTarget);

function entryStat(location: PreviewLocation, name: string) {
  const rel = join(location.folder, name);
  const path = join(location.root, rel);
  if (location.isPrivate(path) || relative(path, resolveInRoot(location.root, rel).real)) throw missing();
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw missing();
  return stat;
}

function hasEntry(location: PreviewLocation, name: string): boolean {
  try {
    entryStat(location, name);
    return true;
  } catch {
    return false;
  }
}

/** The bounded Files reader rechecks this exact, public file while holding its open descriptor. */
function inspectEntry(location: PreviewLocation, name: string) {
  return readPreview(join(location.root, location.folder, name), name, t().previewTarget, () => entryStat(location, name));
}

function locatePreviewEntry(
  conv: Conversation,
  input: Partial<AppPreviewRequest>,
  entries: string[],
  lookup: Lookup,
  settings?: SettingsStore,
  required?: string,
) {
  const { folder, root, messageId } = input;
  if (
    typeof folder !== 'string' ||
    folder.length > 4096 ||
    /[\x00-\x1f]/.test(folder) ||
    folder.split(/[\\/]/).some((p) => p === '..') ||
    (messageId !== undefined && (typeof messageId !== 'string' || root !== undefined))
  )
    throw new HttpError(400, t().previewTarget);
  if (
    entries.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length > 255 ||
        (entry !== 'package.json' &&
          !isContainerEntry(entry) &&
          (!/\.html?$/i.test(entry) || entry.includes('/') || !isPreviewAsset(entry))),
    )
  )
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
      const sub = relative(base, resolve(base, folder));
      if (isAbsolute(sub) || /^[a-z]:|^[\\/]/i.test(sub) || isPrivate(base)) continue;
      const selectedFolder = sub.split(sep).join('/');
      previewFolderParts(selectedFolder);
      const location = { root: base, folder: selectedFolder, isPrivate };
      const entry = entries.find((name) => hasEntry(location, name));
      if (entry && (!required || hasEntry(location, required))) return { location, entry };
    } catch {
      /* A relative reply link can belong to another of the member's working directories. */
    }
  }
  throw entries.length > 1 ? new HttpError(404, t().previewFolderEntry, PREVIEW_NO_RECIPE) : new HttpError(404, t().previewTarget);
}

export function previewTarget(
  conv: Conversation,
  input: Partial<AppPreviewRequest>,
  lookup: Lookup,
  settings?: SettingsStore,
): PreviewTarget {
  const { mode } = input;
  if (mode === 'container') {
    const entry = input.entry;
    if (typeof entry !== 'string' || !isContainerEntry(entry)) throw new HttpError(400, t().previewTarget);
    const { location } = locatePreviewEntry(conv, input, [entry], lookup, settings);
    return { ...location, entry, mode };
  }
  if (mode !== 'static' && mode !== 'build' && mode !== 'server') throw new HttpError(400, t().previewTarget);
  const selected = input.entry ?? (mode === 'static' ? 'index.html' : 'package.json');
  if (input.messageId === undefined && (mode === 'static' ? selected === 'package.json' : selected !== 'package.json'))
    throw new HttpError(400, t().previewTarget);
  const entry = mode === 'static' ? (selected === 'package.json' ? 'index.html' : selected) : 'package.json';
  const { location } = locatePreviewEntry(conv, input, [selected], lookup, settings, selected !== entry ? entry : undefined);
  const npmRoot = mode === 'static' ? undefined : npmWorkspaceRoot(location);
  return { ...location, entry, mode, ...(npmRoot !== undefined && { npmRoot }) };
}

/** One segment of a workspace pattern, as npm's globs read it: `*` and `?` within the segment. */
function segmentPattern(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + escaped + '$');
}

function globMatch(pattern: string[], path: string[]): boolean {
  if (!pattern.length) return !path.length;
  if (pattern[0] === '**') return path.some((_, i) => globMatch(pattern.slice(1), path.slice(i))) || globMatch(pattern.slice(1), []);
  return path.length > 0 && segmentPattern(pattern[0]).test(path[0]) && globMatch(pattern.slice(1), path.slice(1));
}

/** Whether a package.json's `workspaces` (an array, or `{ packages }`) include the folder, in order,
 * so that a later `!pattern` leaves one out again as npm does. */
function inNpmWorkspaces(project: Record<string, unknown>, folder: string): boolean {
  const declared = project.workspaces;
  const patterns =
    declared && typeof declared === 'object' && !Array.isArray(declared) ? (declared as Record<string, unknown>).packages : declared;
  if (!Array.isArray(patterns)) return false;
  const path = folder.split('/');
  let included = false;
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const negated = raw.startsWith('!');
    const parts = raw
      .slice(negated ? 1 : 0)
      .replace(/^(?:\.\/)+/, '')
      .split('/')
      .filter((part) => part && part !== '.');
    if (!parts.length || parts.includes('..') || !globMatch(parts, path)) continue;
    included = !negated;
  }
  return included;
}

/** npm keeps one lockfile at a workspace's root. A project without its own lockfile is previewed
 * from the nearest folder above it, inside the same working directory, whose package.json lists it
 * among its workspaces, as npm itself finds the workspace root. */
function npmWorkspaceRoot(location: PreviewLocation): string | undefined {
  if (hasEntry(location, 'package-lock.json')) return;
  const parts = location.folder ? location.folder.split('/') : [];
  for (let n = parts.length - 1; n >= 0; n--) {
    const parent = { ...location, folder: parts.slice(0, n).join('/') };
    if (!hasEntry(parent, 'package.json')) continue;
    const manifest = inspectEntry(parent, 'package.json');
    if (manifest.truncated || manifest.text === undefined) continue;
    let project: Record<string, unknown>;
    try {
      project = parsePreviewPackage(manifest.text);
    } catch {
      continue;
    }
    if (inNpmWorkspaces(project, parts.slice(n).join('/'))) return parent.folder;
  }
}

function localSourceModule(reference?: string): boolean {
  const path = reference?.trim().split(/[?#]/)[0];
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return false;
  return /^(?:\.?\/)?(?:src\/|@vite\/client$)/.test(path) || /\.(?:[cm]?tsx?|jsx|vue|svelte)$/i.test(path);
}

/** Inspect only the selected index. The module lexer reads literal import specifiers without
 * executing the script, resolving imports, or mistaking strings and comments for imports. */
function indexKind(location: PreviewLocation, entry: string): 'static' | 'source' | 'truncated' {
  if (!/^index\.html?$/i.test(entry)) return 'static';
  const file = inspectEntry(location, entry);
  if (file.text === undefined) throw missing();
  const tags = /<!--[\s\S]*?(?:-->|$)|<script\b([^<>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi;
  for (const [, tag, script] of file.text.matchAll(tags)) {
    if (!tag) continue;
    const attributes = new Map<string, string>();
    for (const [, name, double, single, bare] of tag.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
      if (name) attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '');
    }
    if (attributes.get('type')?.toLowerCase() !== 'module') continue;
    if (attributes.has('src')) {
      if (localSourceModule(attributes.get('src'))) return 'source';
    } else if (script?.includes('import') || script?.includes('export')) {
      try {
        if (parseModule(script)[0].some((specifier) => localSourceModule(specifier.n))) return 'source';
      } catch {
        // An incomplete or invalid inline module can still show the browser's diagnostic in a static preview.
      }
    }
  }
  return file.truncated ? 'truncated' : 'static';
}

function projectMode(location: PreviewLocation): 'server' | 'build' | undefined {
  const manifest = inspectEntry(location, 'package.json');
  if (manifest.truncated) throw new HttpError(413, t().previewManifestLimit);
  if (manifest.text === undefined) throw new HttpError(400, t().previewDocker.invalidLock);
  try {
    const project = parsePreviewPackage(manifest.text);
    const hasServerFile = () => hasEntry(location, 'server.js');
    if (hasPreviewScript(project, 'start', hasServerFile)) return 'server';
    if (hasPreviewScript(project, 'build', hasServerFile)) return 'build';
  } catch {
    throw new HttpError(400, t().previewDocker.invalidLock);
  }
}

/** Resolve once in reply-root order before inspecting adjacent files. Never choose a different
 * worktree just because its project has a build or start script. */
export function detectPreviewTarget(conv: Conversation, input: Partial<AppPreviewRequest>, lookup: Lookup, settings?: SettingsStore) {
  const { location, entry } = locatePreviewEntry(
    conv,
    input,
    input.entry === undefined ? [...CONTAINER_ENTRIES, 'package.json', 'index.html'] : [input.entry],
    lookup,
    settings,
  );
  const folder = join(location.root, location.folder);
  if (
    input.expectedFolder !== undefined &&
    (typeof input.expectedFolder !== 'string' || !isAbsolute(input.expectedFolder) || relative(input.expectedFolder, folder))
  )
    throw new HttpError(409, t().previewFolderChanged);
  if (isContainerEntry(entry)) return { folder, entry, mode: 'container' as const };
  // A project that says how it runs (a compose file or a Dockerfile) runs that way, npm or not.
  if (entry === 'package.json') {
    const recipe = CONTAINER_ENTRIES.find((name) => hasEntry(location, name));
    if (recipe) return { folder, entry: recipe, mode: 'container' as const };
  }
  let kind = entry === 'package.json' ? undefined : indexKind(location, entry);
  if (kind === 'static') return { folder, entry, mode: 'static' as const };
  if (entry === 'package.json' || hasEntry(location, 'package.json')) {
    const mode = projectMode(location);
    if (mode) {
      const npmRoot = npmWorkspaceRoot(location);
      const problem = previewNpmFileProblem(
        (name) => hasEntry(npmRoot === undefined ? location : { ...location, folder: npmRoot }, name),
        (name) => hasEntry(location, name),
      );
      if (problem) throw new HttpError(400, problem);
      return { folder, entry: 'package.json', mode };
    }
  }
  if (entry === 'package.json' && hasEntry(location, 'index.html')) {
    kind = indexKind(location, 'index.html');
    if (kind !== 'source') return { folder, entry: 'index.html', mode: 'static' as const };
  }
  if (kind === 'truncated') return { folder, entry, mode: 'static' as const };
  throw new HttpError(400, t().previewProjectEntry, PREVIEW_NO_RECIPE);
}

/** A file or folder at or below a root. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A regular file there, not a link (what `hasEntry` accepts, before its finer checks). */
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where the files a turn added or changed are now: the member's own worktree for an isolated change. */
function changedFiles(conv: Conversation, msg: Conversation['messages'][number], lookup: Lookup): string[] {
  const worktrees = replyWorktrees(conv, msg, lookup);
  const files: string[] = [];
  for (const c of msg.changes ?? []) {
    const base = c.isolated ? worktrees.find((w) => w.root === c.root && (!c.branch || w.branch === c.branch))?.path : c.root;
    if (!base) continue;
    for (const f of c.files) if (f.status !== 'D') files.push(join(base, ...f.path.split('/')));
  }
  return files;
}

/**
 * The app a finished turn made, from the files it added or changed: a compose file, a Dockerfile or
 * a package.json says its folder runs; a page belongs to the nearest folder above it, inside the
 * same working directory, that has one of those, or else opens as it is. The shallowest such folder
 * is the app (the more telling file first at the same depth), as `detectPreviewTarget` then confirms.
 */
export function changedPreviewTarget(conv: Conversation, input: { messageId?: unknown }, lookup: Lookup, settings?: SettingsStore) {
  const { messageId } = input;
  if (typeof messageId !== 'string' || messageId.length > 256) throw new HttpError(400, t().previewTarget);
  const msg = conv.messages.find((m) => m.id === messageId && m.author.kind === 'agent');
  if (!msg) throw missing();
  const roots = mediaRoots(conv, msg, lookup)
    .slice(0, -1)
    .flatMap((dir) => {
      try {
        return [realpathSync.native(dir)];
      } catch {
        return [];
      }
    });
  const runs = [...CONTAINER_ENTRIES, 'package.json'];
  const found = new Map<string, { entry?: string; depth: number; rank: number }>();
  for (const file of changedFiles(conv, msg, lookup)) {
    const name = basename(file);
    const page = /\.html?$/i.test(name);
    if ((!page && !runs.includes(name)) || file.split(sep).includes('node_modules')) continue;
    const root = roots.find((r) => inside(r, file));
    if (!root) continue;
    let folder = dirname(file);
    let entry: string | undefined;
    if (page) {
      let dir = folder;
      while (!runs.some((n) => regularFile(join(dir, n)))) {
        if (dir === root || !inside(root, dirname(dir))) break;
        dir = dirname(dir);
      }
      if (runs.some((n) => regularFile(join(dir, n)))) folder = dir;
      else entry = name;
    }
    const rank = entry ? 3 : runs.findIndex((n) => regularFile(join(folder, n))) < CONTAINER_ENTRIES.length ? 0 : 1;
    const depth = relative(root, folder).split(sep).filter(Boolean).length;
    const known = found.get(folder);
    if (!known || rank < known.rank) found.set(folder, { entry, depth, rank });
  }
  const ranked = [...found].sort(([, a], [, b]) => a.depth - b.depth || a.rank - b.rank);
  for (const [folder, { entry }] of ranked) {
    try {
      return detectPreviewTarget(conv, { folder, messageId, ...(entry && { entry }) }, lookup, settings);
    } catch {
      /* Not one that runs (no lockfile, no script): the next. */
    }
  }
  throw missing();
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
