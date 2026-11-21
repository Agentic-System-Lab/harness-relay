import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { InstallJob } from '../src/server/cliInstall';
import { probePreviewDocker } from '../src/server/previewDocker';
import { previewDockerInstallPlan } from '../src/server/previewDockerInstall';
import type { runShellScript, SpawnOptions, SpawnResult } from '../src/server/process';
import type { LinuxPackages, PackageManager } from '../src/server/sandboxSetup';

const result = (stdout = '', code = 0, stderr = ''): SpawnResult => ({
  code,
  signal: null,
  stdout,
  stdoutBytes: Buffer.from(stdout),
  stdoutTruncated: false,
  stdoutSize: Buffer.byteLength(stdout),
  stderr,
  aborted: false,
  timedOut: false,
});

function linux(pm: PackageManager | undefined = 'apt', allowed = true) {
  return {
    packageManager: () => pm,
    adminWay: () => (allowed ? ('pkexec' as const) : undefined),
    install: vi.fn<LinuxPackages['install']>(async () => {}),
  };
}

it('checks only the selected local Docker context and distinguishes setup failures from missing software', async () => {
  const bin = '/Applications/Docker.app/Contents/Resources/bin/docker';
  const host = {
    platform: 'darwin' as const,
    home: '/Users/test',
    env: { PATH: './bin:/repo/node_modules/.bin', DOCKER_CONTEXT: 'my-local', DOCKER_HOST: 'tcp://elsewhere' },
    hasProgram: vi.fn((_p: string) => false),
    run: vi.fn(async (_o: SpawnOptions) => result()),
  };
  expect(await probePreviewDocker(host)).toMatchObject({ state: 'missing', detail: expect.stringContaining('Docker') });
  expect(host.run).not.toHaveBeenCalled();
  host.hasProgram.mockImplementation((p) => p === bin);
  let context = 'tcp://example.com:2376';
  let info = result('linux arm64');
  host.run.mockImplementation(async (o) => (o.args.includes('context') ? result(context) : info));
  expect(await probePreviewDocker(host)).toMatchObject({ state: 'unavailable', detail: expect.stringMatching(/local Docker|本機通訊端/) });
  expect(host.run).toHaveBeenCalledTimes(1);
  context = 'unix:///Users/test/.docker/run/docker.sock';
  info = result('', 1, 'Cannot connect to the Docker daemon.');
  expect(await probePreviewDocker(host)).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('Cannot connect') });
  info = result('', 1, 'permission denied');
  expect(await probePreviewDocker(host)).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('permission denied') });
  for (const engine of ['windows amd64', 'linux s390x', '']) {
    info = result(engine);
    expect(await probePreviewDocker(host)).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('arm64') });
  }
  info = result('linux x86_64');
  expect(await probePreviewDocker(host)).toEqual({ state: 'ready' });
  const commands = host.run.mock.calls.map(([o]) => o);
  const probe = commands.at(-1)!;
  expect(probe).toMatchObject({ bin, args: ['--host', context, 'info', '--format', expect.any(String)] });
  expect(probe.env).not.toHaveProperty('DOCKER_HOST');
  expect(probe.env).not.toHaveProperty('DOCKER_CONTEXT');
  expect(commands.at(-2)!.env.DOCKER_CONTEXT).toBe('my-local');
  expect(host.hasProgram.mock.calls.flat()).not.toContain('/repo/node_modules/.bin/docker');
});

it('directs a Linux user to socket access help only when the local engine denies permission', async () => {
  const host = {
    platform: 'linux' as const,
    home: '/home/relay',
    env: { DOCKER_HOST: 'unix:///var/run/docker.sock' },
    hasProgram: () => true,
    run: vi.fn(async () => result('', 1, 'permission denied while connecting')),
  };
  expect(await probePreviewDocker(host)).toMatchObject({
    state: 'unavailable',
    help: 'linux-access',
    detail: expect.stringContaining('rootless'),
  });
  host.run.mockResolvedValue(result('', 1, 'connection refused'));
  expect(await probePreviewDocker(host)).not.toHaveProperty('help');
});

it('recognizes the per-user Windows install without a PATH reload and pins the local pipe', async () => {
  const bin = 'C:\\Users\\relay\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
  const host = {
    platform: 'win32' as const,
    home: 'C:\\Users\\relay',
    env: { Docker_Host: 'npipe:////./pipe/docker_engine' },
    hasProgram: (p: string) => p === bin,
    run: vi.fn(async (_o: SpawnOptions) => result('linux amd64')),
  };
  expect(await probePreviewDocker(host)).toEqual({ state: 'ready' });
  expect(host.run).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ bin, args: ['--host', host.env.Docker_Host, 'info', '--format', expect.any(String)] }),
  );
  expect(host.run.mock.calls[0]![0].env).not.toHaveProperty('DOCKER_HOST');
});

