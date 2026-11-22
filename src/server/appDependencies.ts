import type { AppDependency, AppDependencyView, PreviewDockerView } from '../shared/types';
import { browserInstallPlan } from './browser/install';
import { InstallError, InstallJob, type CliInstaller } from './cliInstall';
import { HttpError } from './errors';
import { canInstallGithubCli, githubCliAvailable, installGithubCli } from './githubInstall';
import { t } from './i18n';
import { hasDockerCli, probePreviewDocker, type DockerStatus } from './previewDocker';
import { previewDockerInstallPlan } from './previewDockerInstall';
import type { LinuxPackages } from './sandboxSetup';

type Install = (job: InstallJob) => Promise<unknown>;

interface Dependency {
  available(): boolean;
  plan(): { install?: Install; command?: string; detail?: string };
}

/** One job per prerequisite, shared by all signed-in browsers. Viewing a row never starts an install. */
export class AppDependencies {
  private jobs = new Map<AppDependency | 'docker', InstallJob>();
  private stopping = false;

  constructor(
    private deps: Record<AppDependency, Dependency>,
    private docker?: Dependency & { probe(): Promise<DockerStatus> },
  ) {}

  async dockerView(): Promise<PreviewDockerView> {
    if (!this.docker) throw new HttpError(503, t().appInstallManual);
    const running = () => this.jobs.get('docker')?.state === 'running';
    const status = running() ? { state: 'missing' as const } : await this.docker.probe();
    const plan = status.state === 'missing' && !running() ? this.docker.plan() : {};
    return {
      ...status,
      detail: plan.detail ?? status.detail,
      available: status.state === 'ready',
      canInstall: Boolean(plan.install),
      command: plan.command,
      job: this.jobs.get('docker')?.view(),
    };
  }

  async installDocker(): Promise<PreviewDockerView> {
    if (this.stopping) throw new HttpError(503, t().shuttingDown);
    const dep = this.docker;
    if (!dep) throw new HttpError(503, t().appInstallManual);
    // Installation covers a missing CLI. A stopped engine, an inaccessible socket or a remote
    // context calls for host setup instead. Reserve the job synchronously before any async work.
    if (this.jobs.get('docker')?.state !== 'running' && !dep.available()) {
      const plan = dep.plan();
      if (!plan.install) throw new HttpError(400, plan.detail ?? t().appInstallManual);
      this.start('docker', dep, plan.install);
    }
    return this.dockerView();
  }

  view(name: AppDependency): AppDependencyView {
    const job = this.jobs.get(name);
    const running = job?.state === 'running';
    const available = !running && this.deps[name].available();
    const plan = running || available ? {} : this.deps[name].plan();
    return { available, canInstall: Boolean(plan.install), command: plan.command, job: job?.view() };
  }

  install(name: AppDependency): AppDependencyView {
    if (this.stopping) throw new HttpError(503, t().shuttingDown);
    const dep = this.deps[name];
    if (this.jobs.get(name)?.state === 'running' || dep.available()) return this.view(name);
    const { install } = dep.plan();
    if (!install) throw new HttpError(400, t().appInstallManual);
    this.start(name, dep, install);
    return this.view(name);
  }

  private start(name: AppDependency | 'docker', dep: Dependency, install: Install) {
    const job = new InstallJob();
    this.jobs.set(name, job);
    job.ended = this.run(job, dep, install);
  }

  private async run(job: InstallJob, dep: Dependency, install: Install) {
    try {
      await install(job);
      job.abort.signal.throwIfAborted();
      if (!dep.available()) throw new InstallError(() => t().appInstallMissing);
      job.finish('success');
    } catch (err) {
      if (job.abort.signal.aborted) job.finish('cancelled', () => t().cliInstallCancelled);
      else job.finish('failed', err instanceof InstallError ? err.render : () => (err as Error).message);
    }
  }

  running() {
    return [...this.jobs.values()].filter((job) => job.state === 'running').length;
  }

  async shutdown() {
    this.stopping = true;
    for (const job of this.jobs.values()) if (job.state === 'running') job.abort.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.ended));
  }
}

export function commonAppDependencies(
  linux: LinuxPackages,
  browserAvailable: () => boolean,
  clis: Pick<CliInstaller, 'withWindowsUserPath'>,
) {
  return new AppDependencies(
    {
      github: { available: githubCliAvailable, plan: () => (canInstallGithubCli() ? { install: installGithubCli } : {}) },
      browser: { available: browserAvailable, plan: () => browserInstallPlan(linux) },
    },
    { available: hasDockerCli, probe: probePreviewDocker, plan: () => previewDockerInstallPlan(linux, {}, clis) },
  );
}
