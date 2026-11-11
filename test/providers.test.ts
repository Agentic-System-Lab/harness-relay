import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'relay-providers-'));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { openDatabase } = await import('../src/server/db');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');

describe("a CLI's status when it cannot run", () => {
  const providers = () => {
    const settings = new SettingsStore(openDatabase(':memory:'));
    return { settings, service: new ProviderService(settings) };
  };

  it('is "not installed" with no message of its own when the command is not found: Settings words it, with where to install it', async () => {
    const { settings, service } = providers();
    settings.update('grok', { bin: join(root, 'no-such-grok') });
    const status = await service.status('grok', true);
    expect(status).toMatchObject({ provider: 'grok', installed: false, bin: join(root, 'no-such-grok') });
    expect(status.auth.detail).toBeUndefined();
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('keeps the reason when the file is there but cannot run', async () => {
    const { settings, service } = providers();
    const bin = join(root, 'claude-not-runnable');
    writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n');
    chmodSync(bin, 0o644);
    settings.update('claude', { bin });
    const status = await service.status('claude', true);
    expect(status.installed).toBe(false);
    expect(status.auth.detail).toMatch(/EACCES|permission/i);
  });
});

describe('accounts of a CLI', () => {
  // A stand-in for `claude` that keeps its sign-in in its home, as the real one does.
  const FAKE_CLAUDE = `#!/bin/sh
home="$CLAUDE_CONFIG_DIR"
case "$1 $2" in
  "--version ") echo "2.1.0 (Claude Code)" ;;
  "auth status")
    if [ -f "$home/signed-in" ]; then printf '{"loggedIn": true, "email": "%s", "authMethod": "claude.ai"}\\n' "$(cat "$home/signed-in")"
    else echo '{"loggedIn": false}'; fi ;;
  "auth login") echo "work@example.com" > "$home/signed-in"; echo "Logged in" ;;
  "auth logout") rm -f "$home/signed-in"; echo "Logged out" ;;
esac
`;
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('checks, signs in and signs out each account in its own home', async () => {
    const dir = join(root, 'accounts');
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'claude');
    writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.update('claude', { bin });
    settings.setAgentHome(join(dir, 'homes'));
    const work = settings.addAccount('claude', 'Work');
    const service = new ProviderService(settings);
    writeFileSync(join(settings.env('claude').CLAUDE_CONFIG_DIR!, 'signed-in'), 'me@example.com');

    const status = await service.status('claude', true);
    expect(status).toMatchObject({ installed: true, version: '2.1.0', auth: { loggedIn: true, account: 'me@example.com' } });
    expect(status.accounts).toEqual([
      { id: '', label: '', auth: { loggedIn: true, method: 'claude.ai', account: 'me@example.com' }, usingStoredApiKey: false },
      { id: work, label: 'Work', auth: { loggedIn: false }, usingStoredApiKey: false },
    ]);

    // Signing the other account in leaves the default one as it was.
    const login = service.startLogin('claude', 'claudeai', work);
    expect(login).toMatchObject({ provider: 'claude', account: work, state: 'running' });
    expect(service.login('claude')).toBeNull();
    await vi.waitFor(() => expect(service.login('claude', work)?.state).toBe('success'));
    const after = await service.status('claude');
    expect(after.accounts.map((a) => [a.id, a.auth.loggedIn, a.auth.account])).toEqual([
      ['', true, 'me@example.com'],
      [work, true, 'work@example.com'],
    ]);

    await service.logout('claude', work);
    expect((await service.status('claude')).accounts.map((a) => a.auth.loggedIn)).toEqual([true, false]);
    service.forgetLogin('claude', work);
    expect(service.login('claude', work)).toBeNull();
  });

  it('lists every account as unknown when the CLI is not installed', async () => {
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.update('grok', { bin: join(root, 'no-such-grok-either') });
    const team = settings.addAccount('grok', 'Team');
    settings.updateAccount('grok', team, { apiKey: 'xai-team-key' });
    const status = await new ProviderService(settings).status('grok', true);
    expect(status.installed).toBe(false);
    expect(status.accounts).toEqual([
      { id: '', label: '', auth: { loggedIn: null }, usingStoredApiKey: false },
      { id: team, label: 'Team', auth: { loggedIn: null }, usingStoredApiKey: true },
    ]);
  });
});
