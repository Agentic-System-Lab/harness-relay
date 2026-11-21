import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devices, type Locator, type Page } from '@playwright/test';
import { SCHEDULE_KINDS } from '../../src/shared/types';
import { en } from '../../src/web/locales/en';
import { zhTW } from '../../src/web/locales/zh-TW';
import { expect, test } from '../fixtures';
import { composer, finishedReply, homePage, openTeamChat } from '../support/app';

// A phone's screen, the way the chat is used over Tailscale (docs/remote-access.md).
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];

/** Where the fingers are: for each, its identifier and its offset from the gesture's first point, [id, dx, dy]. */
type Fingers = [number, number, number][];

/** One step of a gesture: its event, the fingers on the screen after it, those it is about, and how long it waits first (ms). */
interface TouchStep {
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel';
  touches: Fingers;
  changed: Fingers;
  wait?: number;
}

/**
 * Touch events from the page (Playwright's touchscreen only taps), sent where a finger's go: to the
 * element under the gesture's first point, `at` (a fraction of `on`'s box, its middle by default),
 * which must be on `on`. In one go, so that the moves follow the touch as a real swipe's do, unless a
 * step waits. WebKit has no `Touch` constructor: there they are made as Playwright makes them.
 */
async function gesture(on: Locator, steps: TouchStep[], at: [number, number] = [0.5, 0.5]): Promise<void> {
  await on.evaluate(
    async (el, { steps, at }) => {
      const r = el.getBoundingClientRect();
      const [x0, y0] = [r.left + r.width * at[0], r.top + r.height * at[1]];
      const target = document.elementFromPoint(x0, y0);
      if (!target || !el.contains(target)) throw new Error(`(${x0}, ${y0}) is not on ${el.className || el.tagName}`);
      const legacy = document as Document & {
        createTouch(view: Window, target: EventTarget, id: number, pageX: number, pageY: number, screenX: number, screenY: number): Touch;
        createTouchList(...touches: Touch[]): TouchList;
      };
      let constructible = true;
      try {
        new Touch({ identifier: 0, target, clientX: x0, clientY: y0 });
      } catch {
        constructible = false;
      }
      const touch = ([id, dx, dy]: [number, number, number]) => {
        const [x, y] = [x0 + dx, y0 + dy];
        return constructible
          ? new Touch({ identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
          : legacy.createTouch(window, target, id, x, y, x, y);
      };
      const list = (fingers: [number, number, number][]) => {
        const touches = fingers.map(touch);
        return (constructible ? touches : legacy.createTouchList(...touches)) as Touch[];
      };
      for (const step of steps) {
        if (step.wait) await new Promise((done) => setTimeout(done, step.wait));
        const [touches, changed] = [list(step.touches), list(step.changed)];
        target.dispatchEvent(
          new TouchEvent(step.type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches,
            targetTouches: touches,
            changedTouches: changed,
          }),
        );
      }
    },
    { steps, at },
  );
}

/** A finger's swipe by (dx, dy) from `at` on `on`, in six moves, then lifted (or cancelled). */
async function swipe(
  on: Locator,
  dx: number,
  dy = 0,
  { at, cancel = false }: { at?: [number, number]; cancel?: boolean } = {},
): Promise<void> {
  const moves: TouchStep[] = [1, 2, 3, 4, 5, 6].map((i) => ({
    type: 'touchmove',
    touches: [[0, (dx * i) / 6, (dy * i) / 6]],
    changed: [[0, (dx * i) / 6, (dy * i) / 6]],
  }));
  const last: TouchStep = cancel
    ? { type: 'touchcancel', touches: [], changed: [[0, dx, dy]] }
    : { type: 'touchend', touches: [], changed: [[0, dx, dy]] };
  await gesture(on, [{ type: 'touchstart', touches: [[0, 0, 0]], changed: [[0, 0, 0]] }, ...moves, last], at);
}

/**
 * A finger's swipe from (x, y) by dx as the browser's own touches (Chromium's DevTools protocol, which
 * hit-tests them and scrolls with them, as with a real finger), in `steps` moves `ms` apart on the
 * events' clock, so that their speed does not depend on how fast this computer sends them.
 */
async function browserSwipe(page: Page, x: number, y: number, dx: number, { steps = 6, ms = 8 } = {}): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1000;
  const at = (i: number) => ({ timestamp: start + (i * ms) / 1000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], ...at(0) });
  for (let i = 1; i <= steps; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y }], ...at(i) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], ...at(steps + 1) });
  await cdp.detach();
}

/** A point in a locator's box (its middle by default), for the browser's own touches. */
async function middle(on: Locator, fx = 0.5, fy = 0.5): Promise<[number, number]> {
  const box = (await on.boundingBox())!;
  return [box.x + box.width * fx, box.y + box.height * fy];
}

