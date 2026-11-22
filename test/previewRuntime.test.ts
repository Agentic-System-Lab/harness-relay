import { beforeEach, expect, it, vi } from 'vitest';
import type { SpawnOptions, SpawnResult } from '../src/server/process';
import { cleanupPreviewRuntimes, startPreviewRuntime } from '../src/server/previewRuntime';
import { runProcess } from '../src/server/process';
import { isProgram } from '../src/server/executable';
import { decodePreviewFiles, encodePreviewFiles } from '../src/server/previewDockerWire';

vi.mock('../src/server/process', async (load) => ({ ...(await load<typeof import('../src/server/process')>()), runProcess: vi.fn() }));
vi.mock('../src/server/executable', async (load) => ({ ...(await load<typeof import('../src/server/executable')>()), isProgram: vi.fn() }));
const command = vi.mocked(runProcess);
const id = 'a'.repeat(64);
const owner = 'b'.repeat(32);
const opts = () => ({
  files: new Map([
    ['package.json', Buffer.from('{"scripts":{"build":"vite build","start":"node server.js"}}')],
    ['package-lock.json', Buffer.from('{"lockfileVersion":3,"packages":{"":{}}}')],
  ]),
  mode: 'build' as const,
  signal: new AbortController().signal,
  owner,
});
function result(stdout: string | Buffer = '', code = 0, stderr = ''): SpawnResult {
  const bytes = Buffer.from(stdout);
  return {
    stdout: bytes.toString(),
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
function docker(o: SpawnOptions): SpawnResult {
  const a = o.args;
  if (a.includes('context')) return result(process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
  if (a.includes('info')) return result('linux arm64');
  if (a.includes('create')) return result(id);
  if (a.some((arg) => arg.includes('cpu.max'))) return result('arm64');
  if (a.some((arg) => arg.includes('readdirSync'))) return result(encodePreviewFiles(new Map([['index.html', Buffer.from('built')]])));
  return result();
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('DOCKER_HOST', '');
  vi.mocked(isProgram).mockReturnValue(true);
  command.mockReset().mockImplementation(async (o) => docker(o));
});
it('runs builds on an immutable private Linux container then removes it before serving the public output', async () => {
  const runtime = await startPreviewRuntime(opts());
  const commands = command.mock.calls.map(([o]) => o.args);
  const create = commands.find((a) => a.includes('create'))!;
  expect(create).toEqual(
    expect.arrayContaining([
      '--read-only',
      '--network=none',
      '--cap-drop=ALL',
      '--user=1000:1000',
      '--security-opt=no-new-privileges',
      '--pids-limit=96',
      '--cpus=1',
      '--memory=768m',
      expect.stringMatching(/^docker.io\/library\/node@sha256:[0-9a-f]{64}$/),
    ]),
  );
  expect(create.join(' ')).not.toMatch(/(?:--mount|--publish|--volume)[ =]/);
  expect(commands.findIndex((a) => a.some((arg) => arg.includes('cpu.max')))).toBeLessThan(commands.findIndex((a) => a.includes('ci')));
  expect(commands).toContainEqual(expect.arrayContaining(['ci', '--offline']));
  expect(commands.some((a) => a.some((arg) => arg.startsWith('--workspace')))).toBe(false);
  expect(commands).toContainEqual(expect.arrayContaining([expect.stringContaining('readdirSync'), '/work/app/dist']));
  expect(commands.at(-1)).toEqual(expect.arrayContaining(['rm', '-f', id]));
  expect(await (await runtime.request(new Request('http://preview/'))).text()).toBe('built');
  await runtime.stop();
});
it('installs a workspace member with the root’s dependencies and runs its own script and output', async () => {
  const files = new Map([
    ['package.json', Buffer.from('{"workspaces":["apps/*"]}')],
    [
      'package-lock.json',
      Buffer.from('{"lockfileVersion":3,"packages":{"":{},"apps/web":{},"node_modules/web":{"resolved":"apps/web","link":true}}}'),
    ],
    ['apps/web/package.json', Buffer.from('{"scripts":{"build":"vite build"}}')],
  ]);
  const runtime = await startPreviewRuntime({ ...opts(), files, workspace: 'apps/web' });
  const commands = command.mock.calls.map(([o]) => o.args);
  const member = '--workspace=/work/app/apps/web';
  expect(commands).toContainEqual(expect.arrayContaining(['ci', member, '--include-workspace-root', '--offline']));
  expect(commands).toContainEqual(expect.arrayContaining(['run', 'build', member]));
  expect(commands).toContainEqual(expect.arrayContaining([expect.stringContaining('readdirSync'), '/work/app/apps/web/dist']));
  expect(await (await runtime.request(new Request('http://preview/'))).text()).toBe('built');
  await runtime.stop();
});
it('cleans a container once a failed isolation check rules out running project code', async () => {
  command.mockImplementation(async (o) => (o.args.some((a) => a.includes('cpu.max')) ? result('', 1, 'CPU quota missing') : docker(o)));
  await expect(startPreviewRuntime(opts())).rejects.toThrow(/quota/);
  expect(command.mock.calls.some(([o]) => o.args.includes('ci'))).toBe(false);
  expect(command.mock.calls.at(-1)![0].args).toEqual(expect.arrayContaining(['rm', '-f', id]));
});
it('waits for a racing create to finish and then removes that exact container', async () => {
  const controller = new AbortController();
  command.mockImplementation(async (o) => {
    if (o.args.includes('create')) controller.abort();
    return docker(o);
  });
  await expect(startPreviewRuntime({ ...opts(), signal: controller.signal })).rejects.toThrow();
  expect(command.mock.calls.at(-1)![0].args).toEqual(expect.arrayContaining(['rm', '-f', id]));
  expect(command.mock.calls.some(([o]) => o.args.includes('start'))).toBe(false);
});
it('rejects remote engines before transferring a snapshot or creating a container', async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://example.org:2376');
  vi.stubEnv('DOCKER_CONTEXT', '');
  await expect(startPreviewRuntime(opts())).rejects.toThrow(/local Docker|本機通訊端/);
  expect(command.mock.calls.some(([o]) => o.args.includes('create'))).toBe(false);
});
it('explains a missing Docker engine and never executes npm on the host', async () => {
  vi.mocked(isProgram).mockReturnValue(false);
  await expect(startPreviewRuntime(opts())).rejects.toThrow(/Docker/);
  expect(command).not.toHaveBeenCalled();
});
it('sweeps only IDs returned by the persistent installation owner label, containers first, then their networks, volumes and images', async () => {
  const listed: Record<string, string> = { ps: id, network: 'net1', volume: 'relay-preview-x_data', image: 'sha256:' + 'c'.repeat(64) };
  command.mockImplementation(async (o) => {
    const kind = o.args.includes('ps') ? 'ps' : (['network', 'volume', 'image'].find((k) => o.args[2] === k) ?? '');
    return o.args.includes('ls') || o.args.includes('ps') ? result((listed[kind] ?? '') + '\n') : docker(o);
  });
  await cleanupPreviewRuntimes(owner);
  const calls = command.mock.calls.map(([o]) => o.args.slice(2));
  const filter = ['--filter', 'label=io.harness-relay.preview.owner=' + owner];
  for (const kind of ['network', 'volume', 'image']) expect(calls).toContainEqual(expect.arrayContaining([kind, 'ls', ...filter]));
  expect(calls.find((a) => a[0] === 'ps')).toEqual(expect.arrayContaining(filter));
  const removals = calls.filter((a) => a.includes('rm'));
  expect(removals).toEqual([
    ['rm', '-f', id],
    ['network', 'rm', 'net1'],
    ['volume', 'rm', '-f', 'relay-preview-x_data'],
    ['image', 'rm', '-f', 'sha256:' + 'c'.repeat(64)],
  ]);
});
it('refuses a listed name that could be read as an option before removing anything of its kind', async () => {
  command.mockImplementation(async (o) => (o.args.includes('ls') && o.args.includes('network') ? result('--force\n') : docker(o)));
  await expect(cleanupPreviewRuntimes(owner)).rejects.toThrow();
  expect(command.mock.calls.some(([o]) => o.args.includes('network') && o.args.includes('rm'))).toBe(false);
});
it('round trips exact bytes with Unicode names and refuses unsafe or malformed build output', () => {
  const files = new Map([['資 料/pic.png', Buffer.from([0, 13, 255, 254])]]);
  expect(decodePreviewFiles(encodePreviewFiles(files))).toEqual(files);
  expect(() => decodePreviewFiles(encodePreviewFiles(new Map([['../outside.html', Buffer.alloc(0)]])))).toThrow();
  expect(() => decodePreviewFiles(encodePreviewFiles(files).subarray(0, -1))).toThrow();
});
it('cancels a stalled browser upload before running a forwarding process', async () => {
  const { encodePreviewRequest } = await import('../src/server/previewDockerWire');
  const ctrl = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const req = new Request('http://preview/', { method: 'POST', body, duplex: 'half' } as RequestInit);
  const pending = encodePreviewRequest(req, ctrl.signal);
  ctrl.abort();
  await expect(pending).rejects.toThrow();
  expect(canceled).toBe(true);
}, 1000);

it('only transports the local path, application headers and binary body', async () => {
  const { encodePreviewRequest, decodePreviewResponse } = await import('../src/server/previewDockerWire');
  const bytes = Buffer.from([0, 10, 255]);
  const raw = await encodePreviewRequest(
    new Request('http://example.org/items?q=1', {
      method: 'POST',
      headers: { Authorization: 'Bearer x', Cookie: 'secret', 'Content-Type': 'image/png' },
      body: bytes,
    }),
  );
  const split = raw.indexOf(10);
  expect(JSON.parse(raw.subarray(0, split).toString())).toEqual({
    method: 'POST',
    path: '/items?q=1',
    headers: { 'content-type': 'image/png' },
  });
  expect(raw.subarray(split + 1)).toEqual(bytes);
  const payload = Buffer.concat([
    Buffer.from(JSON.stringify({ status: 201, headers: { 'set-cookie': 'other', 'content-type': 'image/png' } }) + '\n'),
    bytes,
  ]);
  const res = decodePreviewResponse(payload, 'POST');
  expect(res.status).toBe(201);
  expect(res.headers.get('set-cookie')).toBeNull();
  expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
});

it('includes the bounded tail of backend logs when the fixed port never becomes ready', async () => {
  command.mockImplementation(async (o) => {
    if (o.args.includes('/usr/local/bin/npm') && o.args.includes('start')) {
      return new Promise<SpawnResult>((resolve) =>
        o.signal!.addEventListener('abort', () => resolve({ ...result('x'.repeat(9000) + ' port configuration missing'), aborted: true }), {
          once: true,
        }),
      );
    }
    if (o.args.some((arg) => arg.includes('net.connect'))) return result('', 1, 'readiness failed');
    return docker(o);
  });
  const error = await startPreviewRuntime({ ...opts(), mode: 'server' }).catch((e) => e as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/port configuration missing/);
  expect((error as Error).message.length).toBeLessThan(2300);
  expect(command.mock.calls.at(-1)![0].args).toEqual(expect.arrayContaining(['rm', '-f', id]));
});

it.each([
  ['missing lockfile', null, 'package-lock.json'],
  ['malformed lockfile', '{', 'package-lock.json'],
  ['malformed manifest', '[', 'package.json'],
  ['unsupported lock format', '{"lockfileVersion":1}', 'package-lock.json'],
  ['unsupported dependency', '{"dependencies":{"demo":"file:../other"}}', 'package.json'],
  ['missing build script', '{}', 'package.json'],
] as const)('reports %s before invoking Docker, recording ownership or fetching an image', async (_case, value, file) => {
  const options = opts();
  if (value === null) options.files.delete(file);
  else options.files.set(file, Buffer.from(value));
  const beforeDocker = vi.fn(async () => {});
  await expect(startPreviewRuntime({ ...options, beforeDocker })).rejects.toThrow();
  expect(beforeDocker).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});
it('retains a failed start for retry when Docker fails to remove its container', async () => {
  let failures = 0;
  command.mockImplementation(async (o) => {
    if (o.args.some((a) => a.includes('cpu.max'))) return result('', 1, 'CPU quota missing');
    if (o.args.includes('rm') && ++failures === 1) return result('', 1, 'daemon unavailable');
    return docker(o);
  });
  const error = await startPreviewRuntime(opts()).catch((e) => e);
  expect(error.name).toBe('PreviewCleanupError');
  expect(error.message).toContain('CPU quota missing');
  expect(error.message).toContain('daemon unavailable');
  await Promise.all([error.stop(), error.stop()]);
  await error.stop();
  expect(failures).toBe(2);
});
it('retries a failed stop on a returned handle, accepting only actual disappearance of that ID', async () => {
  let attempts = 0;
  command.mockImplementation(async (o) => {
    if (o.args.includes('rm')) {
      attempts++;
      if (attempts === 1) return result('', 1, 'daemon unavailable: no such container metadata service');
      return result('', 1, 'Error response from daemon: No such container: ' + id);
    }
    if (o.args.includes('/usr/local/bin/npm') && o.args.includes('start')) {
      return new Promise<SpawnResult>((res) =>
        o.signal!.addEventListener('abort', () => res({ ...result(), aborted: true }), { once: true }),
      );
    }
    return docker(o);
  });
  const h = await startPreviewRuntime({ ...opts(), mode: 'server' });
  await expect(h.stop()).rejects.toThrow(/daemon unavailable/);
  await Promise.all([h.stop(), h.stop()]);
  await h.stop();
  expect(attempts).toBe(2);
});
it('transfers only the selected owner execute bits to the app snapshot', async () => {
  const options = opts();
  options.files.set('scripts/build.sh', Buffer.from('#!/bin/sh'));
  const beforeDocker = vi.fn(async () => {});
  await startPreviewRuntime({ ...options, beforeDocker, executables: new Set(['scripts/build.sh']) });
  expect(beforeDocker).toHaveBeenCalledOnce();
  const blob = command.mock.calls.find(([o]) => o.stdin)![0].stdin as Buffer;
  const executable: string[] = [];
  for (let i = 0; i < blob.length;) {
    const n = blob.readUInt32BE(i),
      size = blob.readUInt32BE(i + 4);
    const length = n & 0x7fffffff;
    if (n >= 0x80000000) executable.push(blob.toString('utf8', i + 8, i + 8 + length));
    i += 8 + length + size;
  }
  expect(executable).toEqual(['app/scripts/build.sh']);
});
