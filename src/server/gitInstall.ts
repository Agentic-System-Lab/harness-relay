import { win32 } from 'node:path';
import type { GitInstallView, GitRequirement } from '../shared/types';
import { gitBash, InstallError, InstallJob, installerEnv, runStep } from './cliInstall';
import { HttpError } from './errors';
import { captureGit } from './gitProcess';
import { t } from './i18n';
import { runProcess, runShellScript } from './process';
import { linuxPackageCommand, type LinuxPackages } from './sandboxSetup';
import { findOnPath, isProgram } from './executable';

const APPLE = '/usr/bin/xcode-select';
const WINGET_ARGS = [
  'install',
  '--exact',
  '--id',
  'Git.Git',
  '--source',
  'winget',
  '--accept-source-agreements',
  '--accept-package-agreements',
  '--silent',
  '--disable-interactivity',
];

interface GitInstallHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasProgram: typeof isProgram;
  run: typeof runProcess;
  runScript: typeof runShellScript;
  hasGit: (requirement: GitRequirement) => Promise<boolean>;
}

interface InstallPlan {
  method?: GitInstallView['method'];
  command?: string;
  install?: (job: InstallJob) => Promise<unknown>;
}

/** One installation at a time on the server host, regardless of which browser requested it. */
export class GitInstall {
  private job?: InstallJob;
  private starting = false;
  private host: GitInstallHost;

  constructor(
    private linux: Pick<LinuxPackages, 'packageManager' | 'adminWay' | 'install'>,
    host: Partial<GitInstallHost> = {},
  ) {
    this.host = {
      platform: process.platform,
      env: process.env,
      hasProgram: isProgram,
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
      const alias = env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
      const winget = findOnPath('winget', env, platform, alias ? [alias] : [], hasProgram);
      const command = 'winget install --exact --id Git.Git --source winget';
      return winget
        ? {
            method: 'winget',
            install: (job) => runStep(this.host, job, command, { bin: winget, args: WINGET_ARGS, env: installerEnv(env) }),
          }
        : {};
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
    const available = await this.host.hasGit(requirement);
    const { method, command } = available ? {} : this.plan();
    return {
      available,
      ...(method ? { method } : {}),
      ...(command ? { command } : {}),
      ...(this.job ? { job: this.job.view() } : {}),
    };
  }

  running(): number {
    return this.starting || this.job?.state === 'running' ? 1 : 0;
  }

  async install(requirement: GitRequirement): Promise<GitInstallView> {
    if (this.running()) return this.view(requirement);
    this.starting = true;
    try {
      if (await this.host.hasGit(requirement)) return { available: true };
      const plan = this.plan();
      if (!plan.install) throw new HttpError(400, t().gitInstallUnavailable);
      const job = new InstallJob();
      this.job = job;
      job.ended = this.run(job, plan.method, plan.install, requirement);
      return { available: false, method: plan.method, job: job.view() };
    } finally {
      this.starting = false;
    }
  }

  /** A quit or shutdown stops the managed process as it does for other installers. */
  shutdown(): Promise<void> {
    if (this.job?.state !== 'running') return Promise.resolve();
    this.job.abort.abort();
    return this.job.ended;
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
