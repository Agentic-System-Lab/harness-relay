import { expect, test } from '../fixtures';
import { acceptNextDialog } from '../support/app';
import { DEV_WEB_DIR } from '../support/paths';

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
      await expect(other.getByRole('alert')).toHaveText('That code is wrong or has expired.');
    } finally {
      await other.close();
    }
  });

  test('a link opened in a tab that shows the sign-in page already signs it in', async ({ page, relay }) => {
    await page.goto(relay.base);
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
    // Only the fragment changes: the page does not load again.
    const code = await relay.newSignInCode();
    await page.evaluate((c) => (window.location.hash = `#code=${c}`), code);
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    expect(page.url()).not.toContain(code);
  });

  test("a link's error does not come back after signing in with a code and being signed out", async ({ page, relay }) => {
    await page.goto(`${relay.base}/#code=AAAA-BBBB`);
    await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired.');
    await page.getByLabel('Sign-in code').fill(await relay.newSignInCode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();

    // The server no longer knows this browser (its session gone): the page finds out on its next
    // request, without loading again, and shows the sign-in page without the old link's error.
    await page.context().clearCookies();
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a sign-in link opened in a tab signed in already keeps it signed in, with requests still on their way', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    const keyNow = () => page.evaluate(() => localStorage.getItem('relay:key'));
    const oldKey = await keyNow();

    // Requests the page sends with its key are held until the new link has signed it in again, which
    // ends the session they were sent for: they are answered "signed out", after the new key came.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const held = new Set<string>();
    const resent = new Set<string>();
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const key = req.headers()['x-relay-key'];
      if (path !== '/api/auth/login' && key === oldKey) {
        held.add(path);
        await released;
      } else if (held.has(path)) resent.add(path);
      await route.continue();
    });
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await expect.poll(() => held.size).toBeGreaterThan(0);

    await page.evaluate((c) => (window.location.hash = `#code=${c}`), await relay.newSignInCode());
    await expect.poll(keyNow).not.toBe(oldKey);
    const newKey = await keyNow();
    release();
    // Each held request is sent again with the new key, and the tab stays signed in.
    await expect.poll(() => [...held].every((p) => resent.has(p))).toBe(true);
    expect(await keyNow()).toBe(newKey);
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toHaveCount(0);
    await page.unroute('**/api/**');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
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

test.describe('signing in, in a development build of the UI', () => {
  // React's development build runs each effect twice (StrictMode), as under `npm run dev`.
  test.use({ signIn: false, serverEnv: { RELAY_WEB_DIR: DEV_WEB_DIR } });

  test('a sign-in link opens the app on the first load, asking whether the browser is signed in once', async ({ page, relay }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/auth') asked.push(r.method());
    });
    const code = await relay.newSignInCode();
    await page.goto(`${relay.base}/#code=${code}`);
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    expect(page.url()).not.toContain(code);
    expect(asked).toEqual(['GET']);
  });

  test('a link that does not work shows its error on the first load', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#code=AAAA-BBBB`);
    await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired.');
  });
});
