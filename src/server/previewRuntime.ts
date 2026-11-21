import { t } from './i18n';
import { tail } from './process';
import { randomUUID } from 'node:crypto';
import { checked, localDocker, checkDockerEngine, type Docker, type DockerOptions } from './previewDocker';
import { lockedPreviewPackages, fetchPreviewPackage, type LockedPreviewPackage } from './previewDockerPackages';
import {
  APP_PORT,
  EXPORT_DIST,
  FORWARD_HTTP,
  IMPORT_FILES,
  MAX_DIST,
  RESPONSE_LIMIT,
  decodePreviewFiles,
  decodePreviewResponse,
  encodePreviewFiles,
  encodePreviewRequest,
} from './previewDockerWire';
import { previewFileResponse } from './previewFiles';

export interface PreviewRuntime {
  request(request: Request): Promise<Response>;
  stop(): Promise<void>;
}

/** A start failed and Docker has not confirmed cleanup. The manager retains stop until removal succeeds. */
export class PreviewCleanupError extends Error {
  constructor(
    startError: unknown,
    cleanupError: unknown,
    readonly stop: () => Promise<void>,
  ) {
    super([startError, cleanupError].map((error) => (error instanceof Error ? error.message : String(error))).join('\n'), {
      cause: startError,
    });
    this.name = 'PreviewCleanupError';
  }
}

// Official Node 22.23.5 / Debian bookworm, index for Linux amd64 and arm64.
const IMAGE = 'docker.io/library/node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee';
const LABEL = 'io.harness-relay.preview.owner';
const DIGEST = /^[a-f0-9]{64}$/;
const NODE = ['/usr/local/bin/node', '--input-type=module', '-e'];
const MIB = 1024 * 1024;
const MAX_PACKAGES = 96 * MIB;
const MAX_TARBALL = 24 * MIB;
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'];
const LIMITS = `
import fs from 'node:fs';
const read = name => fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();
const [quota,period] = read('cpu.max').split(/\\s+/).map(Number);
if (!(quota > 0 && period > 0 && quota <= period)) throw Error('Docker CPU quota is unavailable.');
const within = (file, max) => Number(read(file)) > 0 && Number(read(file)) <= max;
if (!within('memory.max',805306368) || Number(read('memory.swap.max')) !== 0 || !within('pids.max',96))
  throw Error('Docker memory or process quota is unavailable.');
const status = fs.readFileSync('/proc/self/status','utf8');
if (process.getuid() !== 1000 || !/^CapEff:\\s*0+$/m.test(status) || !/^NoNewPrivs:\\s*1$/m.test(status) || !/^Seccomp:\\s*2$/m.test(status))
  throw Error('Required Docker process isolation is unavailable.');
if (!['arm64','x64'].includes(process.arch)) throw Error('Preview requires Linux x64 or arm64.');
console.log(process.arch);
`;
const READY = `
import net from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
const deadline = Date.now()+30000;
while (true) {
  const up = await new Promise(resolve => {
    const socket = net.connect(${APP_PORT},'127.0.0.1');
    socket.once('connect',()=>{socket.destroy();resolve(true)});
    socket.once('error',()=>{socket.destroy();resolve(false)});
  });
  if (up) break;
  if (Date.now()>deadline) throw Error('Preview did not listen on PORT=${APP_PORT} within 30 seconds.');
  await sleep(150);
}
`;

function ownerLabel(owner: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error(t().previewDocker.invalidOwner);
  return LABEL + '=' + owner;
}

async function remove(docker: Docker, id: string): Promise<void> {
  const r = await docker(['rm', '-f', id]);
  // Some Docker versions return a nonzero exit for an already-removed ID. Daemon failures and
  // unrelated diagnostics must survive so the owner of this handle can retry.
  if (r.code === 1 && !r.aborted && !r.timedOut && r.stderr.trim().toLowerCase() === 'error response from daemon: no such container: ' + id)
    return;
  checked(r, t().previewDocker.remove);
}

async function sweep(docker: Docker, filters: string[]): Promise<void> {
  const r = checked(await docker(['ps', '-aq', '--no-trunc', ...filters.flatMap((f) => ['--filter', f])]), t().previewDocker.find);
  if (r.stdoutTruncated) throw new Error(t().previewDocker.containerCount);
  for (const id of r.stdout.trim().split(/\s+/).filter(Boolean)) {
    if (!DIGEST.test(id)) throw new Error(t().previewDocker.invalidDocker);
    await remove(docker, id);
  }
}

