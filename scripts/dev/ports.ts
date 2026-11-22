/*
 * `npm run dev`'s ports (scripts/dev.ts), found before the server and Vite start so that both know
 * them: the API's is `PORT`, else 8789 or the first free one up to 8808; Vite's is
 * `RELAY_DEV_WEB_PORT`, else 5173 or the first free one up to 5192 (`src/server/ports.ts`). A port
 * the environment names is taken as it is (0: any free one), and when it is in use, nothing starts.
 *
 * A port counts as free when nothing listens on it at any address a program here may use for it: both
 * loopback addresses (Vite listens on the one `localhost` names, and its proxy and the browser
 * connect to either), both wildcard ones (a program listening on every address, such as a container's
 * published port, also answers on `localhost`, and on macOS a socket may listen on 127.0.0.1 beside
 * it), and `HOST` for the API.
 */
import { createServer, type AddressInfo } from 'node:net';
import { DEV_API_PORT, DEV_PORT_TRIES, DEV_WEB_PORT, portNumber } from '../../src/server/ports';

/** Where a port must be free: both loopback addresses and both wildcard ones (`::` for IPv6 alone: `tryListen()`). */
export const LOCAL_BINDS: readonly string[] = ['127.0.0.1', '::1', '0.0.0.0', '::'];

/** A port refused or not found: said as it is, and nothing starts. */
export class DevPortError extends Error {}

/**
 * Whether a port can be listened on at an address: `taken` when something listens there, `absent`
 * when the address is not this computer's (no IPv6, a `HOST` that is not its own), which is then not
 * in the way (the server says so itself). Any other refusal (`EACCES`) is a `DevPortError` that says it.
 *
 * `::` is tried for IPv6 alone, as `0.0.0.0` is for IPv4 alone: on Windows a socket for both may
 * listen beside one on `::` for IPv6 alone, which it would then miss. A socket listening on `::` for
 * both is still found, at both (`0.0.0.0` too).
 */
export function tryListen(port: number, host: string): Promise<'free' | 'taken' | 'absent'> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') done('taken');
      else if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'].includes(err.code ?? '')) done('absent');
      else fail(new DevPortError(`Cannot listen on port ${port} at ${host}: ${err.message}.`));
    });
    probe.listen({ port, host, exclusive: true, ipv6Only: host === '::' }, () => probe.close(() => done('free')));
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
  if (!value?.trim()) return undefined;
  const port = portNumber(value);
  if (port === undefined) throw new DevPortError(`${name}=${value} is not a port: give a whole number from 0 to 65535, or leave it out.`);
  return port;
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
  /** Ports it may not be (the other one's), and the variable that holds each. */
  avoid: ReadonlyMap<number, string>;
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
      if (!o.avoid.has(port) && (await deps.free(port, o.hosts))) return port;
    }
    throw new DevPortError(`No free port for ${o.label} (${o.name}=0): set ${o.name} to one that is free.`);
  }
  if (o.wanted !== undefined) {
    const holder = o.avoid.get(o.wanted);
    if (holder) throw new DevPortError(`${o.name}=${o.wanted} is ${holder}'s port too: choose another.`);
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
    if (!o.avoid.has(port) && (await deps.free(port, o.hosts))) return port;
  }
  throw new DevPortError(`No free port for ${o.label} from ${o.from} to ${last}: set ${o.name} to one that is free.`);
}

export interface DevPorts {
  /** The API's port, for the server and Vite's proxy (`PORT`). */
  api: number;
  /** Vite's port (`RELAY_DEV_WEB_PORT`). */
  web: number;
  /** What to say about them: a usual port that was not taken, and why. */
  notes: string[];
}

/** The two ports `npm run dev` runs on, by the environment it was started with. */
export async function devPorts(env: NodeJS.ProcessEnv, deps: PortDeps = REAL): Promise<DevPorts> {
  const host = env.HOST?.trim();
  const apiWanted = envPort('PORT', env.PORT);
  const webWanted = envPort('RELAY_DEV_WEB_PORT', env.RELAY_DEV_WEB_PORT);
  // The API's search steps around a Vite port named (not 0, which is found after it).
  const apiAvoid = new Map(webWanted ? [[webWanted, 'RELAY_DEV_WEB_PORT']] : []);
  const api = await pickPort(
    {
      label: 'the API',
      name: 'PORT',
      wanted: apiWanted,
      from: DEV_API_PORT,
      hosts: [...new Set([...LOCAL_BINDS, ...(host ? [host] : [])])],
      avoid: apiAvoid,
    },
    deps,
  );
  const web = await pickPort(
    {
      label: 'Vite',
      name: 'RELAY_DEV_WEB_PORT',
      wanted: webWanted,
      from: DEV_WEB_PORT,
      hosts: LOCAL_BINDS,
      avoid: new Map([[api, 'PORT']]),
    },
    deps,
  );
  const notes: string[] = [];
  if (apiWanted === undefined && api !== DEV_API_PORT) {
    const why = apiAvoid.has(DEV_API_PORT) ? `is Vite's (RELAY_DEV_WEB_PORT)` : 'is in use';
    notes.push(`Port ${DEV_API_PORT} ${why}: the API listens on ${api} instead.`);
  }
  if (webWanted === undefined && web !== DEV_WEB_PORT) {
    const why = api === DEV_WEB_PORT ? `is the API's (PORT)` : 'is in use';
    notes.push(`Port ${DEV_WEB_PORT} ${why}: Vite serves the UI on ${web} instead.`);
  }
  return { api, web, notes };
}

/** The environment of the server and Vite: the ports taken, over what the environment said. */
export function devEnv(env: NodeJS.ProcessEnv, ports: DevPorts): NodeJS.ProcessEnv {
  return { ...env, PORT: String(ports.api), RELAY_DEV_WEB_PORT: String(ports.web) };
}
