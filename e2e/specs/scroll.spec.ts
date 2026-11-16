import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';

/*
 * Scrolling the chat: the messages follow new output until the reader scrolls up; then a round arrow in
 * the middle above the message box takes them back to their end, and they follow again (`showsToEnd`
 * and `followsAfterScroll` in src/web/chat.ts). `e2e:long` makes a reply taller than the window.
 */
const messages = (page: Page) => page.locator('.messages');
const toEnd = (page: Page) => page.getByRole('button', { name: 'Scroll to the latest message' });

/** How far the messages are from their end, in pixels. */
const fromEnd = (page: Page) => messages(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** The reader scrolls the messages up by `dy` with the mouse wheel, and waits for the scroll to end (it can be animated). */
async function wheelUp(page: Page, dy: number): Promise<number> {
  await messages(page).hover();
  await page.mouse.wheel(0, -dy);
  return messages(page).evaluate(async (el) => {
    let last = -1;
    while (el.scrollTop !== last) {
      last = el.scrollTop;
      await new Promise((done) => setTimeout(done, 150));
    }
    return last;
  });
}

test.describe('scrolling the chat', () => {
  test('scrolled up, the arrow in the middle above the message box takes the chat to its end, also from the keyboard', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Tell me everything e2e:long');
    await finishedReply(page, 'Claude');
    // At the end, following: no arrow.
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);

    await wheelUp(page, 600);
    await expect(toEnd(page)).toBeVisible();
    await expect(toEnd(page)).toHaveAttribute('title', 'Scroll to the latest message');
    // In the middle of the message box, above it, over the messages' last lines, its arrow in its middle.
    const [arrow, box, list, icon] = await Promise.all([
      toEnd(page).boundingBox(),
      page.locator('.composer').boundingBox(),
      messages(page).boundingBox(),
      toEnd(page).locator('svg').boundingBox(),
    ]);
    expect(Math.abs(arrow!.x + arrow!.width / 2 - (box!.x + box!.width / 2))).toBeLessThanOrEqual(1);
    expect(arrow!.y + arrow!.height).toBeLessThan(box!.y);
    expect(arrow!.y).toBeGreaterThan(list!.y);
    expect(arrow!.y + arrow!.height).toBeLessThan(list!.y + list!.height);
    expect(Math.abs(icon!.x + icon!.width / 2 - (arrow!.x + arrow!.width / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(icon!.y + icon!.height / 2 - (arrow!.y + arrow!.height / 2))).toBeLessThanOrEqual(0.5);
    // Nothing of the messages is over it.
    expect(
      await toEnd(page).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }),
    ).toBe(true);

    await toEnd(page).click();
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);

    // From the keyboard: once the chat is at its end, the arrow is gone and focus goes on to the message box.
    await wheelUp(page, 600);
    await toEnd(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();

    // Scrolling down to the end by hand hides it too.
    await wheelUp(page, 600);
    await expect(toEnd(page)).toBeVisible();
    await page.mouse.wheel(0, 5000);
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);

    // With reduced motion, the chat is at its end at once, with no smooth scroll.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await wheelUp(page, 600);
    await toEnd(page).click();
    expect(await fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);
  });

  test('while a reply streams, a reader who scrolls up stays there with the arrow, which then follows the reply to its end', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    // Its paragraphs come one after another over fifteen seconds.
    await send(page, 'Tell me everything e2e:long e2e:slow=15');
    // Once the reply is taller than the window, with much of it still to come; following it, no arrow.
    await expect.poll(() => messages(page).evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 30_000 }).toBeGreaterThan(200);
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(page.locator('.live-tag')).toHaveCount(1);
    await expect(toEnd(page)).toHaveCount(0);

    const top = await wheelUp(page, 300);
    await expect(toEnd(page)).toBeVisible();
    // More comes in below, and the reader stays where they scrolled to.
    const behind = await fromEnd(page);
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(behind + 100);
    expect(Math.abs((await messages(page).evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toBeVisible();

    await toEnd(page).click();
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);
    // Following again: the rest of the reply comes in under it, and the chat stays at its end.
    await expect(page.locator('.live-tag')).toHaveCount(1);
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('Padding paragraph 40 of a long reply.');
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);
  });
});
