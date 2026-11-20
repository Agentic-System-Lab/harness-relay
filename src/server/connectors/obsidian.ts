import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  ftruncateSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type { OutboxPreview } from '../../shared/types';
import { HttpError } from '../errors';
import { resolveInRoot } from '../files';
import type { GatewayTool, PreparedOutboxCall } from '../gateway';
import { t } from '../i18n';
import { overlaps, protectedReads, relayFolderRefusal, type AgentFolderOptions } from '../protect';

/** Store the canonical folder, and check it is still that vault whenever a tool opens it. */
export function checkedVault(path: string, options: AgentFolderOptions): string {
  let root: string;
  try {
    if (!isAbsolute(path)) throw new Error();
    root = realpathSync.native(path);
    if (!lstatSync(join(root, '.obsidian')).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, t().appsVault);
  }
  const refusal = relayFolderRefusal({ cwd: root, permission: 'edit' }, options);
  if (refusal) throw new HttpError(400, refusal);
  if (protectedReads().some((p) => overlaps(root, p))) throw new HttpError(400, t().appsVault);
  return root;
}

export function vaultPath(root: string, input: unknown) {
  const path = input ?? '';
  if (
    typeof path !== 'string' ||
    path.includes('\\') ||
    path.includes(':') ||
    isAbsolute(path) ||
    path.split('/').some((part) => part.startsWith('.'))
  )
    throw new Error(t().fileNotFound);
  const found = resolveInRoot(root, path);
  // A directory alias or a file link could point to hidden settings or a different type of file.
  if (found.rel !== path || realpathSync.native(found.real) !== join(root, ...path.split('/'))) throw new Error(t().fileNotFound);
  return found;
}

const NOTE_BYTES = 48 * 1024;
type Note = NonNullable<OutboxPreview['note']>;
const identity = (s: BigIntStats) => `${s.dev}/${s.ino}`;
const revision = (s: BigIntStats) => `${identity(s)}/${s.birthtimeNs}/${s.ctimeNs}/${s.mtimeNs}/${s.size}`;
const conflict = () => new Error(t().obsidianChanged);

function notePath(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !/\.md$/i.test(input) ||
    /[\\<>:"|?*\x00-\x1f\x7f]/.test(input) ||
    input.split('/').some((p) => !p || p.startsWith('.') || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|(?:com|lpt)[0-9¹²³])(?:\.|$)/i.test(p))
  )
    throw new Error(t().obsidianPath);
  return input;
}

function markdown(content: unknown): string {
  if (
    typeof content !== 'string' ||
    content.includes('\0') ||
    Buffer.byteLength(content) > NOTE_BYTES ||
    Buffer.from(content, 'utf8').toString('utf8') !== content
  )
    throw new Error(t().obsidianContent);
  return content;
}

/** Only bounded, complete UTF-8 text is eligible. Keep the BOM, empty content and exact line endings for the preview. */
interface OriginalNote {
  text: string;
  version: string;
}

function original(vault: string, path: string, use?: (fd: number, note: OriginalNote) => void): OriginalNote {
  const { real } = vaultPath(vault, path);
  const check = () => {
    const st = lstatSync(vaultPath(vault, path).real, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) throw conflict();
    if (st.size > BigInt(NOTE_BYTES)) throw new Error(t().obsidianContent);
    return st;
  };
  const initial = check();
  const access = use ? constants.O_RDWR : constants.O_RDONLY;
  const fd = openSync(real, access | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (revision(opened) !== revision(initial) || revision(check()) !== revision(opened)) throw conflict();
    const size = Number(opened.size);
    const bytes = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, bytes, at, size - at, at);
      if (!n) throw conflict();
      at += n;
    }
    if (revision(fstatSync(fd, { bigint: true })) !== revision(opened)) throw conflict();
    const text = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error(t().obsidianContent);
    const note = { text, version: revision(opened) };
    use?.(fd, note);
    return note;
  } finally {
    closeSync(fd);
  }
}

/** Even a create must pin an existing, visible parent. An entry that is a dangling link is occupied too. */
function location(vault: string, path: string) {
  const relativeParent = posix.dirname(path);
  const { real: parent } = vaultPath(vault, relativeParent === '.' ? '' : relativeParent);
  const stat = lstatSync(parent, { bigint: true });
  if (!stat.isDirectory()) throw new Error(t().obsidianPath);
  return {
    parent,
    full: join(parent, posix.basename(path)),
    vaultKey: identity(lstatSync(vault, { bigint: true })),
    parentKey: identity(stat),
  };
}

/** Copy ACLs and extended attributes on platforms with a metadata-aware system copy. Both paths
 * are descriptors: a replaced path cannot redirect the copy or expose the original's contents. */
function copyNoteMetadata(source: number, staged: number): boolean {
  const args =
    process.platform === 'darwin'
      ? ['-p', '/dev/fd/3', '/dev/fd/4']
      : process.platform === 'linux'
        ? ['--attributes-only', '--preserve=all', '/proc/self/fd/3', '/proc/self/fd/4']
        : undefined;
  if (!args) return false;
  const cp = spawnSync('/bin/cp', args, {
    stdio: ['ignore', 'ignore', 'ignore', source, staged],
    env: { PATH: '/usr/bin:/bin' },
    timeout: 3000,
  });
  if (cp.status !== 0) return false;
  // Some copies retain only as much of the source's ownership and access as the user may set.
  const a = fstatSync(source),
    b = fstatSync(staged);
  return a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}

