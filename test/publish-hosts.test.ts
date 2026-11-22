import { describe, expect, it, vi } from 'vitest';
import { PUBLISH_REPO_ACCESS } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { NeonApi } from '../src/server/publish/neon';
import { httpsUrl, RenderApi } from '../src/server/publish/render';

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown; redirect?: string };

/** A fetch that answers from `routes` (`METHOD path` → status and JSON) and records each request. */
function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown?]>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.href, method, headers: init?.headers as Record<string, string>, body, redirect: init?.redirect });
    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: 'no route ' + key }), { status: 404 });
    const [status, data] = route(body);
    return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const RENDER = 'https://api.render.com/v1';
const NEON = 'https://console.neon.tech/api/v2';

describe("Render's API", () => {
  it('lists the workspaces the key reaches, with the key in its header only, following no redirect', async () => {
    const { fetcher, calls } = fakeFetch({
      'GET /v1/owners': () => [
        200,
        [
          { owner: { id: 'tea-1', name: 'Me', type: 'user' }, cursor: 'a' },
          { owner: { id: 'tea-2', email: 'team@example.com', type: 'team' }, cursor: 'b' },
          { owner: { id: 'bad id/..' } },
        ],
      ],
    });
    const render = new RenderApi('rnd_key', fetcher, RENDER);
    expect(await render.owners()).toEqual([
      { id: 'tea-1', name: 'Me' },
      { id: 'tea-2', name: 'team@example.com' },
    ]);
    expect(calls[0]).toMatchObject({ url: RENDER + '/owners?limit=100', method: 'GET', redirect: 'error' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer rnd_key');
  });

  it('says when the key is refused, or Render wants payment information', async () => {
    const refused = new RenderApi('k', fakeFetch({ 'GET /v1/owners': () => [401, { message: 'unauthorized' }] }).fetcher, RENDER);
    await withLang('en', () => expect(refused.owners()).rejects.toMatchObject({ status: 400, message: /Render API key is not valid/ }));
    const pay = new RenderApi(
      'k',
      fakeFetch({ 'POST /v1/services': () => [402, { message: 'payment information required' }] }).fetcher,
      RENDER,
    );
    await withLang('en', () =>
      expect(
        pay.createService({ type: 'web_service', name: 'a', ownerId: 'tea-1', repo: 'r', details: {}, region: 'oregon', envVars: [] }),
      ).rejects.toMatchObject({ status: 400, message: /payment information/ }),
    );
  });

  it('makes a free web service from the repository, deploying only when Relay asks, and reads its address', async () => {
    const { fetcher, calls } = fakeFetch({
      'POST /v1/services': () => [
        201,
        {
          service: {
            id: 'srv-1',
            dashboardUrl: 'https://dashboard.render.com/web/srv-1',
            serviceDetails: { url: 'https://todo-app.onrender.com' },
          },
          deployId: 'dep-1',
        },
      ],
    });
    const render = new RenderApi('k', fetcher, RENDER);
    const made = await render.createService({
      type: 'web_service',
      name: 'todo-app',
      ownerId: 'tea-1',
      repo: 'https://github.com/me/todo-app',
      details: { runtime: 'docker', envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.' } },
      region: 'singapore',
      envVars: [{ key: 'A', value: 'b' }],
    });
    expect(made).toEqual({
      id: 'srv-1',
      url: 'https://todo-app.onrender.com/',
      dashboardUrl: 'https://dashboard.render.com/web/srv-1',
      deployId: 'dep-1',
    });
    expect(calls[0]!.body).toEqual({
      type: 'web_service',
      name: 'todo-app',
      ownerId: 'tea-1',
      repo: 'https://github.com/me/todo-app',
      branch: 'main',
      autoDeployTrigger: 'off',
      envVars: [{ key: 'A', value: 'b' }],
      serviceDetails: {
        runtime: 'docker',
        envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.' },
        plan: 'free',
        region: 'singapore',
      },
    });
  });

  it('gives a static site no plan or region, which Render does not take for one', async () => {
    const { fetcher, calls } = fakeFetch({ 'POST /v1/services': () => [201, { service: { id: 'srv-2' } }] });
    await new RenderApi('k', fetcher, RENDER).createService({
      type: 'static_site',
      name: 's',
      ownerId: 'tea-1',
      repo: 'r',
      details: { publishPath: '.' },
      region: 'oregon',
      envVars: [],
    });
    expect((calls[0]!.body as { serviceDetails: unknown }).serviceDetails).toEqual({ publishPath: '.' });
  });

  it("says how to let Render's GitHub app read the repository when it cannot, and when a name is taken", async () => {
    const spec = {
      type: 'web_service' as const,
      name: 'n',
      ownerId: 'tea-1',
      repo: 'r',
      details: {},
      region: 'oregon' as const,
      envVars: [],
    };
    const noAccess = new RenderApi(
      'k',
      fakeFetch({ 'POST /v1/services': () => [400, { message: 'could not find repository https://github.com/me/n' }] }).fetcher,
      RENDER,
    );
    await withLang('en', () =>
      expect(noAccess.createService(spec)).rejects.toMatchObject({
        status: 400,
        code: PUBLISH_REPO_ACCESS,
        message: expect.stringContaining('https://github.com/apps/render/installations/new'),
      }),
    );
    const taken = new RenderApi('k', fakeFetch({ 'POST /v1/services': () => [409, { message: 'name taken' }] }).fetcher, RENDER);
    await expect(taken.createService(spec)).rejects.toMatchObject({ status: 409 });
    const other = new RenderApi('k', fakeFetch({ 'POST /v1/services': () => [400, { message: 'invalid plan' }] }).fetcher, RENDER);
    await withLang('en', () => expect(other.createService(spec)).rejects.toMatchObject({ status: 502, message: /invalid plan/ }));
  });

  it("deploys a commit, follows the deploy's state, and treats a service gone from Render as gone", async () => {
    const { fetcher, calls } = fakeFetch({
      'POST /v1/services/srv-1/deploys': () => [201, { id: 'dep-2', status: 'created' }],
      'GET /v1/services/srv-1/deploys/dep-2': () => [200, { id: 'dep-2', status: 'build_in_progress' }],
      'GET /v1/services/srv-1': () => [200, { id: 'srv-1', serviceDetails: { url: 'https://x.onrender.com' } }],
      'DELETE /v1/services/srv-1': () => [204],
      'DELETE /v1/services/srv-9': () => [404, { message: 'not found' }],
      'GET /v1/services/srv-9': () => [404],
      'POST /v1/services/srv-9/deploys': () => [404],
    });
    const render = new RenderApi('k', fetcher, RENDER);
    expect(await render.deploy('srv-1', 'abc123')).toBe('dep-2');
    expect(calls[0]!.body).toEqual({ commitId: 'abc123', clearCache: 'do_not_clear' });
    expect(await render.deployStatus('srv-1', 'dep-2')).toBe('build_in_progress');
    expect(await render.service('srv-1')).toMatchObject({ url: 'https://x.onrender.com/' });
    expect(await render.service('srv-9')).toBeUndefined();
    await render.deleteService('srv-1');
    await render.deleteService('srv-9');
    await withLang('en', () => expect(render.deploy('srv-9', 'abc')).rejects.toMatchObject({ status: 409, message: /deleted on Render/ }));
  });

  it("never puts a host's id where it could leave its place in a path", async () => {
    const render = new RenderApi('k', fakeFetch({}).fetcher, RENDER);
    await expect(render.deployStatus('../owners', 'x')).rejects.toMatchObject({ status: 502 });
    await expect(render.deleteService('a/b')).rejects.toMatchObject({ status: 502 });
  });

  it('says Render could not be reached, without the error itself', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    }) as unknown as typeof fetch;
    await withLang('en', () =>
      expect(new RenderApi('k', fetcher, RENDER).owners()).rejects.toMatchObject({
        status: 502,
        message: 'Render could not be reached, or its answer could not be read. Try again in a moment.',
      }),
    );
  });

  it('links only to https addresses Render gives', () => {
    expect(httpsUrl('https://a.onrender.com')).toBe('https://a.onrender.com/');
    expect(httpsUrl('http://a.onrender.com')).toBeUndefined();
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpsUrl('https://u:p@a.onrender.com')).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});

describe("Neon's API", () => {
  it('lists the organizations the key reaches', async () => {
    const { fetcher, calls } = fakeFetch({
      'GET /api/v2/users/me/organizations': () => [200, { organizations: [{ id: 'org-1', name: 'Mine' }, { id: 'org 2' }] }],
    });
    expect(await new NeonApi('napi', fetcher, NEON).orgs()).toEqual([{ id: 'org-1', name: 'Mine' }]);
    expect(calls[0]!.headers.Authorization).toBe('Bearer napi');
  });

  it("makes a project in the organization with the compose file's names and version, and waits for its operations", async () => {
    let polls = 0;
    const { fetcher, calls } = fakeFetch({
      'POST /api/v2/projects': () => [
        201,
        {
          project: { id: 'proj-1' },
          connection_uris: [
            {
              connection_uri: 'postgresql://todo:pw@ep-1.us-west-2.aws.neon.tech/todo?sslmode=require',
              connection_parameters: { database: 'todo', password: 'pw', role: 'todo', host: 'ep-1.us-west-2.aws.neon.tech' },
            },
          ],
          operations: [
            { id: 'op-1', status: 'running' },
            { id: 'op-2', status: 'finished' },
          ],
        },
      ],
      'GET /api/v2/projects/proj-1/operations/op-1': () => [
        200,
        { operation: { id: 'op-1', status: ++polls < 2 ? 'running' : 'finished' } },
      ],
    });
    const sleep = vi.fn(async () => {});
    const db = await new NeonApi('k', fetcher, NEON, sleep).createProject({
      name: 'todo-app',
      regionId: 'aws-us-west-2',
      orgId: 'org-1',
      pgVersion: 16,
      database: 'todo',
      role: 'todo',
    });
    expect(db).toEqual({
      projectId: 'proj-1',
      uri: 'postgresql://todo:pw@ep-1.us-west-2.aws.neon.tech/todo?sslmode=require',
      host: 'ep-1.us-west-2.aws.neon.tech',
      role: 'todo',
      password: 'pw',
      database: 'todo',
    });
    expect(calls[0]!.body).toEqual({
      project: {
        name: 'todo-app',
        region_id: 'aws-us-west-2',
        org_id: 'org-1',
        pg_version: 16,
        branch: { database_name: 'todo', role_name: 'todo' },
      },
    });
    expect(polls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('refuses a project whose operation failed, or an answer without its connection', async () => {
    const failed = fakeFetch({
      'POST /api/v2/projects': () => [
        201,
        {
          project: { id: 'p' },
          connection_uris: [
            { connection_uri: 'postgresql://a:b@h/d', connection_parameters: { database: 'd', password: 'b', role: 'a', host: 'h' } },
          ],
          operations: [{ id: 'op', status: 'failed' }],
        },
      ],
    });
    await expect(new NeonApi('k', failed.fetcher, NEON).createProject({ name: 'x', regionId: 'r' })).rejects.toMatchObject({ status: 502 });
    const empty = fakeFetch({ 'POST /api/v2/projects': () => [201, { project: { id: 'p' } }] });
    await expect(new NeonApi('k', empty.fetcher, NEON).createProject({ name: 'x', regionId: 'r' })).rejects.toMatchObject({ status: 502 });
  });

  it("reads a project's connection again, and deletes one (already gone is not an error)", async () => {
    const { fetcher, calls } = fakeFetch({
      'GET /api/v2/projects/proj-1/connection_uri': () => [200, { uri: 'postgresql://todo:p%40ss@ep-1.neon.tech/todo?sslmode=require' }],
      'DELETE /api/v2/projects/proj-1': () => [200, { project: { id: 'proj-1' } }],
      'DELETE /api/v2/projects/proj-2': () => [404, { message: 'not found' }],
    });
    const neon = new NeonApi('k', fetcher, NEON);
    expect(await neon.connection('proj-1', 'todo', 'todo')).toMatchObject({
      host: 'ep-1.neon.tech',
      role: 'todo',
      password: 'p@ss',
      database: 'todo',
    });
    expect(calls[0]!.url).toBe(NEON + '/projects/proj-1/connection_uri?database_name=todo&role_name=todo');
    await neon.deleteProject('proj-1');
    await neon.deleteProject('proj-2');
  });

  it('says when the key is refused', async () => {
    const neon = new NeonApi('k', fakeFetch({ 'GET /api/v2/users/me/organizations': () => [401, { message: 'no' }] }).fetcher, NEON);
    await withLang('en', () => expect(neon.orgs()).rejects.toMatchObject({ status: 400, message: /Neon API key is not valid/ }));
  });
});
