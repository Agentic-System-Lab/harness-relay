import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { acceptNextDialog, composer, finishedReply, openTeamChat, send, settled } from '../support/app';

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
});
