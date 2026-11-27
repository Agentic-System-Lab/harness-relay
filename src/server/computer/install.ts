import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { InstallJob } from '../cliInstall';
import { findOnPath, isProgram } from '../executable';
import { t } from '../i18n';
import { installPortableArchive, portableInstallEnv, systemArchiveTool, type ArchiveHost, type PortableBuild } from '../portableInstall';
import { runProcess, runSync } from '../process';
import { cliFolder } from '../protect';

/*
 * Cua's command-line tool (`cua`, https://github.com/trycua/cua), which starts the computers the computer
 * tools drive (`session.ts`): installed from Settings → Common apps → Computer on its own, into a folder
 * of Harness Relay's (`clis/cua`), from the maker's release at the version below, its checksum checked;
 * or the one the user installed themselves, when it is new enough.
 */

/** The version Settings installs, the one the computer tools were checked with. */
export const CUA_VERSION = '0.31.2';
/** The oldest `cua` the computer tools start: its `mcp` server's computer tools and `sb` commands as they use them. */
export const CUA_MIN_VERSION = '0.31.0';

// https://github.com/trycua/cua/releases/download/cua-sdk-v0.31.2/checksums.txt, and each archive's size.
const SIZES: Record<string, number> = {
  'darwin-arm64': 84_536_919,
  'darwin-x64': 91_509_187,
  'linux-arm64': 87_722_768,
  'linux-x64': 95_432_014,
  'windows-arm64': 88_650_666,
  'windows-x64': 95_948_086,
};
const SUMS: Record<string, string> = {
  'darwin-arm64': '6f27a92d7e8734391520bc5ff48962b9954c6aa9b8877136a5c6b92846656c46',
  'darwin-x64': '9262dbf8f0b91549c2333dfebf130ef48a89e1cc0b57c6e87a4ec8b2c2ad776b',
  'linux-arm64': 'cb3e6d19febbb3cc1c2ac6a9560db489bece0b9f33a06651fb3704c1de0a8710',
  'linux-x64': '64c3a3299028afe2232420060c08d849f1480f506db1dcf5fa944efc8d4e60ae',
  'windows-arm64': 'b80cb74d290a4902b51e97a1aa96375bf2d38eb20894d52a3cf75f5c0f78f6a7',
  'windows-x64': '4ecf32607d6fa96c3ba00434615aa9d0a547d7a53b00bfe977b172bb9aa4cc10',
};

/** The version `cua --version` printed ("cua 0.31.2"). */
export function parseCuaVersion(stdout: string): string | undefined {
  return /^cua (\d+\.\d+\.\d+)/m.exec(stdout)?.[1];
}

/** Whether version `a` is at least `b` (both `x.y.z`). */
export function atLeast(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
}

