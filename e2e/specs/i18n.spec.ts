import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { countPages, finishedReply, homePage } from '../support/app';

test.describe('in Traditional Chinese', () => {
  test.use({ lang: 'zh-TW' });

  test('the app, its templates and the lead agent’s card are in Chinese; the agents get English prompts', async ({ page, relay }) => {
    await expect(page.getByRole('heading', { name: '讓你的 agent 團隊從此為你幹活' })).toBeVisible();
    await page.getByRole('button', { name: '新對話' }).first().click();
    await expect(page.getByRole('heading', { name: '新對話' })).toBeVisible();
    await expect(page.locator('.preset-card', { hasText: '三方辯論' })).toBeVisible();
    // Lead review, ticked in every new chat, is not what this test is about.
    await page.getByRole('checkbox', { name: '團隊回答後，請首席 agent 審閱回覆' }).uncheck();

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

test.describe("the page's words", () => {
  /** The languages whose words the page has fetched, in order (`src/web/locales/*.ts`, one file each). */
  const fetchedLanguages = (page: Page) => {
    const fetched: string[] = [];
    page.on('request', (r) => {
      const lang = /\/assets\/(en|zh-TW)-[^/]*\.js$/.exec(new URL(r.url()).pathname)?.[1];
      if (lang) fetched.push(lang);
    });
    return fetched;
  };
  const languages = (page: Page, name: string) => page.getByRole('radiogroup', { name, exact: true });
  const openSettings = (page: Page) => page.evaluate(() => (location.hash = '#/settings'));

  test("only the language shown is fetched, with the page's own files; the other once it is chosen", async ({ page }) => {
    const fetched = fetchedLanguages(page);
    await page.reload();
    await expect(homePage(page)).toBeVisible();
    // Asked for by the page's head (vite.config.ts, languagePreload), not only once its script runs.
    await expect(page.locator('head link[rel="modulepreload"][href*="/assets/en-"]')).toHaveCount(1);
    await expect(page.locator('head link[rel="modulepreload"][href*="/assets/zh-TW-"]')).toHaveCount(0);
    expect(fetched).toEqual(['en']);

    await openSettings(page);
    await languages(page, 'Language').getByRole('radio', { name: '繁體中文' }).click();
    await expect(page.getByRole('heading', { name: '設定與登入' })).toBeVisible();
    expect(fetched).toEqual(['en', 'zh-TW']);
    await page.reload();
    await expect(page.getByRole('heading', { name: '設定與登入' })).toBeVisible();
    await expect(page.locator('head link[rel="modulepreload"][href*="/assets/zh-TW-"]')).toHaveCount(1);
    expect(fetched).toEqual(['en', 'zh-TW', 'zh-TW']);
  });

  test('a language chosen whose words cannot be loaded: the page reloads once for them, then says so and stays as it was', async ({ page }) => {
    await page.route('**/assets/zh-TW-*.js', (route) => route.fulfill({ status: 404, body: '' }));
    await openSettings(page);
    const pages = await countPages(page);
    const chinese = languages(page, 'Language').getByRole('radio', { name: '繁體中文' });
    await chinese.click();
    await expect.poll(pages).toBe(1);
    // Missing again so soon after: no reload this time.
    await chinese.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load 繁體中文. Reload the page to try again.' })).toBeVisible();
    await expect(languages(page, 'Language').getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
    expect(await pages()).toBe(1);

    await page.unroute('**/assets/zh-TW-*.js');
    await page.reload();
    await chinese.click();
    await expect(languages(page, '介面語言').getByRole('radio', { name: '繁體中文' })).toHaveAttribute('aria-checked', 'true');
  });

});

test.describe("the page's own words, missing from its first load", () => {
  // The tab's first page: one that had them before could take them from its memory cache, which
  // Playwright's WebKit does not route, and get them after all.
  test.use({ signIn: false });

  test('a page whose own words cannot be loaded reloads once for them, then says so in both languages', async ({ page, relay }) => {
    await page.route('**/assets/en-*.js', (route) => route.fulfill({ status: 404, body: '' }));
    const pages = await countPages(page);
    await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
    const note = page.getByRole('alert');
    await expect(note).toHaveText(/Harness Relay 無法載入這個頁面。Harness Relay could not load this page\./);
    // The page asked for, then the one it reloaded for its words.
    expect(await pages()).toBe(2);

    // Once they are there, the button brings the page back, signing the browser in with the link's code.
    await page.unroute('**/assets/en-*.js');
    await note.getByRole('button', { name: '重新載入 · Reload' }).click();
    await expect(homePage(page)).toBeVisible();
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
