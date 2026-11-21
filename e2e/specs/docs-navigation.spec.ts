import { expect, test, type Page } from '@playwright/test';
import { serveSite, SITE_URL } from '../support/share';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => (route.request().url().startsWith(SITE_URL) ? serveSite(route) : route.abort()));
});

/** The page picker starts at the toolbar and owns the entire strip that otherwise opens this article's contents. */
async function checkPagesOverlay(page: Page) {
  const toggle = page.locator('.doc-toc-toggle');
  const pages = page.locator('[data-doc-nav-toggle]');
  const top = page.locator('[data-doc-nav]');
  const panel = page.locator('.doc-nav-list');
  const strip = await toggle.evaluate((el) => {
    const r = el.closest('nav')!.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, height: r.height };
  });
  await pages.press('Enter');
  await expect(pages).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeHidden();
  expect(await panel.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(
    await top.evaluate((el) => el.getBoundingClientRect().bottom),
    0,
  );
  expect(
    await page.evaluate(({ left, right, top, height }) => {
      const y = top + height / 2;
      return [left + 2, (left + right) / 2, right - 2].every((x) => document.elementFromPoint(x, y)?.closest('.doc-nav-list'));
    }, strip),
  ).toBe(true);
  await pages.press('Tab');
  await expect(panel.locator('a').first()).toBeFocused();
  await toggle.evaluate((el) => el.focus());
  await expect(panel.locator('a').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pages).toBeFocused();
  await expect(panel).toBeHidden();
  await expect(toggle).toBeVisible();
  expect(
    await page.evaluate(
      ({ left, right, top, height }) =>
        Boolean(document.elementFromPoint((left + right) / 2, top + height / 2)?.closest('.doc-toc-toggle')),
      strip,
    ),
  ).toBe(true);
}

