import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import type { InboxItem } from '../../src/shared/types';
import { acceptNextDialog, awaitingPlan, chatId, confirmTeam, finishedReply, homePage, send, settled, startChat } from '../support/app';

/*
 * Settings → Notifications, and what the page does when agents finish or need the user. The browser's
 * own notifications and sound are recorded instead (a stand-in `Notification` and `AudioContext`,
 * set before the app's scripts), and this browser has no push service (`PushManager` taken away), so
 * the page tells the user itself, as in the desktop app's window. Push notifications, which need a
 * real push service, are covered by the unit tests (test/push.test.ts, test/alerts.test.ts).
 */

interface Recorded {
  notes: { title: string; body: string; tag?: string; silent?: boolean }[];
  /** Notes played (each sound is two or three). */
  tones: number;
}

/**
 * Records the page's notifications and sound from its next load on. `focused`: whether its window
 * has the keyboard (`document.hasFocus()`), which `setFocused` changes. `prefs`: the choices saved
 * in Settings → Notifications before the page loads (none: as a first visit); `allowed`: whether the
 * browser already allows notifications.
 */
async function recordAlerts(page: Page, o: { prefs?: object; allowed?: boolean } = {}): Promise<void> {
  await page.addInitScript(({ prefs, allowed }) => {
    const w = window as unknown as { __alerts: Recorded & { focused: boolean; clicks: (() => void)[] } };
    w.__alerts = { notes: [], tones: 0, focused: true, clicks: [] };
    try {
      if (prefs && localStorage.getItem('relay:alerts') === null) localStorage.setItem('relay:alerts', JSON.stringify(prefs));
      if (allowed) sessionStorage.setItem('e2e:notify', 'granted');
    } catch {
      /* storage unavailable */
    }
    class FakeNotification {
      onclick: (() => void) | null = null;
      static get permission() {
        return sessionStorage.getItem('e2e:notify') ?? 'default';
      }
      static async requestPermission() {
        sessionStorage.setItem('e2e:notify', 'granted');
        return 'granted';
      }
      constructor(title: string, options: NotificationOptions = {}) {
        w.__alerts.notes.push({ title, body: options.body ?? '', tag: options.tag, silent: options.silent ?? undefined });
        w.__alerts.clicks.push(() => this.onclick?.());
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    delete (window as { PushManager?: unknown }).PushManager;
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        return { type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start: () => void w.__alerts.tones++, stop() {} };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node };
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true, writable: true });
    document.hasFocus = () => w.__alerts.focused;
  }, o);
  await page.reload();
  await expect(page.locator('.app main.main')).toBeVisible();
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __alerts: Recorded }).__alerts);
const setFocused = (page: Page, focused: boolean) =>
  page.evaluate((f) => void ((window as unknown as { __alerts: { focused: boolean } }).__alerts.focused = f), focused);
const bodies = async (page: Page) => (await recorded(page)).notes.map((n) => n.body);

/** The page asks for the conversations once more (as it does every 3 seconds) and has heard the answer. */
async function polled(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => /\/api\/conversations(\?|$)/.test(r.url()) && r.request().method() === 'GET'),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
}

const ON = { notify: true, sound: true, done: true, needs: true };

