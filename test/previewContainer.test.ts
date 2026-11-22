import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { PreviewTerminalEvent } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { shownCommand, startContainerPreview } from '../src/server/previewContainer';
import { FORWARDER } from '../src/server/previewCompose';
import type { Docker, DockerOptions } from '../src/server/previewDocker';
import type { PreviewEngine } from '../src/server/previewEngine';
import type { SpawnResult } from '../src/server/process';

const owner = 'b'.repeat(64);
const forwarderId = 'f'.repeat(64);
const mainIds = ['a'.repeat(64), 'c'.repeat(64)];

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
function fakeDocker(o: { buildFails?: boolean; noCompose?: boolean; exposed?: string } = {}) {
  const calls: { args: string[]; options: DockerOptions }[] = [];
  const portOpen = deferred<SpawnResult>();
  let exit = deferred<SpawnResult>();
  let created = 0;
  const docker: Docker = async (args, options = {}) => {
    calls.push({ args, options });
    const joined = args.join(' ');
    if (args[0] === 'info') return result('linux arm64');
    if (joined === 'compose version --short')
      return o.noCompose ? result('', 1, "docker: 'compose' is not a docker command.") : result('2.30.3');
    if (args[0] === 'build') {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      options.onSpawn?.(child as unknown as ChildProcess);
      child.stderr.emit('data', Buffer.from('#1 building\n'));
      return o.buildFails ? result('', 1, 'RUN pip install failed') : result();
    }
    if (joined.startsWith('image inspect')) return result(o.exposed ?? '{"8000/tcp":{}}');
    if (args[0] === 'compose') {
      if (args.includes('--force-recreate')) created++;
      return result();
    }
    if (args[0] === 'ps') {
      if (joined.includes('com.docker.compose.service=' + FORWARDER)) return result(forwarderId);
      if (joined.includes('com.docker.compose.service=')) return result(mainIds[created]!);
      return result(''); // sweeps
    }
    if (args[0] === 'exec' && args.includes('-i')) {
      return result('{"status":200,"headers":{"content-type":"text/html"}}\n<h1>App</h1>');
    }
    if (args[0] === 'exec' && args.at(-1) === '256') return result('arm64');
    if (args[0] === 'exec') return portOpen.promise;
    if (args[0] === 'inspect') return result('["python"]\n["app.py"]');
    if (args[0] === 'wait') return exit.promise;
    if (args.includes('ls')) return result('');
    return result();
  };
  docker.endpoint = 'unix:///var/run/docker.sock';
  return {
    docker,
    calls,
    openPort: () => portOpen.resolve(result()),
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
    const build = s.docker.calls.find((c) => c.args[0] === 'build')!;
    expect(build.args).toEqual(
      expect.arrayContaining(['--label', 'io.harness-relay.preview.owner=' + owner, '-f', 'Dockerfile', '--progress=plain']),
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
    const forwarded = s.docker.calls.find((c) => c.args.includes('-i'))!.args;
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
    expect(s.engine.attached.map((a) => a.id)).toEqual(mainIds);
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
    expect(s.docker.calls.some((c) => c.args[0] === 'build')).toBe(false);
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

  it('builds each service from its own folder, copies mounted project files into a derived image, and serves the published port', async () => {
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
    const builds = s.docker.calls.filter((c) => c.args[0] === 'build');
    expect(builds.map((b) => tarNames(b.options.stdin as Buffer))).toEqual([
      { Dockerfile: 'FROM python:3.13-slim\n', 'greeting.txt': 'hi' },
      {
        Dockerfile: expect.stringMatching(
          /^FROM relay-preview-[0-9a-f]+-0:build\nCOPY \["relay-mount-0\/greeting.txt","\/srv\/greeting.txt"\]\n$/,
        ),
        'relay-mount-0/greeting.txt': 'hi',
      },
      {
        Dockerfile: 'FROM postgres:16\nCOPY ["relay-mount-0/","/docker-entrypoint-initdb.d/"]\n',
        'relay-mount-0/init.sql': 'create table t ();',
      },
    ]);
    // A port the file publishes: nothing to inspect, no PORT set.
    expect(s.docker.calls.some((c) => c.args[0] === 'image')).toBe(false);
    const model = JSON.parse(String(s.docker.calls.find((c) => c.args[0] === 'compose' && c.args.includes('up'))!.options.stdin));
    expect(model.services.web).toMatchObject({ image: expect.stringMatching(/-0:mounts$/), environment: {} });
    expect(model.services.db).toMatchObject({ image: expect.stringMatching(/-1:mounts$/), networks: ['relay'] });
    s.docker.openPort();
    await expect.poll(() => s.events.some((e) => e.type === 'page')).toBe(true);
    await s.preview.request(new Request('http://preview/'));
    expect(s.docker.calls.find((c) => c.args.includes('-i'))!.args.at(-1)).toBe('80');
    await s.preview.stop();
  });
});

it('shows a command line quoted where a word needs it', () => {
  expect(shownCommand(['python', 'app.py', '--name', 'two words', "it's", '$HOME'])).toBe(
    `python app.py --name 'two words' 'it'\\''s' '$HOME'`,
  );
});
