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

/** Waits for the arrow to come to rest: it fades in from 6px lower. */
const atRest = (page: Page) => toEnd(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

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
  test('scrolled up, the arrow in the middle above the message box takes the chat to its end, also from the keyboard', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Tell me everything e2e:long');
    await finishedReply(page, 'Claude');
    // At the end, following: no arrow.
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);

    // Half a message typed, the reader scrolls up to check something.
    await composer(page).fill('Half a thought');
    await wheelUp(page, 600);
    await expect(toEnd(page)).toBeVisible();
    await expect(toEnd(page)).toHaveAttribute('title', 'Scroll to the latest message');
    await atRest(page);
    // In the middle of the message box, above it, over the messages' last lines, its arrow in its middle.
    const [arrow, box, list, icon] = await Promise.all([
      toEnd(page).boundingBox(),
      page.locator('.composer').boundingBox(),
      messages(page).boundingBox(),
      toEnd(page).locator('svg').boundingBox(),
    ]);
    expect(Math.abs(arrow!.x + arrow!.width / 2 - (box!.x + box!.width / 2))).toBeLessThanOrEqual(1);
    expect(arrow!.y + arrow!.height).toBeLessThan(box!.y);
    const gap = list!.y + list!.height - (arrow!.y + arrow!.height);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(24);
    expect(Math.abs(icon!.x + icon!.width / 2 - (arrow!.x + arrow!.width / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(icon!.y + icon!.height / 2 - (arrow!.y + arrow!.height / 2))).toBeLessThanOrEqual(0.5);
    // Nothing of the messages is over it.
    expect(
      await toEnd(page).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }),
    ).toBe(true);

    // A click takes the chat to its end, and the message box keeps the focus and what was typed.
    await toEnd(page).click();
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('Half a thought');

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

    // With reduced motion, the chat is at its end at once, with no smooth scroll; and a click with
    // the message box not focused leaves it so.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await composer(page).blur();
    await wheelUp(page, 600);
    await toEnd(page).click();
    expect(await fromEnd(page)).toBeLessThanOrEqual(1);
    await expect(toEnd(page)).toHaveCount(0);
    await expect(composer(page)).not.toBeFocused();
  });

  test('the arrow stands above messages waiting in the tray, and the @mention list hides it while open', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Tell me everything e2e:long e2e:slow=15');
    await expect.poll(() => messages(page).evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 30_000 }).toBeGreaterThan(200);
    // Sent while the team replies, a message waits in the tray above the message box.
    await composer(page).fill('And then?');
    await composer(page).press('Enter');
    const tray = page.locator('.queue-tray');
    await expect(tray).toBeVisible();

    await wheelUp(page, 300);
    await expect(toEnd(page)).toBeVisible();
    await atRest(page);
    const [arrow, above, box] = [
      (await toEnd(page).boundingBox())!,
      (await tray.boundingBox())!,
      (await page.locator('.composer').boundingBox())!,
    ];
    expect(arrow.y + arrow.height).toBeLessThan(above.y);
    expect(Math.abs(arrow.x + arrow.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(1);

    // Typing @ opens the list of members over the messages, where the arrow would stand: it goes while the list is open.
    await composer(page).fill('@');
    await expect(page.locator('.mention-menu')).toBeVisible();
    await expect(toEnd(page)).toBeHidden();
    await composer(page).fill('');
    await expect(page.locator('.mention-menu')).toHaveCount(0);
    await expect(toEnd(page)).toBeVisible();
  });

  test('while a reply streams, a reader who scrolls up stays there with the arrow, which then follows the reply to its end', async ({
    page,
    relay,
  }) => {
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
