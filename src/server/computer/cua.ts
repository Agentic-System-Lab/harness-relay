import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { portableInstallEnv } from '../portableInstall';
import { dockerSearchPath } from '../previewDocker';
import { runProcess, tail, type SpawnResult } from '../process';

/*
 * Running `cua` for the computer tools: with Cua's own home (`~/.cua`, or the server's `CUA_HOME`: its
 * computers, images and their tokens, kept from the agents below full access by `protectedReads()`), its
 * telemetry off, and an environment of the server's that keeps only what it needs to find a container engine
 * (Docker's or Podman's settings, the system's folders, proxies), never a model key or a cloud's.
 *
 * Not a folder of Harness Relay's data folder: Cua's own Linux VM (macOS, Windows) keeps a socket in its
 * home, whose path must stay under 104 bytes, which a data folder deep in a checkout would not.
 */

/** Cua's home: what `cua` keeps of its computers (`CUA_HOME`, else `~/.cua`). */
export function cuaHome(source: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return source.CUA_HOME?.trim() || join(home, '.cua');
}

/**
 * Where Linux computers run (`CUA_RUNTIME_LINUX`): on macOS and Windows, Cua's own Linux VM (a small VM with
 * Docker and gVisor, or on Windows a WSL distribution of its own), apart from the user's Docker; on Linux,
 * the container engine there. The server's own setting wins.
 */
export function linuxRuntime(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (source.CUA_RUNTIME_LINUX?.trim()) return source.CUA_RUNTIME_LINUX.trim();
  return platform === 'darwin' || platform === 'win32' ? 'builtin' : undefined;
}

/** What `cua` is given of the server's environment, with its telemetry off. */
export function cuaEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  search = dockerSearchPath(source),
): NodeJS.ProcessEnv {
  const env = portableInstallEnv(source);
  for (const [key, value] of Object.entries(source))
    if (
      /^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|CONTAINER_HOST|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|USER|LOGNAME|USERNAME|COMPUTERNAME|LC_ALL|LC_CTYPE|TZ)$/i.test(
        key,
      )
    )
      env[key] = value;
  env.PATH = search;
  env.CUA_HOME = cuaHome(source, source.HOME || source.USERPROFILE || homedir());
  const runtime = linuxRuntime(source, platform);
  if (runtime) env.CUA_RUNTIME_LINUX = runtime;
  // Cua's telemetry is on unless one of these says otherwise (https://cua.ai/docs/cua-sdk/concepts/telemetry).
  env.DO_NOT_TRACK = '1';
  env.CUA_TELEMETRY = '0';
  return env;
}

/** `cua` said it could not: its words (the end of what it wrote), and its exit code. */
export class CuaError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/** The JSON value `cua --json` printed: its last line that is one (progress may come before it). */
export function lastJson(stdout: string): unknown {
  const whole = stdout.trim();
  try {
    return JSON.parse(whole);
  } catch {
    // Several lines: the last one that is a JSON value.
  }
  const lines = whole.split(/\r?\n/).reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) continue;
    try {
      return JSON.parse(text);
    } catch {
      // not JSON
    }
  }
  return undefined;
}

/** Why a run of `cua` failed, in a line or a few: its error output's end (or its output's), without colours. */
export function cuaFailure(r: Pick<SpawnResult, 'stdout' | 'stderr' | 'code' | 'timedOut' | 'aborted'>, what: string): string {
  if (r.aborted) return what + ': stopped';
  if (r.timedOut) return what + ': it did not finish in time';
  // eslint-disable-next-line no-control-regex
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = plain(r.stderr || r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\S+Z\s+(WARN|INFO|DEBUG|TRACE)\b/.test(l));
  return what + (lines.length ? ': ' + tail(lines.slice(-4).join(' '), 600) : ` (exit code ${r.code ?? 'none'})`);
}

