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
      return {
        name: (a as CSSAnimation).animationName,
        duration: Number(timing.duration),
        iterations: timing.iterations,
        changed: [...changed].sort(),
      };
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

  test('a first question and its workspace survive a trip to lead settings and are submitted once', async ({ page, relay }) => {
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.getByRole('link', { name: 'Start a new chat' }).click();
    const question = page.getByRole('textbox', { name: 'What would you like to accomplish?' });
    const options = page.locator('.chat-options > summary');
    const wait = page.getByRole('radio', { name: 'Wait for my confirmation' });
    const direct = page.getByRole('radio', { name: 'Start answering right away' });
    await expect(wait).toBeChecked();
    await expect(page.locator('.template-library .preset-main').first()).toBeHidden();
    await question.fill('Prepare a release summary');
    await options.click();
    await page.getByPlaceholder(/Conversation title/).fill('Release notes');
    const extra = relay.addProject('release');
    const folders = page.getByRole('combobox', { name: 'Working directories' });
    const folderLabel = page.locator('.settings-grid label', { hasText: 'Working directories' });
    const [labelBox, pickerBox] = await Promise.all([folderLabel.boundingBox(), page.locator('.chat-options .cwd-input').boundingBox()]);
    expect(pickerBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height);
    await folders.fill(extra);
    await folders.press('Enter');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await direct.check();
    await expect(page.locator('.page-head')).toContainText('answer right away');
    await page.getByRole('link', { name: 'Change the lead agent' }).click();
    await page.getByRole('link', { name: 'Return to new chat draft' }).click();
    await expect(question).toHaveValue('Prepare a release summary');
    await expect(direct).toBeChecked();
    await expect(options).toContainText('Edit');
    await expect(options).toContainText(extra);
    await options.click();
    await expect(page.getByPlaceholder(/Conversation title/)).toHaveValue('Release notes');
    await wait.check();
    await expect(page.locator('.page-head')).toContainText('wait for your confirmation');
    await page.getByRole('button', { name: 'Send first question' }).click();
    await expect(page.locator('.plan-card.awaiting')).toBeVisible();
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.msg-user')).toContainText('Prepare a release summary');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.getByRole('link', { name: 'Harness Relay', exact: true }).click();
    await page.getByRole('link', { name: 'Confirm the team for “Release notes”' }).click();
    await expect(page.locator('.plan-card.awaiting')).toBeVisible();
    await openNewChat(page);
    await expect(question).toHaveValue('');
    await expect(wait).toBeChecked();
    await direct.check();
    await page.getByRole('button', { name: 'Start chat →' }).click();
    await page.waitForURL(/#\/c\//);
    await openNewChat(page);
    await expect(direct).toBeChecked();
    await expect(page.locator('.page-head')).toContainText('answer right away');
  });

  for (const automation of [false, true]) {
    const name = automation ? 'New automation' : 'New chat';
    test(`${name} keeps a failed draft and leaves the current page in place after a background retry`, async ({ page }) => {
      const path = automation ? '/api/schedules' : '/api/conversations';
      await page.getByRole('button', { name, exact: true }).first().click();
      const message = page.locator('.first-task .task-input');
      await message.fill('Review this week’s invoices');
      const review = page.locator('.first-task-actions').getByRole('checkbox', { name: /review the team.s replies/i });
      await expect(review).toBeChecked();
      await review.uncheck();
      const expectedSections = automation
        ? ['.chat-options', '.automation-options', '.template-library']
        : ['.chat-options', '.template-library'];
      const boxes = await Promise.all(expectedSections.map((selector) => page.locator(selector + ' > summary').boundingBox()));
      for (let i = 1; i < boxes.length; i++) {
        const gap = boxes[i]!.y - (boxes[i - 1]!.y + boxes[i - 1]!.height);
        expect(gap).toBeGreaterThanOrEqual(-1);
        expect(gap).toBeLessThanOrEqual(4);
      }
      if (automation) {
        await page.locator('.automation-options > summary').click();
        await page.getByRole('checkbox', { name: 'Create a webhook too' }).check();
      }
      for (const fail of [true, false]) {
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
          finish = resolve;
        });
        await page.route('**' + path, async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          await held;
          if (fail) await route.fulfill({ status: 503, json: { error: 'Creation temporarily unavailable' } });
          else await route.continue();
        });
        const requested = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === path);
        const responded = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path);
        await page.locator('.first-task-actions button.primary').click();
        await requested;
        try {
          await page.getByRole('link', { name: /Change the lead agent/ }).click();
          await expect(page).toHaveURL(/#\/settings\/lead$/);
        } finally {
          finish();
        }
        const response = await responded;
        await page.unroute('**' + path);
        if (fail) {
          await page.getByRole('link', { name: /Return to .*draft/ }).click();
          await expect(page.getByRole('alert')).toContainText('Creation temporarily unavailable');
          await expect(message).toHaveValue('Review this week’s invoices');
          await expect(review).not.toBeChecked();
        } else {
          const { id } = await response.json();
          const created = page.locator(`.sidebar a[href="#/c/${id}"]`);
          await expect(created).toBeVisible();
          await expect(page).toHaveURL(/#\/settings\/lead$/);
          await created.click();
          if (automation) await expect(page.getByRole('dialog', { name: 'Automation' })).toContainText('The token is shown only this once');
        }
      }
    });
  }

  test('the logo plays its animation once on each visit, with transform and opacity alone, and not with reduced motion', async ({
    page,
  }) => {
    await expect(homePage(page)).toBeVisible();
    // Each part runs for a while (a nameless `animation` shorthand once minified to `none`, which runs
    // for no time at all), once, and changes only what the compositor can animate by itself.
    const first = await animations(page);
    expect(first.map((a) => a.name).sort()).toEqual([
      'home-line-in',
      'logo-join-claude',
      'logo-join-codex',
      'logo-join-grok',
      'logo-orbit',
    ]);
    for (const a of first) {
      expect(a.duration, a.name).toBeGreaterThan(0);
      expect(a.iterations, a.name).toBe(1);
      expect(
        a.changed.every((p) => p === 'transform' || p === 'opacity'),
        `${a.name} changes ${a.changed.join(', ')}`,
      ).toBe(true);
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

  test('a part of the page that cannot be loaded: the page reloads once for it, then says so; the note closes, and Reload brings it', async ({
    page,
  }) => {
    // As in a page left open across an update, whose dialogs the new version replaced (src/web/chunks.ts).
    await page.route('**/assets/ReportDialog-*.js', (route) => route.fulfill({ status: 404, body: '' }));
    const pages = await countPages(page);
    const report = page.getByRole('button', { name: 'Report a problem' });
    await report.click();
    await expect.poll(pages).toBe(1);
    await expect(homePage(page)).toBeVisible();
    // Missing again so soon after: no reload this time, but a note instead of an empty page.
    await report.click();
    const note = page
      .getByRole('alert')
      .filter({ hasText: 'This part of the page could not be loaded (Harness Relay may have just been updated).' });
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

  test('a part of the page that loads but fails to draw says so, not that it could not be loaded, and the page does not reload', async ({
    page,
  }) => {
    // A dialog with a bug in it: a reload would not help, so the note says to report it.
    await page.route('**/assets/ReportDialog-*.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: "export function ReportDialog() { throw new Error('e2e: broken on purpose'); }",
      }),
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
