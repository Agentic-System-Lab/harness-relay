import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { InstallJob, NODE_VERSION, folderNpm, type NodeBuild } from '../src/server/cliInstall';
import { openDatabase } from '../src/server/db';
import { Hub } from '../src/server/hub';
import { withLang } from '../src/server/i18n';
import { Orchestrator } from '../src/server/orchestrator';
import { runShellScript, type RunOptions, type SpawnOptions, type SpawnResult } from '../src/server/process';
import { ProviderService } from '../src/server/providers';
import { hostNode, relaySandboxTools, sandboxNode, sandboxNodeFolder } from '../src/server/relaySandbox';
import {
  ADMIN_SCRIPT,
  SCRIPT_CANNOT_RUN,
  APPARMOR_FILE,
  APPARMOR_PROFILE,
  LINUX_NEEDS,
  SandboxSetup,
  USERNS_RESTRICTION,
  letsBwrap,
  type SandboxSetupHost,
} from '../src/server/sandboxSetup';
import { SettingsStore } from '../src/server/settings';
import { Store } from '../src/server/store';
import { slow } from './timeouts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-sandbox-setup-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function result(code: number | null, stdout = '', o: Partial<SpawnResult> = {}): SpawnResult {
  const bytes = Buffer.from(stdout);
  return {
    code,
    signal: null,
    stdout,
    stdoutBytes: bytes,
    stdoutTruncated: false,
    stdoutSize: bytes.length,
    stderr: '',
    aborted: false,
    timedOut: false,
    ...o,
  };
}

/** Every program the Linux sandboxes need, where a Debian or Ubuntu has them. */
const ALL_LINUX = [
  '/usr/bin/bwrap',
  '/usr/bin/socat',
  '/usr/bin/rg',
  '/usr/bin/slirp4netns',
  '/usr/sbin/ip',
  '/usr/sbin/iptables',
  '/usr/sbin/ip6tables',
  '/usr/sbin/iptables-restore',
  '/usr/sbin/ip6tables-restore',
  '/usr/bin/unshare',
  '/usr/bin/nsenter',
];
/** Where an x64 Debian or Ubuntu has libatomic, which Node.js's Linux builds run with. */
const LIBATOMIC = '/usr/lib/x86_64-linux-gnu/libatomic.so.1';
const BASE = ['/bin/sh', '/usr/bin/env', '/usr/bin/curl', '/usr/bin/tar', LIBATOMIC];

/** Claude Code's docs' profile for `/usr/bin/bwrap`, as homelab has it. */
const CLAUDE_PROFILE =
  'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n';

type Run = SpawnOptions & { script?: string };

/**
 * A computer without network or real installers: `programs` are the ones it has (an install adds
 * what it installs, as `onRun` answers or the default does: every program the Linux sandboxes need).
 */
function setup(
  o: {
    platform?: NodeJS.Platform;
    arch?: string;
    electron?: boolean;
    uid?: number;
    programs?: string[];
    /** The programs every computer here has (sh, env, curl, tar, libatomic), unless given. */
    base?: string[];
    files?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    sudo?: boolean;
    pathNode?: string | null;
    nodeBuild?: SandboxSetupHost['nodeBuild'];
    onRun?: (s: Run, programs: Set<string>) => SpawnResult | Promise<SpawnResult> | undefined;
  } = {},
) {
  const programs = new Set([...(o.base ?? BASE), ...(o.programs ?? ['/usr/bin/apt-get', '/usr/bin/sudo'])]);
  const files = { ...o.files };
  const calls: Run[] = [];
  const dataDir = join(root, `data-${++n}`);
  const nodeDir = sandboxNodeFolder(dataDir);
  const answer = async (s: Run): Promise<SpawnResult> => {
    calls.push(s);
    const r = await o.onRun?.(s, programs);
    if (r) return r;
    const tool = basename(s.bin);
    if (tool === 'curl') {
      const out = s.args[s.args.indexOf('-o') + 1]!;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, '');
    } else if (tool === 'tar') {
      const npm = folderNpm(s.args[s.args.indexOf('-C') + 1]!, 'linux');
      for (const f of [npm.bin, ...npm.args]) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, '');
        chmodSync(f, 0o755);
      }
    } else if (tool !== 'node') {
      // The administrator's script: the packages are there afterwards (curl and libatomic too), and the profile.
      for (const p of [...ALL_LINUX, '/usr/bin/curl', LIBATOMIC]) programs.add(p);
      if (s.script !== undefined || s.args.includes('-c')) files[APPARMOR_FILE] = APPARMOR_PROFILE;
    }
    return result(0, `${tool} done`);
  };
  const host: Partial<SandboxSetupHost> = {
    platform: o.platform ?? 'linux',
    arch: o.arch ?? 'x64',
    env: o.env ?? { PATH: '/usr/bin:/bin', KEEP: 'me' },
    electron: o.electron ?? false,
    uid: o.uid ?? 1000,
    isProgram: (p) => programs.has(p),
    isFile: (p) => programs.has(p) || (p.startsWith(root) && existsSync(p) && statSync(p).isFile()),
    read: (p) => files[p],
    list: (d) =>
      Object.keys(files)
        .filter((f) => dirname(f) === d)
        .map((f) => basename(f)),
    sudoWorks: () => o.sudo ?? true,
    pathNode: () => (o.pathNode === undefined ? null : o.pathNode),
    nodeDir,
    ...(o.nodeBuild ? { nodeBuild: o.nodeBuild } : {}),
    run: (s) => answer(s),
    runScript: (shell: string, flags: readonly string[], script: string, run: RunOptions) =>
      answer({ ...run, bin: shell, args: [...flags], script }),
  };
  // The Node.js put into `nodeDir`, as the relay sandbox finds it there.
  host.installedNode = () => sandboxNode(dataDir);
  const changed = vi.fn();
  return { s: new SandboxSetup({ changed }, host), host, calls, programs, files, nodeDir, changed };
}