test('a phone follows a deep link in the Chinese tools tree and lets the reader operate its branches by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE_URL + 'zh-TW/docs/tools/#microsoft-oauth-setup');
  const toc = page.getByRole('navigation', { name: '本頁內容' });
  const toggle = toc.getByRole('button', { name: '本頁內容' });
  const active = toc.locator('a[aria-current="true"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(active).toBeHidden();
  await checkPagesOverlay(page);
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(active).toHaveAttribute('href', '#microsoft-oauth-setup');
  await expect(toc.locator('details[open] > summary')).toHaveText(['常用 App', '帳號登入設定（OAuth 2.0）']);
  const messaging = toc.getByText('團隊通訊', { exact: true });
  await messaging.focus();
  await messaging.press('Enter');
  const teams = toc.locator('a[href="#microsoft-teams"]');
  await expect(teams).toBeVisible();
  await messaging.press('Tab');
  await expect(teams).toBeFocused();
  await teams.press('Enter');
  await expect(page).toHaveURL(/#microsoft-teams$/);
  await expect(active).toHaveAttribute('href', '#microsoft-teams');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#microsoft-teams')).toBeFocused();
  const barBottom = await toggle.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(await page.locator('#microsoft-teams').evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(barBottom);
  await toggle.press('Space');
  await messaging.focus();
  await messaging.press('Space');
  await expect(teams).toBeHidden();
  await toggle.press('Escape');
  await expect(toggle).toBeFocused();
  await page.goBack();
  await expect(active).toHaveAttribute('href', '#microsoft-oauth-setup');
  // Closing the reading branch and revealing a differently sized one must not move the text on a phone.
  const heading = page.locator('h2#default-team-checks-title');
  const top = await heading.evaluate((element) => {
    element.scrollIntoView({ block: 'start', behavior: 'instant' });
    return element.getBoundingClientRect().top;
  });
  await expect(active).toHaveAttribute('href', '#default-team-checks');
  await expect(toc.locator('details[open] > summary')).toHaveText(['工具庫']);
  expect(Math.abs((await heading.evaluate((element) => element.getBoundingClientRect().top)) - top)).toBeLessThanOrEqual(1);
});

test('a tablet keeps a single contents row below search, scrolls its list, and switches cleanly to desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto(SITE_URL + 'docs/tools/#mail');
  const toc = page.getByRole('navigation', { name: 'On this page' });
  const toggle = toc.getByRole('button', { name: 'On this page' });
  const list = toc.locator(':scope > ol');
  const nav = page.locator('[data-doc-nav]');
  const pages = nav.getByRole('button', { name: 'Docs Tools' });
  const search = nav.getByRole('searchbox');
  const box = async (loc: typeof toggle) =>
    loc.evaluate((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
  await expect(toggle).toBeVisible();
  expect((await box(toggle)).top).toBeCloseTo((await box(nav)).bottom, 0);
  await expect(list).toBeHidden();
  await toggle.press('Space');
  await toc.getByText('Tool library', { exact: true }).click();
  await toc.getByText('Related topics', { exact: true }).click();
  const pageScroll = await page.evaluate(() => window.scrollY);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
  expect((await box(list)).bottom).toBeLessThanOrEqual(600);
  await checkPagesOverlay(page);
  await pages.click();
  await expect(list).toBeHidden();
  await expect(pages).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.doc-toc-toggle')).toBeHidden();
  await search.fill('calendar');
  const results = page.locator('[data-doc-search-panel]');
  await expect(results.getByRole('option').first()).toBeVisible();
  await expect(nav.locator('[data-doc-nav-toggle]')).toHaveAttribute('aria-expanded', 'false');
  expect((await box(results)).top).toBeGreaterThanOrEqual((await box(toggle)).bottom);
  await toggle.press('Enter');
  await expect(results).toBeHidden();
  await expect(list).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(toggle).toBeHidden();
  await expect(list).toBeVisible();
  expect(await toc.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(toggle).toBeFocused();
  await expect(list).toBeHidden();
  // The tablet row also works for a page without nested sections.
  await page.goto(SITE_URL + 'docs/troubleshooting/');
  await expect(toggle).toBeVisible();
  await expect(list).toBeHidden();
});

test('only focus on a disappearing contents control moves when tablet styles take effect before the resize callback', async ({ page }) => {
  await page.addInitScript(() => {
    // Hold the site's breakpoint callbacks so Chromium can apply the real media styles and run a paint first.
    const listen = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, callback, options) {
      if (!(this instanceof MediaQueryList) || !this.media.includes('1180px') || type !== 'change' || !callback) {
        return listen.call(this, type, callback, options);
      }
      listen.call(
        this,
        type,
        (event) => {
          document.documentElement.dataset.pendingDocsLayout = 'true';
          document.addEventListener(
            'release-docs-layout',
            () => {
              if (typeof callback === 'function') callback.call(this, event);
              else callback.handleEvent(event);
            },
            { once: true },
          );
        },
        options,
      );
    };
  });
  const resize = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('html')).toHaveAttribute('data-pending-docs-layout', 'true');
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      delete document.documentElement.dataset.pendingDocsLayout;
      document.dispatchEvent(new Event('release-docs-layout'));
    });
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SITE_URL + 'docs/tools/#mail');
  const list = page.locator('.doc-toc > ol');
  const toggle = page.locator('.doc-toc-toggle');
  const chosen = list.locator('a[aria-current="true"]');
  await chosen.focus();
  await expect(chosen).toBeFocused();
  await resize(768);
  await expect(toggle).toBeFocused();
  await expect(list).toBeHidden();
  await resize(1440);
  await expect(list.locator('summary, a').first()).toBeFocused();

  const search = page.getByRole('searchbox');
  await search.focus();
  await resize(768);
  await expect(search).toBeFocused();
  await resize(1440);
  const articleLink = page.locator('.doc-body a[href]').first();
  await articleLink.focus();
  await resize(768);
  await expect(articleLink).toBeFocused();
  await resize(1440);
  const branch = list.locator(':scope > li > details > summary').first();
  await branch.focus();
  await expect(branch).toBeFocused();
  await branch.evaluate((el) => el.blur());
  await resize(768);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('a non-tools guide reveals the active subsection after a fragment jump or ordinary scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.goto(SITE_URL + 'docs/phone/#android');
  const toc = page.getByRole('navigation', { name: 'On this page' });
  const active = toc.locator('a[aria-current="true"]');
  await expect(toc.locator('.doc-toc-toggle')).toBeHidden();
  await expect(active).toHaveAttribute('href', '#android');
  await expect(active).toBeVisible();
  await page.locator('h3#keep-running-from-source').evaluate((heading) => heading.scrollIntoView());
  await expect(active).toHaveAttribute('href', '#keep-running-from-source');
  await expect(active).toBeVisible();
});

