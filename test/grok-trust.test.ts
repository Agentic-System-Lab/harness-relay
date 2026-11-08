import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { grokHome, restoreGrokTrust, trustGrokFolder, withTrustedFolder } from '../src/server/grokTrust';
import { parseGrokInspect } from '../src/server/native';
import { asksGrokTrust } from '../src/web/components/GrokTrust';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-grok-trust-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Grok's folder trust", () => {
  it('adds a folder the way grok --trust records it', () => {
    expect(withTrustedFolder('', '/Users/me/app', 1700000000)).toBe('[folders."/Users/me/app"]\ntrusted = true\ndecided_at = 1700000000\n');
    const existing = '[folders."/Users/me/other"]\ntrusted = true\ndecided_at = 1\n';
    expect(withTrustedFolder(existing, '/Users/me/app', 2)).toBe(
      '[folders."/Users/me/other"]\ntrusted = true\ndecided_at = 1\n\n[folders."/Users/me/app"]\ntrusted = true\ndecided_at = 2\n',
    );
  });

  it('replaces a folder marked untrusted and keeps everything else', () => {
    const existing = [
      '[folders."/a"]',
      'trusted = true',
      'decided_at = 1',
      '',
      '[folders."/b"]',
      'trusted = false',
      'decided_at = 2',
      '',
      '[folders."/c"]',
      'trusted = true',
      'decided_at = 3',
      '',
    ].join('\n');
    const next = withTrustedFolder(existing, '/b', 9);
    expect(next).toBe(
      '[folders."/a"]\ntrusted = true\ndecided_at = 1\n\n[folders."/b"]\ntrusted = true\ndecided_at = 9\n\n[folders."/c"]\ntrusted = true\ndecided_at = 3\n',
    );
    expect(next.match(/\[folders\."\/b"\]/g)).toHaveLength(1);
  });

  it('writes Windows paths and quotes as TOML strings', () => {
    expect(withTrustedFolder('', 'C:\\Users\\me\\"app"', 1)).toContain('[folders."C:\\\\Users\\\\me\\\\\\"app\\""]');
  });

  it('writes the store in GROK_HOME, readable by the owner only', () => {
    const env = { GROK_HOME: join(root, 'grok-home') };
    expect(grokHome(env)).toBe(env.GROK_HOME);
    expect(trustGrokFolder('/Users/me/app', env, 1_700_000_000_000)).toBeNull();
    const first = '[folders."/Users/me/app"]\ntrusted = true\ndecided_at = 1700000000\n';
    expect(trustGrokFolder('/Users/me/app', env, 1_700_000_100_000)).toBe(first);
    const file = join(env.GROK_HOME, 'trusted_folders.toml');
    expect(readFileSync(file, 'utf8')).toBe('[folders."/Users/me/app"]\ntrusted = true\ndecided_at = 1700000100\n');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('puts the store back as it was, or removes it when there was none', () => {
    const env = { GROK_HOME: join(root, 'restore-home') };
    const file = join(env.GROK_HOME, 'trusted_folders.toml');
    const none = trustGrokFolder('/a', env, 1_000);
    restoreGrokTrust(none, env);
    expect(existsSync(file)).toBe(false);
    trustGrokFolder('/a', env, 1_000);
    const before = readFileSync(file, 'utf8');
    restoreGrokTrust(trustGrokFolder('/b', env, 2_000), env);
    expect(readFileSync(file, 'utf8')).toBe(before);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reads whether a folder is trusted from grok inspect", () => {
    expect(parseGrokInspect({ projectTrusted: false }).folderTrusted).toBe(false);
    expect(parseGrokInspect({ projectTrusted: true }).folderTrusted).toBe(true);
    expect(parseGrokInspect({}).folderTrusted).toBeUndefined();
  });

  it('reads the folder Grok decides trust for: the project root without its trailing slash, else the folder it ran in', () => {
    // A repository's subfolder: the repository root, above the folder.
    expect(parseGrokInspect({ cwd: '/r/packages/app', projectRoot: '/r/' })).toMatchObject({ trustFolder: '/r', trustFolderAbove: true });
    // The repository root itself.
    expect(parseGrokInspect({ cwd: '/r', projectRoot: '/r/' })).toMatchObject({ trustFolder: '/r' });
    expect(parseGrokInspect({ cwd: '/r', projectRoot: '/r/' }).trustFolderAbove).toBeUndefined();
    // Outside a repository: the folder itself (Grok reports it as a real path).
    expect(parseGrokInspect({ cwd: '/private/tmp/x', projectRoot: null })).toMatchObject({ trustFolder: '/private/tmp/x' });
    expect(parseGrokInspect({ cwd: '/', projectRoot: '/' }).trustFolder).toBe('/');
    expect(parseGrokInspect({ cwd: 'C:\\r\\app', projectRoot: 'C:\\' })).toMatchObject({ trustFolder: 'C:\\', trustFolderAbove: true });
    expect(parseGrokInspect({}).trustFolder).toBeUndefined();
  });
});

describe('asking about trust when a chat starts', () => {
  const grok = { id: 'g', name: 'G', provider: 'grok' as const, role: '' };
  const claude = { id: 'c', name: 'C', provider: 'claude' as const, role: '' };

  it('asks only for a team with a Grok member and a folder', () => {
    expect(asksGrokTrust({ agents: [claude, grok], settings: { cwd: '/p' } })).toBe(true);
    expect(asksGrokTrust({ agents: [claude], settings: { cwd: '/p' } })).toBe(false);
    expect(asksGrokTrust({ agents: [grok], settings: { cwd: '  ' } })).toBe(false);
    // An auto team has no members yet: the lead agent picks them later.
    expect(asksGrokTrust({ agents: [], settings: { cwd: '/p', autoTeam: true } })).toBe(false);
  });
});
