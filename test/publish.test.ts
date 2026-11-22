import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GH_SIGNED_OUT, PUBLISH_SETUP, type PublishedApp } from '../src/shared/types';
import { openDatabase } from '../src/server/db';
import { withLang } from '../src/server/i18n';
import { runProcess, type SpawnOptions, type SpawnResult } from '../src/server/process';
import type { Docker } from '../src/server/previewDocker';
import { AppPublisher, type PreviewForPublish } from '../src/server/publish';
import { repoRemote } from '../src/server/publish/git';
import { NEON_SECRET, PublishStore, RENDER_SECRET } from '../src/server/publish/store';
import type { SecretStore } from '../src/server/secrets';
import { slow } from './timeouts';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'relay-publish-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function keyring(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    storage: 'keychain',
    values,
    get: (n) => values.get(n) ?? null,
    set: (n, v) => void values.set(n, v),
    delete: (n) => void values.delete(n),
  };
}

const RENDER_KEY = 'rnd_abcdefghijklmnopqrstuvwxyz';
const NEON_KEY = 'napi_abcdefghijklmnopqrstuvwxyz';

/** Render and Neon as their APIs answer, in memory: services, deploys that go live after a poll, projects. */
function cloud(o: { deploy?: string[]; owners?: number } = {}) {
  const services = new Map<string, { body: Record<string, unknown> }>();
  const deploys = new Map<string, { states: string[]; commit?: string }>();
  const projects = new Map<string, Record<string, unknown>>();
  const requests: { method: string; path: string; body?: Record<string, unknown>; auth: string }[] = [];
  let n = 0;
  const json = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const auth = (init?.headers as Record<string, string>).Authorization;
    requests.push({ method, path: url.pathname, body, auth });
    const p = url.pathname;
    if (url.host === 'render.test') {
      if (auth !== 'Bearer ' + RENDER_KEY) return json(401, { message: 'unauthorized' });
      if (method === 'GET' && p === '/v1/owners')
        return json(
          200,
          Array.from({ length: o.owners ?? 1 }, (_, i) => ({ owner: { id: `tea-${i + 1}`, name: `Workspace ${i + 1}` } })),
        );
      if (method === 'POST' && p === '/v1/services') {
        const id = `srv-${++n}`;
        services.set(id, { body: body! });
        const deployId = `dep-${++n}`;
        deploys.set(deployId, { states: [...(o.deploy ?? ['build_in_progress', 'live'])] });
        return json(201, {
          service: {
            id,
            dashboardUrl: `https://dashboard.render.com/web/${id}`,
            serviceDetails: { url: `https://${body!.name}.onrender.com` },
          },
          deployId,
        });
      }
      const deploy = /^\/v1\/services\/([^/]+)\/deploys(?:\/([^/]+))?$/.exec(p);
      if (deploy && !services.has(deploy[1]!)) return json(404, { message: 'not found' });
      if (deploy && method === 'POST') {
        const id = `dep-${++n}`;
        deploys.set(id, { states: [...(o.deploy ?? ['update_in_progress', 'live'])], commit: String(body!.commitId) });
        return json(201, { id, status: 'created' });
      }
      if (deploy && method === 'GET') {
        const d = deploys.get(deploy[2]!)!;
        return json(200, { id: deploy[2], status: d.states.length > 1 ? d.states.shift() : d.states[0] });
      }
      const service = /^\/v1\/services\/([^/]+)$/.exec(p);
      if (service && method === 'DELETE') return services.delete(service[1]!) ? json(204) : json(404);
      if (service && method === 'GET') return services.has(service[1]!) ? json(200, { id: service[1], serviceDetails: {} }) : json(404);
    }
    if (url.host === 'neon.test') {
      if (auth !== 'Bearer ' + NEON_KEY) return json(401, { message: 'unauthorized' });
      if (method === 'GET' && p === '/api/v2/users/me/organizations') return json(200, { organizations: [{ id: 'org-1', name: 'Mine' }] });
      if (method === 'POST' && p === '/api/v2/projects') {
        const project = body!.project as { name: string; branch?: { database_name?: string; role_name?: string } };
        const id = `proj-${++n}`;
        const database = project.branch?.database_name ?? 'neondb';
        const role = project.branch?.role_name ?? 'neondb_owner';
        projects.set(id, project);
        const host = `ep-${id}.neon.test`;
        return json(201, {
          project: { id },
          connection_uris: [
            {
              connection_uri: `postgresql://${role}:pw-${id}@${host}/${database}?sslmode=require`,
              connection_parameters: { database, role, password: `pw-${id}`, host },
            },
          ],
          operations: [{ id: 'op-1', status: 'finished' }],
        });
      }
      const conn = /^\/api\/v2\/projects\/([^/]+)\/connection_uri$/.exec(p);
      if (conn && projects.has(conn[1]!))
        return json(200, {
          uri: `postgresql://${url.searchParams.get('role_name')}:pw-${conn[1]}@ep-${conn[1]}.neon.test/${url.searchParams.get('database_name')}?sslmode=require`,
        });
      const project = /^\/api\/v2\/projects\/([^/]+)$/.exec(p);
      if (project && method === 'DELETE') return projects.delete(project[1]!) ? json(200, { project: {} }) : json(404);
    }
    return json(404, { message: 'no route' });
  }) as unknown as typeof fetch;
  return { fetcher, services, deploys, projects, requests };
}

