import { describe, expect, it } from 'vitest';
import { withLang } from '../src/server/i18n';
import { pgUri } from './pgUri';
import type { NeonDatabase } from '../src/server/publish/neon';
import {
  databaseEnv,
  optionalDatabase,
  pgVersion,
  publishSpec,
  suggestName,
  userEnv,
  type PublishSource,
} from '../src/server/publish/plan';

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
const refusal = (source: PublishSource) => {
  try {
    withLang('en', () => publishSpec(source));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('not refused');
};
const neon = (over: Partial<NeonDatabase> = {}): NeonDatabase => ({
  projectId: 'p-1',
  uri: pgUri('secret', 'ep-1.neon.tech'),
  host: 'ep-1.neon.tech',
  role: 'todo',
  password: 'secret',
  database: 'todo',
  ...over,
});

const TODO_COMPOSE = `
services:
  app:
    build: .
    ports: ["3000:3000"]
    command: ["node", "dist/index.js"]
    environment:
      DATABASE_URL: postgres://todo:todo@db:5432/todo
      NODE_ENV: production
    depends_on: [db]
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: todo
      POSTGRES_PASSWORD: todo
      POSTGRES_DB: todo
    volumes:
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
      - ./db/seed:/docker-entrypoint-initdb.d
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

describe('what each kind of preview publishes as on Render', () => {
  it('a static page: a static site of the folder as it is, at its own path when it is not the index', () => {
    const index = publishSpec({ mode: 'static', entry: 'index.html', files: files({ 'index.html': '' }) });
    expect(index).toMatchObject({ kind: 'static', serviceType: 'static_site', details: { publishPath: '.' }, env: [], databases: [] });
    expect(index.path).toBeUndefined();
    expect(publishSpec({ mode: 'static', entry: 'game.html', files: files({ 'game.html': '' }) }).path).toBe('game.html');
  });

  it("an npm build: a static site that runs the preview's npm ci and build, publishing dist, on the preview's Node", () => {
    const spec = publishSpec({ mode: 'build', entry: 'package.json', files: files({ 'package.json': '{}' }) });
    expect(spec).toMatchObject({
      kind: 'build',
      serviceType: 'static_site',
      details: { buildCommand: 'npm ci --include=dev && npm run build', publishPath: 'dist' },
      env: [{ key: 'NODE_VERSION', value: '22', source: 'compose' }],
      databaseOptional: false,
    });
    // A workspace member builds its own, from the workspace root's lockfile.
    expect(publishSpec({ mode: 'build', entry: 'package.json', workspace: 'client', files: files({}) }).details).toEqual({
      buildCommand: 'npm ci --include=dev --workspace=client --include-workspace-root && npm run build --workspace=client',
      publishPath: 'client/dist',
    });
  });

  it('a Node.js backend: a web service with the npm ci and npm start the preview ran, and a database to add', () => {
    const spec = publishSpec({ mode: 'server', entry: 'package.json', workspace: 'apps/api', files: files({}) });
    expect(spec).toMatchObject({
      kind: 'server',
      serviceType: 'web_service',
      details: {
        runtime: 'node',
        envSpecificDetails: {
          buildCommand: 'npm ci --include=dev --workspace=apps/api --include-workspace-root',
          startCommand: 'npm start --workspace=apps/api',
        },
      },
      databaseOptional: true,
    });
  });

  it("refuses a workspace folder Render's shell would read as more than a path", () => {
    for (const workspace of ['a b', 'a;rm -rf /', '../up', 'x/./y', '$(id)'])
      expect(refusal({ mode: 'server', entry: 'package.json', workspace, files: files({}) })).toMatch(/workspace member/);
  });

  it('a Dockerfile: a web service built from it by Render', () => {
    expect(publishSpec({ mode: 'container', entry: 'Dockerfile', files: files({ Dockerfile: 'FROM scratch' }) })).toMatchObject({
      kind: 'docker',
      serviceType: 'web_service',
      details: { runtime: 'docker', envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.' } },
      databaseOptional: true,
    });
  });

  it("a compose file: its app service from its build, its command and port, and its PostgreSQL as Neon's with the init scripts in order", () => {
    const spec = publishSpec({
      mode: 'container',
      entry: 'compose.yaml',
      files: files({
        'compose.yaml': TODO_COMPOSE,
        Dockerfile: 'FROM node:22',
        'db/init.sql': 'CREATE TABLE todos (id int);',
        'db/seed/02-data.sql': 'INSERT INTO todos VALUES (1);',
        'db/seed/01-setup.sh': 'echo hi',
        'db/seed/nested/x.sql': 'not run: postgres reads only the folder itself',
      }),
    });
    expect(spec.kind).toBe('compose');
    expect(spec.details).toEqual({
      runtime: 'docker',
      envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: './', dockerCommand: 'node dist/index.js' },
    });
    expect(spec.env).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://todo:todo@db:5432/todo', source: 'compose' },
      { key: 'NODE_ENV', value: 'production', source: 'compose' },
      { key: 'PORT', value: '3000', source: 'compose' },
    ]);
    expect(spec.databases).toHaveLength(1);
    const [db] = spec.databases;
    expect(db).toMatchObject({ service: 'db', database: 'todo', role: 'todo', pgVersion: 16 });
    expect(db!.initScripts).toEqual(['db/seed/02-data.sql', 'db/init.sql']);
    expect(db!.skippedScripts).toEqual(['db/seed/01-setup.sh']);
    expect(db!.scripts.map((s) => s.sql.toString())).toEqual(['INSERT INTO todos VALUES (1);', 'CREATE TABLE todos (id int);']);
  });

  it("builds a compose service's context and Dockerfile from where the compose file says", () => {
    const spec = publishSpec({
      mode: 'container',
      entry: 'compose.yaml',
      files: files({
        'compose.yaml': 'services:\n  web:\n    build:\n      context: server\n      dockerfile: Dockerfile.prod\n    ports: ["8080"]\n',
        'server/Dockerfile.prod': 'FROM scratch',
      }),
    });
    expect(spec.details).toEqual({
      runtime: 'docker',
      envSpecificDetails: { dockerfilePath: './server/Dockerfile.prod', dockerContext: './server' },
    });
    expect(spec.databases).toEqual([]);
  });

  it('gives Neon its own names for a PostgreSQL left on postgres, and the default version for an image without one', () => {
    const spec = publishSpec({
      mode: 'container',
      entry: 'compose.yaml',
      files: files({
        'compose.yaml': 'services:\n  web:\n    build: .\n  pg:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: pw\n',
        Dockerfile: '',
      }),
    });
    expect(spec.databases[0]).toMatchObject({ service: 'pg', database: 'neondb', role: 'neondb_owner', composeUser: 'postgres' });
    expect(spec.databases[0]!.pgVersion).toBeUndefined();
  });

  it.each([
    ['services:\n  db:\n    image: postgres:16\n', /only a database/],
    ['services:\n  web:\n    build: .\n  cache:\n    image: redis:7\n', /also has "cache"/],
    ['services:\n  web:\n    build: .\n  api:\n    build: .\n', /also has "(web|api)"/],
    ['services:\n  web:\n    image: nginx\n    ports: ["80"]\n', /has no build/],
    ['services:\n  web:\n    build:\n      context: .\n      args:\n        A: b\n', /build arguments/],
    ['services:\n  web:\n    build:\n      context: .\n      target: prod\n', /build arguments, a target/],
    ['services:\n  web:\n    build: .\n    volumes: ["./Dockerfile:/app/Dockerfile"]\n', /mounts project files/],
    ['services:\n  web:\n    build: .\n    entrypoint: ["sh"]\n', /entrypoint/],
  ])('refuses what Render cannot run as one free service: %s', (yaml, reason) => {
    expect(refusal({ mode: 'container', entry: 'compose.yaml', files: files({ 'compose.yaml': yaml, Dockerfile: '' }) })).toMatch(reason);
  });
});

describe('the names and versions it makes', () => {
  it.each([
    ['/home/me/chats/todo-app', 'todo-app'],
    ['/x/My Cool App!!', 'my-cool-app'],
    ['/x/待辦清單', 'app'],
    ['/x/' + 'a'.repeat(60), 'a'.repeat(40)],
    ['/x/' + 'a'.repeat(39) + '-b', 'a'.repeat(39)],
  ])('suggests a name from the folder %s', (folder, name) => expect(suggestName(folder)).toBe(name));

  it.each([
    ['postgres:16', 16],
    ['postgres:16.4-alpine', 16],
    ['docker.io/library/postgres:17@sha256:abc', 17],
    ['postgis/postgis:15-3.4', 15],
    ['timescale/timescaledb:latest-pg17', 17],
    ['postgres:13', undefined],
    ['postgres:latest', undefined],
    ['postgres', undefined],
  ])("reads the major version from the image's tag: %s", (image, version) => expect(pgVersion(image)).toBe(version));
});

describe("the app's variables", () => {
  const todo = () =>
    publishSpec({
      mode: 'container',
      entry: 'compose.yaml',
      files: files({ 'compose.yaml': TODO_COMPOSE, Dockerfile: '', 'db/init.sql': '' }),
    });

  it("replaces the compose file's URL to the database service with Neon's, and keeps the rest", () => {
    const spec = todo();
    const env = databaseEnv(spec.env, [{ spec: spec.databases[0]!, neon: neon() }], []);
    expect(env).toEqual([
      { key: 'DATABASE_URL', value: neon().uri, source: 'database' },
      { key: 'NODE_ENV', value: 'production', source: 'compose' },
      { key: 'PORT', value: '3000', source: 'compose' },
    ]);
  });

  it('replaces separate host, user, password and database variables, and asks for TLS', () => {
    const spec = publishSpec({
      mode: 'container',
      entry: 'compose.yaml',
      files: files({
        Dockerfile: '',
        'compose.yaml': `services:
  web:
    build: .
    environment:
      PGHOST: db
      PGUSER: shop
      PGPASSWORD: hunter2
      PGDATABASE: store
      PGPORT: "5432"
      GREETING: shop
  db:
    image: postgres:17
    environment: { POSTGRES_USER: shop, POSTGRES_PASSWORD: hunter2, POSTGRES_DB: store }
`,
      }),
    });
    const env = databaseEnv(
      spec.env,
      [{ spec: spec.databases[0]!, neon: neon({ role: 'shop', database: 'store', password: 'n3on' }) }],
      [],
    );
    expect(Object.fromEntries(env.map((e) => [e.key, e.value]))).toEqual({
      PGHOST: 'ep-1.neon.tech',
      PGUSER: 'shop',
      PGPASSWORD: 'n3on',
      PGDATABASE: 'store',
      PGPORT: '5432',
      // Not a variable about the database, though its value is the user's name.
      GREETING: 'shop',
      PGSSLMODE: 'require',
    });
    expect(env.some((e) => e.key === 'DATABASE_URL')).toBe(false);
  });

  it('gives DATABASE_URL for a database no variable names (the checkbox), and puts the user’s over the rest but Neon’s', () => {
    const env = databaseEnv(
      [{ key: 'NODE_VERSION', value: '22', source: 'compose' }],
      [{ spec: optionalDatabase(), neon: neon() }],
      [
        { key: 'NODE_VERSION', value: '24' },
        { key: 'API_KEY', value: 'k' },
        { key: 'DATABASE_URL', value: 'postgres://elsewhere' },
      ],
    );
    expect(env).toEqual([
      { key: 'NODE_VERSION', value: '24', source: 'user' },
      { key: 'DATABASE_URL', value: neon().uri, source: 'database' },
      { key: 'API_KEY', value: 'k', source: 'user' },
    ]);
  });

  it("checks the dialog's variables", () => {
    expect(userEnv(undefined)).toEqual([]);
    expect(userEnv([{ key: 'A_1', value: 'x' }])).toEqual([{ key: 'A_1', value: 'x' }]);
    for (const bad of [
      'nope',
      [{ key: '1A', value: '' }],
      [{ key: 'A B', value: '' }],
      [{ key: 'A', value: 1 }],
      [{ key: 'A', value: 'a\0b' }],
      [
        { key: 'A', value: '' },
        { key: 'A', value: '' },
      ],
      Array.from({ length: 101 }, (_, i) => ({ key: 'K' + i, value: '' })),
      [{ key: 'A', value: 'x'.repeat(32 * 1024 + 1) }],
    ])
      expect(() => userEnv(bad)).toThrow();
  });
});
