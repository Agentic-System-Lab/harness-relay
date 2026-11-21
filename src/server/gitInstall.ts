import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import type { GitInstallView, GitRequirement } from '../shared/types';
import { gitBash, InstallError, InstallJob, installerEnv, runStep, type CliInstaller } from './cliInstall';
import { HttpError } from './errors';
import { captureGit } from './gitProcess';
import { t } from './i18n';
import { runProcess, runShellScript } from './process';
import { linuxPackageCommand, type LinuxPackages } from './sandboxSetup';
import { isProgram } from './executable';
import { portableInstallEnv } from './portableInstall';

const APPLE = '/usr/bin/xcode-select';
function aliasExists(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface GitInstallHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasProgram: typeof isProgram;
  hasAlias: typeof aliasExists;
  run: typeof runProcess;
  runScript: typeof runShellScript;
  hasGit: (requirement: GitRequirement) => Promise<boolean>;
}

/** PowerShell can start a WinGet App Execution Alias which Node cannot stat or launch directly. */
export function wingetInstall(
  id: 'Git.Git' | 'Google.Chrome',
  host: Pick<GitInstallHost, 'env' | 'hasProgram' | 'run' | 'runScript'> & { hasAlias?: typeof aliasExists },
): ((job: InstallJob) => Promise<void>) | undefined {
  const env = Object.fromEntries(Object.entries(host.env).map(([key, value]) => [key.toUpperCase(), value]));
  const absolute = (dir?: string) => (dir && /^[a-z]:[\\/]/i.test(dir) ? win32.normalize(dir) : undefined);
  const root = absolute(env.SYSTEMROOT) ?? absolute(env.WINDIR) ?? 'C:\\Windows';
  const system32 = win32.join(root, 'System32');
  const profile = absolute(env.USERPROFILE);
  const local = absolute(env.LOCALAPPDATA) ?? (profile && win32.join(profile, 'AppData', 'Local'));
  const aliases = local
    ? [
        win32.join(local, 'Microsoft', 'WindowsApps', 'winget.exe'),
        win32.join(local, 'Microsoft', 'WindowsApps', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'winget.exe'),
      ]
    : [];
  // A server started by npm inherits the project's bin directories. Only accept a PATH entry
  // for App Installer itself, under the system's protected AppX package directory.
  const programFiles = absolute(env.PROGRAMW6432) ?? absolute(env.PROGRAMFILES) ?? win32.join(win32.parse(root).root, 'Program Files');
  const appx = win32.join(programFiles, 'WindowsApps').toLowerCase();
  const packaged = (env.PATH ?? '')
    .split(';')
    .filter(
      (dir) =>
        win32.dirname(dir).toLowerCase() === appx &&
        /^Microsoft\.DesktopAppInstaller_(?:\d+\.){3}\d+_(?:x64|x86|arm64|arm|neutral)__8wekyb3d8bbwe$/i.test(win32.basename(dir)),
    )
    .map((dir) => win32.join(dir, 'winget.exe'));
  const winget = [...aliases, ...packaged].find(host.hasProgram);
  const alias = winget ? undefined : aliases.find(host.hasAlias ?? aliasExists);
  const shell = win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!winget && (!alias || !host.hasProgram(shell))) return undefined;
  const pkg = ['install', '--exact', '--id', id, '--source', 'winget'];
  const args = [...pkg, '--accept-source-agreements', '--accept-package-agreements', '--silent', '--disable-interactivity'];
  const shown = ['winget', ...pkg].join(' ');
  return async (job) => {
    const base = {
      ...portableInstallEnv(env),
      SYSTEMROOT: root,
      WINDIR: root,
      COMSPEC: win32.join(system32, 'cmd.exe'),
      PATH: [system32, root].join(';'),
    };
    if (winget) await runStep(host, job, shown, { bin: winget, args, env: base, cwd: system32 });
    else {
      const script = ["$ErrorActionPreference = 'Stop'", '& $env:HARNESS_RELAY_WINGET ' + args.join(' '), 'exit $LASTEXITCODE'].join('\n');
      await runStep(
        host,
        job,
        shown,
        { bin: shell, args: ['-NoProfile', '-NonInteractive'], env: { ...base, HARNESS_RELAY_WINGET: alias }, cwd: system32 },
        script,
      );
    }
  };
}

interface InstallPlan {
  method?: GitInstallView['method'];
  command?: string;
  install?: (job: InstallJob) => Promise<unknown>;
}

