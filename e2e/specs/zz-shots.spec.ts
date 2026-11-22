import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { finishedReply, send, settled } from '../support/app';
import { chatWith, cli } from '../support/clis';

// Throwaway: screenshots for the pull request (not committed).
const OUT =
  '/private/tmp/claude-501/-Users-cyyeh-Desktop-agentic-system-lab-harness-relay/067d837e-c28b-402f-b051-05b95ed0db08/scratchpad/main-session/shots';

for (const lang of ['zh-TW', 'en'] as const) {
  test.describe(lang, () => {
    test.use({ lang });
    test(`secrets and fixed commands (${lang})`, async ({ page, relay }) => {
      const claude = cli('claude');
      const id = await chatWith(page, relay, claude);
      await send(
        page,
        lang === 'en' ? 'Set up posting to Threads e2e:secret e2e:command' : '幫我設定自動發文到 Threads e2e:secret e2e:command',
      );
      await finishedReply(page, claude.name);
      const secret = page.locator('.handoff-card').first();
      await secret.locator('input').first().fill('tok-123456');
      await secret.screenshot({ path: `${OUT}/${lang}-secret-card.png` });
      await secret.locator('button.primary').click();
      await expect(secret.locator('.approval-waiting')).toBeVisible();
      await settled(relay, id);
      await secret.screenshot({ path: `${OUT}/${lang}-secret-saved.png` });
      const command = page.locator('.handoff-card').nth(1);
      await command.scrollIntoViewIfNeeded();
      await command.screenshot({ path: `${OUT}/${lang}-command-proposed.png` });
      await command.locator('button.primary').first().click();
      await expect(command.locator('.handoff-try')).toBeVisible();
      await command.locator('.handoff-try button.primary').click();
      await expect(command.locator('.handoff-run-result.handoff-ok')).toBeVisible({ timeout: 60_000 });
      await command.screenshot({ path: `${OUT}/${lang}-command-tried.png` });
      await page.goto(`${relay.base}/#/settings/handoffs`);
      const card = page.locator('#settings-handoffs');
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: `${OUT}/${lang}-settings.png` });
      // The automation's form, with the fixed command picked.
      await page.goto(`${relay.base}/#/c/${id}`);
      await page
        .locator('.chat-head')
        .getByRole('button', { name: lang === 'en' ? 'Automation' : '自動任務' })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog
        .locator('select')
        .filter({ has: page.locator('option[value=""]') })
        .last()
        .selectOption({ index: 1 });
      const field = dialog
        .locator('.field')
        .filter({ has: page.locator('select') })
        .last();
      await field.scrollIntoViewIfNeeded();
      await field.screenshot({ path: `${OUT}/${lang}-schedule-command.png` });
    });

    test.skip(`secrets card on a phone (${lang})`, async ({ page, relay }) => {
      await page.setViewportSize({ width: 412, height: 915 });
      const claude = cli('claude');
      await chatWith(page, relay, claude);
      await send(page, lang === 'en' ? 'Set up posting e2e:secret' : '設定發文 e2e:secret');
      await finishedReply(page, claude.name);
      await page.locator('.handoff-card').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/${lang}-secret-phone.png` });
    });
  });
}
