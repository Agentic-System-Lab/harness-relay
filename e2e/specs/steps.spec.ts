import { devices, type Locator, type Page } from '@playwright/test';
import type { StepsPart } from '../../src/shared/steps';
import type { Conversation } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, replies, send } from '../support/app';

/*
 * Steps cards: a member that gives the user steps to take outside Harness Relay (a `<steps>` block,
 * `e2e:steps`) waits for them as for a question; the user ticks each step (kept on the server), then
 * answers with Done or "I'm stuck", and the member that asked goes on first.
 */

const STEPS = ['Open the example console and create an app.', 'Copy the app ID.', 'Turn on the API under Use cases.'];

/**
 * A chat whose Claude gave the user steps, and Grok waits after it: the steps card (the first reply's,
 * also once Claude has replied again). `touch`: sent with the send button, as on a touch screen,
 * where Enter is a new line.
 */
async function stepsCard(page: Page, relay: Parameters<typeof openTeamChat>[1], touch = false): Promise<{ id: string; card: Locator }> {
  const id = await openTeamChat(page, relay, [
    { name: 'Claude', provider: 'claude' },
    { name: 'Grok', provider: 'grok' },
  ]);
  const question = 'Connect the app e2e:steps@claude';
  if (touch) {
    await composer(page).fill(question);
    await page.getByRole('button', { name: 'Send' }).tap();
  } else {
    await send(page, question);
  }
  const asked = await finishedReply(page, 'Claude');
  await expect(asked).toContainText('Please set up the app, then come back.');
  await expect(asked).not.toContainText('<steps>');
  return { id, card: page.locator('.steps-card').first() };
}

const box = (card: Locator, n: number) => card.getByRole('checkbox', { name: new RegExp(`^${n}\\. `) });

/** The steps the server has ticked, of the chat's first steps card. */
const ticked = (conv: Conversation) =>
  conv.messages
    .flatMap((m) => m.parts)
    .find((p): p is StepsPart => p.type === 'steps')
    ?.items.map((i) => Boolean(i.done));

test.describe('steps cards', () => {
  test('a member’s steps are ticked as the user goes, kept for a reload and another tab, then Done goes on with that member first', async ({
    page,
    relay,
  }) => {
    const { id, card } = await stepsCard(page, relay);
    await expect(card).toContainText('Steps from @Claude');
    await expect(card).toContainText('0 of 3 done');
    await expect(card.getByRole('checkbox')).toHaveCount(3);
    for (const [i, step] of STEPS.entries()) await expect(box(card, i + 1)).toHaveAccessibleName(`${i + 1}. ${step}`);
    // Its link opens elsewhere, as a reply's does.
    const link = card.getByRole('link', { name: 'the example console' });
    await expect(link).toHaveAttribute('href', 'https://example.com/console');
    await expect(link).toHaveAttribute('target', '_blank');
    // The team waits for the user: Grok has not spoken.
    await expect(replies(page, 'Grok')).toHaveCount(0);
    await expect(page.locator('.approval-banner')).toHaveText('☑ Steps waiting for you: @Claude');
    await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Answer needed');
    await expect(page.locator('.ask-card')).toHaveCount(0);
    await expect(composer(page)).toHaveAttribute('placeholder', 'Answer @Claude…');

    // Ticked with the keyboard, and kept across a reload.
    await box(card, 1).focus();
    await page.keyboard.press('Space');
    await expect(box(card, 1)).toBeChecked();
    await expect(card).toContainText('1 of 3 done');
    await expect.poll(async () => ticked(await relay.api<Conversation>(`/api/conversations/${id}`))).toEqual([true, false, false]);
    await page.reload();
    await expect(box(card, 1)).toBeChecked();

    // Another tab ticks the third step: this one shows it.
    const other = await page.context().newPage();
    await other.goto(`${relay.base}/#/c/${id}`);
    const there = other.locator('.steps-card');
    await expect(box(there, 1)).toBeChecked();
    await box(there, 3).check();
    await expect(box(card, 3)).toBeChecked();
    await other.close();

    await card.getByLabel('Note (optional)').fill('The app is called Relay.');
    await expect(card).toContainText("Steps you didn't tick are reported as not done.");
    await card.getByRole('button', { name: 'Send (2 of 3 done)' }).click();

    const answer = page.locator('.msg-user').last();
    await expect(answer).toContainText('I did 2 of the 3 steps @Claude gave me.');
    await expect(answer).toContainText('[not done] Copy the app ID.');
    await expect(answer).toContainText('Note: The app is called Relay.');
    // Claude answers first, with the user's answer in hand; then Grok, who waited.
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await expect(await finishedReply(page, 'Claude')).toContainText('Thanks, Claude got your answer');
    await expect(await finishedReply(page, 'Grok')).toContainText('I did 2 of the 3 steps @Claude gave me.');
    // Answered: what the user sent, and nothing more to change.
    await expect(card).toContainText('Answered');
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.locator('.step-done')).toHaveCount(2);
    await expect(card).toContainText('Note The app is called Relay.');
    await expect(page.locator('.approval-banner')).toHaveCount(0);
  });

  test('“I’m stuck” says at which step, with a note, and the member goes on from there', async ({ page, relay }) => {
    const { card } = await stepsCard(page, relay);
    await box(card, 1).check();
    await card.getByRole('button', { name: "I'm stuck" }).click();
    // Where the user is stuck is asked first: the first step not ticked.
    const where = card.getByLabel('Stuck at');
    await expect(where).toBeFocused();
    await expect(where).toHaveValue('1');
    await where.selectOption({ label: 'Step 3: Turn on the API under Use cases.' });
    await card.getByPlaceholder('What went wrong? What does the page say?').fill('There is no Use cases tab.');
    await card.getByRole('button', { name: 'Send', exact: true }).click();

    const answer = page.locator('.msg-user').last();
    await expect(answer).toContainText("I'm stuck at step 3 of the 3 steps @Claude gave me (1 done).");
    await expect(answer).toContainText('[stuck here] Turn on the API under Use cases.');
    await expect(await finishedReply(page, 'Claude')).toContainText('There is no Use cases tab.');
    await expect(card).toContainText('Stuck at step 3');
    await expect(card.locator('.step-stuck')).toContainText('3.');
  });

  test('a free-text answer instead leaves the card as it was, no longer waited for', async ({ page, relay }) => {
    const { card } = await stepsCard(page, relay);
    await box(card, 2).check();
    await send(page, 'All done, the ID is 42.');
    await expect(await finishedReply(page, 'Grok')).toContainText('All done, the ID is 42.');
    await expect(card).toContainText('The team is no longer waiting for these steps.');
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await expect(card.locator('.step-done')).toHaveCount(1);
  });

  test.describe('on a phone', () => {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
    test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

    test('the card fits the screen, and its steps are ticked and answered by touch', async ({ page, relay, browserName }) => {
      test.skip(browserName === 'firefox', 'no mobile emulation in Firefox');
      const { card } = await stepsCard(page, relay, true);
      const width = page.viewportSize()!.width;
      const bounds = (await card.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      // Each box is a large enough target for a finger.
      const target = (await box(card, 1).boundingBox())!;
      expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(40);
      for (const n of [1, 2, 3]) await box(card, n).tap();
      for (const n of [1, 2, 3]) await expect(box(card, n)).toBeChecked();
      await card.getByRole('button', { name: 'Done', exact: true }).tap();
      await expect(page.locator('.msg-user').last()).toContainText('I did all 3 steps @Claude gave me.');
      await expect(card).toContainText('Answered');
    });
  });
});
