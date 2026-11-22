/**
 * A container preview's plan: the services a project's compose file (or its one Dockerfile) asks
 * for, kept to what an app needs, and the compose model Relay runs instead of the file itself.
 * Pure: the snapshot's file names in, a plan and a model out. Nothing here reads the host.
 *
 * The file is never handed to `docker compose` as it is. Relay reads it, interpolates it with an
 * empty environment, keeps the keys an app needs, rewrites what would reach the host (ports, bind
 * mounts, networks, named volumes) and refuses the rest, naming the key.
 */
import { posix } from 'node:path';
import { parse } from 'yaml';
import { PREVIEW_RECIPES } from '../shared/types';
import { t } from './i18n';

/** The forwarder's service: it owns the main service's network namespace and carries HTTP to it. */
export const FORWARDER = 'relay-forward';
export const COMPOSE_NAMES: readonly string[] = PREVIEW_RECIPES.filter((name) => name !== 'Dockerfile');
export const MAX_SERVICES = 8;
const MAX_COMPOSE_BYTES = 256 * 1024;
const DEFAULT_PORT = 4173;

/** Each service's limits. The first three are what the npm path verifies too, scaled for any language. */
export const SERVICE_LIMITS = { memory: '1g', memoryBytes: 1024 * 1024 * 1024, cpus: 1, pids: 256, nofile: 4096 };
/**
 * Root in an image keeps only what official images (postgres, nginx, redis…) need to hand their
 * files to their own user and switch to it. No network administration, raw sockets, devices or mounts.
 */
export const SERVICE_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];

export interface PreviewBuild {
  /** The build context: a folder of the snapshot ('' for its root). */
  context: string;
  /** The Dockerfile's path inside the context. */
  dockerfile: string;
  /** `dockerfile_inline`: the Dockerfile's text, written into the context for the build. */
  inline?: string;
  args: Record<string, string>;
  target?: string;
}

/** A project file or folder a service bind-mounted: copied into its container before it starts. */
export interface PreviewMount {
  /** A snapshot path: a file, or a folder whose files are all copied. */
  source: string;
  target: string;
  folder: boolean;
}

export type PreviewVolume = { type: 'volume'; source?: string; target: string; readOnly: boolean } | { type: 'tmpfs'; target: string };

export interface PreviewService {
  name: string;
  image?: string;
  build?: PreviewBuild;
  command?: string[];
  entrypoint?: string[];
  environment: Record<string, string>;
  dependsOn: Record<string, { condition: string }>;
  healthcheck?: Record<string, unknown>;
  workingDir?: string;
  user?: string;
  hostname?: string;
  platform?: string;
  init?: boolean;
  stopSignal?: string;
  tty: boolean;
  stdinOpen: boolean;
  volumes: PreviewVolume[];
  mounts: PreviewMount[];
  /** Container ports from `ports` (their container side) and `expose`, in order. */
  ports: number[];
}

export interface PreviewPlan {
  services: PreviewService[];
  /** The service the panel shows: its page when it serves one, and its terminal. */
  main: string;
  /** Named volumes, each the preview's own. */
  volumes: string[];
  /** What Relay left out, said in the terminal before the build. */
  notes: string[];
}

function refuse(message: string): never {
  throw new Error(message);
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

// --- Interpolation, as compose does it, with nothing in the environment -----------------------

/**
 * `${VAR}` and `$VAR` are empty, `${VAR:-default}` and `${VAR-default}` their default (itself
 * interpolated), `${VAR:+alt}` and `${VAR+alt}` empty, `${VAR:?message}` and `${VAR?message}` an
 * error, and `$$` a `$`. No variable comes from the host or a `.env` file.
 */
export function interpolate(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '$') {
      out += c;
      continue;
    }
    const next = text[i + 1];
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      if (depth) refuse(t().previewCompose.interpolation(text.slice(i, i + 40)));
      const inner = text.slice(i + 2, j - 1);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([\s\S]*))?$/.exec(inner);
      if (!m) refuse(t().previewCompose.interpolation(text.slice(i, j)));
      const [, variable, op, rest] = m;
      if (op === ':-' || op === '-') out += interpolate(rest ?? '');
      else if (op === ':?' || op === '?') refuse(t().previewCompose.required(variable!, rest ?? ''));
      i = j - 1;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
      if (m) i += m[0].length;
      else out += '$';
    }
  }
  return out;
}

