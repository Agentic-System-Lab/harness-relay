import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { browserInstallPlan } from '../src/server/browser/install';
import { InstallJob } from '../src/server/cliInstall';
import type { SpawnOptions, SpawnResult } from '../src/server/process';
import type { LinuxPackages, PackageManager } from '../src/server/sandboxSetup';

const result = (code = 0): SpawnResult => ({
  code,
  signal: null,
  stdout: '',
  stdoutBytes: Buffer.alloc(0),
  stdoutTruncated: false,
  stdoutSize: 0,
  stderr: '',
  aborted: false,
  timedOut: false,
});

function linuxHost(pm: PackageManager | undefined = 'apt', allowed = true) {
  return {
    packageManager: vi.fn<LinuxPackages['packageManager']>(() => pm),
    adminWay: vi.fn<LinuxPackages['adminWay']>(() => (allowed ? 'pkexec' : undefined)),
    install: vi.fn<LinuxPackages['install']>(async () => {}),
  };
}

const app = 'Google Chrome.app';

// No command touches the network or mounts an image. On Darwin the final exclusive rename uses
// the real system call on these scratch directories, including in the concurrent-destination test.
function macFixture(intercept?: (request: SpawnOptions, job: InstallJob) => SpawnResult | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'relay-browser-test-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const temp = join(root, 'temp');
  const home = join(root, "User's Home");
  const apps = join(home, 'Applications');
  const dest = join(apps, app);
  mkdirSync(temp);
  const job = new InstallJob();
  let mount!: string;
  const run = vi.fn(async (request: SpawnOptions) => {
    const { bin, args } = request;
    if (bin === '/usr/bin/hdiutil' && args[0] === 'attach') {
      mount = args[args.indexOf('-mountpoint') + 1]!;
      mkdirSync(join(mount, app));
      writeFileSync(join(mount, app, 'contents'), 'application data');
    }
    const override = intercept?.(request, job);
    if (override) return override;
    if (bin === '/usr/bin/curl') writeFileSync(args[args.indexOf('--output') + 1]!, 'disk image');
    else if (bin === '/usr/bin/ditto') cpSync(args[0]!, args[1]!, { recursive: true });
    else if (bin === '/usr/bin/hdiutil' && args[0] === 'detach') rmSync(join(mount, app), { recursive: true });
    return result();
  });
  const plan = browserInstallPlan(linuxHost(), {
    platform: 'darwin',
    env: {},
    home,
    temp,
    run,
    ...(process.platform === 'darwin'
      ? {}
      : {
          publish: (from: string, to: string) => {
            if (existsSync(to)) throw new Error('Destination exists');
            renameSync(from, to);
          },
        }),
  });
  return { install: () => plan.install!(job), job, run, apps, temp, mount: () => mount, dest };
}

