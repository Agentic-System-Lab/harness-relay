import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const SIGNED_OUT: Record<'claude' | 'codex' | 'grok' | 'cursor', string> = {
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
    cursor: `case "$1 $2 $3" in
  "--version  ") echo "2026.11.11-043ef28" ;;
  "status --format json") printf '{\\n  "status": "unauthenticated",\\n  "isAuthenticated": false,\\n  "message": "Not logged in"\\n}\\n' ;;
esac`,
  };
  const posixIt = process.platform === 'win32' ? it.skip : it;

  for (const provider of ['claude', 'codex', 'grok', 'cursor'] as const) {
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

describe("Cursor's one sign-in", () => {
  // A stand-in for \`cursor-agent\`: its sign-in is the computer user's (here, a file outside its
  // config folder), and \`status\` reads only the store it is given: with the in-memory store it says
  // signed out, key or no key (as the real one does).
  const FAKE_CURSOR = `#!/bin/sh
signed="$FAKE_CURSOR_DIR/signed-in"
case "$1" in
  --version) echo "2026.11.11-043ef28" ;;
  status)
    if [ "$AGENT_CLI_CREDENTIAL_STORE" != "memory" ] && [ -f "$signed" ]; then printf '{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"%s"}}\\n' "$(cat "$signed")"
    else echo '{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}'; fi ;;
  login) echo "login browser=\${NO_OPEN_BROWSER:-open}" >> "$FAKE_CURSOR_DIR/log"; echo "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc"; echo "me@example.com" > "$signed" ;;
  logout) echo "logout store=\${AGENT_CLI_CREDENTIAL_STORE:-system} key=\${CURSOR_API_KEY:-none}" >> "$FAKE_CURSOR_DIR/log"; rm -f "$signed" ;;
esac
`;
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('belongs to the default account; another account signs in with its API key only, apart from it', async () => {
    const { KeyOnlyAccountError } = await import('../src/server/providers');
    const dir = join(root, 'cursor-sign-in');
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'cursor-agent');
    writeFileSync(bin, FAKE_CURSOR, { mode: 0o755 });
    vi.stubEnv('FAKE_CURSOR_DIR', dir);
    vi.stubEnv('CURSOR_API_KEY', '');
    vi.stubEnv('CURSOR_AUTH_TOKEN', '');
    try {
      const settings = new SettingsStore(openDatabase(':memory:'));
      settings.update('cursor', { bin });
      settings.setAgentHome(join(dir, 'homes'));
      const team = settings.addAccount('cursor', 'Team');
      const service = new ProviderService(settings);
      const log = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);

      // Its sign-in link is printed, not opened in a browser here.
      service.startLogin('cursor');
      await vi.waitFor(() => expect(service.login('cursor')?.state).toBe('success'));
      expect(service.login('cursor')?.urls).toEqual(['https://cursor.com/loginDeepControl?challenge=abc']);
      expect(log()).toEqual(['login browser=1']);
      expect(() => service.startLogin('cursor', undefined, team)).toThrow(KeyOnlyAccountError);

      const status = await service.status('cursor', true);
      expect(status).toMatchObject({ installed: true, version: '2026.11.11-043ef28' });
      expect(status.accounts.map((a) => [a.id, a.auth])).toEqual([
        ['', { loggedIn: true, account: 'me@example.com' }],
        [team, { loggedIn: false }], // not the default account's sign-in
      ]);
      settings.updateAccount('cursor', team, { apiKey: 'key_team' });
      service.invalidate('cursor');
      // Its key signs it in for each run only, which \`status\` cannot see: it is taken as signed in by it.
      expect((await service.status('cursor', true)).accounts[1]).toMatchObject({ auth: { loggedIn: true, method: 'API key' }, usingStoredApiKey: true });

      // A key only in the server's environment: the default account runs on it, and shows so.
      vi.stubEnv('CURSOR_API_KEY', 'key_from_shell');
      expect((await service.status('cursor', true)).accounts[0]).toMatchObject({ auth: { loggedIn: true, method: 'API key' }, usingStoredApiKey: false });
      vi.stubEnv('CURSOR_API_KEY', '');

      // Signing the other account out signs nothing out: it kept nothing.
      await service.logout('cursor', team);
      expect(log()).toEqual(['login browser=1']);
      // The default account signs out of Cursor's own sign-in, also when it has a key of its own.
      settings.updateAccount('cursor', '', { apiKey: 'key_default' });
      await service.logout('cursor');
      expect(log()).toEqual(['login browser=1', 'logout store=system key=none']);
      // In the store the server was started with, when it names one.
      vi.stubEnv('AGENT_CLI_CREDENTIAL_STORE', 'file');
      await service.logout('cursor');
      expect(log().at(-1)).toBe('logout store=file key=none');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Antigravity's sign-in", () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt("signs the default account in with Google in its home, prints the link rather than open a browser, and gives another account its key only", async () => {
    const { KeyOnlyAccountError } = await import('../src/server/providers');
    const { writeFakeAntigravity } = await import('./fake-antigravity');
    const { t } = await import('../src/server/i18n');
    const dir = join(root, 'antigravity-sign-in');
    mkdirSync(dir, { recursive: true });
    const bin = writeFakeAntigravity(join(dir, 'agy'));
    const logFile = join(dir, 'log.jsonl');
    vi.stubEnv('FAKE_AGY_LOG', logFile);
    vi.stubEnv('FAKE_AGY_CLI', join(__dirname, 'fixtures', 'antigravity', 'cli'));
    vi.stubEnv('FAKE_AGY_MODELS', 'models-signed-out.txt');
    vi.stubEnv('GEMINI_API_KEY', '');
    try {
      const settings = new SettingsStore(openDatabase(':memory:'));
      settings.update('antigravity', { bin });
      settings.setAgentHome(join(dir, 'homes'));
      const team = settings.addAccount('antigravity', 'Team');
      const service = new ProviderService(settings);
      const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
      const starts = () => log().filter((l) => l.start);

      // `agy models` answers only signed in, asked in the account's home (as HOME: only `agy acp` takes
      // --gemini-dir). The other account runs on its own key only: without one it is signed out, and agy
      // is not asked (the Google sign-in it keeps is the default account's), even when agy is signed in.
      vi.stubEnv('FAKE_AGY_MODELS', 'models.txt');
      const out = await service.status('antigravity', true);
      expect(out.accounts.map((a) => [a.id, a.auth.loggedIn])).toEqual([
        ['', true],
        [team, false],
      ]);
      expect(starts().filter((l) => l.argv.includes('models')).map((l) => l.env.HOME)).toEqual([join(dir, 'homes', 'antigravity')]);
      vi.stubEnv('FAKE_AGY_MODELS', 'models-signed-out.txt');
      expect((await service.status('antigravity', true)).accounts[0]!.auth.loggedIn).toBe(false);
      expect(starts().filter((l) => l.argv[0] === 'models').every((l) => l.env.SSH_CONNECTION && l.env.HARNESS_RELAY_ANTIGRAVITY_HOME === null)).toBe(true);
      expect(out).toMatchObject({ installed: true, version: '1.5.6' });
      vi.stubEnv('FAKE_AGY_MODELS', 'models.txt');
      expect((await service.status('antigravity', true)).accounts[0]!.auth).toEqual({ loggedIn: true });

      // Its sign-in prints the link and waits for the code the page shows.
      const view = service.startLogin('antigravity');
      expect(view.method).toBe('google');
      await vi.waitFor(() => expect(service.login('antigravity')?.wantsInput).toBe(true));
      expect(service.login('antigravity')?.urls).toEqual(['https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test']);
      service.sendLoginInput('antigravity', '4/0Abc-code');
      await vi.waitFor(() => expect(service.login('antigravity')?.state).toBe('success'));
      const login = starts().find((l) => l.argv.includes('--login'))!;
      expect(login.argv).toEqual(['acp', '--login']);
      expect(login.env).toMatchObject({ HOME: join(dir, 'homes', 'antigravity'), SSH_CONNECTION: expect.any(String) });
      expect(log().find((l) => l.code)?.code).toBe('4/0Abc-code');
      // Another account's sign-in could replace the default one's in the keyring: it runs on its key only.
      expect(() => service.startLogin('antigravity', undefined, team)).toThrow(KeyOnlyAccountError);
      expect(() => service.startLogin('antigravity', undefined, team)).toThrow(t().antigravityAccountLogin);
      settings.updateAccount('antigravity', team, { apiKey: 'AIza-team' });
      service.invalidate('antigravity');
      expect((await service.status('antigravity', true)).accounts[1]).toMatchObject({ auth: { loggedIn: true, method: 'API key' }, usingStoredApiKey: true });

      // Signing that account out drops nothing (the Google sign-in agy keeps is the default account's);
      // the default account signs out with agy's ACP logout, in its home.
      const before = starts().length;
      await service.logout('antigravity', team);
      expect(starts().length).toBe(before);
      await service.logout('antigravity');
      const logout = starts().at(-1)!;
      expect(logout.argv).toEqual(['acp', '--gemini-dir', join(dir, 'homes', 'antigravity', '.gemini')]);
      expect(log().at(-1)).toMatchObject({ method: 'logout' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Copilot's sign-in", () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt("signs each account in to GitHub with a device code in its own home, tells who it is signed in as, and signs out over ACP", async () => {
    const { writeFakeCopilot } = await import('./fake-copilot');
    const dir = join(root, 'copilot-sign-in');
    mkdirSync(dir, { recursive: true });
    const bin = writeFakeCopilot(join(dir, 'copilot'));
    const logFile = join(dir, 'log.jsonl');
    vi.stubEnv('FAKE_COPILOT_LOG', logFile);
    // A GitHub token in the server's environment is the default account's only.
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
    try {
      const settings = new SettingsStore(openDatabase(':memory:'));
      settings.update('copilot', { bin });
      settings.setAgentHome(join(dir, 'homes'));
      const team = settings.addAccount('copilot', 'Team');
      const service = new ProviderService(settings);
      const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
      const starts = () => log().filter((l) => l.start);
      const home = join(dir, 'homes', 'copilot');

      // Nobody signed in yet: a session it opens (in a home of its own, with the account's sign-in state) says so.
      let out = await service.status('copilot', true);
      expect(out).toMatchObject({ installed: true, version: '1.0.109' });
      expect(out.accounts.map((a) => [a.id, a.auth.loggedIn])).toEqual([
        ['', false],
        [team, false],
      ]);

      // Where it cannot keep the token (no credential store), it says so and exits 0: a failed sign-in.
      vi.stubEnv('FAKE_COPILOT_NO_KEYRING', '1');
      service.startLogin('copilot');
      await vi.waitFor(() => expect(service.login('copilot')?.state).toBe('failed'));
      expect(service.login('copilot')?.output).toContain('the token was not saved');
      expect((await service.status('copilot', true)).accounts[0]!.auth.loggedIn).toBe(false);
      vi.stubEnv('FAKE_COPILOT_NO_KEYRING', '');

      // Its device sign-in prints GitHub's link and code, in the account's home.
      const view = service.startLogin('copilot');
      expect(view.method).toBe('device');
      await vi.waitFor(() => expect(service.login('copilot')?.state).toBe('success'));
      expect(service.login('copilot')?.urls).toEqual(['https://github.com/login/device']);
      expect(service.login('copilot')?.codes).toEqual(['ABCD-1234']);
      const login = starts().find((l) => l.argv[0] === 'login')!;
      expect(login.argv).toEqual(['login', '--device-code']);
      expect(login.env.COPILOT_HOME).toBe(home);
      out = await service.status('copilot', true);
      expect(out.accounts[0]!.auth).toEqual({ loggedIn: true, account: 'octocat' });
      expect(out.accounts[1]!.auth.loggedIn).toBe(false);

      // Another account signs in in its own home; with a token of its own it runs on that.
      settings.updateAccount('copilot', team, { apiKey: 'github_pat_team' });
      service.invalidate('copilot');
      expect((await service.status('copilot', true)).accounts[1]).toMatchObject({ auth: { loggedIn: true, method: 'GitHub token' }, usingStoredApiKey: true });
      expect(settings.env('copilot', team).COPILOT_GITHUB_TOKEN).toBe('github_pat_team');
      // A token is asked about too: one Copilot does not take (a classic token) is not signed in, though it is set.
      vi.stubEnv('FAKE_COPILOT_SIGNED_OUT', '1');
      service.invalidate('copilot');
      expect((await service.status('copilot', true)).accounts[1]!.auth.loggedIn).toBe(false);
      vi.stubEnv('FAKE_COPILOT_SIGNED_OUT', '');
      service.invalidate('copilot');

      // The status asked Copilot itself: a session in a home of its own, never the account's, with no prompt.
      const asks = starts().filter((l) => l.argv.join(' ') === '--acp');
      expect(asks.length).toBeGreaterThan(0);
      expect(asks.every((l) => l.env.COPILOT_HOME !== home)).toBe(true);
      expect(log().some((l) => l.method === 'session/prompt')).toBe(false);

      // The default account signs out with Copilot's ACP logout, in its home.
      await service.logout('copilot');
      const logout = starts().filter((l) => l.env.COPILOT_HOME === home).at(-1)!;
      expect(logout.argv).toEqual(['--acp']);
      expect(log().filter((l) => l.method === 'logout')).toHaveLength(1);
      expect((await service.status('copilot', true)).accounts[0]!.auth.loggedIn).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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
    else echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'; fi ;;
  "auth login") echo "work@example.com" > "$home/signed-in"; echo "Logged in" ;;
  "auth logout") rm -f "$home/signed-in"; echo "Logged out" ;;
esac
`;
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('keeps no status that was being asked when an account changed, so the next one has it', async () => {
    const dir = join(root, 'changed-while-asked');
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'claude');
    writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.update('claude', { bin });
    settings.setAgentHome(join(dir, 'homes'));
    const service = new ProviderService(settings);

    // Asked before the account is added (and the status invalidated, as the route does), answered after.
    const asking = service.status('claude', true);
    const work = settings.addAccount('claude', 'Work');
    service.invalidate('claude');
    expect((await asking).accounts.map((a) => a.id)).toEqual(['']);
    // Not kept: the next status, not forced, asks again instead of giving that answer for 20 s.
    const next = await service.status('claude');
    expect(next.accounts.map((a) => a.id)).toEqual(['', work]);
    // A cached answer keeps the time of the check it came from; a forced one is checked anew.
    expect((await service.status('claude')).checkedAt).toBe(next.checkedAt);
    expect((await service.status('claude', true)).checkedAt).toBeGreaterThanOrEqual(next.checkedAt!);
    expect((await asking).checkedAt).toBeLessThanOrEqual(next.checkedAt!);

    // The clock set back: each new check is still dated later, so it still wins in the chat.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 60_000);
    try {
      expect((await service.status('claude', true)).checkedAt).toBeGreaterThan(next.checkedAt!);
    } finally {
      clock.mockRestore();
    }
  });

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
      settings.update('cursor', { bin: join(root, 'no-such-cursor-models') });
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
        ['cursor', ''],
        ['antigravity', ''],
        ['copilot', ''],
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
