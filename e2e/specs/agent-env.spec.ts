import type { SettingsView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, openNewChat, openTeamChat, replies, send } from '../support/app';
import { withClis } from '../support/clis';

// Codex and Grok besides Claude Code, the one CLI a test server has by default: tests here use them.
withClis('codex', 'grok');

/*
 * Another model provider's key in the environment Harness Relay was started with reaches only that
 * provider's own CLI (src/server/agentEnv.ts): New chat says so once, a CLI's card in Settings names
 * the keys it is not given, and one passed on there reaches that CLI's runs, and no other's.
 */

test.describe("other providers' keys in the server's environment", () => {
  // Nobody's own: withheld from every CLI with a sign-in. Without the Gemini API key a test server gives
  // Antigravity (`DEFAULT_KEY`), which is not installed here and would be another key the others lose.
  test.use({ serverEnv: { HF_TOKEN: 'hf-e2e-value', MISTRAL_API_KEY: 'mistral-e2e-value', GEMINI_API_KEY: '' } });

  test.describe('the notice', () => {
    test.use({ envNotice: true });

    test('New chat says once which keys each installed CLI is not given, names only, and leads to its card', async ({ page }) => {
      await openNewChat(page);
      const dialog = page.getByRole('dialog', { name: 'Each CLI gets only its own keys' });
      await expect(dialog).toBeVisible();
      // The three CLIs installed here, each with both keys; none that is not installed.
      for (const cli of ['Claude Code', 'Codex', 'Grok']) await expect(dialog).toContainText(`${cli}: MISTRAL_API_KEY, HF_TOKEN`);
      await expect(dialog).not.toContainText('Cursor');
      await expect(dialog).not.toContainText('e2e-value');
      await dialog.getByRole('link', { name: 'Open Settings' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('#settings-claude details.agent-env summary')).toHaveText('Environment variables (2 keys not given)');
      // Seen: not again, after a reload either.
      await openNewChat(page);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });

  test("a key passed on from a CLI's card reaches that CLI's runs, and no other's", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [
      { name: 'Ada', provider: 'claude' },
      { name: 'Gus', provider: 'grok' },
    ]);
    await send(page, 'Which keys? e2e:env=HF_TOKEN,MISTRAL_API_KEY');
    await expect(await finishedReply(page, 'Ada')).toContainText('My environment: HF_TOKEN is not set, MISTRAL_API_KEY is not set.');
    await expect(await finishedReply(page, 'Gus')).toContainText('My environment: HF_TOKEN is not set, MISTRAL_API_KEY is not set.');

    await page.goto(`${relay.base}/#/settings/claude`);
    const env = page.locator('#settings-claude details.agent-env');
    await env.locator('summary').click();
    await expect(env).toContainText('Set, but not given to it:');
    await expect(env).not.toContainText('e2e-value');
    await env.getByRole('button', { name: 'Pass HF_TOKEN on to it' }).click();
    await expect(env.getByRole('button', { name: 'Stop passing HF_TOKEN on' })).toBeVisible();
    await expect(env.locator('summary')).toHaveText('Environment variables (1 key not given)');
    // A name that is not one is refused in the page, before it is sent; one typed is added, and × takes it off.
    const box = env.getByRole('textbox', { name: 'Name of a variable to pass on' });
    await box.fill('NOT-A-NAME');
    await env.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(env.getByRole('alert')).toContainText("A variable's name has letters, digits and underscores only");
    await box.fill(' MISTRAL_API_KEY ');
    await box.press('Enter');
    await expect(env.getByRole('button', { name: 'Stop passing MISTRAL_API_KEY on' })).toBeVisible();
    await expect(box).toHaveValue('');
    await expect(env.locator('summary')).toHaveText('Environment variables');
    await env.getByRole('button', { name: 'Stop passing MISTRAL_API_KEY on' }).click();
    await expect(env.getByRole('button', { name: 'Pass MISTRAL_API_KEY on to it' })).toBeVisible();
    await expect(env.locator('summary')).toHaveText('Environment variables (1 key not given)');
    const saved = await relay.api<SettingsView>('/api/settings');
    expect(saved.providers.find((p) => p.provider === 'claude')!.environment).toMatchObject({
      pass: ['HF_TOKEN'],
      withheld: ['MISTRAL_API_KEY'],
    });
    expect(saved.providers.find((p) => p.provider === 'grok')!.environment!.pass).toEqual([]);

    await page.goto(`${relay.base}/#/c/${id}`);
    await send(page, 'And now? e2e:env=HF_TOKEN,MISTRAL_API_KEY');
    await expect(replies(page, 'Gus')).toHaveCount(2, { timeout: 45_000 });
    await expect(await finishedReply(page, 'Ada')).toContainText('My environment: HF_TOKEN is set, MISTRAL_API_KEY is not set.');
    await expect(await finishedReply(page, 'Gus')).toContainText('My environment: HF_TOKEN is not set, MISTRAL_API_KEY is not set.');
  });
});
