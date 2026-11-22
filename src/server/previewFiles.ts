import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mediaType } from '../shared/media';
import { looksSecret } from '../shared/share';
import { fileKey, withheldFileKeys } from './db';
import { HttpError } from './errors';
import { t } from './i18n';
import { agentFolderOptions, agentFolders, appBrowserDirs, protectedReads, realPath } from './protect';
import { DATA_DIR, type SettingsStore } from './settings';

const MiB = 1024 * 1024;
const limits = { items: 4096, depth: 32, fileBytes: 16 * MiB, totalBytes: 64 * MiB };
const missing = () => new HttpError(404, t().fileNotFound);
const changed = () => new HttpError(409, t().previewSnapshotChanged);
const tooLarge = () => new HttpError(413, t().previewSnapshotLimit);

// Reject Windows devices, alternate data streams, short-name aliases and trimmed names on every host.
// Names from both the browser and directory entries will also be used inside a Linux container.
function safeName(name: string): boolean {
  return (
    !!name &&
    !looksSecret(name) &&
    !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) &&
    !/[ .]$|~\d/i.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) &&
    !/^(?:node_modules|coverage|__pycache__|vendor|npmrc|netrc|yarnrc)$/i.test(name) &&
    !/\.(?:db|sqlite3?|duckdb)(?:$|[-.])|\.(?:crt|cer|der|pkcs12|db3|mdb|bak|log)$/i.test(name)
  );
}

const PUBLIC_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.wasm': 'application/wasm',
  }),
);
const privateSource = /^(?:src|server|backend|api|test|tests|config|db|database|migrations|private|coverage)$/i;
function publicType(path: string): string | undefined {
  const names = path.split('/');
  if (!names.every(safeName) || names.slice(0, -1).some((n) => privateSource.test(n))) return;
  const file = names.at(-1)!;
  if (/(?:^|[.-])(?:config|server|backend|test|spec)(?:[.-]|$)/i.test(file)) return;
  return PUBLIC_TYPES.get(extname(file).toLowerCase()) ?? mediaType(file);
}

/** Public output only. Also applied when the runtime hands the server a map of built files. */
export function isPreviewAsset(path: string): boolean {
  return Boolean(publicType(path));
}

/** Files the npm project may need to install offline, build and start. They are never served by this map. */
function sourceFile(path: string): boolean {
  return (
    Boolean(PUBLIC_TYPES.get(extname(path).toLowerCase()) ?? mediaType(path)) ||
    /\.(?:[cm]?[jt]sx?|json|s[ac]ss|less|vue|svelte|astro|sql|mdx?|ya?ml|toml|graphql|gql|sh|ejs|pug|hbs)$/i.test(path)
  );
}

/**
 * A container build may need any of the project's files, in any language. Dotfiles stay out, as
 * everywhere (secrets often hide there), apart from these, which only pin versions or shape the
 * build context. Folders that hold installed dependencies or build output stay out too.
 */
const CONTAINER_DOTFILES = new Set(['.dockerignore', '.python-version', '.nvmrc', '.node-version', '.ruby-version', '.tool-versions']);
const CONTAINER_SKIPPED = /^(?:target|venv|__pypackages__|bower_components)$/;

function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

// Darwin's O_NOFOLLOW_ANY (sys/fcntl.h) applies to every component. Linux also checks the opened
// handle's kernel-resolved path. On all systems keep each traversed directory's identity and change
// time until its children have been copied. Renames, junction swaps or a replaced parent invalidate
// the whole result, even when the file itself kept its identity.
const readFlags = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW);

/** Only the owner's executable bit needs to cross into the unprivileged Linux container. */
class PreviewSnapshot extends Map<string, Buffer> {
  readonly executables = new Set<string>();
}

/**
 * A snapshot's identity: every file's name, executable bit and contents, in name order. Publishing
 * takes the snapshot again and compares the two, so that what goes online is what was previewed.
 */
export function previewDigest(files: ReadonlyMap<string, Buffer>, executables: ReadonlySet<string> = new Set()): string {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    hash.update(name + '\0' + (executables.has(name) ? 'x' : '-') + '\0' + data.length + '\0');
    hash.update(data);
  }
  return hash.digest('hex');
}