describe('installing the browser on the Relay computer', () => {
  it('publishes only the signed Chrome bundle from the read-only Google image and cleans up', async () => {
    const { apps, dest, install, run, temp } = macFixture();
    expect(run).not.toHaveBeenCalled();
    await install();
    expect(readdirSync(apps)).toEqual([app]);
    expect(readFileSync(join(dest, 'contents'), 'utf8')).toBe('application data');
    expect(readdirSync(temp)).toEqual([]);
    const calls = run.mock.calls.map(([o]) => o);
    expect(calls.map((o) => [o.bin, o.args[0]])).toEqual([
      ['/usr/bin/curl', '-q'],
      ['/usr/bin/hdiutil', 'attach'],
      ['/usr/bin/ditto', expect.any(String)],
      ['/usr/bin/codesign', '--verify'],
      ['/usr/bin/hdiutil', 'detach'],
    ]);
    expect(calls[0]!.args).toContain('https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg');
    expect(calls[1]!.args).toContain('-readonly');
    const signature = calls[3]!.args;
    expect(signature).toEqual(['--verify', '--deep', '--strict', '--all-architectures', '-R', expect.any(String), calls[2]!.args[1]]);
    expect(signature[5]).toContain('anchor apple generic and identifier "com.google.Chrome"');
    expect(signature[5]).toContain('certificate leaf[subject.OU] = "EQHXZ8M8AV"');
  });

  it.each(['/usr/bin/curl', '/usr/bin/ditto', '/usr/bin/codesign'])('cleans up without publishing on failure of %s', async (bin) => {
    const fixture = macFixture((o) => (o.bin === bin ? result(1) : undefined));
    await expect(fixture.install()).rejects.toThrow();
    expect(readdirSync(fixture.apps)).toEqual([]);
    expect(readdirSync(fixture.temp)).toEqual([]);
  });

  it('detaches an image even when hdiutil was cancelled before reporting a successful mount', async () => {
    const fixture = macFixture((o, job) => {
      if (o.args[0] === 'attach') job.abort.abort();
      return o.args[0] === 'detach' && !o.args.includes('-force') ? result(1) : undefined;
    });
    await expect(fixture.install()).rejects.toThrow();
    const detaches = fixture.run.mock.calls.map(([o]) => o).filter((o) => o.args[0] === 'detach');
    expect(detaches.map((o) => o.args)).toEqual([
      ['detach', fixture.mount()],
      ['detach', '-force', fixture.mount()],
    ]);
    expect(detaches.every((o) => !o.signal)).toBe(true);
    expect(readdirSync(fixture.apps)).toEqual([]);
    expect(readdirSync(fixture.temp)).toEqual([]);
  });

  it('leaves a busy mount and backing image intact when even forced ejection fails', async () => {
    const fixture = macFixture((o) => (o.args[0] === 'detach' ? result(1) : undefined));
    await expect(fixture.install()).rejects.toThrow();
    const mount = fixture.mount();
    expect(readFileSync(join(mount, app, 'contents'), 'utf8')).toBe('application data');
    expect(readFileSync(join(mount, '..', 'googlechrome.dmg'), 'utf8')).toBe('disk image');
    expect(readdirSync(fixture.apps)).toEqual([]);
  });

  it('honors cancellation during cleanup before publishing the verified bundle', async () => {
    const fixture = macFixture((o, job) => {
      if (o.args[0] === 'detach') job.abort.abort();
      return undefined;
    });
    await expect(fixture.install()).rejects.toThrow();
    expect(readdirSync(fixture.apps)).toEqual([]);
    expect(readdirSync(fixture.temp)).toEqual([]);
  });

  it('leaves an existing application alone without starting the download', async () => {
    const fixture = macFixture();
    mkdirSync(fixture.dest, { recursive: true });
    writeFileSync(join(fixture.dest, 'user-data'), 'keep me');
    await expect(fixture.install()).rejects.toThrow();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.dest, 'user-data'), 'utf8')).toBe('keep me');
  });

  it('preserves even an empty destination created just before the atomic rename', async () => {
    const fixture = macFixture((o) => {
      if (o.args[0] === 'detach') mkdirSync(fixture.dest);
      return undefined;
    });
    await expect(fixture.install()).rejects.toThrow();
    expect(readdirSync(fixture.dest)).toEqual([]);
    expect(readdirSync(fixture.apps)).toEqual([app]);
    expect(readdirSync(fixture.temp)).toEqual([]);
  });

  it('asks WinGet for Google.Chrome from the fixed source; a missing WinGet offers no install', async () => {
    const run = vi.fn(async () => result());
    const host = { platform: 'win32' as const, env: { Path: 'C:\\bin' }, run };
    const plan = browserInstallPlan(linuxHost(), { ...host, hasProgram: (p) => p.toLowerCase() === 'c:\\bin\\winget.exe' });
    await plan.install!(new InstallJob());
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        bin: 'C:\\bin\\winget.EXE',
        args: expect.arrayContaining(['--exact', '--id', 'Google.Chrome', '--source', 'winget']),
      }),
    );
    expect(browserInstallPlan(linuxHost(), { ...host, hasProgram: () => false })).toEqual({});
  });

  it.each([
    ['apt', 'ID="ubuntu"', 'chromium-browser'],
    ['apt', 'ID=debian', 'chromium'],
    ['apt', 'ID=linuxmint\nID_LIKE="ubuntu debian"', 'chromium'],
    ['dnf', 'ID=fedora', 'chromium'],
    ['pacman', 'ID=arch', 'chromium'],
    ['zypper', 'ID=opensuse-leap', 'chromium'],
  ] as const)('uses the system package manager %s for %s, or gives its manual command', async (pm, os, pkg) => {
    const job = new InstallJob();
    const linux = linuxHost(pm);
    const host = { platform: 'linux' as const, osRelease: () => os };
    await browserInstallPlan(linux, host).install!(job);
    expect(linux.install).toHaveBeenCalledExactlyOnceWith(job, [pkg]);
    const manual = linuxHost(pm, false);
    const plan = browserInstallPlan(manual, host);
    expect(plan.install).toBeUndefined();
    expect(plan.command).toMatch(new RegExp('^sudo .* ' + pkg + '$'));
    expect(manual.install).not.toHaveBeenCalled();
  });

  it('offers no install for an unsupported OS or an unknown system package manager', () => {
    const linux = linuxHost();
    linux.packageManager.mockReturnValue(undefined);
    expect(browserInstallPlan(linux, { platform: 'linux' })).toEqual({});
    expect(browserInstallPlan(linux, { platform: 'freebsd' })).toEqual({});
    expect(linux.adminWay).not.toHaveBeenCalled();
  });
});
