import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_COMMAND, DEV_SIGNALS, concurrentlyBin, passSignals } from '../scripts/dev/concurrently';
import { DevPortError, LOCAL_BINDS, devEnv, devPorts, envPort, pickPort, portFree, tryListen, type PortDeps } from '../scripts/dev/ports';
import { DEFAULT_PORT, DEV_API_PORT, DEV_PORT_TRIES, DEV_WEB_PORT } from '../src/server/ports';
import { slow } from './timeouts';

/** Ports that something listens on, and the addresses each check was asked about. */
function fake(taken: number[], system: number[] = []): PortDeps & { asked: Array<[number, readonly string[]]> } {
  const asked: Array<[number, readonly string[]]> = [];
  return {
    asked,
    free: async (port, hosts) => {
      asked.push([port, hosts]);
      return !taken.includes(port);
    },
    system: async () => {
      const port = system.shift();
      if (port === undefined) throw new Error('no more ports');
      return port;
    },
  };
}

describe('npm run dev: its ports', () => {
  it('takes 8789 and 5173 when they are free, and says nothing', async () => {
    expect(await devPorts({}, fake([]))).toEqual({ api: DEV_API_PORT, web: DEV_WEB_PORT, notes: [] });
  });

  it('takes the next free port past those in use, for the API and for Vite, and says so', async () => {
    const ports = await devPorts({}, fake([8789, 8790, 5173]));
    expect(ports).toEqual({
      api: 8791,
      web: 5174,
      notes: ['Port 8789 is in use: the API listens on 8791 instead.', 'Port 5173 is in use: Vite serves the UI on 5174 instead.'],
    });
  });

  it("checks both ports at both loopback and both wildcard addresses, and the API's at HOST too", async () => {
    expect(LOCAL_BINDS).toEqual(['127.0.0.1', '::1', '0.0.0.0', '::']);
    const deps = fake([]);
    await devPorts({ HOST: '192.168.1.20' }, deps);
    expect(deps.asked).toEqual([
      [8789, [...LOCAL_BINDS, '192.168.1.20']],
      [5173, LOCAL_BINDS],
    ]);
    const plain = fake([]);
    await devPorts({ HOST: ' ' }, plain);
    await devPorts({ HOST: '0.0.0.0' }, plain);
    expect(plain.asked.filter(([port]) => port === 8789).map(([, hosts]) => hosts)).toEqual([LOCAL_BINDS, LOCAL_BINDS]);
  });

  it('takes PORT and RELAY_DEV_WEB_PORT as they are, and nothing starts when one is in use', async () => {
    expect(await devPorts({ PORT: '9000', RELAY_DEV_WEB_PORT: '6000' }, fake([8789, 5173]))).toEqual({ api: 9000, web: 6000, notes: [] });
    // A port named is not moved, even to the usual one.
    await expect(devPorts({ PORT: '8789' }, fake([8789]))).rejects.toThrow(
      'Port 8789 (PORT) is in use: another program, or another Harness Relay, listens there. Choose another PORT, or leave it out to take the first free port from 8789.',
    );
    await expect(devPorts({ RELAY_DEV_WEB_PORT: '5180' }, fake([5180]))).rejects.toThrow(/^Port 5180 \(RELAY_DEV_WEB_PORT\) is in use/);
    await expect(devPorts({ PORT: '8789' }, fake([8789]))).rejects.toBeInstanceOf(DevPortError);
    // Only the one not named moves, and is said.
    expect(await devPorts({ PORT: '9000' }, fake([5173]))).toEqual({
      api: 9000,
      web: 5174,
      notes: ['Port 5173 is in use: Vite serves the UI on 5174 instead.'],
    });
  });

  it('never gives both the same port, and steps the one not named around the one named', async () => {
    expect(await devPorts({ PORT: '5173' }, fake([]))).toEqual({
      api: 5173,
      web: 5174,
      notes: ["Port 5173 is the API's (PORT): Vite serves the UI on 5174 instead."],
    });
    // A Vite port named in the API's range: the API takes the next one, whether its own is in use or not.
    expect(await devPorts({ RELAY_DEV_WEB_PORT: '8790' }, fake([8789]))).toEqual({
      api: 8791,
      web: 8790,
      notes: ['Port 8789 is in use: the API listens on 8791 instead.'],
    });
    expect(await devPorts({ RELAY_DEV_WEB_PORT: '8789' }, fake([]))).toEqual({
      api: 8790,
      web: 8789,
      notes: ["Port 8789 is Vite's (RELAY_DEV_WEB_PORT): the API listens on 8790 instead."],
    });
    await expect(devPorts({ PORT: '5180', RELAY_DEV_WEB_PORT: '5180' }, fake([]))).rejects.toThrow(
      "PORT=5180 is RELAY_DEV_WEB_PORT's port too: choose another.",
    );
  });

  it('takes a free port the system gives for a port of 0', async () => {
    // The first one the system gave was taken meanwhile; the next one is free.
    expect(await devPorts({ PORT: '0' }, fake([51000], [51000, 51001]))).toEqual({ api: 51001, web: 5173, notes: [] });
    // Never the API's own for Vite.
    expect(await devPorts({ PORT: '51001', RELAY_DEV_WEB_PORT: '0' }, fake([], [51001, 51002]))).toMatchObject({ api: 51001, web: 51002 });
    const none = fake([51000], Array<number>(DEV_PORT_TRIES).fill(51000));
    await expect(devPorts({ PORT: '0' }, none)).rejects.toThrow('No free port for the API (PORT=0): set PORT to one that is free.');
  });

  it(`gives up after ${DEV_PORT_TRIES} ports, and never looks past 65535`, async () => {
    const taken = Array.from({ length: DEV_PORT_TRIES }, (_, i) => DEV_API_PORT + i);
    await expect(devPorts({}, fake(taken))).rejects.toThrow(
      `No free port for the API from 8789 to ${8789 + DEV_PORT_TRIES - 1}: set PORT to one that is free.`,
    );
    expect(await devPorts({}, fake(taken.slice(0, -1)))).toMatchObject({ api: 8789 + DEV_PORT_TRIES - 1 });
    const deps = fake([65534, 65535]);
    await expect(pickPort({ label: 'Vite', name: 'X', from: 65534, hosts: LOCAL_BINDS, avoid: new Map() }, deps)).rejects.toThrow(
      'from 65534 to 65535',
    );
    expect(deps.asked.map(([port]) => port)).toEqual([65534, 65535]);
  });

  it("never looks at npm start's and the desktop app's port, and the two never look at each other's", () => {
    expect(DEV_API_PORT).toBeGreaterThan(DEFAULT_PORT);
    expect(DEV_WEB_PORT + DEV_PORT_TRIES).toBeLessThan(DEFAULT_PORT);
  });

  it('reads a port from the environment: unset or blank is none, else a whole number up to 65535', () => {
    expect(envPort('PORT', undefined)).toBeUndefined();
    expect(envPort('PORT', '')).toBeUndefined();
    expect(envPort('PORT', '  ')).toBeUndefined();
    expect(envPort('PORT', ' 8790 ')).toBe(8790);
    expect(envPort('PORT', '0')).toBe(0);
    expect(envPort('PORT', '65535')).toBe(65535);
    for (const wrong of ['abc', '-1', '8790.5', '1e4', '0x1f90', '65536', '123456']) {
      expect(() => envPort('PORT', wrong), wrong).toThrow(
        `PORT=${wrong} is not a port: give a whole number from 0 to 65535, or leave it out.`,
      );
    }
  });

  it('hands both ports to the server and Vite in their environment, over what it said', () => {
    expect(devEnv({ PORT: '', HOME: '/home/me', npm_lifecycle_event: 'dev' }, { api: 8790, web: 5174, notes: [] })).toEqual({
      PORT: '8790',
      RELAY_DEV_WEB_PORT: '5174',
      HOME: '/home/me',
      npm_lifecycle_event: 'dev',
    });
  });
});

