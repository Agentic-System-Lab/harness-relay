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
const { catalogFor } = await import('../src/shared/types');

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

  it("asks each account's home for the CLI's own defaults, and layers that account's defaults over them", async () => {
    vi.stubEnv('ANTHROPIC_MODEL', '');
    vi.stubEnv('CLAUDE_CODE_EFFORT_LEVEL', '');
    try {
      const settings = new SettingsStore(openDatabase(':memory:'));
      settings.setAgentHome(join(root, 'model-homes'));
      // Not installed: their models are the built-in lists, and no CLI runs.
      settings.update('codex', { bin: join(root, 'no-such-codex') });
      settings.update('grok', { bin: join(root, 'no-such-grok-models') });
      const work = settings.addAccount('claude', 'Work');
      const team = settings.addAccount('grok', 'Team');
      writeFileSync(join(settings.env('claude').CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'high' }));
      writeFileSync(join(settings.env('claude', work).CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
      settings.updateAccount('claude', work, { defaultEffort: 'low' });
      const service = new ProviderService(settings);

      const own = await service.models('claude');
      expect(own).toMatchObject({ cliDefaultModel: 'opus', cliDefaultEffort: 'high', defaultModel: 'opus', defaultEffort: 'high' });
      expect(own.account).toBeUndefined();
      expect(await service.models('claude', false, work)).toMatchObject({
        account: work,
        cliDefaultModel: 'sonnet',
        defaultModel: 'sonnet',
        defaultEffort: 'low',
      });
      // A change to an account's defaults shows at once, without asking the CLI again.
      settings.updateAccount('claude', work, { defaultModel: 'haiku' });
      expect((await service.models('claude', false, work)).defaultModel).toBe('haiku');
      expect((await service.models('claude')).defaultModel).toBe('opus');
      // An account the CLI does not have is the default account.
      const gone = await service.models('claude', false, 'gone');
      expect([gone.account, gone.cliDefaultModel]).toEqual([undefined, 'opus']);

      const all = await service.modelsAll();
      expect(all.map((m) => [m.provider, m.account ?? ''])).toEqual([
        ['claude', ''],
        ['claude', work],
        ['codex', ''],
        ['grok', ''],
        ['grok', team],
      ]);
      expect(catalogFor(all, 'claude', work)?.defaultModel).toBe('haiku');
      expect(catalogFor(all, 'claude')?.defaultModel).toBe('opus');
      expect(catalogFor(all, 'claude', 'gone')?.defaultModel).toBe('opus');
      expect(catalogFor(all, 'codex', work)).toMatchObject({ provider: 'codex' });
      expect(catalogFor([], 'claude')).toBeUndefined();

      // Kept for ten minutes, per account, until the CLI's settings change.
      writeFileSync(join(settings.env('claude', work).CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ model: 'fable' }));
      expect((await service.models('claude', false, work)).cliDefaultModel).toBe('sonnet');
      expect((await service.models('claude', true, work)).cliDefaultModel).toBe('fable');
      writeFileSync(join(settings.env('claude').CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
      service.invalidate('claude');
      expect((await service.models('claude')).cliDefaultModel).toBe('sonnet');
    } finally {
      vi.unstubAllEnvs();
    }
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
