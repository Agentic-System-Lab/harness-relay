import { expect, test } from '../fixtures';
import { LEAD_REVIEW, composer, finishedReply, openNewChat, openTeamChat, reviewCards, send, settled, startChat } from '../support/app';

/*
 * Lead review: once the team has answered, the lead agent reads its replies, marks what needs a closer
 * look and suggests the next steps. The fake lead agent flags the first words of the first reply as a
 * risk, and suggests a step for the user and one for the team (`reviewReply` in e2e/fake-cli/lib/plan.cjs).
 */
test.describe('lead review', () => {
  test("the lead agent reviews the team's replies, marks the words it quotes in the reply, and its next step for the team goes into the message box", async ({
    page,
    relay,
  }) => {
    const id = await startChat(page, { autoConfirm: true, leadReview: true });
    await send(page, 'Check my plan');
    const reply = await finishedReply(page, 'Claude');
    const card = reviewCards(page).last();
    await expect(card).toContainText("Lead agent's review");
    await expect(card).toContainText('The fake lead agent read 1 reply.');
    await expect(card.locator('.review-point')).toHaveCount(1);
    await expect(card.locator('.review-point')).toContainText('Risk');
    await expect(card.locator('.review-quote')).toHaveText('Hello from Claude (Claude');
    await expect(card).toContainText('The fake lead agent flags what @Claude said first.');
    await expect(card.locator('.review-step')).toHaveText([/You\s*Try the answer yourself\./, /Team\s*Ask @Claude to go on\.\s*Ask the team/]);

    // The words it quotes are marked in the reply (CSS Custom Highlight API), and the reply says so.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const h = CSS.highlights.get('review-risk');
          return h ? [...h].map((r) => (r as Range).toString()) : [];
        }),
      )
      .toEqual(['Hello from Claude (Claude']);
    const tag = reply.getByRole('button', { name: /1 to note/ });
    await expect(tag).toBeVisible();
    await tag.click();
    await expect(card).toHaveClass(/flash/);
    await card.getByRole('button', { name: '@Claude' }).click();
    await expect(reply).toHaveClass(/flash/);

    await card.getByRole('button', { name: 'Ask the team' }).click();
    await expect(composer(page)).toHaveValue('@Claude please go on with the next part.');

    // The lead agent read the reply as it was written, and ran on its own state.
    const conv = await settled(relay, id);
    expect(conv.settings.leadReview).toBe(true);
    expect(relay.fakeLog().some((e) => e.prompt?.includes('<reply n="1" from="@Claude (Claude Code)">\nHello from Claude'))).toBe(true);

    // The next new chat starts the same way.
    await openNewChat(page);
    await expect(page.getByRole('checkbox', { name: LEAD_REVIEW })).toBeChecked();
  });

  test("is off unless the chat asks for it, and once turned on in the chat's team settings reads every reply since", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'First');
    await finishedReply(page, 'Claude');
    await settled(relay, id);
    await expect(reviewCards(page)).toHaveCount(0);

    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.getByRole('checkbox', { name: LEAD_REVIEW }).check();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();

    await send(page, 'Second');
    await expect(reviewCards(page)).toHaveCount(1);
    await expect(reviewCards(page)).toContainText('The fake lead agent read 2 replies.');
    await expect(reviewCards(page)).toContainText('Read 2 replies');
  });

  test("is stopped by Stop, and says so when it cannot read the lead agent's answer", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await send(page, 'Go e2e:slowreview');
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page).last()).toContainText("The lead agent (Claude Code) is reviewing the team's replies…");
    await expect(composer(page)).toHaveAttribute('placeholder', /The lead agent is reviewing the replies/);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(reviewCards(page).last()).toContainText('The review was stopped');
    await settled(relay, id);

    // The next review reads these replies again, with the new ones.
    await send(page, 'Again e2e:badreview');
    await expect(reviewCards(page)).toHaveCount(2);
    await expect(reviewCards(page).last()).toContainText('The lead agent could not review these replies (no JSON review found in the reply)');
  });
});
