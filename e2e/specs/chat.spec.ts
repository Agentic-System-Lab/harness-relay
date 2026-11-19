import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The animations in the team design cards: each one's name, element (its classes), timing, what it changes and its keyframes' transforms. */
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
          on: (effect.target as Element).className,
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
 * The card's mark's angle, in degrees, at each time given (milliseconds since it appeared): its
 * animations paused and sought there, then the turns of the mark and of its orbit (the first turn is
 * the mark's, the next ones the orbit's) read together.
 */
const angles = (page: Page, times: number[]) =>
  page.evaluate((times) => {
    const mark = document.querySelector('.plan-card .logo-motion')!;
    const orbit = mark.querySelector('.logo-motion-orbit')!;
    const parts = document.getAnimations().filter((a) => ((a.effect as KeyframeEffect).target as Element | null)?.closest('.plan-card'));
    for (const a of parts) a.pause();
    const matrix = (el: Element) => {
      const transform = getComputedStyle(el).transform;
      return new DOMMatrix(transform === 'none' ? undefined : transform);
    };
    return times.map((t) => {
      for (const a of parts) a.currentTime = t;
      const m = matrix(mark).multiply(matrix(orbit));
      return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
    });
  }, times);

/**
 * The card's mark once still (its animations paused and sought to 1.6 s, between turns): its size, and
 * each dot's place and size within it, in pixels.
 */
const markDrawing = (page: Page) =>
  page.evaluate(() => {
    const mark = document.querySelector('.plan-card .logo-motion')!;
    for (const a of document.getAnimations()) {
      if (!((a.effect as KeyframeEffect).target as Element | null)?.closest('.plan-card')) continue;
      a.pause();
      a.currentTime = 1600;
    }
    const box = mark.getBoundingClientRect();
    const dots = [...mark.querySelectorAll('.logo-dot')].map((d) => {
      const r = d.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, size: r.width, height: r.height };
    });
    return { width: box.width, height: box.height, dots };
  });

/** The Logo's three circles (Claude's, Codex's, Grok's: `Logo.tsx`), in its 32 units. */
const LOGO_DOTS = [
  { cx: 9, cy: 16, r: 6 },
  { cx: 23, cy: 10, r: 5 },
  { cx: 23, cy: 23, r: 5 },
];

test.describe('auto team with exhausted CLI quotas', () => {
  test.use({ openBackend: false });

  test('refreshes quota before starting the next team and replaces a newly exhausted model', async ({ page, relay }) => {
    await relay.api('/api/settings', { method: 'PUT', body: { lead: { provider: 'codex' } } });
    const id = await startChat(page, { autoConfirm: true, permission: 'read-only' });
    await send(page, 'Choose Claude first e2e:team=claude');
    await expect((await finishedReply(page, 'Claude')).locator('.provider-tag')).toHaveText('Claude Code');
    await settled(relay, id);

    const claudeUsage = relay.fakeLog().find((entry) => entry.cli === 'claude' && entry.usage === 42);
    expect(claudeUsage?.home).toBeTruthy();
    writeFileSync(join(claudeUsage!.home!, 'e2e-plan-exhausted'), '');
    await send(page, 'Choose Claude again e2e:team=claude');
    await expect(page.locator('.plan-card').last()).toContainText('adjusted to use available accounts or models');
    await expect((await finishedReply(page, 'Claude')).locator('.provider-tag')).toHaveText('Codex');

    const conv = await settled(relay, id);
    expect(conv.messages.findLast((m) => m.plan)?.plan?.agents?.map((a) => a.provider)).toEqual(['codex']);
    const lead = relay.fakeLog().findLast((entry) => entry.cli === 'codex' && entry.prompt?.includes('Coding agents you can use'));
    expect(lead?.prompt).toBeDefined();
    expect(lead?.prompt).not.toContain('- claude (Claude Code)');
  });

  test.describe('all CLIs are exhausted', () => {
    test.use({ serverEnv: { E2E_EXHAUSTED_CLIS: 'claude,codex,grok' } });

    test('explains why it cannot start a team', async ({ page, relay }) => {
      const id = await startChat(page, { autoConfirm: true, permission: 'read-only' });
      await send(page, 'Choose a team');
      await expect(page.getByRole('status').filter({ hasText: 'No models are available for this team.' })).toBeVisible();

      const conv = await settled(relay, id);
      expect(conv.messages.find((m) => m.plan)?.plan?.status).toBe('failed');
      expect(conv.agents).toEqual([]);
      expect(conv.messages.some((m) => m.author.kind === 'agent')).toBe(false);
    });
  });
});