/** Use explicit offsets: the metadata copy may have left the descriptor positioned after the old data. */
function replaceText(fd: number, text: string) {
  const bytes = Buffer.from(text);
  let at = 0;
  while (at < bytes.length) {
    const written = writeSync(fd, bytes, at, bytes.length - at, at);
    if (!written) throw new Error(t().obsidianWriteFailed);
    at += written;
  }
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
}

const digest = (note: Note) => createHash('sha256').update(JSON.stringify(note)).digest('hex');

export function noteWriteTools(selectedVault: () => string, unavailable: () => string | undefined, vaultId = () => ''): GatewayTool[] {
  return (['create', 'edit'] as const).map((operation): GatewayTool => {
    const create = operation === 'create';
    return {
      name: `obsidian_${operation}`,
      group: 'obsidian',
      tier: 'send',
      description: `Propose ${create ? 'a new' : 'a replacement for an existing'} Markdown note in the selected Obsidian vault. Use a visible .md path in an existing folder and complete UTF-8 text (48 KiB maximum). The user must review and save every proposal in the chat. Never write the file another way.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative .md path.' },
          content: { type: 'string', description: 'Complete proposed Markdown.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      unavailable,
      describe: () => ({ title: `obsidian_${operation}` }),
      prepare(a): PreparedOutboxCall {
        const path = notePath(a.path);
        const after = markdown(a.content);
        const vault = selectedVault();
        const { full, parentKey, vaultKey } = location(vault, path);
        const existing = create ? undefined : original(vault, path);
        if (create && lstatSync(full, { throwIfNoEntry: false })) throw new Error(t().obsidianExists);
        const note = { vault, path, before: existing?.text ?? null, after };
        return {
          title: create ? t().obsidianCreate(path) : t().obsidianEdit(path),
          preview: { fields: [], note },
          args: { vaultId: vaultId(), vaultKey, parentKey, version: existing?.version ?? null, digest: digest(note) },
        };
      },
      send: async (args, item) => {
        const note = item.preview.note;
        if (!note || (note.before === null) !== create || digest(note) !== args.digest) throw conflict();
        const path = notePath(note.path);
        const after = markdown(note.after);
        const destination = () => {
          if (selectedVault() !== note.vault || vaultId() !== args.vaultId) throw conflict();
          const dest = location(note.vault, path);
          if (dest.parentKey !== args.parentKey || dest.vaultKey !== args.vaultKey) throw conflict();
          return dest;
        };
        const { parent, full } = destination();
        const validate = (file: OriginalNote) => {
          if (file.version !== args.version || file.text !== note.before) throw conflict();
        };
        const empty = () => {
          if (lstatSync(full, { throwIfNoEntry: false })) throw new Error(t().obsidianExists);
        };
        // A metadata-aware replacement and an exclusive create first write a sibling from the full approved text.
        const temp = join(parent, `.relay-note-${randomUUID()}.tmp`);
        const fd = openSync(temp, 'wx+', 0o600);
        const tmpId = identity(fstatSync(fd, { bigint: true }));
        const checkTemp = () => {
          const st = lstatSync(temp, { bigint: true, throwIfNoEntry: false });
          if (!st || st.nlink !== 1n || identity(st) !== tmpId) throw conflict();
        };
        try {
          destination();
          checkTemp();
          if (create) empty();
          else {
            let inPlace = false;
            original(note.vault, path, (source, file) => {
              validate(file);
              if (copyNoteMetadata(source, fd)) return;
              // Keep the original inode wherever its complete metadata cannot be copied (including Windows).
              // Opening never truncates. Recheck after the copy attempt, then write only this pinned descriptor.
              destination();
              validate(original(note.vault, path));
              if (revision(fstatSync(source, { bigint: true })) !== file.version) throw conflict();
              try {
                replaceText(source, after);
              } catch (error) {
                // Restore the approved preimage for an ordinary write error while this same single-link file remains.
                const st = fstatSync(source, { bigint: true });
                if (st.nlink === 1n && identity(st) === identity(lstatSync(vaultPath(note.vault, path).real, { bigint: true }))) {
                  replaceText(source, file.text);
                }
                throw error;
              }
              inPlace = true;
            });
            if (inPlace) return t().obsidianSaved(path);
          }
          checkTemp();
          replaceText(fd, after);
          destination();
          checkTemp();
          if (create) {
            // Atomic no-clobber even if another application has just created the note.
            try {
              linkSync(temp, full);
            } catch (error) {
              // FAT and some network vaults do not support hard links. Exclusive copy still refuses an occupied name.
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'EEXIST') throw new Error(t().obsidianExists);
              if (code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') throw error;
              destination();
              checkTemp();
              copyFileSync(temp, full, constants.COPYFILE_EXCL);
            }
          } else {
            validate(original(note.vault, path));
            renameSync(temp, full);
          }
        } finally {
          closeSync(fd);
          // Never follow a moved parent to remove a different file with this name.
          const st = lstatSync(temp, { bigint: true, throwIfNoEntry: false });
          if (st && identity(st) === tmpId) unlinkSync(temp);
        }
        return t().obsidianSaved(path);
      },
    };
  });
}
