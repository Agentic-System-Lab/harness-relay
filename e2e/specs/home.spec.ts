import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { countPages, finishedReply, homePage, openNewChat, openTeamChat, send } from '../support/app';

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

  test('a part of the page that cannot be loaded: the page reloads once for it, then says so; the note closes, and Reload brings it', async ({ page }) => {
    // As in a page left open across an update, whose dialogs the new version replaced (src/web/chunks.ts).
    await page.route('**/assets/ReportDialog-*.js', (route) => route.fulfill({ status: 404, body: '' }));
    const pages = await countPages(page);
    const report = page.getByRole('button', { name: 'Report a problem' });
    await report.click();
    await expect.poll(pages).toBe(1);
    await expect(homePage(page)).toBeVisible();
    // Missing again so soon after: no reload this time, but a note instead of an empty page.
    await report.click();
    const note = page.getByRole('alert').filter({ hasText: 'This part of the page could not be loaded (Harness Relay may have just been updated).' });
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Close' }).click();
    await expect(note).toBeHidden();
    await expect(homePage(page)).toBeVisible();
    expect(await pages()).toBe(1);

    await page.unroute('**/assets/ReportDialog-*.js');
    await report.click();
    await note.getByRole('button', { name: 'Reload' }).click();
    await expect.poll(pages).toBe(2);
    await report.click();
    await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
  });

  test('a part of the page that loads but fails to draw says so, not that it could not be loaded, and the page does not reload', async ({ page }) => {
    // A dialog with a bug in it: a reload would not help, so the note says to report it.
    await page.route('**/assets/ReportDialog-*.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: "export function ReportDialog() { throw new Error('e2e: broken on purpose'); }" }),
    );
    const pages = await countPages(page);
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const note = page.getByRole('alert').filter({ hasText: 'This part of the page ran into a problem and could not be shown.' });
    await expect(note).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'could not be loaded' })).toHaveCount(0);
    expect(await pages()).toBe(0);
    await note.getByRole('button', { name: 'Close' }).click();
    await expect(note).toBeHidden();
  });

  test('a diagram that cannot be loaded shows its source, and the page does not reload for it', async ({ page, relay }) => {
    // Mermaid loads when a reply first has a diagram; it is not one of the parts the page reloads for.
    await page.route('**/assets/mermaid.core-*.js', (route) => route.fulfill({ status: 404, body: '' }));
    const pages = await countPages(page);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Draw it e2e:mermaid');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply.locator('.mermaid-block code')).toContainText('Question --> Answer');
    await expect(reply.getByText('This Mermaid diagram could not be drawn, so its source is shown.')).toBeVisible();
    expect(await pages()).toBe(0);
  });
});
