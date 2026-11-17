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

  test('a schedule that tracks a goal shows the progress a reply reports, and switches off once it is reached', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Track the build');
    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    const drawer = page.getByRole('dialog', { name: 'Schedule' });
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Check the build e2e:progress=done');
    await drawer.getByRole('textbox', { name: 'Goal to track (optional)' }).fill('The build passes');
    await drawer.getByRole('radio', { name: 'Every day' }).click();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();

    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    const progress = drawer.getByRole('region', { name: 'Progress on the goal' });
    await expect(progress).toContainText('No progress yet');
    await drawer.getByRole('button', { name: 'Run once now' }).click();
    await drawer.getByRole('button', { name: 'Close' }).click();

    // The reply's block is shown as a card, not as text; the agent was told the goal.
    const reply = await finishedReply(page, 'Codex');
    const card = reply.getByRole('note', { name: 'Progress on the goal' });
    await expect(card).toContainText('Done');
    await expect(card).toContainText('“The build passes”: done (Codex).');
    await expect(reply).not.toContainText('<progress');
    await expect(page.locator('.msg-system', { hasText: 'says the goal is reached; the schedule is off now' })).toBeVisible();

    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    await expect(progress).toContainText('Done');
    await expect(progress.locator('.progress-note')).toHaveCount(1);
    await expect(drawer.getByRole('checkbox', { name: 'On' })).not.toBeChecked();
  });

  test("a schedule's webhook shows its token once, and a program's call sends the message with what it posted", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Hooked');
    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    const drawer = page.getByRole('dialog', { name: 'Schedule' });
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('CI reported');
    await drawer.getByRole('radio', { name: 'Every day' }).click();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();

    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    const hook = drawer.getByRole('region', { name: 'Webhook' });
    await hook.getByRole('button', { name: 'Add a webhook' }).click();
    const example = hook.locator('.hook-example');
    await expect(example).toContainText('curl -X POST');
    const line = (await example.textContent())!;
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(line)![1]!;
    const url = /'(http:\/\/127\.0\.0\.1:\d+\/api\/hooks\/[^']+)'/.exec(line)![1]!;
    await expect(hook).toContainText('Not called yet');

    // A program on this computer: no browser's sign-in, only the token.
    const call = (bearer: string) =>
      fetch(url, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ event: 'ci-failed', branch: 'main' }) });
    expect((await call('wrong')).status).toBe(404);
    expect((await call(token)).status).toBe(202);
    await expect(hook).toContainText('Last called');
    await drawer.getByRole('button', { name: 'Close' }).click();

    const sent = page.locator('.msg-user', { hasText: 'CI reported' });
    await expect(sent).toContainText('Scheduled');
    await sent.getByText('What the webhook sent').click();
    await expect(sent.locator('.event-block pre')).toContainText('"event": "ci-failed"');
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “CI reported');

    // Shown once: opened again, the drawer has no token, only the way to make a new one.
    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).click();
    await expect(hook.locator('.hook-example')).toHaveCount(0);
    await expect(hook.getByRole('button', { name: 'New token' })).toBeVisible();
  });
});
