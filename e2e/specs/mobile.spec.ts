import { devices } from '@playwright/test';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat } from '../support/app';

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
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
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
});

