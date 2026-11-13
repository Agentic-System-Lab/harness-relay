import { expect, test } from '../fixtures';
import { askAndConfirm, awaitingPlan, chatId, composer, confirmTeam, finishedReply, replies, send, settled, startChat } from '../support/app';
import { HALVES, sharedPermission, teamOf } from '../support/clis';

/** The most members the lead agent puts in a team it designs for a new question (`newTeamLimit` in src/server/planner.ts). */
const LEAD_TEAM_MAX = 5;

test.describe('a new chat', () => {
  test('the lead agent proposes a team, and once it is confirmed the team answers', async ({ page, relay }) => {
    await startChat(page);
    await expect(composer(page)).toHaveAttribute('placeholder', /lead agent builds a team/);

    await send(page, 'What does this project do?');
    const card = awaitingPlan(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Custom team "E2E team"');
    await expect(card).toContainText('The fake lead agent picked the members the question asked for.');
    await expect(card).toContainText('@Claude');

    await confirmTeam(page);
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('Hello from Claude (Claude Code). You said: “What does this project do?”.');
    await expect(reply.locator('.provider-tag')).toHaveText('Claude Code');

    // The conversation is in the sidebar under its first question, and the reply is kept.
    await expect(page.locator('.conv-link', { hasText: 'What does this project do?' })).toBeVisible();
    const conv = await settled(relay, chatId(page));
    expect(conv.messages.filter((m) => m.author.kind === 'agent').map((m) => m.status)).toEqual(['done']);
  });

  test("with the lead agent's teams used without asking, the team answers right away", async ({ page }) => {
    await startChat(page, { autoConfirm: true });
    await send(page, 'Hello there');
    await expect(page.locator('.plan-card').last()).toContainText('Used without asking');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “Hello there”.');
    await expect(awaitingPlan(page)).toHaveCount(0);
  });

  // The CLIs with a sign-in, then the open agents (those whose fake is written), each in teams the lead
  // agent picks, in a chat with the permission all of them can run with here. A half with more CLIs
  // than the lead agent puts in a new team (`LEAD_TEAM_MAX`) answers as teams of about the same size,
  // each in a chat of its own.
  for (const half of HALVES) {
    test(half.title('a team of every CLI answers in turn'), async ({ page }) => {
      const all = teamOf(half.clis);
      const size = Math.ceil(all.length / Math.ceil(all.length / LEAD_TEAM_MAX));
      for (let i = 0; i < all.length; i += size) {
        const team = all.slice(i, i + size);
        await startChat(page, { permission: sharedPermission(team) });
        await askAndConfirm(page, `Review the code together e2e:team=${team.map((c) => c.provider).join(',')}`);
        for (const c of team) {
          const reply = await finishedReply(page, c.name);
          await expect(reply).toContainText(`Hello from ${c.name} (${c.label}). You said: “Review the code together”.`);
          await expect(reply.locator('.provider-tag')).toHaveText(c.label);
        }
        // Roundtable order: the team's.
        await expect(page.locator('.msg-agent .msg-head strong')).toHaveText(team.map((c) => `@${c.name}`));
      }
    });
  }

  test('a follow-up question gets a team again and the members answer it', async ({ page, relay }) => {
    await startChat(page);
    await askAndConfirm(page, 'First question');
    await expect(await finishedReply(page, 'Claude')).toContainText('First question');
    await settled(relay, chatId(page));

    await askAndConfirm(page, 'Second question e2e:team=codex');
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “Second question”.');
    await expect(replies(page, 'Claude')).toHaveCount(1);
  });
});
