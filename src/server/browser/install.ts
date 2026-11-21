import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStep, type CliInstallHost, type InstallJob } from '../cliInstall';
import { isProgram } from '../executable';
import { wingetInstall } from '../gitInstall';
import { portableInstallEnv } from '../portableInstall';
import { runProcess, runShellScript } from '../process';
import { linuxPackageCommand, type LinuxPackages } from '../sandboxSetup';

const CHROME_APP = 'Google Chrome.app';
const CHROME_DMG = 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg';
const GOOGLE_SIGNATURE =
  '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"' +
  ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

interface BrowserInstallHost extends Pick<CliInstallHost, 'platform' | 'env' | 'home' | 'run' | 'runScript'> {
  temp: string;
  hasProgram: typeof isProgram;
  hasAlias?: (file: string) => boolean;
  osRelease: () => string;
  publish: typeof publishMacApp;
}

// Node's rename() replaces an existing empty directory. Darwin's exclusive rename atomically
// publishes the whole bundle or leaves whoever owns the destination alone, even in that race.
function publishMacApp(source: string, destination: string, env: NodeJS.ProcessEnv): void {
  const script = [
    "ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);",
    'function run(paths) {',
    '  if ($.renamex_np(paths[0], paths[1], 4) !== 0) throw Error("Cannot install Google Chrome at " + paths[1]);',
    '}',
  ].join('\n');
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, source, destination], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Cannot install Google Chrome.');
}

function readOsRelease(): string {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // The second path is used on distributions without a local override.
    }
  }
  return '';
}

async function installMacChrome(host: BrowserInstallHost, job: InstallJob): Promise<void> {
  const env = portableInstallEnv(host.env);
  const apps = join(host.home, 'Applications');
  const dest = join(apps, CHROME_APP);
  job.abort.signal.throwIfAborted();
  if (lstatSync(dest, { throwIfNoEntry: false })) throw new Error('An application already exists at ' + dest);

  mkdirSync(apps, { recursive: true });
  const stage = mkdtempSync(join(apps, '.relay-chrome-'));
  const stagedApp = join(stage, CHROME_APP);
  try {
    const scratch = mkdtempSync(join(host.temp, 'relay-chrome-'));
    const image = join(scratch, 'googlechrome.dmg');
    const volume = join(scratch, 'volume');
    let attemptedMount = false;
    try {
      await runStep(host, job, 'Download Google Chrome', {
        bin: '/usr/bin/curl',
        args: [
          '-q',
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--output',
          image,
          CHROME_DMG,
        ],
        env,
      });
      mkdirSync(volume);
      attemptedMount = true;
      await runStep(host, job, 'hdiutil attach', {
        bin: '/usr/bin/hdiutil',
        args: ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', volume, image],
        env,
      });
      const source = join(volume, CHROME_APP);
      if (!lstatSync(source).isDirectory()) throw new Error('Missing Google Chrome application in the disk image.');
      // The vendor HFS image carries FinderInfo on its helpers. Omit resource forks and Finder
      // metadata so strict seal verification can run; preserve quarantine on the staged bundle.
      await runStep(host, job, 'Copy Google Chrome', {
        bin: '/usr/bin/ditto',
        args: ['--norsrc', '--qtn', '--acl', source, stagedApp],
        env,
      });
      await runStep(host, job, 'Verify the Google Chrome signature', {
        bin: '/usr/bin/codesign',
        args: ['--verify', '--deep', '--strict', '--all-architectures', '-R', GOOGLE_SIGNATURE, stagedApp],
        env,
      });
    } finally {
      if (attemptedMount) {
        // hdiutil may have mounted the image before it reported a failure or was cancelled.
        // Cleanup uses its own timeout and never inherits the cancelled job's signal.
        for (const args of [
          ['detach', volume],
          ['detach', '-force', volume],
        ]) {
          const detached = await host.run({ bin: '/usr/bin/hdiutil', args, env, timeoutMs: 15000 }).catch(() => undefined);
          if (detached?.code === 0) break;
        }
      }
      // A still-mounted volume cannot be removed by rmdir. Leave it and its backing image for
      // ejection in that case; nothing ever recursively removes the mount point or its parent.
      if (lstatSync(volume, { throwIfNoEntry: false })) rmdirSync(volume);
      await rm(image, { force: true });
      rmdirSync(scratch);
    }
    job.abort.signal.throwIfAborted();
    host.publish(stagedApp, dest, env);
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function browserInstallPlan(
  linux: Pick<LinuxPackages, 'packageManager' | 'adminWay' | 'install'>,
  overrides: Partial<BrowserInstallHost> = {},
): { install?: (job: InstallJob) => Promise<unknown>; command?: string } {
  const host: BrowserInstallHost = {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    temp: tmpdir(),
    run: runProcess,
    runScript: runShellScript,
    hasProgram: isProgram,
    osRelease: readOsRelease,
    publish: publishMacApp,
    ...overrides,
  };
  if (host.platform === 'darwin') return { install: (job) => installMacChrome(host, job) };
  if (host.platform === 'win32') {
    const install = wingetInstall('Google.Chrome', host);
    return install ? { install } : {};
  }
  if (host.platform !== 'linux') return {};
  const pm = linux.packageManager();
  if (!pm) return {};
  const ubuntu = pm === 'apt' && /^ID=(?:ubuntu|"ubuntu"|'ubuntu')\s*$/m.test(host.osRelease());
  const packages = [ubuntu ? 'chromium-browser' : 'chromium'];
  return linux.adminWay() ? { install: (job) => linux.install(job, packages) } : { command: linuxPackageCommand(pm, packages) };
}