export async function cleanupPreviewRuntimes(owner: string): Promise<void> {
  const label = ownerLabel(owner);
  await sweep(await localDocker(), ['label=' + label]);
}

async function seedCache(
  pending: LockedPreviewPackage[],
  signal: AbortSignal,
  transfer: (files: ReadonlyMap<string, Buffer>) => Promise<void>,
): Promise<void> {
  let remaining = MAX_PACKAGES;
  const cached = new Set<string>();
  // Keep transfer buffers bounded while amortizing Docker exec over small dependencies.
  for (let i = 0; i < pending.length; i += 4) {
    signal.throwIfAborted();
    const batch = new Map<string, Buffer>();
    const stopped = new AbortController();
    try {
      await Promise.all(
        pending.slice(i, i + 4).map(async (pkg) => {
          const digest = Buffer.from(pkg.integrity.slice(7), 'base64').toString('hex');
          if (cached.has(digest)) return;
          cached.add(digest);
          const bytes = await fetchPreviewPackage(pkg, AbortSignal.any([signal, stopped.signal]), Math.min(remaining, MAX_TARBALL));
          remaining -= bytes.length;
          if (remaining < 0) throw new Error(t().previewDocker.downloadSize);
          // npm in the pinned image (pacote) reads verified tarballs from cacache by digest.
          batch.set(`cache/_cacache/content-v2/sha512/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest.slice(4)}`, bytes);
        }),
      );
    } finally {
      stopped.abort();
    }
    if (batch.size) await transfer(batch);
  }
}

