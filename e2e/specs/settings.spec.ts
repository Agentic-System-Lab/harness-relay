import { expect, test } from '../fixtures';
import { askAndConfirm, finishedReply, openTeamChat, replies, send, startChat } from '../support/app';

const CLIS = [
  { provider: 'claude', label: 'Claude Code', version: 'v2.1.999' },
  { provider: 'codex', label: 'Codex', version: 'v0.999.0' },
  { provider: 'grok', label: 'Grok', version: 'v1.0.999' },
] as const;

test.describe('a CLI that is not signed in', () => {
  test.use({ serverEnv: { E2E_FAKE_SIGNED_OUT: 'codex' } });

  test('shows as signed out in Settings and the sidebar, and its reply says why', async ({ page, relay }) => {
    await expect(page.locator('.provider-health a[href="#/settings/codex"]')).toHaveAttribute('title', 'Not signed in');
    await expect(page.locator('.provider-health a[href="#/settings/claude"]')).toHaveAttribute('title', 'Signed in: e2e@example.com');
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const card = page.locator('#settings-codex');
    await expect(card).toContainText('Not signed in');
    // Nothing of the CLI's own words after it ("Not logged in").
    await expect(card).not.toContainText('Not logged in');
    await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }]);
    await send(page, 'Anyone there?');
    await expect(replies(page, 'Codex').last().locator('.msg-error')).toContainText('Not logged in');
  });
});

test.describe('settings', () => {
  test('each CLI is found, with its version, and signed in', async ({ page }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await expect(page.getByRole('heading', { name: 'Settings & sign-in', level: 1 })).toBeVisible();
    for (const cli of CLIS) {
      const card = page.locator(`#settings-${cli.provider}`);
      await expect(card.locator('.provider-head')).toContainText(cli.label);
      await expect(card.locator('.provider-head')).toContainText(cli.version);
      await expect(card).toContainText('Signed in');
    }
    await expect(page.locator('#settings-claude')).toContainText('e2e@example.com');
    // The sidebar's health dots say the same.
    await expect(page.locator('.provider-health .health')).toHaveCount(3);
    await expect(page.locator('.provider-health .health.ok')).toHaveCount(3);
  });

  test("a CLI's executable path can be set, and a wrong one shows it as missing", async ({ page }) => {
    await page.goto(page.url().replace(/#.*$/, '#/settings/grok'));
    const card = page.locator('#settings-grok');
    // Loaded first: the box shows the saved path once the settings come.
    await expect(card.locator('.provider-head')).toContainText('v1.0.999');
    await card.locator('summary', { hasText: 'Executable' }).click();
    const bin = card.getByRole('textbox', { name: 'Executable' });
    await bin.fill('/no/such/grok');
    await bin.press('Enter');
    await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
    await expect(card).toContainText('/no/such/grok');

    await bin.fill('');
    await bin.press('Enter');
    await expect(card.locator('.provider-head')).toContainText('v1.0.999');
  });

  test('the language can be switched, and the choice is kept', async ({ page }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const languages = page.locator('#settings-language');
    await languages.getByRole('radio', { name: '繁體中文' }).click();
    await expect(page.getByRole('heading', { name: '設定與登入', level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '設定與登入', level: 1 })).toBeVisible();
    await languages.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Settings & sign-in', level: 1 })).toBeVisible();
  });

  test('another CLI can be the lead agent', async ({ page, relay }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const lead = page.locator('#settings-lead');
    await lead.getByRole('radio', { name: 'Codex' }).click();
    await lead.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(lead).toContainText('Lead agent saved');
    await page.getByRole('button', { name: 'New chat' }).first().click();
    await expect(page.getByText(/the lead agent \(Codex\)/).first()).toBeVisible();

    await startChat(page);
    await askAndConfirm(page, 'Who picks the team? e2e:team=grok');
    await expect(page.locator('.plan-card').last()).toContainText('Lead agent: Codex');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Who picks the team?”.');
    // The lead agent's prompt went to the fake codex.
    expect(relay.fakeLog().some((e) => e.cli === 'codex' && e.prompt?.includes('Choose the team that answers it'))).toBe(true);
  });
});
