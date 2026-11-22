import { describe, expect, it } from 'vitest';
import { withLang } from '../src/server/i18n';
import {
  FORWARDER,
  SERVICE_CAPS,
  commandWords,
  composeModel,
  interpolate,
  isBacking,
  planCompose,
  planDockerfile,
  previewPort,
  type PreviewPlan,
} from '../src/server/previewCompose';

const files = new Set(['web/Dockerfile', 'web/app.py', 'db/init.sql', 'conf/site.conf', 'conf/extra/more.conf', 'Dockerfile.dev']);
const has = (path: string) => files.has(path);
const isFolder = (path: string) => !path || [...files].some((f) => f.startsWith(path + '/'));
const plan = (yaml: string) => planCompose(yaml, has, isFolder);
const refusal = (yaml: string) => {
  try {
    withLang('en', () => plan(yaml));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('not refused');
};

describe('interpolation, with nothing from the environment', () => {
  it.each([
    ['plain', 'plain'],
    ['${HOME}/x', '/x'],
    ['$HOME/x', '/x'],
    ['${MODE:-dev}', 'dev'],
    ['${MODE-dev}', 'dev'],
    ['${MODE:+on}', ''],
    ['${A:-${B:-nested}}', 'nested'],
    ['cost $$5', 'cost $5'],
    ['a$', 'a$'],
    ['$1', '$1'],
  ])('%s → %s', (text, value) => {
    expect(interpolate(text)).toBe(value);
  });
  it('refuses a required variable and a malformed one, naming them', () => {
    expect(() => withLang('en', () => interpolate('${TOKEN:?set it}'))).toThrow(/TOKEN \(set it\)/);
    expect(() => withLang('en', () => interpolate('${TOKEN?}'))).toThrow(/TOKEN/);
    expect(() => interpolate('${NOT CLOSED')).toThrow();
    expect(() => interpolate('${1BAD}')).toThrow();
  });
});

it('splits a command line as a shell would, without running one', () => {
  expect(commandWords('python app.py --name "Two words" \'single quoted\' a\\ b', 'x')).toEqual([
    'python',
    'app.py',
    '--name',
    'Two words',
    'single quoted',
    'a b',
  ]);
  expect(commandWords(['npm', 'start', 3], 'x')).toEqual(['npm', 'start', '3']);
  expect(commandWords('say ""', 'x')).toEqual(['say', '']);
  expect(() => commandWords('echo "open', 'x')).toThrow();
});

describe('a compose file', () => {
  const todo = `
name: ignored
x-common: &env
  TZ: UTC
services:
  web:
    build: ./web
    ports: ["127.0.0.1:8080:80/tcp", "9000/udp"]
    depends_on:
      db: { condition: service_healthy }
    environment:
      <<: *env
      DATABASE_URL: postgres://todo:\${DB_PASSWORD:-todo}@db/todo
      FROM_HOST:
    env_file: .env
    container_name: fixed
    restart: always
    networks: [front]
    deploy: { resources: { limits: { memory: 4g } } }
    command: python app.py --port 80
  db:
    image: postgres:16
    volumes:
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
      - pgdata:/var/lib/postgresql/data
      - type: tmpfs
        target: /run/postgresql
    healthcheck:
      test: pg_isready -U todo
      interval: 1s
  admin:
    image: adminer
    profiles: [debug]
volumes:
  pgdata:
networks:
  front: {}
`;
  it('keeps what an app needs, interpolated, and says what it left out', () => {
    const p = withLang('en', () => plan(todo));
    expect(p.main).toBe('web');
    expect(p.volumes).toEqual(['pgdata']);
    expect(p.services.map((s) => s.name)).toEqual(['web', 'db']);
    const [web, db] = p.services;
    expect(web).toMatchObject({
      build: { context: 'web', dockerfile: 'Dockerfile', args: {} },
      command: ['python', 'app.py', '--port', '80'],
      environment: { TZ: 'UTC', DATABASE_URL: 'postgres://todo:todo@db/todo' },
      dependsOn: { db: { condition: 'service_healthy' } },
      ports: [80],
    });
    expect(web!.environment).not.toHaveProperty('FROM_HOST');
    expect(db).toMatchObject({
      image: 'postgres:16',
      mounts: [{ source: 'db/init.sql', target: '/docker-entrypoint-initdb.d/init.sql', folder: false }],
      volumes: [
        { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', readOnly: false },
        { type: 'tmpfs', target: '/run/postgresql' },
      ],
      healthcheck: { test: 'pg_isready -U todo', interval: '1s' },
    });
    expect(p.notes.join('\n')).toMatch(/env_file of web/);
    expect(p.notes.join('\n')).toMatch(/left out admin/);
  });

  it.each([
    ['privileged', 'services:\n  a:\n    image: x\n    privileged: true', /a\.privileged/],
    ['capabilities', 'services:\n  a:\n    image: x\n    cap_add: [NET_ADMIN]', /a\.cap_add/],
    ['the host network', 'services:\n  a:\n    image: x\n    network_mode: host', /network_mode: host/],
    ["another container's namespace", 'services:\n  a:\n    image: x\n    pid: "container:b"', /pid: container:b/],
    [
      'the Docker socket',
      'services:\n  a:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]',
      /outside the project/,
    ],
    ['a home path', 'services:\n  a:\n    image: x\n    volumes: ["~/.ssh:/root/.ssh"]', /outside the project/],
    ['a path above the project', 'services:\n  a:\n    image: x\n    volumes: ["../secrets:/s"]', /outside the project/],
    ['a Windows path', 'services:\n  a:\n    image: x\n    volumes: ["C:\\\\Users:/u"]', /outside the project/],
    ['a build from Git', 'services:\n  a:\n    build: https://github.com/a/b.git', /URL or Git/],
    ['a build from above', 'services:\n  a:\n    build: ..', /outside the project/],
    ['build secrets', 'services:\n  a:\n    build: { context: web, secrets: [x] }', /a\.build\.secrets/],
    ['the host network for a build', 'services:\n  a:\n    build: { context: web, network: host }', /a\.build\.network/],
    ['extends', 'services:\n  a:\n    image: x\n    extends: { file: ../other.yml, service: b }', /a\.extends/],
    ['include', 'include: [../other.yml]\nservices:\n  a:\n    image: x', /include/],
    ['an unknown key', 'services:\n  a:\n    image: x\n    frobnicate: true', /a\.frobnicate/],
    [
      'a volume on a host folder',
      'services:\n  a:\n    image: x\nvolumes:\n  v: { driver_opts: { type: none, o: bind, device: /etc } }',
      /volumes\.v\.driver_opts/,
    ],
    ['an external volume', 'services:\n  a:\n    image: x\nvolumes:\n  v: { external: true }', /volumes\.v\.external/],
    ['an undeclared volume', 'services:\n  a:\n    image: x\n    volumes: ["data:/d"]', /data/],
    [
      'a volume subpath',
      'services:\n  a:\n    image: x\n    volumes: [{ type: volume, source: v, target: /d, volume: { subpath: x } }]\nvolumes:\n  v:',
      /subpath/,
    ],
    ["Relay's own service name", `services:\n  ${FORWARDER}:\n    image: x`, /reserved/],
    ['a missing Dockerfile', 'services:\n  a:\n    build: { context: web, dockerfile: Missing }', /web\/Missing/],
    ['a service with nothing to run', 'services:\n  a:\n    command: x', /image or a build/],
    ['an unknown dependency', 'services:\n  a:\n    image: x\n    depends_on: [b]', /depends on b/],
    ['no services', 'volumes: {}', /no service/],
    ['YAML that is not valid', 'services: [', /Cannot read/],
    ['duplicate keys', 'services:\n  a:\n    image: x\n    image: y', /Cannot read/],
  ])('refuses %s, naming it', (_, yaml, reason) => {
    expect(refusal(yaml)).toMatch(reason);
  });

  it('refuses too many services and a file too large to read', () => {
    const many = 'services:\n' + Array.from({ length: 9 }, (_, i) => `  s${i}:\n    image: x\n`).join('');
    expect(refusal(many)).toMatch(/at most 8/);
    expect(refusal('services:\n  a:\n    image: x\n# ' + 'x'.repeat(256 * 1024))).toMatch(/256 KB/);
  });

  it('keeps a service its own namespaces and network settings it does not need, leaving them out', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    network_mode: bridge\n    ipc: private\n    extra_hosts: ["host.docker.internal:host-gateway"]\n    dns: [8.8.8.8]',
    );
    expect(p.services[0]).toMatchObject({ name: 'a', image: 'x' });
  });

  it('chooses the service to show: one that publishes a port, then one meant for a terminal, then one built here', () => {
    expect(plan('services:\n  db:\n    image: x\n  api:\n    image: y\n    expose: ["3000"]').main).toBe('api');
    expect(plan('services:\n  db:\n    image: x\n  cli:\n    image: y\n    stdin_open: true').main).toBe('cli');
    expect(plan('services:\n  db:\n    image: x\n  app:\n    build: web').main).toBe('app');
    expect(plan('services:\n  first:\n    image: x\n  second:\n    image: y').main).toBe('first');
    // A database that publishes its port is not the page, as in the todo app that started this.
    expect(
      plan('services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n  web:\n    build: web\n    ports: ["3000:3000"]').main,
    ).toBe('web');
    expect(
      plan(
        'services:\n  db:\n    image: docker.io/library/postgres:16\n    ports: ["5432:5432"]\n  ui:\n    image: nginx\n    ports: ["80:80"]',
      ).main,
    ).toBe('ui');
    expect(plan('services:\n  cache:\n    image: redis\n    ports: ["6379:6379"]').main).toBe('cache');
    expect(
      plan(
        'services:\n  mongo:\n    image: mongo:7\n    ports: ["27017:27017"]\n  admin:\n    image: mongo-express\n    ports: ["8081:8081"]',
      ).main,
    ).toBe('admin');
  });

  it('plans the project folders and files a service mounts, and skips what the snapshot does not hold', () => {
    const p = withLang('en', () =>
      plan(
        'services:\n  a:\n    image: nginx\n    volumes: ["./conf:/etc/nginx/conf.d", "./node_modules:/app/node_modules", "./:/src:ro"]',
      ),
    );
    expect(p.services[0]!.mounts).toEqual([
      { source: 'conf', target: '/etc/nginx/conf.d', folder: true },
      { source: '', target: '/src', folder: true },
    ]);
    expect(p.notes.join('\n')).toMatch(/\.\/node_modules → \/app\/node_modules/);
  });

  it('knows the images that serve a database rather than a page, and not the web UIs beside them', () => {
    for (const image of [
      'postgres:16',
      'docker.io/library/postgres',
      'bitnami/postgresql:16',
      'redis/redis-stack:latest',
      'redis/redis-stack-server',
      'mysql/mysql-server:8',
      'mongo@sha256:abc',
      'timescale/timescaledb-ha:pg16',
    ])
      expect(isBacking(image), image).toBe(true);
    for (const image of [
      'nginx',
      'python:3.13-slim',
      'mongo-express',
      'rediscommander/redis-commander',
      'provectuslabs/kafka-ui',
      'opensearchproject/opensearch-dashboards:2',
      'rabbitmq:3-management',
      'minio/minio',
      'neo4j:5',
      'ghcr.io/me/postgres-admin',
    ])
      expect(isBacking(image), image).toBe(false);
  });

  it('reads build options, an inline Dockerfile and both forms of a port', () => {
    const p = plan(`services:
  a:
    build:
      context: .
      dockerfile: Dockerfile.dev
      target: dev
      args: [VERSION=1, EMPTY]
      cache_from: [x]
    ports: [{ target: 5000, published: 80 }, "3000-3005:3000-3005"]
  b:
    build:
      dockerfile_inline: "FROM alpine\\nCMD echo hi"
`);
    expect(p.services[0]).toMatchObject({
      build: { context: '', dockerfile: 'Dockerfile.dev', target: 'dev', args: { VERSION: '1' } },
      ports: [5000, 3000],
    });
    expect(p.services[1]!.build).toMatchObject({ context: '', dockerfile: '.relay.Dockerfile', inline: 'FROM alpine\nCMD echo hi' });
  });
});