/** The maker's archive for this system, or undefined where it publishes none. */
export function cuaBuild(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PortableBuild | undefined {
  const systems: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  const architectures: Record<string, string> = { x64: 'x64', arm64: 'arm64' };
  const system = systems[platform];
  const cpu = architectures[arch];
  if (!system || !cpu) return undefined;
  const target = system + '-' + cpu;
  const sha256 = SUMS[target];
  if (!sha256) return undefined;
  const file = 'cua-cli-' + CUA_VERSION + '-' + target + (platform === 'win32' ? '.zip' : '.tar.gz');
  // The archive holds `cua` and the helpers it finds beside itself (its microVM monitor, the
  // cua-spacesd it puts into images that have none), at its top.
  return {
    url: 'https://github.com/trycua/cua/releases/download/cua-sdk-v' + CUA_VERSION + '/' + file,
    sha256,
    exe: platform === 'win32' ? 'cua.exe' : 'cua',
    size: SIZES[target],
  };
}

/** Where Settings installs it. */
export const cuaFolder = () => join(cliFolder(), 'cua');

/** What `cua --version` said of each program, by path and modification time (asked once each). */
const versions = new Map<string, string | undefined>();

function versionOf(bin: string, probe: (bin: string) => string | undefined): string | undefined {
  let key = bin;
  try {
    key += ':' + statSync(bin).mtimeMs;
  } catch {
    // Asked by its path alone.
  }
  if (!versions.has(key)) versions.set(key, probe(bin));
  return versions.get(key);
}

function probeVersion(bin: string): string | undefined {
  const r = runSync(bin, ['--version'], { timeoutMs: 10_000, env: portableInstallEnv() });
  return r.status === 0 ? parseCuaVersion(r.stdout) : undefined;
}

export interface FoundCua {
  bin: string;
  version: string;
  /** Harness Relay installed it (Settings), rather than the user. */
  own: boolean;
}

/**
 * The `cua` the computer tools start: the one Settings installed, else the user's own (on the PATH, or
 * where Cua's installer puts it) when it is at least `CUA_MIN_VERSION`; undefined when there is neither.
 * An older one of the user's is `tooOld` (Settings offers its own instead).
 */
export function findCua(
  o: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    folder?: string;
    hasProgram?: (path: string) => boolean;
    probe?: (bin: string) => string | undefined;
  } = {},
): (FoundCua & { tooOld?: false }) | { tooOld: true; bin: string; version?: string } | undefined {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const hasProgram = o.hasProgram ?? isProgram;
  const probe = o.probe ?? probeVersion;
  const path = platform === 'win32' ? win32 : posix;
  const exe = platform === 'win32' ? 'cua.exe' : 'cua';
  const own = path.join(o.folder ?? cuaFolder(), exe);
  if (hasProgram(own)) {
    const version = versionOf(own, probe);
    if (version) return { bin: own, version, own: true };
  }
  // Cua's installer: ~/.local/bin on macOS and Linux, %LOCALAPPDATA%\Programs\cua\bin on Windows.
  const local = env.LOCALAPPDATA ?? env.LocalAppData;
  const extra = platform === 'win32' ? (local ? [win32.join(local, 'Programs', 'cua', 'bin')] : []) : [posix.join(home, '.local', 'bin')];
  const theirs = findOnPath('cua', { ...env, PATHEXT: '.EXE' }, platform, extra, hasProgram);
  if (!theirs || theirs === own) return undefined;
  const version = versionOf(theirs, probe);
  if (version && atLeast(version, CUA_MIN_VERSION)) return { bin: theirs, version, own: false };
  return { tooOld: true, bin: theirs, ...(version ? { version } : {}) };
}

/** The `cua` to start, when there is one new enough. */
export function usableCua(): FoundCua | undefined {
  const found = findCua();
  return found && !found.tooOld ? found : undefined;
}

export function cuaAvailable(): boolean {
  return Boolean(usableCua());
}

export function canInstallCua(platform = process.platform, arch: string = process.arch, tool = systemArchiveTool): boolean {
  return Boolean(cuaBuild(platform, arch) && tool('curl') && tool('tar'));
}

interface CuaInstallHost extends ArchiveHost {
  build?: PortableBuild;
  folder?: string;
  probe?: (exe: string) => Promise<boolean>;
}

/**
 * Removes `cua` as Settings' Remove Cua ends: Harness Relay's own copy (`clis/cua`), never the user's own,
 * whose path is given back to say it stays.
 */
export async function uninstallCua(folder = cuaFolder(), found = findCua): Promise<{ removed: true } | { kept: string } | undefined> {
  const exe = join(folder, process.platform === 'win32' ? 'cua.exe' : 'cua');
  let removed = false;
  if (existsSync(exe)) {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
    removed = true;
  }
  versions.clear();
  const theirs = found();
  if (theirs) return { kept: theirs.bin };
  return removed ? { removed: true } : undefined;
}

/** Installs `cua` into Harness Relay's folder (even beside the user's own: Settings asked for it). */
export async function installCua(
  job: InstallJob,
  { build = cuaBuild(), folder = cuaFolder(), probe, ...host }: CuaInstallHost = {},
): Promise<void> {
  const signal = job.abort.signal;
  signal.throwIfAborted();
  if (!build) throw new Error(t().appInstallManual);
  const env = portableInstallEnv();
  const version = async (exe: string) => {
    try {
      const result = await runProcess({ bin: exe, args: ['--version'], signal, env, timeoutMs: 30_000, maxCapture: 1024 });
      return result.code === 0 && parseCuaVersion(result.stdout) === CUA_VERSION;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  job.append('Cua ' + CUA_VERSION + '\n');
  await installPortableArchive(
    build,
    folder,
    signal,
    env,
    probe ?? version,
    (step) => new Error({ tools: t().appInstallManual, download: t().cuaArchiveDownload, run: t().cuaArchiveRun }[step]),
    { progress: (done, total) => job.progress(done, total), ...host },
  );
  versions.clear();
}