test.describe('notifications and sound', () => {
  test('Settings asks the browser, plays the sound to try it, and sends a test notification', async ({ page }) => {
    await recordAlerts(page);
    await page.evaluate(() => (location.hash = '#/settings/notifications'));
    const card = page.locator('#settings-notifications');
    await expect(card.getByRole('heading', { name: 'Notifications and sound' })).toBeVisible();
    // No push service in this browser: only while the page is open.
    await expect(card).toContainText('Tells you while Harness Relay is open in this browser');
    const test = card.getByRole('button', { name: 'Send a test notification' });
    await expect(test).toBeDisabled();

    await card.getByRole('checkbox', { name: 'Show notifications' }).check();
    await expect(card.getByRole('checkbox', { name: 'Show notifications' })).toBeChecked();
    await card.getByRole('checkbox', { name: 'Play a sound' }).check();
    expect((await recorded(page)).tones).toBe(2);

    await test.click();
    await expect(card).toContainText('Test notification shown.');
    const { notes, tones } = await recorded(page);
    expect(notes).toEqual([
      { title: 'Harness Relay', body: "Notifications are on: you'll be told here when an agent finishes or needs you.", tag: 'relay-test', silent: true },
    ]);
    expect(tones).toBe(4);

    // Kept in this browser.
    await page.reload();
    await expect(card.getByRole('checkbox', { name: 'Show notifications' })).toBeChecked();
    await expect(card.getByRole('checkbox', { name: 'A reply is done (or ended with an error)' })).toBeChecked();
  });

  test('with its window behind another, a team to confirm and a finished reply each show a notification, and a click opens the chat', async ({ page, relay }) => {
    await recordAlerts(page, { prefs: ON, allowed: true });
    await startChat(page);
    const id = chatId(page);
    await setFocused(page, false);

    await send(page, 'Tell me when you are done');
    await expect(awaitingPlan(page)).toBeVisible();
    await expect.poll(() => bodies(page), { timeout: 15_000 }).toContain("The lead agent's team is ready for you to confirm");
    await confirmTeam(page);
    await finishedReply(page, 'Claude');
    await expect
      .poll(() => bodies(page), { timeout: 15_000 })
      .toContain('Claude finished replying\nHello from Claude (Claude Code). You said: “Tell me when you are done”.');
    const { notes, tones } = await recorded(page);
    expect(notes.map((n) => [n.title, n.tag, n.silent])).toEqual([
      ['Tell me when you are done', `relay-${id}`, true],
      ['Tell me when you are done', `relay-${id}`, true],
    ]);
    // Three notes for a need, two for a reply.
    expect(tones).toBe(5);

    await settled(relay, id);
    await page.evaluate(() => (location.hash = '#/'));
    await expect(homePage(page)).toBeVisible();
    await page.evaluate(() => (window as unknown as { __alerts: { clicks: (() => void)[] } }).__alerts.clicks.at(-1)!());
    await page.waitForURL(new RegExp(`#/c/${id}$`));
  });

  test("an agent's question shows a notification with what it asked", async ({ page }) => {
    await recordAlerts(page, { prefs: { ...ON, sound: false }, allowed: true });
    await startChat(page, { autoConfirm: true });
    await setFocused(page, false);
    await send(page, 'Plan the release e2e:ask');
    await expect.poll(() => bodies(page), { timeout: 15_000 }).toEqual([expect.stringMatching(/^Claude asked you something\n/)]);
    expect((await recorded(page)).tones).toBe(0);
  });

  test('says nothing of the chat the user is looking at, and only plays the sound for another one', async ({ page, relay }) => {
    await recordAlerts(page, { prefs: ON, allowed: true });
    await startChat(page, { autoConfirm: true });
    const id = chatId(page);
    await send(page, 'First question');
    await finishedReply(page, 'Claude');
    await settled(relay, id);
    await polled(page);
    expect(await recorded(page)).toEqual({ notes: [], tones: 0, focused: true, clicks: [] });

    await send(page, 'Take your time e2e:slow=5');
    await page.evaluate(() => (location.hash = '#/'));
    await expect(homePage(page)).toBeVisible();
    await settled(relay, id);
    await expect.poll(async () => (await recorded(page)).tones, { timeout: 15_000 }).toBe(2);
    expect((await recorded(page)).notes).toEqual([]);

    // Turned off in Settings: nothing.
    await page.evaluate(() => (location.hash = '#/settings/notifications'));
    const card = page.locator('#settings-notifications');
    await card.getByRole('checkbox', { name: 'Show notifications' }).uncheck();
    await card.getByRole('checkbox', { name: 'Play a sound' }).uncheck();
    await page.evaluate((chat) => (location.hash = `#/c/${chat}`), encodeURIComponent(id));
    await send(page, 'Once more e2e:slow=5');
    await page.evaluate(() => (location.hash = '#/'));
    await expect(homePage(page)).toBeVisible();
    await settled(relay, id);
    await polled(page);
    expect(await recorded(page)).toMatchObject({ notes: [], tones: 2 });
  });
});