async function ended(s: SandboxSetup) {
  await vi.waitFor(() => expect(s.view().job?.state).not.toBe('running'));
  return s.view();
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** The fake build for Linux, whose download (empty here) checks. */
const linuxBuild = (): NodeBuild => ({
  ...fakeBuild(),
  url: 'https://nodejs.org/x/node-v26.0.0-linux-x64.tar.gz',
  file: 'node-v26.0.0-linux-x64.tar.gz',
});
const fakeBuild = (): NodeBuild => ({
  version: '26.0.0',
  url: 'https://nodejs.org/dist/v26.0.0/node-v26.0.0-darwin-arm64.tar.gz',
  file: 'node-v26.0.0-darwin-arm64.tar.gz',
  sha256: EMPTY_SHA256,
  members: ['node-v26.0.0-darwin-arm64/bin/node', 'node-v26.0.0-darwin-arm64/lib/node_modules/npm'],
});

describe('what the sandboxes need', () => {
  it('on Linux, names the packages missing with the package manager’s names, whose sandboxes run them, and the command', () => {
    const { s } = setup();
    const v = s.view();
    expect(v.admin).toBe('sudo');
    expect(v.needs).toEqual([
      {
        kind: 'packages',
        items: ['bubblewrap', 'socat', 'ripgrep', 'slirp4netns', 'iproute2', 'iptables', 'util-linux'],
        for: ['claude', 'codex', 'grok', 'copilot', 'open'],
        command: 'sudo apt-get install -y bubblewrap socat ripgrep slirp4netns iproute2 iptables util-linux',
      },
    ]);
    // Only what is missing: here Copilot's, ip6tables alone bringing iptables.
    const some = setup({
      programs: ['/usr/bin/apt-get', '/usr/bin/sudo', ...ALL_LINUX.filter((p) => !/slirp4netns|ip6tables$/.test(p))],
    }).s.view();
    expect(some.needs).toMatchObject([{ kind: 'packages', items: ['slirp4netns', 'iptables'], for: ['copilot'] }]);
    // dnf's names for iproute2 and iptables.
    const fedora = setup({
      programs: [
        '/usr/bin/dnf',
        '/usr/bin/sudo',
        '/usr/bin/bwrap',
        '/usr/bin/socat',
        '/usr/bin/rg',
        '/usr/bin/slirp4netns',
        '/usr/bin/unshare',
        '/usr/bin/nsenter',
      ],
    }).s.view();
    expect(fedora.needs[0]).toMatchObject({ items: ['iproute', 'iptables-nft'], command: 'sudo dnf install -y iproute iptables-nft' });
    expect(setup({ programs: ['/usr/bin/pacman', '/usr/bin/sudo'] }).s.view().needs[0]!.command).toMatch(
      /^sudo pacman -S --needed bubblewrap /,
    );
    expect(setup({ programs: ['/usr/sbin/zypper', '/usr/bin/sudo'] }).s.view().needs[0]!.command).toMatch(
      /^sudo zypper install bubblewrap /,
    );
    // Found on the PATH too.
    expect(
      setup({
        programs: ['/usr/bin/apt-get', '/usr/bin/sudo', ...ALL_LINUX.filter((p) => !p.endsWith('/rg')), '/opt/rg/rg'],
        env: { PATH: '/opt/rg' },
      }).s.view().needs,
    ).toEqual([]);
  });

  it('says when it cannot install the packages here: no package manager it knows, or no way to get administrator rights', () => {
    const none = setup({ programs: ['/usr/bin/sudo'] }).s.view();
    expect(none.needs[0]).toMatchObject({
      blocked: 'packageManager',
      command: 'bubblewrap socat ripgrep slirp4netns iproute2 iptables util-linux',
    });
    // sudo asks for a password, and no desktop session for pkexec's prompt.
    const noAdmin = setup({ sudo: false, programs: ['/usr/bin/apt-get', '/usr/bin/sudo', '/usr/bin/pkexec'] }).s.view();
    expect(noAdmin.admin).toBeUndefined();
    expect(noAdmin.needs[0]).toMatchObject({ blocked: 'admin', command: expect.stringMatching(/^sudo apt-get install -y /) });
    // In a desktop session, pkexec shows its prompt; as root, nothing is asked.
    expect(
      setup({
        sudo: false,
        programs: ['/usr/bin/apt-get', '/usr/bin/sudo', '/usr/bin/pkexec'],
        env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0' },
      }).s.view().admin,
    ).toBe('pkexec');
    expect(
      setup({ sudo: false, programs: ['/usr/bin/apt-get', '/usr/bin/pkexec'], env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' } }).s.view()
        .admin,
    ).toBe('pkexec');
    expect(setup({ uid: 0, programs: ['/usr/bin/apt-get'] }).s.view().admin).toBe('root');
  });

  it('asks sudo whether it needs a password once a minute at most', () => {
    const sudoWorks = vi.fn(() => true);
    const s = new SandboxSetup(
      {},
      {
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        uid: 1000,
        electron: false,
        isProgram: (p) => ['/usr/bin/sudo', '/usr/bin/apt-get'].includes(p),
        read: () => undefined,
        list: () => [],
        sudoWorks,
      },
    );
    s.view();
    s.view();
    expect(sudoWorks).toHaveBeenCalledTimes(1);
  });

  it('on Ubuntu 23.10 and later, asks for the AppArmor profile that lets bubblewrap make user namespaces, unless one does', () => {
    const restricted = { [USERNS_RESTRICTION]: '1\n' };
    const programs = ['/usr/bin/apt-get', '/usr/bin/sudo', '/usr/sbin/apparmor_parser', ...ALL_LINUX];
    const v = setup({ programs, files: restricted }).s.view();
    expect(v.needs).toEqual([
      {
        kind: 'apparmor',
        items: [APPARMOR_FILE],
        for: ['claude', 'codex', 'grok', 'copilot', 'open'],
        command: `sudo tee ${APPARMOR_FILE} > /dev/null <<'EOF'\n${APPARMOR_PROFILE}\nEOF\nsudo apparmor_parser -r ${APPARMOR_FILE}`,
      },
    ]);
    expect(v.admin).toBe('sudo');
    // Claude Code's docs' profile (as on homelab), or Harness Relay's: nothing to do.
    expect(setup({ programs, files: { ...restricted, '/etc/apparmor.d/bwrap': CLAUDE_PROFILE } }).s.view().needs).toEqual([]);
    expect(setup({ programs, files: { ...restricted, [APPARMOR_FILE]: APPARMOR_PROFILE } }).s.view().needs).toEqual([]);
    // Not restricted, or no AppArmor to load a profile with (a container): nothing either.
    expect(setup({ programs, files: { [USERNS_RESTRICTION]: '0\n' } }).s.view().needs).toEqual([]);
    expect(setup({ programs: programs.filter((p) => !p.includes('apparmor')), files: restricted }).s.view().needs).toEqual([]);
    expect(letsBwrap(CLAUDE_PROFILE)).toBe(true);
    expect(letsBwrap('profile x /usr/bin/bwrap {\n  # userns,\n}')).toBe(false);
    expect(letsBwrap('profile chrome /opt/chrome {\n  userns,\n}')).toBe(false);
  });

  it('in the desktop app with no Node.js on the PATH, asks for one for Harness Relay’s own sandbox, on macOS and Linux', () => {
    const mac = setup({ platform: 'darwin', arch: 'arm64', electron: true, programs: [] });
    const file = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
    expect(mac.s.view()).toEqual({
      platform: 'darwin',
      needs: [
        {
          kind: 'node',
          items: [NODE_VERSION],
          for: ['open'],
          // Checked as the setup checks it, into the folder quoted (the desktop app's has a space in it).
          command: [
            `curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/${file}`,
            `echo "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735  ${file}" | shasum -a 256 -c -`,
            `mkdir -p "${mac.nodeDir}"`,
            `tar -xf ${file} -C "${mac.nodeDir}" --strip-components 1 node-v${NODE_VERSION}-darwin-arm64/bin/node node-v${NODE_VERSION}-darwin-arm64/lib/node_modules/npm`,
          ].join(' && '),
        },
      ],
    });
    expect(setup({ arch: 'x64', electron: true }).s.view().needs[0]!.command).toContain('| sha256sum -c -');
    // A Node.js on the PATH, or run from the source (on Node itself): nothing.
    expect(setup({ platform: 'darwin', electron: true, pathNode: '/opt/homebrew/bin/node' }).s.view().needs).toEqual([]);
    expect(setup({ platform: 'darwin', electron: false }).s.view().needs).toEqual([]);
    // Linux: first, before the packages.
    expect(
      setup({ electron: true })
        .s.view()
        .needs.map((n) => n.kind),
    ).toEqual(['node', 'packages']);
    // No build of Node.js's own for this processor, or no curl and no way to install it: said so.
    expect(setup({ platform: 'darwin', arch: 'ia32', electron: true }).s.view().needs[0]).toMatchObject({
      kind: 'node',
      blocked: 'node',
      items: [],
    });
    expect(
      setup({
        platform: 'darwin',
        arch: 'arm64',
        electron: true,
        programs: [],
        env: { PATH: '/nowhere' },
        nodeBuild: () => fakeBuild(),
      }).s.view().needs[0]!.blocked,
    ).toBeUndefined();
  });

  it('on Linux without curl (as Ubuntu’s desktop), installs it with the packages, then downloads Node.js', () => {
    const noCurl = ['/bin/sh', '/usr/bin/env', '/usr/bin/tar', LIBATOMIC];
    const { s, nodeDir } = setup({ electron: true, base: noCurl });
    const needs = s.view().needs;
    expect(needs.map((n) => n.kind)).toEqual(['packages', 'node']);
    expect(needs[0]).toMatchObject({
      items: ['curl', 'bubblewrap', 'socat', 'ripgrep', 'slirp4netns', 'iproute2', 'iptables', 'util-linux'],
      command: expect.stringMatching(/^sudo apt-get install -y curl bubblewrap /),
    });
    expect(needs[0]!.for).toContain('open');
    expect(needs[1]).toEqual({
      kind: 'node',
      items: [NODE_VERSION],
      for: ['open'],
      command: expect.stringContaining(`mkdir -p "${nodeDir}"`),
    });
    // No administrator rights here: curl is among the packages to install by hand, and Node.js waits for it.
    const by = setup({ electron: true, base: noCurl, sudo: false }).s.view().needs;
    expect(by.map((n) => [n.kind, n.blocked])).toEqual([
      ['packages', 'admin'],
      ['node', 'curl'],
    ]);
    expect(by[0]!.command).toMatch(/^sudo apt-get install -y curl /);
    // curl there: not among the packages.
    expect(setup({ electron: true }).s.view().needs[1]!.items).not.toContain('curl');
  });

  it('on Linux without libatomic, which Node.js’s builds run with, installs it with the packages, by each package manager’s name', () => {
    const noAtomic = ['/bin/sh', '/usr/bin/env', '/usr/bin/curl', '/usr/bin/tar'];
    const apt = setup({ electron: true, base: noAtomic }).s.view().needs;
    expect(apt.map((n) => [n.kind, n.blocked])).toEqual([
      ['packages', undefined],
      ['node', undefined],
    ]);
    expect(apt[0]!.items[0]).toBe('libatomic1');
    const dnf = setup({ electron: true, base: noAtomic, programs: ['/usr/bin/dnf', '/usr/bin/sudo'] }).s.view().needs;
    expect(dnf[0]!.items[0]).toBe('libatomic');
    // Found where an arm64 Debian keeps it, or in /usr/lib64 (Fedora's).
    expect(
      setup({ electron: true, arch: 'arm64', base: [...noAtomic, '/usr/lib/aarch64-linux-gnu/libatomic.so.1'] }).s.view().needs[0]!.kind,
    ).toBe('node');
    expect(setup({ electron: true, base: [...noAtomic, '/usr/lib64/libatomic.so.1'] }).s.view().needs[0]!.kind).toBe('node');
    // No administrator rights: Node.js waits for it, said so.
    expect(
      setup({ electron: true, base: noAtomic, sudo: false })
        .s.view()
        .needs.map((n) => [n.kind, n.blocked]),
    ).toEqual([
      ['packages', 'admin'],
      ['node', 'libatomic'],
    ]);
    // Not asked for without the desktop app's Node.js.
    expect(setup({ base: noAtomic }).s.view().needs[0]!.items).not.toContain('libatomic1');
  });

  it('has nothing to install on Windows, nor on macOS from the source', () => {
    expect(setup({ platform: 'win32', electron: true }).s.view()).toEqual({ platform: 'win32', needs: [] });
    expect(setup({ platform: 'darwin' }).s.view()).toEqual({ platform: 'darwin', needs: [] });
  });

  it('keeps Harness Relay’s Node.js beside the CLIs it installed, where agents may not write', () => {
    const data = join(root, 'data-x');
    expect(sandboxNodeFolder(data)).toBe(join(data, 'clis', 'sandbox-node'));
    expect(sandboxNode(data)).toBeNull();
  });
});

describe('installing what the sandboxes need', () => {
  it('installs the packages in one run of the fixed script with sudo, what it works on in its environment', async () => {
    const { s, calls, changed } = setup();
    const started = s.install();
    expect(started.job?.state).toBe('running');
    const v = await ended(s);
    expect(v.job?.state).toBe('success');
    expect(v.needs).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe('/usr/bin/sudo');
    expect(calls[0]!.args).toEqual([
      '-n',
      '/usr/bin/env',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'HARNESS_RELAY_PM=apt',
      'HARNESS_RELAY_PACKAGES=bubblewrap socat ripgrep slirp4netns iproute2 iptables util-linux',
      'HARNESS_RELAY_APPARMOR=',
      `HARNESS_RELAY_APPARMOR_FILE=${APPARMOR_FILE}`,
      '/bin/sh',
      '-c',
      ADMIN_SCRIPT,
    ]);
    expect(calls[0]!.env).toMatchObject({ NO_COLOR: '1' });
    expect(calls[0]!.env).not.toHaveProperty('KEEP');
    expect(v.job?.log).toContain('$ sudo apt-get install bubblewrap socat ripgrep slirp4netns iproute2 iptables util-linux');
    expect(changed).toHaveBeenCalled();
  });

  it('serializes shared package installs across Git and sandbox jobs', async () => {
    let release!: (value: SpawnResult) => void;
    const installing = new Promise<SpawnResult>((resolve) => {
      release = resolve;
    });
    const { s, calls } = setup({ onRun: (step) => (step.args.includes('HARNESS_RELAY_PACKAGES=git') ? installing : undefined) });
    const git = s.linux.install(new InstallJob(), ['git']);
    s.install();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args).toContain('HARNESS_RELAY_PACKAGES=git');
    release(result(0));
    await git;
    expect((await ended(s)).job?.state).toBe('success');
    expect(calls).toHaveLength(2);
  });

  it('as root, runs the script itself; with pkexec, asks once for the password, and says so when it was not given', async () => {
    const root0 = setup({
      uid: 0,
      env: { PATH: '/test/node_modules/.bin:/usr/bin', GH_TOKEN: 'test-token', OPENAI_API_KEY: 'test-key' },
      programs: ['/usr/bin/apt-get', '/usr/sbin/apparmor_parser'],
      files: { [USERNS_RESTRICTION]: '1' },
    });
    root0.s.install();
    expect((await ended(root0.s)).job?.state).toBe('success');
    expect(root0.calls).toHaveLength(1);
    expect(root0.calls[0]).toMatchObject({
      bin: '/bin/sh',
      script: ADMIN_SCRIPT,
      env: { HARNESS_RELAY_PM: 'apt', HARNESS_RELAY_APPARMOR: APPARMOR_PROFILE, HARNESS_RELAY_APPARMOR_FILE: APPARMOR_FILE },
    });
    expect(root0.calls[0]!.env).not.toHaveProperty('GH_TOKEN');
    expect(root0.calls[0]!.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(root0.calls[0]!.env.HARNESS_RELAY_PACKAGES).toContain('bubblewrap');

    const env = { PATH: '/usr/bin', DISPLAY: ':0', GH_TOKEN: 'test-token' };
    const dismissed = setup({ sudo: false, env, programs: ['/usr/bin/apt-get', '/usr/bin/pkexec'], onRun: () => result(126) });
    dismissed.s.install();
    const d = await ended(dismissed.s);
    expect(d.job?.state).toBe('failed');
    expect(dismissed.calls[0]).toMatchObject({ bin: '/usr/bin/pkexec', env: { DISPLAY: ':0' } });
    expect(dismissed.calls[0]!.env).not.toHaveProperty('GH_TOKEN');
    expect(dismissed.calls[0]!.args[0]).toBe('/usr/bin/env');
    expect(d.job?.log).toContain('Asking for the administrator password');
    expect(withLang('en', () => dismissed.s.view().job?.error)).toMatch(/^The administrator password was not given/);
    expect(withLang('zh-TW', () => dismissed.s.view().job?.error)).toMatch(/^沒有輸入系統管理員密碼/);
    // Another failure says what failed, with its exit code.
    const broken = setup({ onRun: () => result(100) });
    broken.s.install();
    expect(withLang('en', () => broken.s.view().job?.error)).toBeUndefined();
    await ended(broken.s);
    expect(withLang('en', () => broken.s.view().job?.error)).toMatch(/failed \(exit 100\)/);
  });

  it('fails when what it installed is still missing, naming it', async () => {
    const { s } = setup({ onRun: (_s, programs) => (programs.add('/usr/bin/bwrap'), result(0)) });
    s.install();
    const v = await ended(s);
    expect(v.job?.state).toBe('failed');
    expect(withLang('en', () => s.view().job?.error)).toBe(
      'The install ran, but this is still missing: socat, ripgrep, slirp4netns, iproute2, iptables, util-linux. Its output is below.',
    );
  });

  it('in the desktop app, puts Node.js’s build into its folder first, checked, then the packages', async () => {
    const { s, calls, nodeDir } = setup({
      electron: true,
      nodeBuild: () => ({
        ...fakeBuild(),
        url: 'https://nodejs.org/x/node-v26.0.0-linux-x64.tar.gz',
        file: 'node-v26.0.0-linux-x64.tar.gz',
      }),
    });
    s.install();
    const v = await ended(s);
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => basename(c.bin))).toEqual(['curl', 'tar', 'node', 'sudo']);
    expect(v.job?.log).toContain(`Harness Relay's own sandbox finds no Node.js on the PATH: Node.js 26.0.0 goes into ${nodeDir}`);
    expect(existsSync(join(nodeDir, 'bin', 'node'))).toBe(true);
    // The download does not stay.
    expect(existsSync(join(nodeDir, 'install-cache'))).toBe(false);
    expect(v.needs).toEqual([]);
  });

  it('without curl, runs the packages first (curl among them), then puts Node.js in with it', async () => {
    const { s, calls, nodeDir } = setup({
      electron: true,
      base: ['/bin/sh', '/usr/bin/env', '/usr/bin/tar', LIBATOMIC],
      nodeBuild: linuxBuild,
    });
    s.install();
    const v = await ended(s);
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => basename(c.bin))).toEqual(['sudo', 'curl', 'tar', 'node']);
    expect(calls[0]!.args).toContain('HARNESS_RELAY_PACKAGES=curl bubblewrap socat ripgrep slirp4netns iproute2 iptables util-linux');
    expect(calls[1]!.bin).toBe('/usr/bin/curl');
    expect(existsSync(join(nodeDir, 'bin', 'node'))).toBe(true);
    expect(v.needs).toEqual([]);
  });

  it('succeeds with what it can install, leaving what it cannot to be installed by hand', async () => {
    // Node.js goes in; the packages take administrator rights there is no way to get here.
    const { s } = setup({ electron: true, sudo: false, nodeBuild: linuxBuild });
    expect(s.view().needs.map((n) => [n.kind, n.blocked])).toEqual([
      ['node', undefined],
      ['packages', 'admin'],
    ]);
    s.install();
    const v = await ended(s);
    expect(v.job?.state).toBe('success');
    expect(v.needs.map((n) => [n.kind, n.blocked])).toEqual([['packages', 'admin']]);
  });

  it('leaves no Node.js behind when its download does not check, and installs nothing it cannot here', async () => {
    const bad = setup({ platform: 'darwin', electron: true, programs: [], nodeBuild: () => ({ ...fakeBuild(), sha256: 'ab'.repeat(32) }) });
    bad.s.install();
    const v = await ended(bad.s);
    expect(v.job?.state).toBe('failed');
    expect(existsSync(bad.nodeDir)).toBe(false);
    expect(withLang('en', () => bad.s.view().job?.error)).toMatch(/does not match the checksum/);
    // Only the packages are missing, and they cannot be installed here.
    const noAdmin = setup({ sudo: false });
    expect(() => noAdmin.s.install()).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => setup({ programs: ['/usr/bin/apt-get', '/usr/bin/sudo', ...ALL_LINUX] }).s.install()).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('runs one install at a time, stops it when asked while Node.js downloads or when the server stops, and counts it while it runs', async () => {
    const hold = (s: Run) =>
      new Promise<SpawnResult>((resolve) => {
        const stop = () => resolve(result(null, '', { aborted: true }));
        if (s.signal!.aborted) stop();
        else s.signal!.addEventListener('abort', stop);
      });
    const { s, calls } = setup({ electron: true, onRun: hold });
    expect(() => s.cancel()).toThrow(expect.objectContaining({ status: 409 }));
    s.install();
    expect(s.running()).toBe(1);
    expect(s.view().cancellable).toBe(true);
    expect(() => s.install()).toThrow(expect.objectContaining({ status: 409 }));
    await vi.waitFor(() => expect(s.view().job?.log).toContain('$ curl'));
    s.cancel();
    expect((await ended(s)).job?.state).toBe('cancelled');
    // Stopped there: the packages were not started.
    expect(calls.map((c) => basename(c.bin))).toEqual(['curl']);
    expect(s.running()).toBe(0);
    expect(s.view().cancellable).toBeUndefined();
    const other = setup({ onRun: hold });
    other.s.install();
    await other.s.shutdown();
    expect(other.s.view().job?.state).toBe('cancelled');
  });

  it('cannot be stopped once the package manager runs as administrator: stopping it halfway could break its database', async () => {
    let finish!: () => void;
    const { s } = setup({ onRun: () => new Promise<SpawnResult>((resolve) => (finish = () => resolve(result(0)))) });
    s.install();
    await vi.waitFor(() => expect(s.view().job?.log).toContain('$ sudo'));
    expect(s.view().cancellable).toBe(false);
    expect(() => withLang('en', () => s.cancel())).toThrow(/cannot be cancelled/);
    expect(s.view().job?.state).toBe('running');
    finish();
    expect((await ended(s)).job?.state).toBe('failed');
  });

  it('in the desktop app, has the relay sandbox run its host on the Node.js it put in, unless one is on the PATH', () => {
    if (process.platform === 'win32') return;
    const data = join(root, `tools-${++n}`);
    const o = { electron: true, dataDir: data, systemDirs: [] };
    expect(relaySandboxTools('darwin', '', o).node).toBeNull();
    const node = join(sandboxNodeFolder(data), 'bin', 'node');
    const program = (path: string, version: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
      chmodSync(path, 0o755);
    };
    program(node, 'v26.13.1');
    expect(relaySandboxTools('darwin', '', o).node).toBe(node);
    expect(hostNode({ tools: relaySandboxTools('linux', '', o) })).toBe(node);
    // A Node.js 22.12 or later on the PATH comes first; an older one does not count.
    const onPath = join(root, `path-${n}`, 'node');
    program(onPath, 'v22.12.0');
    expect(relaySandboxTools('darwin', dirname(onPath), o).node).toBe(onPath);
    const old = join(root, `old-${n}`, 'node');
    program(old, 'v20.1.0');
    expect(relaySandboxTools('darwin', dirname(old), o).node).toBe(node);
    // Not the desktop app: the server's own Node runs the host.
    expect(relaySandboxTools('darwin', '', { ...o, electron: false }).node).toBeUndefined();
  });
});