export type CuaRunner = (
  args: string[],
  o: {
    signal?: AbortSignal;
    timeoutMs: number;
    /** What cua logs to its error output (`CUA_LOG`, a tracing filter): only its warnings without it. */
    log?: string;
    /** Each line of its error output, as it comes (its log). */
    onStderrLine?: (line: string) => void;
  },
) => Promise<SpawnResult>;

/** Runs `cua` (`bin`) with Harness Relay's environment, in its Cua home. */
export function cuaRunner(bin: () => string | undefined, env: () => NodeJS.ProcessEnv = () => cuaEnv()): CuaRunner {
  return async (args, o) => {
    const program = bin();
    if (!program) throw new CuaError('Cua is not installed', null);
    const e = env();
    if (o.log) e.CUA_LOG = o.log;
    mkdirSync(e.CUA_HOME!, { recursive: true, mode: 0o700 });
    return runProcess({
      bin: program,
      args,
      env: e,
      cwd: e.CUA_HOME,
      signal: o.signal,
      timeoutMs: o.timeoutMs,
      maxCapture: 1 << 20,
      maxStderrCapture: 64 * 1024,
      ...(o.onStderrLine ? { onStderrLine: o.onStderrLine } : {}),
    });
  };
}

/**
 * A line of cua's error output as a job's log keeps it: its own words, without colours or the time; none for
 * what it logs at debug or trace level (its Docker client's pull stream, which `PullProgress` reads).
 */
export function cuaLogLine(line: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!plain) return undefined;
  const logged = /^\S+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+):\s*(.*)$/.exec(plain);
  if (!logged) return tail(plain, 600);
  if (logged[1] === 'TRACE' || logged[1] === 'DEBUG') return undefined;
  return tail(logged[3]!, 600) || undefined;
}

/** The alias of the image a computer is made from (`cua sb create linux`): Cua's Linux desktop. */
export const DESKTOP_IMAGE = 'linux';

/**
 * What `cua --json images info linux` says of the desktop image: its reference (`ghcr.io/trycua/linux:24.04`),
 * which `cua image pull` needs (it hands an alias to Docker as it is, which Docker does not know), and what
 * a pull downloads for this processor (bytes), when the catalog says.
 */
export function desktopImage(info: unknown, arch: string = process.arch): { ref: string; download?: number } | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const entry = info as { ref?: unknown; sizes?: { platforms?: unknown } };
  // A registry's reference (never an option: it goes on cua's command line).
  if (typeof entry.ref !== 'string' || !/^[a-z0-9][\w.-]*(?::\d+)?\/[\w./-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?$/i.test(entry.ref))
    return undefined;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  const platforms = Array.isArray(entry.sizes?.platforms) ? entry.sizes.platforms : [];
  const size = platforms.find(
    (p): p is { arch: string; download: number } =>
      Boolean(p) && (p as { arch?: unknown }).arch === cpu && typeof (p as { download?: unknown }).download === 'number',
  )?.download;
  return { ref: entry.ref, ...(size && size > 0 ? { download: size } : {}) };
}

/** What cua logs for a pull's progress: its Docker client's lines of the engine's pull stream (`bollard::read`, at debug). */
export const PULL_LOG = 'info,bollard::read=debug';

/**
 * A pull's progress, from cua's log (`PULL_LOG`): each line of the container engine's pull stream that
 * cua's Docker client logs (`Decoding JSON line from stream: {"status":"Downloading","progressDetail":
 * {"current":…,"total":…},"id":"<layer>"}`), as bytes downloaded of the layers to download. A layer is
 * one announced (`Pulling fs layer`, `Waiting`) or downloading; one already there (`Already exists`) is not
 * downloaded. The total is the layers' own once each has one; before that the catalog's size (`expected`),
 * or what the layers say so far when that is more (the image pulled may be a little larger than the catalog's),
 * and none without a catalog size. Nothing is logged when the image is already there.
 */
