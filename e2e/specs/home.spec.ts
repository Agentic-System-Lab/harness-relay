import { availableDraftApps } from '../support/draft-apps';
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
    await availableDraftApps(page, { drive: 'ready', browser: 'ready', mail: 'needs-connection' });
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.getByRole('link', { name: 'Start a new chat' }).click();
    const question = page.getByRole('textbox', { name: 'What would you like to accomplish?' });
    await expect(question).toHaveAttribute('placeholder', 'For example, what should I buy for a picnic this weekend?');
    await expect(question).toBeEmpty();
    const options = page.locator('.chat-options > summary');
    const wait = page.getByRole('radio', { name: 'Wait for my confirmation' });
    const direct = page.getByRole('radio', { name: 'Start answering right away' });
    const submit = page.getByRole('button', { name: 'Send question' });
    await expect(submit).toBeDisabled();
    await page
      .locator('input[type="file"]:not([webkitdirectory])')
      .setInputFiles({ name: 'agenda.txt', mimeType: 'text/plain', buffer: Buffer.from('Release agenda') });
    await question.fill(' \n\t ');
    await expect(submit).toBeDisabled();
    await expect(wait).toBeChecked();
    await expect(page.locator('.template-library .preset-main').first()).toBeHidden();
    await question.fill('Prepare a release summary');
    await expect(submit).toBeEnabled();
    await question.clear();
    await expect(submit).toBeDisabled();
    await question.fill('Prepare a release summary');
    const apps = page.locator('.first-input-tools').getByRole('button', { name: /Common apps/ });
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(apps).toBeInViewport();
    await question.press('Tab');
    await expect(apps).toBeFocused();
    const grants = async () => (await relay.api<{ relayTools: unknown }>('/api/tools')).relayTools;
    const previousGrants = await grants();
    await apps.press('Enter');
    const choices = page.getByRole('group', { name: 'Common apps', exact: true });
    await expect(choices.getByRole('checkbox', { name: 'Google Drive', exact: true })).toBeFocused();
    await expect(choices.getByRole('checkbox', { name: 'Mail', exact: true })).toBeDisabled();
    await expect(choices.getByRole('checkbox', { name: 'Mail', exact: true })).toHaveAccessibleDescription('Connection required');
    await expect(choices.getByRole('checkbox')).toHaveCount(10);
    await expect(choices.locator('input:checked')).toHaveCount(0);
    const drive = choices.getByRole('checkbox', { name: 'Google Drive' });
    await drive.press('Space');
    await choices.getByRole('checkbox', { name: 'Browser' }).check();
    await choices.getByRole('checkbox', { name: 'Browser' }).uncheck();
    await expect(page.locator('.draft-app-selection')).toHaveText('Please use Google Drive for this task.');
    await expect(page).toHaveURL(/#\/new$/);
    await question.fill(' ');
    await expect(submit).toBeDisabled();
    await question.fill('Prepare a release summary');
    await choices.getByRole('link', { name: 'Manage app connections' }).press('Enter');
    await expect(page.getByRole('tab', { name: 'Common apps' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('listitem', { name: 'Google Drive', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Return to new chat draft' }).press('Enter');
    await expect(question).toHaveValue('Prepare a release summary');
    await expect(page.locator('.attach-tray')).toContainText('agenda.txt');
    await expect(page.locator('.draft-app-selection')).toHaveText('Please use Google Drive for this task.');
    await apps.click();
    await expect(drive).toBeChecked();
    await drive.press('Escape');
    await expect(choices).toBeHidden();
    await expect(apps).toBeFocused();
    expect(await grants()).toEqual(previousGrants);
    expect(await relay.api('/api/conversations')).toEqual([]);
    await page.setViewportSize(viewport);
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
    await expect(page.locator('.attach-tray')).toContainText('agenda.txt');
    await expect(direct).toBeChecked();
    await expect(options).toContainText('Edit');
    await expect(options).toContainText(extra);
    await options.click();
    await expect(page.getByPlaceholder(/Conversation title/)).toHaveValue('Release notes');
    await wait.check();
    await expect(page.locator('.page-head')).toContainText('wait for your confirmation');
    await submit.click();
    await expect(page.locator('.plan-card.awaiting')).toBeVisible();
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.msg-user .msg-attachments')).toContainText('agenda.txt');
    await expect(page.locator('.msg-user')).toContainText('Prepare a release summary');
    await expect(page.locator('.msg-user')).toContainText('Please use Google Drive for this task.');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.getByRole('link', { name: 'Harness Relay', exact: true }).click();
    await page.getByRole('link', { name: 'Confirm the team for “Release notes”' }).click();
    await expect(page.locator('.plan-card.awaiting')).toBeVisible();
    await openNewChat(page);
    await expect(question).toHaveValue('');
    await expect(wait).toBeChecked();
    await direct.check();
    await expect(submit).toBeDisabled();
    await expect(page.locator('.attach-tray')).toHaveCount(0);
    await question.fill('Summarize the follow-up work');
    await submit.click();
    await page.waitForURL(/#\/c\//);
    await openNewChat(page);
    await expect(direct).toBeChecked();
    await expect(page.locator('.page-head')).toContainText('answer right away');
  });

  for (const automation of [false, true]) {
    const name = automation ? 'New automation' : 'New chat';
    test(name + ' pins its actions and indicates when the form can scroll further', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1500 });
      await page.getByRole('button', { name, exact: true }).first().click();
      const pane = page.locator('.new-chat-body');
      const footer = page.locator('.creation-footer');
      const expectCenteredButtons = async () => {
        const row = (await footer.boundingBox())!;
        for (const button of await footer.getByRole('button').all()) {
          const box = (await button.boundingBox())!;
          const above = box.y - row.y - 1; // Measure from the inside edge of the divider.
          const below = row.y + row.height - box.y - box.height;
          expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
        }
      };
      const hint = page.getByRole('button', { name: 'Scroll down to see more' });
      const submit = footer.getByRole('button', { name: automation ? 'Create automation' : 'Send question' });
      await expect(submit).toBeInViewport();
      await expect(pane.getByRole('radio', { name: 'Wait for my confirmation' })).toHaveCount(1);
      await expect(pane.getByRole('checkbox', { name: /review the team.s replies/i })).toHaveCount(1);
      await expect(hint).toHaveCount(0);
      await expectCenteredButtons();
      const card = page.locator('.first-task');
      const short = (await card.boundingBox())!;
      expect(short.y + short.height).toBeLessThan(1400); // A short card ends before the viewport's bottom.
      const message = pane.locator('.task-input');
      await message.fill('A line in a long task description.\n'.repeat(60));
      expect(
        await message.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollTop;
        }),
      ).toBeGreaterThan(0);
      expect(await card.boundingBox()).toEqual(short);
      await message.fill('');
      await page.setViewportSize({ width: 390, height: 620 });
      await page.locator('.chat-options > summary').click();
      await pane.evaluate((el) => el.scrollTo(0, 0));
      await expect(hint).toBeInViewport();
      const fields = (await pane.boundingBox())!;
      expect((await hint.boundingBox())!.y).toBeGreaterThanOrEqual(fields.y + fields.height - 1);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(hint.locator('svg')).toHaveCSS('animation-name', 'creation-scroll-down');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(hint.locator('svg')).toHaveCSS('animation-name', 'none');
      // At rest, the arrow in the middle of its circle, across and down.
      const circle = (await hint.boundingBox())!;
      const arrow = (await hint.locator('svg').boundingBox())!;
      expect(arrow.x + arrow.width / 2).toBeCloseTo(circle.x + circle.width / 2, 1);
      expect(arrow.y + arrow.height / 2).toBeCloseTo(circle.y + circle.height / 2, 1);
      await expectCenteredButtons();
      const pinned = await footer.boundingBox();
      const frame = (await card.boundingBox())!;
      expect(pinned!.y + pinned!.height).toBeCloseTo(frame.y + frame.height - 1, 0);
      expect(frame.y + frame.height).toBeLessThan(620);
      expect(pinned!.x).toBeGreaterThan(frame.x);
      const heading = await page.locator('#creation-title').boundingBox();
      await hint.click();
      await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      // Only the blank padding below the last field remains to scroll.
      await pane.evaluate((el) => el.scrollTo(0, el.scrollHeight - el.clientHeight - 3));
      await expect(hint).toHaveCount(0);
      await pane.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect(hint).toHaveCount(0);
      await expect(pane.getByRole('checkbox', { name: /review the team.s replies/i })).toBeInViewport();
      await expect(submit).toBeInViewport();
      expect(await footer.boundingBox()).toEqual(pinned);
      expect(await page.locator('#creation-title').boundingBox()).toEqual(heading);
      await pane.evaluate((el) => el.scrollTo(0, 0));
      await expect(hint).toBeVisible();
      await page.locator('.chat-options > summary').click();
      await page.setViewportSize({ width: 1440, height: 1500 });
      await expect(hint).toHaveCount(0);
    });

    test(`${name} keeps a failed draft and leaves the current page in place after a background retry`, async ({ page }) => {
      const path = automation ? '/api/schedules' : '/api/conversations';
      await page.getByRole('button', { name, exact: true }).first().click();
      const message = page.locator('.first-task .task-input');
      await message.fill('Review this week’s invoices');
      const review = page.locator('.creation-fields').getByRole('checkbox', { name: /review the team.s replies/i });
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
          await page.setViewportSize({ width: 390, height: 844 });
          const created = page.getByRole('link', { name: automation ? 'Open created automation' : 'Open created chat' });
          await expect(created).toHaveAttribute('href', `#/c/${id}`);
          await expect(page.getByRole('link', { name: /Return to .*draft/ })).toHaveCount(0);
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
