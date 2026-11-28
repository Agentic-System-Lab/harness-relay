import type { Page } from '@playwright/test';
import { en } from '../../src/web/locales/en';
import { expect, test } from '../fixtures';

/** The guided tour. */
const tour = (page: Page) => page.getByRole('dialog', { name: 'Guided tour' });

/** The topics' titles, as the English locale names them, so that a changed tour changes them here too. */
const titles = en.tour.steps.map((s) => s.title);

/** The topic shown: its title. */
const shown = (page: Page) => tour(page).locator('.tour-topic h3');

/** A topic in the list. */
const listed = (page: Page, title: string) =>
  tour(page)
    .getByRole('navigation', { name: 'Tour topics' })
    .getByRole('button', { name: new RegExp(`^${title}`) });

/** Titles of the topics whose buttons announce that they have been read. */
const checked = (page: Page) =>
  tour(page)
    .getByRole('navigation', { name: 'Tour topics' })
    .getByRole('button', { name: / Read$/ })
    .locator('.tour-name');

/** The home page's question about the topics left to read. */
const nudge = (page: Page) => page.getByRole('complementary', { name: 'Guided tour' });

/**
 * The animations in the tour (none while it is closed): each one's name, state, start, duration,
 * the properties it changes and the value it starts from. Those of the topics' pictures (`.tour-art`)
 * are apart: `art` for them alone, else the card's and the backdrop's alone. Animations only: a
 * topic's check turning green is a transition.
 */
function tourAnimations(page: Page, art = false) {
  return page.evaluate(
    (art) =>
      (document.querySelector('.tour')?.getAnimations({ subtree: true }) ?? [])
        .filter((a) => a instanceof CSSAnimation)
        .filter((a) => Boolean(((a.effect as KeyframeEffect).target as Element | null)?.closest('.tour-art')) === art)
        .map((a) => {
          const effect = a.effect as KeyframeEffect;
          const [first] = effect.getKeyframes();
          const changed = Object.keys(first ?? {}).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
          return {
            name: (a as CSSAnimation).animationName,
            state: a.playState,
            start: a.startTime as number | null,
            duration: Number(effect.getComputedTiming().duration),
            changed,
            from: changed.length === 1 ? String(first![changed[0]!]) : undefined,
          };
        }),
    art,
  );
}

/** The app is drawn (signed in): the tour, when it is due, shows from the first frame. */
async function appShown(page: Page): Promise<void> {
  await expect(page.locator('.app main.main')).toBeVisible();
}

/** A first visit again: nothing read, nothing answered. */
async function firstVisit(page: Page): Promise<void> {
  // Once the tour the page opened has marked its first topic read, or that would come after.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('relay:guide'))).not.toBeNull();
  await page.evaluate(() => localStorage.removeItem('relay:guide'));
  await page.reload();
  await expect(tour(page)).toBeVisible();
}