function interpolateAll(value: unknown): unknown {
  if (typeof value === 'string') return interpolate(value);
  if (Array.isArray(value)) return value.map(interpolateAll);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key.startsWith('x-') ? v : interpolateAll(v)]));
  }
  return value;
}

// --- Small readers ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function isMap(value: unknown): value is Doc {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return refuse(t().previewCompose.invalid(where));
}

/** A command or entrypoint: a list as it is, a string split as a shell would, without running one. */
export function commandWords(value: unknown, where: string): string[] {
  if (Array.isArray(value)) return value.map((word) => scalar(word, where));
  const text = scalar(value, where);
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < text.length) {
      word = (word ?? '') + text[++i];
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (quote) refuse(t().previewCompose.invalid(where));
  if (word !== undefined) words.push(word);
  return words;
}

/** `KEY=value` lists and maps alike. A key without a value would come from the host: left out. */
function keyValues(value: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === undefined || value === null) return out;
  const add = (key: string, v: unknown) => {
    if (!/^[^\s=]{1,256}$/.test(key)) refuse(t().previewCompose.invalid(where));
    if (v === null || v === undefined) return;
    out[key] = scalar(v, where);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = scalar(item, where);
      const at = text.indexOf('=');
      if (at < 0) continue;
      add(text.slice(0, at), text.slice(at + 1));
    }
  } else if (isMap(value)) {
    for (const [key, v] of Object.entries(value)) add(key, v);
  } else {
    refuse(t().previewCompose.invalid(where));
  }
  return out;
}

/** A path relative to the compose file's folder, kept inside the snapshot. */
function projectPath(raw: string, where: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(?:git@|github\.com\/)/i.test(raw)) refuse(t().previewCompose.remote(where));
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:[\\/]/i.test(raw) || raw.startsWith('\\'))
    refuse(t().previewCompose.outside(where, raw));
  const path = posix.normalize(raw.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (path === '..' || path.startsWith('../')) refuse(t().previewCompose.outside(where, raw));
  return path === '.' ? '' : path;
}

function containerPath(raw: unknown, where: string): string {
  const path = scalar(raw, where);
  if (!path.startsWith('/') || path.length > 1024 || /[\0\r\n]/.test(path)) refuse(t().previewCompose.invalid(where));
  return path;
}

/** The container side of a `ports` entry, or of an `expose` one. UDP ports serve no page. */
function containerPort(raw: unknown, where: string): number | undefined {
  if (isMap(raw)) {
    if (raw.protocol !== undefined && String(raw.protocol).toLowerCase() !== 'tcp') return;
    return port(raw.target, where);
  }
  const text = scalar(raw, where);
  const [spec, protocol] = text.split('/');
  if (protocol && protocol.toLowerCase() !== 'tcp') return;
  const side = spec!.split(':').at(-1)!;
  return port(side.split('-')[0], where);
}

function port(raw: unknown, where: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) refuse(t().previewCompose.invalid(where));
  return n;
}

// --- Keys ------------------------------------------------------------------------------------

