/*
 * `npm run dev`: the API server (`tsx watch`, restarted on every change) and Vite, which serves the UI
 * and proxies `/api/` to the API, run together by concurrently as before. Their ports are found here,
 * before either starts, so that both know them: the API's is `PORT`, else 8789 or the next free one;
 * Vite's is `RELAY_DEV_WEB_PORT`, else 5173 or the next free one (`src/server/ports.ts`). Both go to the
 * two in the environment: Vite takes exactly that port (`strictPort` in vite.config.ts) and proxies to
 * the API's, and the server prints its sign-in link for Vite's and keeps agents in the relay sandbox
 * from both. A port the environment names is taken as it is (0: any free one), and when it is in use,
 * nothing starts. A port counts as free when nothing listens on it at either loopback address (Vite
 * listens on the one `localhost` names, and its proxy and the browser connect to either), nor at `HOST`
 * for the API.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEV_API_PORT, DEV_WEB_PORT } from '../src/server/ports';

/** How many ports from 8789 and from 5173 are tried before giving up. */
export const DEV_PORT_TRIES = 20;

/** The addresses `localhost` may name. */
export const LOOPBACKS: readonly string[] = ['127.0.0.1', '::1'];

/** What concurrently runs, as `npm run dev` always ran it. */
export const DEV_COMMAND: readonly string[] = [
  '-k',
  '-n',
  'server,web',
  '-c',
  'blue,magenta',
  'tsx watch --clear-screen=false src/server/index.ts',
  'vite',
];

/** A port refused or not found: said as it is, and nothing starts. */
export class DevPortError extends Error {}

/**
 * Whether a port can be listened on at an address: `taken` when something listens there (or it may
 * not be taken: `EACCES`), `absent` when the address is not this computer's (no IPv6, say), which is
 * then not in the way.
 */
export function tryListen(port: number, host: string): Promise<'free' | 'taken' | 'absent'> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) =>
      done(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' ? 'absent' : 'taken'),
    );
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => done('free')));
  });
}

/** Whether nothing listens on a port at any of these addresses. */
export async function portFree(port: number, hosts: readonly string[]): Promise<boolean> {
  for (const host of hosts) if ((await tryListen(port, host)) === 'taken') return false;
  return true;
}

/** A port the system gives as free (on 127.0.0.1), for a port of 0. */
export function systemPort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

/** A port the environment names: none when unset or blank, else a whole number from 0 to 65535. */
export function envPort(name: string, value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) {
    throw new DevPortError(`${name}=${value} is not a port: give a whole number from 0 to 65535, or leave it out.`);
  }
  return Number(text);
}

export interface PortWanted {
  /** Who listens on it, as a message names it. */
  label: string;
  /** The environment variable that names it. */
  name: string;
  /** The port the environment names, if it does. */
  wanted?: number;
  /** Where to look from when it does not. */
  from: number;
  /** The addresses it must be free at. */
  hosts: readonly string[];
  /** Ports it may not be (the other one's). */
  avoid: readonly number[];
}

export interface PortDeps {
  free: (port: number, hosts: readonly string[]) => Promise<boolean>;
  system: () => Promise<number>;
}

const REAL: PortDeps = { free: portFree, system: systemPort };

/**
 * The port for one of the two: the one the environment names, taken as it is when it is free (0: one
 * the system gives), else `from` or the next free one within `DEV_PORT_TRIES`, never one in `avoid`.
 */
