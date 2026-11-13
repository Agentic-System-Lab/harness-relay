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

  test("on a phone, the tour is a sheet at the bottom of the screen, and a long step's text scrolls above its buttons", async ({ page }) => {
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
    const sizes = () => text.evaluate((el) => ({ top: el.scrollTop, scrolls: el.scrollHeight > el.clientHeight, max: el.scrollHeight - el.clientHeight }));
    expect(await sizes()).toMatchObject({ top: 0, scrolls: true });
    // The text scrolls under the buttons, with the keys too while Next has the focus.
    await next.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => { const s = await sizes(); return s.top >= s.max - 1; }).toBe(true);
    expect(await inView()).toBe(true);
    await expect(card.locator('.tour-foot.scrolls')).toBeVisible();
    // The next step starts at its top.
    await next.click();
    await expect(page.getByRole('dialog', { name: en.tour.steps[long + 1]!.title })).toBeVisible();
    expect((await sizes()).top).toBe(0);
  });

  test('on a wide screen, Next stays in one place through the steps in the middle of the screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    const card = page.locator('.tour-card:not(.tour-measure)');
    const next = card.getByRole('button', { name: 'Next' });
    // Where Next is at each step in the middle of the screen (the others point at the sidebar).
    const places = new Set<number>();
    for (let i = 0; i < en.tour.steps.length - 1; i++) {
      await expect(page.getByRole('dialog', { name: en.tour.steps[i]!.title })).toBeVisible();
      if ((await card.getAttribute('class'))!.includes('centered')) places.add(Math.round((await next.boundingBox())!.y));
      await next.click();
    }
    expect(places.size).toBe(1);
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

  test("following the system follows its light or dark mode", async ({ page }) => {
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
