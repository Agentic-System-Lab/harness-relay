import { expect, test } from '../fixtures';
import { finishedReply } from '../support/app';

test.describe('in Traditional Chinese', () => {
  test.use({ lang: 'zh-TW' });

  test('the app, its templates and the lead agent’s card are in Chinese; the agents get English prompts', async ({ page, relay }) => {
    await expect(page.getByRole('heading', { name: '新對話' })).toBeVisible();
    await expect(page.locator('.preset-card', { hasText: '三方辯論' })).toBeVisible();

    await page.getByRole('button', { name: '開始對話 →' }).click();
    await page.waitForURL(/#\/c\//);
    const box = page.locator('.composer-row textarea');
    await expect(box).toHaveAttribute('placeholder', '提出你的問題，首席 agent 會先為它組隊…');
    await box.fill('這個專案在做什麼？');
    await box.press('Enter');
    const plan = page.locator('.plan-card.awaiting');
    await expect(plan).toContainText('自訂團隊「E2E team」');
    await plan.getByRole('button', { name: '確認團隊' }).click();
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “這個專案在做什麼？”.');

    // The prompts stay in English whatever the UI language (AGENTS.md, "Prompts and languages").
    const prompts = relay.fakeLog().filter((e) => e.prompt);
    expect(prompts.some((e) => e.prompt!.includes("Roundtable: it's your turn, @Claude."))).toBe(true);
  });
});

test.describe('signing in, in Chinese', () => {
  test.use({ lang: 'zh-TW', signIn: false });

  test("the sign-in page and the server's own messages follow the language", async ({ page, relay }) => {
    await page.goto(relay.base);
    await expect(page.getByRole('heading', { name: '登入 Harness Relay' })).toBeVisible();
    await page.getByLabel('登入代碼').fill('AAAA-BBBB');
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('代碼錯誤或已過期。');
  });
});
