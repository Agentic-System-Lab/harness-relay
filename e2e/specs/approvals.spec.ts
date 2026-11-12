import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, replies, send } from '../support/app';
import { CLIS, eachCli, endsTurnNote, member, needsBelowFull } from '../support/clis';

/*
 * A chat that asks the user: an agent that wants to run a command gets an approval card, and the
 * answer reaches its CLI (Claude Code's `can_use_tool`, Codex's approval request, the ACP agents'
 * `session/request_permission`, Pi's gate). Each CLI asks in a read-only chat, but Pi, which has no
 * command tool there: it asks in edit mode, about the one kind of command that asks there (`approve`).
 */
test.describe('approvals', () => {
  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: a command the user allows runs`, async ({ page, relay }) => {
      needsBelowFull(cli.provider);
      await openTeamChat(page, relay, [member(cli)], { permission: cli.approve.permission });
      await send(page, `Print a line ${cli.approve.directive}`);

      const card = page.getByRole('region', { name: `@${cli.name} wants to run a command` });
      await expect(card).toBeVisible();
      await expect(card.locator('.approval-detail')).toContainText(cli.approve.command);
      // The sidebar says the chat needs the user.
      await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Needs you');

      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('The command ran: e2e-approval.');
      await expect(reply.locator('.approval-done')).toContainText('Allowed');
    });

    test(`${cli.provider}: a command the user declines does not run, and the note goes with it`, async ({ page, relay }) => {
      needsBelowFull(cli.provider);
      await openTeamChat(page, relay, [member(cli)], { permission: cli.approve.permission });
      await send(page, `Print a line ${cli.approve.directive}`);
      const card = page.getByRole('region', { name: `@${cli.name} wants to run a command` });
      await card.getByPlaceholder(/Tell it what to do instead/).fill('Not now');
      await card.getByRole('button', { name: 'Decline' }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply.locator('.approval-done')).toContainText('Declined: Not now');
      // The note goes with the refusal to a CLI that takes one (`decline`: Codex's answer has no room
      // for it, Cursor's and others' CLI drop it); one that ends its turn after a refusal says nothing more.
      if (cli.decline === 'passed') await expect(reply).toContainText('The command was declined (the user said: Not now).');
      if (cli.decline === 'dropped') await expect(reply).toContainText('The command was declined.');
      if (cli.decline === 'ends-turn') {
        await expect(reply).toContainText(endsTurnNote(cli));
        await expect(reply).not.toContainText('The command was declined');
      }
    });
  });

  test('"Always allow" in a chat answers the same request by itself the next time', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Print a line e2e:approve');
    const card = page.getByRole('region', { name: '@Claude wants to run a command' });
    await card.getByRole('button', { name: /^Always allow "echo/ }).click();
    await expect(await finishedReply(page, 'Claude')).toContainText('The command ran: e2e-approval.');
    await expect(page.locator('.approval-done').last()).toContainText('Allowed for the rest of this chat');

    await send(page, 'Again e2e:approve');
    await expect(replies(page, 'Claude')).toHaveCount(2);
    const again = await finishedReply(page, 'Claude');
    await expect(again).toContainText('The command ran: e2e-approval.');
    await expect(again.locator('.approval-done')).toContainText('Allowed automatically (earlier answer in this chat)');
    await expect(page.locator('.approval-card')).toHaveCount(0);
  });

  test('stopping the team while a request waits ends it without running the command', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Print a line e2e:approve');
    await expect(page.getByRole('region', { name: '@Claude wants to run a command' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const reply = replies(page, 'Claude').last();
    await expect(reply).toContainText('(stopped)');
    await expect(reply.locator('.approval-done')).toContainText(/Declined|No answer \(the turn ended\)/);
    await expect(page.locator('.approval-card')).toHaveCount(0);
  });

  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: with full access, the command runs and files are written anywhere without asking`, async ({ page, relay }) => {
      const other = relay.addProject('other');
      await openTeamChat(page, relay, [member(cli)], { permission: 'full' });
      await expect(page.locator('.chat-head .head-warning')).toHaveText('Full access');
      await send(page, 'Do it all e2e:approve e2e:write=../other/free.txt');
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('The command ran: e2e-approval. I wrote ../other/free.txt.');
      await expect(page.locator('.approval-card')).toHaveCount(0);
      expect(existsSync(join(other, 'free.txt'))).toBe(true);
    });
  });

  test('a chat that refuses automatically declines without asking', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { approvals: 'deny' });
    await send(page, 'Print a line e2e:approve');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('The command was declined.');
    await expect(page.locator('.approval-card')).toHaveCount(0);
  });
});