/** One installation at a time on the server host, regardless of which browser requested it. */
export class GitInstall {
  private job?: InstallJob;
  private method?: GitInstallView['method'];
  private starting?: Promise<GitInstallView>;
  private stopping = false;
  private host: GitInstallHost;

  constructor(
    private linux: Pick<LinuxPackages, 'packageManager' | 'adminWay' | 'install'>,
    host: Partial<GitInstallHost> = {},
    private clis?: Pick<CliInstaller, 'withWindowsUserPath'>,
  ) {
    this.host = {
      platform: process.platform,
      env: process.env,
      hasProgram: isProgram,
      hasAlias: aliasExists,
      run: runProcess,
      runScript: runShellScript,
      hasGit: async (requirement) => {
        const result = await captureGit(['--version'], this.host.env, { timeoutMs: 4000 }).catch(() => null);
        return result?.code === 0 && (requirement === 'git' || Boolean(gitBash(this.host.env, this.host.hasProgram)));
      },
      ...host,
    };
  }

  private plan(): InstallPlan {
    const { platform, env, hasProgram } = this.host;
    if (platform === 'darwin' && hasProgram(APPLE)) {
      return {
        method: 'apple',
        install: (job) => runStep(this.host, job, 'xcode-select --install', { bin: APPLE, args: ['--install'], env: installerEnv(env) }),
      };
    }
    if (platform === 'win32') {
      const install = wingetInstall('Git.Git', this.host);
      if (!install) return {};
      const clis = this.clis;
      return { method: 'winget', install: clis ? (job) => clis.withWindowsUserPath(job, () => install(job)) : install };
    }
    if (platform === 'linux') {
      const pm = this.linux.packageManager();
      if (!pm) return {};
      return this.linux.adminWay()
        ? { method: 'linux', install: (job) => this.linux.install(job, ['git']) }
        : { command: linuxPackageCommand(pm, ['git']) };
    }
    return {};
  }

  async view(requirement: GitRequirement): Promise<GitInstallView> {
    const running = this.runningView();
    if (running) return running;
    const available = await this.host.hasGit(requirement);
    const { method, command } = available ? {} : this.plan();
    const meanwhile = this.runningView();
    if (meanwhile) return meanwhile;
    return {
      available,
      ...(method ? { method } : {}),
      ...(command ? { command } : {}),
      ...(this.job ? { job: this.job.view() } : {}),
    };
  }

  private runningView(): GitInstallView | undefined {
    if (this.job?.state !== 'running') return undefined;
    return { available: false, method: this.method, job: this.job.view() };
  }

  running(): number {
    return this.starting || this.job?.state === 'running' ? 1 : 0;
  }

  async install(requirement: GitRequirement): Promise<GitInstallView> {
    if (this.stopping) throw new HttpError(503, t().shuttingDown);
    if (this.starting) {
      await this.starting;
      return this.view(requirement);
    }
    const running = this.runningView();
    if (running) return running;
    this.starting = this.begin(requirement);
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async begin(requirement: GitRequirement): Promise<GitInstallView> {
    if (await this.host.hasGit(requirement)) return { available: true };
    if (this.stopping) throw new HttpError(503, t().shuttingDown);
    const plan = this.plan();
    if (!plan.install) throw new HttpError(400, t().gitInstallUnavailable);
    const job = new InstallJob();
    this.job = job;
    this.method = plan.method;
    job.ended = this.run(job, plan.method, plan.install, requirement);
    return { available: false, method: plan.method, job: job.view() };
  }

  /** A quit or shutdown stops the managed process as it does for other installers. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const job = this.job;
    if (job?.state === 'running') job.abort.abort();
    await Promise.allSettled([this.starting, job?.ended]);
  }

  private async run(
    job: InstallJob,
    method: InstallPlan['method'],
    install: NonNullable<InstallPlan['install']>,
    requirement: GitRequirement,
  ) {
    try {
      await install(job);
      // On macOS xcode-select only hands the installation off to Apple's own dialog.
      if (method !== 'apple' && !(await this.host.hasGit(requirement))) throw new InstallError(() => t().gitInstallStillMissing);
      job.finish('success');
    } catch (err) {
      if (job.abort.signal.aborted) job.finish('cancelled', () => t().cliInstallCancelled);
      else job.finish('failed', err instanceof InstallError ? err.render : () => (err as Error).message);
    }
  }
}