function macInstaller(arch: string, writable = true, intercept?: (o: SpawnOptions, dest: string) => SpawnResult | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'relay-mac-docker-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const apps = join(root, 'Applications');
  const temp = join(root, 'temp');
  mkdirSync(apps);
  mkdirSync(temp);
  const dest = join(apps, 'Docker.app');
  const run = vi.fn(async (o: SpawnOptions) => {
    const override = intercept?.(o, dest);
    if (override) return override;
    if (o.bin === '/usr/bin/osascript') {
      cpSync(o.env.RELAY_MAC_SOURCE!, dest, { recursive: true, force: false, errorOnExist: true });
      return result(dest + '/');
    }
    if (o.args[0] === 'attach') mkdirSync(join(o.args[o.args.indexOf('-mountpoint') + 1]!, 'Docker.app'));
    if (o.bin === '/usr/bin/ditto') cpSync(o.args.at(-2)!, o.args.at(-1)!, { recursive: true });
    if (o.args[0] === 'detach') rmSync(join(o.args.at(-1)!, 'Docker.app'), { recursive: true });
    return result();
  });
  const host = { platform: 'darwin' as const, arch, apps, temp, run, canWrite: () => writable, publish: renameSync };
  return { host, run, apps, temp, dest };
}

it.each(['x64', 'arm64'])('installs only Docker’s signed %s Mac app and opens first-run setup', async (arch) => {
  const { host, run, apps, temp } = macInstaller(arch);
  const plan = previewDockerInstallPlan(linux(), host);
  expect(run).not.toHaveBeenCalled();
  await plan.install!(new InstallJob());
  const steps = run.mock.calls.map(([o]) => o);
  expect(steps.map((o) => o.bin)).toEqual([
    '/usr/bin/curl',
    '/usr/bin/hdiutil',
    '/usr/bin/ditto',
    '/usr/bin/codesign',
    '/usr/bin/hdiutil',
    '/usr/bin/open',
  ]);
  expect(steps[0]!.args).toContain('https://desktop.docker.com/mac/main/' + (arch === 'x64' ? 'amd64' : 'arm64') + '/Docker.dmg');
  expect(steps[3]!.args).toContainEqual(expect.stringContaining('certificate leaf[subject.OU] = "9BNSXJN65R"'));
  expect(steps[3]!.args).toContainEqual(expect.stringContaining('identifier "com.docker.docker"'));
  expect(steps.at(-1)!.args).toEqual([join(apps, 'Docker.app')]);
  expect(readdirSync(temp)).toEqual([]);
  expect(readdirSync(apps)).toEqual(['Docker.app']);
  expect(previewDockerInstallPlan(linux(), host).install).toBeUndefined();
});

it('checks both the read-only image and the authorized Finder copy on a standard Mac account', async () => {
  const { host, run, temp, dest } = macInstaller('arm64', false);
  const plan = previewDockerInstallPlan(linux(), host);
  expect(run).not.toHaveBeenCalled();
  await plan.install!(new InstallJob());
  const steps = run.mock.calls.map(([o]) => o);
  expect(steps.map(({ bin }) => bin)).toEqual([
    '/usr/bin/curl',
    '/usr/bin/hdiutil',
    '/usr/bin/codesign',
    '/usr/bin/osascript',
    '/usr/bin/codesign',
    '/usr/bin/hdiutil',
    '/usr/bin/open',
  ]);
  const finder = steps[3]!;
  expect(finder.args.join(' ')).toContain('duplicate sourceBundle to appsFolder without replacing');
  expect(finder.args.join(' ')).not.toContain('do shell script');
  expect(finder.env.RELAY_MAC_SOURCE).toBe(steps[2]!.args.at(-1));
  expect(steps[4]!.args).toEqual([...steps[2]!.args.slice(0, -1), dest]);
  expect(readdirSync(temp)).toEqual([]);
});