/** gh as the fake: signed in as `me`, making each repository as a bare one in `base`; git itself is real. */
function runner(base: string, o: { signedOut?: boolean } = {}) {
  const gh: string[][] = [];
  const run = vi.fn(async (opts: SpawnOptions): Promise<SpawnResult> => {
    if (!/(^|[\\/])gh(\.exe)?$/.test(opts.bin)) return runProcess(opts);
    gh.push(opts.args);
    const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false, aborted: false }) as SpawnResult;
    if (o.signedOut) return { ...ok(''), code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' };
    if (opts.args.includes('user/repos')) {
      const name = opts.args.find((a) => a.startsWith('name='))!.slice(5);
      mkdirSync(join(base, 'me'), { recursive: true });
      execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', repoRemote(`me/${name}`, base)]);
      return ok(`me/${name}\n`);
    }
    return ok('me\n');
  });
  return { run, gh };
}

function fakeDocker() {
  const runs: { args: string[]; stdin: string }[] = [];
  const docker = vi.fn(async () => {
    const d = (async (args: string[], options?: { stdin?: string | Buffer }) => {
      runs.push({ args, stdin: String(options?.stdin ?? '') });
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false } as SpawnResult;
    }) as Docker;
    return d;
  });
  return { docker, runs };
}

let seq = 0;
function setup(o: { deploy?: string[]; owners?: number; signedOut?: boolean } = {}) {
  const dir = join(work, `case-${++seq}`);
  const base = join(dir, 'github');
  mkdirSync(base, { recursive: true });
  const db = openDatabase(join(dir, 'relay.db'));
  const secrets = keyring();
  const store = new PublishStore(db, secrets);
  const c = cloud(o);
  const { run, gh } = runner(base, o);
  const d = fakeDocker();
  let now = 1_000;
  const publisher = new AppPublisher(store, {
    fetcher: c.fetcher,
    run,
    docker: d.docker,
    sleep: async () => {},
    now: () => (now += 1000),
    tmpRoot: join(dir, 'tmp'),
    gitDir: base,
    renderBase: 'https://render.test/v1',
    neonBase: 'https://neon.test/api/v2',
    owner: 'relay-test',
  });
  return { dir, base, db, store, secrets, publisher, cloud: c, gh, docker: d };
}

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
const source = (over: Partial<PreviewForPublish> = {}): PreviewForPublish => ({
  conversationId: 'chat-1',
  folder: '/home/me/chats/todo-app',
  mode: 'container',
  entry: 'compose.yaml',
  files: files({
    'compose.yaml':
      'services:\n  app:\n    build: .\n    ports: ["3000:3000"]\n    environment:\n      DATABASE_URL: postgres://todo:todo@db:5432/todo\n  db:\n    image: postgres:16\n    environment: { POSTGRES_USER: todo, POSTGRES_PASSWORD: todo, POSTGRES_DB: todo }\n    volumes: ["./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro"]\n',
    Dockerfile: 'FROM node:22\nCMD ["node", "server.js"]\n',
    'server.js': 'require("http").createServer((q, s) => s.end("ok")).listen(process.env.PORT)',
    'db/init.sql': 'CREATE TABLE todos (id serial primary key, title text);',
  }),
  executables: new Set(),
  ...over,
});

