import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewTerminalEvent } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { shownCommand, startContainerPreview } from '../src/server/previewContainer';
import { FORWARDER } from '../src/server/previewCompose';
import type { Docker, DockerOptions } from '../src/server/previewDocker';
import type { PreviewEngine } from '../src/server/previewEngine';
import type { SpawnResult } from '../src/server/process';

const owner = 'b'.repeat(64);
const forwarderId = 'f'.repeat(64);
const mainIds = ['a'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
const dbId = 'e'.repeat(64);

function result(stdout = '', code = 0, stderr = ''): SpawnResult {
  const bytes = Buffer.from(stdout);
  return {
    stdout,
    stdoutBytes: bytes,
    stdoutTruncated: false,
    stdoutSize: bytes.length,
    stderr,
    code,
    signal: null,
    aborted: false,
    timedOut: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Untars names and contents, enough to see what a build context held. */
function tarNames(archive: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  let pax: string | undefined;
  while (at + 512 <= archive.length && archive[at] !== 0) {
    const size = parseInt(archive.toString('latin1', at + 124, at + 136).replace(/\0.*$/, ''), 8);
    const data = archive.subarray(at + 512, at + 512 + size).toString();
    const type = archive.toString('latin1', at + 156, at + 157);
    if (type === 'x') pax = /path=(.*)\n$/s.exec(data)![1];
    else {
      out[pax ?? archive.toString('utf8', at, at + 100).replace(/\0.*$/s, '')] = data;
      pax = undefined;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A stand-in Docker: it records every call and answers as a local engine does. */
function fakeDocker(
  o: {
    buildFails?: boolean;
    noCompose?: boolean;
    noBuildx?: boolean;
    exposed?: string;
    builder?: string;
    sweepFails?: boolean;
    startFails?: (container: string) => boolean;
    imagePresent?: boolean;
  } = {},
) {
  const calls: { args: string[]; options: DockerOptions }[] = [];
  let portCheck = deferred<SpawnResult>();
  let exit = deferred<SpawnResult>();
  let created = 0;
  let builder = o.builder;
  const docker: Docker = async (args, options = {}) => {
    calls.push({ args, options });
    const joined = args.join(' ');
    if (args[0] === 'info') return result('linux arm64');
    if (joined === 'compose version --short')
      return o.noCompose ? result('', 1, "docker: 'compose' is not a docker command.") : result('2.30.3');
    if (joined === 'buildx version') return o.noBuildx ? result('', 1, "docker: 'buildx' is not a docker command.") : result('v0.37.2');
    if (args[0] === 'buildx' && args[1] === 'inspect')
      return builder
        ? result(`Name: ${args[2]}\nDriver: docker-container\n\nNodes:\nName: ${args[2]}0\nEndpoint:   ${builder}\n`)
        : result('', 1, 'no builder');
    if (args[0] === 'buildx' && args[1] === 'create') {
      builder = docker.endpoint;
      return result();
    }
    if (args[0] === 'buildx' && args[1] === 'build') {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      options.onSpawn?.(child as unknown as ChildProcess);
      child.stderr.emit('data', Buffer.from('#1 building\n'));
      return o.buildFails ? result('', 1, 'RUN pip install failed') : result();
    }
    if (args[0] === 'pull') return result();
    if (joined.startsWith('image inspect --format {{.Id}}')) return o.imagePresent ? result('sha256:1') : result('', 1, 'No such image');
    if (joined.startsWith('image inspect')) return result(o.exposed ?? '{"8000/tcp":{}}');
    if (args[0] === 'compose') {
      if (args.includes('--force-recreate')) created++;
      return result();
    }
    if (o.sweepFails && args[0] === 'ps' && args.includes('-aq')) return result('', 1, 'Cannot connect to the Docker daemon');
    if (args[0] === 'ps') {
      if (joined.includes('com.docker.compose.service=' + FORWARDER)) return result(forwarderId);
      if (joined.includes('com.docker.compose.service=db')) return result(dbId);
      if (joined.includes('com.docker.compose.service=')) return result(mainIds[created]!);
      return result(''); // sweeps
    }
    if (args[0] === 'exec' && args.at(-1) === '30') return portCheck.promise;
    if (args[0] === 'exec' && args.includes('-i')) {
      return result('{"status":200,"headers":{"content-type":"text/html"}}\n<h1>App</h1>');
    }
    if (args[0] === 'exec' && args.at(-1) === '256') return result('arm64');
    // The port check: each one answered when the test says.
    if (args[0] === 'exec') return portCheck.promise;
    if (args[0] === 'start' && o.startFails?.(args[1]!)) return result('', 1, 'exec: "pyton": executable file not found in $PATH');
    if (args[0] === 'inspect') return result('["python"]\n["app.py"]');
    if (args[0] === 'wait') return exit.promise;
    if (args.includes('ls')) return result('');
    return result();
  };
  docker.endpoint = 'unix:///var/run/docker.sock';
  return {
    docker,
    calls,
    openPort: () => portCheck.resolve(result()),
    /** A check gives up after its half minute: Relay asks again. */
    checkTimesOut: () => {
      const current = portCheck;
      portCheck = deferred<SpawnResult>();
      current.resolve(result('', 3));
    },
    /** Relay's own time limit stops a check that hung: whatever `docker exec` then exits with says nothing. */
    checkKilled: (code: number) => {
      const current = portCheck;
      portCheck = deferred<SpawnResult>();
      current.resolve({ ...result('', code), timedOut: true });
    },
    exit: (code: number) => {
      const current = exit;
      exit = deferred<SpawnResult>();
      current.resolve(result(String(code)));
    },
  };
}

function fakeEngine() {
  const attached: { id: string; logs: boolean; terminal: Duplex; typed: string[] }[] = [];
  const resized: [string, number, number][] = [];
  const engine: PreviewEngine = {
    async attach(id, logs) {
      const typed: string[] = [];
      const terminal = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          typed.push(chunk.toString());
          done();
        },
      });
      attached.push({ id, logs, terminal, typed });
      return terminal;
    },
    async resize(id, rows, cols) {
      resized.push([id, rows, cols]);
    },
  };
  return { engine, attached, resized };
}

function start(files: Record<string, string>, recipe: string, docker = fakeDocker(), engine = fakeEngine()) {
  const controller = new AbortController();
  const preview = startContainerPreview({
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    executables: new Set(),
    recipe,
    signal: controller.signal,
    owner,
    docker: async () => docker.docker,
    engine: () => engine.engine,
  });
  const events: PreviewTerminalEvent[] = [];
  preview.terminal.subscribe((e) => events.push(e));
  const screen = () =>
    events
      .filter((e): e is Extract<PreviewTerminalEvent, { type: 'output' }> => e.type === 'output')
      .map((e) => Buffer.from(e.data, 'base64').toString())
      .join('');
  const phases = () => events.flatMap((e) => (e.type === 'phase' ? [e.phase] : []));
  return { preview, controller, events, screen, phases, docker, engine };
}

const pythonApp = {
  Dockerfile: 'FROM python:3.13-slim\nCOPY app.py .\nCMD ["python","app.py"]\n',
  'app.py': 'print(1)',
  'docs/readme.md': '# hi',
};

describe('a Dockerfile project', () => {
  it('builds from the snapshot alone, checks the limits on the forwarder first, then attaches before the app starts', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    const calls = s.docker.calls.map((c) => c.args);
    const build = s.docker.calls.find((c) => c.args[1] === 'build')!;
    expect(build.args).toEqual(
      expect.arrayContaining(['--label', 'io.harness-relay.preview.owner=' + owner, '-f', 'Dockerfile', '--progress=plain', '--load']),
    );
    // On a builder of Relay's own, made once on the pinned engine: never the user's default one.
    const builderName = build.args[build.args.indexOf('--builder') + 1]!;
    expect(builderName).toMatch(/^harness-relay-preview-[0-9a-f]{12}$/);
    expect(s.docker.calls.find((c) => c.args[1] === 'create')!.args).toEqual(
      expect.arrayContaining(['buildx', 'create', '--name', builderName, '--driver', 'docker-container', '--bootstrap']),
    );
    expect(build.args.at(-1)).toBe('-');
    expect(build.args.join(' ')).toMatch(/--label io\.harness-relay\.preview\.session=relay-preview-[0-9a-f]{16}/);
    expect(build.args.join(' ')).not.toMatch(/\/Users|\/home|\\\\/);
    expect(Object.keys(tarNames(build.options.stdin as Buffer)).sort()).toEqual(['Dockerfile', 'app.py', 'docs/readme.md']);
    // Docker's own progress reaches the terminal, as terminal lines.
    expect(s.screen()).toContain('#1 building\r\n');

    const steps = calls
      .filter((a) => ['compose', 'exec', 'start'].includes(a[0]!) && !a.includes('version'))
      .map((a) => a.slice(a.indexOf('up') >= 0 ? a.indexOf('up') : 0).join(' '));
    expect(steps.slice(0, 4)).toEqual([
      `up -d --no-build ${FORWARDER}`,
      expect.stringMatching(/^exec f{64} \/usr\/local\/bin\/node --input-type=module -e [\s\S]*cgroup[\s\S]* 1073741824 256$/),
      'up --no-start --no-build',
      'up -d --no-build',
    ]);
    const compose = s.docker.calls.find((c) => c.args[0] === 'compose' && c.args.includes('up'))!;
    expect(compose.args.slice(0, 7)).toEqual([
      'compose',
      '-p',
      expect.stringMatching(/^relay-preview-/),
      '-f',
      '-',
      '--project-directory',
      compose.options.cwd,
    ]);
    const model = JSON.parse(String(compose.options.stdin));
    expect(model.services.app).toMatchObject({
      image: expect.stringMatching(/:build$/),
      environment: { PORT: '8000' },
      network_mode: `service:${FORWARDER}`,
    });
    // Attached (with what it wrote so far) before `up -d` started it, then sized to the panel.
    expect(s.engine.attached.map((a) => [a.id, a.logs])).toEqual([[mainIds[0], true]]);
    const attachedAt = s.docker.calls.findIndex((c) => c.args.join(' ').includes('com.docker.compose.service=app'));
    const startedAt = s.docker.calls.findIndex((c) => c.args.includes('-d') && !c.args.includes(FORWARDER));
    expect(attachedAt).toBeLessThan(startedAt);
    expect(s.engine.resized).toEqual([[mainIds[0], 30, 100]]);
    expect(s.events).toContainEqual({ type: 'phase', phase: 'running', command: 'python app.py' });
    expect(s.phases()).toEqual(['building', 'starting', 'running']);
    await s.preview.stop();
  });

  it('opens its page once the port answers, forwards to the EXPOSEd port, and reports how it exited', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    expect((await s.preview.request(new Request('http://preview/'))).status).toBe(503);
    s.docker.openPort();
    await expect.poll(() => s.events.some((e) => e.type === 'page')).toBe(true);
    const page = await s.preview.request(new Request('http://preview/'));
    expect(await page.text()).toBe('<h1>App</h1>');
    const forwarded = s.docker.calls.find((c) => c.args.includes('-i') && c.args.at(-1) !== '30')!.args;
    expect(forwarded.slice(0, 3)).toEqual(['exec', '-i', forwarderId]);
    expect(forwarded.at(-1)).toBe('8000');
    s.engine.attached[0]!.terminal.push('bye\r\n');
    s.docker.exit(3);
    await expect.poll(() => s.events.at(-1)).toEqual({ type: 'phase', phase: 'exited', code: 3 });
    expect(s.screen()).toContain('bye');
    expect(s.engine.attached[0]!.terminal.destroyed).toBe(true);
    expect(s.preview.terminal.input('x')).toBe(false);
    await s.preview.stop();
  });

  it('types into the running app, keeps its size within bounds, and runs it again with a command line', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    expect(s.preview.terminal.input('Relay\r')).toBe(true);
    expect(s.engine.attached[0]!.typed).toEqual(['Relay\r']);
    await s.preview.terminal.resize(5000, 1);
    expect(s.engine.resized.at(-1)).toEqual([mainIds[0], 4, 500]);
    await expect(withLang('en', () => s.preview.terminal.run('echo "open'))).rejects.toMatchObject({ status: 400 });
    await s.preview.terminal.run('python app.py --debug "two words"');
    const recreate = s.docker.calls.find((c) => c.args.includes('--force-recreate'))!;
    expect(recreate.args.slice(-6)).toEqual(['up', '--no-start', '--no-build', '--no-deps', '--force-recreate', 'app']);
    expect(JSON.parse(String(recreate.options.stdin)).services.app).toMatchObject({
      entrypoint: ['python'],
      command: ['app.py', '--debug', 'two words'],
    });
    // The new container: attached first, then started by itself, then sized like the last one.
    expect(s.engine.attached.map((a) => a.id)).toEqual(mainIds.slice(0, 2));
    expect(s.docker.calls.at(-1)?.args[0]).not.toBe('start');
    expect(s.docker.calls.some((c) => c.args.join(' ') === `start ${mainIds[1]}`)).toBe(true);
    expect(s.engine.resized.at(-1)).toEqual([mainIds[1], 4, 500]);
    expect(s.engine.attached[0]!.terminal.destroyed).toBe(true);
    await s.preview.stop();
  });

  it('replays the terminal so far and the current state to a stream that joins later', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    s.engine.attached[0]!.terminal.push('Your name? ');
    s.docker.openPort();
    await expect.poll(() => s.events.some((e) => e.type === 'page')).toBe(true);
    const late: PreviewTerminalEvent[] = [];
    s.preview.terminal.subscribe((e) => late.push(e));
    expect(late[0]).toMatchObject({ type: 'output', replay: true });
    expect(Buffer.from((late[0] as { data: string }).data, 'base64').toString()).toMatch(/#1 building[\s\S]*Your name\? $/);
    expect(late.slice(1)).toEqual([{ type: 'phase', phase: 'running', command: 'python app.py' }, { type: 'page' }]);
    await s.preview.stop();
  });

  it('says why a build failed, removes what it made, and refuses to run again', async () => {
    const docker = fakeDocker({ buildFails: true });
    const s = withLang('en', () => start(pythonApp, 'Dockerfile', docker));
    await expect.poll(() => s.phases().at(-1)).toBe('failed');
    expect(s.events.at(-1)).toMatchObject({ phase: 'failed', error: expect.stringContaining('RUN pip install failed') });
    expect(s.screen()).toContain('\x1b[31m');
    await expect
      .poll(() =>
        s.docker.calls.some((c) => c.args.join(' ').includes('ps -aq --no-trunc --filter label=io.harness-relay.preview.session=')),
      )
      .toBe(true);
    expect(s.docker.calls.some((c) => c.args[0] === 'compose' && c.args.includes('up'))).toBe(false);
    await expect(s.preview.terminal.run()).rejects.toMatchObject({ status: 409 });
    await s.preview.stop();
  });

  it('asks for Docker Compose v2 when the engine has none', async () => {
    const s = withLang('en', () => start(pythonApp, 'Dockerfile', fakeDocker({ noCompose: true })));
    await expect.poll(() => s.phases().at(-1)).toBe('failed');
    expect(s.screen()).toContain('needs Docker Compose v2');
    expect(s.docker.calls.some((c) => c.args[1] === 'build')).toBe(false);
  });

  it('closes its terminal and removes everything its session made when it stops', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    await s.preview.stop();
    expect(s.events.at(-1)).toEqual({ type: 'closed' });
    const swept = s.docker.calls
      .map((c) => c.args.join(' '))
      .filter((a) => a.includes('label=io.harness-relay.preview.session=relay-preview-'));
    expect(swept.map((a) => a.split(' --filter')[0])).toEqual([
      'ps -aq --no-trunc',
      'network ls -q --no-trunc',
      'volume ls -q',
      'image ls -q --no-trunc',
    ]);
    expect(s.engine.attached[0]!.terminal.destroyed).toBe(true);
    const after: PreviewTerminalEvent[] = [];
    s.preview.terminal.subscribe((e) => after.push(e));
    expect(after).toEqual([{ type: 'closed' }]);
    expect((await s.preview.request(new Request('http://preview/'))).status).toBe(410);
  });
});

