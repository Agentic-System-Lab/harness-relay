import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseModule } from 'es-module-lexer/minimal/js';
import type { AppPreviewRequest, Conversation } from '../shared/types';
import { PREVIEW_NO_RECIPE, PREVIEW_RECIPES, inDependencies, isAppEntry } from '../shared/types';
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

/** A folder's real path, as the roots are compared in (a data folder or a working directory reached through a link). */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Where the files a turn added or changed are now: the member's (or the team's) own worktree for an isolated change. */
function changedFiles(conv: Conversation, msg: Conversation['messages'][number], lookup: Lookup, addedOnly = false): string[] {
  const worktrees = replyWorktrees(conv, msg, lookup);
  const files: string[] = [];
  for (const c of msg.changes ?? []) {
    const where = c.isolated ? worktrees.find((w) => w.root === c.root && (!c.branch || w.branch === c.branch))?.path : c.root;
    if (!where) continue;
    const base = real(where);
    for (const f of c.files) if (addedOnly ? f.status === 'A' : f.status !== 'D') files.push(join(base, ...f.path.split('/')));
  }
  return files;
}

/** The working directories (or the member's worktrees) a reply's files can be in, by their real paths. */
function replyRoots(conv: Conversation, msg: Conversation['messages'][number], lookup: Lookup): string[] {
  return mediaRoots(conv, msg, lookup)
    .slice(0, -1)
    .flatMap((dir) => {
      try {
        return [realpathSync.native(dir)];
      } catch {
        return [];
      }
    });
}

/** The nearest folder from `dir` up to `root` that says how it runs (a compose file, a Dockerfile, a package.json). */
function runningFolder(root: string, dir: string): string | undefined {
  const runs = [...CONTAINER_ENTRIES, 'package.json'];
  for (let d = dir; ; d = dirname(d)) {
    if (runs.some((n) => regularFile(join(d, n)))) return d;
    if (d === root || !inside(root, dirname(d))) return undefined;
  }
}

