import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { isProgram, sha256Of } from '../executable';
import { t } from '../i18n';
import { runProcess } from '../process';
import { cliFolder } from '../protect';

// SHA-256 digests from Microsoft's LTS release:
// https://github.com/PowerShell/PowerShell/releases/tag/v7.6.10
const VERSION = '7.6.10';
const SUMS: Record<string, string> = {
  'osx-arm64': 'fb6f1978c7d3266d4ced9391de6519d971ef92bd036e5b8be62f1ccdfbda9477',
  'osx-x64': 'aa55bef6375e7b1a61e860866a38af5f2366ceb4189293e6b73b7777cb1d7793',
  'linux-x64': 'e261cabc91c78a9afe8d1e5f24731ab0d38204735ab2ec94b0af55102652e10d',
  'linux-arm64': '439432cdecf4418413b9a8f547e3ab4d9b40e8e4258913ec3d15fc92c67a9235',
  'linux-arm32': 'c075be079bda46dc64053ae7daaec4811171fe66227306f1e22adaccbfbb2cc9',
  'linux-musl-x64': '5b31557a9a99471692ba9733e058294fb2ea9e50419ac5acb74c0fd278c3d9e0',
  'win-x64': '7d871531806eb1646264e4bbabd9f0c30c23355591bc756bb9909448c29ae166',
  'win-arm64': '1d36ecac1d8f5ac9577cfdfc426af41f3e90cbca6c52445e7db167f532b3a7ab',
  'win-x86': '221bad2ba6eff81f2661c8f467eca286f89173b0e0c044c858f18dbbeacb9891',
};

export function powerShellBuild(platform: NodeJS.Platform, arch: string, musl: boolean) {
  const systems: Partial<Record<NodeJS.Platform, string>> = { darwin: 'osx', linux: musl ? 'linux-musl' : 'linux', win32: 'win' };
  const os = systems[platform];
  if (!os) return;
  const target = os + '-' + (arch === 'arm' ? 'arm32' : arch === 'ia32' ? 'x86' : arch);
  const sha256 = SUMS[target];
  if (!sha256) return;
  const windows = platform === 'win32';
  const file = (windows ? 'PowerShell-' : 'powershell-') + VERSION + '-' + target + (windows ? '.zip' : '.tar.gz');
  return {
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v' + VERSION + '/' + file,
    sha256,
    exe: windows ? 'pwsh.exe' : 'pwsh',
  };
}

export const runtimeFolder = () => join(cliFolder(), 'teams-powershell-' + VERSION);

export const teamsModulesFolder = () => join(cliFolder(), 'teams-modules');

/** Swap in the tested directory. Even when cancellation arrives during a rename, restore the original before releasing the installation slot. */
export async function publishTeamsDirectory(staged: string, target: string, signal: AbortSignal, move = rename): Promise<void> {
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

export class TeamsRuntimeError extends Error {}

function systemTool(name: string): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe')]
      : ['/usr/bin/' + name, '/bin/' + name];
  return candidates.find(isProgram);
}

type Run = (bin: string, args: string[], signal: AbortSignal) => Promise<boolean>;

/** Publish only an intact official archive whose pwsh starts here. A cancelled install leaves any previous runtime in place. */
export async function installTeamsRuntime(
  signal: AbortSignal,
  probe: (executable: string) => Promise<number | null>,
  env: NodeJS.ProcessEnv,
  {
    build = powerShellBuild(
      process.platform,
      process.arch,
      ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1', '/lib/ld-musl-armhf.so.1'].some(existsSync),
    ),
    folder = runtimeFolder(),
    tool = systemTool,
    run = async (bin, args, stop) => {
      const result = await runProcess({ bin, args, signal: stop, timeoutMs: 300000, cwd: dirname(folder), env, maxCapture: 256 });
      return result.code === 0 && !result.timedOut;
    },
  }: { build?: ReturnType<typeof powerShellBuild>; folder?: string; tool?: typeof systemTool; run?: Run } = {},
): Promise<void> {
  if (!build) throw new TeamsRuntimeError(t().teamsRuntimeUnsupported);
  const curl = tool('curl');
  const tar = tool('tar');
  if (!curl || !tar) throw new TeamsRuntimeError(t().teamsRuntimeTools);
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
    if (!download || (await sha256Of(archive)) !== build.sha256) throw new TeamsRuntimeError(t().teamsRuntimeDownload);
    signal.throwIfAborted();
    await mkdir(staged, { mode: 0o700 });
    if (!(await run(tar, ['-xf', archive, '-C', staged], signal))) throw new TeamsRuntimeError(t().teamsRuntimeRun);
    const exe = join(staged, build.exe);
    if (build.exe === 'pwsh') await chmod(exe, 0o755);
    signal.throwIfAborted();
    const result = await probe(exe);
    if (result !== 0 && result !== 21) throw new TeamsRuntimeError(t().teamsRuntimeRun);
    await publishTeamsDirectory(staged, folder, signal);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
