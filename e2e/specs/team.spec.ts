import type { Locator } from '@playwright/test';
import { PROVIDERS } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { askAndConfirm, awaitingPlan, finishedReply, openTeamChat, replies, send, settled, startChat } from '../support/app';

test.describe("changing a chat's team", () => {
  test('the lead agent changes the team when asked, and the new member answers once it is saved', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.getByRole('textbox', { name: 'Ask the lead agent' }).fill('Add a second opinion e2e:add=grok');
    await drawer.getByRole('button', { name: 'Ask the lead agent' }).click();
    await expect(drawer).toContainText('added @Grok (Grok)');
    await expect(drawer).toContainText('The team below is changed. Review it, then press Save to use it.');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    // The lead agent got the team and the request.
    expect(relay.fakeLog().some((e) => e.prompt?.includes('<request>\nAdd a second opinion e2e:add=grok\n</request>'))).toBe(true);

    await send(page, 'What do you both think?');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “What do you both think?”.');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “What do you both think?”.');
    const conv = await settled(relay, id);
    expect(conv.agents.map((a) => `${a.name}/${a.provider}`)).toEqual(['Claude/claude', 'Grok/grok']);
  });

  test("when the lead agent's answer cannot be read, a template stands in", async ({ page }) => {
    await startChat(page);
    await send(page, 'Pick something e2e:badplan');
    const card = awaitingPlan(page);
    await expect(card).toContainText('Using the template "General-question panel" instead');
    await card.getByRole('button', { name: 'Confirm team' }).click();
    for (const name of ['Analyst', 'Critic', 'Synthesizer']) await expect(await finishedReply(page, name)).toContainText('You said: “Pick something”.');
  });

  test('a team proposed for a new question can be declined, and the current team answers', async ({ page }) => {
    await startChat(page);
    await askAndConfirm(page, 'First');
    await finishedReply(page, 'Claude');
    await send(page, 'Second e2e:team=codex');
    const card = awaitingPlan(page);
    await expect(card).toContainText('@Codex');
    await card.getByRole('button', { name: 'No, keep the current team' }).click();
    await expect(page.locator('.plan-card').last()).toContainText('Not used; the current team answered');
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “Second”.');
    await expect(replies(page, 'Codex')).toHaveCount(0);
  });

  test('the add card is as tall as the members beside it with a shadow while more CLIs are below, lists every CLI on a row of its own, and one tall card stretches only its row', async ({ page, relay }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    const members = drawer.locator('.agent-card:not(.add-card)');
    const add = drawer.locator('.add-card');
    const height = async (card: Locator) => (await card.boundingBox())!.height;
    const list = add.locator('.add-card-list');
    const scrolls = () => list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    /** The shadow along the list's bottom edge, which says that more CLIs are below. */
    const shadow = () => list.evaluate((el) => getComputedStyle(el, '::after').opacity);
    // Only where the browser has scroll-driven animations (Chromium, Safari); elsewhere there is none.
    const timelines = await page.evaluate(() => CSS.supports('animation-timeline: scroll()'));
    await expect(members).toHaveCount(1);
    // The drawer has two columns here.
    expect(await drawer.locator('.agent-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);
    await expect(add.getByRole('button', { name: /^＋ / })).toHaveCount(PROVIDERS.length);

    // Beside a member: its height, not that of a button for every CLI, and the list scrolls.
    expect(Math.abs((await height(add)) - (await height(members.first())))).toBeLessThanOrEqual(1);
    expect(await scrolls()).toBe(true);
    // The shadow shows while more are below, and is gone once the list is scrolled to its end.
    if (timelines) {
      await expect.poll(shadow).toBe('1');
      await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect.poll(shadow).toBe('0');
    }

    // Two members fill the first row: on a row of its own, every CLI is listed without scrolling.
    await add.getByRole('button', { name: '＋ Codex' }).click();
    await expect(members).toHaveCount(2);
    expect(await scrolls()).toBe(false);
    if (timelines) await expect.poll(shadow).toBe('0');

    // A third member: beside it again.
    await add.getByRole('button', { name: '＋ Grok' }).click();
    await expect(members).toHaveCount(3);
    const third = await height(members.nth(2));
    expect(Math.abs((await height(add)) - third)).toBeLessThanOrEqual(1);
    expect(await scrolls()).toBe(true);
    // A role box made taller (its corner dragged) stretches the first row, not the second.
    await members.first().locator('textarea').evaluate((el) => void ((el as HTMLElement).style.height = '500px'));
    expect(await height(members.first())).toBeGreaterThan(third + 200);
    expect(Math.abs((await height(members.nth(2))) - third)).toBeLessThanOrEqual(1);
    expect(Math.abs((await height(add)) - third)).toBeLessThanOrEqual(1);
  });
});
