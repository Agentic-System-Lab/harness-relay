import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send } from '../support/app';

/*
 * A read-only chat that asks the user: an agent that wants to run a command gets an approval card,
 * and the answer reaches its CLI (Claude Code's `can_use_tool`, Codex's approval request, Grok's
 * `session/request_permission`).
 */
const CLIS = [
  { name: 'Claude', provider: 'claude' },
  { name: 'Codex', provider: 'codex' },
  { name: 'Grok', provider: 'grok' },
] as const;

test.describe('approvals', () => {
  for (const cli of CLIS) {
    test(`${cli.provider}: a command the user allows runs`, async ({ page, relay }) => {
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }]);
      await send(page, 'Print a line e2e:approve');

      const card = page.getByRole('region', { name: `@${cli.name} wants to run a command` });
      await expect(card).toBeVisible();
      await expect(card.locator('.approval-detail')).toContainText('echo e2e-approval');
      // The sidebar says the chat needs the user.
      await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Needs you');

      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('The command ran: e2e-approval.');
      await expect(reply.locator('.approval-done')).toContainText('Allowed');
    });

    test(`${cli.provider}: a command the user declines does not run`, async ({ page, relay }) => {
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }]);
      await send(page, 'Print a line e2e:approve');
      const card = page.getByRole('region', { name: `@${cli.name} wants to run a command` });
      await card.getByPlaceholder(/Tell it what to do instead/).fill('Not now');
      await card.getByRole('button', { name: 'Decline' }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('The command was declined.');
      await expect(reply.locator('.approval-done')).toContainText('Declined');
    });
  }

  test('a chat that refuses automatically declines without asking', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { approvals: 'deny' });
    await send(page, 'Print a line e2e:approve');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('The command was declined.');
    await expect(page.locator('.approval-card')).toHaveCount(0);
  });
});