/** What a service may say, read below. */
const SERVICE_KEYS = new Set([
  'image',
  'build',
  'command',
  'entrypoint',
  'environment',
  'depends_on',
  'healthcheck',
  'working_dir',
  'user',
  'hostname',
  'platform',
  'init',
  'stop_signal',
  'tty',
  'stdin_open',
  'volumes',
  'tmpfs',
  'ports',
  'expose',
]);
/** What a service may say that Relay sets itself or does not need: left out. */
const DROPPED = new Set([
  'container_name',
  'restart',
  'networks',
  'links',
  'logging',
  'deploy',
  'labels',
  'cap_drop',
  'ulimits',
  'mem_limit',
  'memswap_limit',
  'mem_reservation',
  'mem_swappiness',
  'cpus',
  'cpu_count',
  'cpu_percent',
  'cpu_shares',
  'cpu_quota',
  'cpu_period',
  'cpu_rt_runtime',
  'cpu_rt_period',
  'cpuset',
  'pids_limit',
  'oom_kill_disable',
  'oom_score_adj',
  'shm_size',
  'stop_grace_period',
  'dns',
  'dns_opt',
  'dns_search',
  'extra_hosts',
  'mac_address',
  'domainname',
  'develop',
  'pull_policy',
  'scale',
  'attach',
  'annotations',
  'security_opt',
  'sysctls',
  'group_add',
  'storage_opt',
  'blkio_config',
  'cgroup',
  'read_only',
  'post_start',
  'pre_stop',
]);
/** What would reach the host or other containers. */
const REFUSED = new Set([
  'privileged',
  'cap_add',
  'devices',
  'device_cgroup_rules',
  'volumes_from',
  'external_links',
  'secrets',
  'configs',
  'extends',
  'isolation',
  'runtime',
  'gpus',
  'credential_spec',
  'label_file',
  'models',
  'provider',
  'use_api_socket',
  'cgroup_parent',
]);
/** Namespaces: their own (or left out) is fine, the host's or another container's is not. */
const NAMESPACES = new Set(['network_mode', 'pid', 'ipc', 'uts', 'userns_mode']);

const BUILD_KEYS = new Set(['context', 'dockerfile', 'dockerfile_inline', 'args', 'target']);
const BUILD_DROPPED = new Set([
  'labels',
  'cache_from',
  'cache_to',
  'no_cache',
  'pull',
  'platforms',
  'tags',
  'shm_size',
  'extra_hosts',
  'ulimits',
]);

function readBuild(raw: unknown, service: string, has: (path: string) => boolean): PreviewBuild {
  const where = `${service}.build`;
  const spec = typeof raw === 'string' ? { context: raw } : isMap(raw) ? raw : refuse(t().previewCompose.invalid(where));
  for (const key of Object.keys(spec)) {
    if (key.startsWith('x-') || BUILD_KEYS.has(key) || BUILD_DROPPED.has(key)) continue;
    if (key === 'network' && ['default', 'none'].includes(String(spec[key]))) continue;
    refuse(t().previewCompose.refused(`${where}.${key}`));
  }
  const context = projectPath(spec.context === undefined ? '.' : scalar(spec.context, where + '.context'), where + '.context');
  const inline = spec.dockerfile_inline === undefined ? undefined : scalar(spec.dockerfile_inline, where + '.dockerfile_inline');
  const named = spec.dockerfile === undefined ? 'Dockerfile' : scalar(spec.dockerfile, where + '.dockerfile');
  const dockerfile = inline === undefined ? projectPath(named, where + '.dockerfile') : '.relay.Dockerfile';
  if (!dockerfile) refuse(t().previewCompose.invalid(where + '.dockerfile'));
  if (inline === undefined && !has(posix.join(context, dockerfile)))
    refuse(t().previewCompose.missingFile(posix.join(context, dockerfile)));
  return {
    context,
    dockerfile,
    ...(inline !== undefined ? { inline } : {}),
    args: keyValues(spec.args, where + '.args'),
    ...(spec.target !== undefined ? { target: scalar(spec.target, where + '.target') } : {}),
  };
}

