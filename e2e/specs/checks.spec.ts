import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import type { Conversation, SettingsView } from '../../src/shared/types';
import {
  acceptNextDialog,
  chatId,
  composer,
  finishedReply,
  openNewChat,
  openToolCategory,
  openTeamChat,
  send,
  settled,
  submitFirstQuestion,
} from '../support/app';
import { relaySandbox } from '../support/clis';

/*
 * Team checks: Harness Relay checks the team's work itself once the team has answered, whichever CLI
 * each member runs on. The fake CLI writes a file the chat protects (`e2e:write=…`); the card after
 * the replies says what failed and lets the user check again, ask a member to fix it, or skip it.
 */
const checkCards = (page: Page) => page.locator('.checks-card');
const lastTeamField = (page: Page) => page.locator('.team-editor > section:last-child > :last-child');

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
    const editor = lastTeamField(page);
    const summary = editor.locator('summary');
    await expect(summary).toHaveText('Advanced settings');
    await summary.click();
    // Each rule's label stays above its input in the expanded section.
    const labelGap = await editor.evaluate(
      (el) =>
        el.querySelector('textarea')!.getBoundingClientRect().top -
        el.querySelector('.checks-field > label')!.getBoundingClientRect().bottom,
    );
    expect(labelGap).toBeGreaterThanOrEqual(0);
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

  test('an app the team makes must open in the preview, set in Team settings, and what fails goes back to the team by itself', async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await lastTeamField(page).locator('summary').click();
    await drawer.getByRole('checkbox', { name: 'The app the team builds must open in the preview' }).check();
    await drawer.getByRole('checkbox', { name: 'Send what did not pass back to the team to fix' }).check();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect((await settled(relay, id)).settings.checks).toEqual({ previewApp: true, autoFix: true });

    await send(page, 'Make a snake game e2e:write=snake/main.py');
    const fix = page.locator('.msg-user').filter({ hasText: '@Claude the team checks did not pass' });
    await expect(fix).toContainText('sent by Relay automatically, attempt 1 of 3');
    await expect(fix.locator('.queued-tag')).toHaveText("Relay's fix 1/3");
    await settled(relay, id);
    const card = checkCards(page).last();
    await expect(card.locator('.plan-head .checks-status')).toHaveText('Failed');
    await expect(card).toContainText('App preview');
    await expect(card.locator('.checks-findings')).toContainText('snake It has no Dockerfile');
    await expect(card).toContainText('Sent back to @Claude automatically (1 of 3)');
    // Its turn changed nothing, so there is nothing new to check: it waits for the user.
    await expect(checkCards(page)).toHaveCount(1);
    await expect(page.locator('.msg-user')).toHaveCount(2);
  });

  test('Team settings preserves updated checks when an open drawer refreshes its draft', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {
      permission: 'edit',
      checks: { protectedPaths: ['first-note.txt'] },
    });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    const paths = drawer.getByLabel('Protected paths');
    await expect(paths).toHaveValue('first-note.txt');

    await relay.api(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: {
        agents: [{ id: 'm1', name: 'Reviewer', provider: 'claude', role: 'Review notes.' }],
        settings: { checks: { protectedPaths: ['second-note.txt'] } },
      },
    });
    await expect(drawer.getByLabel('Agent name')).toHaveValue('Reviewer');
    await expect(paths).toHaveValue('second-note.txt');

    await drawer.getByRole('button', { name: 'Use Conventional Commits' }).click();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect((await settled(relay, id)).settings.checks?.protectedPaths).toEqual(['second-note.txt']);
  });

  test('Team settings requires a valid hook folder and time limit before saving', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.locator('.checks-editor summary').click();
    await drawer.getByRole('button', { name: 'Add a hook' }).click();
    await drawer.getByRole('textbox', { name: 'Hook command' }).fill('echo hello');
    const folder = drawer.getByLabel('Folder (relative to the first working directory; optional)', { exact: true });
    const timeout = drawer.getByLabel('Time limit (seconds)', { exact: true });
    const save = drawer.getByRole('button', { name: 'Save', exact: true });

    await folder.fill('../outside');
    await expect(save).toBeDisabled();
    await folder.fill('');
    await timeout.fill('0');
    await expect(save).toBeDisabled();
    await timeout.fill('5');
    await expect(save).toBeEnabled();
  });

  test("hooks set in Team settings run around a member's calls: a before hook refuses a command, an after hook's failure goes back to it", async ({
    page,
    relay,
  }) => {
    test.skip(process.platform === 'win32', 'Hooks do not run on native Windows yet');
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.locator('.checks-editor summary').click();
    await drawer.getByRole('button', { name: 'Add a hook' }).click();
    const before = drawer.locator('.checks-hook-row').last();
    await before.getByRole('textbox', { name: 'Hook command' }).fill('echo "not $RELAY_HOOK_COMMAND"; exit 1');
    await drawer.getByRole('button', { name: 'Add a hook' }).click();
    const after = drawer.locator('.checks-hook-row').last();
    await after.getByRole('combobox', { name: 'When' }).selectOption({ label: 'After' });
    await after.getByRole('combobox', { name: 'Which calls' }).selectOption({ label: 'File changes' });
    await after.getByRole('textbox', { name: 'Hook command' }).fill('echo "lint: $(basename $RELAY_HOOK_FILES) has 1 problem"; exit 1');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect((await settled(relay, id)).settings.checks!.hooks!.map((h) => [h.when, h.tools])).toEqual([
      ['before', 'command'],
      ['after', 'edit'],
    ]);

    await send(page, 'Run it e2e:approve');
    const refused = await finishedReply(page, 'Claude');
    await expect(refused).toContainText("The team's hook refused the command: not echo e2e-approval");
    await expect(refused.locator('.msg-notice')).toContainText('refused `echo e2e-approval`');
    await settled(relay, id);

    await send(page, 'Write it e2e:write=notes.txt');
    const told = await finishedReply(page, 'Claude');
    await expect(told).toContainText("The team's after hook said: lint: notes.txt has 1 problem");
    await expect(told.locator('.msg-notice')).toContainText('did not pass');
    // The call ran: an after hook reports, and undoes nothing.
    expect(existsSync(join(relay.workDir, 'notes.txt'))).toBe(true);
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
    // Checked before anything happened: not "after the fact".
    await expect(card).not.toContainText('Checked after the fact');
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

  test('hooks below Memory and default team checks validate and save independently', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#/settings/tools`);
    const hooks = await openToolCategory(page, 'Hooks');
    const checks = await openToolCategory(page, 'Default team checks');
    // Hooks come after Memory (long-term memory is in Labs).
    await expect(page.locator('.library-category:has(.memory-input) + details')).toHaveAccessibleName('Hooks');
    await expect(checks.getByLabel('Protected paths')).toBeVisible();
    await expect(checks.locator('details')).toHaveCount(0);
    await expect(checks.getByRole('button', { name: 'Add a hook' })).toHaveCount(0);

    const saveHooks = hooks.getByRole('button', { name: 'Save', exact: true });
    const saveChecks = checks.getByRole('button', { name: 'Save', exact: true });
    const folderLabel = 'Folder (relative to the first working directory; optional)';
    await checks.getByRole('button', { name: 'Add a command' }).click();
    const command = checks.getByRole('textbox', { name: 'Command', exact: true });
    await command.fill('echo check');
    await checks.getByLabel(folderLabel, { exact: true }).fill('../outside');
    await expect(saveChecks).toBeDisabled();
    await checks.locator(':scope > summary').click();
    await expect(command).toBeHidden();

    await hooks.getByRole('button', { name: 'Add a hook' }).click();
    const hook = hooks.getByRole('textbox', { name: 'Hook command' });
    await hook.fill('echo hook');
    await hooks.getByLabel(folderLabel, { exact: true }).fill('../outside');
    await expect(saveHooks).toBeDisabled();
    await hooks.getByLabel(folderLabel, { exact: true }).fill('');
    await hooks.getByLabel('Time limit (seconds)', { exact: true }).fill('0');
    await expect(saveHooks).toBeDisabled();
    await hooks.getByLabel('Time limit (seconds)', { exact: true }).fill('5');
    await saveHooks.click();
    await expect(hooks.getByRole('status')).toHaveText('Saved');
    const defaults = async () => (await relay.api<SettingsView>('/api/settings')).checksDefault;
    expect(await defaults()).toEqual({ hooks: [expect.objectContaining({ run: 'echo hook', timeoutSec: 5 })] });
    await openToolCategory(page, 'Default team checks');
    await expect(command).toHaveValue('echo check');
    await expect(checks.getByLabel(folderLabel, { exact: true })).toHaveValue('../outside');

    await hook.fill('unsaved hook');
    await checks.getByLabel(folderLabel, { exact: true }).fill('');
    await checks.getByLabel('Time limit (minutes)', { exact: true }).fill('0');
    await expect(saveChecks).toBeDisabled();
    await checks.getByLabel('Time limit (minutes)', { exact: true }).fill('1');
    await saveChecks.click();
    await expect(checks.getByRole('status')).toHaveText('Saved');
    await expect(hook).toHaveValue('unsaved hook');

    await page.reload();
    await openToolCategory(page, 'Hooks');
    await openToolCategory(page, 'Default team checks');
    await expect(hook).toHaveValue('echo hook');
    await expect(command).toHaveValue('echo check');
    const remove = hooks.getByRole('button', { name: 'Remove this hook' });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      // Read one layout frame: the settings page can still shift as CLI status cards load.
      const gaps = await hooks.locator('.checks-hook-row').evaluate((row) => {
        const rect = (selector: string) => row.querySelector(selector)!.getBoundingClientRect();
        const button = rect('button');
        return {
          top: button.top - rect('label').top,
          beside: button.left - rect('label:last-child select').right,
          right: button.right - rect('input[type="text"]').right,
        };
      });
      expect(gaps.top).toBeCloseTo(0);
      expect(gaps.beside).toBeGreaterThan(0);
      expect(gaps.right).toBeCloseTo(0);
    }
    await remove.click();
    await saveHooks.click();
    await expect(hooks.getByRole('status')).toHaveText('Saved');
    expect(await defaults()).toEqual({ commands: [expect.objectContaining({ run: 'echo check', timeoutMin: 1 })] });
  });

  test('a default set in Settings starts each new chat and automation, which can change or remove it', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#/settings/tools`);
    const section = await openToolCategory(page, 'Default team checks');
    await section.getByLabel('Protected paths').fill('.env\n*.pem');
    await section.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section).toContainText('Saved');
    // On the server, for every browser.
    expect((await relay.api<SettingsView>('/api/settings')).checksDefault).toEqual({ protectedPaths: ['.env', '*.pem'] });

    // A new chat starts with it, marked as the default (a template's own list replaces it).
    await openNewChat(page);
    const options = page.locator('.chat-options > summary');
    await options.click();
    const editor = lastTeamField(page);
    await expect(editor.locator('summary')).toContainText('Advanced settings');
    await expect(editor.getByLabel('Protected paths')).toHaveValue('.env\n*.pem');
    await submitFirstQuestion(page, 'Review the protected files');
    const chat = await relay.api<Conversation>(`/api/conversations/${chatId(page)}`);
    expect(chat.settings.checks).toEqual({ protectedPaths: ['.env', '*.pem'], fromDefault: true });

    // So does a new automation; removed there, it has none.
    await page.getByRole('button', { name: 'New automation' }).click();
    await options.click();
    await expect(editor.locator('summary')).toContainText('Advanced settings');
    await expect(editor.getByLabel('Protected paths')).toHaveValue('.env\n*.pem');
    await editor.getByLabel('Protected paths').fill('');
    await page.getByRole('textbox', { name: 'What should the team do?' }).fill('Check the build');
    await page.getByRole('button', { name: 'Create automation' }).click();
    await page.waitForURL(/#\/c\//);
    const automation = await relay.api<Conversation>(`/api/conversations/${chatId(page)}`);
    expect(automation.settings.checks).toEqual({});
    // Another default changes none made before.
    await page.goto(`${relay.base}/#/settings/tools`);
    await openToolCategory(page, 'Default team checks');
    await section.getByLabel('Protected paths').fill('*.key');
    await section.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section).toContainText('Saved');
    expect((await relay.api<SettingsView>('/api/settings')).checksDefault).toEqual({ protectedPaths: ['*.key'] });
    expect((await relay.api<Conversation>(`/api/conversations/${chat.id}`)).settings.checks).toEqual(chat.settings.checks);
    expect((await relay.api<Conversation>(`/api/conversations/${automation.id}`)).settings.checks).toEqual({});
  });
});
