/**
 * Container previews: any project with a Dockerfile or a compose file. The images are built from
 * the snapshot (the only step with a network), then run as a compose project of Relay's own (see
 * `previewCompose.ts`) with no way out. The main service runs on a terminal the panel shows; when
 * it serves HTTP, the panel shows its page too. A forwarder (the pinned Node image) owns the main
 * service's network namespace and carries both the page and the port check.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { Duplex } from 'node:stream';
import type { PreviewTerminalEvent } from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';
import {
  COMPOSE_NAMES,
  FORWARDER,
  SERVICE_LIMITS,
  commandWords,
  composeModel,
  isBacking,
  planCompose,
  planDockerfile,
  previewPort,
  type PreviewPlan,
  type PreviewService,
} from './previewCompose';
import { checkDockerEngine, checked, localDocker, type Docker, type DockerOptions } from './previewDocker';
import { WAIT_PORT } from './previewDockerWire';
import { previewEngine, type PreviewEngine } from './previewEngine';
import {
  LIMITS,
  NODE,
  PREVIEW_LABEL,
  PREVIEW_NODE_IMAGE,
  ownerLabel,
  previewForwarder,
  sweepPreviewResources,
  type PreviewRuntime,
} from './previewRuntime';
import { tarFiles } from './previewTar';

export interface PreviewTerminal {
  /** Every event from now on, after one that replays the terminal so far and the current state. */
  subscribe(listener: (event: PreviewTerminalEvent) => void): () => void;
  /** Keystrokes for the main service. False when it is not running. */
  input(data: string): boolean;
  resize(cols: number, rows: number): Promise<void>;
  /** Runs the main service again, with its own command or the command line given. */
  run(command?: string): Promise<void>;
}

export interface ContainerPreview extends PreviewRuntime {
  terminal: PreviewTerminal;
}

export interface ContainerOptions {
  files: ReadonlyMap<string, Buffer>;
  executables?: ReadonlySet<string>;
  /** `Dockerfile`, or a compose file's name, at the snapshot's root. */
  recipe: string;
  signal: AbortSignal;
  owner: string;
  beforeDocker?: () => Promise<void>;
  docker?: (signal?: AbortSignal) => Promise<Docker>;
  engine?: (endpoint: string) => PreviewEngine;
}

const SESSION_LABEL = 'io.harness-relay.preview.session';
const HISTORY = 256 * 1024;
const BUILD_TIMEOUT = 15 * 60_000;
const UP_TIMEOUT = 5 * 60_000;
const MAX_INPUT = 64 * 1024;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
/** Relay's builder being made, by name: two previews starting at once on a fresh engine make it once. */
const creatingBuilders = new Map<string, Promise<unknown>>();