function readVolumes(
  raw: unknown,
  service: string,
  declared: Set<string>,
  has: (path: string) => boolean,
  isFolder: (path: string) => boolean,
  notes: string[],
): { volumes: PreviewVolume[]; mounts: PreviewMount[] } {
  const where = `${service}.volumes`;
  const volumes: PreviewVolume[] = [];
  const mounts: PreviewMount[] = [];
  if (raw === undefined || raw === null) return { volumes, mounts };
  if (!Array.isArray(raw)) refuse(t().previewCompose.invalid(where));
  for (const item of raw) {
    let type: string;
    let source: string | undefined;
    let target: string;
    let readOnly = false;
    if (typeof item === 'string') {
      const parts = item.split(':');
      // A Windows drive letter's colon is not a separator. Such a path is refused below anyway.
      if (/^[a-z]$/i.test(parts[0] ?? '') && parts.length > 2) parts.splice(0, 2, parts[0] + ':' + parts[1]);
      if (parts.length === 1) {
        type = 'volume';
        target = containerPath(parts[0], where);
      } else {
        source = parts[0]!;
        target = containerPath(parts[1], where);
        readOnly = (parts[2] ?? '').split(',').includes('ro');
        type = /^[.~/\\]|^[a-z]:/i.test(source) ? 'bind' : 'volume';
      }
    } else if (isMap(item)) {
      for (const key of Object.keys(item)) {
        if (!['type', 'source', 'target', 'read_only', 'volume', 'bind', 'tmpfs', 'consistency'].includes(key))
          refuse(t().previewCompose.refused(`${where}.${key}`));
      }
      type = scalar(item.type ?? 'volume', where);
      source = item.source === undefined || item.source === null ? undefined : scalar(item.source, where);
      target = containerPath(item.target, where);
      readOnly = item.read_only === true;
      if (isMap(item.volume) && item.volume.subpath !== undefined) refuse(t().previewCompose.refused(`${where}.volume.subpath`));
    } else {
      return refuse(t().previewCompose.invalid(where));
    }
    if (type === 'tmpfs') {
      volumes.push({ type: 'tmpfs', target });
    } else if (type === 'volume') {
      if (source !== undefined && !declared.has(source)) refuse(t().previewCompose.undeclaredVolume(service, source));
      volumes.push({ type: 'volume', ...(source !== undefined ? { source } : {}), target, readOnly });
    } else if (type === 'bind') {
      if (source === undefined) refuse(t().previewCompose.invalid(where));
      const path = projectPath(source, where);
      const folder = isFolder(path);
      if (!folder && !has(path)) {
        notes.push(t().previewCompose.mountSkipped(service, source, target));
        continue;
      }
      mounts.push({ source: path, target, folder });
    } else {
      refuse(t().previewCompose.refused(`${where}.type: ${type}`));
    }
  }
  return { volumes, mounts };
}

