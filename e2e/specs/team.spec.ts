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
});
