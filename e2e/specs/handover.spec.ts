import { chromium, type Page } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { findBrowser } from '../../src/server/browser/find';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';

/*
 * Taking over the chat's browser (`browser_hand_over`): the agent (Claude Code's fake, `e2e:mcp`) hands a
 * sign-in page to the user; the card says what stays with the chat's browser and offers to show the page
 * here; the user clicks and types into the screencast's panel (with a mouse, or a finger on a phone),
 * the page's server gets what they typed, and the agent hears only that they handed it back, with their
 * note. The window on the computer Harness Relay runs on opens here only for a browser for the user
 * alone, and headless (`RELAY_HEADLESS_WINDOWS`, else it would open on the developer's screen); the
 * hand-over's window is tested in test/browser.test.ts.
 */

/** A sign-in page: a field over its top half, a button over its bottom half; what is posted, and the page after it. */
async function signInSite(): Promise<{ server: Server; url: string; posted: string[] }> {
  const posted: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posted.push(new URLSearchParams(body).get('user') ?? '');
        res.writeHead(303, { location: '/home', 'set-cookie': 'sid=e2e; Path=/; HttpOnly' }).end();
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/home') return res.end('<title>Home</title><h1>Signed in</h1>');
    res.end(
      '<title>Test sign-in</title><form method="post" action="/login">' +
        '<input name="user" aria-label="User" style="position:fixed;left:0;top:0;width:100%;height:50%;font-size:32px">' +
        '<button style="position:fixed;left:0;top:50%;width:100%;height:50%;font-size:32px">Sign in</button></form>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, posted };
}

/**
 * The Chromium the chat's browser starts: RELAY_BROWSER's, else the system's, else Playwright's (CI may have
 * only its headless shell). On Windows Playwright's, as the Browser test of `app-lifecycle.spec.ts` does:
 * the system's Chrome or Edge there does not start under the test server's own home, which has no AppData
 * folder (the hand-over's card and the browser for the user alone never came on CI's Windows runners).
 */
async function aBrowser(): Promise<string> {
  const configured = process.env.RELAY_BROWSER;
  const found = configured || process.platform !== 'win32' ? findBrowser({ configured }) : undefined;
  if (found) return found;
  const shell = await chromium.launchServer();
  try {
    return shell.process().spawnfile;
  } finally {
    await shell.close();
  }
}

/** Where on the screencast's image a fraction of the page is, on the screen. */
async function onPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const image = page.locator('.handover-screen img');
  await expect(image).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 20_000 });
  const box = (await image.boundingBox())!;
  const size = await image.evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  const scale = Math.min(box.width / size.w, box.height / size.h);
  const left = box.x + (box.width - size.w * scale) / 2;
  const top = box.y + (box.height - size.h * scale) / 2;
  return { x: left + size.w * scale * x, y: top + size.h * scale * y };
}

const askHandOver = (url: string) =>
  `Please sign in for me ${JSON.stringify({ reason: 'Sign in to the test site, then hand it back', url })} e2e:mcp=browser_hand_over`;

