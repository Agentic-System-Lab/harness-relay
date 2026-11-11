import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, replies, send } from '../support/app';

test.describe('how members take turns', () => {
  test('an agent that asks the user waits for the answer, then answers with it', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Pick a way e2e:ask');
    const asked = await finishedReply(page, 'Claude');
    await expect(asked).toContainText('Which option do you prefer, A or B?');
    await expect(asked).not.toContainText('[ASK_USER]');
    await expect(asked.locator('.ask-card')).toContainText('Waiting for your answer');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Answer @Claude…');
    await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Answer needed');

    await send(page, 'Option B');
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await expect(await finishedReply(page, 'Claude')).toContainText('Thanks, Claude got your answer: “Option B”.');
    await expect(page.locator('.ask-card')).toHaveCount(0);
  });

  test('a question can be skipped, and the rest of the team goes on', async ({ page, relay }) => {
    await openTeamChat(page, relay, [
      { name: 'Claude', provider: 'claude' },
      { name: 'Grok', provider: 'grok' },
    ]);
    await send(page, 'Decide something e2e:ask@claude');
    const asked = await finishedReply(page, 'Claude');
    await asked.getByRole('button', { name: 'Skip, let the team go on' }).click();
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Decide something”.');
  });

  test('relay mode: a member hands the floor to the teammate it mentions', async ({ page, relay }) => {
    await openTeamChat(
      page,
      relay,
      [
        { name: 'Lead', provider: 'claude' },
        { name: 'Builder', provider: 'codex' },
      ],
      { mode: 'relay' },
    );
    await expect(composer(page)).toHaveAttribute('placeholder', /@Lead answers first/);
    await send(page, 'Plan and build it e2e:handoff=Builder');
    const lead = await finishedReply(page, 'Lead');
    await expect(lead).toContainText('@Builder, over to you.');
    await expect(lead.locator('.mention, a, span').filter({ hasText: '@Builder' }).first()).toBeVisible();
    await expect(await finishedReply(page, 'Builder')).toContainText('Hello from Builder (Codex)');
    // The floor came back to the user: nobody else speaks.
    await expect(page.locator('.msg-agent')).toHaveCount(2);
  });

  test('a message that @mentions a member is answered by that member only', async ({ page, relay }) => {
    await openTeamChat(page, relay, [
      { name: 'Claude', provider: 'claude' },
      { name: 'Codex', provider: 'codex' },
      { name: 'Grok', provider: 'grok' },
    ]);
    await send(page, '@Grok what do you think?');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “@Grok what do you think?”.');
    await expect(page.locator('.msg-agent')).toHaveCount(1);
  });

  test('in a later round, members with nothing to add pass, and the round ends early', async ({ page, relay }) => {
    await openTeamChat(
      page,
      relay,
      [
        { name: 'Claude', provider: 'claude' },
        { name: 'Codex', provider: 'codex' },
      ],
      { rounds: 3 },
    );
    await send(page, 'Discuss');
    await expect(page.locator('.msg-agent.passed')).toHaveCount(2);
    await expect(page.locator('.msg-agent.passed').first()).toContainText('Nothing to add (PASS)');
    // Round 1 both spoke, round 2 both passed, and no third round.
    await expect(page.locator('.msg-agent')).toHaveCount(4);
  });

  test('a reply can be stopped', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }]);
    await send(page, 'Take your time e2e:slow');
    const reply = replies(page, 'Codex').last();
    await expect(reply.locator('.live-tag')).toBeVisible();
    await expect(reply).toContainText('You said');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(reply).toContainText('(stopped)');
    await expect(reply.locator('.live-tag')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  });

  for (const cli of [
    { name: 'Claude', provider: 'claude' },
    { name: 'Codex', provider: 'codex' },
    { name: 'Grok', provider: 'grok' },
  ] as const) {
    test(`${cli.provider}: a failed reply shows the CLI's error, and Retry answers again`, async ({ page, relay }) => {
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }]);
      await send(page, 'Try this e2e:flaky');
      const failed = replies(page, cli.name).last();
      await expect(failed.locator('.msg-error')).toContainText(`fake ${cli.provider}: failing this once (e2e:flaky)`);

      await failed.getByRole('button', { name: 'Retry' }).click();
      const again = await finishedReply(page, cli.name);
      await expect(again).toContainText('You said: “Try this”.');
      await expect(page.locator('.msg-error')).toHaveCount(0);
    });
  }

  test('a message sent while the team replies waits, then reaches the next member', async ({ page, relay }) => {
    await openTeamChat(page, relay, [
      { name: 'Claude', provider: 'claude' },
      { name: 'Grok', provider: 'grok' },
    ]);
    await send(page, 'Go slowly e2e:slow@claude');
    await expect(replies(page, 'Claude').last().locator('.live-tag')).toBeVisible();

    await composer(page).fill('Also look at the tests');
    await composer(page).press('Enter');
    await expect(page.getByRole('region', { name: 'Messages waiting to be delivered' }).or(page.locator('.queue-tray'))).toContainText('Also look at the tests');

    // Delivered before Grok's turn: Grok answers it.
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Also look at the tests”.', { timeout: 30_000 });
  });
});
