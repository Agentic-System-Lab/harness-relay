import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { askAndConfirm, awaitingPlan, finishedReply, heightWithoutAddCard, openNewChat, replies, send, settled, startChat } from '../support/app';
import { notInstalledBut } from '../support/fake-cli';

/** The CLI each member of the open template is on, in order. */
const memberClis = (page: Page) =>
  page.getByRole('dialog').locator('.agent-card:not(.add-card)').evaluateAll((cards) => cards.map((c) => c.querySelector('.cli-picker [aria-checked="true"]')?.textContent));

test.describe('templates on the CLIs that can run here', () => {
  test("a new template has a member for each CLI installed here only, also when opened before the CLIs' statuses came", async ({ page }) => {
    // The page reloaded and the template opened while the statuses were still on their way.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/providers$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.reload();
    await openNewChat(page);
    await page.locator('.preset-card.new-template .preset-main').click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('heading', { name: 'New template' })).toBeVisible();
    // Not one member per CLI, installed or not: none until the statuses come.
    expect(await memberClis(page)).toEqual([]);
    release();
    // Then one for each CLI installed and signed in here (the test server's three).
    await expect.poll(() => memberClis(page)).toEqual(['Claude Code', 'Codex', 'Grok']);
    // Nothing was changed by the user: closing asks nothing.
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
  });

  test.describe('without Grok', () => {
    test.use({ missingClis: [...notInstalledBut(), 'grok'] });

    test("a template's member on a CLI not installed here moves to one that is, says so, and the template can be saved so", async ({ page }) => {
      await openNewChat(page);
      // A new template: only the two installed.
      await page.locator('.preset-card.new-template .preset-main').click();
      await expect.poll(() => memberClis(page)).toEqual(['Claude Code', 'Codex']);
      await page.keyboard.press('Escape');
      // A built-in one: Grok's member moves to a CLI that can run (both are taken, so the first).
      await page.locator('.preset-card', { hasText: 'Three-way debate' }).locator('.preset-main').click();
      const editor = page.getByRole('dialog');
      await expect.poll(() => memberClis(page)).toEqual(['Claude Code', 'Codex', 'Claude Code']);
      await expect(editor.locator('input[value="Skeptic"]')).toBeVisible();
      await expect(editor).toContainText('Skeptic used a CLI that cannot run on this computer yet (not installed, or not signed in)');
      // Unchanged otherwise, it can still be saved as the user's, with the member moved.
      await expect(editor.getByRole('button', { name: 'Save as my template' })).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(editor).toBeHidden();
    });
  });
});

test.describe('templates', () => {
  test('the built-in templates are listed, and one opens to show its members', async ({ page }) => {
    await openNewChat(page);
    const card = page.locator('.preset-card', { hasText: 'Three-way debate' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Built-in');
    await card.locator('.preset-main').click();
    const editor = page.getByRole('dialog');
    await expect(editor).toBeVisible();
    for (const name of ['Proposer', 'Pragmatist', 'Skeptic']) await expect(editor.locator(`input[value="${name}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
  });

  test("in a template's editor, three columns wide, the add card lists every CLI on a row of its own and is as tall as a member beside it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1300 });
    await openNewChat(page);
    await page.locator('.preset-card', { hasText: 'Architect → Builder → Reviewer' }).locator('.preset-main').click();
    const editor = page.getByRole('dialog');
    const members = editor.locator('.agent-card:not(.add-card)');
    const add = editor.locator('.add-card');
    const list = editor.getByRole('group', { name: 'Add member' });
    const height = async (card: Locator) => (await card.boundingBox())!.height;
    const scrolls = () => list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    await expect(members).toHaveCount(3);
    expect(await editor.locator('.agent-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(3);

    // Its three members fill the first row: on a row of its own, every CLI is listed.
    expect(await scrolls()).toBe(false);
    // A fourth member: beside it, the member keeps its own height and the list scrolls.
    await list.getByRole('button', { name: '＋ Codex' }).click();
    await expect(members).toHaveCount(4);
    const fourth = await heightWithoutAddCard(page, members.nth(3));
    expect(Math.abs(fourth.shown - fourth.hidden)).toBeLessThanOrEqual(1);
    expect(await scrolls()).toBe(true);
    // Two members: beside them, in the first row.
    for (let i = 0; i < 2; i++) await members.first().getByRole('button', { name: 'Remove' }).click();
    await expect(members).toHaveCount(2);
    const two = await heightWithoutAddCard(page, members.first());
    expect(Math.abs(two.shown - two.hidden)).toBeLessThanOrEqual(1);
    expect(Math.abs((await height(add)) - two.shown)).toBeLessThanOrEqual(1);
    expect(await scrolls()).toBe(true);
  });

  test('the lead agent can pick a template as it is', async ({ page, relay }) => {
    const id = await startChat(page);
    await send(page, 'Should we rewrite it? e2e:template=builtin-debate');
    await expect(awaitingPlan(page)).toContainText('Using the template "Three-way debate"');
    await page.getByRole('button', { name: 'Confirm team' }).click();
    // Its two rounds: each member answers in the first, and in the second has nothing to add. Checked
    // once the run is over, so that a slow runner's second round is not taken for the first.
    await settled(relay, id);
    for (const [name, label] of [
      ['Proposer', 'Claude Code'],
      ['Pragmatist', 'Codex'],
      ['Skeptic', 'Grok'],
    ] as const) {
      const [first, second] = [replies(page, name).first(), replies(page, name).nth(1)];
      await expect(first.locator('.provider-tag')).toHaveText(label);
      await expect(first).toContainText('You said: “Should we rewrite it?”.');
      await expect(second).toContainText('Nothing to add (PASS)');
    }
    await expect(page.locator('.msg-agent')).toHaveCount(6);
  });

  test("a team the lead agent designed can be saved as a template", async ({ page }) => {
    await startChat(page);
    await askAndConfirm(page, 'Plan the release e2e:team=claude,grok e2e:name=Release_crew');
    await finishedReply(page, 'Grok');
    const plan = page.locator('.plan-card').last();
    // It asks for the template's name, the team's by default.
    page.once('dialog', (d) => {
      expect(d.defaultValue()).toBe('Release crew');
      void d.accept(d.defaultValue());
    });
    await plan.getByRole('button', { name: 'Save as template' }).click();
    await expect(plan).toContainText('Saved as the template "Release crew"');

    await page.getByRole('button', { name: 'New chat' }).first().click();
    await expect(page.locator('.preset-card', { hasText: 'Release crew' })).toBeVisible();
  });
});