export class PullProgress {
  private layers = new Map<string, { done: number; total?: number; finished: boolean }>();
  constructor(private readonly expected?: number) {}

  /** One line of cua's error output: the progress when it is a line of the pull stream, else undefined. */
  line(text: string): { done: number; total?: number } | undefined {
    // eslint-disable-next-line no-control-regex
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    const at = plain.indexOf('Decoding JSON line from stream: ');
    if (at < 0 || !/\bbollard::read\b/.test(plain.slice(0, at))) return undefined;
    let event: { status?: unknown; id?: unknown; progressDetail?: { current?: unknown; total?: unknown } };
    try {
      event = JSON.parse(plain.slice(at + 'Decoding JSON line from stream: '.length).trim()) as typeof event;
    } catch {
      return undefined;
    }
    if (!event || typeof event.status !== 'string' || typeof event.id !== 'string' || !/^[0-9a-f]{12,64}$/.test(event.id)) return undefined;
    const id = event.id;
    const layer = this.layers.get(id);
    const current = event.progressDetail?.current;
    const total = event.progressDetail?.total;
    switch (event.status) {
      case 'Pulling fs layer':
      case 'Waiting':
        if (!layer) this.layers.set(id, { done: 0, finished: false });
        break;
      case 'Downloading':
        // A layer Docker downloads again (its retry) starts from nothing: the bar keeps what it showed.
        if (typeof current === 'number' && current >= 0 && typeof total === 'number' && total > 0)
          this.layers.set(id, {
            done: Math.max(Math.min(current, total), layer?.total === total ? layer.done : 0),
            total,
            finished: false,
          });
        break;
      case 'Verifying Checksum':
      case 'Download complete':
      case 'Extracting':
      case 'Pull complete':
        // A blob not announced as a layer (the image's configuration) is not counted.
        if (layer) layer.finished = true;
        break;
      case 'Already exists':
        this.layers.delete(id);
        break;
      default:
        return undefined;
    }
    return this.now();
  }

  /** Bytes downloaded, of how many (undefined while neither the layers nor the catalog say). */
  now(): { done: number; total?: number } {
    let done = 0;
    let known = 0;
    let all = true;
    for (const l of this.layers.values()) {
      done += l.finished ? (l.total ?? l.done) : l.done;
      known += l.total ?? 0;
      if (l.total === undefined && !l.finished) all = false;
    }
    const total = all && known ? known : this.expected ? Math.max(this.expected, known) : undefined;
    return { done: total ? Math.min(done, total) : done, ...(total ? { total } : {}) };
  }
}

/**
 * Removes Cua's own Linux runtime, Remove Cua's last step on Cua's side (once no sandbox is left in its home):
 * on macOS a Lima VM (`colima-cua`) under `<home>/runtimes/linux`, stopped and deleted with the `limactl`
 * Cua put there, then that folder (its disk is most of it). Cua has no command for this. Nothing is deleted
 * while a VM there could not be stopped. On Windows its WSL distribution stays (`kept`): its name is Cua's
 * own; on Linux, Cua's images and helper in Docker instead (`kept-docker` while other Cua sandboxes are there).
 */
