import type { PublishAccount, RenderRegion } from '../../shared/types';
import { CONFIG } from '../config';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { arr, HostError, hostJson, obj, segment, str } from './http';

/** Neon's REST API (https://neon.com/docs/reference/api). */
export const NEON_API = 'https://console.neon.tech/api/v2';

/** Neon's region near each of Render's, so that an app and its database are close. */
export const NEON_REGION: Record<RenderRegion, string> = {
  oregon: 'aws-us-west-2',
  ohio: 'aws-us-east-2',
  virginia: 'aws-us-east-1',
  frankfurt: 'aws-eu-central-1',
  singapore: 'aws-ap-southeast-1',
};

/** What a new project's database is reached with. */
export interface NeonDatabase {
  projectId: string;
  /** `postgresql://role:password@host/database?sslmode=require…` */
  uri: string;
  host: string;
  role: string;
  password: string;
  database: string;
}

export interface NeonProjectSpec {
  name: string;
  regionId: string;
  orgId?: string;
  pgVersion?: number;
  database?: string;
  role?: string;
}

/**
 * Neon's API with the user's key: only to Neon's host (or the end-to-end tests' stand-in on this
 * computer, `RELAY_NEON_API_URL`), over HTTPS.
 */
export class NeonApi {
  private base: string;
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
    base: string = CONFIG.neonApiUrl ?? NEON_API,
    private sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    this.base = base.replace(/\/+$/, '') + '/';
  }

  private async call(path: string, init?: Parameters<typeof hostJson>[4]) {
    try {
      return await hostJson(this.fetcher, 'Neon', new URL(path, this.base), this.key, init);
    } catch (err) {
      if (!(err instanceof HostError)) throw err;
      if (err.status === 401 || err.status === 403) throw new HttpError(400, t().publish.neonKey);
      if (err.status === 429) throw new HttpError(429, t().publish.rateLimited('Neon'));
      throw err;
    }
  }

  private failed(err: unknown): never {
    throw err instanceof HostError ? new HttpError(502, t().publish.neonFailed(err.message || String(err.status))) : err;
  }

  /** The organizations the key reaches (`GET /users/me/organizations`). */
  async orgs(): Promise<PublishAccount[]> {
    const data = await this.call('users/me/organizations').catch((err: unknown) => this.failed(err));
    const out: PublishAccount[] = [];
    for (const org of arr(data, 'organizations')) {
      const id = str(org, 'id');
      if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) out.push({ id, name: (str(org, 'name') || id).slice(0, 200) });
    }
    return out;
  }

  /** Makes a project, and waits until what Neon does to start it has finished. */
  async createProject(spec: NeonProjectSpec, signal?: AbortSignal): Promise<NeonDatabase> {
    const data = await this.call('projects', {
      method: 'POST',
      body: {
        project: {
          name: spec.name,
          region_id: spec.regionId,
          ...(spec.orgId ? { org_id: spec.orgId } : {}),
          ...(spec.pgVersion ? { pg_version: spec.pgVersion } : {}),
          ...(spec.database || spec.role
            ? { branch: { ...(spec.database ? { database_name: spec.database } : {}), ...(spec.role ? { role_name: spec.role } : {}) } }
            : {}),
        },
      },
      timeoutMs: 60_000,
    }).catch((err: unknown) => this.failed(err));
    const projectId = str(obj(data, 'project'), 'id');
    const connection = arr(data, 'connection_uris')[0];
    const uri = str(connection, 'connection_uri');
    const params = obj(connection, 'connection_parameters');
    const host = str(params, 'host');
    const role = str(params, 'role');
    const password = str(params, 'password');
    const database = str(params, 'database');
    if (!projectId || !uri || !host || !role || !password || !database || !/^postgres(?:ql)?:\/\//.test(uri))
      throw new HttpError(502, t().publish.badAnswer);
    segment(projectId);
    const operations = arr(data, 'operations')
      .map((op) => ({ id: str(op, 'id'), status: str(op, 'status') }))
      .filter((op): op is { id: string; status: string | undefined } => Boolean(op.id));
    await this.waitFor(projectId, operations, signal);
    return { projectId, uri, host, role, password, database };
  }

  /** Waits for a new project's operations (its timeline, its compute's start), polling each until it ends. */
  private async waitFor(projectId: string, operations: { id: string; status?: string }[], signal?: AbortSignal) {
    const deadline = Date.now() + 180_000;
    for (const op of operations) {
      let status = op.status;
      while (status !== 'finished' && status !== 'skipped') {
        if (status === 'failed' || status === 'cancelled' || status === 'cancelling')
          throw new HttpError(502, t().publish.neonFailed(status));
        if (Date.now() > deadline) throw new HttpError(502, t().publish.neonFailed(t().timedOut));
        signal?.throwIfAborted();
        if (status !== undefined) await this.sleep(1000);
        const data = await this.call('projects/' + segment(projectId) + '/operations/' + segment(op.id)).catch((err: unknown) =>
          this.failed(err),
        );
        status = str(obj(data, 'operation'), 'status') ?? 'unknown';
        if (status === 'unknown') throw new HttpError(502, t().publish.badAnswer);
      }
    }
  }

  /** A project's database as it is reached now (a publish that failed after making it, tried again). */
  async connection(projectId: string, database: string, role: string): Promise<NeonDatabase> {
    const query = new URLSearchParams({ database_name: database, role_name: role });
    const data = await this.call('projects/' + segment(projectId) + '/connection_uri?' + query.toString()).catch((err: unknown) =>
      this.failed(err),
    );
    const uri = str(data, 'uri');
    let url: URL;
    try {
      if (!uri || !/^postgres(?:ql)?:\/\//.test(uri)) throw new Error();
      url = new URL(uri);
    } catch {
      throw new HttpError(502, t().publish.badAnswer);
    }
    return {
      projectId,
      uri: uri!,
      host: url.hostname,
      role: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
    };
  }

  /** Deletes a project (Neon keeps it to restore for 7 days); one already gone is not an error. */
  async deleteProject(id: string): Promise<void> {
    try {
      await this.call('projects/' + segment(id), { method: 'DELETE' });
    } catch (err) {
      if (err instanceof HostError && (err.status === 404 || err.status === 410)) return;
      this.failed(err);
    }
  }
}
