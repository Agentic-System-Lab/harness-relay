import { randomUUID } from 'node:crypto';
import {
  GH_MISSING,
  GH_SIGNED_OUT,
  PUBLISH_SETUP,
  RENDER_REGIONS,
  type PublishedApp,
  type PublishPlan,
  type PublishRequest,
  type PublishSettingsView,
  type PublishStep,
  type RenderRegion,
} from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { runProcess } from '../process';
import { localDocker, type Docker } from '../previewDocker';
import { createRepo, githubLogin, pushSnapshot, type Run } from './git';
import { runInitScripts } from './initdb';
import { NEON_REGION, NeonApi, type NeonDatabase } from './neon';
import {
  APP_NAME,
  databaseEnv,
  optionalDatabase,
  publishSpec,
  suggestName,
  userEnv,
  type DatabaseSpec,
  type PublishSource,
  type PublishSpec,
} from './plan';
import { DEPLOY_DONE, DEPLOY_FAILED, httpsUrl, RenderApi } from './render';
import type { AppRecord, PublishStore } from './store';

/** A running preview, as publishing takes it: the files it was tried with, and where they are. */
export interface PreviewForPublish extends PublishSource {
  conversationId: string;
  /** The folder previewed (absolute). */
  folder: string;
  executables: ReadonlySet<string>;
}

export interface PublisherDeps {
  fetcher?: typeof fetch;
  /** Spawns gh and git (fakes in tests). */
  run?: Run;
  docker?: (signal?: AbortSignal) => Promise<Docker>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where the temporary repositories go. */
  tmpRoot?: string;
  /** The stand-in repositories' folder (tests); undefined = GitHub. */
  gitDir?: string;
  renderBase?: string;
  neonBase?: string;
  /** Docker's owner label for the init scripts' containers. */
  owner: string;
}

/** Stands for a database not made yet, to find which of the app's variables Neon's values replace. */
const PLACEHOLDER: NeonDatabase = {
  projectId: '',
  uri: 'postgresql://neon',
  host: 'neon',
  role: 'neon',
  password: 'neon',
  database: 'neon',
};

/** How long Render may take to build and start an app before Relay stops waiting. */
const DEPLOY_TIMEOUT = 30 * 60_000;
const POLL = 5000;
/** Publishes at once, across all apps. */
const MAX_JOBS = 2;

const STEPS: PublishStep['id'][] = ['repo', 'push', 'database', 'init', 'service', 'build'];

interface Job {
  steps: PublishStep[];
  controller: AbortController;
  done: Promise<void>;
  /** Still under way. A job that ended keeps its steps a while, for a panel that reads them once more. */
  active: boolean;
}

/**
 * Publishing previews to the user's own Render and Neon accounts, through a private GitHub repository
 * of theirs: the settings (`PublishStore`), each publish as a job of steps the panel follows, and
 * unpublishing. Only the user's requests reach it (`app.ts`), never an agent's.
 */
export class AppPublisher {
  private jobs = new Map<string, Job>();
  private closed = false;

  constructor(
    private store: PublishStore,
    private deps: PublisherDeps,
  ) {}