describe('the administrator’s script', () => {
  it('is fixed text that reads what it installs from its environment, as the shell parses it', () => {
    for (const k of ['HARNESS_RELAY_PM', 'HARNESS_RELAY_PACKAGES', 'HARNESS_RELAY_APPARMOR', 'HARNESS_RELAY_APPARMOR_FILE'])
      expect(ADMIN_SCRIPT).toContain(`$${k}`);
    // No package name in its text, and every name a package manager spells without shell syntax.
    for (const need of LINUX_NEEDS)
      for (const name of typeof need.pkg === 'string' ? [need.pkg] : Object.values(need.pkg)) {
        expect(ADMIN_SCRIPT).not.toContain(` ${name} `);
        expect(name).toMatch(/^[a-z0-9][a-z0-9.+-]*$/);
      }
  });

  it.skipIf(process.platform === 'win32')(
    'installs with apt, updating its lists only when a package cannot be found, then writes and loads the profile unless one is there',
    async () => {
      const dir = join(root, `script-${++n}`);
      const bin = join(dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const log = join(dir, 'log');
      // Stand-ins: apt-get fails once (stale lists) until `update`; apparmor_parser says what it loads.
      const tool = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      tool(
        'apt-get',
        `echo "apt-get $*" >> "$LOG"\nfor a in "$@"; do if [ "$a" = update ]; then : > "$UPDATED"; exit 0; fi; done\n[ -f "$UPDATED" ] || exit 100`,
      );
      tool('apparmor_parser', 'echo "apparmor_parser $*" >> "$LOG"');
      const profiles = join(dir, 'apparmor.d');
      mkdirSync(profiles);
      const file = join(profiles, 'harness-relay-bwrap');
      // The script looks in /etc/apparmor.d itself: a test can only see that it writes where it is told.
      const env = {
        PATH: `${bin}:/usr/bin:/bin`,
        LOG: log,
        UPDATED: join(dir, 'updated'),
        HARNESS_RELAY_PM: 'apt',
        HARNESS_RELAY_PACKAGES: 'bubblewrap socat',
        HARNESS_RELAY_APPARMOR: APPARMOR_PROFILE,
        HARNESS_RELAY_APPARMOR_FILE: file,
      };
      const r = await runShellScript('/bin/sh', [], ADMIN_SCRIPT, { env, timeoutMs: 20_000 });
      expect(r.code).toBe(0);
      expect(tool).toBeDefined();
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      // apt waits for its lock (unattended upgrades may hold it).
      expect(lines.slice(0, 3)).toEqual([
        'apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends bubblewrap socat',
        'apt-get -o DPkg::Lock::Timeout=120 update',
        'apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends bubblewrap socat',
      ]);
      // A computer whose own /etc/apparmor.d already lets /usr/bin/bwrap make user namespaces skips it.
      if (lines.length > 3) {
        expect(lines[3]).toBe(`apparmor_parser -r ${file}`);
        expect(readFileSync(file, 'utf8')).toBe(`${APPARMOR_PROFILE}\n`);
      }
      // Nothing to install: nothing runs.
      const none = await runShellScript('/bin/sh', [], ADMIN_SCRIPT, {
        env: { ...env, HARNESS_RELAY_PACKAGES: '', HARNESS_RELAY_APPARMOR: '' },
        timeoutMs: 20_000,
      });
      expect(none.code).toBe(0);
      // A command it runs that is not there (127): not taken for pkexec's own 127, a password not given.
      const missing = await runShellScript('/bin/sh', [], ADMIN_SCRIPT, {
        env: { ...env, PATH: bin, HARNESS_RELAY_PM: 'zypper', HARNESS_RELAY_APPARMOR: '' },
        timeoutMs: 20_000,
      });
      expect(missing.code).toBe(SCRIPT_CANNOT_RUN);
      // A package manager's own failure keeps its code, and stops the script there: no profile after it.
      tool('apt-get', `echo "apt-get $*" >> "$LOG"\nexit 100`);
      writeFileSync(log, '');
      const failed = await runShellScript('/bin/sh', [], ADMIN_SCRIPT, { env, timeoutMs: 20_000 });
      expect(failed.code).toBe(100);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends bubblewrap socat',
        'apt-get -o DPkg::Lock::Timeout=120 update',
      ]);
    },
    slow(30_000),
  );
});

