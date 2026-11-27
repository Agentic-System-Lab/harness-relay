import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileKey } from '../src/server/db';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ComputerScreenEvent, HandoverPart } from '../src/shared/types';
import { Handovers } from '../src/server/browser/handover';
import {
  cuaEnv,
  cuaFailure,
  cuaHome,
  cuaLogLine,
  cuaRunner,
  desktopImage,
  lastJson,
  linuxRuntime,
  PULL_LOG,
  PullProgress,
  removeCuaRuntime,
} from '../src/server/computer/cua';
import { checkComputerInputs } from '../src/server/computer/input';
import {
  atLeast,
  CUA_MIN_VERSION,
  CUA_VERSION,
  cuaBuild,
  findCua,
  installCua,
  parseCuaVersion,
  uninstallCua,
} from '../src/server/computer/install';
import { InstallJob } from '../src/server/cliInstall';
import { StdioMcp, toolResult, type McpToolResult } from '../src/server/computer/mcp';
import {
  COMPUTER_HANDOVER_UNASKED,
  COMPUTER_LOOK_FIRST,
  COMPUTER_USER_HAS_IT,
  ComputerService,
  computerHandoverOutcome,
  computerName,
  folderKey,
  imageSize,
  pinnedCopy,
  insideFolder,
  isGuestPath,
  runtimeSummary,
  sandboxState,
  type ComputerMcp,
} from '../src/server/computer/session';
import { computerTools, keysOf } from '../src/server/computer/tools';
import type { GatewayContext } from '../src/server/gateway';
import { withLang } from '../src/server/i18n';
import type { SpawnResult } from '../src/server/process';
import { cuaHomeDir } from '../src/server/protect';
import { slow } from './timeouts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-computer-')));
const ELSEWHERE = join(root, 'elsewhere');
mkdirSync(ELSEWHERE, { recursive: true });
/** The computer of the chats in `root`. */
const NAME = computerName(root, root);
afterAll(() => {
  // The folders are the system's temporary ones: left to it.
});

/** A PNG's first bytes, `w` by `h` (enough for `imageSize()`), as base64. */
function png(w: number, h: number, tag = 0): string {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[30] = tag;
  return b.toString('base64');
}

const ok = (stdout = '', stderr = ''): SpawnResult => ({ code: 0, stdout, stderr, timedOut: false, aborted: false }) as SpawnResult;
const fail = (stderr: string): SpawnResult => ({ code: 1, stdout: '', stderr, timedOut: false, aborted: false }) as SpawnResult;

/** A stand-in for `cua mcp`: records its calls, answers screenshots with a frame. */
class FakeMcp implements ComputerMcp {
  alive = true;
  calls: [string, Record<string, unknown>][] = [];
  frame = 0;
  answer?: (name: string, args: Record<string, unknown>) => McpToolResult | undefined;
  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.calls.push([name, args]);
    const custom = this.answer?.(name, args);
    if (custom) return custom;
    if (name === 'computer_screenshot')
      return { text: '', images: [{ data: png(1200, 750, this.frame++), mimeType: 'image/png' }], isError: false };
    return { text: '{"success":true}', images: [], isError: false };
  }
  close() {
    this.alive = false;
  }
}

function setup(
  o: {
    info?: SpawnResult;
    create?: SpawnResult[];
    dataDir?: string;
    available?: boolean;
    protectedPaths?: string[];
    /** Held before cua answers: a slow step. */
    before?: (args: string[]) => Promise<void> | undefined;
    /** Told of each `sb cp`, before the fake copies. */
    cp?: (args: string[]) => void;
    /** Where the desktop image is recorded as downloaded (a file of this setup's own by default). */
    imageRecord?: string;
  } = {},
) {
  const runs: string[][] = [];
  let mcpStarts = 0;
  const creates = [...(o.create ?? [ok('{"status":"ready"}')])];
  const mcp = new FakeMcp();
  const handovers = new Handovers();
  let now = 1_000_000;
  const shots = join(root, 'shots-' + Math.random().toString(36).slice(2));
  const service = new ComputerService({
    run: async (args) => {
      runs.push(args);
      await o.before?.(args);
      if (args[1] === 'cp') o.cp?.(args);
      if (args.includes('info')) return o.info ?? fail('not found: sandbox');
      if (args.includes('create')) return creates.shift() ?? ok();
      if (args.includes('ls'))
        return ok(
          JSON.stringify([
            { name: computerName(o.dataDir ?? root, folderKey(root)), state: 'suspended', status: 'stopped' },
            { name: 'relay-other-x', state: 'running', status: 'ready' },
          ]),
        );
      // A copy out of the computer writes the local file, as cua does.
      if (args[1] === 'cp' && args[2]!.startsWith('local:')) writeFileSync(args[3]!, 'from the computer');
      if (args.includes('view')) return ok(JSON.stringify({ url: 'http://127.0.0.1:41234/viewer/#ticket=abc', expires_at_unix: 2000 }));
      if (args.includes('doctor'))
        return ok(JSON.stringify({ backends: [{ backend: 'container', ready: true, detail: 'Docker Engine', missing: [] }] }));
      return ok();
    },
    available: () => o.available ?? true,
    startMcp: async () => {
      mcpStarts++;
      mcp.alive = true;
      return mcp;
    },
    found: () => ({ bin: '/x/cua', version: CUA_VERSION, own: true }),
    dataDir: o.dataDir ?? root,
    imageRecord: o.imageRecord ?? join(shots, 'cua-image.json'),
    protectedPaths: () => o.protectedPaths ?? [],
    handovers,
    // Every chat in `root` but `elsewhere`, in a folder of its own.
    folderOf: (id) => (id === 'elsewhere' ? ELSEWHERE : root),
    shotsDir: () => shots,
    handoverMs: { start: 5_000, use: 5_000 },
    frameMs: 20,
    idleMs: 60_000,
    now: () => now,
  });
  return {
    service,
    runs,
    mcp,
    handovers,
    shots,
    mcpStarts: () => mcpStarts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function ctx(o: Partial<GatewayContext> = {}): GatewayContext {
  return {
    convId: 'c1',
    agentId: 'a1',
    agentName: 'Claude',
    messageId: 'm1',
    cwd: root,
    permission: 'edit',
    unattended: false,
    signal: new AbortController().signal,
    ...o,
  };
}

describe('installing Cua', () => {
  it('picks the maker’s archive for each system and checks it with a fixed checksum', () => {
    expect(cuaBuild('darwin', 'arm64')).toEqual({
      url: `https://github.com/trycua/cua/releases/download/cua-sdk-v${CUA_VERSION}/cua-cli-${CUA_VERSION}-darwin-arm64.tar.gz`,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      exe: 'cua',
      size: 84_536_919,
    });
    expect(cuaBuild('linux', 'x64')?.url).toMatch(/linux-x64\.tar\.gz$/);
    expect(cuaBuild('win32', 'arm64')).toMatchObject({ exe: 'cua.exe', url: expect.stringMatching(/windows-arm64\.zip$/) });
    expect(cuaBuild('win32', 'ia32')).toBeUndefined();
    expect(cuaBuild('freebsd', 'x64')).toBeUndefined();
    const sums = ['darwin', 'linux', 'win32'].flatMap((p) => ['x64', 'arm64'].map((a) => cuaBuild(p as NodeJS.Platform, a)!.sha256));
    expect(new Set(sums).size).toBe(6);
  });

  it('reads versions and compares them', () => {
    expect(parseCuaVersion('cua 0.31.2\n')).toBe('0.31.2');
    expect(parseCuaVersion('something else')).toBeUndefined();
    expect(atLeast('0.31.2', '0.31.0')).toBe(true);
    expect(atLeast('0.31.0', '0.31.0')).toBe(true);
    expect(atLeast('0.30.9', '0.31.0')).toBe(false);
    expect(atLeast('1.0.0', '0.31.0')).toBe(true);
    expect(atLeast(CUA_VERSION, CUA_MIN_VERSION)).toBe(true);
  });

  it('starts its own copy first, else the user’s own when it is new enough', () => {
    // A Linux computer's paths, on every system the tests run on.
    const folder = '/srv/relay/data/clis/cua';
    const own = '/srv/relay/data/clis/cua/cua';
    const theirs = '/home/u/.local/bin/cua';
    const programs = new Set<string>();
    const probe = (bin: string) => (bin === own ? '0.31.2' : bin === theirs ? version : undefined);
    const version = '0.31.5';
    const find = () =>
      findCua({ env: { PATH: '/usr/bin' }, platform: 'linux', home: '/home/u', folder, hasProgram: (p) => programs.has(p), probe });
    expect(find()).toBeUndefined();
    programs.add(theirs);
    expect(find()).toEqual({ bin: theirs, version: '0.31.5', own: false });
    // An older one on the PATH is too old (and Settings offers its own).
    const older = '/opt/old/cua';
    expect(
      findCua({
        env: { PATH: '/opt/old' },
        platform: 'linux',
        home: '/nobody',
        folder,
        hasProgram: (p) => p === older,
        probe: () => '0.20.0',
      }),
    ).toEqual({ tooOld: true, bin: older, version: '0.20.0' });
    // Its own copy first, beside the user's.
    programs.add(own);
    expect(find()).toEqual({ bin: own, version: '0.31.2', own: true });
  });
});

describe('installing Cua from Settings', () => {
  it.skipIf(process.platform === 'win32')('downloads, checks and unpacks it into its folder, saying how much is downloaded', async () => {
    const folder = join(root, 'install', 'cua');
    const payload = join(root, 'install-payload');
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, 'cua'), '#!/bin/sh\necho cua 0.31.2\n');
    writeFileSync(join(payload, 'cua-spacesd-linux-aarch64'), 'helper');
    const tarball = execFileSync('tar', ['-czf', '-', '-C', payload, 'cua', 'cua-spacesd-linux-aarch64']);
    const build = { ...cuaBuild('linux', 'arm64')!, sha256: createHash('sha256').update(tarball).digest('hex'), size: tarball.length };
    const run = vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'curl') {
        const out = args[args.indexOf('--output') + 1]!;
        writeFileSync(out, tarball.subarray(0, 10));
        await new Promise((r) => setTimeout(r, 700));
        writeFileSync(out, tarball);
      } else execFileSync(bin, args);
      return true;
    });
    const job = new InstallJob();
    const seen: (number | undefined)[] = [];
    const progress = job.progress.bind(job);
    job.progress = (done, total) => {
      seen.push(done);
      progress(done, total);
    };
    await installCua(job, { build, folder, tool: (n) => n, run, probe: async () => true });
    expect(readFileSync(join(folder, 'cua-spacesd-linux-aarch64'), 'utf8')).toBe('helper');
    expect(job.view().progress).toEqual({ done: tarball.length, total: tarball.length });
    expect(seen).toContain(10);
    expect(job.view().log).toMatch(/Cua 0\.31\.2/);
  });
});