  private render(key = this.store.renderKey()) {
    if (!key) throw new HttpError(400, t().publish.setupRender, PUBLISH_SETUP);
    return new RenderApi(key, this.deps.fetcher, this.deps.renderBase);
  }
  private neon(key = this.store.neonKey()) {
    if (!key) throw new HttpError(400, t().publish.setupNeon, PUBLISH_SETUP);
    return new NeonApi(key, this.deps.fetcher, this.deps.neonBase, this.deps.sleep);
  }
  private run(): Run {
    return this.deps.run ?? runProcess;
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private sleep(ms: number, signal: AbortSignal) {
    return (this.deps.sleep ?? ((n) => new Promise<void>((resolve) => setTimeout(resolve, n))))(ms).then(() => signal.throwIfAborted());
  }

  // --- Settings ---------------------------------------------------------------------------------

  view(conversationGone: (id: string) => boolean = () => false): PublishSettingsView {
    return {
      storage: this.store.storage,
      render: {
        keyMasked: this.store.renderKeyMasked(),
        owners: this.store.render.owners,
        ...(this.store.render.ownerId ? { ownerId: this.store.render.ownerId } : {}),
        region: this.store.render.region,
      },
      neon: {
        keyMasked: this.store.neonKeyMasked(),
        orgs: this.store.neon.orgs,
        ...(this.store.neon.orgId ? { orgId: this.store.neon.orgId } : {}),
      },
      apps: this.store.apps().map((a) => this.appView(a, conversationGone)),
    };
  }

  /** Checks a Render key (`GET /owners`) before keeping it. */
  async setRenderKey(key: unknown) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(key.trim())) throw new HttpError(400, t().publish.renderKey);
    if (!this.store.storage) throw new HttpError(503, t().publish.storage);
    const owners = await this.render(key.trim()).owners();
    if (!owners.length) throw new HttpError(400, t().publish.renderNoOwner);
    this.store.setRender(key.trim(), owners);
  }

  updateRender(body: { ownerId?: unknown; region?: unknown }) {
    if (body.ownerId !== undefined && typeof body.ownerId !== 'string') throw new HttpError(400, t().invalidField('ownerId'));
    if (body.region !== undefined && !RENDER_REGIONS.includes(body.region as RenderRegion))
      throw new HttpError(400, t().invalidField('region'));
    this.store.updateRender({ ownerId: body.ownerId as string | undefined, region: body.region as RenderRegion | undefined });
  }

  removeRender() {
    this.store.removeRender();
  }

  /** Checks a Neon key (`GET /users/me/organizations`) before keeping it. */
  async setNeonKey(key: unknown) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(key.trim())) throw new HttpError(400, t().publish.neonKey);
    if (!this.store.storage) throw new HttpError(503, t().publish.storage);
    const orgs = await this.neon(key.trim()).orgs();
    this.store.setNeon(key.trim(), orgs);
  }

  updateNeon(body: { orgId?: unknown }) {
    if (body.orgId !== undefined && typeof body.orgId !== 'string') throw new HttpError(400, t().invalidField('orgId'));
    this.store.updateNeon({ orgId: body.orgId as string | undefined });
  }

  removeNeon() {
    this.store.removeNeon();
  }

  // --- Apps ---------------------------------------------------------------------------------------

  private appView(a: AppRecord, conversationGone: (id: string) => boolean = () => false): PublishedApp {
    const job = this.jobs.get(a.id);
    const repo = a.repo ?? a.name;
    return {
      id: a.id,
      name: a.name,
      conversationId: a.conversationId,
      ...(conversationGone(a.conversationId) ? { conversationGone: true } : {}),
      folder: a.folder,
      kind: a.kind,
      serviceType: a.serviceType,
      repo,
      repoUrl: a.repo ? `https://github.com/${a.repo}` : '',
      ...(a.serviceId ? { serviceId: a.serviceId } : {}),
      ...(a.dashboardUrl ? { dashboardUrl: a.dashboardUrl } : {}),
      ...(a.url ? { url: a.url } : {}),
      databases: a.databases.map((d) => ({ service: d.service, projectId: d.projectId, name: d.name })),
      createdAt: a.createdAt,
      ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}),
      state: a.state,
      ...(a.interrupted ? { error: t().publish.interrupted } : a.error ? { error: a.error } : {}),
      ...(job ? { steps: job.steps.map((s) => ({ ...s })) } : {}),
    };
  }

  app(id: string, conversationGone?: (id: string) => boolean): PublishedApp {
    const a = this.store.app(id);
    if (!a) throw new HttpError(404, t().publish.notFound);
    return this.appView(a, conversationGone);
  }

  private existing(folder: string) {
    return this.store.apps().find((a) => a.folder === folder);
  }

  private missing(spec: PublishSpec): PublishPlan['missing'] {
    const out: PublishPlan['missing'] = [];
    if (!this.store.renderKey()) out.push('render');
    else if (!this.store.render.ownerId) out.push('render-owner');
    if (spec.databases.length) {
      if (!this.store.neonKey()) out.push('neon');
      else if (!this.neonOrg()) out.push('neon-org');
    }
    return out;
  }

  /** The organization a project goes to: the chosen one; none when the key reaches none (an older personal account). */
  private neonOrg(): string | undefined | null {
    if (this.store.neon.orgId) return this.store.neon.orgId;
    return this.store.neon.orgs.length ? null : undefined;
  }

  /** What publishing this preview would do, for the dialog. */
  async plan(source: PreviewForPublish): Promise<PublishPlan> {
    const spec = publishSpec(source);
    const existing = this.existing(source.folder);
    let github: PublishPlan['github'];
    try {
      github = { login: await githubLogin(this.run()) };
    } catch (err) {
      const code = err instanceof HttpError ? err.code : undefined;
      if (code !== GH_MISSING && code !== GH_SIGNED_OUT) throw err;
      github = { problem: code };
    }
    return {
      kind: spec.kind,
      serviceType: spec.serviceType,
      name: existing?.name ?? suggestName(source.folder),
      folder: source.folder,
      ...(existing ? { existing: this.appView(existing) } : {}),
      // The variables as the app will get them, Neon's shown by name only (they are made when it publishes).
      env: databaseEnv(
        spec.env,
        spec.databases.map((db) => ({ spec: db, neon: PLACEHOLDER })),
        [],
      ).map((e) => (e.source === 'database' ? { ...e, value: '' } : e)),
      databases: spec.databases.map(({ service, database, role, pgVersion, initScripts, skippedScripts }) => ({
        service,
        database,
        role,
        ...(pgVersion ? { pgVersion } : {}),
        initScripts,
        skippedScripts,
      })),
      databaseOptional: spec.databaseOptional,
      commands: spec.commands,
      missing: this.missing(spec),
      neonReady: Boolean(this.store.neonKey()) && this.neonOrg() !== null,
      github,
      region: this.store.render.region,
    };
  }

  /** Starts publishing the preview: answers at once with the app, whose steps the panel then follows. */
  async publish(source: PreviewForPublish, request: Partial<PublishRequest>): Promise<PublishedApp> {
    if (this.closed) throw new HttpError(503, t().publish.interrupted);
    if (request.public !== true) throw new HttpError(400, t().publish.confirmPublic);
    const spec = publishSpec(source);
    const env = userEnv(request.env);
    if (request.database !== undefined && typeof request.database !== 'boolean') throw new HttpError(400, t().invalidField('database'));
    const databases: DatabaseSpec[] = [...spec.databases];
    if (request.database && spec.databaseOptional && !databases.length) databases.push(optionalDatabase());
    const missing = this.missing({ ...spec, databases });
    if (missing.length)
      throw new HttpError(400, missing[0]!.startsWith('neon') ? t().publish.setupNeon : t().publish.setupRender, PUBLISH_SETUP);
    let app = this.existing(source.folder);
    if (app && this.running(app.id)) throw new HttpError(409, t().publish.busy);
    if ([...this.jobs.values()].filter((j) => j.active).length >= MAX_JOBS) throw new HttpError(429, t().publish.tooMany);
    if (!app) {
      const name = request.name ?? suggestName(source.folder);
      if (typeof name !== 'string' || !APP_NAME.test(name)) throw new HttpError(400, t().publish.name);
      if (this.store.apps().some((a) => a.name === name)) throw new HttpError(409, t().publish.nameTaken(name));
      app = {
        id: randomUUID(),
        name,
        conversationId: source.conversationId,
        folder: source.folder,
        kind: spec.kind,
        serviceType: spec.serviceType,
        ownerId: this.store.render.ownerId!,
        databases: [],
        createdAt: this.now(),
        state: 'publishing',
        ...(spec.path ? { path: spec.path } : {}),
      };
    } else if (app.kind !== spec.kind || app.serviceType !== spec.serviceType) {
      // Render cannot turn a static site into a web service: the app is published anew.
      throw new HttpError(409, t().publish.kindChanged);
    } else {
      app.state = 'publishing';
      delete app.error;
      delete app.interrupted;
    }
    app.conversationId = source.conversationId;
    this.store.put(app);
    const steps: PublishStep[] = STEPS.map((id) => ({ id, state: 'pending' }));
    const job: Job = { steps, controller: new AbortController(), done: Promise.resolve(), active: true };
    this.jobs.set(app.id, job);
    const record = app;
    job.done = this.runJob(record, source, spec, databases, env, job)
      .catch((err: unknown) => {
        const aborted = job.controller.signal.aborted;
        const message = aborted ? t().publish.interrupted : err instanceof Error ? err.message.slice(0, 2000) : t().publish.failed;
        const running = steps.find((s) => s.state === 'running');
        if (running) {
          running.state = 'failed';
          running.detail = message;
        }
        record.state = 'failed';
        if (aborted) record.interrupted = true;
        else record.error = message;
        this.store.put(record);
      })
      .finally(() => {
        job.active = false;
        setTimeout(() => {
          if (this.jobs.get(record.id) === job) this.jobs.delete(record.id);
        }, 10 * 60_000).unref?.();
      });
    return this.appView(record);
  }

  private running(id: string): boolean {
    return Boolean(this.jobs.get(id)?.active);
  }

  private async runJob(
    app: AppRecord,
    source: PreviewForPublish,
    spec: PublishSpec,
    databases: DatabaseSpec[],
    env: { key: string; value: string }[],
    job: Job,
  ) {
    const signal = job.controller.signal;
    const step = (id: PublishStep['id']) => job.steps.find((s) => s.id === id)!;
    const begin = (id: PublishStep['id']) => {
      signal.throwIfAborted();
      step(id).state = 'running';
    };
    const end = (id: PublishStep['id'], state: PublishStep['state'] = 'done') => {
      step(id).state = state;
    };
    const run = this.run();
    const render = this.render();

    begin('repo');
    if (!app.repo) {
      app.repo = await createRepo(app.name, run);
      this.store.put(app);
      end('repo');
    } else end('repo', 'skipped');

    begin('push');
    const commit = await pushSnapshot(app.repo, source.files, source.executables, run, this.deps.tmpRoot, this.deps.gitDir);
    end('push');

    // The databases: made once, their connection read again for a publish that failed before its service.
    const made: { spec: DatabaseSpec; neon: NeonDatabase }[] = [];
    begin('database');
    const needed = app.serviceId ? [] : databases;
    if (needed.length) {
      const neon = this.neon();
      const org = this.neonOrg();
      for (const db of needed) {
        const known = app.databases.find((d) => d.service === db.service);
        if (known) {
          made.push({ spec: db, neon: await neon.connection(known.projectId, known.database, known.role) });
          continue;
        }
        const name = databases.length > 1 ? `${app.name}-${db.service}`.slice(0, 64) : app.name;
        const created = await neon.createProject(
          {
            name,
            regionId: NEON_REGION[this.store.render.region],
            ...(org ? { orgId: org } : {}),
            ...(db.pgVersion ? { pgVersion: db.pgVersion } : {}),
            ...(db.database !== 'neondb' ? { database: db.database } : {}),
            ...(db.role !== 'neondb_owner' ? { role: db.role } : {}),
          },
          signal,
        );
        app.databases.push({
          service: db.service,
          projectId: created.projectId,
          name,
          database: created.database,
          role: created.role,
          initialized: false,
        });
        this.store.put(app);
        made.push({ spec: db, neon: created });
      }
      end('database');
    } else end('database', 'skipped');

    begin('init');
    const scripts = made.filter(({ spec: db }) => db.scripts.length && !app.databases.find((d) => d.service === db.service)?.initialized);
    for (const { spec: db, neon } of scripts) {
      await runInitScripts(db.image ?? 'postgres:17', neon.uri, db.scripts, this.deps.owner, signal, this.deps.docker ?? localDocker);
      app.databases.find((d) => d.service === db.service)!.initialized = true;
      this.store.put(app);
    }
    end('init', scripts.length ? 'done' : 'skipped');

    begin('service');
    let deployId: string | undefined;
    if (!app.serviceId) {
      const vars = databaseEnv(spec.env, made, env);
      const service = await render.createService({
        type: spec.serviceType,
        name: app.name,
        ownerId: app.ownerId,
        repo: `https://github.com/${app.repo}`,
        details: spec.details,
        region: this.store.render.region,
        envVars: vars.map(({ key, value }) => ({ key, value })),
      });
      app.serviceId = service.id;
      if (service.url) app.url = service.url.replace(/\/$/, '') + '/' + (app.path ?? '');
      if (service.dashboardUrl) app.dashboardUrl = service.dashboardUrl;
      this.store.put(app);
      deployId = service.deployId;
    }
    deployId ??= await render.deploy(app.serviceId, commit);
    end('service');

    begin('build');
    const deadline = this.now() + DEPLOY_TIMEOUT;
    for (;;) {
      const status = await render.deployStatus(app.serviceId, deployId);
      step('build').detail = status;
      if (DEPLOY_DONE.has(status)) break;
      if (DEPLOY_FAILED.has(status)) throw new HttpError(502, t().publish.deployFailed(status));
      if (this.now() > deadline) throw new HttpError(502, t().publish.deployFailed(t().timedOut));
      await this.sleep(POLL, signal);
    }
    if (!app.url) {
      const service = await render.service(app.serviceId);
      const url = httpsUrl(service?.url);
      if (url) app.url = url.replace(/\/$/, '') + '/' + (app.path ?? '');
    }
    end('build');
    app.state = 'live';
    app.publishedAt = this.now();
    delete app.error;
    this.store.put(app);
  }

  /**
   * Takes the app down: its Render service, and its Neon projects when `database` (Neon keeps them to
   * restore for 7 days). The GitHub repository stays: deleting one needs a scope gh does not have by default.
   */
  async unpublish(id: string, database: boolean) {
    const app = this.store.app(id);
    if (!app) throw new HttpError(404, t().publish.notFound);
    if (this.running(id)) throw new HttpError(409, t().publish.busy);
    if (app.serviceId) await this.render().deleteService(app.serviceId);
    if (database && app.databases.length) {
      const neon = this.neon();
      for (const d of app.databases) await neon.deleteProject(d.projectId);
    }
    this.store.remove(id);
    this.jobs.delete(id);
  }

  /** Stops the publishes under way (the server's shutdown): each ends as interrupted. */
  async close() {
    this.closed = true;
    const jobs = [...this.jobs.values()].filter((job) => job.active);
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}
