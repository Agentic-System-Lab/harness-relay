import { expect, test } from '../fixtures';
import { acceptNextDialog } from '../support/app';

test.describe('signing in', () => {
  test.use({ signIn: false });

  test('a browser that is not signed in gets the sign-in page, and a code signs it in', async ({ page, relay }) => {
    await page.goto(relay.base);
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
    // Nothing of the app, nor of its API, without signing in.
    expect((await page.request.get(`${relay.base}/api/conversations`)).status()).toBe(401);

    const code = page.getByLabel('Sign-in code');
    await code.fill('AAAA-BBBB');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired.');

    await code.fill(await relay.newSignInCode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(page.locator('[data-signin]')).toHaveCount(0);

    // The session outlives a reload.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
  });

  test('a sign-in link signs in once; the code cannot be used again', async ({ page, browser, relay }) => {
    const code = await relay.newSignInCode();
    await page.goto(`${relay.base}/#code=${code}`);
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    // The code is gone from the address bar.
    expect(page.url()).not.toContain(code);

    const other = await browser.newPage();
    try {
      await other.goto(`${relay.base}/#code=${code}`);
      await expect(other.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test('a browser can sign itself out in Settings', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const card = page.locator('#settings-browsers');
    await expect(card).toContainText('this browser');
    acceptNextDialog(page);
    await card.locator('li, .browser-row', { hasText: 'this browser' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
  });
});