test.describe('taking over the browser', () => {
  test.use({ serverEnv: async ({}, use) => use({ RELAY_BROWSER: await aBrowser() }) });

  test('the user signs in through the screencast with a mouse and keys, and hands it back with a note', async ({ page, relay }) => {
    const site = await signInSite();
    try {
      await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { browser: ['claude'] } } });
      await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Hand over');
      await send(page, askHandOver(site.url));

      const card = page.getByRole('region', { name: '@Claude hands the browser to you' });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('Sign in to the test site, then hand it back');
      await expect(card.locator('.handover-url')).toContainText(site.url);
      await expect(card).toContainText("What you sign in to stays usable by the agents in this chat's browser until the chat is deleted");
      // The sidebar says the chat needs the user.
      await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Needs you');
      await card.getByRole('button', { name: 'Show it here' }).click();

      const panel = page.getByRole('dialog', { name: 'Take over the browser' });
      await expect(panel).toBeVisible();
      await expect(panel.getByLabel('Address')).toHaveValue(site.url);
      // Into the field, typed with keys, then text as an input method gives it.
      const field = await onPage(page, 0.5, 0.25);
      await page.mouse.click(field.x, field.y);
      await panel.getByLabel('Type into the page').pressSequentially('someone');
      await page.keyboard.insertText('注音');
      const button = await onPage(page, 0.5, 0.75);
      await page.mouse.click(button.x, button.y);
      await expect.poll(() => site.posted).toEqual(['someone注音']);
      await expect(panel.getByLabel('Address')).toHaveValue(`${site.url}home`);

      // Hidden for a moment, the note written on the card, handed back there.
      await panel.getByRole('button', { name: 'Hide for now' }).click();
      await expect(panel).toBeHidden();
      await expect(card).toContainText('In your hands');
      await card.getByPlaceholder('A note to the agent (optional)').fill('Signed in as someone');
      await card.getByRole('button', { name: 'Done: hand it back' }).click();

      const reply = await finishedReply(page, 'Claude', 60_000);
      await expect(reply).toContainText(
        'The browser_hand_over tool said: The user took over the browser and handed it back, saying: "Signed in as someone". The page is open as they left it.',
      );
      // Never what they typed.
      await expect(reply).not.toContainText('someone注音');
      await expect(reply.locator('.handover-done')).toContainText('Handed back (in the chat): Signed in as someone');
      await expect(page.locator('.conv-item.active .conv-status', { hasText: 'Needs you' })).toHaveCount(0);
    } finally {
      site.server.close();
    }
  });

  test('declined, the agent hears so and the card says it', async ({ page, relay }) => {
    const site = await signInSite();
    try {
      await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { browser: ['claude'] } } });
      await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Decline');
      await send(page, askHandOver(site.url));
      const card = page.getByRole('region', { name: '@Claude hands the browser to you' });
      await card.getByPlaceholder('A note to the agent (optional)').fill('Later');
      await card.getByRole('button', { name: 'Decline' }).click();
      const reply = await finishedReply(page, 'Claude', 60_000);
      await expect(reply).toContainText('The browser_hand_over tool said: The user declined to take over the browser, saying: "Later".');
      await expect(reply.locator('.handover-done')).toContainText('Declined: Later');
      expect(site.posted).toEqual([]);
    } finally {
      site.server.close();
    }
  });

  test('a secret from a page: the browser for the user alone opens at its address, and the selection is saved with nothing of it on the page', async ({
    page,
    relay,
  }) => {
    const TOKEN = 'tok-e2e-from-page-7c41';
    const site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // A token generator's page: the token over the page's top half.
      res.end(`<title>Your token</title><p style="position:fixed;left:0;top:0;width:100%;height:50%;margin:0;font-size:32px">${TOKEN}</p>`);
    });
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/token`;
    try {
      await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'A secret from a page');
      await send(page, `Set up posting e2e:secret e2e:secreturl=${url}`);
      const card = page.getByRole('region', { name: 'Secrets @Claude asks for' });
      await expect(card).toContainText('A browser for you alone');
      // The whole address, which the user may open in their own browser instead.
      await expect(card.getByRole('link', { name: url })).toHaveAttribute('href', url);
      await card.getByRole('button', { name: `Open ${new URL(url).host} in a browser for you alone` }).click();
      // It is on this computer: said whole, and opened only once the user confirms it.
      await expect(card.getByRole('alert')).toContainText(`${url} is on this computer or your local network`);
      await card.getByRole('button', { name: 'Open it all the same' }).click();

      const panel = page.getByRole('dialog', { name: 'A browser for you alone' });
      await expect(panel).toBeVisible();
      await expect(panel.getByLabel('Address')).toHaveValue(url);
      // Its line shows whole, wrapped where it must: that it starts signed in to no site too.
      const why = panel.locator('.handover-why');
      await expect(why).toContainText('This browser starts signed in to no site');
      expect(await why.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      // Three clicks on the token select it; the server reads the selection and keeps it.
      const token = await onPage(page, 0.5, 0.25);
      await page.mouse.click(token.x, token.y, { clickCount: 3 });
      await panel.getByRole('button', { name: 'Save selection as E2E_TOKEN' }).click();
      // The card had one ask: it is answered, the browser closes, and the team gets the name.
      await expect(panel).toBeHidden();
      await expect(card).toContainText('Saved from the page');
      await expect(page.locator('.msg-user').last()).toContainText('I gave E2E_TOKEN');
      // Nothing of the value on the page, nor in what the server sends of the chat or Settings.
      await expect(page.locator('body')).not.toContainText(TOKEN);
      const conv = page.url().split('/c/')[1]!;
      expect(JSON.stringify(await relay.api(`/api/conversations/${decodeURIComponent(conv)}`))).not.toContain(TOKEN);
      const view = await relay.api<{ folders: { secrets: { name: string }[] }[] }>('/api/handoffs');
      expect(view.folders.flatMap((f) => f.secrets.map((x) => x.name))).toEqual(['E2E_TOKEN']);
      expect(JSON.stringify(view)).not.toContain(TOKEN);
      // Its throwaway profile went with it.
      await expect
        .poll(() => (existsSync(join(relay.dataDir, 'browser', 'user')) ? readdirSync(join(relay.dataDir, 'browser', 'user')) : []))
        .toEqual([]);
    } finally {
      site.close();
    }
  });

  test.describe('where this computer shows windows (headless here)', () => {
    test.use({ serverEnv: async ({}, use) => use({ RELAY_BROWSER: await aBrowser(), RELAY_HEADLESS_WINDOWS: 'on' }) });

    test('a secret from a page in a window: the card offers it, hears it closed, Close closes it, and the selection made there is saved', async ({
      page,
      relay,
    }) => {
      const TOKEN = 'tok-e2e-in-window-93ad';
      // A token page that selects its token itself: nobody can drag a mouse in a headless window.
      const site = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          `<title>Your token</title><p id="t">${TOKEN}</p><script>getSelection().selectAllChildren(document.getElementById('t'))</script>`,
        );
      });
      await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
      const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/token`;
      const host = new URL(url).host;
      try {
        await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'A secret in a window');
        await send(page, `Set up posting e2e:secret e2e:secreturl=${url}`);
        const card = page.getByRole('region', { name: 'Secrets @Claude asks for' });
        await expect(card).toContainText('In a window, it opens on the computer Harness Relay runs on');
        // The chat is at 127.0.0.1, as on the computer Harness Relay runs on: the window is the way offered first.
        const inWindow = card.getByRole('button', { name: `Open ${host} in a window` });
        await expect(inWindow).toHaveClass(/primary/);
        await expect(card.getByRole('button', { name: `Open ${host} in a browser for you alone` })).toBeVisible();
        await inWindow.click();
        // On this computer: said whole, and opened only once the user confirms it, in the window still.
        await expect(card.getByRole('alert')).toContainText(`${url} is on this computer or your local network`);
        const opened = page.waitForResponse((r) => r.request().method() === 'POST' && /\/secrets\/[^/]+\/browser$/.test(r.url()) && r.ok());
        await card.getByRole('button', { name: 'Open it all the same' }).click();
        const res = await opened;
        const { handoverId, mode } = (await res.json()) as { handoverId: string; mode: string };
        expect(mode).toBe('window');
        const box = card.getByRole('group', { name: 'A browser for you alone' });
        await expect(box).toContainText('It is open in a window on the computer Harness Relay runs on');
        // No screencast: the page is in the window.
        await expect(page.getByRole('dialog', { name: 'A browser for you alone' })).toHaveCount(0);
        // The window closed there (the user closed it): the card hears it, and its box goes.
        const convId = new URL(res.url()).pathname.split('/')[3]!;
        await relay.api(`/api/conversations/${convId}/handovers/${handoverId}`, { body: { action: 'done' } });
        await expect(box).toHaveCount(0);

        // Opened again, Close on the card closes it.
        await inWindow.click();
        await card.getByRole('button', { name: 'Open it all the same' }).click();
        await expect(box).toBeVisible();
        await box.getByRole('button', { name: 'Close the browser' }).click();
        await expect(box).toHaveCount(0);
        await expect.poll(() => readdirSync(join(relay.dataDir, 'browser', 'user'))).toEqual([]);

        // Opened again: what the user selected there is saved from the card, and the window closes with it.
        await inWindow.click();
        await card.getByRole('button', { name: 'Open it all the same' }).click();
        await expect(box).toBeVisible();
        await expect(async () => {
          await box.getByRole('button', { name: 'Save selection as E2E_TOKEN' }).click();
          await expect(card).toContainText('Saved from the page', { timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await expect(box).toHaveCount(0);
        await expect(page.locator('.msg-user').last()).toContainText('I gave E2E_TOKEN');
        await expect(page.locator('body')).not.toContainText(TOKEN);
        const view = await relay.api<{ folders: { secrets: { name: string }[] }[] }>('/api/handoffs');
        expect(view.folders.flatMap((f) => f.secrets.map((x) => x.name))).toEqual(['E2E_TOKEN']);
        await expect.poll(() => readdirSync(join(relay.dataDir, 'browser', 'user'))).toEqual([]);
      } finally {
        site.close();
      }
    });
  });

  test.describe('on a phone, in Chinese', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, lang: 'zh-TW' });

    test('a tap is a click, and the typing box types into the page', async ({ page, relay }) => {
      const site = await signInSite();
      try {
        await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { browser: ['claude'] } } });
        await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, '交接');
        // On a touch screen Enter is a new line: the send button sends.
        await composer(page).fill(askHandOver(site.url));
        await page.getByRole('button', { name: '送出' }).tap();
        const card = page.getByRole('region', { name: '@Claude 要把瀏覽器交給你' });
        await card.getByRole('button', { name: '在這裡顯示' }).click();
        const panel = page.getByRole('dialog', { name: '接手瀏覽器' });
        await expect(panel).toBeVisible();
        // The panel takes the whole screen, and the page is laid out to it.
        const box = (await panel.boundingBox())!;
        expect(box.width).toBeGreaterThan(380);
        const field = await onPage(page, 0.5, 0.25);
        await page.touchscreen.tap(field.x, field.y);
        await panel.getByLabel('輸入到網頁').click();
        await page.keyboard.insertText('手機');
        const button = await onPage(page, 0.5, 0.75);
        await page.touchscreen.tap(button.x, button.y);
        await expect.poll(() => site.posted).toEqual(['手機']);
        await panel.getByRole('button', { name: '完成，交回給 agent' }).click();
        const reply = await finishedReply(page, 'Claude', 60_000);
        await expect(reply).toContainText('The user took over the browser and handed it back.');
        await expect(reply.locator('.handover-done')).toContainText('已交回（在聊天中）');
      } finally {
        site.server.close();
      }
    });
  });
});
