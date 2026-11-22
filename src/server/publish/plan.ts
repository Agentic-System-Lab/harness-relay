import { basename, posix } from 'node:path';
import type { PublishDatabasePlan, PublishEnvVar, PublishKind } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { COMPOSE_NAMES, type PreviewService } from '../previewCompose';
import { previewPlan, shownCommand } from '../previewContainer';
import { PREVIEW_NODE_MAJOR } from '../previewRuntime';
import type { NeonDatabase } from './neon';

/** What a publish makes of a preview: Render's service, and the databases it needs. */
export interface PublishSpec {
  kind: PublishKind;
  serviceType: 'static_site' | 'web_service';
  /** Render's details for the service (`plan.ts` alone writes them). */
  details: Record<string, unknown>;
  /** Shown in the dialog: the commands Render runs, the folder it publishes, the Dockerfile. */
  commands: { build?: string; start?: string; publish?: string; dockerfile?: string };
  /** The variables the app gets before its databases are made (the compose file's, `NODE_VERSION`). */
  env: PublishEnvVar[];
  databases: DatabaseSpec[];
  /** A backend or Dockerfile without compose: a database can be added. */
  databaseOptional: boolean;
  /** A static page that is not the folder's index: the path it is at. */
  path?: string;
}

/** A Neon database for a compose file's PostgreSQL service: what the app's variables say of it now. */
export interface DatabaseSpec extends PublishDatabasePlan {
  /** The image its init scripts run with (`psql`), the compose file's own. */
  image?: string;
  /** The compose file's values that stand for it, replaced by Neon's (`databaseEnv`). */
  composeUser?: string;
  composePassword?: string;
  composeDatabase?: string;
  /** Each init script's text, in order. */
  scripts: { name: string; sql: Buffer }[];
}

/** What a preview publishes from: its mode, its recipe and its files. */
export interface PublishSource {
  mode: 'static' | 'build' | 'server' | 'container';
  entry: string;
  /** For a member of an npm workspace: its folder inside the workspace root the files are from. */
  workspace?: string;
  files: ReadonlyMap<string, Buffer>;
}

/** An app's name on GitHub and Render: lowercase letters, digits and hyphens, at most 40. */
export const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The name the dialog starts with, from the folder's own. */
export function suggestName(folder: string): string {
  const slug = basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'app';
}

/** A workspace member's folder, as npm takes it in a command Render's shell runs: plain path characters only. */
function workspaceFlag(workspace: string | undefined): string {
  if (workspace === undefined) return '';
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(workspace) || workspace.split('/').some((p) => p === '..' || p === '.'))
    throw new HttpError(400, t().publish.workspace);
  return ' --workspace=' + workspace;
}

/** PostgreSQL's images, whose services become Neon databases. */
const POSTGRES = /^(?:[^/]+\/)*(?:postgres|postgresql|postgis|timescaledb(?:-ha)?)(?:[:@]|$)/i;

/** The major PostgreSQL version an image's tag names (`postgres:16`, `postgis/postgis:16-3.4`, `…:latest-pg17`), if Neon has it. */
export function pgVersion(image: string): number | undefined {
  const tag = /:([^@/]+)(?:@|$)/.exec(image)?.[1] ?? '';
  const m = /(?:^|pg)(\d{2})(?:[.-]|$)/.exec(tag);
  const v = m ? Number(m[1]) : NaN;
  return v >= 14 && v <= 18 ? v : undefined;
}

/** A name Neon takes for a database or a role: PostgreSQL's plain identifiers, not `postgres` (Neon's names then). */
function neonName(value: string | undefined): string | undefined {
  return value && value !== 'postgres' && /^[a-z_][a-z0-9_]{0,62}$/.test(value) ? value : undefined;
}

const INITDB = '/docker-entrypoint-initdb.d';

