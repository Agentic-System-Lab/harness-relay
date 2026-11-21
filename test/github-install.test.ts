import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallJob } from '../src/server/cliInstall';
import { canInstallGithubCli, findGithubCli, githubCliBuild, installGithubCli } from '../src/server/githubInstall';
import { t } from '../src/server/i18n';
import { portableInstallEnv } from '../src/server/portableInstall';

let temp: string | undefined;
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3 });
});

describe('the portable GitHub CLI', () => {
  it('uses fixed release artifacts with the correct archive layout on each supported platform', () => {
    const targets = [
      ['darwin', 'arm64', 'macOS_arm64.zip'],
      ['darwin', 'x64', 'macOS_amd64.zip'],
      ['linux', 'x64', 'linux_amd64.tar.gz'],
      ['linux', 'arm64', 'linux_arm64.tar.gz'],
      ['linux', 'arm', 'linux_armv6.tar.gz'],
      ['linux', 'ia32', 'linux_386.tar.gz'],
      ['win32', 'x64', 'windows_amd64.zip'],
      ['win32', 'arm64', 'windows_arm64.zip'],
      ['win32', 'ia32', 'windows_386.zip'],
    ] as const;
    for (const [platform, arch, asset] of targets) {
      expect(githubCliBuild(platform, arch)).toEqual({
        url: 'https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_' + asset,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        exe: platform === 'win32' ? 'bin/gh.exe' : 'bin/gh',
        stripDirectory: platform !== 'win32',
      });
    }
    const tool = (name: string) => '/system/' + name;
    expect(canInstallGithubCli('win32', 'arm64', tool)).toBe(true);
    expect(canInstallGithubCli('linux', 'ppc64', tool)).toBe(false);
    expect(canInstallGithubCli('darwin', 'x64', (name) => (name === 'tar' ? undefined : tool(name)))).toBe(false);
  });

  it('resolves an existing gh first and the private binary as soon as it has been published', async () => {
    const env = { PATH: '/user/bin:/usr/bin' };
    const files = new Set<string>();
    const resolve = () => findGithubCli(env, 'linux', (p) => files.has(p), '/relay/clis/github-cli');
    expect(resolve()).toBeUndefined();
    files.add('/relay/clis/github-cli/bin/gh');
    expect(resolve()).toBe('/relay/clis/github-cli/bin/gh');
    files.add('/user/bin/gh');
    expect(resolve()).toBe('/user/bin/gh');
    const run = vi.fn();
    await installGithubCli(new InstallJob(), { current: resolve, run });
    expect(run).not.toHaveBeenCalled();
    const system = 'C:\\Program Files\\GitHub CLI\\gh.EXE';
    expect(findGithubCli({ PATH: '', ProgramFiles: 'C:\\Program Files' }, 'win32', (p) => p === system, 'C:\\Relay Data')).toBe(system);
    expect(findGithubCli({ PATH: '' }, 'win32', (p) => p === 'C:\\Relay Data\\bin\\gh.exe', 'C:\\Relay Data')).toBe(
      'C:\\Relay Data\\bin\\gh.exe',
    );
  });

  it('excludes account credentials and project-local programs from the installer environment', () => {
    const system = join(tmpdir(), 'tools');
    const path = [system, join(tmpdir(), 'node_modules', '.bin'), '.'].join(delimiter);
    expect(portableInstallEnv({ GH_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', GH_CONFIG_DIR: 'private', LANG: 'C', Path: path })).toEqual({
      LANG: 'C',
      PATH: system,
      PATHEXT: '.EXE',
    });
  });

  it('verifies and starts the staged binary before publication; failed and cancelled attempts preserve the old folder', async () => {
    temp = await mkdtemp(join(tmpdir(), 'relay-gh-install-'));
    const folder = join(temp, 'github-cli');
    const payload = join(temp, 'payload');
    await mkdir(join(payload, 'version', 'bin'), { recursive: true });
    await writeFile(join(payload, 'version', 'bin', 'gh'), 'new gh');
    await mkdir(folder);
    await writeFile(join(folder, 'old'), 'previous gh');
    const tarball = execFileSync('tar', ['-czf', '-', '-C', payload, 'version']);
    const build = { ...githubCliBuild('linux', 'x64')!, sha256: createHash('sha256').update(tarball).digest('hex') };
    let bytes: Buffer = Buffer.from('incomplete');
    const run = vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'curl') {
        expect(args.at(-1)).toBe(build.url);
        expect(args.slice(args.indexOf('--proto-redir'), args.indexOf('--proto-redir') + 2)).toEqual(['--proto-redir', '=https']);
        await writeFile(args[args.indexOf('--output') + 1], bytes);
      } else {
        expect(bin).toBe('tar');
        execFileSync(bin, args);
      }
      return true;
    });
    const probe = vi.fn(async (exe: string) => {
      expect(await readFile(exe, 'utf8')).toBe('new gh');
      expect(await readFile(join(folder, 'old'), 'utf8')).toBe('previous gh');
      return true;
    });
    const prepare = (job = new InstallJob()) =>
      installGithubCli(job, { folder, build, current: () => undefined, tool: (n) => n, run, probe });
    await expect(prepare()).rejects.toThrow(t().githubArchiveDownload);
    expect(run.mock.calls.map(([bin]) => bin)).toEqual(['curl']);
    expect(probe).not.toHaveBeenCalled();
    bytes = tarball;
    probe.mockResolvedValueOnce(false);
    await expect(prepare()).rejects.toThrow(t().githubArchiveRun);
    const cancelled = new InstallJob();
    probe.mockImplementationOnce(async () => {
      cancelled.abort.abort();
      return true;
    });
    await expect(prepare(cancelled)).rejects.toThrow();
    expect(await readFile(join(folder, 'old'), 'utf8')).toBe('previous gh');
    expect((await readdir(temp)).sort()).toEqual(['github-cli', 'payload']);
    await prepare();
    expect(await readFile(join(folder, 'bin', 'gh'), 'utf8')).toBe('new gh');
  });
});