/**
 * Whether the sidebar drawer is open: its class, once two frames have passed, so that React has drawn
 * what the gesture set (no transition to wait for, and a wrong open shows).
 */
const drawerOpen = (page: Page) =>
  page.locator('.app').evaluate(async (el) => {
    for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(() => done(undefined)));
    return el.classList.contains('sidebar-open');
  });

/** Sends a message by touch: on a touch screen Enter is a new line, and the send button sends. */
async function tapSend(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).tap();
}

/** A one-second grey WebM, 64×36, for a reply's video (made with ffmpeg; 534 bytes). */
const CLIP =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHmEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggHQ7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECPQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYhcf7hST/khzpyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhDuaygDgibCBQLqBJJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYhcf7hST/khzmfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnWs54EAo6eBAACAsAIAnQEqQAAkAABHCIWFiJmEiAICAAaOT8zHm/FYAP7D4AAcU7trkbuPs4EAt4r3gQHxggGf8IED';

test('the desktop home links to pairing and follows a phone opening, closing, and signing out', async ({
  page,
  browser,
  relay,
  browserName,
}) => {
  test.skip(browserName === 'firefox', 'no mobile emulation in Firefox');
  const home = page.locator('.sidebar-bottom .phone-link');
  await expect(home).toContainText('Connect your phone');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.locator('.home-phone-corner .phone-link').click();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  const card = page.locator('#settings-home-screen');
  await expect(card.getByRole('heading', { name: 'Connect your phone', exact: true })).toBeInViewport();
  await expect(card.getByRole('button', { name: 'Sign in another device' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Add to Home Screen' })).toBeVisible();
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  try {
    const tab = await phone.newPage();
    await tab.addInitScript(() => {
      localStorage.setItem('relay:onboarded', '999');
      localStorage.setItem('relay:lang', 'en');
    });
    await tab.goto(relay.base + '/#code=' + (await relay.newSignInCode()));
    await expect(tab.locator('.app main.main')).toBeVisible();
    await expect(tab.locator('.phone-link')).toHaveCount(0);
    const guideLink = tab.locator('.home-hero a[href="#/settings/home-screen"]');
    await guideLink.click();
    const guide = tab.locator('#settings-home-screen');
    await expect(guide.getByRole('button', { name: 'Android · Chrome' })).toHaveAttribute('aria-pressed', 'true');
    await expect(guide.locator('.guide-steps li')).toHaveCount(3);
    await guide.getByRole('button', { name: 'iPhone · Safari' }).click();
    await expect(guide.locator('li').first()).toContainText(/Safari/);
    await expect(guide.locator('li').nth(1)).toContainText(/Open as Web App/i);
    await guide.locator('a[href="#/settings/notifications"]').click();
    await expect(tab.locator('#settings-notifications .section-title')).toBeInViewport();
    await expect(card.getByRole('heading', { name: 'Phone connected' })).toBeVisible();
    await page.goto(relay.base + '/#/');
    await expect(home).toContainText('Phone connected');
    await tab.close();
    await expect(home).toContainText('Phone paired', { timeout: 20_000 });
    await home.click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('navigation', { name: 'Sections of this page' }).getByRole('link', { name: 'Browsers', exact: true }).click();
    await page
      .locator('#settings-browsers')
      .locator('.share-row')
      .filter({ hasText: /Android/ })
      .getByRole('button', { name: 'Sign out' })
      .click();
    await expect(home).toContainText('Connect your phone');
  } finally {
    await phone.close();
  }
});

test.describe('on a phone', () => {
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  // Firefox has no mobile emulation.
  test.skip(({ browserName }) => browserName === 'firefox', 'no mobile emulation in Firefox');

  test('pairs a phone after installing Tailscale, using a single-use sign-in link', async ({ page, browser, relay }) => {
    await page.goto(relay.base + '/?pair=1#code=' + (await relay.newSignInCode()));
    const card = page.locator('#settings-home-screen');
    await expect(page).toHaveURL(/#\/settings\/home-screen$/);
    await expect(page.locator('#settings-browsers').getByRole('button', { name: 'Sign in another device' })).toHaveCount(0);
    await card.locator('.guide-pairing > summary').click();
    await card.locator('.phone-setup summary').click();
    await expect(card.getByRole('img', { name: 'Need Tailscale on your phone?' })).toBeVisible();
    await expect(card.getByRole('link', { name: /official Tailscale/ })).toHaveAttribute('href', 'https://tailscale.com/download');
    await expect(card.locator('.browsers-code')).toHaveCount(0);
    // Stand in for the desktop's Serve address, retaining the actual code from the server.
    const origin = 'https://computer.example.ts.net:8443';
    await page.route('**/api/auth/codes', async (route) => {
      const reply = await route.fetch();
      await route.fulfill({ response: reply, json: { ...(await reply.json()), phoneUrl: origin } });
    });
    await card.getByRole('button', { name: 'Sign in another device' }).tap();
    await expect(card.getByRole('img', { name: 'Scan to sign in to Harness Relay' })).toBeVisible();
    const link = new URL((await card.locator('.browsers-code-link').innerText()).trim());
    expect(link.origin).toBe(origin);
    expect(link.hash).toMatch(/^#code=[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const phone = await browser.newContext();
    try {
      const paired = await phone.newPage();
      // The offline fixture serves the same host at its loopback address.
      await paired.goto(relay.base + '/' + link.hash);
      await expect(paired.locator('.app main.main')).toBeVisible();
      await expect(paired).not.toHaveURL(/#code=/);
      const used = await phone.request.post(relay.base + '/api/auth/login', { data: { code: link.hash.slice(6) } });
      expect(used.status()).toBe(400);
    } finally {
      await phone.close();
    }
  });

  test('recovers a lost send response and a stale approval, then downloads the result', async ({ page, relay, context }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    const messages = '/api/conversations/' + id + '/messages';
    const text = 'Make the report e2e:approve e2e:write=report.md';
    await page.route(
      '**' + messages,
      async (route) => {
        const accepted = await route.fetch();
        expect(accepted.status()).toBe(202);
        await route.abort('connectionreset');
      },
      { times: 1 },
    );
    await composer(page).fill(text);
    await page.locator('.composer-row .send').tap();
    await expect(composer(page)).toHaveValue(text);
    await expect(page.locator('.approval-card')).toBeVisible();
    // An unrelated, refused draft must not replace the uncertain first delivery.
    await page.route('**' + messages, (route) => route.fulfill({ status: 409, json: { error: 'Draft refused' } }), { times: 1 });
    await composer(page).fill('A different draft');
    await page.locator('.composer-row .send').tap();
    await expect(page.getByRole('alert')).toContainText('Draft refused');
    await composer(page).fill(text);
    await page.locator('.composer-row .send').tap();
    await expect(composer(page)).toHaveValue('');
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.approval-card')).toHaveCount(1);
    const approval = (await page.locator('.approval-card').getAttribute('id'))!.slice('approval-'.length);
    await context.setOffline(true);
    // Another signed-in client answers while the phone cannot receive the result.
    await page.evaluate(() =>
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'relay:open', url: location.href } })),
    );
    await expect(page.locator('.approval-card button').first()).toBeDisabled();
    await relay.api('/api/conversations/' + id + '/approvals/' + approval, { body: { allow: true } });
    await context.setOffline(false);
    await expect(page.locator('.approval-done')).toContainText('Allowed');
    await expect(await finishedReply(page, 'Claude')).toContainText('I wrote report.md.');
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).tap();
    const panel = page.getByRole('dialog', { name: 'Files' });
    await panel.getByTitle('report.md', { exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('link', { name: 'Download', exact: true }).click(),
    ]);
    expect(readFileSync(await download.path(), 'utf8')).toBe('Written by Claude (Claude Code).\n');
  });

  test('the sidebar opens from the menu, and a chat works by touch', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'On the go');
    // The sidebar is tucked away until the menu opens it.
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    // The menu's three lines sit in the middle of its button (an icon, not a text glyph on a baseline; no
    // padding, which WebKit's default puts 1px more of below than above).
    const menu = page.getByRole('button', { name: 'Open sidebar' });
    const [box, icon] = [(await menu.boundingBox())!, (await menu.locator('svg').boundingBox())!];
    expect(Math.abs(icon.x + icon.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(0.1);
    expect(Math.abs(icon.y + icon.height / 2 - (box.y + box.height / 2))).toBeLessThanOrEqual(0.1);
    await menu.tap();
    await expect(page.locator('.conv-link', { hasText: 'On the go' })).toBeInViewport();
    // Going somewhere closes it again.
    await page.getByRole('button', { name: 'New chat' }).first().tap();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await page.locator('.conv-link', { hasText: 'On the go' }).tap();
    await expect(page.locator('.sidebar')).not.toBeInViewport();

    await expect(composer(page)).toBeVisible();
    await composer(page).fill('Quick question');
    // On a touch screen Enter is a new line: the send button sends.
    await page.getByRole('button', { name: 'Send' }).tap();
    await expect(page.locator('.msg-user', { hasText: 'Quick question' })).toBeVisible();
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Quick question”.');

    // The header's actions are under ⋯.
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).tap();
    await expect(page.getByRole('dialog', { name: 'Files' })).toBeVisible();
  });

  test('a swipe right opens the sidebar and a swipe left closes it; a scroll, a swipe in the message box or on a wide screen does not, and a wide screen closes it', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Swiped open');
    const sidebar = page.locator('.sidebar');
    const messages = page.locator('.messages');
    await expect(sidebar).not.toBeInViewport();

    // Up and down is a scroll, also one that goes more than a swipe's distance sideways.
    await swipe(messages, 60, -150);
    expect(await drawerOpen(page)).toBe(false);
    // A swipe right anywhere on the chat, not only from the screen's edge.
    await swipe(messages, 150);
    await expect(page.locator('.conv-link', { hasText: 'Swiped open' })).toBeInViewport();
    // Wholly in view (it slides in) before a finger goes on it.
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    // A swipe left on the sidebar closes it, and one on the dimmed page beside it (right of its 268px).
    await swipe(sidebar, -150);
    await expect(sidebar).not.toBeInViewport();
    await swipe(messages, 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await swipe(page.locator('.sidebar-scrim'), -150, 0, { at: [0.85, 0.5] });
    await expect(sidebar).not.toBeInViewport();

    // In the message box the finger moves the caret.
    await swipe(composer(page), 150);
    expect(await drawerOpen(page)).toBe(false);

    // Once the screen is wide enough for it to be no drawer, it closes: narrow again, it is shut.
    await swipe(messages, 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect.poll(() => drawerOpen(page)).toBe(false);
    // On a wide screen a swipe does nothing.
    await swipe(messages, 150);
    expect(await drawerOpen(page)).toBe(false);
    await page.setViewportSize(viewport);
    await expect(sidebar).not.toBeInViewport();
  });

  test('a quick flick opens the sidebar; a slow short drag, a cancelled touch, a long press, a second finger, a dialog or selected text do not', async ({
    page,
    relay,
    browserName,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Flicked open');
    const messages = page.locator('.messages');
    const sidebar = page.locator('.sidebar');
    await tapSend(page, 'Quick question');
    await finishedReply(page, 'Grok');

    // 40px, short of a swipe's 50: lifted at once it is a flick, cancelled it is nothing.
    await swipe(messages, 40, 0, { cancel: true });
    expect(await drawerOpen(page)).toBe(false);
    await swipe(messages, 40);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await swipe(page.locator('.sidebar-scrim'), -40, 0, { at: [0.85, 0.5] });
    await expect(sidebar).not.toBeInViewport();
    // The same 40px slowly, stopped a moment before it lifts.
    await gesture(messages, [
      { type: 'touchstart', touches: [[0, 0, 0]], changed: [[0, 0, 0]] },
      { type: 'touchmove', touches: [[0, 12, 0]], changed: [[0, 12, 0]], wait: 30 },
      { type: 'touchmove', touches: [[0, 25, 0]], changed: [[0, 25, 0]], wait: 150 },
      { type: 'touchmove', touches: [[0, 40, 0]], changed: [[0, 40, 0]], wait: 150 },
      { type: 'touchend', touches: [], changed: [[0, 40, 0]], wait: 150 },
    ]);
    expect(await drawerOpen(page)).toBe(false);
    // A long press (450ms) before the finger moves: it selects text.
    await gesture(messages, [
      { type: 'touchstart', touches: [[0, 0, 0]], changed: [[0, 0, 0]] },
      ...[1, 2, 3, 4, 5, 6].map((i): TouchStep => ({
        type: 'touchmove',
        touches: [[0, 25 * i, 0]],
        changed: [[0, 25 * i, 0]],
        wait: i === 1 ? 450 : 0,
      })),
      { type: 'touchend', touches: [], changed: [[0, 150, 0]] },
    ]);
    expect(await drawerOpen(page)).toBe(false);

    // A second finger on the screen: a pinch or a scroll, not a swipe.
    await gesture(messages, [
      { type: 'touchstart', touches: [[0, 0, 0]], changed: [[0, 0, 0]] },
      { type: 'touchmove', touches: [[0, 20, 0]], changed: [[0, 20, 0]] },
      {
        type: 'touchstart',
        touches: [
          [0, 20, 0],
          [1, 0, 120],
        ],
        changed: [[1, 0, 120]],
      },
      {
        type: 'touchmove',
        touches: [
          [0, 150, 0],
          [1, 130, 120],
        ],
        changed: [
          [0, 150, 0],
          [1, 130, 120],
        ],
      },
      { type: 'touchend', touches: [[1, 130, 120]], changed: [[0, 150, 0]] },
      { type: 'touchend', touches: [], changed: [[1, 130, 120]] },
    ]);
    expect(await drawerOpen(page)).toBe(false);

    // Text selected in a message: the finger may be dragging its handles.
    await page.locator('.msg-user', { hasText: 'Quick question' }).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    });
    await swipe(messages, 150);
    expect(await drawerOpen(page)).toBe(false);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    // Text selected in the message box is the box's own: a swipe on the chat still opens the sidebar.
    await composer(page).fill('Some words');
    await composer(page).evaluate((box: HTMLTextAreaElement) => {
      box.focus();
      box.select();
    });
    if (browserName === 'chromium') expect(await page.evaluate(() => document.getSelection()?.type)).toBe('Range');
    await swipe(messages, 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await swipe(sidebar, -150);
    await expect(sidebar).not.toBeInViewport();
    // Also once the box has lost the focus, its selection kept (Chromium still calls it a Range then).
    await composer(page).evaluate((box: HTMLTextAreaElement) => box.blur());
    if (browserName === 'chromium') expect(await page.evaluate(() => document.getSelection()?.type)).toBe('Range');
    await swipe(messages, 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await swipe(sidebar, -150);
    await expect(sidebar).not.toBeInViewport();

    // A dialog has the page; once it is closed, a swipe opens the sidebar again.
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).tap();
    const files = page.getByRole('dialog', { name: 'Files' });
    await expect(files).toBeVisible();
    await swipe(files, 150);
    expect(await drawerOpen(page)).toBe(false);
    // Beside it too, on its dimmed backdrop: an open dialog has the page.
    await swipe(page.locator('.modal-scrim'), 150, 0, { at: [0.01, 0.5] });
    expect(await drawerOpen(page)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(files).toBeHidden();
    await swipe(messages, 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
  });

  test("a swipe on a code block scrolled sideways is the code block's, and one on a video is the video's", async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'clip.webm'), Buffer.from(CLIP, 'base64'));
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Wide code');
    await tapSend(page, 'A clip ![clip](clip.webm) e2e:widecode');
    const reply = await finishedReply(page, 'Grok');
    const sidebar = page.locator('.sidebar');

    // The code block scrolls sideways (highlight.js's code element does).
    const code = reply.locator('pre code');
    expect(await code.evaluate((el) => [getComputedStyle(el).overflowX, el.scrollWidth > el.clientWidth + 100])).toEqual(['auto', true]);
    await code.evaluate((el) => {
      el.scrollLeft = 120;
    });
    await swipe(code, 150, 0, { at: [0.3, 0.5] });
    expect(await drawerOpen(page)).toBe(false);
    // Back at its start, the swipe is the sidebar's.
    await code.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await swipe(code, 150, 0, { at: [0.3, 0.5] });
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await swipe(page.locator('.sidebar-scrim'), -150, 0, { at: [0.85, 0.5] });
    await expect(sidebar).not.toBeInViewport();

    // A video's seek bar moves with the finger: the video, controls and all, keeps the move.
    const video = reply.locator('video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
    await swipe(video, 150, 0, { at: [0.2, 0.9] });
    expect(await drawerOpen(page)).toBe(false);
  });

  test("with the browser's own touches, a swipe and a flick open and close the sidebar, and a code block scrolled sideways scrolls back instead", async ({
    page,
    relay,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', "the browser's own touches are sent through Chromium's DevTools protocol");
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Real touches');
    await tapSend(page, 'Show me e2e:widecode');
    const reply = await finishedReply(page, 'Grok');
    const sidebar = page.locator('.sidebar');
    const scrim = page.locator('.sidebar-scrim');
    const messages = page.locator('.messages');

    // A swipe right on the chat, and a swipe left beside the sidebar.
    await browserSwipe(page, ...(await middle(messages)), 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await browserSwipe(page, ...(await middle(scrim, 0.85)), -150);
    await expect(sidebar).not.toBeInViewport();
    // A flick: 40px in 32ms (Chromium sends no move under 15px).
    await browserSwipe(page, ...(await middle(messages)), 40, { steps: 4 });
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await browserSwipe(page, ...(await middle(scrim, 0.85)), -40, { steps: 4 });
    await expect(sidebar).not.toBeInViewport();
    // Slowly, 40px in 400ms, it is no flick.
    await browserSwipe(page, ...(await middle(messages)), 40, { steps: 4, ms: 100 });
    expect(await drawerOpen(page)).toBe(false);

    // The browser scrolls the code block back with the finger, and the sidebar stays shut.
    const code = reply.locator('pre code');
    await code.evaluate((el) => {
      el.scrollLeft = 120;
    });
    await browserSwipe(page, ...(await middle(code, 0.3)), 150);
    await expect.poll(() => code.evaluate((el) => el.scrollLeft)).toBeLessThan(120);
    expect(await drawerOpen(page)).toBe(false);
    // Back at its start, the swipe is the sidebar's.
    await expect.poll(() => code.evaluate((el) => el.scrollLeft)).toBe(0);
    await browserSwipe(page, ...(await middle(code, 0.3)), 150);
    await expect(sidebar).toBeInViewport({ ratio: 1 });
  });

  test.describe('with the guided tour', () => {
    test.use({ tour: true });

    test('a swipe over the guided tour leaves the sidebar shut, and opens it once the tour is skipped', async ({ page }) => {
      const tour = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Skip tour' }) });
      await expect(tour).toBeVisible();
      await swipe(tour, 150);
      expect(await drawerOpen(page)).toBe(false);
      await tour.getByRole('button', { name: 'Skip tour' }).tap();
      await expect(tour).toBeHidden();
      await swipe(page.locator('.main'), 150);
      await expect(page.locator('.sidebar')).toBeInViewport({ ratio: 1 });
    });
  });

  test("the menu button tells of unread notifications; one opened from the drawer's bell closes the drawer, also for the chat on screen", async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'On the go');
    // As if the window were behind another: the chat on screen reads nothing of its own.
    await page.evaluate(() => void (document.hasFocus = () => false));
    await composer(page).fill('Quick question');
    await page.getByRole('button', { name: 'Send' }).tap();
    await finishedReply(page, 'Grok');
    const menu = page.getByRole('button', { name: 'Open sidebar (1 unread notification)' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.menu-dot')).toBeVisible();

    await menu.tap();
    const bell = page.locator('.sidebar .brand').getByRole('button', { name: 'Notifications (1 unread)' });
    await expect(bell).toBeInViewport();
    await expect(bell.locator('.inbox-badge')).toHaveText('1');
    await bell.tap();
    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    const item = dialog.locator('.inbox-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Grok finished replying');
    // The chat it opens is the one on screen: the address stays, the dialog and the drawer close.
    await item.tap();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible();
    await expect(page.locator('.menu-dot')).toHaveCount(0);
  });

  test("a conversation's pin shows without hovering, and a tap pins it above the groups", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Pin me');
    // Somewhere else, so that a tap on the conversation opens it.
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await page.getByRole('button', { name: 'New chat' }).first().tap();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    const item = page.locator('.conv-item', { hasText: 'Pin me' });
    await expect(item).toBeInViewport();
    // No hover on a touch screen: shown all along, on every conversation.
    const pin = item.getByRole('button', { name: 'Pin "Pin me"' });
    await expect(pin).toHaveCSS('opacity', '1');
    await pin.tap();
    const pinned = page.getByRole('region', { name: 'Pinned', exact: true });
    await expect(pinned.locator('.conv-title-text')).toHaveText(['Pin me']);
    await expect(page.getByRole('button', { name: 'Unpin "Pin me"' })).toHaveCount(2);
    // A tap on the conversation still opens it: the pin is over its corner only.
    await pinned.locator('.conv-link').tap();
    await expect(page.locator('.chat-title')).toHaveText('Pin me');
    await expect(page.locator('.sidebar')).not.toBeInViewport();
  });

  test('a long message keeps the page from scrolling sideways', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await composer(page).fill(`A very long word: ${'x'.repeat(300)} e2e:markdown`);
    await page.getByRole('button', { name: 'Send' }).tap();
    await finishedReply(page, 'Claude');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('scrolled up, the arrow to the end sits in the middle above the message box, and a tap takes the chat there', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await tapSend(page, 'Tell me everything e2e:long');
    await finishedReply(page, 'Claude');
    const list = page.locator('.messages');
    const fromEnd = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    const toEnd = page.getByRole('button', { name: 'Scroll to the latest message' });
    await expect.poll(fromEnd).toBeLessThanOrEqual(1);
    await expect(toEnd).toHaveCount(0);

    // As a finger's scroll up does (Playwright's touchscreen only taps).
    await list.evaluate((el) => el.scrollBy(0, -800));
    await expect(toEnd).toBeVisible();
    // At rest: it fades in from 6px lower.
    await toEnd.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const [arrow, box] = [(await toEnd.boundingBox())!, (await page.locator('.composer').boundingBox())!];
    expect(Math.abs(arrow.x + arrow.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
    expect(arrow.y + arrow.height).toBeLessThan(box.y);
    // A finger's target of 48px around the 36px circle it shows: 5px outside the circle is still the button.
    expect(arrow.width).toBeGreaterThanOrEqual(48);
    expect(
      await toEnd.evaluate((el) => {
        const circle = getComputedStyle(el, '::before');
        return parseFloat(circle.width) + parseFloat(circle.borderLeftWidth) + parseFloat(circle.borderRightWidth);
      }),
    ).toBeCloseTo(36, 1); // WebKit reports fractional CSS pixels at a phone’s device scale.
    expect(
      await toEnd.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
        return [
          [x - 23, y],
          [x + 23, y],
          [x, y - 23],
          [x, y + 23],
        ].every(([px, py]) => el.contains(document.elementFromPoint(px!, py!)));
      }),
    ).toBe(true);
    // A tap leaves the keyboard as it was: shut, the message box does not take the focus…
    await composer(page).blur();
    await toEnd.tap();
    await expect.poll(fromEnd).toBeLessThanOrEqual(1);
    await expect(toEnd).toHaveCount(0);
    await expect(composer(page)).not.toBeFocused();
    // …and open, the message box keeps it.
    await composer(page).focus();
    await list.evaluate((el) => el.scrollBy(0, -800));
    await toEnd.tap();
    await expect.poll(fromEnd).toBeLessThanOrEqual(1);
    await expect(composer(page)).toBeFocused();
  });

  test("on a narrow phone, a template's editor and the team settings do not scroll sideways, and the add card lists every CLI", async ({
    page,
    relay,
  }) => {
    /** How far a scrolling box scrolls sideways. */
    const sideways = (box: string) => page.locator(box).evaluate((el) => el.scrollWidth - el.clientWidth);
    // 320px: an iPhone SE (1st generation), or a mini with Display Zoom, narrower than a 290px member card
    // and its margins; 280px: a foldable's cover screen, where English's "hand-offs / message" goes on a
    // line of its own.
    const widths = [320, 280];
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await page.getByRole('button', { name: 'New chat' }).first().tap();
    await page.locator('.template-library > summary').tap();
    // A relay template: its rules have the hand-off limit, a number box with its unit.
    await page.locator('.preset-card', { hasText: 'Architect → Builder → Reviewer' }).locator('.preset-main').tap();
    const editor = page.getByRole('dialog');
    await expect(editor.locator('input[value="Architect"]')).toBeVisible();
    await expect(editor.getByText('hand-offs / message')).toBeAttached();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 640 });
      expect(await sideways('.template-editor-body')).toBeLessThanOrEqual(1);
      // One column: the add card shares no row, so it lists every CLI without a scroll of its own.
      expect(await editor.locator('.add-card-list').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press('Escape');

    await page.setViewportSize(viewport);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { mode: 'relay' });
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).tap();
    await expect(page.getByRole('dialog', { name: 'Team settings' }).locator('input[value="Claude"]')).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 640 });
      expect(await sideways('.drawer')).toBeLessThanOrEqual(1);
      expect(await page.locator('.drawer .add-card-list').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    }
  });

  test("on a narrow phone, a new schedule of any kind does not scroll sideways, in either language, nor does a chat's Automation", async ({
    page,
    relay,
  }) => {
    /** The boxes that scroll sideways, and how far: not the row of kinds, which does so where it must. */
    const sideways = () =>
      page.evaluate(() =>
        [document.documentElement, ...document.querySelectorAll<HTMLElement>('*')]
          .filter(
            (el) =>
              !el.matches('.schedule-kinds') &&
              el.scrollWidth > el.clientWidth + 1 &&
              (el === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)),
          )
          .map((el) => `${el.className || el.tagName} +${el.scrollWidth - el.clientWidth}`),
      );
    /** How many rows the buttons in `box` take. */
    const rows = (box: string) =>
      page
        .locator(box)
        .evaluate((g) => new Set([...g.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))).size);
    /** Whether the chosen kind is wholly in the row's view. */
    const chosenInView = () =>
      page.locator('.schedule-kinds').evaluate((row) => {
        const box = row.getBoundingClientRect();
        const on = row.querySelector('button.on')!.getBoundingClientRect();
        return on.left >= box.left - 1 && on.right <= box.right + 1;
      });
    // The creation page uses a select, and the drawer scrolls its kinds horizontally.
    // The week's seven days need about 310px in English
    // and 276px in Chinese: below that they go onto two rows.
    const widths = [320, 280];
    const widthsOf = { en: [...widths, 400, 430], 'zh-TW': [...widths, 250, 360] };
    const dayRows = (lang: 'en' | 'zh-TW', width: number) => (lang === 'en' ? (width <= 320 ? 2 : 1) : width <= 280 ? 2 : 1);
    for (const [lang, messages] of [
      ['en', en],
      ['zh-TW', zhTW],
    ] as const) {
      const s = messages.schedule;
      await page.evaluate((l) => localStorage.setItem('relay:lang', l), lang);
      await page.setViewportSize(viewport);
      await page.goto(`${relay.base}/#/schedule`);
      // Only the hash changes from one language to the next: load the page again in the new one.
      await page.reload();
      await page.setViewportSize({ width: 250, height: 640 });
      const library = page.locator('.creation-fields > .template-library');
      await library.locator('summary').tap();
      await expect(library.locator('.preset-card').first()).toBeVisible();
      expect(await sideways(), `${lang}, expanded team templates`).toEqual([]);
      await library.locator('summary').tap();
      for (const kind of SCHEDULE_KINDS) {
        await page.setViewportSize(viewport);
        const when = page.getByRole('combobox', { name: s.repeat });
        await when.selectOption(kind);
        if (kind === 'interval') {
          // The interval's unit is only "hours", next to its box; its hint, a line of its own, still describes the box.
          await expect(page.locator('.schedule-form .field-with-unit .unit')).toHaveText(s.hoursUnit);
          await expect(page.locator('.schedule-form input[type="number"]')).toHaveAccessibleDescription(s.intervalHint);
        }
        for (const width of widthsOf[lang]) {
          await page.setViewportSize({ width, height: 640 });
          expect(await sideways(), `${lang}, ${kind}, ${width}px`).toEqual([]);
          await expect(when).toHaveValue(kind);
          if (kind === 'weekly') expect(await rows('.day-picker'), `the days, ${lang}, ${width}px`).toBe(dayRows(lang, width));
        }
        // Waiting for several things: each in a box of its own, with its Remove, still within the page.
        if (kind === 'event') {
          await page.setViewportSize(viewport);
          await page.getByRole('button', { name: s.watch.add }).tap();
          await expect(page.getByRole('group', { name: s.watch.group(2) })).toBeVisible();
          for (const width of widthsOf[lang]) {
            await page.setViewportSize({ width, height: 640 });
            expect(await sideways(), `${lang}, two things to wait for, ${width}px`).toEqual([]);
          }
        }
      }
    }

    // A chat's Automation drawer, with the week's days.
    await page.evaluate(() => localStorage.setItem('relay:lang', 'en'));
    await page.setViewportSize(viewport);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    // Only the hash changed: load the chat again in English.
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).tap();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    await drawer.getByRole('radiogroup', { name: 'When' }).getByRole('radio', { name: 'Every week', exact: true }).tap();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 640 });
      expect(await sideways(), `the drawer, ${width}px`).toEqual([]);
    }
    // Saved as the last kind, the drawer opens again with it in the row's view, though the row scrolls.
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Check the build');
    await drawer.getByRole('radiogroup', { name: 'When' }).getByRole('radio', { name: 'Every few hours', exact: true }).tap();
    await drawer.getByRole('button', { name: 'Save', exact: true }).tap();
    await expect(drawer).toBeHidden();
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).tap();
    await expect(drawer.getByRole('radio', { name: 'Every few hours', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(await page.locator('.schedule-kinds').evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
    expect(await chosenInView()).toBe(true);
  });

  test("the home page's tagline is smaller, each of its lines on one line, and the logo closes the sidebar", async ({ page }) => {
    /** The tagline's size, how many lines it takes, and whether the page scrolls sideways. */
    const tagline = () =>
      page.locator('.home-line').evaluate((h) => {
        const style = getComputedStyle(h);
        return {
          size: parseFloat(style.fontSize),
          lines: Math.round(h.getBoundingClientRect().height / parseFloat(style.lineHeight)),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
    await expect(homePage(page)).toBeVisible();
    // English on two lines ("From now on," and the rest), neither of them wrapped.
    expect(await tagline()).toEqual({ size: expect.any(Number), lines: 2, overflow: expect.any(Number) });
    const en = await tagline();
    expect(en.size).toBeLessThan(22);
    expect(en.overflow).toBeLessThanOrEqual(1);

    // Tapping the logo closes the sidebar, also when the home page is open already.
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await expect(page.locator('.sidebar')).toBeInViewport();
    await page.locator('.sidebar').getByRole('link', { name: 'Harness Relay', exact: true }).tap();
    await expect(page.locator('.sidebar')).not.toBeInViewport();

    // Chinese on one line.
    await page.evaluate(() => localStorage.setItem('relay:lang', 'zh-TW'));
    await page.reload();
    await expect(page.getByRole('heading', { name: '讓你的 agent 團隊從此為你幹活' })).toBeVisible();
    const zh = await tagline();
    expect(zh.lines).toBe(1);
    expect(zh.size).toBeLessThan(22);
    expect(zh.overflow).toBeLessThanOrEqual(1);
  });
});
