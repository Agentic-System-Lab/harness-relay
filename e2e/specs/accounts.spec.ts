import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Provider, SettingsView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openTeamChat, send, settled } from '../support/app';
import type { RelayServer } from '../support/relay';

const CLIS = [
  { name: 'Claude', provider: 'claude', label: 'Claude Code' },
  { name: 'Codex', provider: 'codex', label: 'Codex' },
  { name: 'Grok', provider: 'grok', label: 'Grok' },
] as const;

/** An account's box in a CLI's card in Settings, by the name it shows. */
const accountBlock = (page: Page, provider: Provider, name: string) =>
  page.locator(`#settings-${provider} .account-block`).filter({ has: page.locator('.account-head strong', { hasText: new RegExp(`^${name}$`) }) });

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

/** The home the CLI ran a member's turn in: the start of the process that got `@<name>`'s prompt. */
function turnHome(relay: RelayServer, provider: Provider, name: string, text: string): string | undefined {
  const log = relay.fakeLog();
  const turn = log.find((e) => e.cli === provider && e.prompt?.includes(text) && new RegExp(`your turn, @${name}\\b`).test(e.prompt));
  return turn && log.find((e) => e.pid === turn.pid && e.args)?.home;
}

/** The API key a test saves for an account; the fake CLIs say whether they were given it. */
const WORK_KEY = 'sk-ant-e2e-work-key-5678';

test.describe('more than one account', () => {
  test.use({ serverEnv: { E2E_EXPECTED_API_KEY: WORK_KEY } });

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
      expect(turnHome(relay, cli.provider, cli.name, 'Whose account is this?')).toBe(work.home);
      expect(turnHome(relay, cli.provider, `${cli.name}2`, 'Whose account is this?')).toBe(join(relay.home, `.${cli.provider}`));
    });
  }

  test('each account signs in and out on its own', async ({ page, relay }) => {
    const { id } = await relay.api<{ id: string }>('/api/settings/providers/claude/accounts', { body: { label: 'Work' } });
    const home = join(relay.dataDir, 'accounts', `claude-${id}`);
    await page.goto(page.url().replace(/#.*$/, '#/settings/claude'));
    const work = accountBlock(page, 'claude', 'Work');
    const main = accountBlock(page, 'claude', 'Default account');
    await expect(work.locator('.pill')).toHaveText('Signed in');

    // Signing out runs the CLI's own sign-out in that account's folder only.
    acceptNextDialog(page);
    await work.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(work.locator('.pill')).toHaveText('Not signed in');
    await expect(main.locator('.pill')).toHaveText('Signed in');
    await expect(main.locator('.account-head')).toContainText('e2e@example.com');
    const logouts = relay.fakeLog().filter((e) => e.cli === 'claude' && e.args?.join(' ') === 'auth logout');
    expect(logouts.map((e) => e.home)).toEqual([home]);

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

  test("with the credential store off, an account's API key is kept in the database, shown masked, and given to its CLI only", async ({ page, relay }) => {
    const { id } = await relay.api<{ id: string }>('/api/settings/providers/claude/accounts', { body: { label: 'Work' } });
    await page.goto(page.url().replace(/#.*$/, '#/settings/claude'));
    const work = accountBlock(page, 'claude', 'Work');
    const main = accountBlock(page, 'claude', 'Default account');
    const keyBox = (block: typeof work) => block.locator('details.sub').filter({ has: page.locator('summary', { hasText: /^API key/ }) });

    // The tests' servers run with RELAY_KEYRING=off: the boxes say where a key goes.
    await keyBox(main).locator('summary').click();
    await expect(keyBox(main)).toContainText("Keys are kept in Harness Relay's database (readable only by your user account).");
    // The server's own environment is the default account's only.
    await expect(keyBox(main)).toContainText('To keep it out of the database, set ANTHROPIC_API_KEY before starting Harness Relay instead.');
    await keyBox(work).locator('summary').click();
    await expect(keyBox(work)).toContainText("Keys are kept in Harness Relay's database");
    await expect(keyBox(work)).not.toContainText('set ANTHROPIC_API_KEY');

    const key = WORK_KEY;
    await keyBox(work).getByPlaceholder('sk-ant-…').fill(key);
    await keyBox(work).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(keyBox(work).locator('summary')).toHaveText('API key (set: sk-a…5678)');
    await expect(work.locator('.pill')).toHaveText('Using an API key');
    await expect(main.locator('.pill')).toHaveText('Signed in');
    // Never sent back to the browser.
    expect(JSON.stringify(await relay.api('/api/settings'))).not.toContain(key);

    const conv = await relay.api<{ id: string }>('/api/conversations', {
      body: {
        title: 'Keys',
        agents: [
          { id: 'm1', name: 'Claude', provider: 'claude', role: 'You are Claude.', account: id },
          { id: 'm2', name: 'Claude2', provider: 'claude', role: 'You are Claude2.' },
        ],
        settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: relay.workDir },
      },
    });
    await page.goto(`${relay.base}/#/c/${conv.id}`);
    await send(page, 'Which key do you have?');
    await finishedReply(page, 'Claude');
    await finishedReply(page, 'Claude2');
    await settled(relay, conv.id);
    // The account's CLI got its key as ANTHROPIC_API_KEY (the fake logs only whether it is the one expected); the default account's did not.
    const starts = relay.fakeLog().filter((e) => e.cli === 'claude' && e.args);
    const turnStart = (name: string) => {
      const turn = relay.fakeLog().find((e) => e.cli === 'claude' && e.prompt?.includes('Which key do you have?') && new RegExp(`your turn, @${name}\\b`).test(e.prompt));
      return starts.find((e) => e.pid === turn?.pid);
    };
    expect(turnStart('Claude')?.apiKey).toBe('expected');
    expect(turnStart('Claude2')?.apiKey).toBeNull();
    for (const s of starts) expect(JSON.stringify(s.args)).not.toContain(key);
  });
});
