/**
 * Stand-ins for Render's and Neon's APIs on this computer, for publishing a previewed app
 * (`src/server/publish/`): one HTTP server, Render under `/render/v1` (`RELAY_RENDER_API_URL`) and Neon
 * under `/neon/api/v2` (`RELAY_NEON_API_URL`), answering as their API references document them, with
 * what the tests' keys reach. A service's first deploy is building when first asked, then live; a project
 * comes with its connection and operations already finished, at a host under `.test`, which no DNS
 * answers (Neon's own names would reach Neon), unless `databaseHost` names a real PostgreSQL (one in
 * Docker, whose `psql` runs a compose file's init scripts), reached without TLS. Every request is
 * recorded, without its key.
 */
import { createServer, type Server } from 'node:http';

export const RENDER_KEY = 'rnd_e2eRenderKeyForTheStandIn0001';
export const NEON_KEY = 'napi_e2eNeonKeyForTheStandIn00001';

export interface CloudRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export interface FakeCloud {
  renderUrl: string;
  neonUrl: string;
  requests: CloudRequest[];
  services: Map<string, Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  /** Deploys still to report: each answers its states in turn, then the last one. */
  deploys: Map<string, string[]>;
  server: Server;
}

export async function startCloud(o: { databaseHost?: string } = {}): Promise<FakeCloud> {
  const requests: CloudRequest[] = [];
  const services = new Map<string, Record<string, unknown>>();
  const projects = new Map<string, Record<string, unknown>>();
  const deploys = new Map<string, string[]>();
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const p = url.pathname;
      const auth = req.headers.authorization;
      if (p.startsWith('/render/v1/')) {
        requests.push({ method, path: p.slice('/render'.length), body });
        if (auth !== 'Bearer ' + RENDER_KEY) return send(401, { message: 'unauthorized' });
        const path = p.slice('/render/v1'.length);
        if (method === 'GET' && path === '/owners')
          return send(200, [{ owner: { id: 'tea-e2e', name: 'Relay Test', type: 'user' }, cursor: 'x' }]);
        if (method === 'POST' && path === '/services') {
          const id = `srv-e2e${++n}`;
          const deployId = `dep-e2e${++n}`;
          services.set(id, body!);
          deploys.set(deployId, ['build_in_progress', 'live']);
          return send(201, {
            service: {
              id,
              name: body!.name,
              dashboardUrl: `https://dashboard.render.com/${body!.type === 'static_site' ? 'static' : 'web'}/${id}`,
              serviceDetails: { url: `https://${String(body!.name)}.onrender.com` },
            },
            deployId,
          });
        }
        const deploy = /^\/services\/([^/]+)\/deploys(?:\/([^/]+))?$/.exec(path);
        if (deploy && !services.has(deploy[1]!)) return send(404, { message: 'service not found' });
        if (deploy && method === 'POST') {
          const id = `dep-e2e${++n}`;
          deploys.set(id, ['update_in_progress', 'live']);
          return send(201, { id, status: 'created', commit: { id: body?.commitId } });
        }
        if (deploy && method === 'GET') {
          const states = deploys.get(deploy[2]!) ?? ['live'];
          return send(200, { id: deploy[2], status: states.length > 1 ? states.shift() : states[0] });
        }
        const service = /^\/services\/([^/]+)$/.exec(path);
        if (service && method === 'DELETE') return services.delete(service[1]!) ? send(204) : send(404, { message: 'not found' });
        if (service && method === 'GET') return services.has(service[1]!) ? send(200, { id: service[1], serviceDetails: {} }) : send(404);
        return send(404, { message: 'not found' });
      }
      if (p.startsWith('/neon/api/v2/')) {
        requests.push({ method, path: p.slice('/neon'.length), body });
        if (auth !== 'Bearer ' + NEON_KEY) return send(401, { message: 'unauthorized' });
        const path = p.slice('/neon/api/v2'.length);
        if (method === 'GET' && path === '/users/me/organizations')
          return send(200, { organizations: [{ id: 'org-e2e', name: 'Relay Test org' }] });
        if (method === 'POST' && path === '/projects') {
          const project = (body?.project ?? {}) as { branch?: { database_name?: string; role_name?: string } };
          const id = `proj-e2e${++n}`;
          const database = project.branch?.database_name ?? 'neondb';
          const role = project.branch?.role_name ?? 'neondb_owner';
          const host = o.databaseHost ?? `ep-${id}.us-west-2.neon.test`;
          const options = o.databaseHost ? 'sslmode=disable' : 'sslmode=require';
          projects.set(id, project);
          return send(201, {
            project: { id },
            connection_uris: [
              {
                connection_uri: `postgresql://${role}:npg_e2e@${host}/${database}?${options}`,
                connection_parameters: { database, role, password: 'npg_e2e', host },
              },
            ],
            operations: [{ id: 'op-e2e', status: 'finished' }],
          });
        }
        const project = /^\/projects\/([^/]+)$/.exec(path);
        if (project && method === 'DELETE')
          return projects.delete(project[1]!) ? send(200, { project: {} }) : send(404, { message: 'not found' });
        return send(404, { message: 'not found' });
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { renderUrl: base + '/render/v1', neonUrl: base + '/neon/api/v2', requests, services, projects, deploys, server };
}