function readService(
  name: string,
  raw: unknown,
  declared: Set<string>,
  has: (path: string) => boolean,
  isFolder: (path: string) => boolean,
  notes: string[],
): PreviewService | undefined {
  if (!NAME.test(name) || name === FORWARDER) refuse(t().previewCompose.serviceName(name));
  if (!isMap(raw)) return refuse(t().previewCompose.invalid(name));
  if (raw.profiles !== undefined) {
    // Compose leaves a service with profiles out unless one is chosen. So does the preview.
    notes.push(t().previewCompose.profileSkipped(name));
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('x-') || SERVICE_KEYS.has(key) || DROPPED.has(key)) continue;
    if (key === 'env_file') {
      notes.push(t().previewCompose.envFileSkipped(name));
      continue;
    }
    if (NAMESPACES.has(key)) {
      const v = String(value);
      if (v === 'host' || /^(?:container|service):/.test(v)) refuse(t().previewCompose.refused(`${name}.${key}: ${v}`));
      continue;
    }
    refuse(t().previewCompose.refused(`${name}.${key}`));
  }
  const build = raw.build === undefined ? undefined : readBuild(raw.build, name, has);
  const image = raw.image === undefined ? undefined : scalar(raw.image, name + '.image');
  if (image !== undefined && !/^[^\s]{1,255}$/.test(image)) refuse(t().previewCompose.invalid(name + '.image'));
  if (!build && !image) refuse(t().previewCompose.noImage(name));
  const dependsOn: Record<string, { condition: string }> = {};
  if (Array.isArray(raw.depends_on)) {
    for (const dep of raw.depends_on) dependsOn[scalar(dep, name + '.depends_on')] = { condition: 'service_started' };
  } else if (isMap(raw.depends_on)) {
    for (const [dep, spec] of Object.entries(raw.depends_on)) {
      const condition = isMap(spec) && spec.condition !== undefined ? scalar(spec.condition, name + '.depends_on') : 'service_started';
      if (!['service_started', 'service_healthy', 'service_completed_successfully'].includes(condition))
        refuse(t().previewCompose.invalid(name + '.depends_on'));
      dependsOn[dep] = { condition };
    }
  } else if (raw.depends_on !== undefined) {
    refuse(t().previewCompose.invalid(name + '.depends_on'));
  }
  let healthcheck: Record<string, unknown> | undefined;
  if (raw.healthcheck !== undefined) {
    if (!isMap(raw.healthcheck)) refuse(t().previewCompose.invalid(name + '.healthcheck'));
    healthcheck = {};
    for (const [key, value] of Object.entries(raw.healthcheck)) {
      if (!['test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable'].includes(key))
        refuse(t().previewCompose.refused(`${name}.healthcheck.${key}`));
      healthcheck[key] = key === 'test' && typeof value !== 'string' ? commandWords(value, name + '.healthcheck.test') : value;
    }
  }
  const ports: number[] = [];
  for (const field of ['ports', 'expose'] as const) {
    const list = raw[field];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) refuse(t().previewCompose.invalid(`${name}.${field}`));
    for (const item of list) {
      const p = containerPort(item, `${name}.${field}`);
      if (p !== undefined && !ports.includes(p)) ports.push(p);
    }
  }
  const { volumes, mounts } = readVolumes(raw.volumes, name, declared, has, isFolder, notes);
  if (raw.tmpfs !== undefined) {
    for (const item of Array.isArray(raw.tmpfs) ? raw.tmpfs : [raw.tmpfs]) {
      volumes.push({ type: 'tmpfs', target: containerPath(scalar(item, name + '.tmpfs').split(':')[0], name + '.tmpfs') });
    }
  }
  const text = (key: string) => (raw[key] === undefined || raw[key] === null ? undefined : scalar(raw[key], `${name}.${key}`));
  const flag = (key: string) => raw[key] === true || raw[key] === 'true';
  return {
    name,
    ...(image !== undefined ? { image } : {}),
    ...(build ? { build } : {}),
    ...(raw.command !== undefined && raw.command !== null ? { command: commandWords(raw.command, name + '.command') } : {}),
    ...(raw.entrypoint !== undefined && raw.entrypoint !== null ? { entrypoint: commandWords(raw.entrypoint, name + '.entrypoint') } : {}),
    environment: keyValues(raw.environment, name + '.environment'),
    dependsOn,
    ...(healthcheck ? { healthcheck } : {}),
    ...(text('working_dir') !== undefined ? { workingDir: text('working_dir') } : {}),
    ...(text('user') !== undefined ? { user: text('user') } : {}),
    ...(text('hostname') !== undefined ? { hostname: text('hostname') } : {}),
    ...(text('platform') !== undefined ? { platform: text('platform') } : {}),
    ...(raw.init !== undefined ? { init: flag('init') } : {}),
    ...(text('stop_signal') !== undefined ? { stopSignal: text('stop_signal') } : {}),
    tty: flag('tty'),
    stdinOpen: flag('stdin_open'),
    volumes,
    mounts,
    ports,
  };
}

/**
 * Images that serve a database or a broker, not a page, even when the file publishes their port:
 * the name, then only a suffix that is still the database itself (never a web UI's: mongo-express,
 * redis-commander, kafka-ui, opensearch-dashboards). Brokers and stores whose image serves a web
 * console (RabbitMQ's management, MinIO, Neo4j) are left out on purpose: their page is worth showing.
 */
const BACKING =
  /^(?:[^/]+\/)*(?:postgres|postgresql|postgis|mysql|mariadb|redis|valkey|mongo|mongodb|memcached|elasticsearch|opensearch|cassandra|zookeeper|kafka|nats|clickhouse|cockroach|cockroachdb|influxdb|timescaledb)(?:-(?:server|stack(?:-server)?|ha|alpine|oss|community|enterprise))?(?:[:@]|$)/i;

/** Whether an image serves a database or a broker rather than a page. */
export function isBacking(image: string): boolean {
  return BACKING.test(image);
}

/**
 * The service the panel shows: among those that publish a port, one built here, then one that is
 * not a database's image; else one meant for a terminal, then one built here, then the first.
 */
export function mainService(services: PreviewService[]): string {
  const serving = services.filter((s) => s.ports.length);
  const pick =
    serving.find((s) => s.build) ??
    serving.find((s) => !s.image || !isBacking(s.image)) ??
    services.find((s) => s.tty || s.stdinOpen) ??
    services.find((s) => s.build) ??
    serving[0] ??
    services[0]!;
  return pick.name;
}

