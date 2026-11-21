import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path';
import { isProgram, sha256Of } from './executable';
import { runProcess } from './process';

/** Swap in the tested directory. Even when cancellation arrives during a rename, restore the original before releasing the installation slot. */
export async function publishPortableDirectory(staged: string, target: string, signal: AbortSignal, move = rename): Promise<void> {
  signal.throwIfAborted();
  const hadPrevious = existsSync(target);
  // A failed rollback must leave the backup outside the staging folder the caller cleans up.
  const previous = dirname(staged) + '-previous';
  if (hadPrevious) await move(target, previous);
  let published = false;
  try {
    signal.throwIfAborted();
    await move(staged, target);
    published = true;
    signal.throwIfAborted();
  } catch (err) {
    if (published) await move(target, staged);
    if (hadPrevious) await move(previous, target);
    throw err;
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true, maxRetries: 3 });
}

export function systemArchiveTool(name: string): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe')]
      : ['/usr/bin/' + name, '/bin/' + name];
  return candidates.find(isProgram);
}

export function portableInstallEnv(source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {};
  // Keep OS, HTTPS proxy and certificate settings. Never inherit a PowerShell profile/module path,
  // .NET startup hooks, cloud service credentials, or npm's project-local bin directories.
  for (const [key, val] of Object.entries(source)) {
    if (
      /^(HOME|USERPROFILE|SYSTEMROOT|WINDIR|ProgramFiles(?:\(x86\))?|ProgramData|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|XDG_DATA_HOME|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|LANG)$/i.test(
        key,
      )
    )
      env[key] = val;
  }
  env.PATH = (source.PATH ?? source.Path ?? '')
    .split(delimiter)
    .filter((p) => isAbsolute(p) && !/(^|[/\\])node_modules([/\\]|$)/i.test(p))
    .join(delimiter);
  env.PATHEXT = '.EXE';
  return env;
}

export interface PortableBuild {
  url: string;
  sha256: string;
  /** Relative to the published directory. */
  exe: string;
  /** Some makers wrap their binary and license in a versioned top-level directory. */
  stripDirectory?: boolean;
}

export type ArchiveFailure = 'tools' | 'download' | 'run';
export interface ArchiveHost {
  tool?: typeof systemArchiveTool;
  run?: (bin: string, args: string[], signal: AbortSignal) => Promise<boolean>;
}

/** Verify the maker's fixed digest, unpack in a sibling directory, and publish only after the program starts there. */
export async function installPortableArchive(
  build: PortableBuild,
  folder: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  probe: (exe: string) => Promise<boolean>,
  failure: (step: ArchiveFailure) => Error,
  {
    tool = systemArchiveTool,
    run = async (bin, args, stop) => {
      const result = await runProcess({ bin, args, signal: stop, timeoutMs: 300000, cwd: dirname(folder), env, maxCapture: 256 });
      return result.code === 0 && !result.timedOut;
    },
  }: ArchiveHost = {},
): Promise<void> {
  const curl = tool('curl');
  const tar = tool('tar');
  if (!curl || !tar) throw failure('tools');
  signal.throwIfAborted();
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(folder + '-install-');
  const archive = join(temp, 'archive');
  const staged = join(temp, 'runtime');
  try {
    const download = await run(
      curl,
      [
        '-q',
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--retry',
        '2',
        '--max-filesize',
        '134217728',
        '--output',
        archive,
        build.url,
      ],
      signal,
    );
    if (!download || (await sha256Of(archive)) !== build.sha256) throw failure('download');
    signal.throwIfAborted();
    await mkdir(staged, { mode: 0o700 });
    const extract = ['-xf', archive, '-C', staged];
    if (build.stripDirectory) extract.push('--strip-components', '1');
    if (!(await run(tar, extract, signal))) throw failure('run');
    const exe = join(staged, build.exe);
    if (!build.exe.endsWith('.exe')) await chmod(exe, 0o755);
    signal.throwIfAborted();
    if (!(await probe(exe))) throw failure('run');
    await publishPortableDirectory(staged, folder, signal);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