describe('a compose project', () => {
  it('refuses a file that reaches the host before anything reaches Docker', () => {
    const docker = fakeDocker();
    expect(() =>
      withLang('en', () => start({ 'compose.yaml': 'services:\n  a:\n    image: x\n    privileged: true' }, 'compose.yaml', docker)),
    ).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('a.privileged') }));
    expect(docker.calls).toEqual([]);
  });

  it('builds each service from its own folder, copies mounted project files into the created containers, and serves the published port', async () => {
    const s = start(
      {
        'compose.yaml':
          'services:\n  web:\n    build: ./web\n    ports: ["8080:80"]\n    volumes: ["./web/greeting.txt:/srv/greeting.txt:ro"]\n  db:\n    image: postgres:16\n    volumes: ["./db:/docker-entrypoint-initdb.d"]\n',
        'web/Dockerfile': 'FROM python:3.13-slim\n',
        'web/greeting.txt': 'hi',
        'db/init.sql': 'create table t ();',
        'other/secret-ish.txt': 'not for web',
      },
      'compose.yaml',
    );
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    const builds = s.docker.calls.filter((c) => c.args[1] === 'build');
    expect(builds.map((b) => tarNames(b.options.stdin as Buffer))).toEqual([
      { Dockerfile: 'FROM python:3.13-slim\n', 'greeting.txt': 'hi' },
    ]);
    // No image derived from another (its ONBUILD steps would run): the files go into the created
    // containers, at their targets, with docker cp, which runs nothing; the main one's before it starts.
    const copies = s.docker.calls.filter((c) => c.args[0] === 'cp');
    expect(copies.map((c) => [c.args, tarNames(c.options.stdin as Buffer)])).toEqual([
      [['cp', '-', dbId + ':/'], { 'docker-entrypoint-initdb.d/init.sql': 'create table t ();' }],
      [['cp', '-', mainIds[0] + ':/'], { 'srv/greeting.txt': 'hi' }],
    ]);
    const calls = s.docker.calls.map((c) => c.args.join(' '));
    expect(calls.findIndex((a) => a.startsWith('cp - ' + mainIds[0]))).toBeLessThan(calls.findIndex((a) => a.endsWith('up -d --no-build')));
    // A port the file publishes: nothing to inspect, no PORT set.
    expect(s.docker.calls.some((c) => c.args[0] === 'image')).toBe(false);
    const model = JSON.parse(String(s.docker.calls.find((c) => c.args[0] === 'compose' && c.args.includes('up'))!.options.stdin));
    expect(model.services.web).toMatchObject({ image: expect.stringMatching(/-0:build$/), environment: {} });
    expect(model.services.db).toMatchObject({ image: 'postgres:16', pull_policy: 'missing', networks: ['relay'] });
    // A run again recreates the main container: its files go in again.
    await s.preview.terminal.run();
    expect(s.docker.calls.filter((c) => c.args[0] === 'cp').at(-1)!.args).toEqual(['cp', '-', mainIds[1] + ':/']);
    s.docker.openPort();
    await expect.poll(() => s.events.some((e) => e.type === 'page')).toBe(true);
    await s.preview.request(new Request('http://preview/'));
    expect(s.docker.calls.find((c) => c.args.includes('-i') && c.args.at(-1) !== '30')!.args.at(-1)).toBe('80');
    await s.preview.stop();
  });
});