describe('removing Cua’s program', () => {
  it('deletes its own copy, never the user’s own', async () => {
    const folder = join(root, 'uninstall', 'cua');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, process.platform === 'win32' ? 'cua.exe' : 'cua'), 'x');
    expect(await uninstallCua(folder, () => undefined)).toEqual({ removed: true });
    expect(existsSync(folder)).toBe(false);
    expect(await uninstallCua(folder, () => ({ bin: '/home/u/.local/bin/cua', version: '0.31.2', own: false }))).toEqual({
      kept: '/home/u/.local/bin/cua',
    });
    expect(await uninstallCua(folder, () => undefined)).toBeUndefined();
  });
});

describe('removing Cua’s own Linux runtime', () => {
  it('stops and deletes its VM with Cua’s own limactl, then its folder; nothing where there is none', async () => {
    const home = join(root, 'runtime-home');
    const dir = join(home, 'runtimes', 'linux');
    const limactl = join(dir, 'colima-0.10.3-lima-2.2.0', 'lima', 'bin', 'limactl');
    mkdirSync(dirname(limactl), { recursive: true });
    writeFileSync(limactl, '');
    mkdirSync(join(dir, 'vm', '_lima', 'colima-cua'), { recursive: true });
    const calls: { bin: string; args: string[]; lima?: string }[] = [];
    const run = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      calls.push({ bin, args, lima: env.LIMA_HOME });
      return args[0] === 'list' ? ok(JSON.stringify({ name: 'colima-cua', status: 'Running' }) + '\n') : ok();
    };
    expect(await removeCuaRuntime({ home, platform: 'darwin', run })).toBe('removed');
    expect(calls.map((c) => c.args.join(' '))).toEqual(['list --json', 'stop --force colima-cua', 'delete --force colima-cua']);
    expect(calls.every((c) => c.bin === limactl && c.lima === join(dir, 'vm', '_lima'))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(await removeCuaRuntime({ home, platform: 'darwin', run })).toBe('none');
    // A VM that could not be deleted keeps its folder.
    mkdirSync(dirname(limactl), { recursive: true });
    writeFileSync(limactl, '');
    mkdirSync(join(dir, 'vm', '_lima'), { recursive: true });
    const stuck = async (_bin: string, args: string[]) =>
      args[0] === 'list' ? ok('{"name":"colima-cua"}\n') : args[0] === 'delete' ? fail('busy') : ok();
    await expect(removeCuaRuntime({ home, platform: 'darwin', run: stuck })).rejects.toThrow(/could not be deleted/);
    expect(existsSync(dir)).toBe(true);
    // On Windows, its WSL distribution stays.
    expect(await removeCuaRuntime({ home, platform: 'win32', run })).toBe('kept-wsl');
  });

  it('on Linux, takes Cua’s helper and images out of Docker once none of its sandboxes is there', async () => {
    const home = join(root, 'runtime-linux');
    const calls: string[] = [];
    let containers = 'cua-runsc-helper\thelper\n';
    const run = async (bin: string, args: string[]) => {
      calls.push([bin, ...args].join(' '));
      if (args[0] === 'ps') return ok(containers);
      // Cua pulls its desktop image by digest (no tag); its helper has one.
      if (args[0] === 'images')
        return ok(
          'ghcr.io/trycua/linux\t<none>\tsha256:3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c\ncua-vmm/helper\t1\t<none>\nubuntu\t24.04\tsha256:abababababababababababababababababababababababababababababababab\n',
        );
      return ok();
    };
    expect(await removeCuaRuntime({ home, platform: 'linux', run })).toBe('removed');
    expect(calls).toEqual([
      expect.stringMatching(/^docker ps -a --filter label=ai\.cua\.managed=true/),
      'docker rm --force cua-runsc-helper',
      expect.stringMatching(/^docker images/),
      'docker rmi ghcr.io/trycua/linux@sha256:3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c',
      'docker rmi cua-vmm/helper:1',
    ]);
    // A sandbox of Cua's still there (another Cua home's): nothing goes.
    calls.length = 0;
    containers = 'cua-runsc-helper\thelper\nrelay-x\tsandbox\n';
    expect(await removeCuaRuntime({ home, platform: 'linux', run })).toBe('kept-docker');
    expect(calls).toHaveLength(1);
    // An image a container still uses: Docker refuses it, and that is said.
    containers = '';
    const inUse = async (bin: string, args: string[]) =>
      args[0] === 'images'
        ? ok('ghcr.io/trycua/linux\t24.04\t<none>\n')
        : args[0] === 'rmi'
          ? fail('image is being used by container x')
          : ok('');
    await expect(removeCuaRuntime({ home, platform: 'linux', run: inUse })).rejects.toThrow(/being used/);
    // Without Docker (Podman): nothing.
    expect(
      await removeCuaRuntime({
        home,
        platform: 'linux',
        run: async () => {
          throw new Error('spawn docker ENOENT');
        },
      }),
    ).toBe('none');
  });
});

describe('running cua', () => {
  it('gives cua only what it needs of the environment, its own home and its telemetry off', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      DOCKER_HOST: 'unix:///run/docker.sock',
      ANTHROPIC_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GH_TOKEN: 'gh',
      CUA_SANDBOX: 'someone-elses',
    };
    const env = cuaEnv(source, 'linux', '/usr/bin:/usr/local/bin');
    expect(env).toMatchObject({
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/u',
      DOCKER_HOST: 'unix:///run/docker.sock',
      DO_NOT_TRACK: '1',
      CUA_TELEMETRY: '0',
    });
    expect(env.CUA_HOME).toBe(join('/home/u', '.cua'));
    for (const key of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'CUA_SANDBOX', 'CUA_RUNTIME_LINUX'])
      expect(env[key]).toBeUndefined();
    expect(cuaEnv(source, 'darwin', '/usr/bin').CUA_RUNTIME_LINUX).toBe('builtin');
    expect(cuaEnv(source, 'win32', 'C:\\Windows').CUA_RUNTIME_LINUX).toBe('builtin');
    expect(cuaEnv({ ...source, CUA_RUNTIME_LINUX: 'system', CUA_HOME: '/c' }, 'darwin', '/usr/bin')).toMatchObject({
      CUA_RUNTIME_LINUX: 'system',
      CUA_HOME: '/c',
    });
    expect(linuxRuntime({}, 'linux')).toBeUndefined();
    // Settings' protected reads follow the same home.
    expect(cuaHomeDir({ CUA_HOME: '/c' }, '/home/u')).toBe(cuaHome({ CUA_HOME: '/c' }, '/home/u'));
    expect(cuaHomeDir({}, '/home/u')).toBe(cuaHome({}, '/home/u'));
  });

  it('reads cua’s JSON and says why it failed in its own words', () => {
    expect(lastJson('{"a":1}')).toEqual({ a: 1 });
    expect(lastJson('progress\n{"b":2}\n')).toEqual({ b: 2 });
    expect(lastJson('[1]')).toEqual([1]);
    expect(lastJson('nothing')).toBeUndefined();
    const why = cuaFailure(
      {
        code: 1,
        stdout: '',
        stderr: '\x1b[2m2026-11-27T14:19:44Z\x1b[0m \x1b[33m WARN\x1b[0m noise\ncua: local runtime: it broke\n',
        timedOut: false,
        aborted: false,
      },
      'Could not make the computer',
    );
    expect(why).toBe('Could not make the computer: cua: local runtime: it broke');
    expect(cuaFailure({ code: null, stdout: '', stderr: '', timedOut: true, aborted: false }, 'X')).toBe('X: it did not finish in time');
  });

  it('reads what doctor says of where Linux computers run', () => {
    const doctor = {
      backends: [
        { backend: 'container', ready: false, detail: 'no engine', missing: ['docker'] },
        { backend: 'managed', ready: false, provisionable: true, detail: 'built-in Linux runtime, set up on first use, about 455 MB' },
      ],
    };
    expect(runtimeSummary(doctor, 'builtin')).toEqual({ ready: true, detail: 'built-in Linux runtime, set up on first use, about 455 MB' });
    expect(runtimeSummary(doctor, undefined)).toEqual({ ready: false, detail: 'no engine (missing: docker)' });
    expect(runtimeSummary({}, undefined)).toBeUndefined();
    expect(runtimeSummary({ backends: [] }, 'builtin')).toMatchObject({ ready: false });
  });
});

