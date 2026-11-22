import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineSocket, previewEngine } from '../src/server/previewEngine';

const id = 'a'.repeat(64);

it('reaches only a local socket or named pipe, never a TCP address', () => {
  expect(engineSocket('unix:///Users/me/.orbstack/run/docker.sock')).toBe('/Users/me/.orbstack/run/docker.sock');
  expect(engineSocket('npipe:////./pipe/docker_engine')).toBe('\\\\.\\pipe\\docker_engine');
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://host', 'npipe:////server/pipe/docker_engine', 'unix://relative', '']) {
    expect(() => engineSocket(endpoint)).toThrow();
  }
  expect(() => previewEngine('tcp://example.org:2376')).toThrow();
});

describe.skipIf(process.platform === 'win32')('the Engine API over a Unix socket', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  const sockets = new Set<Duplex>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  /** A stand-in daemon: `upgrade` answers an attach (Node gives every request with Upgrade to it), the rest a resize. */
  async function engine(upgrade: (req: IncomingMessage, socket: Duplex) => void, seen: string[]) {
    dir = mkdtempSync(join(tmpdir(), 'relay-engine-'));
    const socket = join(dir, 'docker.sock');
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end();
    });
    server.on('connection', (s: Duplex) => sockets.add(s));
    server.on('upgrade', (req: IncomingMessage, sock: Duplex) => {
      seen.push(`${req.method} ${req.url} ${req.headers.upgrade}`);
      upgrade(req, sock);
    });
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
    return previewEngine('unix://' + socket);
  }

  it('attaches with an upgrade and carries terminal bytes both ways, with the history when asked', async () => {
    const seen: string[] = [];
    const docker = await engine((_req, sock) => {
      sock.write(
        'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nYour name? ',
      );
      sock.on('data', (chunk: Buffer) => sock.write('echo:' + chunk.toString()));
    }, seen);
    const terminal = await docker.attach(id, true);
    let screen = '';
    terminal.on('data', (chunk: Buffer) => (screen += chunk.toString()));
    terminal.write('Relay\r');
    await expect.poll(() => screen).toBe('Your name? echo:Relay\r');
    terminal.destroy();
    expect(seen[0]).toBe(`POST /containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=1 tcp`);
    (await docker.attach(id, false)).destroy();
    expect(seen[1]).toBe(`POST /containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1 tcp`);
  });

  it('says why Docker refused an attach, and resizes or quietly leaves a container that is gone', async () => {
    const seen: string[] = [];
    const docker = await engine((_req, sock) => {
      const body = '{"message":"container is not running"}';
      sock.end(`HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    }, seen);
    await expect(docker.attach(id, true)).rejects.toThrow(/container is not running/);
    await docker.resize(id, 40.4, 132.2);
    expect(seen.at(-1)).toBe(`POST /containers/${id}/resize?h=40&w=132`);
  });

  it('refuses a container ID that is not one before sending anything', async () => {
    const seen: string[] = [];
    const docker = await engine(() => {}, seen);
    await expect(docker.attach('../../images/create?fromImage=x', true)).rejects.toThrow();
    await expect(docker.resize('abc', 1, 1)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
