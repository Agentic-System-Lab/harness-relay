import { accessSync, constants, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { readOsRelease } from './browser/install';
import { runStep, type CliInstaller, type CliInstallHost, type InstallJob } from './cliInstall';
import { isProgram } from './executable';
import { wingetInstall } from './gitInstall';
import { t } from './i18n';
import { installMacApp, publishMacApp } from './macAppInstall';
import { portableInstallEnv } from './portableInstall';
import { runProcess, runShellScript, runSync } from './process';
import { windowsDockerFolders } from './previewDocker';
import { linuxPackageCommand, type LinuxPackages } from './sandboxSetup';

const DOCKER_SIGNATURE =
  '=anchor apple generic and identifier "com.docker.docker" and certificate leaf[subject.OU] = "9BNSXJN65R"' +
  ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

interface InstallHost extends Pick<CliInstallHost, 'platform' | 'arch' | 'env' | 'run' | 'runScript'> {
  hasProgram: typeof isProgram;
  hasAlias?: (p: string) => boolean;
  apps: string;
  canWrite: (dir: string) => boolean;
  temp: string;
  publish: typeof publishMacApp;
  osRelease: () => string;
}

// Hold the file against writes and renames from signature verification until Start-Process opens
// it. Start the GUI as the Relay user so Docker can present its own first-run agreement.
const OPEN_WINDOWS_DESKTOP = `$ErrorActionPreference = 'Stop'
$exe = $env:RELAY_DOCKER_DESKTOP
$lock = [IO.File]::Open($exe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $signature = Get-AuthenticodeSignature -LiteralPath $exe
  if ($signature.Status -ne 'Valid') { throw 'Invalid Docker Desktop signature' }
  $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -notin @('Docker Inc', 'Docker Inc.', 'Docker, Inc.', 'Docker, Inc')) { throw 'Unexpected Docker Desktop publisher' }
  Start-Process -FilePath $exe -WorkingDirectory ([IO.Path]::GetDirectoryName($exe))
} finally { $lock.Dispose() }`;

async function openWindowsDocker(host: InstallHost, job: InstallJob) {
  const env = Object.fromEntries(Object.entries(host.env).map(([k, v]) => [k.toUpperCase(), v]));
  const exe = windowsDockerFolders(env)
    .map((dir) => win32.join(dir, 'Docker Desktop.exe'))
    .find(host.hasProgram);
  const root = env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  const system32 = win32.join(root, 'System32');
  const shell = win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!exe || !/^[a-z]:\\/i.test(shell) || !host.hasProgram(shell)) {
    job.append(t().previewDocker.openDesktop + '\n');
    return;
  }
  await runStep(
    host,
    job,
    'Open Docker Desktop',
    {
      bin: shell,
      args: ['-NoProfile', '-NonInteractive'],
      cwd: system32,
      env: { ...portableInstallEnv(env), SYSTEMROOT: root, WINDIR: root, PATH: system32, RELAY_DOCKER_DESKTOP: exe },
    },
    OPEN_WINDOWS_DESKTOP,
  );
}

/** Installation has already succeeded. A desktop prompt may need a person at the host to open it. */
async function firstLaunch(job: InstallJob, launch: () => Promise<unknown>) {
  try {
    await launch();
  } catch (err) {
    job.abort.signal.throwIfAborted();
    job.append(t().previewDocker.launchFailed + '\n' + (err as Error).message + '\n');
  }
}

function hostArch() {
  // A server running under Rosetta reports x64. Docker Desktop must match the Mac's hardware.
  if (process.platform === 'darwin' && process.arch === 'x64') {
    if (runSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { timeoutMs: 1000 }).stdout?.trim() === '1') return 'arm64';
  }
  return process.arch;
}

export function previewDockerInstallPlan(
  linux: Pick<LinuxPackages, 'packageManager' | 'adminWay' | 'install'>,
  overrides: Partial<InstallHost> = {},
  clis?: Pick<CliInstaller, 'withWindowsUserPath'>,
): { install?: (job: InstallJob) => Promise<unknown>; command?: string; detail?: string } {
  const host: InstallHost = {
    platform: process.platform,
    arch: overrides.arch ?? hostArch(),
    env: process.env,
    hasProgram: isProgram,
    run: runProcess,
    runScript: runShellScript,
    apps: '/Applications',
    canWrite: (dir) => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    temp: tmpdir(),
    publish: publishMacApp,
    osRelease: readOsRelease,
    ...overrides,
  };
  const manual = t().previewDocker.manual;
  if (!['arm64', 'x64'].includes(host.arch)) return { detail: t().previewDocker.arch };
  if (host.platform === 'darwin') {
    const dest = join(host.apps, 'Docker.app');
    if (lstatSync(dest, { throwIfNoEntry: false })) return { detail: t().previewDocker.existing(dest) };
    const arch = host.arch === 'arm64' ? 'arm64' : 'amd64';
    return {
      install: async (job) => {
        await installMacApp(host, job, {
          name: 'Docker',
          apps: host.apps,
          url: `https://desktop.docker.com/mac/main/${arch}/Docker.dmg`,
          signature: DOCKER_SIGNATURE,
          finder: !host.canWrite(host.apps),
        });
        await firstLaunch(job, () =>
          runStep(host, job, 'Open Docker Desktop', { bin: '/usr/bin/open', args: [dest], env: portableInstallEnv(host.env) }),
        );
      },
    };
  }
  if (host.platform === 'win32') {
    const install = wingetInstall('Docker.DockerDesktop', host);
    if (!install) return { detail: t().previewDocker.noWinget };
    return {
      install: async (job) => {
        await (clis ? clis.withWindowsUserPath(job, () => install(job)) : install(job));
        job.abort.signal.throwIfAborted();
        await firstLaunch(job, () => openWindowsDocker(host, job));
      },
    };
  }
  if (host.platform !== 'linux') return { detail: manual };
  const pm = linux.packageManager();
  const os = host.osRelease();
  const id = /^ID=["']?([^"'\s]+)/m.exec(os)?.[1];
  const version = Number(/^VERSION_ID=["']?(\d+)/m.exec(os)?.[1]);
  let packages: string[];
  if (pm === 'apt' && (id === 'ubuntu' || id === 'debian')) {
    // Debian 13 split out the recommended CLI, and our package helper skips recommends.
    packages = id === 'debian' && version >= 13 ? ['docker.io', 'docker-cli'] : ['docker.io'];
  } else if (pm === 'dnf' && id === 'fedora') {
    packages = ['moby-engine', 'docker-cli'];
  } else if ((pm === 'pacman' && id === 'arch') || (pm === 'zypper' && id?.startsWith('opensuse'))) {
    packages = ['docker'];
  } else {
    return { detail: manual };
  }
  return linux.adminWay() ? { install: (job) => linux.install(job, packages) } : { command: linuxPackageCommand(pm, packages) };
}