test('scrolling closes only automatic branches and preserves manual choices and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SITE_URL + 'docs/tools/#google-oauth-setup');
  const toc = page.getByRole('navigation', { name: 'On this page' });
  const branch = (title: string) => toc.locator('details').filter({ has: page.locator(':scope > summary', { hasText: title }) });
  const common = branch('Common apps');
  const oauth = branch('Account sign-in settings');
  const notes = branch('Documents and notes');
  const mail = branch('Mail and calendar');
  const library = branch('Tool library');
  const active = toc.locator('a[aria-current="true"]');
  await expect(oauth).toHaveJSProperty('open', true);
  await notes.locator(':scope > summary').hover();
  await expect(notes).toHaveJSProperty('open', false);
  await notes.locator(':scope > summary').click();
  await page.locator('#mail-title').evaluate((el) => el.scrollIntoView());
  await expect(active).toHaveAttribute('href', '#mail');
  await expect(oauth).toHaveJSProperty('open', false);
  await expect(notes).toHaveJSProperty('open', true);
  await mail.locator('a[href="#mail"]').focus();
  await page.locator('#skills-title').evaluate((el) => el.scrollIntoView());
  await expect(active).toHaveAttribute('href', '#skills');
  await expect(mail.locator('a[href="#mail"]')).toBeFocused();
  await expect(mail).toHaveJSProperty('open', true);
  await library.locator(':scope > summary').focus();
  await expect(mail).toHaveJSProperty('open', false);
  await expect(notes).toHaveJSProperty('open', true);
  await expect(common).toHaveJSProperty('open', true);
  await notes.locator(':scope > summary').click();
  await library.locator(':scope > summary').focus();
  await expect(notes).toHaveJSProperty('open', false);
  await expect(common).toHaveJSProperty('open', false);
});

test.describe('on a large landscape touch tablet', () => {
  test.use({ hasTouch: true, viewport: { width: 1366, height: 1024 } });

  test('uses the compact contents and search rows even at desktop width', async ({ page }) => {
    await page.goto(SITE_URL + 'docs/phone/#android');
    const toc = page.getByRole('navigation', { name: 'On this page' });
    const toggle = toc.getByRole('button', { name: 'On this page' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await checkPagesOverlay(page);
    const position = await page.locator('#android').evaluate((el) => el.getBoundingClientRect().top);
    await toggle.tap();
    await expect(toc.locator('a[aria-current="true"]')).toHaveAttribute('href', '#android');
    expect(await page.locator('#android').evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(position, 0);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('native disclosure and ordinary links reach an account guide', async ({ page }) => {
    await page.goto(SITE_URL + 'docs/tools/');
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await expect(toc.locator(':scope > ol > li > details > summary')).toHaveText(['Common apps', 'Tool library', 'Related topics']);
    await toc.getByText('Common apps', { exact: true }).press('Enter');
    await toc.getByText('Account sign-in settings (OAuth 2.0)', { exact: true }).press('Space');
    const google = toc.getByRole('link', { name: 'Set up Google OAuth 2.0', exact: true });
    await expect(google).toBeVisible();
    await google.click();
    await expect(page).toHaveURL(/#google-oauth-setup$/);
    await expect(page.getByRole('heading', { name: 'Set up Google OAuth 2.0' })).toBeInViewport();
  });
});