/** Whether a folder's package.json says it runs: a start, build or dev script, or npm's default server.js. */
function runsSomething(folder: string): boolean {
  if (CONTAINER_ENTRIES.some((n) => regularFile(join(folder, n)))) return true;
  try {
    const scripts = (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
    const has = (name: string) => typeof scripts?.[name] === 'string' && Boolean((scripts[name] as string).trim());
    return has('start') || has('build') || has('dev') || regularFile(join(folder, 'server.js'));
  } catch {
    return true;
  }
}

function attempt(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** An app a turn made or changed that cannot run in a preview, and why. */
export interface AppProblem {
  /** Its folder, as found, and where it is in its working directory (or worktree), as shown. */
  folder: string;
  shown: string;
  reason: string;
}

/**
 * The apps a reply's turn made or changed, and the ones of them that cannot run in a preview: for each
 * folder it added or changed one of `APP_ENTRIES` in (the nearest folder above the file, in the same
 * working directory, that says how it runs; else the file's own), what `detectPreviewTarget` refused
 * there, as files are now. `added`: only files the turn added (a new app, not an edit of one).
 */
export function appProblems(
  conv: Conversation,
  messageId: string,
  lookup: Lookup,
  settings?: SettingsStore,
  o: { added?: boolean } = {},
): { apps: string[]; problems: AppProblem[] } {
  const msg = conv.messages.find((m) => m.id === messageId && m.author.kind === 'agent');
  if (!msg) return { apps: [], problems: [] };
  const roots = replyRoots(conv, msg, lookup);
  // Each app's folder, its working directory, and the index pages in folders below it, which open as they are.
  const folders = new Map<string, { root: string; pages: string[]; names: Set<string> }>();
  for (const file of changedFiles(conv, msg, lookup, o.added)) {
    const root = roots.find((r) => inside(r, file));
    if (!isAppEntry(basename(file)) || !root || inDependencies(relative(root, file).split(sep))) continue;
    const folder = runningFolder(root, dirname(file)) ?? dirname(file);
    const app = folders.get(folder) ?? { root, pages: [], names: new Set<string>() };
    app.names.add(basename(file));
    if (folder !== dirname(file) && /^index\.html?$/i.test(basename(file))) app.pages.push(file);
    folders.set(folder, app);
  }
  const opens = (folder: string, entry?: string) => {
    detectPreviewTarget(conv, { folder, messageId, ...(entry && { entry }) }, lookup, settings);
    return true;
  };
  const problems: AppProblem[] = [];
  for (const [folder, { root, pages, names }] of folders) {
    try {
      opens(folder);
    } catch (error) {
      // Its project does not run, but the page a turn wrote opens as it is (as the panel opens it).
      if (pages.some((p) => attempt(() => opens(dirname(p), basename(p))))) continue;
      // Only a package.json, of a library or a workspace: nothing in it runs, so it is no app.
      if ([...names].every((n) => n === 'package.json') && !runsSomething(folder)) {
        folders.delete(folder);
        continue;
      }
      const reason =
        error instanceof HttpError && error.code === PREVIEW_NO_RECIPE ? t().previewNoWay : (error as Error).message || t().previewTarget;
      problems.push({ folder, shown: relative(root, folder).split(sep).filter(Boolean).join('/') || '.', reason });
    }
  }
  return { apps: [...folders.keys()], problems };
}

/**
 * The app a finished turn made, from the files it added or changed: a compose file, a Dockerfile or
 * a package.json says its folder runs; an index page belongs to the nearest folder above it, inside
 * the same working directory, that has one of those (`public/index.html` its npm project), and any
 * page also opens as it is when that project does not run. The shallowest that runs is the app (the
 * more telling file first at the same depth), as `detectPreviewTarget` confirms.
 */
export function changedPreviewTarget(conv: Conversation, input: { messageId?: unknown }, lookup: Lookup, settings?: SettingsStore) {
  const { messageId } = input;
  if (typeof messageId !== 'string' || messageId.length > 256) throw new HttpError(400, t().previewTarget);
  const msg = conv.messages.find((m) => m.id === messageId && m.author.kind === 'agent');
  if (!msg) throw missing();
  const roots = replyRoots(conv, msg, lookup);
  const runs = [...CONTAINER_ENTRIES, 'package.json'];
  const found = new Map<string, { folder: string; entry?: string; depth: number; rank: number; root: string }>();
  const add = (root: string, folder: string, entry?: string) => {
    const rank = entry ? 3 : runs.findIndex((n) => regularFile(join(folder, n))) < CONTAINER_ENTRIES.length ? 0 : 1;
    const depth = relative(root, folder).split(sep).filter(Boolean).length;
    const key = folder + '\0' + (entry ?? '');
    if (!found.has(key)) found.set(key, { folder, entry, depth, rank, root });
  };
  for (const file of changedFiles(conv, msg, lookup)) {
    const name = basename(file);
    const page = /\.html?$/i.test(name);
    const root = roots.find((r) => inside(r, file));
    if ((!page && !isAppEntry(name)) || !root || inDependencies(relative(root, file).split(sep))) continue;
    const folder = dirname(file);
    if (runs.includes(name)) {
      add(root, folder);
      continue;
    }
    // An index page's project, or another entry's (app.py, main.go…): the nearest folder above it that
    // runs. A report or another page stays a page, and an entry with nothing that runs it is no app yet.
    if (!page || /^index\.html?$/i.test(name)) {
      const project = runningFolder(root, folder);
      if (project) add(root, project);
    }
    if (page) add(root, folder, name);
  }
  const ranked = [...found.values()].sort((a, b) => a.depth - b.depth || a.rank - b.rank);
  for (const { folder, entry, root } of ranked) {
    try {
      const app = detectPreviewTarget(conv, { folder, messageId, ...(entry && { entry }) }, lookup, settings);
      // Where it is in its working directory (or the member's worktree), as the card shows it.
      const shown = [...relative(root, app.folder).split(sep).filter(Boolean), app.entry].join('/');
      return { ...app, shown };
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
