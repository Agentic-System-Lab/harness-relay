import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat } from '../support/app';

test.describe('schedules', () => {
  test("a chat's schedule is saved, and running it once sends its message to the team", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Daily check');
    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    const drawer = page.getByRole('dialog', { name: 'Schedule' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Check the build');
    await drawer.getByRole('radio', { name: 'Every day' }).click();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    // Saved, it closes; the sidebar shows the chat has a schedule.
    await expect(drawer).toBeHidden();
    await expect(page.locator('.conv-item.active .conv-schedule')).toBeVisible();

    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    await expect(drawer.locator('.schedule-status')).toContainText('Every day at');
    await drawer.getByRole('button', { name: 'Run once now' }).click();
    await drawer.getByRole('button', { name: 'Close' }).click();
    const sent = page.locator('.msg-user', { hasText: 'Check the build' });
    await expect(sent).toBeVisible();
    await expect(sent).toContainText('Scheduled');
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “Check the build”.');
  });
});