async function until(publisher: AppPublisher, id: string): Promise<PublishedApp> {
  for (let i = 0; i < 200; i++) {
    const app = publisher.app(id);
    if (app.state !== 'publishing') return app;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('still publishing');
}

async function connected(s: ReturnType<typeof setup>) {
  await s.publisher.setRenderKey(RENDER_KEY);
  await s.publisher.setNeonKey(NEON_KEY);
}

describe('Settings → Publish to the cloud', () => {
  it('checks each key before keeping it in the credential store, and shows only its masked end', async () => {
    const s = setup();
    await withLang('en', () => expect(s.publisher.setRenderKey('rnd_wrongwrongwrongwrong')).rejects.toMatchObject({ status: 400 }));
    expect(s.secrets.values.size).toBe(0);
    await connected(s);
    expect(s.secrets.values.get(RENDER_SECRET)).toBe(RENDER_KEY);
    expect(s.secrets.values.get(NEON_SECRET)).toBe(NEON_KEY);
    const view = s.publisher.view();
    expect(JSON.stringify(view)).not.toContain(RENDER_KEY);
    expect(JSON.stringify(view)).not.toContain(NEON_KEY);
    expect(view.render).toMatchObject({
      keyMasked: expect.stringMatching(/wxyz$/),
      owners: [{ id: 'tea-1', name: 'Workspace 1' }],
      ownerId: 'tea-1',
      region: 'oregon',
    });
    expect(view.neon).toMatchObject({ orgs: [{ id: 'org-1', name: 'Mine' }], orgId: 'org-1' });
    // Nothing but the key goes into the database.
    expect(String((s.db.prepare("SELECT value FROM app_settings WHERE key = 'publish'").get() as { value: string }).value)).not.toContain(
      RENDER_KEY,
    );
    s.publisher.updateRender({ region: 'singapore' });
    expect(() => s.publisher.updateRender({ region: 'mars' })).toThrow();
    expect(() => s.publisher.updateRender({ ownerId: 'tea-9' })).toThrow();
    s.publisher.removeRender();
    s.publisher.removeNeon();
    expect(s.secrets.values.size).toBe(0);
    expect(s.publisher.view().render).toEqual({ keyMasked: '', owners: [], region: 'singapore' });
  });

  it('asks for a workspace when the key reaches several, and refuses keys without a credential store', async () => {
    const s = setup({ owners: 2 });
    await s.publisher.setRenderKey(RENDER_KEY);
    expect(s.publisher.view().render.ownerId).toBeUndefined();
    s.publisher.updateRender({ ownerId: 'tea-2' });
    expect(s.publisher.view().render.ownerId).toBe('tea-2');
    const none = new AppPublisher(new PublishStore(openDatabase(join(s.dir, 'none.db'))), { owner: 'x' });
    expect(none.view().storage).toBe(false);
    await expect(none.setRenderKey(RENDER_KEY)).rejects.toMatchObject({ status: 503 });
  });
});

describe('publishing a preview', () => {
  it(
    "pushes the snapshot to a new private repository, makes the Neon database with its init script, then Render's service with Neon's URL, until it is live",
    async () => {
      const s = setup();
      await connected(s);
      const plan = await withLang('en', () => s.publisher.plan(source()));
      expect(plan).toMatchObject({
        kind: 'compose',
        serviceType: 'web_service',
        name: 'todo-app',
        missing: [],
        neonReady: true,
        github: { login: 'me' },
        databases: [{ service: 'db', database: 'todo', role: 'todo', pgVersion: 16, initScripts: ['db/init.sql'] }],
      });
      // Neon's values are named, never shown before they exist.
      expect(plan.env).toEqual([
        { key: 'DATABASE_URL', value: '', source: 'database' },
        { key: 'PORT', value: '3000', source: 'compose' },
      ]);
      const started = await s.publisher.publish(source(), { public: true, env: [{ key: 'API_KEY', value: 'secret-1' }] });
      expect(started.state).toBe('publishing');
      const app = await until(s.publisher, started.id);
      expect(app).toMatchObject({
        state: 'live',
        name: 'todo-app',
        repo: 'me/todo-app',
        repoUrl: 'https://github.com/me/todo-app',
        url: 'https://todo-app.onrender.com/',
        dashboardUrl: expect.stringMatching(/^https:\/\/dashboard\.render\.com\//),
        databases: [{ service: 'db', name: 'todo-app' }],
      });
      expect(app.steps!.map((x) => [x.id, x.state])).toEqual([
        ['repo', 'done'],
        ['push', 'done'],
        ['database', 'done'],
        ['init', 'done'],
        ['service', 'done'],
        ['build', 'done'],
      ]);
      // The repository holds the snapshot, and none of the variables.
      const bare = repoRemote('me/todo-app', s.base);
      const tree = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })
        .trim()
        .split('\n');
      expect(tree.sort()).toEqual(['Dockerfile', 'compose.yaml', 'db/init.sql', 'server.js']);
      expect(() => execFileSync('git', ['--git-dir', bare, 'grep', '-q', 'secret-1', 'main'], { stdio: 'ignore' })).toThrow();
      // Neon: in the region near Render's, the organization, the compose file's names and version.
      const [project] = [...s.cloud.projects.values()];
      expect(project).toMatchObject({
        name: 'todo-app',
        region_id: 'aws-us-west-2',
        org_id: 'org-1',
        pg_version: 16,
        branch: { database_name: 'todo', role_name: 'todo' },
      });
      // The init script ran once, with psql from the compose file's image, the address on stdin only.
      expect(s.docker.runs).toHaveLength(1);
      const [psql] = s.docker.runs;
      expect(psql!.args).toContain('postgres:16');
      expect(psql!.args.join(' ')).not.toContain('pw-');
      expect(psql!.stdin).toMatch(/^postgresql:\/\/todo:pw-proj-\d+@ep-proj-\d+\.neon\.test\/todo\?sslmode=require\nCREATE TABLE todos/);
      // Render: a free Docker web service from the repository, with Neon's URL in place of the compose file's.
      const [service] = [...s.cloud.services.values()];
      expect(service!.body).toMatchObject({
        type: 'web_service',
        name: 'todo-app',
        ownerId: 'tea-1',
        repo: 'https://github.com/me/todo-app',
        branch: 'main',
        serviceDetails: { runtime: 'docker', plan: 'free', region: 'oregon' },
      });
      expect(service!.body.envVars).toEqual([
        { key: 'DATABASE_URL', value: expect.stringMatching(/^postgresql:\/\/todo:pw-proj-/) },
        { key: 'PORT', value: '3000' },
        { key: 'API_KEY', value: 'secret-1' },
      ]);
      expect(JSON.stringify(s.publisher.view())).not.toContain('pw-proj');
    },
    slow(30_000),
  );

  it(
    'updates the same service with a new commit, without making anything again',
    async () => {
      const s = setup();
      await connected(s);
      const first = await until(s.publisher, (await s.publisher.publish(source(), { public: true })).id);
      const plan = await s.publisher.plan(source());
      expect(plan.existing).toMatchObject({ id: first.id, url: first.url });
      const changed = source({ files: new Map([...source().files, ['server.js', Buffer.from('// v2')]]) });
      const app = await until(s.publisher, (await s.publisher.publish(changed, { public: true, name: 'ignored' })).id);
      expect(app).toMatchObject({ id: first.id, state: 'live', name: 'todo-app' });
      expect(app.steps!.map((x) => [x.id, x.state])).toEqual([
        ['repo', 'skipped'],
        ['push', 'done'],
        ['database', 'skipped'],
        ['init', 'skipped'],
        ['service', 'done'],
        ['build', 'done'],
      ]);
      expect(s.cloud.services.size).toBe(1);
      expect(s.cloud.projects.size).toBe(1);
      expect(s.docker.runs).toHaveLength(1);
      const head = execFileSync('git', ['--git-dir', repoRemote('me/todo-app', s.base), 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
      expect([...s.cloud.deploys.values()].some((d) => d.commit === head)).toBe(true);
    },
    slow(30_000),
  );

  it(
    "fails with Render's state when the build fails, then a second try goes on from what was made",
    async () => {
      const s = setup({ deploy: ['build_in_progress', 'build_failed'] });
      await connected(s);
      const failed = await withLang('en', async () => until(s.publisher, (await s.publisher.publish(source(), { public: true })).id));
      expect(failed).toMatchObject({ state: 'failed', error: expect.stringMatching(/build_failed/) });
      expect(failed.steps!.find((x) => x.id === 'build')).toMatchObject({ state: 'failed' });
      const again = await until(s.publisher, (await s.publisher.publish(source(), { public: true })).id);
      expect(again.steps!.map((x) => x.state)).toEqual(['skipped', 'done', 'skipped', 'skipped', 'done', 'failed']);
      expect(s.cloud.projects.size).toBe(1);
      expect(s.cloud.services.size).toBe(1);
    },
    slow(30_000),
  );

  it(
    'a Neon database for a backend only when ticked, and a static site with neither',
    async () => {
      const s = setup();
      await connected(s);
      const server = source({
        folder: '/x/api',
        mode: 'server',
        entry: 'package.json',
        files: files({ 'package.json': '{"scripts":{"start":"node ."}}', 'package-lock.json': '{}', 'index.js': '' }),
      });
      const app = await until(s.publisher, (await s.publisher.publish(server, { public: true, database: true, name: 'api' })).id);
      expect(app).toMatchObject({ state: 'live', databases: [{ service: 'DATABASE_URL', name: 'api' }] });
      const [project] = [...s.cloud.projects.values()];
      expect(project).not.toHaveProperty('branch');
      const body = [...s.cloud.services.values()][0]!.body;
      expect(body.serviceDetails).toMatchObject({ runtime: 'node', envSpecificDetails: { startCommand: 'npm start' } });
      expect(body.envVars).toEqual([
        { key: 'NODE_VERSION', value: '22' },
        { key: 'DATABASE_URL', value: expect.stringMatching(/^postgresql:\/\/neondb_owner:/) },
      ]);

      const site = source({ folder: '/x/site', mode: 'static', entry: 'game.html', files: files({ 'game.html': '<p>hi</p>' }) });
      const page = await until(s.publisher, (await s.publisher.publish(site, { public: true, database: true })).id);
      expect(page).toMatchObject({
        state: 'live',
        serviceType: 'static_site',
        name: 'site',
        url: 'https://site.onrender.com/game.html',
        databases: [],
      });
      expect(s.cloud.projects.size).toBe(1);
    },
    slow(30_000),
  );

  it('refuses before anything is made: without confirming it is public, without Settings, a bad or taken name, gh signed out', async () => {
    const s = setup();
    await withLang('en', async () => {
      await expect(s.publisher.publish(source(), {})).rejects.toMatchObject({ status: 400, message: /anyone with its address/ });
      await expect(s.publisher.publish(source(), { public: true })).rejects.toMatchObject({ status: 400, code: PUBLISH_SETUP });
      await s.publisher.setRenderKey(RENDER_KEY);
      // The compose file has PostgreSQL: Neon is needed.
      expect((await s.publisher.plan(source())).missing).toEqual(['neon']);
      await expect(s.publisher.publish(source(), { public: true })).rejects.toMatchObject({ code: PUBLISH_SETUP, message: /Neon/ });
      await s.publisher.setNeonKey(NEON_KEY);
      await expect(s.publisher.publish(source(), { public: true, name: 'Bad Name' })).rejects.toMatchObject({ status: 400 });
      await expect(s.publisher.publish(source(), { public: true, env: [{ key: '1X', value: '' }] })).rejects.toMatchObject({ status: 400 });
    });
    expect(s.cloud.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    // gh was only asked who is signed in (for the plan), and made nothing.
    expect(s.gh.filter((args) => args.includes('user/repos'))).toEqual([]);

    const out = setup({ signedOut: true });
    await connected(out);
    expect((await out.publisher.plan(source())).github).toEqual({ problem: GH_SIGNED_OUT });
    const failed = await until(out.publisher, (await out.publisher.publish(source(), { public: true })).id);
    expect(failed).toMatchObject({ state: 'failed' });
    expect(out.cloud.services.size).toBe(0);
  });

  it(
    'refuses a second publish of the same app while one runs, and another of the same name',
    async () => {
      const s = setup();
      await connected(s);
      const first = await s.publisher.publish(source(), { public: true });
      await expect(s.publisher.publish(source(), { public: true })).rejects.toMatchObject({ status: 409 });
      await until(s.publisher, first.id);
      await withLang('en', () =>
        expect(s.publisher.publish(source({ folder: '/elsewhere/todo-app' }), { public: true })).rejects.toMatchObject({
          status: 409,
          message: /already named "todo-app"/,
        }),
      );
      // The same folder as another kind of app: unpublished first.
      await expect(
        s.publisher.publish(source({ mode: 'static', entry: 'index.html', files: files({ 'index.html': '' }) }), { public: true }),
      ).rejects.toMatchObject({ status: 409 });
    },
    slow(30_000),
  );

  it(
    'unpublishes: the service goes, the databases only when asked, the record with them; a restart mid-publish says so',
    async () => {
      const s = setup();
      await connected(s);
      const app = await until(s.publisher, (await s.publisher.publish(source(), { public: true })).id);
      await s.publisher.unpublish(app.id, false);
      expect(s.cloud.services.size).toBe(0);
      expect(s.cloud.projects.size).toBe(1);
      expect(s.publisher.view().apps).toEqual([]);
      await expect(s.publisher.unpublish(app.id, false)).rejects.toMatchObject({ status: 404 });

      const again = await until(s.publisher, (await s.publisher.publish(source(), { public: true, name: 'todo-two' })).id);
      await s.publisher.unpublish(again.id, true);
      expect(s.cloud.projects.size).toBe(1);

      // A record left publishing when the server stopped: failed, in the reader's language.
      const record = { ...s.store.apps()[0], id: 'x', name: 'x', state: 'publishing' as const, databases: [], kind: 'static' as const };
      s.store.put(record as never);
      const reopened = new AppPublisher(new PublishStore(s.db, s.secrets), { owner: 'x' });
      expect(withLang('en', () => reopened.app('x'))).toMatchObject({
        state: 'failed',
        error: 'Harness Relay stopped during the publish. Publish again.',
      });
      expect(withLang('zh-TW', () => reopened.app('x')).error).toMatch(/停止/);
    },
    slow(30_000),
  );
});