it.each([
  'bad source',
  'racing destination',
  'Finder declined',
  'access denied',
  'wrong copy',
  'linked destination',
  'bad signature',
] as const)('keeps Docker closed when Finder installation cannot finish (%s)', async (condition) => {
  const { host, run, temp } = macInstaller('arm64', false, (o, dest) => {
    if (o.bin === '/usr/bin/codesign') {
      if (condition === 'bad source' || (condition === 'bad signature' && o.args.at(-1) === dest)) return result('', 1);
      if (condition === 'racing destination') mkdirSync(dest);
    }
    if (o.bin === '/usr/bin/osascript') {
      if (condition === 'Finder declined') return result('cancelled');
      if (condition === 'access denied') return result('denied');
      if (condition === 'wrong copy') return result(dest + '-other');
      if (condition === 'linked destination') {
        symlinkSync(o.env.RELAY_MAC_SOURCE!, dest, 'junction');
        return result(dest + '/');
      }
    }
  });
  const job = new InstallJob();
  await expect(previewDockerInstallPlan(linux(), host).install!(job)).rejects.toThrow();
  expect(job.abort.signal.aborted).toBe(condition === 'Finder declined');
  expect(run.mock.calls.some(([o]) => o.bin === '/usr/bin/open')).toBe(false);
  expect(run.mock.calls.some(([o]) => o.bin === '/usr/bin/osascript')).toBe(!['bad source', 'racing destination'].includes(condition));
  expect(readdirSync(temp)).toEqual([]);
});

it('asks the registered Windows package installer for Docker Desktop', async () => {
  const local = 'C:\\Users\\relay\\AppData\\Local';
  const winget = local + '\\Microsoft\\WindowsApps\\winget.exe';
  const run = vi.fn(async (_o: SpawnOptions) => result());
  const desktop = local + '\\Programs\\DockerDesktop\\Docker Desktop.exe';
  const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const runScript = vi.fn<typeof runShellScript>(async () => result());
  const host = {
    runScript,
    platform: 'win32' as const,
    arch: 'x64',
    env: { LOCALAPPDATA: local },
    hasProgram: (p: string) => [winget, desktop, shell].includes(p),
    hasAlias: () => false,
    run,
  };
  const plan = previewDockerInstallPlan(linux(), host);
  expect(run).not.toHaveBeenCalled();
  await plan.install!(new InstallJob());
  expect(run).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ bin: winget, args: expect.arrayContaining(['--id', 'Docker.DockerDesktop', '--source', 'winget']) }),
  );
  expect(run.mock.calls[0]![0].args).toEqual(expect.arrayContaining(['--override', 'install --quiet --backend=wsl-2']));
  expect(run.mock.calls[0]![0].args.join(' ')).not.toMatch(/--accept-license|--accept-package-agreements/);
  expect(runScript).toHaveBeenCalledExactlyOnceWith(
    shell,
    ['-NoProfile', '-NonInteractive'],
    expect.any(String),
    expect.objectContaining({ env: expect.objectContaining({ RELAY_DOCKER_DESKTOP: desktop }) }),
  );
  const script = runScript.mock.calls[0]![2];
  expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $exe');
  expect(script.indexOf("if ($signature.Status -ne 'Valid')")).toBeLessThan(script.indexOf('Start-Process -FilePath $exe'));
  expect(script).toContain('Unexpected Docker Desktop publisher');
  expect(script).not.toContain('-Verb RunAs');
  expect(previewDockerInstallPlan(linux(), { ...host, hasProgram: () => false })).toEqual({ detail: expect.stringContaining('WinGet') });
});

it.each([
  ['apt', 'ID=ubuntu', ['docker.io']],
  ['apt', 'ID=debian\nVERSION_ID="13"', ['docker.io', 'docker-cli']],
  ['apt', 'ID=debian\nVERSION_ID="12"', ['docker.io']],
  ['dnf', 'ID=fedora', ['moby-engine', 'docker-cli']],
  ['pacman', 'ID=arch', ['docker']],
  ['zypper', 'ID=opensuse-tumbleweed', ['docker']],
] as const)('installs the distro’s engine and CLI through %s (%s)', async (pm, os, packages) => {
  const host = { platform: 'linux' as const, arch: 'arm64', osRelease: () => os };
  const manager = linux(pm);
  const job = new InstallJob();
  const plan = previewDockerInstallPlan(manager, host);
  expect(manager.install).not.toHaveBeenCalled();
  await plan.install!(job);
  expect(manager.install).toHaveBeenCalledExactlyOnceWith(job, packages);
  expect(previewDockerInstallPlan(linux(pm, false), host)).toEqual({ command: expect.stringContaining(packages.join(' ')) });
});

it('offers manual setup for an unsupported system or Linux distribution', () => {
  expect(previewDockerInstallPlan(linux(), { platform: 'freebsd', arch: 'x64' })).toEqual({ detail: expect.any(String) });
  expect(previewDockerInstallPlan(linux(), { platform: 'linux', arch: 'ia32' })).toEqual({ detail: expect.stringContaining('arm64') });
  expect(previewDockerInstallPlan(linux(), { platform: 'linux', arch: 'x64', osRelease: () => 'ID=other' })).toEqual({
    detail: expect.any(String),
  });
});
