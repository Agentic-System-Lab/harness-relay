import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WAIT_PORT } from '../src/server/previewDockerWire';
import { slow } from './timeouts';

// The port check runs in the forwarder as `node --input-type=module -e WAIT_PORT <port> <seconds>`,
// with its stdin held open by Relay while it waits. Here it runs on this computer's Node.

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function listen(port = 0): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

/** A port nothing listens on: one that was free a moment ago. */
async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((resolve) => servers.pop()!.close(resolve));
  return port;
}

function waitPort(port: number, seconds: number, closeStdin = false): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', WAIT_PORT, String(port), String(seconds)], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (closeStdin) child.stdin.end();
  return new Promise((resolve) =>
    child.on('exit', (code) => {
      child.stdin.destroy();
      resolve({ code, ms: Date.now() - started });
    }),
  );
}

it('ends with 0 as soon as the port answers, though Relay still holds its stdin open', async () => {
  const port = await listen();
  const { code, ms } = await waitPort(port, 30);
  expect(code).toBe(0);
  expect(ms).toBeLessThan(slow(5000));
});

it('keeps trying until the app starts listening', async () => {
  const port = await freePort();
  const waiting = waitPort(port, 30);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await listen(port);
  expect((await waiting).code).toBe(0);
});

it('ends with 3 when the port stays closed past its time, for Relay to ask again', async () => {
  const { code } = await waitPort(await freePort(), 1);
  expect(code).toBe(3);
});

it('ends with 4 when Relay stops waiting and closes its stdin', async () => {
  const { code, ms } = await waitPort(await freePort(), 30, true);
  expect(code).toBe(4);
  expect(ms).toBeLessThan(slow(5000));
});