describe('the computer MCP client', () => {
  it('reads a tool result’s text and images', () => {
    expect(
      toolResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
          { type: 'audio', data: 'x' },
          { type: 'text', text: 'b' },
        ],
        isError: true,
      }),
    ).toEqual({ text: 'a\nb', images: [{ data: 'AAA', mimeType: 'image/png' }], isError: true });
    expect(toolResult(undefined)).toEqual({ text: '', images: [], isError: false });
  });

  it('starts a stdio MCP server, initializes it, lists its tools and calls them; a server that exits fails its calls', async () => {
    const script = join(root, 'fake-mcp.cjs');
    writeFileSync(
      script,
      `let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);const m=JSON.parse(line);
if(m.method==='initialize')out(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{},serverInfo:{name:'fake',version:'1'}});
else if(m.method==='tools/list')out(m.id,{tools:[{name:'computer_screenshot'},{name:'computer_click'}]});
else if(m.method==='tools/call'&&m.params.name==='computer_click')out(m.id,{content:[{type:'text',text:'clicked '+m.params.arguments.x}]});
else if(m.method==='tools/call'&&m.params.name==='boom')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'boom'}})+'\\n');
else if(m.method==='tools/call'&&m.params.name==='exit')process.exit(3);}});
function out(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');}`,
    );
    const exits: string[] = [];
    const mcp = await StdioMcp.start({
      bin: process.execPath,
      args: [script],
      env: { PATH: process.env.PATH },
      cwd: root,
      onExit: (why) => exits.push(why),
    });
    expect([...mcp.tools]).toEqual(['computer_screenshot', 'computer_click']);
    expect(await mcp.call('computer_click', { x: 5 }, { timeoutMs: slow(5000) })).toEqual({
      text: 'clicked 5',
      images: [],
      isError: false,
    });
    expect(await mcp.call('boom', {}, { timeoutMs: slow(5000) })).toMatchObject({ isError: true, text: expect.stringContaining('boom') });
    await expect(mcp.call('exit', {}, { timeoutMs: slow(5000) })).rejects.toThrow();
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(mcp.alive).toBe(false);
    mcp.close();
  });

  it('refuses a server that does not answer initialize in time', async () => {
    const script = join(root, 'silent-mcp.cjs');
    writeFileSync(script, `process.stdin.resume();`);
    await expect(
      StdioMcp.start({ bin: process.execPath, args: [script], env: { PATH: process.env.PATH }, cwd: root, startMs: 300 }),
    ).rejects.toThrow(/did not start in time/);
  });
});

