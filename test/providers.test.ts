import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { removeTree } from '../src/server/fsRemove';

const root = mkdtempSync(join(tmpdir(), 'relay-providers-'));
process.env.RELAY_DATA_DIR = join(root, 'data');
// An open agent's home keeps its config read-only (the model lookups write one): taken apart as runs leave it.
afterAll(() => removeTree(root, { restore: true }));

const { openDatabase } = await import('../src/server/db');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { OPEN_PROVIDERS, catalogFor } = await import('../src/shared/types');

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

describe('a signed-out account', () => {
  // What each CLI prints when its home has no sign-in (tried with the real ones).
  const SIGNED_OUT: Record<'claude' | 'codex' | 'grok', string> = {
    claude: `case "$1 $2" in
  "--version ") echo "2.1.0 (Claude Code)" ;;
  "auth status") echo '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty",\n  "loginExpiresAt": null\n}'; exit 1 ;;
esac`,
    codex: `case "$1 $2" in
  "--version ") echo "codex-cli 0.80.0" ;;
  "login status") echo "Not logged in" >&2; exit 1 ;;
esac`,
    grok: `case "$1" in
  --version) echo "grok 1.2.0" ;;
  models) printf 'You are not authenticated.\\n\\nDefault model: grok-4.6\\n' ;;
esac`,
  };
  const posixIt = process.platform === 'win32' ? it.skip : it;

  for (const provider of ['claude', 'codex', 'grok'] as const) {
    posixIt(`says only that it is signed out (${provider}), with nothing of the CLI's own words after the pill`, async () => {
      const dir = join(root, `signed-out-${provider}`);
      mkdirSync(dir, { recursive: true });
      const bin = join(dir, provider);
      writeFileSync(bin, `#!/bin/sh\n${SIGNED_OUT[provider]}\n`, { mode: 0o755 });
      const settings = new SettingsStore(openDatabase(':memory:'));
      settings.update(provider, { bin });
      settings.setAgentHome(join(dir, 'homes'));
      const status = await new ProviderService(settings).status(provider, true);
      expect(status.installed).toBe(true);
      expect(status.accounts).toEqual([{ id: '', label: '', auth: { loggedIn: false }, usingStoredApiKey: false }]);
    });
  }
});

describe('accounts of a CLI', () => {
  // A stand-in for `claude` that keeps its sign-in in its home, as the real one does.
  const FAKE_CLAUDE = `#!/bin/sh
home="$CLAUDE_CONFIG_DIR"
case "$1 $2" in
  "--version ") echo "2.1.0 (Claude Code)" ;;
  "auth status")
    if [ -f "$home/signed-in" ]; then printf '{"loggedIn": true, "email": "%s", "authMethod": "claude.ai"}\\n' "$(cat "$home/signed-in")"
    else echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'; fi ;;
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
      for (const p of OPEN_PROVIDERS) settings.update(p, { bin: join(root, `no-such-${p}-models`) });
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
        ...OPEN_PROVIDERS.map((p) => [p, '']),
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
      writeFileSync(join(settings.env('claude', work).CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ model: 'opus' }));
      service.invalidate('claude');
      // Every account of that CLI is asked again.
      expect((await service.models('claude')).cliDefaultModel).toBe('sonnet');
      expect((await service.models('claude', false, work)).cliDefaultModel).toBe('opus');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A stand-in for `grok models` that counts its runs in its home and names its model after the count.
  const COUNTING_GROK = `#!/bin/sh
n=$(cat "$GROK_HOME/runs" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$GROK_HOME/runs"
echo "  - grok-run-$n"
`;

  posixIt("asks every account of a CLI again when that CLI's models are invalidated, and no other CLI's", async () => {
    const dir = join(root, 'invalidate');
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'grok');
    writeFileSync(bin, COUNTING_GROK, { mode: 0o755 });
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.setAgentHome(join(dir, 'homes'));
    settings.update('grok', { bin });
    const team = settings.addAccount('grok', 'Team');
    const service = new ProviderService(settings);
    const ids = async (account = '') => (await service.models('grok', false, account)).models.map((m) => m.id);
    expect([await ids(), await ids(team)]).toEqual([['grok-run-1'], ['grok-run-1']]);
    expect([await ids(), await ids(team)]).toEqual([['grok-run-1'], ['grok-run-1']]); // kept
    service.invalidate('claude');
    expect([await ids(), await ids(team)]).toEqual([['grok-run-1'], ['grok-run-1']]);
    service.invalidate('grok');
    expect([await ids(), await ids(team)]).toEqual([['grok-run-2'], ['grok-run-2']]);
    service.invalidate();
    expect(await ids(team)).toEqual(['grok-run-3']);
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