test.describe('the guided tour', () => {
  test.use({ tour: true });

  test('opens on a first visit at its first topic, checks each topic shown, and does not open again by itself', async ({ page }) => {
    await expect(tour(page)).toBeVisible();
    await expect(shown(page)).toHaveText(titles[0]!);
    await expect(tour(page).getByText(`1 of ${titles.length} read`)).toBeVisible();
    await expect(checked(page)).toHaveText([titles[0]]);
    await expect(listed(page, titles[0]!)).toHaveAttribute('aria-current', 'step');

    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(shown(page)).toHaveText(titles[1]!);
    await expect(tour(page).getByText(`2 of ${titles.length} read`)).toBeVisible();
    // Any topic from the list, in any order.
    await listed(page, 'Automations').click();
    await expect(shown(page)).toHaveText('Automations');
    await expect(listed(page, 'Automations')).toHaveAttribute('aria-current', 'step');
    await expect(checked(page)).toHaveText([titles[0], titles[1], 'Automations']);
    // The arrow keys step too.
    await page.keyboard.press('ArrowLeft');
    await expect(shown(page)).toHaveText('Connect your phone');
    await page.keyboard.press('ArrowRight');
    await expect(shown(page)).toHaveText('Automations');

    // The last topic finishes it.
    await listed(page, titles.at(-1)!).click();
    await expect(tour(page).getByRole('button', { name: 'Next' })).toHaveCount(0);
    await tour(page).getByRole('button', { name: 'Done' }).click();
    await expect(tour(page)).toBeHidden();

    // After a reload, the home page asks about the topics left.
    await page.reload();
    await appShown(page);
    await expect(tour(page)).toHaveCount(0);
    await expect(nudge(page)).toContainText('The guided tour has 5 topics you have not read. Take a look?');
  });

  test('asks on the home page about the topics left: Show me opens the first of them, Not now stops asking', async ({ page }) => {
    await expect(tour(page)).toBeVisible();
    await tour(page).getByRole('button', { name: 'Close the tour' }).click();
    await expect(tour(page)).toBeHidden();
    // Not asked on the page that closed it.
    await expect(nudge(page)).toHaveCount(0);

    await page.reload();
    await appShown(page);
    await expect(tour(page)).toHaveCount(0);
    await expect(nudge(page)).toContainText(`The guided tour has ${titles.length - 1} topics you have not read.`);
    // The home page only: it stays out of a chat's way, and is there again back home.
    await page.locator('.home-start').click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(nudge(page)).toHaveCount(0);
    await page.goBack();
    await expect(nudge(page)).toBeVisible();

    await nudge(page).getByRole('button', { name: 'Show me' }).click();
    await expect(nudge(page)).toHaveCount(0);
    await expect(shown(page)).toHaveText(titles[1]!);
    await expect(checked(page)).toHaveText([titles[0], titles[1]]);
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();

    await page.reload();
    await expect(nudge(page)).toContainText(`The guided tour has ${titles.length - 2} topics you have not read.`);
    await nudge(page).getByRole('button', { name: 'Not now' }).click();
    await expect(nudge(page)).toHaveCount(0);
    await page.reload();
    await appShown(page);
    await expect(nudge(page)).toHaveCount(0);
    await expect(tour(page)).toHaveCount(0);

    // Settings opens it still, with its checks, at the first topic not read.
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
    await expect(shown(page)).toHaveText(titles[2]!);
    await expect(checked(page)).toHaveText(titles.slice(0, 3));
  });

  test('a browser that finished an older tour can read new topics and see which existing topics changed', async ({ page }) => {
    await expect(tour(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('relay:guide'))).not.toBeNull();
    await page.evaluate(() => {
      localStorage.removeItem('relay:guide');
      localStorage.setItem('relay:onboarded', '20');
    });
    await page.reload();
    await appShown(page);
    await expect(tour(page)).toHaveCount(0);
    await expect(nudge(page)).toContainText('The guided tour has 9 topics you have not read. Take a look?');
    await nudge(page).getByRole('button', { name: 'Show me' }).click();
    await expect(shown(page)).toHaveText('Get an agent ready');
    await expect(checked(page)).toHaveText(['Meet Harness Relay', 'Get an agent ready']);
    await expect(tour(page).locator('.tour-changed')).toHaveText(Array(5).fill('Updated'));
    await expect(listed(page, 'Start a chat')).toContainText('Updated');

    await expect(listed(page, 'After a reply')).not.toContainText('Updated');

    // A browser that read every topic and dismissed reminders in version 47.
    await page.evaluate(() => {
      localStorage.removeItem('relay:onboarded');
      localStorage.setItem(
        'relay:guide',
        JSON.stringify({
          seen: { welcome: 17, agents: 39, chat: 46, team: 45, replies: 47, phone: 23, automations: 44, apps: 33 },
          quiet: 47,
        }),
      );
    });
    await page.reload();
    await appShown(page);
    await expect(nudge(page)).toContainText('The guided tour has 6 topics you have not read.');
    await nudge(page).getByRole('button', { name: 'Show me' }).click();
    await expect(shown(page)).toHaveText('Start a chat');
    await expect(tour(page)).toContainText('mic, attach files or folders');
    await expect(listed(page, 'While the team works')).toContainText('Updated');
    await expect(listed(page, 'After a reply')).toContainText('Updated');
    await expect(listed(page, 'Labs')).not.toContainText('Updated');
    // The chat's computer is new since then: unread, not updated; the apps topic, now with the tool library, updated.
    await expect(listed(page, 'Computer')).not.toContainText('Updated');
    await expect(listed(page, 'Common apps and tools')).toContainText('Updated');
    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(tour(page)).toContainText('edit text files or delete files');
    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(shown(page)).toHaveText('After a reply');
    await expect(tour(page)).toContainText('Share under a reply');
    await expect(tour(page)).toContainText('Question usage below your question');
    await listed(page, 'Common apps and tools').click();
    await expect(tour(page)).toContainText('Add MCP servers, skills and memory in the tool library.');
    await expect(tour(page).getByRole('link', { name: 'Open Apps and tools' })).toHaveAttribute('href', /#\/settings\/apps$/);
    await listed(page, 'Computer').click();
    await expect(tour(page)).toContainText('take control any time');
    // Settings' Computer (Cua) row itself, not only its card.
    await expect(tour(page).getByRole('link', { name: 'Install Cua' })).toHaveAttribute('href', /#\/settings\/apps\/computer$/);
    await listed(page, 'Labs').click();
    await expect(tour(page)).toContainText('CodeAct');
    await expect(tour(page)).toContainText('RLM');
    await expect(tour(page)).toContainText('long-term memory');
    await tour(page).getByRole('link', { name: 'Open Labs' }).click();
    await expect(page).toHaveURL(/#\/settings\/labs$/);
    await expect(page.locator('#settings-labs')).toBeInViewport();
    await page.goBack();
    await page.reload();
    await appShown(page);
    await expect(nudge(page)).toHaveCount(0);
    await expect(tour(page)).toHaveCount(0);
  });

  test("a topic's button goes where it says and closes the tour", async ({ page }) => {
    await listed(page, 'Start a chat').click();
    await tour(page).getByRole('link', { name: 'Start a new chat' }).click();
    await expect(tour(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/new$/);

    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
    await listed(page, 'Connect your phone').click();
    await tour(page).getByRole('link', { name: 'Connect your phone' }).click();
    await expect(tour(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/settings\/home-screen$/);
    await expect(page.locator('#settings-home-screen')).toBeInViewport();

    // The computer's Install Cua: Settings' Computer (Cua) row itself, opened, with its own Install Cua in view.
    await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
    await listed(page, 'Computer').click();
    await tour(page).getByRole('link', { name: 'Install Cua' }).click();
    await expect(tour(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/settings\/apps\/computer$/);
    const row = page.getByRole('listitem', { name: 'Computer (Cua)', exact: true });
    await expect(row.locator('.app-options')).toHaveAttribute('open', '');
    await expect(row.getByRole('button', { name: 'Install Cua', exact: true })).toBeInViewport();
    await expect(row.locator('.app-options > summary')).toBeFocused();

    // Again from that same address, the row folded and scrolled away meanwhile: the link opens it again.
    await row.locator('.app-options > summary').click();
    await expect(row.locator('.app-options')).not.toHaveAttribute('open', '');
    await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
    await listed(page, 'Computer').click();
    await tour(page).getByRole('link', { name: 'Install Cua' }).click();
    await expect(tour(page)).toBeHidden();
    await expect(row.locator('.app-options')).toHaveAttribute('open', '');
    await expect(row.getByRole('button', { name: 'Install Cua', exact: true })).toBeInViewport();
  });

  test('on a phone, the tour is a sheet at the bottom showing one topic, and All topics shows the list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await firstVisit(page);
    const card = page.locator('.tour-card');
    const next = card.getByRole('button', { name: 'Next' });
    const list = card.getByRole('navigation', { name: 'Tour topics' });
    await expect(shown(page)).toHaveText(titles[0]!);
    await expect(list).toBeHidden();
    // Its bottom at the screen's, with Next in it.
    const atBottom = async () => {
      const c = (await card.boundingBox())!;
      return c.y > 0 && Math.abs(c.y + c.height - 844) <= 1;
    };
    await expect.poll(atBottom).toBe(true);
    await expect(next).toBeInViewport({ ratio: 1 });

    await card.getByRole('button', { name: 'All topics' }).click();
    await expect(list).toBeVisible();
    await expect(shown(page)).toBeHidden();
    await expect(listed(page, titles[0]!)).toBeFocused();
    expect(await atBottom()).toBe(true);
    await listed(page, 'Automations').click();
    await expect(list).toBeHidden();
    await expect(shown(page)).toHaveText('Automations');
    await expect(next).toBeFocused();
    expect(await atBottom()).toBe(true);
  });

  test("on a short phone, the picture gives its room back, and a topic's text scrolls above its buttons", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 300 });
    await firstVisit(page);
    await page.locator('.tour-card').getByRole('button', { name: 'All topics' }).click();
    await listed(page, 'While the team works').click();
    await expect(shown(page)).toHaveText('While the team works');
    const card = page.locator('.tour-card');
    const text = card.locator('.tour-body');
    const next = card.getByRole('button', { name: 'Next' });
    await expect(card.locator('.tour-art > svg')).toBeHidden();
    const inView = async () => {
      const [c, n] = [await card.boundingBox(), await next.boundingBox()];
      return c!.y >= 0 && Math.abs(c!.y + c!.height - 300) <= 1 && n!.y + n!.height <= c!.y + c!.height;
    };
    await expect.poll(inView).toBe(true);
    const sizes = () =>
      text.evaluate((el) => ({ top: el.scrollTop, scrolls: el.scrollHeight > el.clientHeight, max: el.scrollHeight - el.clientHeight }));
    expect(await sizes()).toMatchObject({ top: 0, scrolls: true });
    // The text scrolls under the buttons, with the keys too while Next has the focus.
    await next.focus();
    await page.keyboard.press('End');
    await expect
      .poll(async () => {
        const s = await sizes();
        return s.top >= s.max - 1;
      })
      .toBe(true);
    expect(await inView()).toBe(true);
    await expect(card.locator('.tour-foot.scrolls')).toBeVisible();
    // The next topic starts at its top.
    await next.click();
    await expect(shown(page)).toHaveText(titles[titles.indexOf('While the team works') + 1]!);
    expect((await sizes()).top).toBe(0);
  });

  test('on a phone, the tour slides up once as it opens, also from Settings, comes to rest at the bottom of the screen, and not with reduced motion', async ({
    page,
  }) => {
    // Opened at a phone's size: Next takes the focus while the sheet is still below the screen.
    await page.setViewportSize({ width: 390, height: 560 });
    await firstVisit(page);
    const card = page.locator('.tour-card');
    const next = card.getByRole('button', { name: 'Next' });
    await expect.poll(() => tourAnimations(page).then((a) => a.map((x) => x.name))).toEqual(['tour-scrim-in', 'tour-sheet-in']);
    await expect.poll(() => tourAnimations(page).then((a) => a.every((x) => x.state === 'finished'))).toBe(true);
    const opened = await tourAnimations(page);
    // The sheet comes up from below the screen, the backdrop fades in, and nothing else changes
    // (transform and opacity alone: no layout or paint on each frame).
    expect(opened.map((a) => [a.changed, a.from])).toEqual([
      [['opacity'], '0'],
      [['transform'], 'translateY(100%)'],
    ]);
    expect(opened.every((a) => a.duration > 0)).toBe(true);
    // At rest with its bottom at the screen's, Next in it: focusing Next as it slid in moved nothing.
    const atBottom = async () => {
      const c = (await card.boundingBox())!;
      return c.y > 0 && Math.abs(c.y + c.height - 560) <= 1;
    };
    expect(await atBottom()).toBe(true);
    await expect(next).toBeInViewport({ ratio: 1 });
    await expect(next).toBeFocused();
    // The next topic keeps the sheet where it is: the animation does not play again.
    await next.click();
    await expect(shown(page)).toHaveText(titles[1]!);
    expect(await tourAnimations(page)).toEqual(opened);
    expect(await atBottom()).toBe(true);

    // Replayed from Settings, it slides up again.
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();
    const replay = async () => {
      await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
      await expect(tour(page)).toBeVisible();
    };
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await replay();
    await expect.poll(() => tourAnimations(page).then((a) => a.map((x) => x.name))).toEqual(['tour-scrim-in', 'tour-sheet-in']);
    await expect.poll(() => tourAnimations(page).then((a) => a.every((x) => x.state === 'finished'))).toBe(true);
    const replayed = await tourAnimations(page);
    expect(replayed.every((a, n) => a.start! > opened[n]!.start!)).toBe(true);
    expect(await atBottom()).toBe(true);
    await expect(next).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await replay();
    expect(await tourAnimations(page)).toEqual([]);
    expect(await atBottom()).toBe(true);
  });

  test('on a wide screen, the card keeps one size and Next one place through the topics', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await firstVisit(page);
    const card = page.locator('.tour-card');
    const next = card.locator('.tour-foot .primary');
    // Only a phone's sheet slides in: here the card and the backdrop are still.
    expect(await tourAnimations(page)).toEqual([]);
    const places = new Set<string>();
    for (const title of titles) {
      await listed(page, title).click();
      await expect(shown(page)).toHaveText(title);
      const [c, n] = [(await card.boundingBox())!, (await next.boundingBox())!];
      places.add(`${Math.round(c.height)} ${Math.round(n.y)} ${Math.round(n.x + n.width)}`);
    }
    expect([...places]).toHaveLength(1);
  });

  test("the welcome topic's picture: a request going in and a result coming out, drawn once, then still; another on the next topic, and still from the start with reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await firstVisit(page);
    const art = page.locator('.tour-art[data-art="welcome"]');
    await expect(art.locator('svg')).toBeVisible();
    // Decorative, and without words: the topic's text says what Harness Relay is.
    await expect(art).toHaveAttribute('aria-hidden', 'true');
    await expect(art.locator('svg')).toHaveText('');
    // Your request, Harness Relay's mark (the logo's three dots), and the result: two lines added, one removed, a check.
    await expect(art.locator('.request .you')).toHaveCount(1);
    await expect(art.locator('.mark circle')).toHaveCount(3);
    await expect(art.locator('.result .row.add')).toHaveCount(2);
    await expect(art.locator('.result .row.del')).toHaveCount(1);
    await expect(art.locator('.result .tour-art-badge')).toHaveCount(1);
    // The request comes first, top left; the result last, bottom right.
    const request = (await art.locator('.request').boundingBox())!;
    const result = (await art.locator('.result').boundingBox())!;
    expect(request.y + request.height).toBeLessThan(result.y);
    expect(request.x).toBeLessThan(result.x);
    // Above the topic's title, below the card's head.
    const box = (await art.locator('svg').boundingBox())!;
    const title = (await shown(page).boundingBox())!;
    const head = (await page.locator('.tour-head').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(box.y + box.height).toBeLessThanOrEqual(title.y);
    expect(box.height).toBeGreaterThan(180);

    // It plays once and comes to rest, with transform, opacity and the arrows' dash alone.
    await expect.poll(() => tourAnimations(page, true).then((a) => a.length)).toBeGreaterThan(0);
    await expect.poll(() => tourAnimations(page, true).then((a) => a.every((x) => x.state === 'finished')), { timeout: 10_000 }).toBe(true);
    const played = await tourAnimations(page, true);
    expect(played.every((a) => a.duration > 0 && Number.isFinite(a.duration))).toBe(true);
    expect([...new Set(played.flatMap((a) => a.changed))].sort()).toEqual(['opacity', 'strokeDashoffset', 'transform']);
    expect([...new Set(played.map((a) => a.name))].sort()).toEqual([
      'tour-art-draw',
      'tour-art-in',
      'tour-art-pop',
      'tour-art-ring',
      'tour-art-show',
      'tour-art-turn',
      'tour-art-write',
    ]);
    // At rest: the request, the mark and the result there, the arrows drawn, the ring gone.
    const atRest = async () => {
      for (const part of ['.request', '.mark', '.result', '.check']) await expect(art.locator(part)).toHaveCSS('opacity', '1');
      for (const edge of await art.locator('.edge').all()) await expect(edge).toHaveCSS('stroke-dashoffset', '0px');
      // The arrowheads shown, the lines written out whole.
      for (const tip of await art.locator('.tip').all()) await expect(tip).toHaveCSS('opacity', '1');
      // (After its animation, an identity matrix: the same as none.)
      for (const line of await art.locator('.line').all()) await expect(line).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
      await expect(art.locator('.halo')).toHaveCSS('opacity', '0');
    };
    await atRest();

    // The next topic has a picture of its own.
    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(shown(page)).toHaveText(titles[1]!);
    await expect(art).toHaveCount(0);
    await expect(page.locator('.tour-art[data-art="agents"] > svg')).toBeVisible();

    // With reduced motion: the still picture at once, nothing moving.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await listed(page, titles[0]!).click();
    await expect(art.locator('svg')).toBeVisible();
    expect(await tourAnimations(page, true)).toEqual([]);
    await atRest();
  });

  test('every topic has a picture of its own, without words, that comes to rest', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await firstVisit(page);
    const pictures = new Set<string>();
    for (const title of titles) {
      await listed(page, title).click();
      await expect(shown(page)).toHaveText(title);
      const art = page.locator('.tour-art');
      await expect(art).toHaveCount(1);
      await expect(art.locator('> svg')).toBeVisible();
      await expect(art).toHaveAttribute('aria-hidden', 'true');
      await expect(art).toHaveText('');
      pictures.add((await art.getAttribute('data-art'))!);
      await expect
        .poll(() => tourAnimations(page, true).then((a) => a.every((x) => x.state === 'finished')), { timeout: 10_000 })
        .toBe(true);
    }
    expect(pictures.size).toBe(titles.length);
  });

  test('a picture takes the room above its topic, and is left out where that is too little', async ({ page }) => {
    // A window that cuts the card: the picture shrinks to the room, between the head and the title.
    await page.setViewportSize({ width: 1280, height: 440 });
    await firstVisit(page);
    const svg = page.locator('.tour-art > svg');
    await expect(svg).toBeVisible();
    const box = (await svg.boundingBox())!;
    const head = (await page.locator('.tour-head').boundingBox())!;
    const title = (await shown(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(box.y + box.height).toBeLessThanOrEqual(title.y);
    expect(box.height).toBeLessThan(216);
    await expect(page.locator('.tour-foot')).not.toHaveClass(/scrolls/);
    // A short window: the card is cut to the screen, and the topic's text takes it all.
    await page.setViewportSize({ width: 1280, height: 320 });
    await expect(shown(page)).toHaveText(titles[0]!);
    await expect(svg).toBeHidden();
    // On a phone, the sheet makes room for it, between All topics and the title, so the topic's text does not scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(svg).toBeVisible();
    // Measured at once: the sheet may still be sliding up.
    const onPhone = await page.evaluate(() => {
      const rect = (part: string) => document.querySelector(`.tour-card ${part}`)!.getBoundingClientRect();
      return { all: rect('.tour-all'), room: rect('.tour-art'), svg: rect('.tour-art > svg'), title: rect('.tour-topic h3') };
    });
    expect(onPhone.svg.top).toBeGreaterThanOrEqual(onPhone.all.bottom);
    expect(onPhone.svg.top).toBeGreaterThanOrEqual(onPhone.room.top);
    expect(onPhone.svg.bottom).toBeLessThanOrEqual(onPhone.room.bottom);
    expect(onPhone.svg.bottom).toBeLessThanOrEqual(onPhone.title.top);
    await expect(page.locator('.tour-foot')).not.toHaveClass(/scrolls/);
  });
});

/** The page's background (`--bg`): the light theme's, or the dark one's. */
const BACKGROUND = { light: 'rgb(255, 255, 255)', dark: 'rgb(33, 33, 33)' } as const;

/** The browser's bar colour (`theme-color`) for the system's light and dark modes, in that order. */
async function barColors(page: Page): Promise<(string | null)[]> {
  return page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((m) => m.getAttribute('content')));
}

async function openAppearance(page: Page) {
  await page.getByRole('link', { name: /Settings & sign-in/ }).click();
  return page.locator('#settings-appearance').getByRole('radiogroup', { name: 'Appearance' });
}

test.describe('the theme', () => {
  test('dark or light chosen in Settings is set on the page, kept after a reload, and wins over the system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const html = page.locator('html');
    const body = page.locator('body');
    let themes = await openAppearance(page);
    await expect(themes.getByRole('radio', { name: 'Follow system' })).toHaveAttribute('aria-checked', 'true');

    await themes.getByRole('radio', { name: 'Dark' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(body).toHaveCSS('background-color', BACKGROUND.dark);
    expect(await barColors(page)).toEqual(['#212121', '#212121']);

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(body).toHaveCSS('background-color', BACKGROUND.dark);
    themes = page.locator('#settings-appearance').getByRole('radiogroup', { name: 'Appearance' });
    await expect(themes.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

    // Light stays light when the system turns dark.
    await themes.getByRole('radio', { name: 'Light' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(body).toHaveCSS('background-color', BACKGROUND.light);
    expect(await barColors(page)).toEqual(['#ffffff', '#ffffff']);
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(body).toHaveCSS('background-color', BACKGROUND.light);
  });

  test('following the system follows its light or dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const html = page.locator('html');
    const body = page.locator('body');
    const themes = await openAppearance(page);
    await themes.getByRole('radio', { name: 'Light' }).click();
    await expect(body).toHaveCSS('background-color', BACKGROUND.light);

    await themes.getByRole('radio', { name: 'Follow system' }).click();
    await expect(html).not.toHaveAttribute('data-theme');
    await expect(body).toHaveCSS('background-color', BACKGROUND.dark);
    // Each bar colour for its own mode again.
    expect(await barColors(page)).toEqual(['#ffffff', '#212121']);

    // The system switches while the page is open, and again after a reload.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(body).toHaveCSS('background-color', BACKGROUND.light);
    await page.reload();
    await appShown(page);
    await expect(html).not.toHaveAttribute('data-theme');
    await expect(body).toHaveCSS('background-color', BACKGROUND.light);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(body).toHaveCSS('background-color', BACKGROUND.dark);
  });
});