export async function startPreviewRuntime(opts: {
  files: ReadonlyMap<string, Buffer>;
  mode: 'build' | 'server';
  beforeDocker?: () => Promise<void>;
  executables?: ReadonlySet<string>;
  signal: AbortSignal;
  owner: string;
}): Promise<PreviewRuntime> {
  const { files, mode, signal } = opts;
  const label = ownerLabel(opts.owner);
  const setup = AbortSignal.any([signal, AbortSignal.timeout(4 * 60_000)]);
  setup.throwIfAborted();
  // Parse and validate once locally, even when Docker is absent. Actual CPU selection follows
  // the verified guest architecture. Only eligible projects need a recovery sweep or an image.
  const packages = lockedPreviewPackages(files, mode);
  await opts.beforeDocker?.();
  setup.throwIfAborted();
  const docker = await localDocker(setup);
  const name = 'harness-relay-preview-' + randomUUID();
  let id = '';
  let createSent = false;
  let removed: Promise<void> | undefined;
  const lifetime = new AbortController();
  const stopContainer = () => {
    lifetime.abort();
    if (!removed) {
      const removal = id ? remove(docker, id) : createSent ? sweep(docker, ['label=' + label, 'name=^/' + name + '$']) : Promise.resolve();
      removed = removal.catch((error) => {
        removed = undefined;
        throw error;
      });
    }
    return removed;
  };
  const onAbort = () => {
    void stop().catch(() => {});
  };
  let closed = false;
  async function stop() {
    closed = true;
    signal.removeEventListener('abort', onAbort);
    await stopContainer();
  }
  const exec = (args: string[], options: DockerOptions = {}) =>
    docker(['exec', ...(options.stdin ? ['-i'] : []), id, ...args], { signal: setup, ...options });
  try {
    await checkDockerEngine(docker, setup);
    const image = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE], { signal: setup });
    if (image.code !== 0) checked(await docker(['pull', IMAGE], { signal: setup, timeoutMs: 120000 }), t().previewDocker.pull);
    setup.throwIfAborted();
    createSent = true;
    // Do not interrupt create in flight: await the ID even when the user closes the panel here.
    const created = checked(
      await docker([
        'create',
        '--pull=never',
        '--rm',
        '--name',
        name,
        '--label',
        label,
        '--user=1000:1000',
        '--read-only',
        '--network=none',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--cgroupns=private',
        '--memory=768m',
        '--memory-swap=768m',
        '--cpus=1',
        '--pids-limit=96',
        '--shm-size=8m',
        '--ulimit=nofile=1024:1024',
        '--ulimit=core=0:0',
        '--log-driver=none',
        '--tmpfs=/work:rw,exec,nosuid,nodev,size=384m,nr_inodes=65536,uid=1000,gid=1000,mode=0700',
        '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m,nr_inodes=8192,mode=1777',
        ...PROXIES.flatMap((key) => ['--env', key + '=', '--env', key.toLowerCase() + '=']),
        '--env',
        'HOME=/work/home',
        '--env',
        'npm_config_cache=/work/cache',
        '--env',
        'npm_config_offline=true',
        '--env',
        'HOST=127.0.0.1',
        '--env',
        'PORT=' + APP_PORT,
        '--entrypoint=/bin/sleep',
        IMAGE,
        '7200',
      ]),
      t().previewDocker.create,
    );
    if (!DIGEST.test(created.stdout.trim())) throw new Error(t().previewDocker.invalidDocker);
    id = created.stdout.trim();
    setup.throwIfAborted();
    checked(await docker(['start', id], { signal: setup }), t().previewDocker.start);
    const arch = checked(await exec([...NODE, LIMITS]), t().previewDocker.limits).stdout.trim();
    if (arch !== 'x64' && arch !== 'arm64') throw new Error(t().previewDocker.arch);
    const transfer = async (entries: ReadonlyMap<string, Buffer>, executable?: ReadonlySet<string>) => {
      checked(
        await exec([...NODE, IMPORT_FILES], { stdin: encodePreviewFiles(entries, executable), timeoutMs: 30000 }),
        t().previewDocker.copy,
      );
    };
    await seedCache(packages[arch], setup, transfer);
    await transfer(
      new Map(Array.from(files, ([name, bytes]) => ['app/' + name, bytes])),
      new Set(Array.from(opts.executables ?? [], (name) => 'app/' + name)),
    );
    const npm = ['/usr/local/bin/npm', '--prefix', '/work/app'];
    checked(
      await exec([...npm, 'ci', '--offline', '--no-audit', '--no-fund', '--no-progress', '--include=dev'], { timeoutMs: 90000 }),
      t().previewDocker.ci,
    );
    if (mode === 'build') {
      checked(await exec([...npm, 'run', 'build'], { timeoutMs: 90000 }), t().previewDocker.build);
      const result = checked(
        await exec([...NODE, EXPORT_DIST], { maxCapture: MAX_DIST, timeoutMs: 15000 }),
        t().previewDocker.collect,
        false,
      );
      if (result.stdoutTruncated) throw new Error(t().previewDocker.distSize);
      const assets = decodePreviewFiles(result.stdoutBytes);
      if (!assets.has('index.html')) throw new Error(t().previewDocker.dist);
      await stopContainer();
      setup.throwIfAborted();
      return {
        stop,
        request: async (request) => (closed || signal.aborted ? new Response(null, { status: 410 }) : previewFileResponse(assets, request)),
      };
    }

    // The server and attached docker exec both end with the container. Never parse its startup logs
    // for an address. Capture failures on the fixed-port readiness probe and on later requests.
    const exited = exec([...npm, 'start'], { signal: lifetime.signal, timeoutMs: 7200000, maxCapture: 8192 });
    const server = exited.then((result) => {
      checked(result, t().previewDocker.server);
      throw new Error(t().previewDocker.exited);
    });
    let serverFailure: unknown;
    void server.catch((error) => {
      serverFailure = error;
      lifetime.abort();
    });
    try {
      await Promise.race([server, exec([...NODE, READY], { timeoutMs: 35000 }).then((r) => checked(r, t().previewDocker.ready))]);
    } catch (error) {
      // A live process may keep logging a configuration error without opening its listener.
      // Stop the attached exec first so its captured log becomes available.
      lifetime.abort();
      const result = await exited.catch(() => undefined);
      const detail = result?.aborted ? tail(result.stdout + '\n' + result.stderr, 2048) : '';
      if (detail && error instanceof Error) throw new Error(error.message + '\n' + detail);
      throw error;
    }
    setup.throwIfAborted();
    signal.addEventListener('abort', onAbort, { once: true });
    let active = 0;
    return {
      stop,
      async request(request) {
        if (closed || signal.aborted) return new Response(null, { status: 410 });
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method))
          return new Response(null, { status: 405 });
        if (active >= 8) return new Response(null, { status: 429 });
        active++;
        try {
          if (serverFailure) throw serverFailure;
          const requestSignal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(15000)]);
          const stdin = await encodePreviewRequest(request, requestSignal);
          const forwarded = exec([...NODE, FORWARD_HTTP], {
            stdin,
            signal: requestSignal,
            timeoutMs: 15000,
            maxCapture: RESPONSE_LIMIT + 32769,
          });
          const result = checked(await forwarded, t().previewDocker.http, false);
          if (result.stdoutTruncated) throw new Error(t().previewDocker.responseSize);
          return decodePreviewResponse(result.stdoutBytes, request.method);
        } finally {
          active--;
        }
      },
    };
  } catch (e) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new PreviewCleanupError(e, cleanupError, stop);
    }
    throw e;
  }
}
