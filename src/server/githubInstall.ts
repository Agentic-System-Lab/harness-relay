import { join, win32, posix } from 'node:path';
import type { InstallJob } from './cliInstall';
import { BREW_DIRS, findOnPath, isProgram } from './executable';
import { t } from './i18n';
import { installPortableArchive, portableInstallEnv, systemArchiveTool, type ArchiveHost, type PortableBuild } from './portableInstall';
import { runProcess } from './process';
import { cliFolder } from './protect';

const VERSION = '2.105.0';
// https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_checksums.txt
const SUMS: Record<string, string> = {
  macOS_amd64: '23602cbccbbdc6285a8520745b714cb927ce2ca621779373c2a20cd8e33fda66',
  macOS_arm64: '2a5d03103ae444927383b93d9ffd65579a26e2eb900ce1cf11f55258d5319ded',
  linux_386: 'fd3b7a5fd9404bd4560f476018ca87bc080980774115fdf2792ffc09a67fb445',
  linux_amd64: '79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f',
  linux_arm64: 'b1278c75107423d818f1937fd92cafc9e5e9b606631568f68d7fb816f5885a02',
  linux_armv6: '245d24e084724ff2cce4fb914d632dd4d0976a4161de18e61ea619360209a3c5',
  windows_386: 'df02ca46a6655ffa0dd6d2f6d1387d1ebff63ab05272ff76301246925f67b8c7',
  windows_amd64: '8813a72c899900afaa10e3fec8fbc64b908c89dbfe837e95ed2fa500fc140627',
  windows_arm64: '5282a09c7757210c6e2dfb11a56b11e14e646df9b3b6a49f155465f5f881c3b7',
};

/** The version `gh --version` printed ("gh version 2.88.1 (2026-03-12)"). */
export function parseGhVersion(stdout: string): string | undefined {
  return /gh version (\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

export function githubCliBuild(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PortableBuild | undefined {
  const systems: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'linux', win32: 'windows' };
  const architectures: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'armv6', ia32: '386' };
  const target = systems[platform] + '_' + architectures[arch];
  const sha256 = SUMS[target];
  if (!sha256) return;
  const file = 'gh_' + VERSION + '_' + target + (platform === 'linux' ? '.tar.gz' : '.zip');
  return {
    url: 'https://github.com/cli/cli/releases/download/v' + VERSION + '/' + file,
    sha256,
    exe: platform === 'win32' ? 'bin/gh.exe' : 'bin/gh',
    stripDirectory: platform !== 'win32',
  };
}

const githubFolder = () => join(cliFolder(), 'github-cli');

/** Keep using gh from the user's PATH or package manager before the portable copy that Relay installed. */
export function findGithubCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  hasProgram = isProgram,
  folder = githubFolder(),
): string | undefined {
  // The desktop app may still have the PATH from before a system installation.
  const windowsPrograms = env.ProgramFiles ?? env.PROGRAMFILES;
  const extra = platform === 'win32' ? (windowsPrograms ? [win32.join(windowsPrograms, 'GitHub CLI')] : []) : BREW_DIRS;
  const onPath = findOnPath('gh', env, platform, extra, hasProgram);
  if (onPath) return onPath;
  const privateBin = (platform === 'win32' ? win32 : posix).join(folder, 'bin', platform === 'win32' ? 'gh.exe' : 'gh');
  return hasProgram(privateBin) ? privateBin : undefined;
}

export function githubCliAvailable(): boolean {
  return Boolean(findGithubCli());
}

export function canInstallGithubCli(platform = process.platform, arch: string = process.arch, tool = systemArchiveTool): boolean {
  return Boolean(githubCliBuild(platform, arch) && tool('curl') && tool('tar'));
}

interface GithubInstallHost extends ArchiveHost {
  build?: PortableBuild;
  folder?: string;
  current?: () => string | undefined;
  probe?: (exe: string) => Promise<boolean>;
}

export async function installGithubCli(
  job: InstallJob,
  { build = githubCliBuild(), folder = githubFolder(), current = findGithubCli, probe, ...host }: GithubInstallHost = {},
): Promise<void> {
  const signal = job.abort.signal;
  signal.throwIfAborted();
  if (current()) return;
  if (!build) throw new Error(t().appInstallManual);
  const env = portableInstallEnv();
  const version = async (exe: string) => {
    try {
      const result = await runProcess({ bin: exe, args: ['--version'], signal, env, timeoutMs: 10_000, maxCapture: 1024 });
      return result.code === 0 && parseGhVersion(result.stdout) === VERSION;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  job.append('GitHub CLI ' + VERSION + '\n');
  await installPortableArchive(
    build,
    folder,
    signal,
    env,
    probe ?? version,
    (step) => new Error({ tools: t().appInstallManual, download: t().githubArchiveDownload, run: t().githubArchiveRun }[step]),
    host,
  );
}
