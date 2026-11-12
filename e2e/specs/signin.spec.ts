import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures';
import { acceptNextDialog, homePage } from '../support/app';
import { DEV_WEB_DIR } from '../support/paths';
import type { RelayServer } from '../support/relay';

/**
 * A sign-in link opened in a tab signed in already (only its fragment changes), with requests the
 * page sent with its key still on their way: the tab stays signed in.
 */
async function linkInSignedInTab(page: Page, relay: RelayServer): Promise<void> {
  await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
  await expect(homePage(page)).toBeVisible();
  const keyNow = () => page.evaluate(() => localStorage.getItem('relay:key'));
  const oldKey = await keyNow();
  // The page's sign-outs: the event the app shows the sign-in page on (SIGNED_OUT_EVENT).
  await page.evaluate(() => {
    const w = window as unknown as { signedOuts: number };
    w.signedOuts = 0;
    window.addEventListener('relay:signed-out', () => w.signedOuts++);
  });

  // Requests the page sends with its key are held until the link's sign-in, which ends the session
  // they were sent for. Their answers ("signed out") then reach the page together with the sign-in's.
  const held: Route[] = [];
  const heldPaths = new Set<string>();
  const heldAnswers: number[] = [];
  const resent = new Set<string>();
  let newKey = '';
  let deliver!: () => void;
  const delivered = new Promise<void>((r) => (deliver = r));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const key = req.headers()['x-relay-key'];
    if (path === '/api/auth/login') {
      const login = await route.fetch();
      newKey = ((await login.json()) as { key: string }).key;
      const answers = await Promise.all(held.map((h) => h.fetch()));
      heldAnswers.push(...answers.map((a) => a.status()));
      await Promise.all([route.fulfill({ response: login }), ...held.map((h, i) => h.fulfill({ response: answers[i] }))]);
      deliver();
    } else if (key === oldKey && !newKey) {
      held.push(route);
      heldPaths.add(path);
      await delivered; // answered above, with the sign-in
    } else {
      if (key === newKey && heldPaths.has(path)) resent.add(path);
      await route.continue();
    }
  });
  await page.getByRole('link', { name: /Settings & sign-in/ }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);

  await page.evaluate((c) => (window.location.hash = `#code=${c}`), await relay.newSignInCode());
  // Each held request, answered "signed out", is sent again with the new key; the page is never
  // signed out, not even for a moment.
  await expect.poll(() => [...heldPaths].every((p) => resent.has(p))).toBe(true);
  expect(heldAnswers.length).toBeGreaterThan(0);
  expect(heldAnswers.every((s) => s === 401)).toBe(true);
  expect(await keyNow()).toBe(newKey);
  expect(await page.evaluate(() => (window as unknown as { signedOuts: number }).signedOuts)).toBe(0);
  await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toHaveCount(0);
  await page.unroute('**/api/**');
  await page.reload();
  await expect(homePage(page)).toBeVisible();
}

/**
 * A sign-in link opened in a new tab (as a terminal opens one) while another tab of the browser has
 * requests on their way: the new tab's sign-in ends the session both used, and the other tab's answers
 * ("signed out") reach it together with the sign-in's. Both tabs end signed in, also after a reload.
 */
