import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { grokHome, trustGrokFolder, withTrustedFolder } from '../src/server/grokTrust';
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
    trustGrokFolder('/Users/me/app', env, 1_700_000_000_000);
    trustGrokFolder('/Users/me/app', env, 1_700_000_100_000);
    const file = join(env.GROK_HOME, 'trusted_folders.toml');
    expect(readFileSync(file, 'utf8')).toBe('[folders."/Users/me/app"]\ntrusted = true\ndecided_at = 1700000100\n');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reads whether a folder is trusted from grok inspect", () => {
    expect(parseGrokInspect({ projectTrusted: false }).folderTrusted).toBe(false);
    expect(parseGrokInspect({ projectTrusted: true }).folderTrusted).toBe(true);
    expect(parseGrokInspect({}).folderTrusted).toBeUndefined();
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
