import type { AppDependency, AppDependencyView } from '../shared/types';
import { browserInstallPlan } from './browser/install';
import { InstallError, InstallJob } from './cliInstall';
import { HttpError } from './errors';
import { canInstallGithubCli, githubCliAvailable, installGithubCli } from './githubInstall';
import { t } from './i18n';
import type { LinuxPackages } from './sandboxSetup';

interface Dependency {
  available(): boolean;
  plan(): { install?: (job: InstallJob) => Promise<unknown>; command?: string };
}

/** One job per prerequisite, shared by all signed-in browsers. Viewing a row never starts an install. */
export class AppDependencies {
  private jobs = new Map<AppDependency, InstallJob>();
  private stopping = false;

  constructor(private deps: Record<AppDependency, Dependency>) {}

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
    const job = new InstallJob();
    this.jobs.set(name, job);
    job.ended = this.run(job, dep, install);
    return this.view(name);
  }

  private async run(job: InstallJob, dep: Dependency, install: (job: InstallJob) => Promise<unknown>) {
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

export function commonAppDependencies(linux: LinuxPackages, browserAvailable: () => boolean) {
  return new AppDependencies({
    github: { available: githubCliAvailable, plan: () => (canInstallGithubCli() ? { install: installGithubCli } : {}) },
    browser: { available: browserAvailable, plan: () => browserInstallPlan(linux) },
  });
}