describe('the chat’s computer', () => {
  it('names a computer by the data folder and the conversation, apart from another server’s', () => {
    expect(computerName('/data/a', 'c1')).toMatch(/^relay-[0-9a-f]{6}-[0-9a-f]{12}$/);
    expect(computerName('/data/a', 'c1')).toBe(computerName('/data/a', 'c1'));
    expect(computerName('/data/a', 'c1')).not.toBe(computerName('/data/b', 'c1'));
    expect(computerName('/data/a', 'c1')).not.toBe(computerName('/data/a', 'c2'));
    expect(sandboxState({ state: 'running', status: 'ready' })).toBe('running');
    expect(sandboxState({ state: 'suspended', status: 'stopped' })).toBe('suspended');
    expect(sandboxState({ state: 'exited' })).toBe('stopped');
    expect(sandboxState(undefined)).toBeUndefined();
    expect(imageSize(png(1200, 750))).toEqual({ width: 1200, height: 750 });
    // A JPEG's, past its first segments.
    const jpeg = Buffer.from([
      ...[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
      ...Array<number>(14).fill(0),
      ...[0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xee, 0x04, 0xb0, 0x03],
      ...Array<number>(9).fill(0),
    ]);
    expect(imageSize(jpeg.toString('base64'))).toEqual({ width: 1200, height: 750 });
    expect(imageSize(Buffer.from('not an image').toString('base64'))).toBeUndefined();
    expect(imageSize(Buffer.from('GIF89a........................').toString('base64'))).toBeUndefined();
  });

  it('is made at its first use, a screenshot saved for the chat and shown to the panel', async () => {
    const { service, runs, mcp, shots } = setup();
    const events: ComputerScreenEvent[] = [];
    service.watch('c1', (e) => events.push(e));
    const r = await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect(runs[0]).toEqual(['--json', 'sb', 'info', 'local:' + NAME]);
    expect(runs[1]).toEqual(['--json', 'sb', 'create', 'linux', '--name', NAME, '--wait', 'desktop']);
    expect(r.images).toHaveLength(1);
    expect(r.text).toMatch(/1200×750 pixels/);
    expect(service.view('c1').recent[0]).toMatchObject({ who: 'relay' });
    const path = /Saved the screenshot as (.+?\.png)/.exec(r.text)![1]!;
    expect(path.startsWith(shots)).toBe(true);
    expect(readFileSync(path).subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(service.view('c1')).toMatchObject({ status: 'ready', control: 'agents', available: true });
    expect(events.some((e) => e.type === 'state' && e.view.status === 'starting')).toBe(true);
    expect(events.some((e) => e.type === 'frame' && e.width === 1200)).toBe(true);
    // The panel takes frames of its own while someone watches.
    await vi.waitFor(() => expect(mcp.calls.filter(([n]) => n === 'computer_screenshot').length).toBeGreaterThan(1));
    await service.shutdown();
  });

  it('goes on starting in the background, whatever the agent’s call does: it is told to look again', async () => {
    let finish!: () => void;
    const slowCreate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runs: string[][] = [];
    const service = new ComputerService({
      run: async (args, o) => {
        runs.push(args);
        if (args.includes('info')) return fail('not found');
        if (args.includes('create')) {
          await slowCreate;
          return o.signal?.aborted ? { ...fail(''), aborted: true } : ok();
        }
        return ok();
      },
      available: () => true,
      startMcp: async () => new FakeMcp(),
      dataDir: root,
      handovers: new Handovers(),
      shotsDir: () => join(root, 'shots-bg'),
      readyMs: 50,
    });
    const turn = new AbortController();
    const r = await service.call(ctx({ signal: turn.signal }), 'computer_screenshot', {}, 'screenshot');
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/still starting/) });
    expect(service.view('c1')).toMatchObject({ status: 'starting', startedAt: expect.any(Number) });
    // The turn ends; the start goes on.
    turn.abort();
    const late = service.call(ctx({ signal: turn.signal }), 'computer_screenshot', {}, 'screenshot');
    await expect(late).rejects.toThrow(/turn ended/);
    finish();
    await vi.waitFor(() => expect(service.view('c1').status).toBe('ready'));
    expect(runs.filter((a) => a.includes('create'))).toHaveLength(1);
    expect((await service.call(ctx(), 'computer_screenshot', {}, 'screenshot')).images).toHaveLength(1);
    await service.shutdown();
  });

  it('wakes a suspended computer and restarts a stopped one, without making another', async () => {
    const suspended = setup({ info: ok('{"state":"suspended","status":"stopped"}') });
    await suspended.service.call(ctx(), 'computer_click', { x: 1, y: 2 }, 'click');
    expect(suspended.runs.map((r) => r.slice(0, 3).join(' '))).toEqual(['--json sb info', 'sb resume local:' + NAME]);
    const stopped = setup({ info: ok('{"state":"exited","status":"stopped"}') });
    await stopped.service.call(ctx(), 'computer_click', { x: 1, y: 2 }, 'click');
    expect(stopped.runs[1]!.slice(0, 2)).toEqual(['sb', 'restart']);
    await suspended.service.shutdown();
    await stopped.service.shutdown();
  });

  it('tries runc once when gVisor cannot start the image, and says so; another failure is the computer’s error', async () => {
    const { service, runs } = setup({
      create: [fail("cua: local runtime: container 'x' exited right after start (status Stopped)"), ok()],
    });
    await service.call(ctx(), 'computer_click', { x: 1, y: 2 }, 'click');
    expect(runs.filter((r) => r.includes('create')).map((r) => r.includes('runc'))).toEqual([false, true]);
    expect(
      service
        .view('c1')
        .recent.map((a) => a.what)
        .join(' '),
    ).toMatch(/runc/);
    const bridge = setup({
      create: [
        fail("cua: local runtime: [local] container engine: could not find the bridge port of container x on the engine's host:"),
        ok(),
      ],
    });
    await bridge.service.call(ctx(), 'computer_click', { x: 1, y: 2 }, 'click');
    expect(bridge.runs.filter((r) => r.includes('create'))).toHaveLength(2);
    await bridge.service.shutdown();
    // Another failure that names the runtime is not gVisor's: no runc for it.
    const named = setup({ create: [fail('cua: pull ghcr.io/trycua/linux:24.04 (runtime runsc): network unreachable')] });
    await expect(named.service.call(ctx(), 'computer_click', { x: 1, y: 2 }, 'click')).rejects.toThrow(/network unreachable/);
    expect(named.runs.filter((r) => r.includes('create'))).toHaveLength(1);
    await named.service.shutdown();
    const broken = setup({ create: [fail('cua: local runtime: no container engine')] });
    await expect(broken.service.call(ctx(), 'computer_click', { x: 1, y: 2 }, 'click')).rejects.toThrow(/no container engine/);
    expect(broken.service.view('c1')).toMatchObject({ status: 'failed', error: expect.stringContaining('no container engine') });
    await service.shutdown();
  });

  it('refuses the agents while the user has control, and their input until they looked again after', async () => {
    const { service, mcp } = setup();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    service.takeControl('c1');
    expect(service.view('c1').control).toBe('user');
    expect(await service.call(ctx(), 'computer_screenshot', {}, 'screenshot')).toEqual({ text: COMPUTER_USER_HAS_IT, isError: true });
    expect(await service.call(ctx(), 'computer_click', { x: 1, y: 1 }, 'click')).toEqual({ text: COMPUTER_USER_HAS_IT, isError: true });
    // The user's own input goes through, at the screen's pixels.
    expect(
      await service.input('c1', [
        { type: 'click', x: 0.5, y: 1 },
        { type: 'key', keys: 'ctrl+l' },
        { type: 'key', keys: 'enter' },
        { type: 'text', text: 'hi' },
      ]),
    ).toBe(true);
    expect(mcp.calls.slice(-4)).toEqual([
      ['computer_click', { x: 600, y: 749 }],
      ['computer_hotkey', { keys: 'ctrl+l' }],
      ['computer_key', { key: 'enter' }],
      ['computer_type', { text: 'hi' }],
    ]);
    service.handBack('c1');
    expect(service.view('c1').control).toBe('agents');
    expect(await service.input('c1', [{ type: 'text', text: 'late' }])).toBe(false);
    expect(await service.call(ctx(), 'computer_click', { x: 1, y: 1 }, 'click')).toEqual({ text: COMPUTER_LOOK_FIRST, isError: true });
    // Another agent that never looked is held back too; one that looks may act.
    expect(await service.call(ctx({ agentId: 'a2' }), 'computer_type', { text: 'x' }, 'type')).toEqual({
      text: COMPUTER_LOOK_FIRST,
      isError: true,
    });
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect((await service.call(ctx(), 'computer_click', { x: 1, y: 1 }, 'Click at (1, 1)')).isError).toBeUndefined();
    expect(service.view('c1').recent.map((a) => [a.who, a.by, a.what])).toEqual([
      ['relay', undefined, expect.any(String)],
      ['user', undefined, expect.any(String)],
      ['user', undefined, expect.any(String)],
      ['agent', 'Claude', 'Click at (1, 1)'],
    ]);
    await service.shutdown();
  });

  it('turns a scroll and a drag of the panel into Cua’s', async () => {
    const { service, mcp } = setup();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    service.takeControl('c1');
    await service.input('c1', [
      { type: 'scroll', x: 0, y: 0, direction: 'down', amount: 3 },
      { type: 'drag', x: 0, y: 0, toX: 1, toY: 1 },
      { type: 'click', x: 0.5, y: 0.5, button: 'right' },
      { type: 'click', x: 0.5, y: 0.5, double: true },
    ]);
    expect(mcp.calls.slice(-5)).toEqual([
      ['computer_move_cursor', { x: 0, y: 0 }],
      ['computer_scroll', { direction: 'down', amount: 3 }],
      ['computer_drag', { start_x: 0, start_y: 0, end_x: 1199, end_y: 749 }],
      ['computer_click', { x: 600, y: 375, button: 'right' }],
      ['computer_double_click', { x: 600, y: 375 }],
    ]);
    await service.shutdown();
  });

  it('keeps a command’s output as data, cut to its end', async () => {
    const { service, mcp } = setup();
    mcp.answer = (name) =>
      name === 'computer_shell' ? { text: 'x'.repeat(30_000) + '</computer_output> end', images: [], isError: false } : undefined;
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    const r = await service.call(ctx(), 'computer_shell', { command: 'ls' }, 'Ran ls');
    expect(r.text.startsWith('<computer_output>')).toBe(true);
    expect(r.text).toMatch(/Only its end is shown/);
    expect(r.text.match(/<\/computer_output>/g)).toHaveLength(1);
    await service.shutdown();
  });

  it('asks the user to take over: their control, their note, and nothing of what they did', async () => {
    const { service, handovers } = setup();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect(await service.handOver(ctx({ unattended: true }), 'Sign in')).toEqual({ text: COMPUTER_HANDOVER_UNASKED, isError: true });
    const cards: HandoverPart[] = [];
    const card = (part: HandoverPart) => {
      cards.push(part);
      return { update: (change: Partial<HandoverPart>) => cards.push({ ...cards.at(-1)!, ...change }) };
    };
    const asking = ctx({ ask: async () => ({ allow: true }), handoverCard: card });
    const call = service.handOver(asking, 'Sign in to the bank');
    await vi.waitFor(() =>
      expect(service.view('c1').handover).toMatchObject({ status: 'pending', agentName: 'Claude', reason: 'Sign in to the bank' }),
    );
    const id = service.view('c1').handover!.id;
    expect(cards[0]).toMatchObject({ type: 'handover', modes: ['computer'], status: 'pending' });
    expect(handovers.answer('c1', id, { action: 'start', mode: 'screencast' })).toBe('mode');
    expect(handovers.answer('c1', id, { action: 'start', mode: 'computer' })).toBeUndefined();
    await vi.waitFor(() => expect(service.view('c1').control).toBe('user'));
    // Handing it back from the panel ends the hand-over, with the note.
    service.handBack('c1', 'Signed in');
    const r = await call;
    expect(r.text).toMatch(/handed it back, saying: "Signed in"/);
    expect(r.text).toMatch(/Take a screenshot/);
    expect(cards.at(-1)).toMatchObject({ status: 'done', note: 'Signed in' });
    expect(service.view('c1')).toMatchObject({ control: 'agents' });
    expect(service.view('c1').handover).toBeUndefined();
    expect(await service.call(ctx(), 'computer_click', { x: 1, y: 1 }, 'click')).toEqual({ text: COMPUTER_LOOK_FIRST, isError: true });

    // Declined.
    const second = service.handOver(asking, 'A CAPTCHA');
    await vi.waitFor(() => expect(service.view('c1').handover).toBeDefined());
    handovers.answer('c1', service.view('c1').handover!.id, { action: 'cancel', note: 'not now' });
    expect(await second).toEqual({ text: 'The user declined to take over the computer, saying: "not now".', isError: true });
    await service.shutdown();
  });

  it('says how a hand-over ended by itself', () => {
    const minutes = { start: 15, use: 30 };
    expect(computerHandoverOutcome({ action: 'timeout' }, false, minutes).text).toMatch(/within 15 minutes/);
    expect(computerHandoverOutcome({ action: 'timeout' }, true, minutes).text).toMatch(/after 30 minutes/);
    expect(computerHandoverOutcome({ action: 'gone' }, true, minutes).isError).toBe(true);
    expect(computerHandoverOutcome({ action: 'cancel', note: 'a "b"' }, true, minutes).text).toBe(
      'The user stopped before finishing, saying: "a \'b\'". Take a screenshot (computer_screenshot) before going on: the screen has changed.',
    );
  });

  it('leaves the user the control they had as a hand-over ends, and asks for one hand-over at a time', async () => {
    const { service, handovers } = setup();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    const card = () => ({ update: () => undefined });
    const asking = ctx({ ask: async () => ({ allow: true }), handoverCard: card });
    service.takeControl('c1');
    const first = service.handOver(asking, 'Sign in');
    // Another agent's (a chat of the same folder too) is refused while this one is asked, from its start on.
    expect(await service.handOver(ctx({ ...asking, agentId: 'a2', agentName: 'Codex' }), 'Me too')).toMatchObject({
      isError: true,
      text: expect.stringContaining('already asked'),
    });
    await vi.waitFor(() => expect(service.view('c1').handover).toBeDefined());
    handovers.answer('c1', service.view('c1').handover!.id, { action: 'cancel' });
    await first;
    expect(service.view('c1').control).toBe('user');
    // Taken over while the user had it already: it stays theirs as the turn ends.
    const turn = new AbortController();
    const second = service.handOver({ ...asking, signal: turn.signal }, 'Again');
    await vi.waitFor(() => expect(service.view('c1').handover).toBeDefined());
    handovers.answer('c1', service.view('c1').handover!.id, { action: 'start', mode: 'computer' });
    await vi.waitFor(() => expect(service.view('c1').handover?.status).toBe('active'));
    turn.abort();
    await expect(second).rejects.toThrow();
    expect(service.view('c1').control).toBe('user');
    expect(service.view('c1').handover).toBeUndefined();
    // One that gave the user control gives it back as the turn ends.
    service.handBack('c1');
    const again = new AbortController();
    const third = service.handOver({ ...asking, signal: again.signal }, 'Once more');
    await vi.waitFor(() => expect(service.view('c1').handover).toBeDefined());
    handovers.answer('c1', service.view('c1').handover!.id, { action: 'start', mode: 'computer' });
    await vi.waitFor(() => expect(service.view('c1').control).toBe('user'));
    again.abort();
    await expect(third).rejects.toThrow();
    expect(service.view('c1').control).toBe('agents');
    await service.shutdown();
  });

  it('starts again only once a suspend under way has ended', async () => {
    let release: (() => void) | undefined;
    const { service, runs, advance } = setup({
      // The first suspend only.
      before: (args) => (args.includes('suspend') && !release ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    advance(61_000);
    const idle = service.suspendIdle();
    await vi.waitFor(() => expect(service.view('c1').status).toBe('stopping'));
    const call = service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const suspendAt = runs.findIndex((r) => r.includes('suspend'));
    expect(runs.slice(suspendAt + 1)).toEqual([]);
    release!();
    await idle;
    expect((await call).isError).toBeFalsy();
    expect(runs.slice(suspendAt + 1).some((r) => r.includes('info'))).toBe(true);
    expect(service.view('c1').status).toBe('ready');
    await service.shutdown();
  });

  it('stops a start under way when its computer is deleted, and keeps nothing it started', async () => {
    let release: (() => void) | undefined;
    const { service, runs, mcpStarts } = setup({
      // The first create only.
      before: (args) => (args.includes('create') && !release ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    const call = service.call(ctx(), 'computer_screenshot', {}, 'screenshot').catch((err: Error) => err);
    await vi.waitFor(() => expect(runs.some((r) => r.includes('create'))).toBe(true));
    const removing = service.removeByName(NAME);
    release!();
    await removing;
    expect(await call).toBeInstanceOf(Error);
    expect(runs.at(-1)).toEqual(['sb', 'rm', 'local:' + NAME, '--force']);
    expect(mcpStarts()).toBe(0);
    expect(service.view('c1').status).toBe('off');
    // Used again, it is made again.
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect(service.view('c1').status).toBe('ready');
    await service.shutdown();
  });

  it('says what was done in the language each panel asks in', async () => {
    const { service } = setup();
    const seen = { en: [] as ComputerScreenEvent[], zh: [] as ComputerScreenEvent[] };
    const stop = [
      withLang('en', () => service.watch('c1', (e) => seen.en.push(e))),
      withLang('zh-TW', () => service.watch('c1', (e) => seen.zh.push(e))),
    ];
    service.takeControl('c1');
    const said = (events: ComputerScreenEvent[]) => {
      const state = events.filter((e) => e.type === 'state').at(-1);
      return state?.type === 'state' ? state.view.recent.at(-1)?.what : undefined;
    };
    expect(said(seen.en)).toBe('You took control of the computer');
    expect(said(seen.zh)).toBe('你接手了電腦');
    expect(withLang('en', () => service.view('c1').recent.at(-1)?.what)).toBe('You took control of the computer');
    for (const end of stop) end();
    await service.shutdown();
  });

  it('is suspended when unused, turned off and deleted on the user’s word', async () => {
    const { service, runs, advance } = setup();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    await service.suspendIdle();
    expect(runs.some((r) => r.includes('suspend'))).toBe(false);
    advance(61_000);
    await service.suspendIdle();
    expect(runs.at(-1)).toEqual(['sb', 'suspend', 'local:' + NAME]);
    expect(service.view('c1').status).toBe('off');
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect(runs.some((r) => r.includes('resume'))).toBe(false);
    await service.turnOff('c1');
    expect(service.view('c1').status).toBe('off');
    await service.removeByName(NAME);
    expect(runs.at(-1)).toEqual(['sb', 'rm', 'local:' + NAME, '--force']);
    expect(service.view('c1')).toMatchObject({ status: 'off', recent: [] });
    await service.shutdown();
  });

  it('lists only this data folder’s computers, and gives Settings their chats', async () => {
    const { service } = setup();
    expect(await service.list()).toEqual([{ name: NAME, state: 'suspended' }]);
    const view = await service.settingsView(true, () => [
      { id: 'c1', title: 'Fix the app', cwd: root },
      { id: 'c2', title: 'Try it', cwd: root },
      { id: 'c3', title: 'Other', cwd: ELSEWHERE },
    ]);
    expect(view).toEqual({
      cua: { version: CUA_VERSION, own: true, path: '/x/cua' },
      installs: CUA_VERSION,
      // Not downloaded yet, and no download asked for.
      image: {},
      runtime: { ready: true, detail: 'Docker Engine' },
      computers: [{ name: NAME, folder: root, chats: ['Fix the app', 'Try it'], status: 'off' }],
    });
    await service.shutdown();
  });

  it('is shared by the chats of one working directory, another folder getting its own', async () => {
    const { service, runs } = setup();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    // Another chat in the same folder: the same computer, already on.
    await service.call(ctx({ convId: 'c2' }), 'computer_screenshot', {}, 'screenshot');
    expect(runs.filter((r) => r.includes('create'))).toHaveLength(1);
    expect(service.nameOf('c2')).toBe(NAME);
    expect(service.view('c2')).toMatchObject({ status: 'ready', folder: root });
    // Who has control is the computer's, in every chat of the folder; agents of two chats are told apart
    // (their member ids repeat): each looks again after the user had it.
    service.takeControl('c2');
    expect(service.view('c1').control).toBe('user');
    service.handBack('c1');
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect(await service.call(ctx({ convId: 'c2' }), 'computer_click', { x: 1, y: 1 }, 'click')).toEqual({
      text: COMPUTER_LOOK_FIRST,
      isError: true,
    });
    // A chat in another folder: a computer of its own.
    await service.call(ctx({ convId: 'elsewhere' }), 'computer_screenshot', {}, 'screenshot');
    expect(runs.filter((r) => r.includes('create')).map((r) => r[5])).toEqual([NAME, computerName(root, folderKey(ELSEWHERE))]);
    expect(service.view('elsewhere')).toMatchObject({ folder: ELSEWHERE, control: 'agents' });
    await service.shutdown();
  });

  it('deletes a computer by its name from Settings, only one of this data folder', async () => {
    const { service, runs } = setup();
    expect(await service.removeByName('relay-000000-000000000000')).toBe(false);
    expect(await service.removeByName('not a name')).toBe(false);
    expect(await service.removeByName(NAME)).toBe(true);
    expect(runs.at(-1)).toEqual(['sb', 'rm', 'local:' + NAME, '--force']);
    await service.shutdown();
  });

  it('removes Cua from Settings: this server’s computers once deleted, the cache, Cua’s runtime when nothing else is left, and its own copy', async () => {
    let sandboxes = [{ name: NAME, state: 'running', status: 'ready' }];
    const runs: string[][] = [];
    let uninstalled = 0;
    let runtimes = 0;
    // `sb rm` only starts a deletion: the sandbox is listed a while longer.
    let deleting = 0;
    const service = new ComputerService({
      run: async (args) => {
        runs.push(args);
        if (args.includes('ls')) {
          if (deleting && --deleting === 0) sandboxes = sandboxes.filter((s) => s.name !== NAME);
          return ok(JSON.stringify(sandboxes));
        }
        if (args.includes('rm')) deleting = 3;
        if (args.includes('info')) return fail('not found');
        return ok('{}');
      },
      removeRuntime: async () => {
        runtimes++;
        return 'removed';
      },
      removalPollMs: 1,
      available: () => true,
      startMcp: async () => new FakeMcp(),
      dataDir: root,
      handovers: new Handovers(),
      folderOf: () => root,
      shotsDir: () => join(root, 'shots-removal'),
      uninstall: async () => {
        uninstalled++;
        return { removed: true };
      },
    });
    service.startRemoval();
    await vi.waitFor(async () => expect((await service.settingsView(false, () => [])).removal?.state).toBe('success'));
    // The cache is pruned only once the computer is gone.
    expect(runs.map((r) => r.slice(0, 3).join(' '))).toEqual([
      '--json sb ls',
      'sb rm local:' + NAME,
      '--json sb ls',
      '--json sb ls',
      '--json sb ls',
      '--json cache prune',
    ]);
    expect(runs.some((r) => r.includes('host'))).toBe(false);
    expect(runtimes).toBe(1);
    expect(uninstalled).toBe(1);
    const { removal } = await service.settingsView(false, () => []);
    expect(removal?.log).toMatch(/relay-/);
    // Another sandbox left in Cua's home (the user's own): Cua's runtime stays.
    sandboxes = [{ name: 'their-own', state: 'running', status: 'ready' }];
    runs.length = 0;
    service.startRemoval();
    await vi.waitFor(async () => expect((await service.settingsView(false, () => [])).removal?.state).toBe('success'));
    expect(runtimes).toBe(1);
    expect(runs.some((r) => r.includes('rm'))).toBe(false);
    await service.shutdown();
  });

  it('says that Cua is not all gone where its runtime stays (Windows) or could not be removed', async () => {
    for (const [runtime, said] of [
      [async () => 'kept-wsl' as const, /wsl --unregister/],
      [async () => 'kept-docker' as const, /Docker still has other Cua sandboxes/],
      [
        async () => {
          throw new Error('Cua’s Linux VM colima-cua could not be deleted: busy');
        },
        /could not be deleted: busy/,
      ],
    ] as const) {
      const service = new ComputerService({
        run: async (args) => (args.includes('ls') ? ok('[]') : ok('{}')),
        available: () => true,
        startMcp: async () => new FakeMcp(),
        dataDir: root,
        handovers: new Handovers(),
        shotsDir: () => join(root, 'shots-removal4'),
        removeRuntime: runtime,
      });
      withLang('en', () => service.startRemoval());
      await vi.waitFor(async () => expect((await service.settingsView(false, () => [])).removal?.state).toBe('failed'));
      expect((await service.settingsView(false, () => [])).removal?.error).toMatch(said);
      await service.shutdown();
    }
  });

  it('says which steps of removing Cua did not finish', async () => {
    const service = new ComputerService({
      run: async (args) => (args.includes('prune') ? fail('cua: cache is locked') : args.includes('ls') ? ok('[]') : ok('{}')),
      available: () => true,
      startMcp: async () => new FakeMcp(),
      dataDir: root,
      handovers: new Handovers(),
      shotsDir: () => join(root, 'shots-removal3'),
    });
    withLang('en', () => service.startRemoval());
    await vi.waitFor(async () => expect((await service.settingsView(false, () => [])).removal?.state).toBe('failed'));
    expect((await service.settingsView(false, () => [])).removal?.error).toMatch(/Clearing the images.*cache is locked/);
    await service.shutdown();
  });

  it('starts no computer while Cua is being removed', async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = new ComputerService({
      run: async (args) => {
        if (args.includes('prune')) await slow;
        if (args.includes('ls')) return ok('[]');
        return ok('{}');
      },
      available: () => true,
      startMcp: async () => new FakeMcp(),
      dataDir: root,
      handovers: new Handovers(),
      shotsDir: () => join(root, 'shots-removal2'),
    });
    service.startRemoval();
    await expect(service.call(ctx(), 'computer_screenshot', {}, 'screenshot')).rejects.toThrow();
    finish();
    await vi.waitFor(async () => expect((await service.settingsView(false, () => [])).removal?.state).toBe('success'));
    await service.shutdown();
  });

  it('gives a link to Cua’s viewer of a computer that is on, to watch only: even while the user has control', async () => {
    const { service, runs } = setup();
    await expect(service.viewerLink('c1')).rejects.toThrow();
    await service.call(ctx(), 'computer_screenshot', {}, 'screenshot');
    expect(await service.viewerLink('c1')).toMatchObject({
      url: 'http://127.0.0.1:41234/viewer/#ticket=abc',
      viewOnly: true,
      expiresAt: 2_000_000,
    });
    expect(runs.at(-1)).toContain('--view-only');
    // Cua cannot take a link back: one with input would go on after the user handed the computer back.
    service.takeControl('c1');
    expect(await service.viewerLink('c1')).toMatchObject({ viewOnly: true });
    expect(runs.at(-1)).toContain('--view-only');
    await service.shutdown();
  });

  it('refuses to start when Cua is not installed', async () => {
    const { service } = setup({ available: false });
    expect(service.unavailable()).toMatch(/Cua/);
    await expect(service.call(ctx(), 'computer_screenshot', {}, 'screenshot')).rejects.toThrow(/Cua/);
    expect(() => service.turnOn('c1')).toThrow(/Cua/);
    expect(await service.settingsView(false, () => [])).toMatchObject({ computers: [] });
    await service.shutdown();
  });
});

describe('the desktop image', () => {
  // cua's log as it writes it (cua 0.31.2 with `CUA_LOG=info,bollard::read=debug`, Docker on Linux).
  const at = '\x1b[2m2026-11-27T18:02:20.454764Z\x1b[0m';
  const debug = (event: object) =>
    `${at} \x1b[34mDEBUG\x1b[0m \x1b[2mbollard::read\x1b[0m\x1b[2m:\x1b[0m Decoding JSON line from stream: ${JSON.stringify(event)}\r`;
  const DIGEST = 'sha256:' + '3c'.repeat(32);
  const info = `${at} \x1b[32m INFO\x1b[0m \x1b[2mcua_vmm::container\x1b[0m\x1b[2m:\x1b[0m pulling image \x1b[3mimage\x1b[0m\x1b[2m=\x1b[0m"ghcr.io/trycua/linux@${DIGEST}"`;
  const layer = (status: string, id: string, progressDetail: object = {}) => debug({ status, progressDetail, id });
  const REF = 'ghcr.io/trycua/linux:24.04';
  const CATALOG = {
    ref: REF,
    sizes: {
      platforms: [
        { arch: 'amd64', download: 1_400_706_377 },
        { arch: 'arm64', download: 1_326_181_369 },
      ],
    },
  };
  const pulled = ok(JSON.stringify({ kind: 'container', reference: `ghcr.io/trycua/linux@${DIGEST}`, size_bytes: 4_952_372_379 }));

  it('finds the desktop image’s reference in Cua’s catalog, with what a pull downloads for this processor', () => {
    expect(desktopImage(CATALOG, 'x64')).toEqual({ ref: REF, download: 1_400_706_377 });
    expect(desktopImage(CATALOG, 'arm64')).toEqual({ ref: REF, download: 1_326_181_369 });
    expect(desktopImage({ ref: REF }, 'x64')).toEqual({ ref: REF });
    expect(desktopImage({ ref: `ghcr.io/trycua/linux@${DIGEST}` }, 'x64')?.ref).toBe(`ghcr.io/trycua/linux@${DIGEST}`);
    // Never an option of cua's, nor anything but a registry's reference.
    for (const ref of ['--runtime=runc/x', '-x/y', 'linux', 'ghcr.io/trycua/linux:24.04 --force', ''])
      expect(desktopImage({ ref }, 'x64')).toBeUndefined();
    expect(desktopImage(undefined)).toBeUndefined();
    expect(desktopImage([CATALOG])).toBeUndefined();
  });

  it('reads Docker’s pull progress from cua’s log: the layers to download, of the catalog’s size until each says its own', () => {
    const p = new PullProgress(1000);
    expect(p.line(info)).toBeUndefined();
    expect(p.line('cua: provider not configured')).toBeUndefined();
    // The image's own line, and its configuration's (a blob that is not a layer), count for nothing.
    expect(p.line(debug({ status: 'Pulling from trycua/linux', id: `ghcr.io/trycua/linux@${DIGEST}` }))).toBeUndefined();
    expect(p.line(layer('Pulling fs layer', '1e6e7ca511b9'))).toEqual({ done: 0, total: 1000 });
    expect(p.line(layer('Waiting', 'db1d5603818e'))).toEqual({ done: 0, total: 1000 });
    expect(p.line(layer('Already exists', '0db1ede1885b'))).toEqual({ done: 0, total: 1000 });
    expect(p.line(layer('Download complete', 'fd18d7b2aa35', { hidecounts: true }))).toEqual({ done: 0, total: 1000 });
    expect(p.line(layer('Downloading', '1e6e7ca511b9', { current: 100, total: 300 }))).toEqual({ done: 100, total: 1000 });
    // Every layer has said its size: theirs, though the catalog said less.
    expect(p.line(layer('Downloading', 'db1d5603818e', { current: 50, total: 900 }))).toEqual({ done: 150, total: 1200 });
    expect(p.line(layer('Download complete', '1e6e7ca511b9', { hidecounts: true }))).toEqual({ done: 350, total: 1200 });
    expect(p.line(layer('Extracting', '1e6e7ca511b9', { current: 1, units: 's' }))).toEqual({ done: 350, total: 1200 });
    expect(p.line(layer('Pull complete', 'db1d5603818e', { hidecounts: true }))).toEqual({ done: 1200, total: 1200 });
    // What is not a line of the stream, or not one it knows.
    expect(p.line(debug({ status: 'Digest: ' + DIGEST }))).toBeUndefined();
    expect(p.line(`${at} DEBUG bollard::read: Decoding JSON line from stream: {not json`)).toBeUndefined();
    expect(
      p.line(`${at} DEBUG other::module: Decoding JSON line from stream: {"status":"Downloading","id":"aaaaaaaaaaaa"}`),
    ).toBeUndefined();
  });

  it('keeps the total while some layers have not said their size: the catalog’s, or the layers’ so far when more, else none', () => {
    // A little larger than the catalog said (seen with cua 0.31.2): the layers' sum, never no total.
    const larger = new PullProgress(100);
    larger.line(layer('Pulling fs layer', 'aaaaaaaaaaaa'));
    larger.line(layer('Pulling fs layer', 'bbbbbbbbbbbb'));
    expect(larger.line(layer('Downloading', 'aaaaaaaaaaaa', { current: 60, total: 110 }))).toEqual({ done: 60, total: 110 });
    expect(larger.line(layer('Downloading', 'bbbbbbbbbbbb', { current: 0, total: 5 }))).toEqual({ done: 60, total: 115 });
    // Without the catalog's size: a total only once every layer has one (a small one that never said is done).
    const none = new PullProgress();
    none.line(layer('Pulling fs layer', 'aaaaaaaaaaaa'));
    none.line(layer('Pulling fs layer', 'bbbbbbbbbbbb'));
    none.line(layer('Pulling fs layer', 'cccccccccccc'));
    expect(none.line(layer('Downloading', 'aaaaaaaaaaaa', { current: 10, total: 100 }))).toEqual({ done: 10 });
    expect(none.line(layer('Download complete', 'cccccccccccc', { hidecounts: true }))).toEqual({ done: 10 });
    expect(none.line(layer('Downloading', 'bbbbbbbbbbbb', { current: 5, total: 50 }))).toEqual({ done: 15, total: 150 });
  });

  it('keeps cua’s own words of its log for the job’s, without its colours, times or debug lines', () => {
    expect(cuaLogLine(info)).toBe(`pulling image image="ghcr.io/trycua/linux@${DIGEST}"`);
    expect(
      cuaLogLine(`${at} \x1b[33m WARN\x1b[0m \x1b[2mcua_vmm::container\x1b[0m\x1b[2m:\x1b[0m gVisor (runsc) not available; using runc`),
    ).toBe('gVisor (runsc) not available; using runc');
    expect(cuaLogLine(layer('Downloading', 'aaaaaaaaaaaa', { current: 1, total: 2 }))).toBeUndefined();
    expect(cuaLogLine('cua: provider not configured: a container engine is not available\r')).toBe(
      'cua: provider not configured: a container engine is not available',
    );
    expect(cuaLogLine('  \r')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('runs cua with the log it asks for, its error output read line by line', async () => {
    const dir = join(root, 'runner-' + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'cua');
    writeFileSync(bin, '#!/bin/sh\necho "log: $CUA_LOG" >&2\necho second >&2\necho done\n', { mode: 0o755 });
    const lines: string[] = [];
    const run = cuaRunner(
      () => bin,
      () => ({ PATH: process.env.PATH, CUA_HOME: join(dir, 'home') }),
    );
    const r = await run(['--json', 'image', 'pull', REF], { timeoutMs: 10_000, log: PULL_LOG, onStderrLine: (l) => lines.push(l) });
    expect(r.stdout.trim()).toBe('done');
    expect(lines).toEqual([`log: ${PULL_LOG}`, 'second']);
    // Without asking, cua's own setting: none of the server's.
    const quiet: string[] = [];
    await run(['--version'], { timeoutMs: 10_000, onStderrLine: (l) => quiet.push(l) });
    expect(quiet[0]).toBe('log: ');
  });

  /** A computer service whose cua answers the catalog and pulls as `pull` says; `record`: where the image is recorded. */
  function imageService(
    o: {
      info?: () => SpawnResult;
      pull?: (opts: { signal?: AbortSignal; onStderrLine?: (line: string) => void }) => Promise<SpawnResult>;
      create?: () => Promise<void>;
      version?: string;
      record?: string;
      runtime?: string;
      available?: boolean;
    } = {},
  ) {
    const runs: { args: string[]; log?: string }[] = [];
    const record = o.record ?? join(root, 'image-' + Math.random().toString(36).slice(2), 'cua-image.json');
    const made = new Set<string>();
    const service = new ComputerService({
      run: async (args, opts) => {
        runs.push({ args, ...(opts.log ? { log: opts.log } : {}) });
        if (args[1] === 'images') return o.info?.() ?? ok(JSON.stringify(CATALOG));
        if (args[1] === 'image') return o.pull ? o.pull(opts) : pulled;
        if (args.includes('info'))
          return made.has(args.at(-1)!.replace(/^local:/, ''))
            ? ok(JSON.stringify({ state: 'running', status: 'ready' }))
            : fail('not found: sandbox');
        if (args.includes('create')) {
          await o.create?.();
          made.add(args[args.indexOf('--name') + 1]!);
          return ok('{"status":"ready"}');
        }
        if (args.includes('ls')) return ok('[]');
        return ok('{}');
      },
      available: () => o.available ?? true,
      found: () => (o.available === false ? undefined : { bin: '/x/cua', version: o.version ?? CUA_VERSION, own: true }),
      runtime: () => o.runtime,
      startMcp: async () => new FakeMcp(),
      dataDir: root,
      imageRecord: record,
      arch: 'x64',
      removalPollMs: 1,
      handovers: new Handovers(),
      folderOf: (id) => (id === 'elsewhere' ? ELSEWHERE : root),
      shotsDir: () => join(dirname(record), 'shots'),
    });
    const pulls = () => runs.filter((r) => r.args[1] === 'image');
    return { service, runs, record, pulls, settings: () => service.settingsView(false, () => []) };
  }

  /** A pull that says how far it is, then waits for `release()`; one that is stopped ends as cua does. */
  function heldPull() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pull = async (opts: { signal?: AbortSignal; onStderrLine?: (line: string) => void }): Promise<SpawnResult> => {
      for (const line of [
        info,
        layer('Pulling fs layer', '1e6e7ca511b9'),
        layer('Pulling fs layer', 'db1d5603818e'),
        layer('Downloading', '1e6e7ca511b9', { current: 200_000_000, total: 400_000_000 }),
      ])
        opts.onStderrLine?.(line);
      const stopped = new Promise<'stopped'>((resolve) => opts.signal?.addEventListener('abort', () => resolve('stopped'), { once: true }));
      if ((await Promise.race([gate.then(() => 'done' as const), stopped])) === 'stopped')
        return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true } as SpawnResult;
      opts.onStderrLine?.(layer('Downloading', 'db1d5603818e', { current: 1_000_000_000, total: 1_000_000_000 }));
      opts.onStderrLine?.(layer('Pull complete', '1e6e7ca511b9'));
      opts.onStderrLine?.(layer('Pull complete', 'db1d5603818e'));
      return pulled;
    };
    return { pull, release };
  }

  it('downloads it from Settings with Docker’s progress, once at a time, and records it for the cua found', async () => {
    const { pull, release } = heldPull();
    const { service, runs, record, pulls, settings } = imageService({ pull });
    expect((await settings()).image).toEqual({});
    withLang('en', () => service.startImage());
    service.startImage();
    await vi.waitFor(async () => expect((await settings()).image?.job?.progress).toEqual({ done: 200_000_000, total: 1_400_706_377 }));
    expect(pulls()).toHaveLength(1);
    expect(runs.map((r) => r.args).filter((a) => a[1] !== 'sb')).toEqual([
      ['--json', 'images', 'info', 'linux'],
      ['--json', 'image', 'pull', REF],
    ]);
    // Docker's progress, as cua logs it at debug for its Docker client.
    expect(pulls()[0]!.log).toBe('info,bollard::read=debug');
    expect((await settings()).image?.job?.state).toBe('running');
    expect((await settings()).image?.downloadedAt).toBeUndefined();
    expect(service.busy()).toBe(1);
    release();
    await vi.waitFor(async () => expect((await settings()).image?.job?.state).toBe('success'));
    const { image } = await settings();
    expect(image?.downloadedAt).toEqual(expect.any(Number));
    expect(image?.job?.progress).toEqual({ done: 1_400_000_000, total: 1_400_000_000 });
    // Its log: what ran and cua's own words, never the stream itself.
    expect(image?.job?.log).toContain(`$ cua image pull ${REF}`);
    expect(image?.job?.log).toContain('pulling image image=');
    expect(image?.job?.log).not.toMatch(/Decoding JSON|bollard/);
    expect(service.busy()).toBe(0);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ at: image?.downloadedAt, cua: CUA_VERSION });
    await service.shutdown();
    // Another server on this data folder knows it; a cua of another version may make computers of another image.
    const again = imageService({ record });
    expect((await again.settings()).image?.downloadedAt).toBe(image?.downloadedAt);
    await again.service.shutdown();
    const other = imageService({ record, version: '0.32.0' });
    expect((await other.settings()).image).toEqual({});
    await other.service.shutdown();
  });

  it('says on macOS and Windows that Cua sets up its own Linux VM first', async () => {
    const { service, settings } = imageService({ runtime: 'builtin' });
    withLang('en', () => service.startImage());
    await vi.waitFor(async () => expect((await settings()).image?.job?.state).toBe('success'));
    expect((await settings()).image?.job?.log).toContain('Cua first sets up its own Linux virtual machine');
    await service.shutdown();
  });

  it('says why it could not be downloaded, in cua’s words, and downloads it again on the user’s word', async () => {
    let catalog = fail('cua: images: unknown command');
    let pullsFail = true;
    const { service, settings } = imageService({
      info: () => catalog,
      pull: async (opts) => {
        if (!pullsFail) return pulled;
        opts.onStderrLine?.(layer('Pulling fs layer', '1e6e7ca511b9'));
        return {
          code: 4,
          stdout: '',
          stderr: `${layer('Pulling fs layer', '1e6e7ca511b9')}\ncua: provider not configured: a container engine is not available: the built-in Linux runtime runs on macOS and Windows\n`,
          timedOut: false,
          aborted: false,
        } as SpawnResult;
      },
    });
    withLang('en', () => service.startImage());
    await vi.waitFor(async () => expect((await settings()).image?.job?.state).toBe('failed'));
    // Said in the language each request asks in.
    expect((await withLang('en', () => settings())).image?.job?.error).toBe(
      "Could not look up Cua's desktop image: cua: images: unknown command",
    );
    expect((await withLang('zh-TW', () => settings())).image?.job?.error).toMatch(/^無法查到 Cua 的桌面映像檔: cua: images/);
    catalog = ok(JSON.stringify(CATALOG));
    withLang('zh-TW', () => service.startImage());
    await vi.waitFor(async () => expect((await settings()).image?.job?.state).toBe('failed'));
    const { image } = await withLang('en', () => settings());
    expect(image?.job?.error).toBe(
      'Could not download the desktop image: cua: provider not configured: a container engine is not available: the built-in Linux runtime runs on macOS and Windows',
    );
    expect(image?.downloadedAt).toBeUndefined();
    pullsFail = false;
    service.startImage();
    await vi.waitFor(async () => expect((await settings()).image?.downloadedAt).toEqual(expect.any(Number)));
    await service.shutdown();
  });

  it('makes a computer started meanwhile wait for it, its panel told how far it is; the next one is said to start quickly', async () => {
    const { pull, release } = heldPull();
    let createGate: Promise<void> | undefined;
    const { service, runs } = imageService({ pull, create: () => createGate ?? Promise.resolve() });
    service.startImage();
    await vi.waitFor(() => expect(runs.some((r) => r.args[1] === 'image')).toBe(true));
    const states: ComputerScreenEvent[] = [];
    const unwatch = service.watch('c1', (e) => states.push(e));
    withLang('en', () => service.turnOn('c1'));
    await vi.waitFor(() => expect(service.view('c1').image).toEqual({ done: 200_000_000, total: 1_400_706_377 }));
    expect(service.view('c1').status).toBe('starting');
    expect(withLang('en', () => service.view('c1')).recent.map((a) => a.what)).toContain(
      'Waiting for the desktop image Settings is downloading, then making the computer',
    );
    expect(states.some((e) => e.type === 'state' && e.view.image)).toBe(true);
    // Not made beside the download: Cua would download the image a second time.
    expect(runs.some((r) => r.args.includes('create'))).toBe(false);
    release();
    await vi.waitFor(() => expect(service.view('c1').status).toBe('ready'));
    const order = runs.map((r) => (r.args[1] === 'image' ? 'pull' : r.args.includes('create') ? 'create' : '')).filter(Boolean);
    expect(order).toEqual(['pull', 'create']);
    expect(service.view('c1').image).toBeUndefined();
    unwatch();
    // Another folder's computer: the image is here, so its panel does not say a first start downloads it.
    let made!: () => void;
    createGate = new Promise<void>((resolve) => {
      made = resolve;
    });
    service.turnOn('elsewhere');
    await vi.waitFor(() => expect(service.view('elsewhere')).toMatchObject({ status: 'starting', imageReady: true }));
    made();
    await vi.waitFor(() => expect(service.view('elsewhere').status).toBe('ready'));
    expect(service.view('elsewhere').imageReady).toBeUndefined();
    await service.shutdown();
  });

  it('a computer made without Settings’ download records the image too', async () => {
    const { service, settings } = imageService();
    expect((await settings()).image?.downloadedAt).toBeUndefined();
    service.turnOn('c1');
    await vi.waitFor(() => expect(service.view('c1').status).toBe('ready'));
    expect((await settings()).image?.downloadedAt).toEqual(expect.any(Number));
    await service.shutdown();
  });

  it('is stopped by Remove Cua, which forgets it; no download starts while Cua is being removed, nor without Cua', async () => {
    const { pull } = heldPull();
    const { service, record, settings } = imageService({ pull });
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ at: 1, cua: CUA_VERSION }));
    service.startImage();
    await vi.waitFor(async () => expect((await settings()).image?.job?.progress).toBeDefined());
    service.startRemoval();
    await vi.waitFor(async () => expect((await settings()).removal?.state).toBe('success'));
    const { image } = await settings();
    expect(image?.job?.state).toBe('cancelled');
    expect(image?.downloadedAt).toBeUndefined();
    expect(existsSync(record)).toBe(false);
    await service.shutdown();

    // While Cua is being removed (its listing held): no download.
    let listed!: () => void;
    const held = new Promise<void>((resolve) => {
      listed = resolve;
    });
    const removing = new ComputerService({
      run: async (args) => {
        if (args.includes('ls')) await held;
        return args.includes('ls') ? ok('[]') : ok('{}');
      },
      available: () => true,
      startMcp: async () => new FakeMcp(),
      dataDir: root,
      imageRecord: join(root, 'image-removing', 'cua-image.json'),
      handovers: new Handovers(),
      shotsDir: () => join(root, 'shots-image-removing'),
    });
    removing.startRemoval();
    expect(() => withLang('en', () => removing.startImage())).toThrow('Cua is being removed');
    listed();
    await removing.shutdown();

    const missing = imageService({ available: false });
    expect(() => withLang('en', () => missing.service.startImage())).toThrow('Cua is not installed here');
    expect((await missing.settings()).image).toBeUndefined();
    await missing.service.shutdown();
  });

  it('stops a download under way at shutdown, and starts none after', async () => {
    const { pull } = heldPull();
    const { service, settings } = imageService({ pull });
    service.startImage();
    await vi.waitFor(async () => expect((await settings()).image?.job?.progress).toBeDefined());
    await service.shutdown();
    expect((await settings()).image?.job?.state).toBe('cancelled');
    expect(service.busy()).toBe(0);
    expect(() => service.startImage()).toThrow();
  });
});

