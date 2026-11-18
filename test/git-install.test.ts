import { describe, expect, it, vi } from 'vitest';
import { GIT_MISSING } from '../src/shared/types';
import { GitInstall } from '../src/server/gitInstall';
import { addWindowsGitToPath, gitCommand } from '../src/server/gitProcess';
import type { runProcess, SpawnResult } from '../src/server/process';
import { LinuxPackages } from '../src/server/sandboxSetup';

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

function setup(platform: NodeJS.Platform, initial = false) {
  let available = initial;
  const hasGit = vi.fn(async () => available);
  const linux = {
    packageManager: vi.fn(() => 'apt' as const),
    adminWay: vi.fn<LinuxPackages['adminWay']>(() => 'sudo'),
    install: vi.fn(async () => {
      available = true;
    }),
  };
  const run = vi.fn<typeof runProcess>(async () => {
    if (platform === 'win32') available = true;
    return result();
  });
  const host = {
    platform,
    env: platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: 'C:\\Windows' } : { PATH: '/usr/bin:/bin' },
    hasProgram: (path: string) => path === '/usr/bin/xcode-select' || /\\Microsoft\\WindowsApps\\winget\.exe$/i.test(path),
    hasGit,
    run,
  };
  return {
    setup: new GitInstall(linux, host),
    linux,
    host,
    run,
    ready: () => {
      available = true;
    },
  };
}

describe('installing Git on request', () => {
  it('reports status without installing and skips installation when Git is already available', async () => {
    const { setup: git, run } = setup('win32', true);
    expect(await git.view('git')).toEqual({ available: true });
    expect(await git.install('git')).toEqual({ available: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('asks the Windows package manager for Git for Windows with a fixed source and package, once', async () => {
    const { setup: git, host, run } = setup('win32');
    expect(await git.view('gitBash')).toEqual({ available: false, method: 'winget' });
    expect(run).not.toHaveBeenCalled();
    const [a] = await Promise.all([git.install('gitBash'), git.install('gitBash')]);
    expect(a.method).toBe('winget');
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        bin: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.EXE',
        args: [
          'install',
          '--exact',
          '--id',
          'Git.Git',
          '--source',
          'winget',
          '--accept-source-agreements',
          '--accept-package-agreements',
          '--silent',
          '--disable-interactivity',
        ],
      }),
    );
    expect(host.hasGit).toHaveBeenLastCalledWith('gitBash');
    expect(await git.view('gitBash')).toMatchObject({ available: true, job: { state: 'success' } });
  });

  it('hands off to the macOS dialog and reports Git as ready only when available', async () => {
    const { setup: git, run, ready } = setup('darwin');
    await git.install('git');
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bin: '/usr/bin/xcode-select', args: ['--install'] }));
    expect(await git.view('git')).toMatchObject({ available: false, method: 'apple' });
    expect(git.running()).toBe(0);
    ready();
    expect(await git.view('git')).toMatchObject({ available: true });
  });

  it('uses the shared Linux package installer for only Git and verifies that installation made it available', async () => {
    const { setup: git, linux } = setup('linux');
    linux.install.mockImplementationOnce(async () => {});
    await git.install('git');
    expect(linux.install).toHaveBeenCalledExactlyOnceWith(expect.anything(), ['git']);
    expect(await git.view('git')).toMatchObject({ available: false, job: { state: 'failed', error: expect.any(String) } });
    await git.install('git');
    expect(await git.view('git')).toMatchObject({ available: true, job: { state: 'success' } });
  });

  it('gives a terminal command on Linux when no administrator prompt is available', async () => {
    const { setup: git, linux } = setup('linux');
    linux.adminWay.mockReturnValue(undefined);
    expect(await git.view('git')).toEqual({ available: false, command: 'sudo apt-get install -y git' });
    await expect(git.install('git')).rejects.toMatchObject({ status: 400 });
    expect(linux.install).not.toHaveBeenCalled();
  });

  it('gives a manual path when WinGet is missing, and shows a failed installer as retryable', async () => {
    const { host, linux } = setup('win32');
    const git = new GitInstall(linux, { ...host, hasProgram: () => false });
    expect(await git.view('git')).toEqual({ available: false });
    await expect(git.install('git')).rejects.toMatchObject({ status: 400 });

    const { setup: retryable, run } = setup('win32');
    run.mockResolvedValueOnce(result(1));
    await retryable.install('git');
    expect(await retryable.view('git')).toMatchObject({ available: false, method: 'winget', job: { state: 'failed' } });
  });
});

describe('finding Git without a restart or an unsolicited native installer', () => {
  it('does not run the Apple stub until developer tools are available', async () => {
    const paths = new Set(['/usr/bin/git']);
    const selected = vi.fn(async () => '');
    const locate = () => gitCommand({ PATH: '/usr/bin' }, 'darwin', (path) => paths.has(path), selected);
    await expect(locate()).rejects.toMatchObject({ code: GIT_MISSING });
    selected.mockResolvedValue('/Library/Developer/CommandLineTools');
    await expect(locate()).rejects.toMatchObject({ code: GIT_MISSING });
    paths.add('/Library/Developer/CommandLineTools/usr/bin/git');
    await expect(locate()).resolves.toBe('/Library/Developer/CommandLineTools/usr/bin/git');
  });

  it('finds a non-Apple Git after the stub', async () => {
    const paths = new Set(['/usr/bin/git', '/opt/homebrew/bin/git']);
    const locate = gitCommand(
      { PATH: '/usr/bin:/opt/homebrew/bin' },
      'darwin',
      (path) => paths.has(path),
      async () => '',
    );
    await expect(locate).resolves.toBe('/opt/homebrew/bin/git');
  });

  it('finds a new Windows installation even before Windows updates the server process PATH', async () => {
    const env = { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
    const path = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const exists = (p: string) => p.toLowerCase() === path.toLowerCase();
    await expect(gitCommand(env, 'win32', exists)).resolves.toBe(path);
    addWindowsGitToPath(env, exists);
    addWindowsGitToPath(env, exists);
    expect(env.Path).toBe('C:\\Windows;C:\\Program Files\\Git\\cmd');
  });
});
