import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { Provider, SettingsView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import type { FakeLogEntry, RelayServer } from '../support/relay';

const CLIS = [
  { name: 'Claude', provider: 'claude', label: 'Claude Code' },
  { name: 'Codex', provider: 'codex', label: 'Codex' },
  { name: 'Grok', provider: 'grok', label: 'Grok' },
] as const;

/** An account's box in a CLI's card in Settings, by the name it shows. */
const accountBlock = (page: Page, provider: Provider, name: string) =>
  page.locator(`#settings-${provider} .account-block`).filter({ has: page.locator('.account-head strong', { hasText: new RegExp(`^${name}$`) }) });

/** The API key box of an account's box. */
const keyBox = (block: Locator) => block.locator('details.sub').filter({ has: block.page().locator('summary', { hasText: /^API key/ }) });

/** Adds an account to a CLI in Settings, as the user does, and returns it as the server keeps it. */
async function addAccount(page: Page, relay: RelayServer, provider: Provider, label: string) {
  const card = page.locator(`#settings-${provider}`);
  const add = card.locator('details.sub').filter({ has: page.locator('summary', { hasText: 'Add an account' }) });
  await add.locator('summary').click();
  await add.getByRole('textbox', { name: 'Account name' }).fill(label);
  await add.getByRole('button', { name: 'Add an account' }).click();
  await expect(card).toContainText(`Added the account "${label}". Sign in to it above`);
  const settings = await relay.api<SettingsView>('/api/settings');
  return settings.providers.find((p) => p.provider === provider)!.accounts.find((a) => a.label === label)!;
}

/** Adds an account through the API; returns its id and the folder the server gives it. */
async function apiAccount(relay: RelayServer, provider: Provider, label = 'Work'): Promise<{ id: string; home: string }> {
  const { id } = await relay.api<{ id: string }>(`/api/settings/providers/${provider}/accounts`, { body: { label } });
  return { id, home: join(relay.dataDir, 'accounts', `${provider}-${id}`) };
}

/**
 * Signs the page in only now, at a CLI's card in Settings, for a test that added accounts through
 * the API before: the app's first look at the CLIs' status has them. (A look already under way when
 * one is added answers without it, and that answer can arrive after a newer one's.)
 */
async function openSettings(page: Page, relay: RelayServer, provider: Provider): Promise<void> {
  await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
  await expect(page.locator('.app main.main')).toBeVisible();
  await page.goto(`${relay.base}/#/settings/${provider}`);
}

/** A chat of `members` (each on the account it names, else the default one), opened in the page. */
async function chatWith(page: Page, relay: RelayServer, members: { name: string; provider: Provider; account?: string }[]): Promise<string> {
  const conv = await relay.api<{ id: string }>('/api/conversations', {
    body: {
      title: 'Accounts',
      agents: members.map((m, i) => ({ id: `m${i + 1}`, name: m.name, provider: m.provider, role: `You are ${m.name}.`, ...(m.account ? { account: m.account } : {}) })),
      settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: relay.workDir },
    },
  });
  await page.goto(`${relay.base}/#/c/${conv.id}`);
  return conv.id;
}

/** The start of the process that ran a member's turn: the one that got `@<name>`'s prompt with `text`. */
function turnStart(relay: RelayServer, provider: Provider, name: string, text: string): FakeLogEntry | undefined {
  const log = relay.fakeLog();
  const turn = log.find((e) => e.cli === provider && e.prompt?.includes(text) && new RegExp(`your turn, @${name}\\b`).test(e.prompt));
  return turn && log.find((e) => e.pid === turn.pid && e.args);
}

/** The CLIs the fakes stand in for. */
type FakeProvider = (typeof CLIS)[number]['provider'];

/** The CLI's own sign-out command. */
const LOGOUT: Record<FakeProvider, string> = { claude: 'auth logout', codex: 'logout', grok: 'logout' };
const logoutHomes = (relay: RelayServer, provider: FakeProvider) =>
  relay.fakeLog().flatMap((e) => (e.cli === provider && e.args?.join(' ') === LOGOUT[provider] ? [e.home] : []));