/** The plan for a recipe, from the snapshot alone, before anything reaches Docker. */
export function previewPlan(files: ReadonlyMap<string, Buffer>, recipe: string): PreviewPlan {
  const has = (path: string) => files.has(path);
  const isFolder = (path: string) => !path || [...files.keys()].some((name) => name.startsWith(path + '/'));
  if (COMPOSE_NAMES.includes(recipe)) {
    const text = files.get(recipe);
    if (!text) throw new HttpError(404, t().previewTarget);
    try {
      return planCompose(text.toString('utf8'), has, isFolder);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  }
  if (recipe !== 'Dockerfile' || !files.has(recipe)) throw new HttpError(404, t().previewTarget);
  return planDockerfile(recipe);
}

/** The files of a snapshot folder, with names inside it. */
function filesUnder(files: ReadonlyMap<string, Buffer>, folder: string, executables: ReadonlySet<string>) {
  const out = new Map<string, Buffer>();
  const exec = new Set<string>();
  const prefix = folder ? folder + '/' : '';
  for (const [name, data] of files) {
    if (!name.startsWith(prefix)) continue;
    out.set(name.slice(prefix.length), data);
    if (executables.has(name)) exec.add(name.slice(prefix.length));
  }
  return { files: out, executables: exec };
}

/** A command line shown in the panel, quoted where a word needs it. */
export function shownCommand(words: readonly string[]): string {
  return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : "'" + w.replace(/'/g, `'\\''`) + "'")).join(' ');
}

/** Terminal text from a program that writes lines (Docker's build and compose output): CRLF for the terminal. */
function lines(text: string): Buffer {
  return Buffer.from(text.replace(/\r?\n/g, '\r\n'));
}

export function startContainerPreview(opts: ContainerOptions): ContainerPreview {
  const plan = previewPlan(opts.files, opts.recipe);
  const shownService = plan.services.find((s) => s.name === plan.main)!;
  const backing = !shownService.build && Boolean(shownService.image && isBacking(shownService.image));
  const label = ownerLabel(opts.owner);
  const id = randomBytes(8).toString('hex');
  const project = 'relay-preview-' + id;
  const labels = { [PREVIEW_LABEL]: opts.owner, [SESSION_LABEL]: project };
  const lifetime = new AbortController();
  const signal = AbortSignal.any([opts.signal, lifetime.signal]);
  const executables = opts.executables ?? new Set<string>();
  // Compose reads a `.env` beside its project. An empty folder of its own has none.
  let projectDir: string | undefined;

  const listeners = new Set<(event: PreviewTerminalEvent) => void>();
  const history: Buffer[] = [];
  let historySize = 0;
  let state: Extract<PreviewTerminalEvent, { type: 'phase' }> = { type: 'phase', phase: 'building' };
  let page = false;
  const emit = (event: PreviewTerminalEvent) => {
    for (const listener of listeners) listener(event);
  };
  const write = (bytes: Buffer) => {
    if (!bytes.length) return;
    history.push(bytes);
    historySize += bytes.length;
    while (historySize > HISTORY && history.length > 1) historySize -= history.shift()!.length;
    emit({ type: 'output', data: bytes.toString('base64') });
  };
  const say = (text: string, style = '2') => write(lines(`\x1b[${style}m${text}\x1b[0m\n`));
  const phase = (next: typeof state) => {
    state = next;
    emit(next);
  };

  let docker: Docker | undefined;
  let engine: PreviewEngine | undefined;
  let images = new Map<string, string>();
  let port = 0;
  let setPort = false;
  let forwarder = '';
  let main = '';
  let attached: Duplex | undefined;
  let watch: AbortController | undefined;
  let size = { cols: 100, rows: 30 };
  let busy: Promise<void> | undefined;
  let closed = false;

  const run = (args: string[], step: string, options: DockerOptions = {}) =>
    docker!(args, { signal, ...options }).then((r) => checked(r, step));
  /** Docker's own progress, streamed into the terminal as it comes. */
  const streamed = (options: DockerOptions = {}): DockerOptions => ({
    ...options,
    onSpawn: (child) => {
      child.stdout?.on('data', (chunk: Buffer) => write(lines(chunk.toString('utf8'))));
      child.stderr?.on('data', (chunk: Buffer) => write(lines(chunk.toString('utf8'))));
    },
  });
  const compose = (args: string[], model: Record<string, unknown>, options: DockerOptions = {}) =>
    run(['compose', '-p', project, '-f', '-', '--project-directory', projectDir!, ...args], t().previewDocker.composeUp, {
      ...options,
      cwd: projectDir,
      stdin: JSON.stringify(model),
    });
  const serviceContainer = async (service: string, all = false) => {
    const r = await run(
      [
        'ps',
        ...(all ? ['-a'] : []),
        '-q',
        '--no-trunc',
        '--filter',
        'label=com.docker.compose.project=' + project,
        '--filter',
        'label=com.docker.compose.service=' + service,
      ],
      t().previewDocker.find,
    );
    const found = r.stdout.trim().split(/\s+/).filter(Boolean);
    if (found.length !== 1 || !CONTAINER_ID.test(found[0]!)) throw new Error(t().previewDocker.invalidDocker);
    return found[0]!;
  };
  const model = (command?: string[]) =>
    composeModel(plan, { project, labels, images, forwarderImage: PREVIEW_NODE_IMAGE, port, setPort, ...(command ? { command } : {}) });

  /**
   * A BuildKit builder of Relay's own on the pinned engine, one per engine. A build on the user's
   * default builder would share its cache mounts (`RUN --mount=type=cache`) with the user's own
   * builds, and an environment or a `buildx use` could send the snapshot to another builder.
   */
  let builderName: string | undefined;
  async function builder(): Promise<string> {
    const name =
      'harness-relay-preview-' +
      createHash('sha256')
        .update(docker!.endpoint ?? '')
        .digest('hex')
        .slice(0, 12);
    const existing = async () => {
      const found = await docker!(['buildx', 'inspect', name], { signal });
      if (found.code !== 0) return false;
      // Its node must be on the engine every other call goes to.
      const endpoints = [...found.stdout.matchAll(/^Endpoint:\s+(\S+)\s*$/gm)].map((m) => m[1]);
      if (!endpoints.length || endpoints.some((endpoint) => endpoint !== docker!.endpoint))
        throw new Error(t().previewDocker.builderEndpoint(name));
      return true;
    };
    if (await existing()) return name;
    // Every preview waiting for it says so, not only the one making it.
    say(t().previewDocker.builder + '…', '1');
    let creating = creatingBuilders.get(name);
    if (!creating) {
      creating = create(name).finally(() => creatingBuilders.delete(name));
      creatingBuilders.set(name, creating);
    }
    try {
      await creating;
    } catch (error) {
      // Another Relay may have made it meanwhile: then it is there, and the same.
      if (!(await existing())) throw error;
    }
    return name;
  }
  function create(name: string) {
    return run(
      [
        'buildx',
        'create',
        '--name',
        name,
        '--driver',
        'docker-container',
        '--driver-opt',
        'memory=4g',
        '--driver-opt',
        'memory-swap=4g',
        '--driver-opt',
        'cpu-period=100000',
        '--driver-opt',
        'cpu-quota=200000',
        '--bootstrap',
      ],
      t().previewDocker.builder,
      streamed({ timeoutMs: UP_TIMEOUT }),
    );
  }
  /** `docker buildx build` on Relay's builder, the image loaded into the engine and labelled. */
  const buildArgs = (tag: string) => [
    'buildx',
    'build',
    '--builder',
    builderName!,
    '--load',
    '--progress=plain',
    '--label',
    label,
    '--label',
    `${SESSION_LABEL}=${project}`,
    '-t',
    tag,
  ];

  async function build(service: PreviewService, index: number): Promise<void> {
    if (service.build) {
      const b = service.build;
      const context = filesUnder(opts.files, b.context, executables);
      if (b.inline !== undefined) context.files.set(b.dockerfile, Buffer.from(b.inline));
      const tag = `${project}-${index}:build`;
      say(t().previewDocker.imageBuild(service.name) + '…', '1');
      await run(
        [
          ...buildArgs(tag),
          '-f',
          b.dockerfile,
          ...Object.entries(b.args).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
          ...(b.target ? ['--target', b.target] : []),
          '-',
        ],
        t().previewDocker.imageBuild(service.name),
        streamed({ stdin: tarFiles(context.files, context.executables), timeoutMs: BUILD_TIMEOUT }),
      );
      images.set(service.name, tag);
    }
  }

  /**
   * The project files a service bind-mounts, copied into its created container before it starts:
   * a tar of them at their targets, which `docker cp` unpacks and nothing runs. (An image derived
   * from the service's would run its base image's ONBUILD steps.)
   */
  async function copyMounts(service: PreviewService, container: string): Promise<void> {
    if (!service.mounts.length) return;
    const copy = new Map<string, Buffer>();
    const exec = new Set<string>();
    for (const m of service.mounts) {
      const target = posix.normalize(m.target).replace(/^\/+|\/+$/g, '');
      if (m.folder) {
        const under = filesUnder(opts.files, m.source, executables);
        for (const [name, data] of under.files) {
          copy.set(target + '/' + name, data);
          if (under.executables.has(name)) exec.add(target + '/' + name);
        }
      } else {
        copy.set(target, opts.files.get(m.source)!);
        if (executables.has(m.source)) exec.add(target);
      }
    }
    await run(['cp', '-', container + ':/'], t().previewDocker.mountCopy(service.name), {
      stdin: tarFiles(copy, exec),
      timeoutMs: UP_TIMEOUT,
    });
  }

  /** The image's EXPOSEd TCP ports, for a main service whose file does not say which port it serves. */
  async function exposed(tag: string): Promise<number[]> {
    const r = await run(['image', 'inspect', '--format', '{{json .Config.ExposedPorts}}', tag], t().previewDocker.inspect);
    try {
      const ports = JSON.parse(r.stdout.trim() || 'null') as Record<string, unknown> | null;
      return Object.keys(ports ?? {})
        .filter((p) => p.endsWith('/tcp'))
        .map((p) => Number(p.split('/')[0]))
        .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    } catch {
      return [];
    }
  }

  /** The command line the main container runs, for the panel to offer it again or edited. */
  async function command(container: string): Promise<string> {
    const r = await docker!(['inspect', '--format', '{{json .Config.Entrypoint}}\n{{json .Config.Cmd}}', container], { signal });
    if (r.code !== 0) return '';
    try {
      const [entry, cmd] = r.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[] | null);
      return shownCommand([...(entry ?? []), ...(cmd ?? [])]);
    } catch {
      return '';
    }
  }

  /**
   * Attach to the main container, start it, report its command, watch its port, and say when it
   * exits. `docker wait` says when it exits: an attach to a container that already stopped replays
   * what it wrote, then waits for a start that never comes.
   */
  async function attach(start: (container: string) => Promise<unknown>): Promise<void> {
    const container = await serviceContainer(plan.main, true);
    main = container;
    await copyMounts(shownService, container);
    // Before it starts: an attach to a running container does not replay what it already wrote,
    // so a prompt printed at once would be lost.
    const socket = await engine!.attach(container, true, signal);
    attached = socket;
    socket.on('data', (chunk: Buffer) => write(chunk));
    socket.on('error', () => {});
    await start(container);
    watch = new AbortController();
    const watching = AbortSignal.any([signal, watch.signal]);
    // The connection may drop while the app runs on: pick its terminal up again, without its history.
    socket.once('close', () => {
      if (attached !== socket || closed || watching.aborted) return;
      attached = undefined;
      void engine!
        .attach(container, false, watching)
        .then((again) => {
          if (watching.aborted || closed) return again.destroy();
          attached = again;
          again.on('data', (chunk: Buffer) => write(chunk));
          again.on('error', () => {});
        })
        .catch(() => {});
    });
    await engine!.resize(container, size.rows, size.cols);
    phase({ type: 'phase', phase: 'running', command: await command(container) });
    // A check of half a minute at a time: stopping `docker exec` leaves what it ran in the container.
    // A database's port is open but serves no page: its terminal is the preview.
    void (async () => {
      while (!backing && !watching.aborted && !closed) {
        const r = await docker!(['exec', '-i', forwarder, ...NODE, WAIT_PORT, String(port), '30'], {
          signal: watching,
          keepStdinOpen: true,
          timeoutMs: 60_000,
        });
        if (watching.aborted || closed) return;
        if (r.code === 0) {
          page = true;
          emit({ type: 'page' });
        }
        // Up, or the forwarder cannot check any more: either way this watch is done.
        if (r.code !== 3) return;
      }
    })();
    void docker!(['wait', container], { signal: watching, timeoutMs: 2 * 60 * 60_000 }).then(async (r) => {
      if (watching.aborted || closed || r.code !== 0) return;
      // The last bytes it wrote may still be on their way.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (watching.aborted || closed) return;
      watch?.abort();
      const last = attached;
      attached = undefined;
      last?.destroy();
      page = false;
      const code = Number(r.stdout.trim());
      phase({ type: 'phase', phase: 'exited', code: Number.isInteger(code) ? code : -1 });
    });
  }

  async function start(): Promise<void> {
    await opts.beforeDocker?.();
    signal.throwIfAborted();
    docker = await (opts.docker ?? localDocker)(signal);
    engine = (opts.engine ?? previewEngine)(docker.endpoint ?? '');
    await checkDockerEngine(docker, signal);
    const version = await docker(['compose', 'version', '--short'], { signal });
    if (version.code !== 0) throw new Error(t().previewDocker.composeMissing);
    if (plan.services.some((s) => s.build)) {
      const buildx = await docker(['buildx', 'version'], { signal });
      if (buildx.code !== 0) throw new Error(t().previewDocker.buildxMissing);
      builderName = await builder();
    }
    projectDir = mkdtempSync(join(tmpdir(), 'relay-compose-'));
    for (const note of plan.notes) say(note);
    let index = 0;
    for (const service of plan.services) await build(service, index++);
    signal.throwIfAborted();
    // The image's EXPOSE matters only when the file does not say which port the app serves.
    const shown = shownService;
    let tag = images.get(shown.name);
    if (!shown.ports.length && !tag && shown.image) {
      // An image the engine has is used as it is, as compose would (a local one, or offline).
      if ((await docker(['image', 'inspect', '--format', '{{.Id}}', shown.image], { signal })).code !== 0)
        await run(['pull', shown.image], t().previewDocker.imagePull(shown.image), streamed({ timeoutMs: UP_TIMEOUT }));
      tag = shown.image;
    }
    ({ port, setPort } = previewPort(plan, !shown.ports.length && tag ? await exposed(tag) : []));
    phase({ type: 'phase', phase: 'starting' });
    // The forwarder first, alone: it proves the engine enforces the limits before any project code runs.
    await compose(['up', '-d', '--no-build', FORWARDER], model(), streamed({ timeoutMs: UP_TIMEOUT }));
    forwarder = await serviceContainer(FORWARDER);
    await run(
      ['exec', forwarder, ...NODE, LIMITS, String(SERVICE_LIMITS.memoryBytes), String(SERVICE_LIMITS.pids)],
      t().previewDocker.limits,
    );
    // Every container created, none started: the main one is attached to first, then all start in
    // their order (dependencies and their health checks first).
    await compose(['up', '--no-start', '--no-build'], model(), streamed({ timeoutMs: UP_TIMEOUT }));
    signal.throwIfAborted();
    for (const service of plan.services) {
      if (service.name !== plan.main && service.mounts.length) await copyMounts(service, await serviceContainer(service.name, true));
    }
    await attach(() => compose(['up', '-d', '--no-build'], model(), streamed({ timeoutMs: UP_TIMEOUT })));
  }

  /** Everything this preview made, found by its session label: containers, networks, volumes, images. One sweep at a time. */
  let sweeping: Promise<void> | undefined;
  const sweepAll = () =>
    (sweeping ??= (async () => {
      const cleaner = docker ?? (await (opts.docker ?? localDocker)());
      await sweepPreviewResources(cleaner, `label=${SESSION_LABEL}=${project}`);
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    })().finally(() => {
      sweeping = undefined;
    }));
  const fail = (error: unknown) => {
    if (closed) return;
    const message = error instanceof Error ? error.message : String(error);
    say(message, '31');
    phase({ type: 'phase', phase: 'failed', error: message.slice(0, 4000) });
    // A failed preview keeps its terminal for the error, not its services: Rebuild starts afresh.
    forwarder = '';
    watch?.abort();
    attached?.destroy();
    attached = undefined;
    void sweepAll().catch((cleanup: unknown) => console.error('[preview] cleanup:', cleanup));
  };
  busy = start()
    .catch(fail)
    .finally(() => {
      busy = undefined;
    });

  let stopped: Promise<void> | undefined;
  const stop = () => {
    closed = true;
    lifetime.abort();
    watch?.abort();
    attached?.destroy();
    attached = undefined;
    emit({ type: 'closed' });
    listeners.clear();
    // What a failed sweep leaves still carries the owner label, which the next start sweeps: the
    // preview itself is gone either way, and no session waits on the engine to come back.
    stopped ??= (async () => {
      await busy?.catch(() => {});
      await sweepAll().catch((error: unknown) => console.error('[preview] cleanup:', error));
    })();
    return stopped;
  };
  opts.signal.addEventListener('abort', () => void stop().catch(() => {}), { once: true });

  let forward: ((request: Request) => Promise<Response>) | undefined;
  return {
    stop,
    async request(request) {
      if (closed) return new Response(null, { status: 410 });
      if (!page || !forwarder) return new Response(null, { status: 503 });
      forward ??= previewForwarder((args, options) => docker!(['exec', '-i', forwarder, ...args], options), signal, port);
      return forward(request);
    },
    terminal: {
      subscribe(listener) {
        if (closed) {
          listener({ type: 'closed' });
          return () => {};
        }
        listener({ type: 'output', data: Buffer.concat(history).toString('base64'), replay: true });
        listener(state);
        if (page) listener({ type: 'page' });
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      input(data) {
        if (!attached || closed || state.phase !== 'running') return false;
        attached.write(Buffer.from(data.slice(0, MAX_INPUT), 'utf8'));
        return true;
      },
      async resize(cols, rows) {
        size = { cols: Math.min(500, Math.max(10, Math.round(cols))), rows: Math.min(300, Math.max(4, Math.round(rows))) };
        if (attached && main && engine) await engine.resize(main, size.rows, size.cols);
      },
      async run(line) {
        if (busy && !closed) throw new HttpError(409, t().previewDocker.runBusy);
        if (closed || !forwarder) throw new HttpError(409, t().previewDocker.runFailed);
        let words: string[] | undefined;
        try {
          words = line === undefined ? undefined : commandWords(line, 'command');
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        if (words && !words.length) throw new HttpError(400, t().previewTarget);
        busy = (async () => {
          watch?.abort();
          const previous = attached;
          attached = undefined;
          previous?.destroy();
          page = false;
          phase({ type: 'phase', phase: 'starting' });
          say('— ' + (line ?? t().previewDocker.composeUp) + ' —');
          await compose(['up', '--no-start', '--no-build', '--no-deps', '--force-recreate', plan.main], model(words), {
            timeoutMs: UP_TIMEOUT,
          });
          await attach((container) => run(['start', container], t().previewDocker.start));
        })()
          // A command that cannot start (a typo, no /bin/sh in the image) ends this run, not the
          // preview: its other services and their data stay, and it can run again.
          .catch((error: unknown) => {
            if (closed) return;
            watch?.abort();
            const last = attached;
            attached = undefined;
            last?.destroy();
            const message = error instanceof Error ? error.message : String(error);
            say(message, '31');
            phase({ type: 'phase', phase: 'exited', code: -1, error: message.slice(0, 4000) });
          })
          .finally(() => {
            busy = undefined;
          });
        await busy;
      },
    },
  };
}
