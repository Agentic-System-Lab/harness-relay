import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import {
  askAndConfirm,
  awaitingPlan,
  chatId,
  composer,
  confirmTeam,
  finishedReply,
  replies,
  send,
  settled,
  startChat,
} from '../support/app';
import { eachHalf, sharedPermission, teamOf } from '../support/clis';

/** The most members the lead agent puts in a team it designs for a new question (`newTeamLimit` in src/server/planner.ts). */
const LEAD_TEAM_MAX = 5;

/** The animations in the team design cards: each one's name, timing, what it changes and its keyframes' transforms. */
const cardAnimations = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => ((a.effect as KeyframeEffect).target as Element | null)?.closest('.plan-card'))
      .map((a) => {
        const effect = a.effect as KeyframeEffect;
        const timing = effect.getComputedTiming();
        const keyframes = effect.getKeyframes();
        const changed = new Set(keyframes.flatMap((k) => Object.keys(k)));
        for (const key of ['offset', 'computedOffset', 'easing', 'composite']) changed.delete(key);
        return {
          name: (a as CSSAnimation).animationName,
          delay: Number(timing.delay),
          duration: Number(timing.duration),
          iterations: timing.iterations,
          playState: a.playState,
          changed: [...changed].sort(),
          // Each keyframe's turn in degrees (`rotate(0deg)`, or `rotate(0)` as some browsers write it).
          frames: keyframes.map((k) => ({
            at: Number(k.computedOffset),
            deg: parseFloat(/rotate\(([-\d.]+)/.exec(String(k.transform))?.[1] ?? 'NaN'),
          })),
        };
      }),
  );

/**
 * The card's mark's angle, in degrees, at each time given (milliseconds since it appeared): its turns
 * paused and sought there, then its turned part's transform read.
 */
const angles = (page: Page, times: number[]) =>
  page.evaluate((times) => {
    const orbit = document.querySelector('.plan-card .logo-motion-orbit')!;
    const turns = document.getAnimations().filter((a) => (a.effect as KeyframeEffect).target === orbit);
    for (const a of turns) a.pause();
    return times.map((t) => {
      for (const a of turns) a.currentTime = t;
      const m = new DOMMatrixReadOnly(getComputedStyle(orbit).transform);
      return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
    });
  }, times);

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

  test("while the lead agent designs the team, its card shows the home page's logo, turning again and again with half a second still after each turn, and still with reduced motion", async ({
    page,
  }) => {
    await startChat(page);
    await send(page, 'Take your time e2e:slowplan');
    const card = page.locator('.plan-card.planning').last();
    await expect(card).toContainText('is choosing a team for this question');
    // The home page's mark, at the size of the card's Logo once the design is in.
    const mark = card.locator('.logo-motion');
    await expect(mark).toBeVisible();
    expect(await mark.boundingBox()).toMatchObject({ width: 18, height: 18 });

    // The dots spiral in once while the mark turns (as on the home page), then it turns again and
    // again: 1.4 s, as eased as the first turn, in each 1.9 s, from half a second after the first one
    // ends. Transform and opacity alone, so the compositor runs it all.
    const parts = await cardAnimations(page);
    expect(parts.map((a) => a.name).sort()).toEqual(['logo-join-claude', 'logo-join-codex', 'logo-join-grok', 'logo-orbit', 'logo-turn']);
    for (const a of parts) {
      expect(a.duration, a.name).toBeGreaterThan(0);
      expect(a.iterations, a.name).toBe(a.name === 'logo-turn' ? Infinity : 1);
      expect(
        a.changed.every((p) => p === 'transform' || p === 'opacity'),
        `${a.name} changes ${a.changed.join(', ')}`,
      ).toBe(true);
    }
    const orbit = parts.find((a) => a.name === 'logo-orbit')!;
    const turn = parts.find((a) => a.name === 'logo-turn')!;
    expect(orbit.duration).toBe(1400);
    expect(turn).toMatchObject({ delay: 1900, duration: 1900 });
    expect(turn.frames.map((f) => f.deg)).toEqual([0, 360, 360]);
    expect(turn.frames[1]!.at).toBeCloseTo(1400 / 1900, 4);
    // It keeps turning while the lead agent works.
    await expect.poll(async () => (await cardAnimations(page)).find((a) => a.name === 'logo-turn')?.playState).toBe('running');
    // Its angle over time: turning, then still for half a second after each turn (1.4–1.9 s, 3.3–3.8 s), then turning again.
    const [first, ...rest] = await angles(page, [300, 1500, 1800, 2200, 3400, 3700, 4100]);
    expect(first).not.toBe(0);
    expect(rest.map((a) => (Math.abs(a) <= 1 ? 'still' : 'turning'))).toEqual(['still', 'still', 'turning', 'still', 'still', 'turning']);

    // Stopped, the card says so, with its mark and animations gone.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(card).toContainText('Team design was stopped');
    await expect(mark).toHaveCount(0);
    expect(await cardAnimations(page)).toEqual([]);

    // With reduced motion the mark is there, standing still.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await send(page, 'Once more e2e:slowplan');
    await expect(page.locator('.plan-card.planning')).toHaveCount(2);
    await expect(page.locator('.plan-card.planning').last().locator('.logo-motion')).toBeVisible();
    expect(await cardAnimations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.plan-card.planning').last()).toContainText('Team design was stopped');
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
  eachHalf((half) => {
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
  });

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