describe('copying files in and out', () => {
  const work = join(root, 'work');
  const outside = join(root, 'outside');
  mkdirSync(join(work, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(work, 'app.py'), 'print(1)');
  writeFileSync(join(outside, 'secret.txt'), 'no');
  const linked = process.platform !== 'win32';
  if (linked) symlinkSync(join(outside, 'secret.txt'), join(work, 'link.txt'));

  it('takes only paths inside the working directory, links resolved', () => {
    expect(insideFolder(work, 'app.py')).toBe(join(work, 'app.py'));
    expect(insideFolder(work, '../outside/secret.txt')).toEqual({ error: expect.stringContaining('outside') });
    expect(insideFolder(work, join(outside, 'secret.txt'))).toEqual({ error: expect.stringContaining('outside') });
    expect(insideFolder(work, 'missing.txt')).toEqual({ error: expect.stringContaining('does not exist') });
    expect(insideFolder(work, 'sub/new.txt', true)).toBe(join(work, 'sub', 'new.txt'));
    expect(insideFolder(work, 'sub', true)).toEqual({ error: expect.stringContaining('not a file') });
    expect(insideFolder(work, 'nowhere/new.txt', true)).toEqual({ error: expect.stringContaining('does not exist') });
    expect(insideFolder(work, '')).toEqual({ error: expect.any(String) });
    if (linked) {
      expect(insideFolder(work, 'link.txt')).toEqual({ error: expect.stringContaining('outside') });
      expect(insideFolder(work, 'link.txt', true)).toEqual({ error: expect.stringContaining('not a file') });
    }
    expect(isGuestPath('/home/cua/x')).toBe(true);
    expect(isGuestPath('home/cua')).toBe(false);
    expect(isGuestPath('/a\nb')).toBe(false);
  });

  const tmp = join(root, 'tmp');
  const data = join(root, 'relay-data');

  it('copies a file in through a copy of its own, and out through a file of its own into place', async () => {
    const uploads: string[] = [];
    const { service, runs } = setup({
      dataDir: data,
      cp: (args) => {
        if (args[3]!.startsWith('local:')) uploads.push(readFileSync(args[2]!, 'utf8'));
      },
    });
    const c = ctx({ cwd: work });
    await service.call(c, 'computer_screenshot', {}, 'screenshot');
    expect(await service.upload(c, 'app.py', '/home/cua/Desktop/app.py', tmp)).toEqual({
      text: 'Copied app.py to /home/cua/Desktop/app.py in the computer.',
    });
    // What cua reads is Harness Relay's copy of the file as it was checked, gone once copied.
    const cp = runs.at(-1)!;
    expect(cp).toEqual(['sb', 'cp', expect.stringContaining(tmp), `local:${computerName(data, folderKey(root))}:/home/cua/Desktop/app.py`]);
    expect(uploads).toEqual(['print(1)']);
    expect(existsSync(cp[2]!)).toBe(false);
    expect((await service.upload(c, 'sub', '/tmp/x', join(root, 'tmp'))).isError).toBe(true);
    expect((await service.upload(c, 'app.py', 'relative', join(root, 'tmp'))).isError).toBe(true);
    expect((await service.download(ctx({ cwd: work, permission: 'read-only' }), '/tmp/r.txt', 'r.txt', join(root, 'tmp'))).isError).toBe(
      true,
    );
    expect(await service.download(c, '/tmp/r.txt', 'sub/r.txt', join(root, 'tmp'))).toEqual({
      text: 'Copied /tmp/r.txt from the computer to sub/r.txt in the working directory.',
    });
    expect(readFileSync(join(work, 'sub', 'r.txt'), 'utf8')).toBe('from the computer');
    await service.shutdown();
  });

  it('never copies what is kept from agents: .git, the data folder, the protected folders, the withheld files', async () => {
    const inner = join(work, 'data');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'relay.db'), 'db');
    mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(work, '.git', 'config'), '[core]');
    mkdirSync(join(work, 'profile'), { recursive: true });
    writeFileSync(join(work, 'profile', 'Cookies'), 'c');
    // Harness Relay's data folder inside the working directory (a read-only chat may work there).
    const { service, runs } = setup({ dataDir: inner, protectedPaths: [join(work, 'profile')] });
    const c = ctx({ cwd: work });
    await service.call(c, 'computer_screenshot', {}, 'screenshot');
    const before = runs.length;
    for (const path of ['.git/config', 'data/relay.db', 'profile/Cookies'])
      expect(await service.upload(c, path, '/tmp/x', tmp), path).toMatchObject({
        isError: true,
        text: expect.stringMatching(/keeps from agents/),
      });
    for (const path of ['.git/hooks/pre-commit', 'data/new.txt', 'profile/x'])
      expect(await service.download(c, '/tmp/r.txt', path, tmp), path).toMatchObject({
        isError: true,
        text: expect.stringMatching(/keeps from agents/),
      });
    expect(runs.slice(before).some((r) => r[1] === 'cp')).toBe(false);
    expect(existsSync(join(work, '.git', 'hooks', 'pre-commit'))).toBe(false);
    // The files this server withholds (its database's, wherever it is).
    writeFileSync(join(work, 'app.db'), 'x');
    const withheld = new Set([fileKey(statSync(join(work, 'app.db'), { bigint: true }))]);
    expect(insideFolder(work, 'app.db', false, { dataDir: data, protectedPaths: () => [], withheld: () => withheld })).toEqual({
      error: expect.stringMatching(/keeps from agents/),
    });
    await service.shutdown();
  });

  it.skipIf(process.platform === 'win32')(
    'places a file copied out only where it was checked: a link put in its way meanwhile is refused',
    async () => {
      mkdirSync(join(work, 'drop'), { recursive: true });
      const { service } = setup({
        dataDir: data,
        cp: (args) => {
          if (!args[2]!.startsWith('local:')) return;
          rmSync(join(work, 'drop'), { recursive: true });
          symlinkSync(outside, join(work, 'drop'));
        },
      });
      const c = ctx({ cwd: work });
      await service.call(c, 'computer_screenshot', {}, 'screenshot');
      expect(await service.download(c, '/tmp/evil', 'drop/evil.plist', tmp)).toMatchObject({
        isError: true,
        text: expect.stringContaining('outside'),
      });
      expect(existsSync(join(outside, 'evil.plist'))).toBe(false);
      await service.shutdown();
    },
  );

  it.skipIf(process.platform === 'win32')('reads a file it copies in through the descriptor it opened, never through a link', async () => {
    writeFileSync(join(work, 'mine.txt'), 'mine');
    symlinkSync(join(outside, 'secret.txt'), join(work, 'swapped.txt'));
    await expect(pinnedCopy(join(work, 'swapped.txt'), tmp)).rejects.toThrow();
    const copy = await pinnedCopy(join(work, 'mine.txt'), tmp);
    expect(readFileSync(copy, 'utf8')).toBe('mine');
  });
});

