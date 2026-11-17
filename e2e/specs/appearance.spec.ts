import type { Page } from '@playwright/test';
import { en } from '../../src/web/locales/en';
import { expect, test } from '../fixtures';

/** The guided tour, whichever step it shows (each step names the dialog after its title). */
const tour = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Guided tour' });

/** The tour's "i / n", once it shows: n, the number of steps. */
async function tourSteps(page: Page): Promise<number> {
  const count = tour(page).getByText(/^\d+ \/ \d+$/);
  await expect(count).toHaveText(/^1 \/ \d+$/);
  return Number((await count.textContent())!.split('/')[1]);
}

/**
 * The animations in the tour (none while it is closed): each one's name, state, start, duration,
 * the properties it changes and the value it starts from. Those of the welcome step's picture
 * (`.tour-art`) are apart: `art` for them alone, else the card's and the backdrop's alone.
 */
function tourAnimations(page: Page, art = false) {
  return page.evaluate(
    (art) =>
      (document.querySelector('.tour')?.getAnimations({ subtree: true }) ?? [])
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

test.describe('the guided tour', () => {
  test.use({ tour: true });

  test('shows on a first visit, steps through to the end, and is not shown again', async ({ page }) => {
    // The steps as the English locale names them, so that a changed tour changes them here too.
    const titles = en.tour.steps.map((s) => s.title);
    await expect(page.getByRole('dialog', { name: titles[0] })).toBeVisible();
    const steps = await tourSteps(page);
    expect(steps).toBeGreaterThan(2);
    // The first step has nothing to go back to.
    await expect(tour(page).getByRole('button', { name: 'Back' })).toHaveCount(0);

    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('dialog', { name: titles[1] })).toBeVisible();
    await expect(tour(page).getByText(`2 / ${steps}`)).toBeVisible();
    await tour(page).getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    // The arrow keys step too.
    await page.keyboard.press('ArrowRight');
    await expect(tour(page).getByText(`2 / ${steps}`)).toBeVisible();

    for (let i = 3; i <= steps; i++) {
      await tour(page).getByRole('button', { name: 'Next' }).click();
      await expect(tour(page).getByText(`${i} / ${steps}`)).toBeVisible();
    }
    // The last step finishes it, with nothing left to skip.
    await expect(page.getByRole('dialog', { name: titles.at(-1) })).toBeVisible();
    await expect(tour(page).getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
    await tour(page).getByRole('button', { name: 'Get started' }).click();
    await expect(tour(page)).toBeHidden();

    await page.reload();
    await appShown(page);
    await expect(tour(page)).toHaveCount(0);
  });

  test('can be skipped, and Settings starts it again', async ({ page }) => {
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    await tour(page).getByRole('button', { name: 'Skip tour' }).click();
    await expect(tour(page)).toBeHidden();
    await page.reload();
    await appShown(page);
    await expect(tour(page)).toHaveCount(0);

    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    await tourSteps(page);
    // Escape ends it too, and it stays done.
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();
    await page.reload();
    await appShown(page);
    await expect(tour(page)).toHaveCount(0);
  });

  test("on a phone, the tour is a sheet at the bottom of the screen, and a long step's text scrolls above its buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    // The longest step: file permission and changes.
    const long = en.tour.steps.findIndex((s) => s.title === 'File permission and changes');
    expect(long).toBeGreaterThan(0);
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    for (let i = 0; i < long; i++) await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('dialog', { name: en.tour.steps[long]!.title })).toBeVisible();

    const card = page.locator('.tour-card:not(.tour-measure)');
    const text = card.locator('.tour-body');
    const next = card.getByRole('button', { name: 'Next' });
    // On the screen, its bottom at the screen's, with Next in it.
    const inView = async () => {
      const [c, n] = [await card.boundingBox(), await next.boundingBox()];
      return c!.y >= 0 && Math.abs(c!.y + c!.height - 560) <= 1 && n!.y + n!.height <= c!.y + c!.height;
    };
    expect(await inView()).toBe(true);
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
    // The next step starts at its top.
    await next.click();
    await expect(page.getByRole('dialog', { name: en.tour.steps[long + 1]!.title })).toBeVisible();
    expect((await sizes()).top).toBe(0);
  });

  test('on a phone, the tour slides up once as it opens, also from Settings, comes to rest at the bottom of the screen, and not with reduced motion', async ({
    page,
  }) => {
    // Opened at a phone's size: Next takes the focus while the sheet is still below the screen.
    await page.setViewportSize({ width: 390, height: 560 });
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    const card = page.locator('.tour-card:not(.tour-measure)');
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
    // The next step keeps the sheet where it is: the animation does not play again.
    await next.click();
    await expect(page.getByRole('dialog', { name: en.tour.steps[1]!.title })).toBeVisible();
    expect(await tourAnimations(page)).toEqual(opened);
    expect(await atBottom()).toBe(true);

    // Replayed from Settings, it slides up again.
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();
    const replay = async () => {
      await page.locator('#settings-tour').getByRole('button', { name: 'Replay the tour' }).click();
      await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
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

  test('on a wide screen, Next stays in one place through the steps in the middle of the screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    const card = page.locator('.tour-card:not(.tour-measure)');
    const next = card.getByRole('button', { name: 'Next' });
    // Only a phone's sheet slides in: here the card and the backdrop are still.
    expect(await tourAnimations(page)).toEqual([]);
    // Where Next is at each step in the middle of the screen (the others point at the sidebar).
    const places = new Set<number>();
    for (let i = 0; i < en.tour.steps.length - 1; i++) {
      await expect(page.getByRole('dialog', { name: en.tour.steps[i]!.title })).toBeVisible();
      if ((await card.getAttribute('class'))!.includes('centered')) places.add(Math.round((await next.boundingBox())!.y));
      await next.click();
    }
    expect(places.size).toBe(1);
  });

  test("the welcome step's picture: a request going in and a result coming out, drawn once, then still; not on the next step, and still from the start with reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    const art = page.locator('.tour-card:not(.tour-measure) .tour-art');
    await expect(art.locator('svg')).toBeVisible();
    // Decorative, and without words: the step's text says what Harness Relay is.
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
    // It fills the room the short text leaves: it starts below the text and ends above the dots.
    const text = (await page.locator('.tour-card:not(.tour-measure) .tour-body p').boundingBox())!;
    const box = (await art.locator('svg').boundingBox())!;
    const dots = (await page.locator('.tour-card:not(.tour-measure) .tour-dots').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(text.y + text.height);
    expect(box.y + box.height).toBeLessThanOrEqual(dots.y);
    expect(box.height).toBeGreaterThan(200);

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
    const shown = async () => {
      for (const part of ['.request', '.mark', '.result', '.check']) await expect(art.locator(part)).toHaveCSS('opacity', '1');
      for (const edge of await art.locator('.edge').all()) await expect(edge).toHaveCSS('stroke-dashoffset', '0px');
      // The arrowheads shown, the lines written out whole.
      for (const tip of await art.locator('.tip').all()) await expect(tip).toHaveCSS('opacity', '1');
      // (After its animation, an identity matrix: the same as none.)
      for (const line of await art.locator('.line').all()) await expect(line).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
      await expect(art.locator('.halo')).toHaveCSS('opacity', '0');
    };
    await shown();

    // The next step has no picture.
    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('dialog', { name: en.tour.steps[1]!.title })).toBeVisible();
    await expect(art).toHaveCount(0);

    // With reduced motion: the still picture at once, nothing moving.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tour(page).getByRole('button', { name: 'Back' }).click();
    await expect(art.locator('svg')).toBeVisible();
    expect(await tourAnimations(page, true)).toEqual([]);
    await shown();
  });

  test("the welcome step's picture takes the room the card leaves it, and is left out where that is too little", async ({ page }) => {
    // A window whose card leaves the picture less than its largest size: it shrinks to the room, between the text and the dots.
    await page.setViewportSize({ width: 1280, height: 520 });
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    const svg = page.locator('.tour-card:not(.tour-measure) .tour-art svg');
    await expect(svg).toBeVisible();
    const text = (await page.locator('.tour-card:not(.tour-measure) .tour-body p').boundingBox())!;
    const box = (await svg.boundingBox())!;
    const dots = (await page.locator('.tour-card:not(.tour-measure) .tour-dots').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(text.y + text.height);
    expect(box.y + box.height).toBeLessThanOrEqual(dots.y);
    expect(box.height).toBeLessThan(300);
    // A short window: the card is cut to the screen, and the step's text takes it all.
    await page.setViewportSize({ width: 1280, height: 380 });
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    await expect(page.locator('.tour-card:not(.tour-measure) .tour-art svg')).toBeHidden();
    // On a phone, the sheet makes room for it: in its room, between the text and the dots, so the step's text does not scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(svg).toBeVisible();
    // Measured at once: the sheet may still be sliding up.
    const onPhone = await page.evaluate(() => {
      const box = (part: string) => document.querySelector(`.tour-card:not(.tour-measure) ${part}`)!.getBoundingClientRect();
      return { text: box('.tour-body p'), room: box('.tour-art'), svg: box('.tour-art svg'), dots: box('.tour-dots') };
    });
    expect(onPhone.svg.top).toBeGreaterThanOrEqual(onPhone.text.bottom);
    expect(onPhone.svg.top).toBeGreaterThanOrEqual(onPhone.room.top);
    expect(onPhone.svg.bottom).toBeLessThanOrEqual(onPhone.room.bottom);
    expect(onPhone.svg.bottom).toBeLessThanOrEqual(onPhone.dots.top);
    await expect(page.locator('.tour-card:not(.tour-measure) .tour-foot')).not.toHaveClass(/scrolls/);
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
