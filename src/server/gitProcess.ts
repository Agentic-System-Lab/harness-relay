import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { GIT_MISSING } from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';
import { capture, CommandNotFoundError } from './process';
import { BREW_DIRS, findOnPath, isProgram } from './executable';

/** Git for Windows' default locations, including when this process has an older PATH. */
export function windowsGitRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.ProgramW6432,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs'),
  ].flatMap((base) => (base && win32.isAbsolute(base) ? [win32.join(base, 'Git')] : []));
}

function windowsGitOutsidePath(env: NodeJS.ProcessEnv, hasProgram: typeof isProgram): string | undefined {
  return windowsGitRoots(env)
    .map((root) => win32.join(root, 'cmd', 'git.exe'))
    .find(hasProgram);
}

/** Agents started after a Git for Windows install also get Git, without restarting the server. */
export function addWindowsGitToPath(env: NodeJS.ProcessEnv, hasProgram = isProgram): void {
  if (findOnPath('git', env, 'win32', [], hasProgram)) return;
  const git = windowsGitOutsidePath(env, hasProgram);
  if (!git) return;
  const key =
    Object.keys(env)
      .sort()
      .find((name) => name.toUpperCase() === 'PATH') ?? 'Path';
  env[key] = [env[key], win32.dirname(git)].filter(Boolean).join(';');
}

function appleShim(path: string): boolean {
  try {
    return realpathSync(path) === '/usr/bin/git';
  } catch {
    return false;
  }
}

export async function gitCommand(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  hasProgram = isProgram,
  selectedDeveloperDir = async () => {
    const result = await capture('/usr/bin/xcode-select', ['--print-path'], env, { timeoutMs: 3000 });
    return result.code === 0 ? result.stdout.trim() : '';
  },
): Promise<string> {
  if (platform === 'win32') {
    const onPath = findOnPath('git', env, platform, [], hasProgram);
    return onPath ?? windowsGitOutsidePath(env, hasProgram) ?? 'git';
  }
  if (platform !== 'darwin') return 'git';
  const onPath = findOnPath('git', env, platform, [], hasProgram);
  if (onPath && onPath !== '/usr/bin/git' && !appleShim(onPath)) return posix.resolve(onPath);
  // Apple's /usr/bin/git is a stub that opens the system install dialog when the tools are missing.
  // Inspect the selected developer directory before running the real Git binary.
  const developer = await selectedDeveloperDir();
  if (posix.isAbsolute(developer)) {
    const git = posix.join(developer, 'usr/bin/git');
    if (hasProgram(git)) return git;
  }
  const other = findOnPath('git', env, platform, BREW_DIRS, (path) => path !== '/usr/bin/git' && !appleShim(path) && hasProgram(path));
  if (other) return posix.resolve(other);
  throw gitMissing();
}

export function gitMissing(): HttpError {
  return new HttpError(400, t().gitMissing, GIT_MISSING);
}

/** Run a Git command and distinguish a missing executable from an error returned by Git. */
export async function captureGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts?: Parameters<typeof capture>[3],
  bin?: string,
): ReturnType<typeof capture> {
  try {
    return await capture(bin ?? (await gitCommand(env)), args, env, opts);
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw gitMissing();
    throw err;
  }
}
