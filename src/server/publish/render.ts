import { PUBLISH_REPO_ACCESS, type PublishAccount, type RenderRegion } from '../../shared/types';
import { CONFIG } from '../config';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { arr, HostError, hostJson, obj, segment, str } from './http';

/** Render's REST API (https://api-docs.render.com). */
export const RENDER_API = 'https://api.render.com/v1';

/** Render's GitHub app, where the user lets it read the repositories Relay makes. */
export const RENDER_GITHUB_APP = 'https://github.com/apps/render/installations/new';

/** A deploy that is over: live, or one that will never be. */
export const DEPLOY_DONE = new Set(['live']);
export const DEPLOY_FAILED = new Set(['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed', 'deactivated']);

/** What Render is asked to make, by Relay (`plan.ts`): its type and details, never anything else. */
export interface RenderServiceSpec {
  type: 'static_site' | 'web_service';
  name: string;
  ownerId: string;
  repo: string;
  /** Static sites: `buildCommand`, `publishPath`. Web services: `runtime` and `envSpecificDetails`. */
  details: Record<string, unknown>;
  region: RenderRegion;
  envVars: { key: string; value: string }[];
}

export interface RenderService {
  id: string;
  url?: string;
  dashboardUrl?: string;
  deployId?: string;
}

/**
 * Render's API with the user's key: only to Render's host (or the end-to-end tests' stand-in on this
 * computer, `RELAY_RENDER_API_URL`), over HTTPS.
 */
export class RenderApi {
  private base: string;
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
    base: string = CONFIG.renderApiUrl ?? RENDER_API,
  ) {
    this.base = base.replace(/\/+$/, '') + '/';
  }

  private url(path: string, query?: Record<string, string>): URL {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }

  private async call(path: string, init?: Parameters<typeof hostJson>[4], query?: Record<string, string>) {
    try {
      return await hostJson(this.fetcher, 'Render', this.url(path, query), this.key, init);
    } catch (err) {
      if (!(err instanceof HostError)) throw err;
      if (err.status === 401 || err.status === 403) throw new HttpError(400, t().publish.renderKey);
      if (err.status === 402) throw new HttpError(400, t().publish.renderPayment);
      if (err.status === 429) throw new HttpError(429, t().publish.rateLimited('Render'));
      throw err;
    }
  }

  /** The workspaces the key reaches (`GET /owners`). */
  async owners(): Promise<PublishAccount[]> {
    const data = await this.call('owners', undefined, { limit: '100' }).catch((err: unknown) => {
      throw err instanceof HostError ? new HttpError(502, t().publish.renderFailed(err.message || String(err.status))) : err;
    });
    const out: PublishAccount[] = [];
    for (const item of arr(data)) {
      const owner = obj(item, 'owner');
      const id = str(owner, 'id');
      if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) out.push({ id, name: (str(owner, 'name') || str(owner, 'email') || id).slice(0, 200) });
    }
    return out;
  }

  /** Makes the service from the repository's `main`, without deploying on its own pushes (Relay deploys each commit). */
  async createService(spec: RenderServiceSpec): Promise<RenderService> {
    const serviceDetails = spec.type === 'web_service' ? { ...spec.details, plan: 'free', region: spec.region } : spec.details;
    let data: unknown;
    try {
      data = await this.call('services', {
        method: 'POST',
        body: {
          type: spec.type,
          name: spec.name,
          ownerId: spec.ownerId,
          repo: spec.repo,
          branch: 'main',
          autoDeployTrigger: 'off',
          envVars: spec.envVars,
          serviceDetails,
        },
        timeoutMs: 60_000,
      });
    } catch (err) {
      if (!(err instanceof HostError)) throw err;
      // Render cannot read the repository: its GitHub app does not reach it.
      if (/\b(repo|repository|github|git provider|installation)\b/i.test(err.message) && [400, 403, 404, 422].includes(err.status))
        throw new HttpError(400, t().publish.repoAccess(RENDER_GITHUB_APP), PUBLISH_REPO_ACCESS);
      if (err.status === 409) throw new HttpError(409, t().publish.renderName(spec.name));
      throw new HttpError(502, t().publish.renderFailed(err.message || String(err.status)));
    }
    const service = obj(data, 'service');
    const id = str(service, 'id');
    if (!id) throw new HttpError(502, t().publish.badAnswer);
    segment(id);
    return {
      id,
      url: httpsUrl(str(obj(service, 'serviceDetails'), 'url')),
      dashboardUrl: httpsUrl(str(service, 'dashboardUrl')),
      deployId: str(data, 'deployId'),
    };
  }

  /** The service as it is: its address, or undefined when it is gone (deleted on Render). */
  async service(id: string): Promise<RenderService | undefined> {
    try {
      const data = await this.call('services/' + segment(id));
      return { id, url: httpsUrl(str(obj(data, 'serviceDetails'), 'url')), dashboardUrl: httpsUrl(str(data, 'dashboardUrl')) };
    } catch (err) {
      if (err instanceof HostError && (err.status === 404 || err.status === 410)) return undefined;
      throw err instanceof HostError ? new HttpError(502, t().publish.renderFailed(err.message || String(err.status))) : err;
    }
  }

  /** Deploys a commit of the repository. */
  async deploy(serviceId: string, commitId: string): Promise<string> {
    try {
      const data = await this.call('services/' + segment(serviceId) + '/deploys', {
        method: 'POST',
        body: { commitId, clearCache: 'do_not_clear' },
      });
      const id = str(data, 'id');
      if (!id) throw new HttpError(502, t().publish.badAnswer);
      return id;
    } catch (err) {
      if (err instanceof HostError && (err.status === 404 || err.status === 410)) throw new HttpError(409, t().publish.serviceGone);
      throw err instanceof HostError ? new HttpError(502, t().publish.renderFailed(err.message || String(err.status))) : err;
    }
  }

  /** A deploy's state (`created`, `queued`, `build_in_progress`, `update_in_progress`, `live`…). */
  async deployStatus(serviceId: string, deployId: string): Promise<string> {
    try {
      const data = await this.call('services/' + segment(serviceId) + '/deploys/' + segment(deployId));
      return str(data, 'status') ?? 'unknown';
    } catch (err) {
      throw err instanceof HostError ? new HttpError(502, t().publish.renderFailed(err.message || String(err.status))) : err;
    }
  }

  /** Deletes the service; one already gone is not an error. */
  async deleteService(id: string): Promise<void> {
    try {
      await this.call('services/' + segment(id), { method: 'DELETE' });
    } catch (err) {
      if (err instanceof HostError && (err.status === 404 || err.status === 410)) return;
      throw err instanceof HostError ? new HttpError(502, t().publish.renderFailed(err.message || String(err.status))) : err;
    }
  }
}

/** An https address a host gave, else undefined: the UI only ever links to one. */
export function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