describe('the model Relay runs', () => {
  const options = (p: PreviewPlan, extra = {}) => ({
    project: 'relay-preview-abc',
    labels: { owner: 'me', session: 'relay-preview-abc' },
    images: new Map([['web', 'relay-preview-abc-0:build']]),
    forwarderImage: 'node@sha256:1',
    ...previewPort(p),
    ...extra,
  });
  it('puts the main service in the forwarder’s namespace and the others on an internal network, all hardened', () => {
    const p = plan(
      'services:\n  web:\n    build: ./web\n    ports: ["8080:80"]\n    hostname: web\n  cache:\n    image: redis\n    tty: false',
    );
    const model = composeModel(p, options(p)) as { services: Record<string, Record<string, unknown>>; networks: unknown };
    // Internal, and without a gateway: no address on the host's side to reach its services through.
    expect(model.networks).toEqual({
      relay: {
        internal: true,
        driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
        labels: { owner: 'me', session: 'relay-preview-abc' },
      },
    });
    const forwarder = model.services[FORWARDER]!;
    expect(forwarder).toMatchObject({
      image: 'node@sha256:1',
      user: '1000:1000',
      read_only: true,
      cap_drop: ['ALL'],
      cap_add: [],
      networks: { relay: { aliases: ['web'] } },
      sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0' },
    });
    const web = model.services.web!;
    expect(web).toMatchObject({
      image: 'relay-preview-abc-0:build',
      pull_policy: 'never',
      network_mode: `service:${FORWARDER}`,
      tty: true,
      stdin_open: true,
      cap_drop: ['ALL'],
      cap_add: SERVICE_CAPS,
      security_opt: ['no-new-privileges:true'],
      mem_limit: '1g',
      memswap_limit: '1g',
      pids_limit: 256,
      cpus: 1,
      restart: 'no',
      labels: { owner: 'me', session: 'relay-preview-abc' },
    });
    expect(web).not.toHaveProperty('ports');
    expect(web).not.toHaveProperty('hostname');
    expect(web.environment).toEqual({});
    expect(model.services.cache).toMatchObject({
      image: 'redis',
      pull_policy: 'missing',
      networks: ['relay'],
      tty: false,
      stdin_open: false,
    });
    for (const service of Object.values(model.services)) {
      expect(service).not.toHaveProperty('privileged');
      expect(service).not.toHaveProperty('ports');
      expect(JSON.stringify(service)).not.toMatch(/"(?:bind|host)"/);
    }
  });
  it('runs one service with no network at all, and gives it PORT', () => {
    const p = planDockerfile();
    const model = composeModel(p, options(p, previewPort(p, [8000]))) as { services: Record<string, Record<string, unknown>> };
    expect(model).not.toHaveProperty('networks');
    expect(model.services[FORWARDER]).toMatchObject({ network_mode: 'none' });
    expect(model.services.app).toMatchObject({ network_mode: `service:${FORWARDER}`, environment: { PORT: '8000' } });
    expect(previewPort(p, [80, 443])).toEqual({ port: 4173, setPort: true });
  });
  it('runs the main service with another command line, and keeps every $ literal for compose', () => {
    const p = plan('services:\n  app:\n    image: x\n    entrypoint: ["tool"]\n    environment: { PRICE: "$$5" }\nvolumes:\n  data:');
    const model = composeModel(p, options(p, { command: ['sh', '-c', 'echo $HOME'] })) as {
      services: Record<string, Record<string, unknown>>;
      volumes?: unknown;
    };
    expect(model.services.app).toMatchObject({
      entrypoint: ['sh'],
      command: ['-c', 'echo $$HOME'],
      environment: { PRICE: '$$5', PORT: '4173' },
    });
    // A volume declared but used by no service is not made.
    expect(model).not.toHaveProperty('volumes');
  });
});
