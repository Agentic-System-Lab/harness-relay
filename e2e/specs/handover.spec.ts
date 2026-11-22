import { chromium, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { findBrowser } from '../../src/server/browser/find';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';

/*
 * Taking over the chat's browser (`browser_hand_over`): the agent (Claude Code's fake, `e2e:mcp`) hands a
 * sign-in page to the user; the card says what stays with the chat's browser and offers to show the page
 * here; the user clicks and types into the screencast's panel (with a mouse, or a finger on a phone),
 * the page's server gets what they typed, and the agent hears only that they handed it back, with their
 * note. The window on the computer Harness Relay runs on is not opened here (it would open on the
 * developer's screen): its launch is tested in test/handover.test.ts.
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

/** The Chromium the chat's browser starts: the system's, else Playwright's (CI may have only its headless shell). */
async function aBrowser(): Promise<string> {
  const found = findBrowser({ configured: process.env.RELAY_BROWSER });
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
        await panel.getByRole('button', { name: '完成，交回給助理' }).click();
        const reply = await finishedReply(page, 'Claude', 60_000);
        await expect(reply).toContainText('The user took over the browser and handed it back.');
        await expect(reply.locator('.handover-done')).toContainText('已交回（在聊天中）');
      } finally {
        site.server.close();
      }
    });
  });
});