test.describe('team design progress and model checks', () => {
  test('shows collapsible progress during design and keeps it open when the model check finishes', async ({ page, relay }) => {
    const id = await startChat(page);
    await send(page, 'Choose a team e2e:slowplan=3');
    const activity = page.locator('details[aria-label="Team design progress"]');
    await expect(activity).toBeVisible();
    await expect(page.locator('.plan-card.planning')).toBeVisible();
    await activity.locator('summary').first().click();
    await expect(activity).toHaveAttribute('open', '');
    await expect(activity.locator('li.tool').first()).toContainText('Checking accounts and usage');

    await expect(awaitingPlan(page)).toBeVisible();
    await expect(activity).toHaveAttribute('open', '');
    await expect(activity.locator('li.tool.done').last()).toContainText('Testing model response');
    const probes = relay.fakeLog(true).filter((e) => e.prompt?.includes('Reply with exactly RELAY_MODEL_OK.'));
    expect(probes.map((e) => e.cli)).toEqual(['claude']);
    expect(probes[0]?.prompt).not.toContain('Choose a team');
    expect((await settled(relay, id)).messages.some((m) => m.author.kind === 'agent')).toBe(false);

    await activity.locator('summary').first().click();
    await expect(activity).not.toHaveAttribute('open', '');
    await confirmTeam(page);
    await expect(await finishedReply(page, 'Claude')).toContainText('Choose a team');
  });

  test('checks a full-access team only after confirmation', async ({ page, relay }) => {
    await startChat(page, { permission: 'full' });
    await send(page, 'Choose a full-access team');
    await expect(awaitingPlan(page)).toContainText('Confirm this team to test the models before they answer.');
    const checks = () => relay.fakeLog(true).filter((e) => e.prompt?.includes('Reply with exactly RELAY_MODEL_OK.'));
    expect(checks()).toEqual([]);

    await confirmTeam(page);
    await expect(await finishedReply(page, 'Claude')).toContainText('Choose a full-access team');
    expect(checks().map((e) => e.cli)).toEqual(['claude']);
  });

  test.describe('when checks receive no successful reply', () => {
    test.use({ openBackend: false, serverEnv: { E2E_FAIL_MODEL_CHECK_CLIS: 'claude,codex,grok' } });

    test('shows the failed check and starts no team even with auto-confirm on', async ({ page, relay }) => {
      const id = await startChat(page, { autoConfirm: true });
      await send(page, 'Choose a team');
      await expect(page.getByRole('status').filter({ hasText: 'Could not verify these models' })).toBeVisible();
      const activity = page.locator('details[aria-label="Team design progress"]');
      await activity.locator('summary').first().click();
      await expect(activity.locator('li.tool.error').first()).toContainText('Testing model response');
      const conv = await settled(relay, id);
      expect(conv.agents).toEqual([]);
      expect(conv.messages.some((m) => m.author.kind === 'agent')).toBe(false);
    });
  });
});

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
    const mark = card.locator('.logo-motion');
    await expect(mark).toBeVisible();

    // The dots spiral in once while the mark turns (as on the home page), then it turns again and
    // again: 1.4 s, as eased as the first turn, in each 1.9 s, from half a second after the first one
    // ends. Transform and opacity alone, and one transform animation an element at most (Chrome
    // composites neither of two that turn the same element, and would recalculate the mark's style
    // on every frame instead), so the compositor runs it all.
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
    const turned = parts.filter((a) => a.changed.includes('transform')).map((a) => a.on);
    expect(new Set(turned).size, `elements turned: ${turned.join(' / ')}`).toBe(turned.length);
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

    // The home page's drawing, at the 18px of the card's Logo once the design is in: each dot where
    // the Logo draws its circle.
    const drawing = await markDrawing(page);
    expect(drawing).toMatchObject({ width: 18, height: 18 });
    drawing.dots.forEach((dot, i) => {
      const { cx, cy, r } = LOGO_DOTS[i]!;
      const unit = 18 / 32;
      expect(dot.x).toBeCloseTo((cx - r) * unit, 1);
      expect(dot.y).toBeCloseTo((cy - r) * unit, 1);
      expect(dot.size).toBeCloseTo(2 * r * unit, 1);
      expect(dot.height).toBeCloseTo(2 * r * unit, 1);
    });

    // Stopped, the card says so, with its mark and animations gone, and its ✦ in the mark's place: the
    // text stays where it was.
    const text = card.locator(':scope > span').last();
    const before = (await text.boundingBox())!.x;
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(card).toContainText('Team design was stopped');
    await expect(mark).toHaveCount(0);
    expect(await cardAnimations(page)).toEqual([]);
    expect((await text.boundingBox())!.x).toBeCloseTo(before, 0);

    // With reduced motion the mark is there, standing still; and in forced colors (a high-contrast
    // theme) its dots keep their own colours, as the SVG Logo's circles do, where the page's would hide them.
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    await send(page, 'Once more e2e:slowplan');
    await expect(page.locator('.plan-card.planning')).toHaveCount(2);
    const still = page.locator('.plan-card.planning').last().locator('.logo-motion');
    await expect(still).toBeVisible();
    expect(await cardAnimations(page)).toEqual([]);
    const colors = await still.locator('.logo-dot').evaluateAll((dots) => dots.map((d) => getComputedStyle(d).backgroundColor));
    expect(new Set(colors).size, colors.join(' / ')).toBe(3);
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
