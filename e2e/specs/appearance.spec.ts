import type { Page } from '@playwright/test';
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
    await expect(page.getByRole('dialog', { name: 'Welcome to Harness Relay' })).toBeVisible();
    const steps = await tourSteps(page);
    expect(steps).toBeGreaterThan(2);
    // The first step has nothing to go back to.
    await expect(tour(page).getByRole('button', { name: 'Back' })).toHaveCount(0);

    await tour(page).getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('dialog', { name: 'Check that each agent is signed in' })).toBeVisible();
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
    await expect(page.getByRole('dialog', { name: 'Adjust any time' })).toBeVisible();
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
