import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Conversation } from '../../src/shared/types';
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

  test('"Approve for me", picked in Team settings: the lead agent allows a command, and leaves one it flags to the user', async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await expect(drawer.getByRole('radiogroup', { name: 'Actions beyond the permission' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Approve for me', exact: true }).click();
    await expect(drawer.getByRole('button', { name: 'Approve for me', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(drawer.getByText(/the lead agent reviews each action beyond it first/)).toBeVisible();
    // The lead agent answers first: there is no separate choice about what is beyond the permission.
    await expect(drawer.getByRole('radiogroup', { name: 'Actions beyond the permission' })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('.chat-head .badge', { hasText: 'Approve for me' })).toBeVisible();
    const saved = await relay.api<Conversation>(`/api/conversations/${id}`);
    expect(saved.settings).toMatchObject({ permission: 'edit', approvals: 'auto' });

    // Approved: the command runs without a card waiting, and its line says who approved it and why.
    await send(page, 'Print a line e2e:approve');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('The command ran: e2e-approval.');
    await expect(reply.locator('.approval-done')).toContainText('Approved for you by the lead agent: The fake lead agent finds it safe.');
    await expect(page.locator('.approval-card')).toHaveCount(0);

    // Flagged: it waits for the user, with the lead agent's reason.
    await send(page, 'Print another line e2e:approve e2e:flag');
    const card = page.getByRole('region', { name: '@Claude wants to run a command' });
    await expect(card).toBeVisible();
    await expect(card.locator('.approval-review')).toHaveText(
      'The lead agent found it potentially unsafe: The fake lead agent was told to flag it.',
    );
    await expect(card.locator('.approval-waiting')).toHaveText('Waiting for you');
    await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Needs you');
    // What it flags can be allowed once only: no rule would let the next one like it through unreviewed.
    await expect(card.getByRole('button', { name: /Always allow/ })).toHaveCount(0);
    await expect(card.locator('.approval-once')).toHaveText(
      'What the lead agent finds potentially unsafe can be allowed this once only, never always in this chat.',
    );
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(replies(page, 'Claude')).toHaveCount(2);
    const second = await finishedReply(page, 'Claude');
    await expect(second).toContainText('The command ran: e2e-approval.');
    await expect(second.locator('.approval-done')).toHaveText(/Allowed$/);
  });

  test('"Approve for me": while the lead agent reviews, nobody is waited for and the user may answer first; pushing is never reviewed', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit', approvals: 'auto' });
    await send(page, 'Print a line e2e:approve e2e:slowapprove=60');
    const card = page.getByRole('region', { name: '@Claude wants to run a command' });
    await expect(card.locator('.approval-waiting')).toHaveText('Lead agent reviewing…');
    await expect(card.locator('.approval-review')).toHaveText(
      'The lead agent is checking whether this is safe, usually within seconds: what it judges safe goes ahead without waiting for you, and it stops to ask you only about the rest. You can also decide now, without waiting for it.',
    );
    // It waits for nobody yet, and does not look as if it did: not the card that waits for the user (the
    // logo turning, no pause sign), its answers secondary and no note to give; no banner, and the chat
    // does not need the user.
    await expect(card).toHaveClass(/\breviewing\b/);
    await expect(card.locator('.approval-icon .logo-spinner')).toHaveCount(1);
    await expect(card.locator('.approval-note')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Allow without waiting' })).toHaveClass(/\bghost\b/);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    await expect(page.locator('.conv-item.active .conv-status')).not.toHaveText('Needs you');
    await card.getByRole('button', { name: 'Allow without waiting' }).click();
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('The command ran: e2e-approval.');
    // The user's answer, not the lead agent's.
    await expect(reply.locator('.approval-done')).toHaveText(/Allowed$/);

    // Publishing is never reviewed: it waits for the user at once, saying why.
    await send(page, 'Publish it e2e:approve=publish');
    const publish = page.getByRole('region', { name: '@Claude wants to run a command' });
    await expect(publish.locator('.approval-detail')).toContainText('npm publish e2e-approval');
    await expect(publish.locator('.approval-review')).toHaveText(
      'Pushing and publishing are always yours to decide: the lead agent never approves them for you',
    );
    await expect(publish.locator('.approval-waiting')).toHaveText('Waiting for you');
    await expect(page.locator('.approval-banner')).toBeVisible();
    await publish.getByRole('button', { name: 'Decline' }).click();
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await expect((await finishedReply(page, 'Claude')).locator('.approval-done')).toContainText('Declined');
  });

  test('a request a background subagent makes while the turn answers can still be answered after the turn has its reply', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'read-only' });
    await send(page, 'Start the job e2e:bgask');
    const card = page.getByRole('region', { name: '@Claude wants to run a command' });
    await expect(card.locator('.approval-detail')).toContainText('echo e2e-approval');
    // The turn has its reply meanwhile, and the request still waits for the user (Claude Code's input stays open).
    await expect(replies(page, 'Claude').last()).toContainText('Started a background job.');
    await page.waitForTimeout(1500);
    await expect(card.locator('.approval-waiting')).toHaveText('Waiting for you');
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    // The subagent ran it, and Claude Code said so in a turn of its own, in the same reply.
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText("The background job's command ran: e2e-approval.");
    await expect(reply.locator('.approval-done')).toHaveText(/Allowed$/);
  });

  test('a request the CLI stops waiting for while the lead agent reviews it says so at once, and the reply goes on', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit', approvals: 'auto' });
    await send(page, 'Print a line e2e:approve e2e:slowapprove=60 e2e:withdraw=2');
    const card = page.getByRole('region', { name: '@Claude wants to run a command' });
    await expect(card.locator('.approval-waiting')).toHaveText('Lead agent reviewing…');
    // Claude Code withdraws it (`control_cancel_request`): neither approved for the user nor expired.
    const reply = await finishedReply(page, 'Claude');
    await expect(page.locator('.approval-card')).toHaveCount(0);
    const line = reply.locator('.approval-done.withdrawn');
    await expect(line).toContainText('echo e2e-approval');
    await expect(line).toContainText('Withdrawn: its CLI stopped waiting for your answer, and an answer no longer reaches it');
    await expect(line).not.toContainText('Approved for you');
    await expect(line.locator('.approval-mark')).toHaveText('↩');
    await expect(reply).toContainText('It stopped waiting for an answer and decided by its own rule. The command ran: e2e-approval.');
    await expect(page.locator('.conv-item.active .conv-status', { hasText: 'Needs you' })).toHaveCount(0);
  });

  test('a long command, once answered, shows its first line, how many lines follow and the answer, and opens to all of it', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Print a line e2e:approve=long');
    const card = page.getByRole('region', { name: '@Claude wants to run a command' });
    // Waiting, all of it shows.
    await expect(card.locator('.approval-detail')).toContainText('sys.stdout.flush()');
    await card.getByPlaceholder(/Tell it what to do instead/).fill('Use echo instead, and keep it to one line in this project');
    await card.getByRole('button', { name: 'Decline' }).click();
    const reply = await finishedReply(page, 'Claude');
    const line = reply.locator('.approval-fold');
    const summary = line.locator('summary');
    await expect(line.locator('.approval-head-line')).toHaveText("python3 - <<'EOF'");
    await expect(line.locator('.approval-more')).toHaveText('+5 lines');
    await expect(line.locator('.approval-outcome')).toHaveText('Declined: Use echo instead, and keep it to one line in this project');
    const full = line.locator('.approval-full');
    await expect(full).toBeHidden();
    await summary.click();
    await expect(full).toBeVisible();
    // The whole command, its line breaks kept.
    expect(await full.evaluate((el) => el.textContent)).toMatch(/^python3 - <<'EOF'\n# e2e:approve=long: .*\nimport sys\n[\s\S]*\nEOF$/);
    // From the keyboard too.
    await summary.press('Enter');
    await expect(full).toBeHidden();
  });

  test('a chat that refuses automatically declines without asking', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { approvals: 'deny' });
    await send(page, 'Print a line e2e:approve');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('The command was declined.');
    await expect(page.locator('.approval-card')).toHaveCount(0);
  });
});