describe('sandbox setup HTTP API', () => {
  const HOST = { host: '127.0.0.1:8787' };
  const json = (method: string) => ({ method, headers: { ...HOST, 'content-type': 'application/json' }, body: '{}' });

  it('says what is missing, installs it in the background and stops it', async () => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const providers = new ProviderService(settings);
    const orchestrator = new Orchestrator(store, hub, settings);
    const invalidate = vi.spyOn(providers, 'invalidate');
    const { host } = setup();
    const a = createApp({
      auth: null,
      store,
      settings,
      hub,
      orchestrator,
      providers,
      sandboxSetup: new SandboxSetup({ changed: () => providers.invalidate() }, host),
    });
    const view = await a.request('/api/sandbox-setup', { headers: HOST });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ needs: [{ kind: 'packages' }], admin: 'sudo' });
    expect((await a.request('/api/sandbox-setup/install', { method: 'POST', headers: HOST })).status).toBe(415);
    expect((await a.request('/api/sandbox-setup/install', json('DELETE'))).status).toBe(409);
    const started = await a.request('/api/sandbox-setup/install', json('POST'));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ job: { state: 'running' } });
    await vi.waitFor(async () =>
      expect(((await (await a.request('/api/sandbox-setup', { headers: HOST })).json()) as { job?: { state: string } }).job?.state).toBe(
        'success',
      ),
    );
    expect(invalidate).toHaveBeenCalledWith();
    expect((await a.request('/api/sandbox-setup/install', json('POST'))).status).toBe(400);
  });
});