/** The init scripts a PostgreSQL service mounts, in the order its image runs them (by name). */
function initScripts(service: PreviewService, files: ReadonlyMap<string, Buffer>) {
  const found: { name: string; source: string }[] = [];
  for (const m of service.mounts) {
    const target = posix.normalize(m.target).replace(/\/+$/, '');
    if (m.folder) {
      if (target !== INITDB) continue;
      for (const name of files.keys()) {
        const rest = m.source ? (name.startsWith(m.source + '/') ? name.slice(m.source.length + 1) : undefined) : name;
        if (rest && !rest.includes('/')) found.push({ name: rest, source: name });
      }
    } else if (posix.dirname(target) === INITDB) {
      found.push({ name: posix.basename(target), source: m.source });
    }
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const scripts: { name: string; sql: Buffer }[] = [];
  const skipped: string[] = [];
  for (const f of found) {
    const sql = files.get(f.source);
    if (/\.sql$/i.test(f.name) && sql) scripts.push({ name: f.source, sql });
    else skipped.push(f.source);
  }
  return { scripts, skipped };
}

/** A compose file published as Render's one free web service: its app service, and its PostgreSQL ones. */
function composeSpec(files: ReadonlyMap<string, Buffer>, recipe: string): PublishSpec {
  const plan = previewPlan(files, recipe);
  const apps = plan.services.filter((s) => !(s.image && POSTGRES.test(s.image)) || s.build);
  const main = apps.find((s) => s.name === plan.main) ?? apps[0];
  if (!main) throw new HttpError(400, t().publish.onlyDatabase);
  for (const s of apps) if (s !== main) throw new HttpError(400, t().publish.composeService(s.name));
  if (!main.build) throw new HttpError(400, t().publish.composeBuild(main.name));
  if (main.build.inline || main.build.target || Object.keys(main.build.args).length)
    throw new HttpError(400, t().publish.composeBuildOptions(main.name));
  if (main.mounts.length) throw new HttpError(400, t().publish.composeMounts(main.name));
  if (main.entrypoint) throw new HttpError(400, t().publish.composeEntrypoint(main.name));
  const context = main.build.context;
  const dockerfile = posix.join(context || '.', main.build.dockerfile);
  const env: PublishEnvVar[] = Object.entries(main.environment).map(([key, value]) => ({ key, value, source: 'compose' }));
  if (main.ports.length && !env.some((e) => e.key === 'PORT')) env.push({ key: 'PORT', value: String(main.ports[0]), source: 'compose' });
  const databases: DatabaseSpec[] = plan.services
    .filter((s) => s !== main && s.image && POSTGRES.test(s.image))
    .map((s) => {
      const user = s.environment.POSTGRES_USER || 'postgres';
      const db = s.environment.POSTGRES_DB || user;
      const { scripts, skipped } = initScripts(s, files);
      return {
        service: s.name,
        database: neonName(db) ?? 'neondb',
        role: neonName(user) ?? 'neondb_owner',
        ...(pgVersion(s.image!) ? { pgVersion: pgVersion(s.image!) } : {}),
        initScripts: scripts.map((x) => x.name),
        skippedScripts: skipped,
        image: s.image,
        composeUser: user,
        composePassword: s.environment.POSTGRES_PASSWORD || undefined,
        composeDatabase: db,
        scripts,
      };
    });
  const command = main.command ? shownCommand(main.command) : undefined;
  return {
    kind: 'compose',
    serviceType: 'web_service',
    details: {
      runtime: 'docker',
      envSpecificDetails: {
        dockerfilePath: './' + dockerfile,
        dockerContext: './' + (context || ''),
        ...(command ? { dockerCommand: command } : {}),
      },
    },
    commands: { dockerfile, ...(command ? { start: command } : {}) },
    env,
    databases,
    databaseOptional: false,
  };
}

/**
 * What a preview publishes as on Render, from its files alone: the same steps its preview ran (npm's
 * install and build or start, the Dockerfile, the compose file's app service), on Render's machines.
 * Throws an HttpError (400) with the reason when Render's free plan cannot run it as one service.
 */
export function publishSpec(source: PublishSource): PublishSpec {
  const node = { key: 'NODE_VERSION', value: PREVIEW_NODE_MAJOR, source: 'compose' as const };
  if (source.mode === 'static') {
    return {
      kind: 'static',
      serviceType: 'static_site',
      details: { publishPath: '.' },
      commands: { publish: '.' },
      env: [],
      databases: [],
      databaseOptional: false,
      ...(/^index\.html?$/i.test(source.entry) ? {} : { path: source.entry }),
    };
  }
  if (source.mode === 'build') {
    const ws = workspaceFlag(source.workspace);
    const publish = (source.workspace ? source.workspace + '/' : '') + 'dist';
    const build = `npm ci --include=dev${ws ? ws + ' --include-workspace-root' : ''} && npm run build${ws}`;
    return {
      kind: 'build',
      serviceType: 'static_site',
      details: { buildCommand: build, publishPath: publish },
      commands: { build, publish },
      env: [node],
      databases: [],
      databaseOptional: false,
    };
  }
  if (source.mode === 'server') {
    const ws = workspaceFlag(source.workspace);
    const build = `npm ci --include=dev${ws ? ws + ' --include-workspace-root' : ''}`;
    const start = 'npm start' + ws;
    return {
      kind: 'server',
      serviceType: 'web_service',
      details: { runtime: 'node', envSpecificDetails: { buildCommand: build, startCommand: start } },
      commands: { build, start },
      env: [node],
      databases: [],
      databaseOptional: true,
    };
  }
  if (COMPOSE_NAMES.includes(source.entry)) return composeSpec(source.files, source.entry);
  if (source.entry !== 'Dockerfile' || !source.files.has('Dockerfile')) throw new HttpError(400, t().previewTarget);
  return {
    kind: 'docker',
    serviceType: 'web_service',
    details: { runtime: 'docker', envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.' } },
    commands: { dockerfile: 'Dockerfile' },
    env: [],
    databases: [],
    databaseOptional: true,
  };
}

/** The database the checkbox adds to a backend or Dockerfile: Neon's own names, `DATABASE_URL`. */
export function optionalDatabase(): DatabaseSpec {
  return { service: 'DATABASE_URL', database: 'neondb', role: 'neondb_owner', initScripts: [], skippedScripts: [], scripts: [] };
}

/** A variable's name, as Render and a shell take it. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_ENV = 100;
const MAX_ENV_VALUE = 32 * 1024;

/** The variables the user gave in the dialog, checked. */
export function userEnv(input: unknown): { key: string; value: string }[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_ENV) throw new HttpError(400, t().invalidField('env'));
  const seen = new Set<string>();
  return input.map((item) => {
    const key = (item as { key?: unknown })?.key;
    const value = (item as { value?: unknown })?.value;
    if (
      typeof key !== 'string' ||
      !ENV_KEY.test(key) ||
      seen.has(key) ||
      typeof value !== 'string' ||
      value.length > MAX_ENV_VALUE ||
      value.includes('\0')
    )
      throw new HttpError(400, t().invalidField('env'));
    seen.add(key);
    return { key, value };
  });
}

/** Whether a value is a PostgreSQL URL for the compose service `host`. */
function urlFor(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    return /^postgres(?:ql)?:$/.test(url.protocol) && url.hostname === host;
  } catch {
    return false;
  }
}

