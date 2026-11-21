import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Where Homebrew puts its commands when the server PATH does not include them. */
export const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];

/** `name` on PATH (with PATHEXT on Windows), then in `extra` directories. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  extra: string[] = [],
  isFile: (p: string) => boolean = fileExists,
): string | undefined {
  // `platform`'s own separators, whichever system this runs on.
  const { delimiter, join: joinPath } = platform === 'win32' ? win32 : posix;
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter), ...extra].filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = joinPath(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return undefined;
}

export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isProgram(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A file's SHA-256 checksum, in hex. */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