test.describe('the notification inbox', () => {
  /** The bell in the sidebar, left of its collapse button. */
  const bell = (page: Page) => page.locator('.sidebar .brand').getByRole('button', { name: /^Notifications/ });
  const inbox = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

  test('the bell keeps what the team said: how many are unread, the list, a click opens its chat and reads it, and Clear all', async ({ page, relay }) => {
    // Notifications and sound off: the inbox keeps them all the same. The window behind another, so the chat on screen reads nothing.
    await recordAlerts(page);
    await startChat(page);
    const id = chatId(page);
    await setFocused(page, false);
    await expect(bell(page)).toHaveAccessibleName('Notifications');
    await expect(bell(page).locator('.inbox-badge')).toHaveCount(0);
    // Left of the collapse button.
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    expect((await bell(page).boundingBox())!.x).toBeLessThan((await collapse.boundingBox())!.x);

    await send(page, 'Tell me when you are done');
    await expect(awaitingPlan(page)).toBeVisible();
    // The server reads the states every 1.5 s, as for push: the team to confirm is kept once it has looked.
    await expect(bell(page)).toHaveAccessibleName('Notifications (1 unread)', { timeout: 15_000 });
    await confirmTeam(page);
    await finishedReply(page, 'Claude');
    await settled(relay, id);
    await expect(bell(page)).toHaveAccessibleName('Notifications (2 unread)', { timeout: 15_000 });
    await expect(bell(page).locator('.inbox-badge')).toHaveText('2');
    expect((await recorded(page)).notes).toEqual([]);

    await page.evaluate(() => (location.hash = '#/'));
    await expect(homePage(page)).toBeVisible();
    await setFocused(page, true);
    await bell(page).click();
    const dialog = inbox(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Notifications' })).toContainText('2 unread');
    const items = dialog.locator('.inbox-item');
    await expect(items).toHaveCount(2);
    await expect(dialog.locator('.inbox-item.unread')).toHaveCount(2);
    // The newest first: the reply, then the team to confirm, each with its chat's title.
    await expect(items.nth(0)).toContainText('Tell me when you are done');
    await expect(items.nth(0)).toContainText('Claude finished replying');
    await expect(items.nth(0)).toContainText('Hello from Claude (Claude Code). You said: “Tell me when you are done”.');
    await expect(items.nth(1)).toContainText("The lead agent's team is ready for you to confirm");

    await items.nth(0).click();
    await page.waitForURL(new RegExp(`#/c/${id}$`));
    await expect(dialog).toBeHidden();
    await expect(bell(page)).toHaveAccessibleName('Notifications');
    await expect(bell(page).locator('.inbox-badge')).toHaveCount(0);
    await expect.poll(async () => (await relay.api<InboxItem[]>('/api/notifications')).map((i) => i.read)).toEqual([true, true]);

    // Read now: kept, without the unread mark; Mark all as read has nothing to do. Clear all asks first.
    await bell(page).click();
    await expect(items).toHaveCount(2);
    await expect(dialog.locator('.inbox-item.unread')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
    acceptNextDialog(page);
    await dialog.getByRole('button', { name: 'Clear all' }).click();
    await expect(dialog).toContainText('No notifications yet.');
    await expect(dialog.getByRole('button', { name: 'Clear all' })).toBeDisabled();
    expect(await relay.api<InboxItem[]>('/api/notifications')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(bell(page)).toBeFocused();
  });

  test('reads at once what comes in the chat on screen; Mark all as read reads the rest; with the sidebar collapsed, the bell is right of the expand button, which keeps the corner', async ({ page, relay }) => {
    await startChat(page, { autoConfirm: true });
    const first = chatId(page);
    await send(page, 'First question');
    await finishedReply(page, 'Claude');
    await settled(relay, first);
    // Kept, and read: the user was looking.
    await expect.poll(async () => (await relay.api<InboxItem[]>('/api/notifications')).map((i) => [i.kind, i.read])).toEqual([['done', true]]);
    await expect(bell(page)).toHaveAccessibleName('Notifications');

    // A reply that ends while the user is elsewhere stays unread.
    await send(page, 'Take your time e2e:slow=5');
    await page.evaluate(() => (location.hash = '#/'));
    await expect(homePage(page)).toBeVisible();
    await settled(relay, first);
    await expect(bell(page)).toHaveAccessibleName('Notifications (1 unread)', { timeout: 15_000 });

    // Collapsed: the expand button keeps the corner, the bell and its count right of it.
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const corner = page.locator('.sidebar-tools');
    const cornerBell = corner.getByRole('button', { name: 'Notifications (1 unread)' });
    const expand = corner.getByRole('button', { name: 'Expand sidebar' });
    await expect(cornerBell).toBeVisible();
    await expect(cornerBell.locator('.inbox-badge')).toHaveText('1');
    // Measured together: the sidebar may still be sliding away.
    const [expandX, bellX] = await corner.evaluate((el) => [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().x));
    expect(expandX).toBeLessThan(bellX!);
    await expect(corner.getByRole('button').first()).toHaveAccessibleName('Expand sidebar');
    await cornerBell.click();
    const dialog = inbox(page);
    await expect(dialog.locator('.inbox-item.unread')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(dialog.locator('.inbox-item.unread')).toHaveCount(0);
    await expect(corner.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expand.click();
    await expect(bell(page)).toHaveAccessibleName('Notifications');
  });
});
