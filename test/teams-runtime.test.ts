import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTeamsRuntime, powerShellBuild, publishTeamsDirectory } from '../src/server/connectors/teamsRuntime';
import { t } from '../src/server/i18n';

let temp: string | undefined;
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe('the portable PowerShell prerequisite for Teams', () => {
  it('selects a pinned Microsoft release for each supported platform and C library', () => {
    const platforms = [
      ['darwin', 'arm64', false, 'osx-arm64.tar.gz'],
      ['darwin', 'x64', false, 'osx-x64.tar.gz'],
      ['win32', 'x64', false, 'win-x64.zip'],
      ['win32', 'arm64', false, 'win-arm64.zip'],
      ['win32', 'ia32', false, 'win-x86.zip'],
      ['linux', 'x64', false, 'linux-x64.tar.gz'],
      ['linux', 'arm64', false, 'linux-arm64.tar.gz'],
      ['linux', 'arm', false, 'linux-arm32.tar.gz'],
      ['linux', 'x64', true, 'linux-musl-x64.tar.gz'],
    ] as const;
    const sums = new Set<string>();
    for (const [os, arch, musl, archive] of platforms) {
      const b = powerShellBuild(os, arch, musl)!;
      expect(new URL(b.url).origin).toBe('https://github.com');
      expect(new URL(b.url).pathname).toBe(
        '/PowerShell/PowerShell/releases/download/v7.6.10/' + (os === 'win32' ? 'PowerShell-' : 'powershell-') + '7.6.10-' + archive,
      );
      expect(b.exe).toBe(os === 'win32' ? 'pwsh.exe' : 'pwsh');
      expect(b.sha256).toMatch(/^[a-f0-9]{64}$/);
      sums.add(b.sha256);
    }
    expect(sums.size).toBe(platforms.length);
    expect(powerShellBuild('linux', 'arm64', true)).toBeUndefined();
    expect(powerShellBuild('linux', 's390x', false)).toBeUndefined();
    expect(powerShellBuild('freebsd', 'x64', false)).toBeUndefined();
  });

  it('verifies before unpacking, probes the staged runtime before publishing it and cleans up failed attempts', async () => {
    temp = await mkdtemp(join(tmpdir(), 'relay-teams-package-'));
    const clis = join(temp, 'clis');
    const folder = join(clis, 'teams-powershell');
    await mkdir(folder, { recursive: true });
    const current = join(folder, 'pwsh');
    await writeFile(current, 'previous');
    const source = join(temp, 'from-microsoft');
    await mkdir(source);
    await writeFile(join(source, 'pwsh'), 'fixture runtime');
    const archive = join(temp, 'stand-in.tar');
    execFileSync('tar', ['-cf', archive, '-C', source, 'pwsh']);
    const bytes = await readFile(archive);
    const build = {
      url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.10/test',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      exe: 'pwsh',
    };
    let contents: Buffer = Buffer.from('incomplete download');
    const run = vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'curl') {
        expect(args[0]).toBe('-q');
        expect(args.slice(args.indexOf('--proto-redir'), args.indexOf('--proto-redir') + 2)).toEqual(['--proto-redir', '=https']);
        expect(args.at(-1)).toBe(build.url);
        await writeFile(args[args.indexOf('--output') + 1], contents);
      } else {
        expect(bin).toBe('tar');
        execFileSync('tar', args);
      }
      return true;
    });
    const probe = vi.fn(async (exe: string) => {
      expect(await readFile(exe, 'utf8')).toBe('fixture runtime');
      expect(await readFile(current, 'utf8')).toBe('previous');
      return 21;
    });
    const stop = new AbortController();
    const prepare = () => installTeamsRuntime(stop.signal, probe, {}, { folder, build, tool: (n) => n, run });
    await expect(prepare()).rejects.toThrow(t().teamsRuntimeDownload);
    expect(run.mock.calls.map((c) => c[0])).toEqual(['curl']);
    expect(probe).not.toHaveBeenCalled();
    expect(await readdir(clis)).toEqual(['teams-powershell']);
    contents = bytes;
    probe.mockResolvedValueOnce(20);
    await expect(prepare()).rejects.toThrow(t().teamsRuntimeRun);
    expect(await readFile(current, 'utf8')).toBe('previous');
    expect(await readdir(clis)).toEqual(['teams-powershell']);
    await prepare();
    expect(await readFile(current, 'utf8')).toBe('fixture runtime');
    expect(await readdir(clis)).toEqual(['teams-powershell']);
  });

  it.each(['backup', 'publish'] as const)(
    'restores the old runtime when cancelled during the %s rename, then allows retry',
    async (when) => {
      temp = await mkdtemp(join(tmpdir(), 'relay-teams-commit-'));
      const target = join(temp, 'current');
      const staged = join(temp, 'install', 'new');
      await mkdir(target);
      await mkdir(staged, { recursive: true });
      await writeFile(join(target, 'version'), 'original');
      await writeFile(join(staged, 'version'), 'replacement');
      const stop = new AbortController();
      const move: typeof rename = async (from, to) => {
        await rename(from, to);
        if (from === (when === 'backup' ? target : staged)) stop.abort();
      };
      await expect(publishTeamsDirectory(staged, target, stop.signal, move)).rejects.toThrow();
      expect(await readFile(join(target, 'version'), 'utf8')).toBe('original');
      expect(await readFile(join(staged, 'version'), 'utf8')).toBe('replacement');
      expect((await readdir(temp)).sort()).toEqual(['current', 'install']);
      await publishTeamsDirectory(staged, target, new AbortController().signal);
      expect(await readFile(join(target, 'version'), 'utf8')).toBe('replacement');
      expect((await readdir(temp)).sort()).toEqual(['current', 'install']);
    },
  );

  it('recovers the previous runtime if publishing fails and retries using the verified staging folder', async () => {
    temp = await mkdtemp(join(tmpdir(), 'relay-teams-retry-'));
    const target = join(temp, 'current');
    const staged = join(temp, 'install', 'new');
    await mkdir(target);
    await mkdir(staged, { recursive: true });
    await writeFile(join(target, 'version'), 'original');
    await writeFile(join(staged, 'version'), 'replacement');
    const signal = new AbortController().signal;
    const failPublish: typeof rename = (from, to) => (from === staged ? Promise.reject(new Error('destination busy')) : rename(from, to));
    await expect(publishTeamsDirectory(staged, target, signal, failPublish)).rejects.toThrow('destination busy');
    expect(await readFile(join(target, 'version'), 'utf8')).toBe('original');
    await publishTeamsDirectory(staged, target, signal);
    expect(await readFile(join(target, 'version'), 'utf8')).toBe('replacement');
    expect((await readdir(temp)).sort()).toEqual(['current', 'install']);
  });

  it('reports missing system extraction tools before creating staging files', async () => {
    const run = vi.fn();
    await expect(
      installTeamsRuntime(
        new AbortController().signal,
        vi.fn(),
        {},
        { build: powerShellBuild('linux', 'x64', false), tool: (n) => (n === 'tar' ? undefined : n), run },
      ),
    ).rejects.toThrow(t().teamsRuntimeTools);
    expect(run).not.toHaveBeenCalled();
  });
});
