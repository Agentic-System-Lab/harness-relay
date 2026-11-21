import { expect, test } from '@playwright/test';
import { serveSite, SITE_URL } from '../support/share';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => (route.request().url().startsWith(SITE_URL) ? serveSite(route) : route.abort()));
});

test('a phone follows a deep link in the Chinese tools tree and lets the reader operate its branches by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE_URL + 'zh-TW/docs/tools/#microsoft-oauth-setup');
  const toc = page.getByRole('navigation', { name: '本頁內容' });
  const active = toc.locator('a[aria-current="true"]');
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
  await messaging.focus();
  await messaging.press('Space');
  await expect(teams).toBeHidden();
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

test('a non-tools guide reveals the active subsection after a fragment jump or ordinary scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 760 });
  await page.goto(SITE_URL + 'docs/phone/#android');
  const toc = page.getByRole('navigation', { name: 'On this page' });
  const active = toc.locator('a[aria-current="true"]');
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
