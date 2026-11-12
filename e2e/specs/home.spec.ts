import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { homePage, openNewChat, openTeamChat } from '../support/app';

/** The home page's animations: each one's name, its duration, how often it plays and what it changes. */
const animations = (page: Page) =>
  page.evaluate(() =>
    document.getAnimations().map((a) => {
      const effect = a.effect as KeyframeEffect;
      const timing = effect.getComputedTiming();
      const changed = new Set(effect.getKeyframes().flatMap((k) => Object.keys(k)));
      for (const key of ['offset', 'computedOffset', 'easing', 'composite']) changed.delete(key);
      return { name: (a as CSSAnimation).animationName, duration: Number(timing.duration), iterations: timing.iterations, changed: [...changed].sort() };
    }),
  );

const running = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

test.describe('the home page', () => {
  test('the app opens on it, and the logo and name lead back to it', async ({ page, relay }) => {
    await expect(homePage(page)).toBeVisible();
    await expect(page.locator('.home-hero .home-logo')).toBeVisible();
    const brand = page.locator('.sidebar').getByRole('link', { name: 'Harness Relay', exact: true });
    await expect(brand).toHaveAttribute('aria-current', 'page');

    await openNewChat(page);
    await expect(brand).not.toHaveAttribute('aria-current', 'page');
    await brand.click();
    await expect(homePage(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New chat' })).toHaveCount(0);

    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.sidebar .brand-logo').click();
    await expect(homePage(page)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/');
  });

  test('the logo plays its animation once on each visit, with transform and opacity alone, and not with reduced motion', async ({ page }) => {
    await expect(homePage(page)).toBeVisible();
    // Each part runs for a while (a nameless `animation` shorthand once minified to `none`, which runs
    // for no time at all), once, and changes only what the compositor can animate by itself.
    const first = await animations(page);
    expect(first.map((a) => a.name).sort()).toEqual(['home-join-claude', 'home-join-codex', 'home-join-grok', 'home-line-in', 'home-orbit']);
    for (const a of first) {
      expect(a.duration, a.name).toBeGreaterThan(0);
      expect(a.iterations, a.name).toBe(1);
      expect(a.changed.every((p) => p === 'transform' || p === 'opacity'), `${a.name} changes ${a.changed.join(', ')}`).toBe(true);
    }
    // It ends by itself, and plays again when the home page is opened again.
    await expect.poll(() => running(page)).toBe(0);
    await openNewChat(page);
    await page.locator('.sidebar').getByRole('link', { name: 'Harness Relay', exact: true }).click();
    await expect(homePage(page)).toBeVisible();
    expect(await running(page)).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(homePage(page)).toBeVisible();
    expect(await animations(page)).toEqual([]);
  });
});