/**
 * The variables the app gets once its databases are made: the spec's, Neon's values in place of the
 * compose file's (a `postgres://` URL to the service, its name as a host, its user, password and
 * database), `DATABASE_URL` for a database nothing names, then the user's over them all.
 */
export function databaseEnv(
  env: PublishEnvVar[],
  databases: { spec: DatabaseSpec; neon: NeonDatabase }[],
  user: { key: string; value: string }[],
): PublishEnvVar[] {
  const out = env.map((e) => ({ ...e }));
  for (const [i, { spec, neon }] of databases.entries()) {
    let named = false;
    let hostVar = false;
    for (const e of out) {
      if (e.source !== 'compose') continue;
      if (urlFor(e.value, spec.service)) {
        e.value = neon.uri;
        e.source = 'database';
        named = true;
      } else if (e.value === spec.service && /HOST/i.test(e.key)) {
        e.value = neon.host;
        e.source = 'database';
        named = hostVar = true;
      } else if (spec.composePassword && e.value === spec.composePassword && /PASS/i.test(e.key)) {
        e.value = neon.password;
        e.source = 'database';
      } else if (spec.composeUser && e.value === spec.composeUser && /USER/i.test(e.key)) {
        e.value = neon.role;
        e.source = 'database';
      } else if (spec.composeDatabase && e.value === spec.composeDatabase && /(?:DB|DATABASE|NAME)/i.test(e.key) && !/URL/i.test(e.key)) {
        e.value = neon.database;
        e.source = 'database';
      }
    }
    // Neon takes TLS only: libpq and node-postgres read this beside separate host variables.
    if (hostVar && !out.some((e) => e.key === 'PGSSLMODE')) out.push({ key: 'PGSSLMODE', value: 'require', source: 'database' });
    if (!named && i === 0 && !out.some((e) => e.key === 'DATABASE_URL'))
      out.push({ key: 'DATABASE_URL', value: neon.uri, source: 'database' });
  }
  for (const u of user) {
    const found = out.find((e) => e.key === u.key);
    if (found?.source === 'database') continue;
    if (found) {
      found.value = u.value;
      found.source = 'user';
    } else out.push({ ...u, source: 'user' });
  }
  return out;
}