describe('the computer tools', () => {
  const { service } = setup();
  const tools = computerTools(service, () => join(root, 'tmp'));
  const byName = new Map(tools.map((t) => [t.name, t]));

  it('look as read, act as act, and hand over at once', () => {
    expect(tools.every((t) => t.group === 'computer')).toBe(true);
    expect(byName.get('computer_screenshot')!.tier).toBe('read');
    expect(byName.get('computer_hand_over')).toMatchObject({ tier: 'read', direct: true });
    for (const name of [
      'computer_click',
      'computer_type',
      'computer_key',
      'computer_scroll',
      'computer_drag',
      'computer_open',
      'computer_shell',
      'computer_upload',
      'computer_download',
    ])
      expect(byName.get(name)!.tier, name).toBe('act');
  });

  it('say what a call does on its approval card', () =>
    withLang('en', () => {
      expect(byName.get('computer_click')!.describe({ x: 10, y: 20 }).title).toBe('Click at (10, 20) on the computer');
      expect(byName.get('computer_click')!.describe({ x: 1, y: 2, double: true }).title).toBe('Double-click at (1, 2) on the computer');
      expect(byName.get('computer_type')!.describe({ text: 'hello' })).toEqual({
        title: 'Type the text below on the computer',
        detail: 'hello',
      });
      expect(byName.get('computer_shell')!.describe({ command: 'apt-get install x' })).toEqual({
        title: 'Run the command below in the computer',
        detail: 'apt-get install x',
      });
      expect(byName.get('computer_upload')!.describe({ path: 'dist/app' }).title).toBe(
        'Copy dist/app from the working directory to /home/cua/Desktop/app in the computer',
      );
    }));

  it('check keys and coordinates before anything reaches the computer', async () => {
    expect(keysOf({ keys: 'Ctrl+C' })).toBe('ctrl+c');
    expect(keysOf({ keys: 'page_up' })).toBe('page_up');
    for (const keys of ['', 'ctrl+', '+c', 'a b', 'ctrl+c;rm', 'x'.repeat(40)]) expect(() => keysOf({ keys }), keys).toThrow();
    await expect(byName.get('computer_click')!.run!({ x: -1, y: 0 }, ctx())).rejects.toThrow(/whole number/);
    expect(await byName.get('computer_type')!.run!({ text: '' }, ctx())).toMatchObject({ isError: true });
    expect(await byName.get('computer_hand_over')!.run!({ reason: ' ' }, ctx())).toMatchObject({ isError: true });
  });
});