/**
 * The plan for a compose file at `file` (its folder is the snapshot's root). `has` says whether the
 * snapshot holds a file, `isFolder` whether it holds files under a folder.
 */
export function planCompose(text: string, has: (path: string) => boolean, isFolder: (path: string) => boolean): PreviewPlan {
  if (Buffer.byteLength(text) > MAX_COMPOSE_BYTES) refuse(t().previewCompose.tooLarge);
  let doc: unknown;
  try {
    doc = parse(text, { merge: true, maxAliasCount: 100, uniqueKeys: true, prettyErrors: false });
  } catch (error) {
    return refuse(t().previewCompose.yaml((error as Error).message.split('\n')[0]!.slice(0, 200)));
  }
  if (!isMap(doc)) return refuse(t().previewCompose.noServices);
  doc = interpolateAll(doc) as Doc;
  const top = doc as Doc;
  for (const key of Object.keys(top)) {
    if (key.startsWith('x-') || ['services', 'volumes', 'networks', 'name', 'version', 'secrets', 'configs'].includes(key)) continue;
    refuse(t().previewCompose.refused(key));
  }
  if (!isMap(top.services) || !Object.keys(top.services).length) refuse(t().previewCompose.noServices);
  const declared = new Set<string>();
  if (top.volumes !== undefined && top.volumes !== null) {
    if (!isMap(top.volumes)) refuse(t().previewCompose.invalid('volumes'));
    for (const [name, spec] of Object.entries(top.volumes)) {
      if (!NAME.test(name)) refuse(t().previewCompose.invalid('volumes.' + name));
      if (spec !== null && spec !== undefined) {
        if (!isMap(spec)) refuse(t().previewCompose.invalid('volumes.' + name));
        for (const key of Object.keys(spec)) {
          if (key === 'labels' || key.startsWith('x-')) continue;
          if (key === 'driver' && spec.driver === 'local') continue;
          refuse(t().previewCompose.refused(`volumes.${name}.${key}`));
        }
      }
      declared.add(name);
    }
  }
  const notes: string[] = [];
  const services: PreviewService[] = [];
  for (const [name, raw] of Object.entries(top.services)) {
    const service = readService(name, raw, declared, has, isFolder, notes);
    if (service) services.push(service);
  }
  if (!services.length) refuse(t().previewCompose.noServices);
  if (services.length > MAX_SERVICES) refuse(t().previewCompose.tooMany(MAX_SERVICES));
  const names = new Set(services.map((s) => s.name));
  for (const s of services) {
    for (const dep of Object.keys(s.dependsOn)) if (!names.has(dep)) refuse(t().previewCompose.unknownDependency(s.name, dep));
  }
  const used = new Set(services.flatMap((s) => s.volumes.flatMap((v) => (v.type === 'volume' && v.source ? [v.source] : []))));
  return { services, main: mainService(services), volumes: [...declared].filter((v) => used.has(v)), notes };
}

/** A project with one Dockerfile at the snapshot's root: one service built from it. */
export function planDockerfile(dockerfile = 'Dockerfile'): PreviewPlan {
  return {
    services: [
      {
        name: 'app',
        build: { context: '', dockerfile, args: {} },
        environment: {},
        dependsOn: {},
        tty: true,
        stdinOpen: true,
        volumes: [],
        mounts: [],
        ports: [],
      },
    ],
    main: 'app',
    volumes: [],
    notes: [],
  };
}

/** The port the forwarder reaches the main service on: the file's, else the image's one EXPOSE, else PORT. */
export function previewPort(plan: PreviewPlan, exposed: readonly number[] = []): { port: number; setPort: boolean } {
  const main = plan.services.find((s) => s.name === plan.main)!;
  if (main.ports.length) return { port: main.ports[0]!, setPort: false };
  if (exposed.length === 1) return { port: exposed[0]!, setPort: true };
  return { port: DEFAULT_PORT, setPort: true };
}

// --- The model Relay runs ---------------------------------------------------------------------

/** Compose interpolates `$` in every string of the model it reads. Every one here is already final. */
function literal(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$/g, '$$$$');
  if (Array.isArray(value)) return value.map(literal);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, literal(v)]));
  return value;
}