export async function pickPort(o: PortWanted, deps: PortDeps = REAL): Promise<number> {
  if (o.wanted === 0) {
    for (let i = 0; i < DEV_PORT_TRIES; i++) {
      const port = await deps.system();
      if (!o.avoid.includes(port) && (await deps.free(port, o.hosts))) return port;
    }
    throw new DevPortError(`No free port for ${o.label} (${o.name}=0): set ${o.name} to one that is free.`);
  }
  if (o.wanted !== undefined) {
    if (o.avoid.includes(o.wanted)) throw new DevPortError(`${o.name}=${o.wanted} is the API's port (PORT): choose another.`);
    if (!(await deps.free(o.wanted, o.hosts))) {
      throw new DevPortError(
        `Port ${o.wanted} (${o.name}) is in use: another program, or another Harness Relay, listens there. ` +
          `Choose another ${o.name}, or leave it out to take the first free port from ${o.from}.`,
      );
    }
    return o.wanted;
  }
  const last = Math.min(o.from + DEV_PORT_TRIES - 1, 65535);
  for (let port = o.from; port <= last; port++) {
    if (!o.avoid.includes(port) && (await deps.free(port, o.hosts))) return port;
  }
  throw new DevPortError(`No free port for ${o.label} from ${o.from} to ${last}: set ${o.name} to one that is free.`);
}

export interface DevPorts {
  /** The API's port, for the server and Vite's proxy (`PORT`). */
  api: number;
  /** Vite's port (`RELAY_DEV_WEB_PORT`). */
  web: number;
  /** What to say about them: a usual port that was in use. */
  notes: string[];
}

/** The two ports `npm run dev` runs on, by the environment it was started with. */
export async function devPorts(env: NodeJS.ProcessEnv, deps: PortDeps = REAL): Promise<DevPorts> {
  const host = env.HOST?.trim();
  const apiWanted = envPort('PORT', env.PORT);
  const webWanted = envPort('RELAY_DEV_WEB_PORT', env.RELAY_DEV_WEB_PORT);
  const api = await pickPort(
    {
      label: 'the API',
      name: 'PORT',
      wanted: apiWanted,
      from: DEV_API_PORT,
      hosts: [...new Set([...LOOPBACKS, ...(host ? [host] : [])])],
      avoid: [],
    },
    deps,
  );
  const web = await pickPort(
    { label: 'Vite', name: 'RELAY_DEV_WEB_PORT', wanted: webWanted, from: DEV_WEB_PORT, hosts: LOOPBACKS, avoid: [api] },
    deps,
  );
  const notes: string[] = [];
  if (apiWanted === undefined && api !== DEV_API_PORT) notes.push(`Port ${DEV_API_PORT} is in use: the API listens on ${api} instead.`);
  if (webWanted === undefined && web !== DEV_WEB_PORT) notes.push(`Port ${DEV_WEB_PORT} is in use: Vite serves the UI on ${web} instead.`);
  return { api, web, notes };
}

/** The environment of the server and Vite: the ports taken, over what the environment said. */
export function devEnv(env: NodeJS.ProcessEnv, ports: DevPorts): NodeJS.ProcessEnv {
  return { ...env, PORT: String(ports.api), RELAY_DEV_WEB_PORT: String(ports.web) };
}

/** concurrently's own command line (its package's `bin`), run with this Node. */
export function concurrentlyBin(): string {
  const manifest = createRequire(import.meta.url).resolve('concurrently/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };
  return join(dirname(manifest), bin.concurrently);
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    console.error('[dev] npm run dev takes no arguments: set PORT or RELAY_DEV_WEB_PORT for other ports.');
    process.exit(2);
  }
  let ports: DevPorts;
  try {
    ports = await devPorts(process.env);
  } catch (err) {
    if (!(err instanceof DevPortError)) throw err;
    console.error(`[dev] ${err.message}`);
    process.exit(1);
  }
  for (const note of ports.notes) console.log(`[dev] ${note}`);
  // concurrently's own command line, as before: its Windows console set-up and its handling of Ctrl+C.
  const child = spawn(process.execPath, [concurrentlyBin(), ...DEV_COMMAND], { stdio: 'inherit', env: devEnv(process.env, ports) });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    // A terminal's Ctrl+C reaches concurrently and its commands too (they share its process group, or
    // its console on Windows), and they take a second one as they took the first. A signal sent to this
    // process alone (npm passing one on) is passed on, but on Windows, where kill() ends a process at
    // once, before it stops its commands.
    process.on(signal, () => {
      if (process.platform !== 'win32') child.kill(signal);
    });
  }
  child.on('error', (err) => {
    console.error(`[dev] could not start concurrently: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('[dev]', err);
    process.exit(1);
  });
}
