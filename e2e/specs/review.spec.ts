import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import type { RelayServer } from '../support/relay';
import { fakeGithub, openShared } from '../support/share';
import {
  LEAD_REVIEW,
  awaitingPlan,
  composer,
  finishedReply,
  openNewChat,
  openTeamChat,
  replies,
  reviewCards,
  send,
  settled,
  startChat,
} from '../support/app';

/*
 * Lead review: once the team has answered, the lead agent reads its replies, marks what needs a closer
 * look and suggests the next steps. The fake lead agent flags the first words of the first reply as a
 * risk, and suggests a step for the user and one for the team (`reviewReply` in e2e/fake-cli/lib/plan.cjs).
 */
/** Shares the open chat as a link (into the fake `gh`'s gist) and returns the page made, its body and the gist's id. */
async function shareOpenChat(page: Page, relay: RelayServer): Promise<{ html: string; body: string; gistId: string; url: string }> {
  await page.locator('.chat-head').getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share conversation' });
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const link = dialog.getByRole('textbox', { name: 'Public link' });
  await expect(link).toHaveValue(/^https:\/\/agentic-system-lab\.github\.io\/harness-relay\/share\/#relay-e2e\/[0-9a-f]{32}$/);
  const url = await link.inputValue();
  const gistId = url.split('/').pop()!;
  const html = readFileSync(join(relay.root, 'fake-github', 'gists', gistId, 'index.html'), 'utf8');
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  return { html, body: html.slice(html.indexOf('<body')), gistId, url };
}

/** The words a review point's @name just jumped to (the `review-focus` highlight). */
const focusedWords = (page: Page) =>
  page.evaluate(() => [...(CSS.highlights.get('review-focus') ?? [])].map((r) => (r as Range).toString()));

/** How far the middle of the latest `review-<kind>` mark is from the middle of the chat's message list, in pixels; null when there is none. */
const markOffCentre = (page: Page, kind: string) =>
  page.evaluate((kind) => {
    const range = [...(CSS.highlights.get(`review-${kind}`) ?? [])].at(-1) as Range | undefined;
    const box = document.querySelector('.messages')!.getBoundingClientRect();
    const rect = range?.getBoundingClientRect();
    return rect ? Math.round(Math.abs(rect.top + rect.height / 2 - (box.top + box.height / 2))) : null;
  }, kind);

test.describe('lead review', () => {
  test("the lead agent reviews the team's replies, marks the words it quotes in the reply, and its next step for the team goes into the message box", async ({
    page,
    relay,
  }) => {
    const id = await startChat(page, 'Check my plan', { autoConfirm: true, leadReview: true });
    const reply = await finishedReply(page, 'Claude');
    const card = reviewCards(page).last();
    await expect(card).toContainText("Lead agent's review");
    await expect(card).toContainText('The fake lead agent read 1 reply.');
    await expect(card.locator('.review-point')).toHaveCount(1);
    await expect(card.locator('.review-point')).toContainText('Risk');
    await expect(card.locator('.review-quote')).toHaveText('Hello from Claude (Claude');
    await expect(card).toContainText('The fake lead agent flags what @Claude said first.');
    await expect(card.locator('.review-step')).toHaveText([
      /You\s*Try the answer yourself\./,
      /Team\s*Ask @Claude to go on\.\s*Ask the team/,
    ]);

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
    // The point's @name goes to the words it quotes, shown for a moment over their mark, and focus goes to their reply.
    await card.getByRole('button', { name: '@Claude' }).click();
    await expect.poll(() => focusedWords(page)).toEqual(['Hello from Claude (Claude']);
    await expect(reply).toBeFocused();
    await expect.poll(() => focusedWords(page), { timeout: 5_000 }).toEqual([]);

    await card.getByRole('button', { name: 'Ask the team' }).click();
    await expect(composer(page)).toHaveValue('@Claude please go on with the next part.');

    // Sent, it is answered and reviewed in turn: the first reply keeps its one mark, the new one has its own.
    await composer(page).press('Enter');
    await expect(reviewCards(page)).toHaveCount(2);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const h = CSS.highlights.get('review-risk');
          return h ? [...h].map((r) => (r as Range).toString()) : [];
        }),
      )
      .toEqual(['Hello from Claude (Claude', 'Hello from Claude (Claude']);

    // The lead agent read the reply as it was written, and ran on its own state.
    const conv = await settled(relay, id);
    expect(conv.settings.leadReview).toBe(true);
    expect(relay.fakeLog().some((e) => e.prompt?.includes('<reply n="1" from="@Claude (Claude Code)">\nHello from Claude'))).toBe(true);

    // Every new chat starts with it on, whatever the last one had.
    await startChat(page, 'Check the draft', { leadReview: false });
    await openNewChat(page);
    await expect(page.locator('.first-task-actions').getByRole('checkbox', { name: LEAD_REVIEW })).toBeChecked();
  });

  test("is off unless the chat asks for it, and once turned on in the chat's team settings reads the latest question's replies", async ({
    page,
    relay,
  }) => {
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
    // While it reviews, its card shows the team design card's mark, turning; stopped, its ✦ instead.
    const mark = reviewCards(page).last().locator('.logo-motion.plan-logo.turning');
    await expect(mark).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(reviewCards(page).last()).toContainText('The review was stopped');
    await expect(mark).toHaveCount(0);
    await expect(reviewCards(page).last().locator('.plan-logo-stopped')).toHaveText('✦');
    await settled(relay, id);

    // The next review reads these replies again, with the new ones.
    await send(page, 'Again e2e:badreview');
    await expect(reviewCards(page)).toHaveCount(2);
    await expect(reviewCards(page).last()).toContainText(
      'The lead agent could not review these replies (no JSON review found in the reply)',
    );
    const prompt = relay.fakeLog().findLast((e) => e.prompt?.includes('with your review'))!.prompt!;
    expect(prompt).toContain('<message from="user">\nGo e2e:slowreview\n</message>');
    expect(prompt).toContain('<reply n="2" from="@Claude (Claude Code)">');
  });

  test('a message sent during a review stops it and goes at once, the next review reads from where the stopped one started, and Team settings can switch it off mid-review', async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await send(page, 'Go e2e:slowreview');
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page).last()).toContainText('is reviewing');
    // The message box says sending now stops the review and sends the message at once.
    await expect(page.locator('.composer-hint')).toContainText('Enter to stop the review and send it now');
    await expect(composer(page)).toHaveAttribute('placeholder', /sending a message stops the review and sends it now/);
    // Whether the queue tray shows at any moment from now on: it never does, as nothing waits.
    await page.evaluate(() => {
      const seen = window as unknown as { trayShown?: boolean };
      seen.trayShown = false;
      new MutationObserver(() => {
        if (document.querySelector('.queue-tray')) seen.trayShown = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await composer(page).fill('And this');
    await composer(page).press('Enter');
    await expect(reviewCards(page).first()).toContainText('The review was stopped');
    await expect(page.locator('.msg-user').last()).toContainText('And this');

    // The next review reads from where the stopped one started: slow again, as it reads the first
    // message too. Team settings can be saved now with only the box changed, and switching it off
    // stops that review too.
    await expect(reviewCards(page)).toHaveCount(2);
    await expect(reviewCards(page).last()).toContainText('is reviewing');
    const lastReview = () => relay.fakeLog().findLast((e) => e.prompt?.includes('with your review'))?.prompt ?? '';
    await expect.poll(lastReview).toContain('<message from="user">\nAnd this\n</message>');
    expect(lastReview()).toContain('<message from="user">\nGo e2e:slowreview\n</message>');
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await expect(drawer).toContainText('lead review alone can be saved now');
    const save = drawer.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
    await drawer.getByRole('checkbox', { name: LEAD_REVIEW }).uncheck();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(drawer).toBeHidden();
    // Its card says lead review is off now; the first stopped one, too.
    await expect(reviewCards(page).last()).toContainText('The review was stopped. Lead review is off now');
    await expect(reviewCards(page).first()).toContainText('Lead review is off now');
    const conv = await settled(relay, id);
    expect(conv.settings.leadReview).toBeUndefined();
    expect(conv.queue ?? []).toHaveLength(0);
    await expect(page.locator('.msg-system').filter({ hasText: /^Stopped\.$/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { trayShown?: boolean }).trayShown)).toBe(false);
  });

  test('a schedule\'s message that comes due during a review waits for it in the tray, and "Skip the review and send now" sends it now', async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await relay.api(`/api/conversations/${id}/schedule`, {
      method: 'PUT',
      body: { text: 'Scheduled check', repeat: { kind: 'interval', hours: 24 }, approvals: 'deny', missed: 'skip', enabled: true },
    });
    await send(page, 'Go e2e:slowreview');
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page).last()).toContainText('is reviewing');
    // Sent now, as when it comes due: it waits for the review.
    await relay.api(`/api/conversations/${id}/schedule/run`, { body: {} });
    const tray = page.locator('.queue-tray');
    await expect(tray.locator('.queue-title')).toHaveText('1 waiting');
    await expect(tray).toContainText('Sent once the lead agent has reviewed the replies');
    await tray.getByRole('button', { name: 'Skip the review and send now' }).click();
    await expect(reviewCards(page).first()).toContainText('The review was stopped');
    await expect(tray).toBeHidden();
    await expect(page.locator('.msg-user').last()).toContainText('Scheduled check');
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await settled(relay, id);
  });

  test('the team design card has the box, which the lead agent leaves alone: ticked there, it holds for the question being answered and the next ones', async ({
    page,
    relay,
  }) => {
    const id = await startChat(page, 'Build and check it', { leadReview: false });
    const card = awaitingPlan(page);
    const box = card.getByRole('checkbox', { name: LEAD_REVIEW });
    await expect(box).not.toBeChecked();
    await expect(card).toContainText("The team's answer is the end of it");
    // The lead agent's design prompt says nothing of it.
    const designs = () => relay.fakeLog().filter((e) => e.prompt?.includes('How to decide'));
    expect(designs()).toHaveLength(1);
    expect(designs().some((e) => /leadReview|Lead review/.test(e.prompt!))).toBe(false);
    await box.check();
    await expect
      .poll(async () => (await relay.api<{ settings: { leadReview?: boolean } }>(`/api/conversations/${id}`)).settings.leadReview)
      .toBe(true);
    await expect(card).toContainText('Each time the team has answered, the lead agent reads the new replies');
    await card.getByRole('button', { name: 'Confirm team' }).click();
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page)).toHaveCount(1);
    await expect(reviewCards(page)).toContainText('The fake lead agent read 1 reply.');
    await settled(relay, id);

    // The next question gets a design of its own: the box is still ticked there (the first card has
    // none now), and its answer is reviewed too.
    await send(page, 'Now the next part');
    const next = awaitingPlan(page);
    await expect(next.getByRole('checkbox', { name: LEAD_REVIEW })).toBeChecked();
    await expect(page.locator('.plan-card').first().getByRole('checkbox', { name: LEAD_REVIEW })).toHaveCount(0);
    await next.getByRole('button', { name: 'Confirm team' }).click();
    await expect(reviewCards(page)).toHaveCount(2);
    await settled(relay, id);

    // Unticked on the latest card, the answers after are not reviewed.
    const latest = page.locator('.plan-card').filter({ has: page.getByRole('checkbox', { name: LEAD_REVIEW }) });
    await latest.getByRole('checkbox', { name: LEAD_REVIEW }).uncheck();
    await expect
      .poll(async () => (await relay.api<{ settings: { leadReview?: boolean } }>(`/api/conversations/${id}`)).settings.leadReview)
      .toBeUndefined();
    await send(page, '@Claude one more thing');
    await expect(await finishedReply(page, 'Claude')).toContainText('one more thing');
    await settled(relay, id);
    await expect(reviewCards(page)).toHaveCount(2);
  });

  test("the New automation page's box is ticked at first, and the automation's chat has it as set there", async ({ page, relay }) => {
    const create = async (review: boolean) => {
      await page.getByRole('button', { name: 'New automation' }).click();
      await page.getByRole('textbox', { name: 'What should the team do?' }).fill('Check the build');
      const box = page.locator('.first-task-actions').getByRole('checkbox', { name: LEAD_REVIEW });
      await expect(box).toBeChecked();
      await box.setChecked(review);
      // The new chats it opens each time copy its setting, as they copy its other settings.
      await page.locator('.automation-options > summary').click();
      await page.getByRole('checkbox', { name: 'Start a new chat each time' }).check();
      await page.getByRole('button', { name: 'Create automation' }).click();
      await page.waitForURL(/#\/c\//);
      const id = /#\/c\/([^/?]+)/.exec(page.url())![1]!;
      return (await relay.api<{ settings: { leadReview?: boolean } }>(`/api/conversations/${id}`)).settings.leadReview;
    };
    expect(await create(true)).toBe(true);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await expect(drawer.getByRole('checkbox', { name: LEAD_REVIEW })).toBeChecked();
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    // Unticked there: off (and ticked again on the next New automation page).
    expect(await create(false)).toBeUndefined();
  });

  test("a shared chat keeps the lead agent's review, with its marks, and each point's @name links to the words it quotes, without the app's buttons or the design card's box", async ({
    page,
    relay,
  }) => {
    const id = await startChat(page, 'Check my plan e2e:long', { autoConfirm: true, leadReview: true, title: 'Reviewed chat' });
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page)).toContainText('Suggested next steps');
    await expect(page.locator('.plan-review')).toHaveCount(1);
    await settled(relay, id);

    const { body, url } = await shareOpenChat(page, relay);
    // The review: its summary, the point and the member it is about (as text), the steps.
    expect(body).toContain("Lead agent's review");
    expect(body).toContain('The fake lead agent read 1 reply.');
    // The point's @name links to the words it quotes, marked in the reply as in the chat (no script runs there).
    const target = /<a class="review-reply-link" href="#(quote-[^"]+-0)">@Claude<\/a>/.exec(body)?.[1];
    expect(target).toBeDefined();
    expect(body).toContain(`<mark class="review-quote-mark risk" id="${target}">Hello from Claude (Claude</mark>`);
    expect(body).toContain('Try the answer yourself.');
    // The design card's box, the step's button and the reply's tag are the app's own.
    expect(body).not.toContain('class="plan-review"');
    expect(body).not.toContain('Ask the team');
    expect(body).not.toContain('to note');
    expect(body).not.toContain('<button');

    // Opened on Harness Relay's viewer, in its frame that runs no script, the link brings the words into
    // view, set apart from other marks; the viewer's own address stays as it was.
    const shared = await openShared(page.context(), fakeGithub(relay), url);
    const words = shared.frame.locator('mark.review-quote-mark');
    await shared.frame.locator('.messages').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(words).not.toBeInViewport();
    await shared.frame.locator('a.review-reply-link').click();
    await expect(words).toBeInViewport();
    await expect.poll(() => shared.page.mainFrame().childFrames()[0]?.url()).toBe(`about:srcdoc#${target}`);
    expect(await words.evaluate((el) => el.matches(':target') && getComputedStyle(el).textDecorationLine)).toBe('underline');
    expect(shared.page.url()).toBe(url);
    await shared.page.close();
  });

  test("a point's @name brings the words it quotes to the middle of the chat, at the top of a reply taller than the window", async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    // A first answer and its review above, so the chat can scroll the next one's first words to its middle.
    await send(page, 'Tell me everything e2e:long');
    await finishedReply(page, 'Claude');
    // Reviewed before the next message, which would stop the review.
    await settled(relay, id);
    await expect(reviewCards(page)).toHaveCount(1);
    await send(page, 'And more e2e:long');
    await expect(reviewCards(page)).toHaveCount(2);
    const reply = await finishedReply(page, 'Claude');
    const card = reviewCards(page).last();
    await expect(card.locator('.review-quote')).toHaveText('Hello from Claude (Claude');
    await settled(relay, id);
    // The words are the reply's first: with the card in view, they are far above it.
    const messages = page.locator('.messages');
    expect(await reply.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(
      await messages.evaluate((el) => el.clientHeight),
    );
    await card.scrollIntoViewIfNeeded();
    expect(await markOffCentre(page, 'risk')).toBeGreaterThan(200);

    await card.getByRole('button', { name: '@Claude' }).click();
    await expect.poll(() => markOffCentre(page, 'risk')).toBeLessThan(30);
    await expect.poll(() => focusedWords(page)).toEqual(['Hello from Claude (Claude']);
    // It stays there: the chat does not follow its end again.
    await page.waitForTimeout(500);
    expect(await markOffCentre(page, 'risk')).toBeLessThan(30);
  });

  test('marks words it quotes across the items of a list in the reply, in the colour of its kind', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await send(page, 'List them e2e:markdown e2e:reviewquote=list e2e:reviewkind=decision');
    await finishedReply(page, 'Claude');
    await expect(reviewCards(page).locator('.review-quote')).toHaveText('first point second point');
    await expect(reviewCards(page)).toContainText('Your call');
    await settled(relay, id);
    // One range from the first item into the second, read as the page shows it, as a decision.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const h = CSS.highlights.get('review-decision');
          return h ? [...h].map((r) => (r as Range).toString().replace(/\s+/g, ' ')) : [];
        }),
      )
      .toEqual(['first point second point']);

    // On a shared page, a mark in each item and none between them (it would sit in the list), the first the one its @name links to.
    const { body } = await shareOpenChat(page, relay);
    const marks = [...body.matchAll(/<mark class="review-quote-mark decision"(?: id="([^"]+)")?>([^<]*)<\/mark>/g)];
    expect(marks.map((m) => [m[1] !== undefined, m[2]])).toEqual([
      [true, 'first point'],
      [false, 'second point'],
    ]);
    expect(body).toContain(`<a class="review-reply-link" href="#${marks[0]![1]}">@Claude</a>`);
    expect(body).toMatch(
      /<li><mark class="review-quote-mark decision" id="[^"]+">first point<\/mark><\/li>\s*<li><mark class="review-quote-mark decision">second point<\/mark><\/li>/,
    );
  });

  test('a point about a reply without words of it goes to the reply, and on a shared page its @name links to the reply', async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { leadReview: true });
    await send(page, 'Look it over e2e:reviewquote=none');
    const reply = await finishedReply(page, 'Claude');
    const card = reviewCards(page).last();
    await expect(card.locator('.review-point')).toHaveCount(1);
    await expect(card.locator('.review-quote')).toHaveCount(0);
    await settled(relay, id);
    await card.getByRole('button', { name: '@Claude' }).click();
    await expect(reply).toHaveClass(/flash/);
    await expect(reply).toBeFocused();
    expect(await focusedWords(page)).toEqual([]);

    const { body } = await shareOpenChat(page, relay);
    expect(body).toContain(`<a class="review-reply-link" href="#${await reply.getAttribute('id')}">@Claude</a>`);
    expect(body).not.toContain('review-quote-mark');
  });

  test("the design card's box goes back when the server refuses the change, and says why", async ({ page }) => {
    await startChat(page, 'Build it');
    const box = awaitingPlan(page).getByRole('checkbox', { name: LEAD_REVIEW });
    await expect(box).not.toBeChecked();
    await page.route('**/lead-review', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test' }) }),
    );
    await box.click();
    await expect(page.getByRole('alert')).toContainText('Refused for the test');
    await expect(box).not.toBeChecked();
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
