import { expect, test } from '../fixtures';
import { askAndConfirm, finishedReply, startChat } from '../support/app';

const CLIS = [
  { provider: 'claude', label: 'Claude Code', version: 'v2.1.999' },
  { provider: 'codex', label: 'Codex', version: 'v0.999.0' },
  { provider: 'grok', label: 'Grok', version: 'v1.0.999' },
] as const;

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
    const settings = await relay.api<{ lead: Record<string, unknown> }>('/api/settings');
    await relay.api('/api/settings', { method: 'PUT', body: { lead: { ...settings.lead, provider: 'codex' } } });
    await page.reload();
    await expect(page.getByText(/the lead agent \(Codex\)/).first()).toBeVisible();

    await startChat(page);
    await askAndConfirm(page, 'Who picks the team? e2e:team=grok');
    await expect(page.locator('.plan-card').last()).toContainText('Lead agent: Codex');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Who picks the team?”.');
    // The lead agent's prompt went to the fake codex.
    expect(relay.fakeLog().some((e) => e.cli === 'codex' && e.prompt?.includes('Choose the team that answers it'))).toBe(true);
  });
});