async function linkInAnotherTab(page: Page, relay: RelayServer): Promise<void> {
  await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
  await expect(homePage(page)).toBeVisible();
  const keyIn = (p: Page) => p.evaluate(() => localStorage.getItem('relay:key'));
  const oldKey = await keyIn(page);

  const held: Route[] = [];
  let loggedIn = false;
  let deliver!: () => void;
  const delivered = new Promise<void>((r) => (deliver = r));
  await page.route('**/api/**', async (route) => {
    if (route.request().headers()['x-relay-key'] === oldKey && !loggedIn) {
      held.push(route);
      await delivered; // answered below, with the other tab's sign-in
    } else await route.continue();
  });
  await page.getByRole('link', { name: /Settings & sign-in/ }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);

  const other = await page.context().newPage();
  try {
    await other.route('**/api/auth/login', async (route) => {
      const login = await route.fetch();
      loggedIn = true;
      const answers = await Promise.all(held.map((h) => h.fetch()));
      await Promise.all([route.fulfill({ response: login }), ...held.map((h, i) => h.fulfill({ response: answers[i] }))]);
      deliver();
    });
    await other.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
    await expect(homePage(other)).toBeVisible();
    const newKey = await keyIn(other);
    expect(newKey).not.toBeNull();
    expect(newKey).not.toBe(oldKey);
    // The first tab may show the sign-in page a moment (its answers came before the new key did),
    // and comes back on its own: it follows the other tab's sign-in.
    await expect(page.locator('.app main.main')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toHaveCount(0);
    await expect.poll(() => keyIn(page)).toBe(newKey);

    await page.unroute('**/api/**');
    for (const tab of [page, other]) {
      await tab.reload();
      await expect(tab.locator('.app main.main')).toBeVisible();
    }
  } finally {
    await other.close();
  }
}

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
    await expect(homePage(page)).toBeVisible();
    await expect(page.locator('[data-signin]')).toHaveCount(0);

    // The session outlives a reload.
    await page.reload();
    await expect(homePage(page)).toBeVisible();
  });

  test('a sign-in link signs in once; the code cannot be used again', async ({ page, browser, relay }) => {
    const code = await relay.newSignInCode();
    await page.goto(`${relay.base}/#code=${code}`);
    await expect(homePage(page)).toBeVisible();
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
    await expect(homePage(page)).toBeVisible();
    expect(page.url()).not.toContain(code);
  });

  test("a link's error does not come back after signing in with a code and being signed out", async ({ page, relay }) => {
    await page.goto(`${relay.base}/#code=AAAA-BBBB`);
    await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired.');
    await page.getByLabel('Sign-in code').fill(await relay.newSignInCode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(homePage(page)).toBeVisible();

    // The server no longer knows this browser (its session gone): the page finds out on its next
    // request, without loading again, and shows the sign-in page without the old link's error.
    await page.context().clearCookies();
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a sign-in link opened in a tab signed in already keeps it signed in, with requests still on their way', ({ page, relay }) =>
    linkInSignedInTab(page, relay));

  test('a tab that shows the sign-in page follows a sign-in in another tab of the browser', async ({ page, relay }) => {
    await page.goto(relay.base);
    await expect(page.getByRole('heading', { name: 'Sign in to Harness Relay' })).toBeVisible();
    const other = await page.context().newPage();
    try {
      await other.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
      await expect(homePage(other)).toBeVisible();
      // Without a reload: the tabs share the cookie and the key.
      await expect(homePage(page)).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test('a sign-in link opened in another tab keeps every tab signed in, with requests still on their way', ({ page, relay }) =>
    linkInAnotherTab(page, relay));

  test('a tab still on its first check follows a sign-in in another tab of the browser', async ({ page, relay }) => {
    // The tab's first question to the server gets its answer ("not signed in") only after another
    // tab signed the browser in: out of date by then.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let first = true;
    let answered = 0;
    page.on('requestfinished', (r) => {
      if (new URL(r.url()).pathname === '/api/auth') answered++;
    });
    await page.route('**/api/auth', async (route) => {
      if (!first) return route.continue();
      first = false;
      const res = await route.fetch();
      await released;
      await route.fulfill({ response: res });
    });
    await page.goto(relay.base);
    const other = await page.context().newPage();
    try {
      await other.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
      await expect(homePage(other)).toBeVisible();
      // The tab asked the server about the other tab's new key, while its first check still ran.
      await expect.poll(() => answered).toBe(1);
      release();
      await expect(homePage(page)).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test('a sign-in that gets no answer is given up after 30 seconds, with a message', async ({ page, relay }) => {
    await page.clock.install();
    await page.route('**/api/auth/login', () => new Promise<void>(() => {})); // never answered
    await page.goto(relay.base);
    await page.getByLabel('Sign-in code').fill('ABCD-EFGH');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Signing in…' })).toBeVisible();
    await page.clock.runFor(29_000);
    await expect(page.getByRole('button', { name: 'Signing in…' })).toBeVisible();
    await page.clock.runFor(1_000); // SIGN_IN_TIMEOUT_MS in src/web/api.ts
    await expect(page.getByRole('alert')).toHaveText('Harness Relay did not answer. Check that it is still running, then try again.');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
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
    await expect(homePage(page)).toBeVisible();
    expect(page.url()).not.toContain(code);
    expect(asked).toEqual(['GET']);
  });

  test('a sign-in link opened in a tab signed in already keeps it signed in, with requests still on their way', ({ page, relay }) =>
    linkInSignedInTab(page, relay));

  test('a sign-in link opened in another tab keeps every tab signed in, with requests still on their way', ({ page, relay }) =>
    linkInAnotherTab(page, relay));

  test('a link that does not work shows its error on the first load', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#code=AAAA-BBBB`);
    await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired.');
  });
});