export async function removeCuaRuntime(
  o: {
    home?: string;
    platform?: NodeJS.Platform;
    run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<SpawnResult>;
  } = {},
): Promise<'removed' | 'none' | 'kept-wsl' | 'kept-docker'> {
  const dir = join(o.home ?? cuaHome(), 'runtimes', 'linux');
  const platform = o.platform ?? process.platform;
  const run =
    o.run ??
    ((bin: string, args: string[], env: NodeJS.ProcessEnv) => runProcess({ bin, args, env, timeoutMs: 180_000, maxCapture: 1 << 20 }));
  // On Linux the computers ran in the user's Docker, where Cua's images and its helper stay after its cache is pruned.
  const docker = platform === 'linux' ? await removeCuaFromDocker(run) : 'none';
  if (!existsSync(dir)) return docker;
  if (platform === 'win32') return 'kept-wsl';
  const lima = join(dir, 'vm', '_lima');
  const limactl = readdirSync(dir)
    .filter((name) => name.startsWith('colima-'))
    .map((name) => join(dir, name, 'lima', 'bin', 'limactl'))
    .find((p) => existsSync(p));
  if (existsSync(lima)) {
    if (!limactl) throw new Error(`Cua's Linux VM in ${dir} could not be stopped: its limactl is missing`);
    const env = { ...cuaEnv(), LIMA_HOME: lima };
    const listed = await run(limactl, ['list', '--json'], env);
    if (listed.code !== 0) throw new Error(`Cua's Linux VM could not be listed: ${tail(listed.stderr || listed.stdout, 300)}`);
    const names = listed.stdout
      .split('\n')
      .map((line) => {
        try {
          return (JSON.parse(line) as { name?: unknown }).name;
        } catch {
          return undefined;
        }
      })
      .filter((name): name is string => typeof name === 'string' && /^[\w.-]+$/.test(name));
    for (const name of names) {
      await run(limactl, ['stop', '--force', name], env);
      const deleted = await run(limactl, ['delete', '--force', name], env);
      if (deleted.code !== 0)
        throw new Error(`Cua's Linux VM ${name} could not be deleted: ${tail(deleted.stderr || deleted.stdout, 300)}`);
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  return 'removed';
}

/**
 * What Cua left in the user's Docker on Linux, once none of Cua's sandboxes is there (of any Cua home: Cua
 * labels its containers `ai.cua.managed`): its helper containers (`ai.cua.kind=helper`, which set up gVisor),
 * then its images (`ghcr.io/trycua/…`, `cua-vmm/helper`; by tag, or by digest where Cua pulled one without a tag),
 * each with a plain `docker rmi`, which Docker refuses for an image a container still uses. Without Docker
 * (Podman), nothing.
 */
async function removeCuaFromDocker(
  run: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<SpawnResult>,
): Promise<'removed' | 'none' | 'kept-wsl' | 'kept-docker'> {
  const env = cuaEnv();
  let listed: SpawnResult;
  try {
    listed = await run(
      'docker',
      ['ps', '-a', '--filter', 'label=ai.cua.managed=true', '--format', '{{.Names}}\t{{.Label "ai.cua.kind"}}'],
      env,
    );
  } catch {
    return 'none';
  }
  if (listed.code !== 0) return 'none';
  const containers = listed.stdout
    .split('\n')
    .map((line) => line.trim().split('\t'))
    .filter(([name]) => name);
  // A sandbox of Cua's still there (another Cua home's): its helper and images stay.
  if (containers.some(([, kind]) => kind !== 'helper')) return 'kept-docker';
  let removed = false;
  for (const [name] of containers) if ((await run('docker', ['rm', '--force', name!], env)).code === 0) removed = true;
  const images = await run('docker', ['images', '--digests', '--format', '{{.Repository}}\t{{.Tag}}\t{{.Digest}}'], env);
  if (images.code === 0)
    for (const line of images.stdout.split('\n')) {
      const [repo = '', tag = '', digest = ''] = line.trim().split('\t');
      if (!/^(ghcr\.io\/trycua\/[\w./-]+|cua-vmm\/helper)$/.test(repo)) continue;
      const ref =
        /^[\w.-]+$/.test(tag) && tag !== '<none>' ? `${repo}:${tag}` : /^sha256:[0-9a-f]{64}$/.test(digest) ? `${repo}@${digest}` : '';
      if (!ref) continue;
      const r = await run('docker', ['rmi', ref], env);
      if (r.code === 0) removed = true;
      else throw new Error(`Cua's image ${ref} stays in Docker: ${tail(r.stderr || r.stdout, 300)}`);
    }
  return removed ? 'removed' : 'none';
}