describe('the panel’s input', () => {
  it('takes only events it knows, in range', () => {
    expect(
      checkComputerInputs([
        { type: 'click', x: 0, y: 1, button: 'right' },
        { type: 'click', x: 0.5, y: 0.5, double: true },
        { type: 'drag', x: 0, y: 0, toX: 1, toY: 1 },
        { type: 'scroll', x: 0.1, y: 0.2, direction: 'up', amount: 2 },
        { type: 'key', keys: 'ctrl+shift+t' },
        { type: 'key', keys: 'page_down' },
        { type: 'text', text: '中文' },
      ]),
    ).toHaveLength(7);
    for (const bad of [
      [],
      'x',
      [{ type: 'click', x: 2, y: 0 }],
      [{ type: 'click', x: 0, y: 0, button: 'back' }],
      [{ type: 'scroll', x: 0, y: 0, direction: 'in', amount: 1 }],
      [{ type: 'scroll', x: 0, y: 0, direction: 'up', amount: 99 }],
      [{ type: 'key', keys: 'ctrl+c; rm -rf' }],
      [{ type: 'text', text: '' }],
      [{ type: 'text', text: 'x'.repeat(2001) }],
      [{ type: 'navigate', url: 'https://x' }],
      Array(51).fill({ type: 'text', text: 'a' }),
    ])
      expect(typeof checkComputerInputs(bad), JSON.stringify(bad).slice(0, 60)).toBe('string');
  });
});
