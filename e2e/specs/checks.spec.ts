import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { acceptNextDialog, composer, finishedReply, openTeamChat, send, settled } from '../support/app';
import { relaySandbox } from '../support/clis';

/*
 * Team checks: Harness Relay checks the team's work itself once the team has answered, whichever CLI
 * each member runs on. The fake CLI writes a file the chat protects (`e2e:write=…`); the card after
 * the replies says what failed and lets the user check again, ask a member to fix it, or skip it.
 */
const checkCards = (page: Page) => page.locator('.checks-card');

test.describe('team checks', () => {
  test('a protected file the team writes fails the check, holds what the user wrote meanwhile, and Skip lets it go', async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'edit',
      checks: { protectedPaths: ['secret.txt'] },
    });
    await send(page, 'Write the secret e2e:write=secret.txt e2e:slow=3');
    // Sent while the only member replies: no turn of this run is left to take it.
    await composer(page).fill('And then this');
    await composer(page).press('Enter');
    await expect(page.locator('.queue-tray')).toContainText('And then this');
    await finishedReply(page, 'Claude');

    const card = checkCards(page).last();
    await expect(card).toContainText('Team checks');
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Failed');
    await expect(card).toContainText('Protected paths');
    await expect(card.locator('.checks-findings')).toContainText("secret.txt added · in @Claude's turn");
    await expect(card).toContainText('Checked after the fact: nothing is undone.');
    // What waits stays until the user decides.
    const tray = page.locator('.queue-tray');
    await expect(tray).toContainText('The team checks failed: these are not delivered yet');
    await expect(tray.getByRole('button', { name: 'Send anyway' })).toBeVisible();

    acceptNextDialog(page);
    await card.getByRole('button', { name: 'Skip' }).click();
    await expect(card).toContainText('Skipped: the failure is kept');
    await expect(tray).toHaveCount(0);
    await expect(page.locator('.msg-user').filter({ hasText: 'And then this' })).toBeVisible();
    await settled(relay, id);
    // Skipped is not a pass: the card still says it failed, and offers no Skip any more.
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Failed');
    await expect(card.getByRole('button', { name: 'Skip' })).toHaveCount(0);
  });

  test('set in Team settings; Check again passes once the file is gone, and a member is asked to fix it', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.locator('.checks-editor summary').click();
    // Laid out in a column (some browsers ignore display: flex on <details>): each rule's name above
    // what is typed, and Add a command apart from the row after the editor.
    const editor = drawer.locator('.checks-editor');
    const gaps = await editor.evaluate((el) => {
      const rect = (q: string) => el.querySelector(q)!.getBoundingClientRect();
      return {
        label: rect('textarea').top - rect('.checks-field > label').bottom,
        after: el.nextElementSibling!.getBoundingClientRect().top - rect('.checks-add').bottom,
      };
    });
    expect(gaps.label).toBeGreaterThanOrEqual(0);
    expect(gaps.after).toBeGreaterThanOrEqual(12);
    await drawer.getByLabel('Protected paths').fill('../outside');
    await expect(drawer.locator('.checks-editor')).toContainText('"../outside" cannot be used');
    await drawer.getByLabel('Protected paths').fill('*.key\n');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect((await settled(relay, id)).settings.checks).toEqual({ protectedPaths: ['*.key'] });

    await send(page, 'Make a key e2e:write=deploy.key');
    await finishedReply(page, 'Claude');
    const failed = checkCards(page).last();
    await expect(failed.locator('.plan-head .checks-status')).toHaveText('Failed');

    // Ask the member to fix it: the user's message, and a turn of its own.
    await failed.getByRole('combobox', { name: 'Ask a member to fix it' }).selectOption({ label: 'Ask @Claude to fix it' });
    await expect(page.locator('.msg-user').last()).toContainText('@Claude please fix what failed in the latest team checks');
    await settled(relay, id);
    await expect(failed).toContainText('@Claude was asked to fix it');

    // The user takes the file away: checked again, it passes.
    const key = join(relay.workDir, 'deploy.key');
    expect(existsSync(key)).toBe(true);
    rmSync(key);
    await checkCards(page).last().getByRole('button', { name: 'Check again' }).click();
    const again = checkCards(page).last();
    await expect(again.locator('.plan-head .checks-status')).toHaveText('Passed');
    await expect(again).toContainText('Checked again');
    await expect(checkCards(page)).toHaveCount(2);
  });

  test('a read-only chat is not checked', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'read-only',
      checks: { protectedPaths: ['secret.txt'] },
    });
    await send(page, 'Try to write e2e:write=secret.txt');
    await finishedReply(page, 'Claude');
    await settled(relay, id);
    await expect(checkCards(page)).toHaveCount(0);
  });

  test('a command that fails shows how it ended and its output; Team settings tries one', async ({ page, relay }) => {
    test.skip(process.platform === 'win32', 'Commands are not checked on native Windows yet');
    const check = `node -e "if (require('fs').existsSync('broken.txt')) { console.log('broken.txt is not allowed'); process.exit(3) }"`;
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'full',
      checks: { commands: [{ id: 'node', run: check }] },
    });
    await send(page, 'Break it e2e:write=broken.txt');
    await finishedReply(page, 'Claude');
    const card = checkCards(page).last();
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Failed');
    const row = card.locator('.checks-outcomes > li').filter({ has: page.locator('.checks-command') });
    await expect(row.locator('.checks-command')).toHaveText(check);
    await expect(row).toContainText('exit 3');
    await expect(row).toContainText('Full access: run without the sandbox');
    await row.getByText('Output (the end)').click();
    await expect(row.locator('pre')).toHaveText('broken.txt is not allowed');
    await settled(relay, id);

    // Team settings: a second command, tried on the working directory as it is.
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.getByRole('button', { name: 'Add a command' }).click();
    const added = drawer.locator('.checks-command-row').last();
    await added.getByRole('textbox', { name: 'Command' }).fill('echo tried && exit 0');
    await added.getByRole('button', { name: 'Try it' }).click();
    await expect(added.locator('.checks-tried .checks-status')).toHaveText('Passed');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect((await settled(relay, id)).settings.checks!.commands!.map((c) => c.run)).toEqual([check, 'echo tried && exit 0']);
  });

  test("below full access, a command runs in Harness Relay's own sandbox, where it cannot write outside the working directory", async ({
    page,
    relay,
  }) => {
    const sandbox = relaySandbox();
    test.skip(!sandbox.ok, `Harness Relay's own sandbox does not work here: ${sandbox.reason}`);
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'edit',
      checks: {
        commands: [
          { id: 'in', run: 'echo inside > inside.txt' },
          { id: 'out', run: 'echo outside > "$HOME/outside.txt"' },
        ],
      },
    });
    await send(page, 'Change something e2e:write=notes.md');
    await finishedReply(page, 'Claude');
    const card = checkCards(page).last();
    await expect(card.locator('.plan-head .checks-status')).not.toHaveText('Checking', { timeout: 60_000 });
    const rows = card.locator('.checks-outcomes > li');
    await expect(rows.filter({ hasText: 'inside.txt' }).locator('.checks-status')).toHaveText('Passed');
    await expect(rows.filter({ hasText: 'inside.txt' })).toContainText('The check changed these files itself: inside.txt');
    // Refused by the sandbox: it could not run, never "the team's work failed".
    await expect(rows.filter({ hasText: 'outside.txt' }).locator('.checks-status')).toHaveText('Could not run');
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Could not run');
    await settled(relay, id);
  });

  test('in parallel mode, a result that breaks a check is not applied until the user applies it anyway', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'edit',
      mode: 'parallel',
      checks: { protectedPaths: ['secret.txt'] },
    });
    await send(page, 'Write it e2e:write=secret.txt');
    const reply = await finishedReply(page, 'Claude');
    // Checked once the team answered: found in the member's worktree.
    await expect(checkCards(page).last().locator('.checks-findings')).toContainText("in @Claude's worktree");
    await settled(relay, id);

    acceptNextDialog(page);
    await reply.getByRole('button', { name: 'Apply to working directory' }).click();
    const card = checkCards(page).last();
    await expect(card).toContainText("Checked before applying: the working directory with @Claude's result in it");
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Failed');
    await expect(card).toContainText('It did not pass, so it was not applied');
    expect(existsSync(join(relay.workDir, 'secret.txt'))).toBe(false);

    acceptNextDialog(page);
    await card.getByRole('button', { name: 'Apply anyway' }).click();
    await expect.poll(() => existsSync(join(relay.workDir, 'secret.txt'))).toBe(true);
    expect(readFileSync(join(relay.workDir, 'secret.txt'), 'utf8')).toContain('Claude');
    await expect(card.getByRole('button', { name: 'Apply anyway' })).toHaveCount(0);
  });

  test("in parallel mode, a result's command runs in Harness Relay's own sandbox on the working directory with the result in it", async ({
    page,
    relay,
  }) => {
    const sandbox = relaySandbox();
    test.skip(!sandbox.ok, `Harness Relay's own sandbox does not work here: ${sandbox.reason}`);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'edit',
      mode: 'parallel',
      checks: { commands: [{ id: 'has', run: 'test -f result.txt && echo checked > from-check.txt' }] },
    });
    await send(page, 'Make it e2e:write=result.txt');
    const reply = await finishedReply(page, 'Claude');
    acceptNextDialog(page);
    await reply.getByRole('button', { name: 'Apply to working directory' }).click();
    const card = checkCards(page).last();
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Passed', { timeout: 60_000 });
    await expect(card).toContainText('Applied to the working directory');
    await expect.poll(() => existsSync(join(relay.workDir, 'result.txt'))).toBe(true);
    // What the check wrote stayed in its own tree.
    expect(existsSync(join(relay.workDir, 'from-check.txt'))).toBe(false);
  });
});