function inside(dir: string, path: string): boolean {
  const part = relative(dir, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

type PreviewSettings = Pick<SettingsStore, 'agentHome' | 'accountsDir' | 'openAgentRoots' | 'bin' | 'env'>;

/** Browser and CLI profile folders under the Windows account's local and roaming AppData. */
function windowsPrivateProfiles(): string[] {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return [
    ...[
      'Google/Chrome',
      'Google/Chrome Beta',
      'Google/Chrome Dev',
      'Google/Chrome SxS',
      'Google/Chrome for Testing',
      'Chromium',
      'Microsoft/Edge',
      'Microsoft/Edge Beta',
      'Microsoft/Edge Dev',
      'Microsoft/Edge SxS',
      'BraveSoftware',
      'Vivaldi',
      'Mozilla/Firefox',
    ].map((path) => join(local, path)),
    ...['Mozilla/Firefox', 'Opera Software', 'Cursor', 'GitHub CLI', 'gcloud', 'Block/goose'].map((path) => join(roaming, path)),
  ];
}

/** The paths a preview must withhold, including when the chat root is itself inside one.
 * Only a worktree recorded for the selected member can be read below Relay's data directory. */
export function previewPrivatePath(
  settings?: PreviewSettings,
  worktrees: readonly string[] = [],
  data = DATA_DIR,
): (path: string) => boolean {
  const home = homedir();
  const env = process.env;
  const inherited = [
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG',
    'CLINE_DATA_DIR',
    'GOOSE_PATH_ROOT',
    'GOOSE_CONFIG_DIR',
    'PI_CODING_AGENT_DIR',
    'OPENHANDS_HOME',
    'GH_CONFIG_DIR',
    'DOCKER_CONFIG',
    'CLOUDSDK_CONFIG',
  ]
    .map((key) => env[key])
    .filter((path): path is string => Boolean(path && isAbsolute(path)));
  const privatePaths = [
    ...new Set(
      [
        ...protectedReads(),
        ...appBrowserDirs(),
        ...windowsPrivateProfiles(),
        ...agentFolders(settings ? agentFolderOptions(settings) : {}),
        ...agentFolders({ env: {} }),
        ...(settings?.openAgentRoots() ?? []),
        ...inherited,
        ...['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.cline', '.pi', '.openhands'].map((name) => join(home, name)),
        ...['opencode', 'goose', 'gh', 'gcloud'].map((name) => join(env.XDG_CONFIG_HOME || join(home, '.config'), name)),
        ...['opencode', 'goose'].map((name) => join(env.XDG_DATA_HOME || join(home, '.local', 'share'), name)),
      ].flatMap((path) => [resolve(path), realPath(resolve(path))]),
    ),
  ];
  const dataRoot = realPath(data);
  const treeRoot = join(dataRoot, 'worktrees');
  const allowedTrees = worktrees.flatMap((path) => {
    // Compare the registered path within the real data folder with its current real location.
    // A junction that now points at a different member must not repurpose this exception.
    const expected = join(dataRoot, relative(data, path));
    const actual = realPath(path);
    return inside(treeRoot, expected) && relative(treeRoot, expected).split(sep).length >= 2 && !relative(expected, actual) ? [actual] : [];
  });
  return (path) =>
    privatePaths.some((base) => inside(base, path)) || (inside(dataRoot, path) && !allowedTrees.some((tree) => inside(tree, path)));
}

/** Only folders that may be copied into a preview may be inspected during project detection. */
export function previewFolderParts(folder: string): string[] {
  const parts = !folder || folder === '.' ? [] : folder.split('/');
  if (!parts.every(safeName) || parts.length > limits.depth) throw missing();
  return parts;
}

export async function previewSnapshot(
  root: string,
  folder: string,
  mode: 'static' | 'build' | 'server' | 'container',
  signal?: AbortSignal,
  isPrivate = previewPrivatePath(),
): Promise<PreviewSnapshot> {
  signal?.throwIfAborted();
  const parts = previewFolderParts(folder);
  const output = new PreviewSnapshot();
  const withheld = withheldFileKeys();
  let items = 0;
  let total = 0;

  const readFile = async (path: string, name: string, before: BigIntStats) => {
    if (
      !before.isFile() ||
      isPrivate(path) ||
      before.nlink !== 1n ||
      withheld.has(fileKey({ dev: Number(before.dev), ino: Number(before.ino) }))
    )
      return;
    if (before.size > limits.fileBytes || total + Number(before.size) > limits.totalBytes) throw tooLarge();
    const file = await open(path, readFlags);
    try {
      if (!sameVersion(before, await file.stat({ bigint: true }))) throw changed();
      if (process.platform === 'linux' && relative(path, await realpath('/proc/self/fd/' + file.fd))) throw changed();
      const data = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < data.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw changed();
        offset += bytesRead;
      }
      if (!sameVersion(before, await file.stat({ bigint: true }))) throw changed();
      total += data.length;
      output.set(name, data);
      if (mode !== 'static' && (process.platform === 'win32' ? /\.sh$/i.test(name) : (before.mode & 0o100n) !== 0n)) {
        output.executables.add(name);
      }
    } finally {
      await file.close();
    }
  };

  const walk = async (dir: string, prefix: string, level: number, selecting: number) => {
    signal?.throwIfAborted();
    if (level > limits.depth || total >= limits.totalBytes) throw tooLarge();
    if (isPrivate(dir)) {
      if (prefix) return;
      throw missing();
    }
    const before = await lstat(dir, { bigint: true });
    if (!before.isDirectory() || relative(dir, await realpath(dir))) throw missing();
    if (selecting < parts.length) {
      await walk(join(dir, parts[selecting]), '', 0, selecting + 1);
    } else {
      // Stream names rather than allocating the contents of an unbounded directory at once.
      for await (const item of await opendir(dir)) {
        signal?.throwIfAborted();
        // Count the directory entry itself in the memory budget as well as the contents
        // retained below. Even a tree of empty folders cannot consume unlimited work.
        total += Buffer.byteLength(item.name);
        if (++items > limits.items || total > limits.totalBytes) throw tooLarge();
        const container = mode === 'container';
        const dotfile = container && item.isFile() && CONTAINER_DOTFILES.has(item.name);
        if ((!safeName(item.name) && !dotfile) || item.isSymbolicLink()) continue;
        const path = join(dir, item.name);
        const name = prefix + item.name;
        if (item.isDirectory()) {
          if (container ? !CONTAINER_SKIPPED.test(item.name) : mode !== 'static' || !privateSource.test(item.name))
            await walk(path, name + '/', level + 1, selecting);
        } else if (item.isFile() && (container || (mode === 'static' ? isPreviewAsset(name) : sourceFile(name)))) {
          await readFile(path, name, await lstat(path, { bigint: true }));
        }
      }
    }
    if (!sameVersion(before, await lstat(dir, { bigint: true })) || relative(dir, await realpath(dir))) throw changed();
  };
  try {
    const before = await lstat(root, { bigint: true });
    if (!before.isDirectory()) throw missing();
    // previewTarget handed us the already canonical root. A different real path now would
    // silently retarget the whole copy, even if its last component still looks like a directory.
    if (!isAbsolute(root) || relative(root, await realpath(root))) throw missing();
    await walk(root, '', 0, 0);
    if (!sameVersion(before, await lstat(root, { bigint: true })) || relative(root, await realpath(root))) throw changed();
    signal?.throwIfAborted();
    return output;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof HttpError) throw error;
    throw missing(); // No host paths or arbitrary filesystem errors in the preview panel.
  }
}

/** Only caller-supplied public paths, typed by Relay. No redirects or directory listing. */
export function previewFileResponse(files: ReadonlyMap<string, Buffer>, request: Request, entry = 'index.html'): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  let path: string;
  try {
    const names = url.pathname.slice(1).split('/').map(decodeURIComponent);
    const directory = !names.at(-1);
    if (directory) names.pop();
    if (!names.every(safeName)) return new Response(null, { status: 404 });
    path = names.length ? (directory ? [...names, 'index.html'] : names).join('/') : entry;
  } catch {
    return new Response(null, { status: 404 });
  }
  const type = publicType(path);
  const data = type && files.get(path);
  if (!type || !data) return new Response(null, { status: 404 });
  // Assets are immutable. Stream the saved buffer to HTTP without copying it for each request.
  const body =
    request.method === 'HEAD'
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        });
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(data.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
