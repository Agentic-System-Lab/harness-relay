import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliInstallHost, type InstallJob } from '../cliInstall';
import { isProgram } from '../executable';
import { wingetInstall } from '../gitInstall';
import { installMacApp, publishMacApp } from '../macAppInstall';
import { runProcess, runShellScript } from '../process';
import { linuxPackageCommand, type LinuxPackages } from '../sandboxSetup';

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

export function readOsRelease(): string {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // The second path is used on distributions without a local override.
    }
  }
  return '';
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
  if (host.platform === 'darwin')
    return {
      install: (job) =>
        installMacApp(host, job, {
          name: 'Google Chrome',
          apps: join(host.home, 'Applications'),
          url: CHROME_DMG,
          signature: GOOGLE_SIGNATURE,
        }),
    };
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