describe('npm run dev: running the server and Vite', () => {
  it("runs the same commands as before, through concurrently's own command line, with Node and tsx's loader in front", () => {
    expect(DEV_COMMAND).toEqual([
      '-k',
      '-n',
      'server,web',
      '-c',
      'blue,magenta',
      'tsx watch --clear-screen=false src/server/index.ts',
      'vite',
    ]);
    expect(existsSync(concurrentlyBin())).toBe(true);
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts.dev).toBe('node --import tsx scripts/dev.ts');
  });

  it('passes each signal on to concurrently, but on Windows', () => {
    const from = new EventEmitter();
    const kill = vi.fn(() => true);
    passSignals({ kill }, from, 'darwin');
    for (const signal of DEV_SIGNALS) from.emit(signal, signal);
    expect(kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM'], ['SIGHUP']]);
    const windows = new EventEmitter();
    const none = vi.fn(() => true);
    passSignals({ kill: none }, windows, 'win32');
    for (const signal of DEV_SIGNALS) windows.emit(signal, signal);
    expect(none).not.toHaveBeenCalled();
    // A listener for each, so that Node does not end this process on Ctrl+C before concurrently ends.
    expect(DEV_SIGNALS.map((s) => windows.listenerCount(s))).toEqual([1, 1, 1]);
  });

  it(
    "gives Vite exactly its port, and its proxy the API's",
    async () => {
      vi.stubEnv('PORT', '8790');
      vi.stubEnv('RELAY_DEV_WEB_PORT', '5174');
      vi.resetModules();
      try {
        const { default: config } = await import('../vite.config');
        expect(config.server).toMatchObject({ port: 5174, strictPort: true, proxy: { '/api/': { target: 'http://localhost:8790' } } });
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    },
    slow(20_000),
  );
});

describe('npm run dev: ports on this computer', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  });

  /** Something listening at one address, on a port the system gives (or this one). */
  async function listen(host: string, port = 0, ipv6Only = false): Promise<number> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen({ port, host, ipv6Only }, done);
    });
    return (server.address() as AddressInfo).port;
  }

  const ipv6 = (() => {
    const probe = spawnSync(process.execPath, [
      '-e',
      "require('net').createServer().listen(0,'::1',function(){this.close()}).on('error',()=>process.exit(1))",
    ]);
    return probe.status === 0;
  })();

  it('counts a port as taken when something listens on it at 127.0.0.1', async () => {
    const port = await listen('127.0.0.1');
    expect(await tryListen(port, '127.0.0.1')).toBe('taken');
    expect(await portFree(port, LOCAL_BINDS)).toBe(false);
  });

  it.skipIf(!ipv6)('counts a port as taken when something listens on it at ::1 only, as Vite does on macOS', async () => {
    const port = await listen('::1');
    expect(await portFree(port, ['127.0.0.1'])).toBe(true);
    expect(await portFree(port, LOCAL_BINDS)).toBe(false);
  });

  it('counts a port as taken when something listens on it at every address (0.0.0.0), as a published container port does', async () => {
    const port = await listen('0.0.0.0');
    expect(await portFree(port, LOCAL_BINDS)).toBe(false);
    expect(await tryListen(port, '0.0.0.0')).toBe('taken');
  });

  // On Windows only `::` tried for IPv6 alone finds it: a socket for both may listen beside it there.
  it.skipIf(!ipv6)('counts a port as taken when something listens on it at every IPv6 address (::)', async () => {
    const port = await listen('::', 0, true);
    expect(await portFree(port, LOCAL_BINDS)).toBe(false);
    expect(await tryListen(port, '::')).toBe('taken');
  });

  it.skipIf(!ipv6)('counts a port as taken when something listens on it at :: for IPv4 and IPv6 both', async () => {
    const port = await listen('::');
    expect(await portFree(port, LOCAL_BINDS)).toBe(false);
  });

  it('leaves an address that is not on this computer out of the way', async () => {
    const port = await listen('127.0.0.1');
    await new Promise((done) => servers.pop()!.close(done));
    // TEST-NET-1 (RFC 5737): never this computer's.
    expect(await tryListen(port, '192.0.2.1')).toBe('absent');
    expect(await portFree(port, [...LOCAL_BINDS, '192.0.2.1'])).toBe(true);
  });

  it('takes the next port when the first one is taken', async () => {
    const taken = await listen('127.0.0.1');
    const port = await pickPort({ label: 'Vite', name: 'RELAY_DEV_WEB_PORT', from: taken, hosts: LOCAL_BINDS, avoid: new Map() });
    expect(port).toBeGreaterThan(taken);
    expect(port).toBeLessThan(taken + DEV_PORT_TRIES);
  });

  it('gets a free port from the system for a port of 0', async () => {
    const port = await pickPort({ label: 'the API', name: 'PORT', wanted: 0, from: DEV_API_PORT, hosts: LOCAL_BINDS, avoid: new Map() });
    expect(port).toBeGreaterThan(0);
    expect(await portFree(port, LOCAL_BINDS)).toBe(true);
  });

  it(
    'refuses a PORT in use before it starts anything',
    async () => {
      const port = await listen('127.0.0.1');
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], {
        env: { ...process.env, PORT: String(port), RELAY_DEV_WEB_PORT: '' },
        encoding: 'utf8',
        timeout: slow(30_000),
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`[dev] Port ${port} (PORT) is in use`);
      expect(run.stdout).not.toContain('[server]');
      expect(run.stdout).not.toContain('[web]');
    },
    slow(40_000),
  );

  it(
    'refuses arguments, which it would not use',
    () => {
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/dev.ts', 'vite'], { encoding: 'utf8', timeout: slow(30_000) });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('npm run dev takes no arguments');
    },
    slow(40_000),
  );
});
