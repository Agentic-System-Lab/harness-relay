import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { LEAD_REVIEW, awaitingPlan, composer, finishedReply, openNewChat, openTeamChat, reviewCards, send, settled, startChat } from '../support/app';

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

    // Every new chat starts with it off, whatever the last one had.
    await openNewChat(page);
    await expect(page.getByRole('checkbox', { name: LEAD_REVIEW })).not.toBeChecked();
  });

  test("is off unless the chat asks for it, and once turned on in the chat's team settings reads the latest question's replies", async ({ page, relay }) => {
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
    // Its first review reads the question the team just answered; what came before is context.
    await expect(reviewCards(page)).toContainText('The fake lead agent read 1 reply.');
    await expect(reviewCards(page)).toContainText('Read 1 reply');
    const prompt = relay.fakeLog().findLast((e) => e.prompt?.includes('with your review'))!.prompt!;
    expect(prompt).toContain('<conversation>\n[User]: First');
    expect(prompt).toContain('<recent>\n<message from="user">\nSecond\n</message>');
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
    const prompt = relay.fakeLog().findLast((e) => e.prompt?.includes('with your review'))!.prompt!;
    expect(prompt).toContain('<message from="user">\nGo e2e:slowreview\n</message>');
    expect(prompt).toContain('<reply n="2" from="@Claude (Claude Code)">');
  });

  test('the lead agent turns it on when it designs a team, and the team design card has the box and says why', async ({ page, relay }) => {
    const id = await startChat(page, { leadReview: false });
    await send(page, 'Build and check it e2e:leadreview');
    const card = awaitingPlan(page);
    const box = card.getByRole('checkbox', { name: LEAD_REVIEW });
    await expect(box).toBeChecked();
    await expect(card).toContainText('The lead agent turned the review on for this team: The fake lead agent wants to review what this team says.');
    await expect(card).toContainText('Each time the team has answered, the lead agent reads the new replies');
    // On at once, before the team is confirmed.
    expect((await relay.api<{ settings: { leadReview?: boolean } }>(`/api/conversations/${id}`)).settings.leadReview).toBe(true);
    await card.getByRole('button', { name: 'Confirm team' }).click();
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page)).toHaveCount(1);
    await expect(reviewCards(page)).toContainText('The fake lead agent read 1 reply.');

    // The box turns it off, and the next answer is not reviewed.
    const latest = page.locator('.plan-card').filter({ has: page.getByRole('checkbox', { name: LEAD_REVIEW }) });
    await latest.getByRole('checkbox', { name: LEAD_REVIEW }).uncheck();
    await expect.poll(async () => (await relay.api<{ settings: { leadReview?: boolean } }>(`/api/conversations/${id}`)).settings.leadReview).toBeUndefined();
    await send(page, '@Claude one more thing');
    await expect(await finishedReply(page, 'Claude')).toContainText('one more thing');
    await settled(relay, id);
    await expect(reviewCards(page)).toHaveCount(1);
  });

  test('a design leaves it as it is when it is on already', async ({ page, relay }) => {
    await startChat(page, { leadReview: true });
    await send(page, 'Build it e2e:leadreview');
    const card = awaitingPlan(page);
    await expect(card.getByRole('checkbox', { name: LEAD_REVIEW })).toBeChecked();
    await expect(card).not.toContainText('turned the review on');
    // The lead agent was not offered it.
    expect(relay.fakeLog().some((e) => e.prompt?.includes('Lead review is off in this conversation'))).toBe(false);
  });

  test("a shared chat keeps the lead agent's review and why it turned it on, without the app's buttons or the box", async ({ page, relay }) => {
    const id = await startChat(page, { autoConfirm: true, title: 'Reviewed chat' });
    await send(page, 'Check my plan e2e:leadreview');
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page)).toContainText('Suggested next steps');
    await settled(relay, id);

    await page.locator('.chat-head').getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Share conversation' });
    await dialog.getByRole('button', { name: 'Create link' }).click();
    const link = dialog.getByRole('textbox', { name: 'Public link' });
    await expect(link).toHaveValue(/^https:\/\/gistpreview\.github\.io\/\?[0-9a-f]{32}$/);
    const gistId = (await link.inputValue()).split('?')[1]!;
    const html = readFileSync(join(relay.root, 'fake-github', 'gists', gistId, 'index.html'), 'utf8');
    const body = html.slice(html.indexOf('<body'));
    // The review: its summary, the point and the member it is about (as text), the steps.
    expect(body).toContain("Lead agent's review");
    expect(body).toContain('The fake lead agent read 1 reply.');
    expect(body).toMatch(/<span class="review-reply-link"[^>]*>@Claude<\/span>/);
    expect(body).toContain('Try the answer yourself.');
    // Why the lead agent turned it on stays; the box, the step's button and the reply's tag do not.
    expect(body).toContain('The lead agent turned the review on for this team');
    expect(body).not.toContain('class="plan-review"');
    expect(body).not.toContain('Ask the team');
    expect(body).not.toContain('to note');
    expect(body).not.toContain('<button');
  });

  test('marks words it quotes across the items of a list in the reply', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await send(page, 'List them e2e:markdown e2e:reviewquote=list');
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page).locator('.review-quote')).toHaveText('first point second point');
    await settled(relay, id);
    // One range from the first item into the second, read as the page shows it.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const h = CSS.highlights.get('review-risk');
          return h ? [...h].map((r) => (r as Range).toString().replace(/\s+/g, ' ')) : [];
        }),
      )
      .toEqual(['first point second point']);
  });

  test("the design card's box goes back when the server refuses the change, and says why", async ({ page }) => {
    await startChat(page);
    await send(page, 'Build it e2e:leadreview');
    const box = awaitingPlan(page).getByRole('checkbox', { name: LEAD_REVIEW });
    await expect(box).toBeChecked();
    await page.route('**/lead-review', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test' }) }),
    );
    await box.click();
    await expect(page.getByRole('alert')).toContainText('Refused for the test');
    await expect(box).toBeChecked();
  });
});

test.describe('lead review in Chinese, on a narrow phone', () => {
  test.use({ lang: 'zh-TW' });

  test('the review card is in Chinese and fits a 320px screen', async ({ page, relay }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await send(page, 'Check it e2e:markdown');
    await finishedReply(page, 'Claude');
    const card = reviewCards(page).last();
    await expect(card).toContainText('首席 agent 的審閱');
    await expect(card.locator('.review-kind')).toHaveText('風險');
    await expect(card).toContainText('建議的下一步');
    await expect(card).toContainText('讀了 1 則回覆');
    await expect(card.getByRole('button', { name: '交給團隊' })).toBeVisible();
    await settled(relay, id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  });
});