it('shows a command line quoted where a word needs it', () => {
  expect(shownCommand(['python', 'app.py', '--name', 'two words', "it's", '$HOME'])).toBe(
    `python app.py --name 'two words' 'it'\\''s' '$HOME'`,
  );
});

describe('what the review found', () => {
  it('uses the builder it made before, and refuses one on another engine', async () => {
    const again = start(pythonApp, 'Dockerfile', fakeDocker({ builder: 'unix:///var/run/docker.sock' }));
    await expect.poll(() => again.phases().at(-1)).toBe('running');
    expect(again.docker.calls.some((c) => c.args[1] === 'create')).toBe(false);
    await again.preview.stop();
    const other = withLang('en', () => start(pythonApp, 'Dockerfile', fakeDocker({ builder: 'tcp://build.example:2376' })));
    await expect.poll(() => other.phases().at(-1)).toBe('failed');
    expect(other.screen()).toMatch(/is on another Docker engine/);
    expect(other.docker.calls.some((c) => c.args[1] === 'build')).toBe(false);
    const none = withLang('en', () => start(pythonApp, 'Dockerfile', fakeDocker({ noBuildx: true })));
    await expect.poll(() => none.phases().at(-1)).toBe('failed');
    expect(none.screen()).toContain('needs Docker buildx');
  });

  it('asks again whether the port is up every half minute, one check at a time', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    const checks = () => s.docker.calls.filter((c) => c.args[0] === 'exec' && c.args.at(-1) === '30');
    await expect.poll(() => checks().length).toBe(1);
    expect(checks()[0]!.args.slice(-2)).toEqual(['8000', '30']);
    // Held open, so that the check in the container ends when Relay stops waiting.
    expect(checks()[0]!.args.slice(0, 3)).toEqual(['exec', '-i', forwarderId]);
    expect(checks()[0]!.options).toMatchObject({ keepStdinOpen: true });
    s.docker.checkTimesOut();
    await expect.poll(() => checks().length).toBe(2);
    expect(s.events.some((e) => e.type === 'page')).toBe(false);
    s.docker.openPort();
    await expect.poll(() => s.events.some((e) => e.type === 'page')).toBe(true);
    expect(checks()).toHaveLength(2);
    await s.preview.stop();
  });

  it('asks again after a check its own time limit stopped, whatever exit code that left', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    const checks = () => s.docker.calls.filter((c) => c.args[0] === 'exec' && c.args.at(-1) === '30');
    await expect.poll(() => checks().length).toBe(1);
    // A killed `docker exec` may say 0: that is not the port answering.
    s.docker.checkKilled(0);
    await expect.poll(() => checks().length).toBe(2);
    expect(s.events.some((e) => e.type === 'page')).toBe(false);
    // Nor does any other code end the watch.
    s.docker.checkKilled(143);
    await expect.poll(() => checks().length).toBe(3);
    s.docker.openPort();
    await expect.poll(() => s.events.some((e) => e.type === 'page')).toBe(true);
    await s.preview.stop();
  });

  it('keeps the services and their data when a run with another command cannot start, and lets it run again', async () => {
    const docker = fakeDocker({ startFails: (id) => id === mainIds[1] });
    const s = withLang('en', () => start(pythonApp, 'Dockerfile', docker));
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    await withLang('en', () => s.preview.terminal.run('pyton app.py'));
    expect(s.events.at(-1)).toMatchObject({ type: 'phase', phase: 'exited', code: -1, error: expect.stringContaining('pyton') });
    expect(s.docker.calls.some((c) => c.args.join(' ').includes('label=io.harness-relay.preview.session='))).toBe(false);
    // Busy while it starts, free again after.
    const pending = s.preview.terminal.run();
    await expect(withLang('en', () => s.preview.terminal.run())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('starting'),
    });
    await pending;
    expect(s.phases().at(-1)).toBe('running');
    await s.preview.stop();
    await expect(withLang('en', () => s.preview.terminal.run())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Rebuild'),
    });
  });

  it('reads the EXPOSE of a main service that is only an image, pulling it first, and needs no builder', async () => {
    const s = start(
      { 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27\n' },
      'compose.yaml',
      fakeDocker({ exposed: '{"80/tcp":{}}' }),
    );
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    const calls = s.docker.calls.map((c) => c.args.join(' '));
    expect(calls.indexOf('pull nginx:1.27')).toBeGreaterThan(-1);
    // Looked for first, pulled since the engine does not have it, then read.
    expect(calls.indexOf('image inspect --format {{.Id}} nginx:1.27')).toBeLessThan(calls.indexOf('pull nginx:1.27'));
    expect(calls.indexOf('pull nginx:1.27')).toBeLessThan(calls.findIndex((a) => a.includes('ExposedPorts')));
    expect(calls.some((a) => a.startsWith('buildx'))).toBe(false);
    const model = JSON.parse(String(s.docker.calls.find((c) => c.args[0] === 'compose' && c.args.includes('up'))!.options.stdin));
    expect(model.services.web.environment).toEqual({ PORT: '80' });
    await s.preview.stop();
  });

  it('stops a build in progress without starting anything', async () => {
    const gate = deferred<void>();
    const docker = fakeDocker();
    const inner = docker.docker;
    docker.docker = Object.assign(
      async (args: string[], options: DockerOptions = {}) => {
        if (args[1] === 'build') {
          docker.calls.push({ args, options });
          await gate.promise;
          return { ...result('', 1), aborted: true };
        }
        return inner(args, options);
      },
      { endpoint: inner.endpoint },
    );
    const s = start(pythonApp, 'Dockerfile', docker);
    await expect.poll(() => docker.calls.some((c) => c.args[1] === 'build')).toBe(true);
    const stopping = s.preview.stop();
    gate.resolve();
    await stopping;
    expect(docker.calls.some((c) => c.args[0] === 'compose' && c.args.includes('up'))).toBe(false);
    expect(s.events.at(-1)).toEqual({ type: 'closed' });
    expect(s.phases()).not.toContain('starting');
  });

  it('sweeps once when a failure and a stop come together, and stops even when the engine is gone', async () => {
    const docker = fakeDocker({ buildFails: true });
    const inner = docker.docker;
    const gate = deferred<void>();
    // The failure's sweep is still listing containers when the user stops the preview.
    docker.docker = Object.assign(
      async (args: string[], options: DockerOptions = {}) => {
        if (args[0] === 'ps' && args.includes('-aq')) await gate.promise;
        return inner(args, options);
      },
      { endpoint: inner.endpoint },
    );
    const s = start(pythonApp, 'Dockerfile', docker);
    await expect.poll(() => s.phases().at(-1)).toBe('failed');
    const stopping = s.preview.stop();
    gate.resolve();
    await stopping;
    expect(docker.calls.filter((c) => c.args[0] === 'ps' && c.args.includes('-aq'))).toHaveLength(1);
    const gone = start(pythonApp, 'Dockerfile', fakeDocker({ sweepFails: true }));
    await expect.poll(() => gone.phases().at(-1)).toBe('running');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(gone.preview.stop()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('picks the terminal up again, without its history, when the connection drops while the app runs', async () => {
    const s = start(pythonApp, 'Dockerfile');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    s.engine.attached[0]!.terminal.destroy();
    await expect.poll(() => s.engine.attached.length).toBe(2);
    expect(s.engine.attached[1]).toMatchObject({ id: mainIds[0], logs: false });
    s.engine.attached[1]!.terminal.push('still here');
    await expect.poll(() => s.screen()).toContain('still here');
    expect(s.preview.terminal.input('x')).toBe(true);
    expect(s.engine.attached[1]!.typed).toEqual(['x']);
    await s.preview.stop();
  });
});

describe('what the second review found', () => {
  it('makes Relay’s builder once when two previews start together on a fresh engine', async () => {
    const docker = fakeDocker();
    const a = start(pythonApp, 'Dockerfile', docker);
    const b = start(pythonApp, 'Dockerfile', docker);
    await expect.poll(() => [a.phases().at(-1), b.phases().at(-1)]).toEqual(['running', 'running']);
    expect(docker.calls.filter((c) => c.args[0] === 'buildx' && c.args[1] === 'create')).toHaveLength(1);
    await Promise.all([a.preview.stop(), b.preview.stop()]);
  });

  it('uses an image the engine already has without pulling it', async () => {
    const s = start(
      { 'compose.yaml': 'services:\n  tool:\n    image: local-only:1\n' },
      'compose.yaml',
      fakeDocker({ imagePresent: true }),
    );
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    expect(s.docker.calls.some((c) => c.args[0] === 'pull')).toBe(false);
    await s.preview.stop();
  });

  it('never takes a database’s open port for a page', async () => {
    const s = start({ 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n' }, 'docker-compose.yml');
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.docker.calls.some((c) => c.args[0] === 'exec' && c.args.at(-1) === '30')).toBe(false);
    await s.preview.stop();
  });

  it('closes the terminal of a run that could not start', async () => {
    const s = withLang('en', () => start(pythonApp, 'Dockerfile', fakeDocker({ startFails: (id) => id === mainIds[1] })));
    await expect.poll(() => s.phases().at(-1)).toBe('running');
    await s.preview.terminal.run('pyton app.py');
    expect(s.engine.attached[1]!.terminal.destroyed).toBe(true);
    await s.preview.stop();
  });
});
