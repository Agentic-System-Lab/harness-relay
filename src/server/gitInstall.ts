import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import type { GitInstallView, GitRequirement } from '../shared/types';
import { gitBash, InstallError, InstallJob, installerEnv, runStep, windowsPowerShell, type CliInstaller } from './cliInstall';
import { HttpError } from './errors';
import { captureGit } from './gitProcess';
import { t } from './i18n';
import { runProcess, runShellScript } from './process';
import { linuxPackageCommand, type LinuxPackages } from './sandboxSetup';
import { findOnPath, isProgram } from './executable';

const APPLE = '/usr/bin/xcode-select';
const WINGET_PACKAGE = ['install', '--exact', '--id', 'Git.Git', '--source', 'winget'];
const WINGET_ARGS = [...WINGET_PACKAGE, '--accept-source-agreements', '--accept-package-agreements', '--silent', '--disable-interactivity'];
const WINGET_COMMAND = ['winget', ...WINGET_PACKAGE].join(' ');
/** PowerShell can start an App Execution Alias which Node cannot stat or launch directly. */
const WINGET_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '& $env:HARNESS_RELAY_WINGET ' + WINGET_ARGS.join(' '),
  'exit $LASTEXITCODE',
].join('\n');

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
      const winget = findOnPath('winget', env, platform, [], (path) => path.toLowerCase().endsWith('.exe') && hasProgram(path));
      const alias = env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe');
      const shell = !winget && alias && this.host.hasAlias(alias) ? windowsPowerShell(env, hasProgram) : undefined;
      if (winget || shell)
        return {
          method: 'winget',
          install: (job) => {
            const run = async () => {
              const base = installerEnv(env);
              if (winget) {
                await runStep(this.host, job, WINGET_COMMAND, { bin: winget, args: WINGET_ARGS, env: base });
              } else {
                await runStep(
                  this.host,
                  job,
                  WINGET_COMMAND,
                  {
                    bin: shell!,
                    args: ['-NoProfile', '-NonInteractive'],
                    env: { ...base, HARNESS_RELAY_WINGET: alias },
                  },
                  WINGET_SCRIPT,
                );
              }
            };
            return this.clis ? this.clis.withWindowsUserPath(job, run) : run();
          },
        };
      return {};
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
