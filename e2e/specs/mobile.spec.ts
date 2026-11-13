import { devices } from '@playwright/test';
import { expect, test } from '../fixtures';
import { composer, finishedReply, homePage, openTeamChat } from '../support/app';

// A phone's screen, the way the chat is used over Tailscale (docs/remote-access.md).
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];

test.describe('on a phone', () => {
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  // Firefox has no mobile emulation.
  test.skip(({ browserName }) => browserName === 'firefox', 'no mobile emulation in Firefox');

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

  test('a long message keeps the page from scrolling sideways', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await composer(page).fill(`A very long word: ${'x'.repeat(300)} e2e:markdown`);
    await page.getByRole('button', { name: 'Send' }).tap();
    await finishedReply(page, 'Claude');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
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

