import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page, Request } from '@playwright/test';
import type { Provider, SettingsView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import { defaultHome, eachCli, homeIn, logoutArgs, sessionFile, SIGNED_IN, type Cli } from '../support/clis';
import type { FakeLogEntry, RelayServer } from '../support/relay';

/*
 * The CLIs with a sign-in of their own have accounts (the open agents have none: they run on the
 * model backends). An account besides the default one signs in on its own (`accounts: 'sign-in'`),
 * or with an API key only (`key-only`: Cursor, Antigravity), which these tests then give it.
 */

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

/** Opens a CLI's card in Settings, for a test that added accounts through the API: it asks the CLIs' status again. */
async function openSettings(page: Page, relay: RelayServer, provider: Provider): Promise<void> {
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

const CLAUDE = SIGNED_IN.find((c) => c.provider === 'claude')!;

/** The CLI's own sign-out command's runs, by the home each ran in. */
const logoutHomes = (relay: RelayServer, cli: Cli) => relay.fakeLog().flatMap((e) => (e.cli === cli.provider && e.args?.join(' ') === logoutArgs(cli) ? [e.home] : []));

/** Where the CLI's fake runs in an account's folder: its home (`homeIn`). */
const homeOf = (cli: Cli, folder: string) => join(folder, ...homeIn(cli));

/** An API key of the shape the CLI's box asks for (its placeholder's beginning), ending as `masked` shows it. */
const keyOf = (cli: Cli, what: string) => `${(cli.apiKeyPlaceholder ?? '').replace(/…$/, '')}e2e-${what}-key-5678`;
const masked = '••••5678';

/** Gives an account its own API key through the API (a key-only account signs in with one). */
const giveKey = (relay: RelayServer, cli: Cli, id: string, key: string) =>
  relay.api(`/api/settings/providers/${cli.provider}/accounts/${id}`, { method: 'PUT', body: { apiKey: key } });

/**
 * The CLIs Harness Relay gives an account's API key to in the environment (Codex keeps one itself,
 * `codex login --with-api-key`: a test of its own): the fake CLIs say whether they were given the one
 * the test expects (E2E_EXPECTED_API_KEY).
 */
const KEYED = SIGNED_IN.filter((c) => c.apiKeyEnv && c.provider !== 'codex');

test.describe('more than one account', () => {
  eachCli(SIGNED_IN, (cli) => {
    test(`${cli.provider}: an added account has a folder of its own, and a member set to use it runs there`, async ({ page, relay }) => {
      await page.getByRole('link', { name: /Settings & sign-in/ }).click();
      const work = await addAccount(page, relay, cli.provider, 'Work');
      // A folder of its own in Harness Relay's data folder, beside the default account's usual home.
      expect(work.home).toBe(join(relay.dataDir, 'accounts', `${cli.provider}-${work.id}`));
      await expect(accountBlock(page, cli.provider, 'Work')).toContainText(`Folder: ${work.home}`);
      if (cli.accounts === 'key-only') {
        // It signs in with its own API key only.
        await giveKey(relay, cli, work.id, keyOf(cli, 'work'));
        await page.reload();
        await expect(accountBlock(page, cli.provider, 'Work').locator('.pill')).toHaveText('Using an API key');
      } else {
        await expect(accountBlock(page, cli.provider, 'Work').locator('.pill')).toHaveText('Signed in');
        // Its sign-in was asked of the CLI in that folder.
        expect(relay.fakeLog().some((e) => e.cli === cli.provider && e.home === homeOf(cli, work.home!) && e.args)).toBe(true);
      }

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
      expect(turnStart(relay, cli.provider, cli.name, 'Whose account is this?')?.home).toBe(homeOf(cli, work.home!));
      expect(turnStart(relay, cli.provider, `${cli.name}2`, 'Whose account is this?')?.home).toBe(defaultHome(relay, cli.provider));
    });
  });

  test.describe(() => {
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
      expect(logoutHomes(relay, CLAUDE)).toEqual([home]);

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

    // The others whose added accounts sign in on their own (a key-only account has no sign-in to sign out of).
    eachCli(SIGNED_IN.filter((c) => c.provider !== 'claude' && c.accounts === 'sign-in'), (cli) => {
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
        expect(logoutHomes(relay, cli)).toEqual([homeOf(cli, home)]);
        await expect(main.locator('.pill')).toHaveText('Signed in');
        await expect(main.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      });
    });
  });

  eachCli(KEYED, (cli) => {
    const key = keyOf(cli, 'work');
    test.describe(() => {
      test.use({ serverEnv: { E2E_EXPECTED_API_KEY: key } });

      test(`${cli.provider}: with the credential store off, an account's API key is kept in the database, shown masked, and given to its CLI only`, async ({ page, relay }) => {
        const { id } = await apiAccount(relay, cli.provider);
        await openSettings(page, relay, cli.provider);
        const work = accountBlock(page, cli.provider, 'Work');
        const main = accountBlock(page, cli.provider, 'Default account');

        // The tests' servers run with RELAY_KEYRING=off: the boxes say where a key goes.
        await keyBox(main).locator('summary').click();
        await expect(keyBox(main)).toContainText("Keys are kept in Harness Relay's database (readable only by your user account).");
        // The server's own environment is the default account's only.
        await expect(keyBox(main)).toContainText(`To keep it out of the database, set ${cli.apiKeyEnv} before starting Harness Relay instead.`);
        // A key-only account's box is open already: its key is how it signs in.
        if (cli.accounts !== 'key-only') await keyBox(work).locator('summary').click();
        await expect(keyBox(work)).toContainText("Keys are kept in Harness Relay's database");
        await expect(keyBox(work)).not.toContainText(`set ${cli.apiKeyEnv}`);

        await keyBox(work).getByPlaceholder(cli.apiKeyPlaceholder!).fill(key);
        await keyBox(work).getByRole('button', { name: 'Save', exact: true }).click();
        await expect(keyBox(work).locator('summary')).toHaveText(`API key (set: ${masked})`);
        await expect(work.locator('.pill')).toHaveText('Using an API key');
        await expect(main.locator('.pill')).toHaveText('Signed in');
        // Never sent back to the browser.
        expect(JSON.stringify(await relay.api('/api/settings'))).not.toContain(key);

        const conv = await chatWith(page, relay, [
          { name: cli.name, provider: cli.provider, account: id },
          { name: `${cli.name}2`, provider: cli.provider },
        ]);
        await send(page, 'Which key do you have?');
        await finishedReply(page, cli.name);
        await finishedReply(page, `${cli.name}2`);
        await settled(relay, conv);
        // The account's CLI got its key, in `apiKeyEnv` (the fake logs only whether it is the one
        // expected); the default account's did not.
        expect(turnStart(relay, cli.provider, cli.name, 'Which key do you have?')?.apiKey).toBe('expected');
        expect(turnStart(relay, cli.provider, `${cli.name}2`, 'Which key do you have?')?.apiKey).toBeNull();
        for (const s of relay.fakeLog().filter((e) => e.cli === cli.provider && e.args)) expect(JSON.stringify(s.args)).not.toContain(key);
      });
    });
  });

  test.describe(() => {
    const key = 'sk-proj-e2e-work-key-5678';
    test.use({ serverEnv: { E2E_EXPECTED_API_KEY: key } });

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

  eachCli(SIGNED_IN.filter((c) => c.apiKeyEnv), (cli) => {
    test.describe(() => {
      const key = 'e2e-server-env-key-1234';
      test.use({ serverEnv: { E2E_EXPECTED_API_KEY: key, [cli.apiKeyEnv!]: key } });

      test(`${cli.provider}: the API key Harness Relay was started with is the default account's only`, async ({ page, relay }) => {
        const { id } = await apiAccount(relay, cli.provider);
        // A key-only account runs on a key of its own, which is another.
        if (cli.accounts === 'key-only') await giveKey(relay, cli, id, keyOf(cli, 'own'));
        const conv = await chatWith(page, relay, [
          { name: cli.name, provider: cli.provider, account: id },
          { name: `${cli.name}2`, provider: cli.provider },
        ]);
        await send(page, 'Which key do you have?');
        await finishedReply(page, cli.name);
        await finishedReply(page, `${cli.name}2`);
        await settled(relay, conv);
        // The server's own key reaches the default account's CLI (`apiKeyEnv`), and not the added account's.
        expect(turnStart(relay, cli.provider, `${cli.name}2`, 'Which key do you have?')?.apiKey).toBe('expected');
        const added = turnStart(relay, cli.provider, cli.name, 'Which key do you have?')?.apiKey;
        if (cli.accounts === 'key-only') expect(added).toBe('other');
        else expect(added).toBeNull();
      });
    });
  });

  eachCli(SIGNED_IN, (cli) => {
    test(`${cli.provider}: removing an added account signs it out and deletes its folder, and its member and the lead agent use the default account`, async ({ page, relay }) => {
      const { id, home } = await apiAccount(relay, cli.provider);
      if (cli.accounts === 'key-only') await giveKey(relay, cli, id, keyOf(cli, 'work'));
      await relay.api('/api/settings', { method: 'PUT', body: { lead: { provider: cli.provider, account: id } } });
      const conv = await chatWith(page, relay, [{ name: cli.name, provider: cli.provider, account: id }]);
      await send(page, 'Before the removal');
      await finishedReply(page, cli.name);
      await settled(relay, conv);
      const before = turnStart(relay, cli.provider, cli.name, 'Before the removal');
      expect(before?.home).toBe(homeOf(cli, home));
      // Its session is kept in that folder.
      const session = relay.fakeLog().find((e) => e.pid === before!.pid && e.session)?.session;
      expect(session && sessionFile(home, session), 'its session').toBeTruthy();

      await page.goto(`${relay.base}/#/settings/${cli.provider}`);
      const work = accountBlock(page, cli.provider, 'Work');
      await expect(work.locator('.pill')).toHaveText(cli.accounts === 'key-only' ? 'Using an API key' : 'Signed in');
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
      // Signed out with the CLI's own command in that folder (and nowhere else; a key-only account has
      // nothing to sign out of), then the folder deleted, with the session in it.
      expect(logoutHomes(relay, cli)).toEqual(cli.accounts === 'key-only' ? [] : [homeOf(cli, home)]);
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
      expect(start?.home).toBe(defaultHome(relay, cli.provider));
      expect(relay.fakeLog().flatMap((e) => (e.pid === start!.pid && e.session ? [e.resumed] : []))).toEqual([false]);
    });
  });

  test("an account added while the CLIs' status is on its way keeps the newer answer's state", async ({ page, relay }) => {
    // The page's next look at the CLIs' status is held on its way back: asked before the account is
    // added, it arrives after the answer that has the account, as a slow one would.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let answered!: () => void;
    const asked = new Promise<void>((r) => (answered = r));
    let held: Request | undefined;
    await page.route(/\/api\/providers(\?|$)/, async (route) => {
      if (held) return route.continue();
      held = route.request();
      const response = await route.fetch();
      answered();
      await released;
      await route.fulfill({ response });
    });
    await page.goto(`${relay.base}/#/settings/claude`);
    await asked;
    await addAccount(page, relay, 'claude', 'Work');
    const pill = accountBlock(page, 'claude', 'Work').locator('.pill');
    await expect(pill).toHaveText('Signed in');

    const landed = page.waitForEvent('requestfinished', (r) => r === held);
    release();
    await landed;
    // The older answer, without the account, came in last: the page keeps the newer one's state.
    for (let i = 0; i < 20; i++) {
      await expect(pill).toHaveText('Signed in', { timeout: 1_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
  });

  test('a CLI signed out outside Harness Relay shows so when Settings is opened again', async ({ page, relay }) => {
    // Settings' own look when it first opens, finished before the sign-out: so the server's cache is
    // the signed-in answer, and the look the test waits for below is the reopened page's.
    const opened = page.waitForEvent('requestfinished', (r) => /\/api\/providers\?refresh=1$/.test(r.url()));
    await page.goto(`${relay.base}/#/settings/claude`);
    await opened;
    const pill = accountBlock(page, 'claude', 'Default account').locator('.pill');
    await expect(pill).toHaveText('Signed in');
    // Signed out in a terminal (`claude auth logout`): the server is not told, and its cache, a few
    // seconds old, still says signed in. Reopened, Settings looks again (`?refresh=1`) while the app
    // asks as usual and gets that cached answer, held here until Settings' own has landed: coming in
    // last, it must not win.
    writeFileSync(join(relay.home, '.claude', 'e2e-signed-out'), '');
    const looked = page.waitForEvent('requestfinished', (r) => /\/api\/providers\?refresh=1$/.test(r.url()));
    await page.route(/\/api\/providers$/, async (route) => {
      const response = await route.fetch();
      await looked;
      await route.fulfill({ response });
    });
    const cachedLanded = page.waitForEvent('requestfinished', (r) => /\/api\/providers$/.test(r.url()));
    await page.reload();
    await cachedLanded;
    for (let i = 0; i < 20; i++) {
      await expect(pill).toHaveText('Not signed in', { timeout: 5_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
  });

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
    expect(logoutHomes(relay, CLAUDE)).toEqual([]);

    await relay.api(`/api/conversations/${chat}/stop`, { body: {} });
    await settled(relay, chat);
    acceptNextDialog(page);
    await remove.click();
    await expect(work).toHaveCount(0);
    expect(existsSync(home)).toBe(false);
  });
});