export interface ModelOptions {
  project: string;
  labels: Record<string, string>;
  /** Each service's image: the one built for it (with its mounts), or its own `image`. */
  images: ReadonlyMap<string, string>;
  forwarderImage: string;
  port: number;
  setPort: boolean;
  /** Run the main service with this command line instead of its own. */
  command?: string[];
}

function hardened(labels: Record<string, string>) {
  return {
    labels,
    restart: 'no',
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: SERVICE_LIMITS.memory,
    memswap_limit: SERVICE_LIMITS.memory,
    cpus: SERVICE_LIMITS.cpus,
    pids_limit: SERVICE_LIMITS.pids,
    shm_size: '64m',
    ulimits: { nofile: { soft: SERVICE_LIMITS.nofile, hard: SERVICE_LIMITS.nofile }, core: { soft: 0, hard: 0 } },
    stop_grace_period: '2s',
    // The terminal's history for an attach that comes after the start, bounded.
    logging: { driver: 'local', options: { 'max-size': '1m', 'max-file': '1', compress: 'false' } },
  };
}

export function composeModel(plan: PreviewPlan, o: ModelOptions): Record<string, unknown> {
  const shared = plan.services.length > 1;
  const services: Record<string, unknown> = {
    [FORWARDER]: {
      ...hardened(o.labels),
      image: o.forwarderImage,
      entrypoint: ['/bin/sleep'],
      command: ['7200'],
      user: '1000:1000',
      read_only: true,
      cap_add: [],
      // The main service shares this namespace. It may bind a port below 1024 as any user.
      sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0' },
      ...(shared ? { networks: { relay: { aliases: [plan.main] } } } : { network_mode: 'none' }),
    },
  };
  for (const s of plan.services) {
    const main = s.name === plan.main;
    const command = main && o.command?.length ? o.command : undefined;
    services[s.name] = {
      ...hardened(o.labels),
      image: o.images.get(s.name) ?? s.image,
      pull_policy: o.images.has(s.name) ? 'never' : 'missing',
      cap_add: SERVICE_CAPS,
      ...(command ? { entrypoint: [command[0]], command: command.slice(1) } : {}),
      ...(!command && s.entrypoint ? { entrypoint: s.entrypoint } : {}),
      ...(!command && s.command ? { command: s.command } : {}),
      environment: main && o.setPort && s.environment.PORT === undefined ? { ...s.environment, PORT: String(o.port) } : s.environment,
      ...(Object.keys(s.dependsOn).length ? { depends_on: s.dependsOn } : {}),
      ...(s.healthcheck ? { healthcheck: s.healthcheck } : {}),
      ...(s.workingDir !== undefined ? { working_dir: s.workingDir } : {}),
      ...(s.user !== undefined ? { user: s.user } : {}),
      ...(s.hostname !== undefined && !main ? { hostname: s.hostname } : {}),
      ...(s.platform !== undefined ? { platform: s.platform } : {}),
      ...(s.init !== undefined ? { init: s.init } : {}),
      ...(s.stopSignal !== undefined ? { stop_signal: s.stopSignal } : {}),
      tty: main || s.tty,
      stdin_open: main || s.stdinOpen,
      volumes: s.volumes.map((v) =>
        v.type === 'tmpfs'
          ? { type: 'tmpfs', target: v.target, tmpfs: { size: 64 * 1024 * 1024 } }
          : { type: 'volume', ...(v.source ? { source: v.source } : {}), target: v.target, read_only: v.readOnly },
      ),
      ...(main ? { network_mode: `service:${FORWARDER}` } : shared ? { networks: ['relay'] } : { network_mode: 'none' }),
    };
  }
  return literal({
    name: o.project,
    services,
    // Internal, and without even a gateway: an internal bridge still has an address on the host's
    // side, where any service of the host listening on every address would answer.
    ...(shared
      ? { networks: { relay: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' }, labels: o.labels } } }
      : {}),
    ...(plan.volumes.length ? { volumes: Object.fromEntries(plan.volumes.map((v) => [v, { labels: o.labels }])) } : {}),
  }) as Record<string, unknown>;
}
