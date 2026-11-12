import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runSync } from './process';

/**
 * Clears the user-immutable flag (`chflags uchg`, which a sandboxed run may set on what it can write)
 * on macOS: on `path` itself (`-h`: a link is changed, never followed), or on everything in it
 * (`-R -P`, links not followed). Elsewhere a no-op (Linux has no such flag a user can set).
 */
export function clearUserFlags(path: string, { tree = false }: { tree?: boolean } = {}): void {
  if (process.platform !== 'darwin') return;
  runSync('/usr/bin/chflags', tree ? ['-R', '-P', 'nouchg', path] : ['-h', 'nouchg', path], { timeoutMs: 30_000, quiet: true });
}

/**
 * Removes `path` best-effort; a link is never followed (removed as a link). With `restore` (only at
 * the next start, after the sweeps of leftover processes), each folder in it first gets its owner's
 * permissions back (u+rwx), so what a run did to them (`chmod 000` on a folder) cannot keep it. Not
 * while the server runs: a process of a run that survived could swap a folder for a link between the
 * check and the change, and the owner's permissions would be given to a folder outside. Logged when
 * something stays (a folder set aside is tried again at the next start).
 */
export function removeTree(path: string, { restore: fix = false }: { restore?: boolean } = {}): void {
  const restore = (p: string) => {
    let isDir: boolean;
    let mode: number;
    try {
      const st = lstatSync(p);
      isDir = st.isDirectory();
      mode = st.mode;
    } catch {
      return;
    }
    if (!isDir) return; // a file goes with its folder's permission; a link is not followed
    try {
      chmodSync(p, (mode & 0o7777) | 0o700);
      for (const name of readdirSync(p)) restore(join(p, name));
    } catch {
      /* not ours to change: rmSync below says what stays */
    }
  };
  if (fix) {
    clearUserFlags(path, { tree: true });
    restore(path);
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[open] could not remove ${path}:`, (err as Error).message);
  }
}