/**
 * The CLIs Harness Relay gives an account's API key to in the environment, with a key of each one's
 * shape: the fake CLIs say whether they were given the one the test expects (E2E_EXPECTED_API_KEY).
 */
const KEYED = [
  { ...CLIS[0], key: 'sk-ant-e2e-work-key-5678', masked: '••••5678', env: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-…' },
  { ...CLIS[2], key: 'xai-e2e-work-key-5678', masked: '••••5678', env: 'XAI_API_KEY', placeholder: 'xai-…' },
] as const;

/** The variable each CLI reads an API key from that the server's own environment may hold (Codex: one of two). */
const SERVER_KEY_ENV: Record<FakeProvider, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', grok: 'XAI_API_KEY' };

test.describe('more than one account', () => {
  for (const cli of CLIS) {
    test(`${cli.provider}: an added account has a folder of its own, and a member set to use it runs there`, async ({ page, relay }) => {
      await page.getByRole('link', { name: /Settings & sign-in/ }).click();
      const work = await addAccount(page, relay, cli.provider, 'Work');
      // A folder of its own in Harness Relay's data folder, beside the default account's usual home.
      expect(work.home).toBe(join(relay.dataDir, 'accounts', `${cli.provider}-${work.id}`));
      await expect(accountBlock(page, cli.provider, 'Work')).toContainText(`Folder: ${work.home}`);
      await expect(accountBlock(page, cli.provider, 'Work').locator('.pill')).toHaveText('Signed in');
      // Its sign-in was asked of the CLI in that folder.
      expect(relay.fakeLog().some((e) => e.cli === cli.provider && e.home === work.home && e.args)).toBe(true);

      const id = await openTeamChat(page, relay, [
        { name: cli.name, provider: cli.provider },
        { name: `${cli.name}2`, provider: cli.provider },
      ]);
      await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
      const drawer = page.getByRole('dialog', { name: 'Team settings' });
      const card = drawer.locator('.agent-card').filter({ has: page.locator(`input[aria-label="Agent name"][value="${cli.name}"]`) });
      // With a second account, each member picks one; the default one is picked until then.
      const account = card.getByRole('combobox', { name: /^Account/ });
      await expect(account.locator('option:checked')).toHaveText(/^Default account/);
      await account.selectOption(work.id);
      await drawer.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(drawer).toBeHidden();

      await send(page, 'Whose account is this?');
      await finishedReply(page, cli.name);
      await expect(await finishedReply(page, `${cli.name}2`)).toContainText('You said: “Whose account is this?”.');
      const conv = await settled(relay, id);
      expect(conv.agents.map((a) => a.account ?? '')).toEqual([work.id, '']);
      // Each member's CLI ran in its account's home: the added one's folder, and the default one's own.
      expect(turnStart(relay, cli.provider, cli.name, 'Whose account is this?')?.home).toBe(work.home);
      expect(turnStart(relay, cli.provider, `${cli.name}2`, 'Whose account is this?')?.home).toBe(join(relay.home, `.${cli.provider}`));
    });
  }

  test.describe(() => {
    // Signed in only once the accounts are added (`openSettings`).
    test.use({ signIn: false });

    test('each account signs in and out on its own', async ({ page, relay }) => {
      const { home } = await apiAccount(relay, 'claude');
      await openSettings(page, relay, 'claude');
      const work = accountBlock(page, 'claude', 'Work');
      const main = accountBlock(page, 'claude', 'Default account');
      await expect(work.locator('.pill')).toHaveText('Signed in');

      // Signing out runs the CLI's own sign-out in that account's folder only.
      acceptNextDialog(page);
      await work.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(work.locator('.pill')).toHaveText('Not signed in');
      await expect(main.locator('.pill')).toHaveText('Signed in');
      await expect(main.locator('.account-head')).toContainText('e2e@example.com');
      expect(logoutHomes(relay, 'claude')).toEqual([home]);

      // Signing in again, with Claude Code's own flow: a page to open, then the code it shows pasted back.
      await work.getByRole('button', { name: 'Sign in', exact: true }).click();
      const login = work.locator('.login-panel');
      await expect(login).toContainText('Waiting for authorisation…');
      await expect(login.getByRole('link', { name: /claude\.example\.invalid\/e2e-login/ })).toBeVisible();
      // The fake signs in as the account the code names.
      await login.getByPlaceholder('Paste the code').fill('work@example.com');
      await login.getByRole('button', { name: 'Submit' }).click();
      await expect(login).toContainText('Signed in ✓');
      await expect(work.locator('.pill')).toHaveText('Signed in');
      await expect(work.locator('.account-head')).toContainText('work@example.com');
      await expect(main.locator('.account-head')).toContainText('e2e@example.com');
      const logins = relay.fakeLog().filter((e) => e.cli === 'claude' && e.args?.[0] === 'auth' && e.args[1] === 'login');
      expect(logins.map((e) => e.home)).toEqual([home]);
    });

    for (const cli of CLIS.filter((c) => c.provider !== 'claude')) {
      test(`${cli.provider}: signing an added account out signs out only that account`, async ({ page, relay }) => {
        const { home } = await apiAccount(relay, cli.provider);
        await openSettings(page, relay, cli.provider);
        const work = accountBlock(page, cli.provider, 'Work');
        const main = accountBlock(page, cli.provider, 'Default account');
        await expect(work.locator('.pill')).toHaveText('Signed in');
        await expect(main.locator('.pill')).toHaveText('Signed in');

        acceptNextDialog(page);
        await work.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect(work.locator('.pill')).toHaveText('Not signed in');
        await expect(work.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
        // The CLI's own `logout`, in that account's folder only: the default account stays signed in.
        expect(logoutHomes(relay, cli.provider)).toEqual([home]);
        await expect(main.locator('.pill')).toHaveText('Signed in');
        await expect(main.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      });
    }
  });

  for (const cli of KEYED) {
    test.describe(() => {
      test.use({ serverEnv: { E2E_EXPECTED_API_KEY: cli.key }, signIn: false });

      test(`${cli.provider}: with the credential store off, an account's API key is kept in the database, shown masked, and given to its CLI only`, async ({ page, relay }) => {
        const { id } = await apiAccount(relay, cli.provider);
        await openSettings(page, relay, cli.provider);
        const work = accountBlock(page, cli.provider, 'Work');
        const main = accountBlock(page, cli.provider, 'Default account');

        // The tests' servers run with RELAY_KEYRING=off: the boxes say where a key goes.
        await keyBox(main).locator('summary').click();
        await expect(keyBox(main)).toContainText("Keys are kept in Harness Relay's database (readable only by your user account).");
        // The server's own environment is the default account's only.
        await expect(keyBox(main)).toContainText(`To keep it out of the database, set ${cli.env} before starting Harness Relay instead.`);
        await keyBox(work).locator('summary').click();
        await expect(keyBox(work)).toContainText("Keys are kept in Harness Relay's database");
        await expect(keyBox(work)).not.toContainText(`set ${cli.env}`);

        await keyBox(work).getByPlaceholder(cli.placeholder).fill(cli.key);
        await keyBox(work).getByRole('button', { name: 'Save', exact: true }).click();
        await expect(keyBox(work).locator('summary')).toHaveText(`API key (set: ${cli.masked})`);
        await expect(work.locator('.pill')).toHaveText('Using an API key');
        await expect(main.locator('.pill')).toHaveText('Signed in');
        // Never sent back to the browser.
        expect(JSON.stringify(await relay.api('/api/settings'))).not.toContain(cli.key);

        const conv = await chatWith(page, relay, [
          { name: cli.name, provider: cli.provider, account: id },
          { name: `${cli.name}2`, provider: cli.provider },
        ]);
        await send(page, 'Which key do you have?');
        await finishedReply(page, cli.name);
        await finishedReply(page, `${cli.name}2`);
        await settled(relay, conv);
        // The account's CLI got its key, in `cli.env` (the fake logs only whether it is the one
        // expected); the default account's did not.
        expect(turnStart(relay, cli.provider, cli.name, 'Which key do you have?')?.apiKey).toBe('expected');
        expect(turnStart(relay, cli.provider, `${cli.name}2`, 'Which key do you have?')?.apiKey).toBeNull();
        for (const s of relay.fakeLog().filter((e) => e.cli === cli.provider && e.args)) expect(JSON.stringify(s.args)).not.toContain(cli.key);
      });
    });
  }

  test.describe(() => {
    const key = 'sk-proj-e2e-work-key-5678';
    test.use({ serverEnv: { E2E_EXPECTED_API_KEY: key }, signIn: false });

    test("codex: an account's API key signs that account in with Codex's own login, which keeps it, and only its CLI gets it", async ({ page, relay }) => {
      const { id, home } = await apiAccount(relay, 'codex');
      // Signed out first, as a new account is: the key is what signs it in.
      await relay.api(`/api/providers/codex/logout?account=${id}`, { body: {} });
      await openSettings(page, relay, 'codex');
      const work = accountBlock(page, 'codex', 'Work');
      const main = accountBlock(page, 'codex', 'Default account');
      await expect(work.locator('.pill')).toHaveText('Not signed in');

      await keyBox(work).locator('summary').click();
      await expect(keyBox(work)).toContainText('Runs codex login --with-api-key; Codex keeps the key itself');
      // Harness Relay keeps no Codex key, so the box names no place it keeps one.
      await expect(keyBox(work)).not.toContainText('Keys are kept in');
      await keyBox(work).getByPlaceholder('sk-…').fill(key);
      await keyBox(work).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(work).toContainText('API key saved');
      await expect(work.locator('.pill')).toHaveText('Signed in');
      await expect(work.locator('.account-head')).toContainText('Logged in using an API key');
      await expect(main.locator('.account-head')).toContainText('Logged in using ChatGPT');
      // Nothing of it is kept here: no key set, none masked, none sent back.
      await expect(keyBox(work).locator('summary')).toHaveText('API key');
      const settings = await relay.api<SettingsView>('/api/settings');
      expect(JSON.stringify(settings)).not.toContain(key);
      expect(settings.providers.find((p) => p.provider === 'codex')!.accounts.find((a) => a.id === id)!.apiKeyMasked).toBe('');
      // `codex login --with-api-key` ran in that account's folder only, with the key on its stdin.
      const logins = relay.fakeLog().filter((e) => e.cli === 'codex' && e.args?.join(' ') === 'login --with-api-key');
      expect(logins.map((e) => e.home)).toEqual([home]);

      const conv = await chatWith(page, relay, [
        { name: 'Codex', provider: 'codex', account: id },
        { name: 'Codex2', provider: 'codex' },
      ]);
      await send(page, 'Which key do you have?');
      await finishedReply(page, 'Codex');
      await finishedReply(page, 'Codex2');
      await settled(relay, conv);
      // The account's Codex runs with the key it kept in that folder; the default account's has none.
      expect(turnStart(relay, 'codex', 'Codex', 'Which key do you have?')?.apiKey).toBe('expected');
      expect(turnStart(relay, 'codex', 'Codex2', 'Which key do you have?')?.apiKey).toBeNull();
      for (const s of relay.fakeLog().filter((e) => e.cli === 'codex' && e.args)) expect(JSON.stringify(s.args)).not.toContain(key);
    });
  });

  for (const cli of CLIS) {
    test.describe(() => {
      const key = 'e2e-server-env-key-1234';
      test.use({ serverEnv: { E2E_EXPECTED_API_KEY: key, [SERVER_KEY_ENV[cli.provider]]: key } });

      test(`${cli.provider}: the API key Harness Relay was started with is the default account's only`, async ({ page, relay }) => {
        const { id } = await apiAccount(relay, cli.provider);
        const conv = await chatWith(page, relay, [
          { name: cli.name, provider: cli.provider, account: id },
          { name: `${cli.name}2`, provider: cli.provider },
        ]);
        await send(page, 'Which key do you have?');
        await finishedReply(page, cli.name);
        await finishedReply(page, `${cli.name}2`);
        await settled(relay, conv);
        // The server's own key reaches the default account's CLI, and not the added account's (`SERVER_KEY_ENV`).
        expect(turnStart(relay, cli.provider, `${cli.name}2`, 'Which key do you have?')?.apiKey).toBe('expected');
        expect(turnStart(relay, cli.provider, cli.name, 'Which key do you have?')?.apiKey).toBeNull();
      });
    });
  }

  for (const cli of CLIS) {
    test(`${cli.provider}: removing an added account signs it out and deletes its folder, and its member and the lead agent use the default account`, async ({ page, relay }) => {
      const { id, home } = await apiAccount(relay, cli.provider);
      await relay.api('/api/settings', { method: 'PUT', body: { lead: { provider: cli.provider, account: id } } });
      const conv = await chatWith(page, relay, [{ name: cli.name, provider: cli.provider, account: id }]);
      await send(page, 'Before the removal');
      await finishedReply(page, cli.name);
      await settled(relay, conv);
      expect(turnStart(relay, cli.provider, cli.name, 'Before the removal')?.home).toBe(home);
      // Its session is kept in that folder.
      expect(existsSync(join(home, 'e2e-sessions'))).toBe(true);

      await page.goto(`${relay.base}/#/settings/${cli.provider}`);
      const work = accountBlock(page, cli.provider, 'Work');
      await expect(work.locator('.pill')).toHaveText('Signed in');
      // The confirmation names the folder that goes.
      const asked = new Promise<string>((resolve) =>
        page.once('dialog', (d) => {
          resolve(d.message());
          void d.accept();
        }),
      );
      await work.locator('.account-head').getByRole('button', { name: 'Remove', exact: true }).click();
      expect(await asked).toContain(`deletes its API key and its folder ${home}`);
      await expect(work).toHaveCount(0);
      await expect(accountBlock(page, cli.provider, 'Default account').locator('.pill')).toHaveText('Signed in');
      // Signed out with the CLI's own command in that folder (and nowhere else), then the folder deleted,
      // with the session in it.
      expect(logoutHomes(relay, cli.provider)).toEqual([home]);
      expect(existsSync(home)).toBe(false);
      const settings = await relay.api<SettingsView>('/api/settings');
      expect(settings.providers.find((p) => p.provider === cli.provider)!.accounts.map((a) => a.id)).toEqual(['']);
      expect(settings.lead.provider).toBe(cli.provider);
      expect(settings.lead.account).toBeUndefined();

      // Its member answers as the default account, in its home, in a new session of its own there.
      await page.goto(`${relay.base}/#/c/${conv}`);
      await send(page, 'After the removal');
      await expect(replies(page, cli.name)).toHaveCount(2);
      await expect(await finishedReply(page, cli.name)).toContainText('You said: “After the removal”.');
      const start = turnStart(relay, cli.provider, cli.name, 'After the removal');
      expect(start?.home).toBe(join(relay.home, `.${cli.provider}`));
      expect(relay.fakeLog().flatMap((e) => (e.pid === start!.pid && e.session ? [e.resumed] : []))).toEqual([false]);
    });
  }

  test('an account is not removed while a conversation runs', async ({ page, relay }) => {
    const { home } = await apiAccount(relay, 'claude');
    const chat = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Take your time e2e:slow');
    await expect(replies(page, 'Claude').last().locator('.live-tag')).toBeVisible();

    await page.goto(`${relay.base}/#/settings/claude`);
    const work = accountBlock(page, 'claude', 'Work');
    const remove = work.locator('.account-head').getByRole('button', { name: 'Remove', exact: true });
    acceptNextDialog(page);
    await remove.click();
    await expect(work).toContainText('A conversation is running, or the lead agent is sorting one into a group or changing a team.');
    // Nothing was done: still there, signed in, with its folder.
    await expect(work.locator('.pill')).toHaveText('Signed in');
    expect(existsSync(home)).toBe(true);
    expect(logoutHomes(relay, 'claude')).toEqual([]);

    await relay.api(`/api/conversations/${chat}/stop`, { body: {} });
    await settled(relay, chat);
    acceptNextDialog(page);
    await remove.click();
    await expect(work).toHaveCount(0);
    expect(existsSync(home)).toBe(false);
  });
});
