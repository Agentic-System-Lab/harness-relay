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

  test('a language chosen whose words cannot be loaded: the page reloads once for them, then says so and stays as it was', async ({
    page,
  }) => {
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

test.describe("the desktop app's menus", () => {
  /** What the page tells the desktop app of its language (`PUT /api/desktop/lang`), and the server's answers. */
  const toldLanguages = (page: Page) => {
    const told: { lang: unknown; status: number }[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/desktop/lang') {
        told.push({ lang: (r.request().postDataJSON() as { lang?: unknown }).lang, status: r.status() });
      }
    });
    return told;
  };
  const languages = (page: Page, name: string) => page.getByRole('radiogroup', { name, exact: true });

  test.describe("in the app's own window", () => {
    // Electron names itself in the user agent, as in the app's window (src/web/update.ts, isAppWindow).
    // Signed in here, so that the page's first load is the one heard.
    test.use({
      signIn: false,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HarnessRelay/2026.11.17 Chrome/142.0.0.0 Electron/39.2.0 Safari/537.36',
    });

    test('the page tells the app the language it shows, as it opens and at each pick', async ({ page, relay }) => {
      const told = toldLanguages(page);
      await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
      await expect(homePage(page)).toBeVisible();
      await expect.poll(() => told).toEqual([{ lang: 'en', status: 200 }]);

      await page.evaluate(() => (location.hash = '#/settings'));
      await languages(page, 'Language').getByRole('radio', { name: '繁體中文' }).click();
      await expect(page.getByRole('heading', { name: '設定與登入' })).toBeVisible();
      await expect
        .poll(() => told)
        .toEqual([
          { lang: 'en', status: 200 },
          { lang: 'zh-TW', status: 200 },
        ]);
      await languages(page, '介面語言').getByRole('radio', { name: 'English' }).click();
      await expect.poll(() => told.map((t) => t.lang)).toEqual(['en', 'zh-TW', 'en']);
    });
  });

  test('another browser, such as a phone’s, never tells the app', async ({ page }) => {
    // Requests as they are sent, not their answers: one still on its way counts too.
    const told: unknown[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/desktop/lang') told.push(r.postDataJSON());
    });
    await page.reload();
    await expect(homePage(page)).toBeVisible();
    await page.evaluate(() => (location.hash = '#/settings'));
    await languages(page, 'Language').getByRole('radio', { name: '繁體中文' }).click();
    await expect(page.getByRole('heading', { name: '設定與登入' })).toBeVisible();
    // The page's next poll for the conversations (every 3 s) is sent after the pick's effect ran: a
    // request telling the app would have been sent before it.
    await page.waitForRequest((r) => new URL(r.url()).pathname === '/api/conversations');
    expect(told).toEqual([]);
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
