import { expect, test } from '../fixtures';
import { askAndConfirm, awaitingPlan, finishedReply, send, startChat } from '../support/app';

test.describe('templates', () => {
  test('the built-in templates are listed, and one opens to show its members', async ({ page }) => {
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

  test('the lead agent can pick a template as it is', async ({ page }) => {
    await startChat(page);
    await send(page, 'Should we rewrite it? e2e:template=builtin-debate');
    await expect(awaitingPlan(page)).toContainText('Using the template "Three-way debate"');
    await page.getByRole('button', { name: 'Confirm team' }).click();
    for (const [name, label] of [
      ['Proposer', 'Claude Code'],
      ['Pragmatist', 'Codex'],
      ['Skeptic', 'Grok'],
    ] as const) {
      const reply = await finishedReply(page, name);
      await expect(reply.locator('.provider-tag')).toHaveText(label);
      await expect(reply).toContainText('You said: “Should we rewrite it?”.');
    }
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
