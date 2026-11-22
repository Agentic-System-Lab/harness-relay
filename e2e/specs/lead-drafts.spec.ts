import type { Conversation } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { en } from '../../src/web/locales/en';
import { finishedReply, openNewChat, openTeamChat, send, startChat } from '../support/app';
import { needsRelaySandbox, withClis } from '../support/clis';

/*
 * The lead agent helping outside a conversation's team: writing a template, team checks and an
 * automation in their editors, a schedule a member proposes in its reply, organizing the sidebar's
 * groups, and naming new chats. The fake lead agent's answers are `templateReply`, `checksReply`,
 * `scheduleReply`, `organizeReply` and `titleIn` in `fake-cli/lib/plan.cjs`.
 */

test.describe("the lead agent's drafts in the editors", () => {
  test('writes a new template, which can be undone, and is kept once saved', async ({ page }) => {
    await openNewChat(page);
    await page.locator('.template-library > summary').click();
    await page.locator('.preset-card.new-template .preset-main').click();
    const editor = page.getByRole('dialog', { name: 'New template' });
    const name = editor.getByRole('textbox', { name: 'Template name' });
    await expect(name).toHaveValue('');
    await editor.getByRole('textbox', { name: en.templateDraft.title }).fill('A team to review pull requests');
    await editor.getByRole('button', { name: en.templateDraft.submit }).click();
    const result = editor.locator('.team-reviser-result');
    await expect(result).toContainText('The fake lead agent wrote a review pair.');
    await expect(result).toContainText('named it "Review pair"');
    await expect(result).toContainText('rewrote the description');
    await expect(name).toHaveValue('Review pair');
    await expect(editor.locator('input[value="Reviewer"]')).toBeVisible();
    await expect(editor.locator('input[value="Tester"]')).toBeVisible();
    // Undo puts the editor back as it was.
    await result.getByRole('button', { name: 'Undo' }).click();
    await expect(name).toHaveValue('');
    await expect(editor.locator('input[value="Reviewer"]')).toHaveCount(0);
    // Asked again, and saved.
    await editor.getByRole('textbox', { name: en.templateDraft.title }).fill('A team to review pull requests');
    await editor.getByRole('button', { name: en.templateDraft.submit }).click();
    await expect(name).toHaveValue('Review pair');
    await editor.getByRole('button', { name: 'Save template' }).click();
    await expect(editor).toBeHidden();
    await expect(page.locator('.preset-card', { hasText: 'Review pair' })).toBeVisible();
  });

  test("writes a chat's team checks after reading its project, kept once the team is saved", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    await drawer.locator('.checks-editor > summary').click();
    await drawer.getByRole('textbox', { name: en.checksDraft.title }).fill('Run the tests, and keep the secrets out');
    await drawer.getByRole('button', { name: en.checksDraft.submit }).click();
    const result = drawer.locator('.checks-editor .team-reviser-result');
    await expect(result).toContainText('The fake lead agent read the project and wrote the checks.');
    await expect(result).toContainText('protected .env');
    await expect(result).toContainText('added the command npm test');
    await expect(drawer.getByRole('textbox', { name: 'Protected paths' })).toHaveValue('.env');
    await expect(drawer.getByRole('textbox', { name: en.checks.commandRun })).toHaveValue('npm test');
    // The team drawer's own "Ask the lead agent", for its team, is apart from it.
    await expect(drawer.getByRole('textbox', { name: 'Ask the lead agent' })).toHaveCount(1);
    // Undo takes back the lead agent's rules only: a member renamed since keeps its new name.
    await drawer.getByRole('textbox', { name: 'Agent name' }).fill('Claudia');
    await result.getByRole('button', { name: 'Undo' }).click();
    await expect(drawer.getByRole('textbox', { name: 'Protected paths' })).toHaveValue('');
    await expect(drawer.getByRole('textbox', { name: 'Agent name' })).toHaveValue('Claudia');
    await drawer.getByRole('textbox', { name: en.checksDraft.title }).fill('Run the tests, and keep the secrets out');
    await drawer.getByRole('button', { name: en.checksDraft.submit }).click();
    await expect(drawer.getByRole('textbox', { name: 'Protected paths' })).toHaveValue('.env');
    await expect(drawer.getByRole('textbox', { name: 'Agent name' })).toHaveValue('Claudia');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    const conv = await relay.api<Conversation>(`/api/conversations/${id}`);
    expect(conv.settings.checks).toMatchObject({ protectedPaths: ['.env'], commands: [{ run: 'npm test' }] });
    expect(conv.agents.map((a) => a.name)).toEqual(['Claudia']);
  });

  test('fills in a new automation from a sentence', async ({ page }) => {
    await page.getByRole('button', { name: 'New automation' }).click();
    await page.getByRole('textbox', { name: en.scheduleDraft.title }).fill('Every evening, sum up what changed');
    await page.getByRole('button', { name: en.scheduleDraft.submit }).click();
    await expect(page.locator('.team-reviser-result')).toContainText('The fake lead agent set it for every evening.');
    await expect(page.getByRole('textbox', { name: en.newSchedule.task })).toHaveValue('Sum up what changed today.');
    await expect(page.getByRole('combobox', { name: en.schedule.repeat })).toHaveValue('daily');
    await expect(page.locator('input[type="time"]')).toHaveValue('18:00');
    await expect(page.getByRole('button', { name: en.newSchedule.create })).toBeEnabled();
  });
});

test.describe('with an open agent as the lead agent', () => {
  withClis('pi');

  test("drafts in an empty folder its sandbox may read, outside Harness Relay's temporary folder", async ({ page, relay }) => {
    needsRelaySandbox('pi');
    await relay.api('/api/settings', { method: 'PUT', body: { lead: { provider: 'pi' } } });
    await page.reload();
    await page.getByRole('button', { name: 'New automation' }).click();
    await page.getByRole('textbox', { name: en.scheduleDraft.title }).fill('Every evening, sum up what changed');
    await page.getByRole('button', { name: en.scheduleDraft.submit }).click();
    await expect(page.locator('.team-reviser-result')).toContainText('The fake lead agent set it for every evening.', { timeout: 30_000 });
    await expect(page.getByRole('textbox', { name: en.newSchedule.task })).toHaveValue('Sum up what changed today.');
  });
});

test.describe('a schedule a member proposes in its reply', () => {
  test('is a card the user creates it from, changes in the form first, or dismisses', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Check the build every morning e2e:propose');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).not.toContainText('<schedule>');
    const card = reply.locator('.schedule-proposal');
    await expect(card).toContainText(en.proposal.title);
    await expect(card).toContainText('Check the build');
    await expect(card).toContainText(en.proposal.note);
    await card.getByRole('button', { name: en.proposal.create }).click();
    await expect(card).toContainText(en.proposal.created);
    await expect(card.getByRole('button')).toHaveCount(0);
    let conv = await relay.api<Conversation>(`/api/conversations/${id}`);
    expect(conv.schedule).toMatchObject({ text: 'Check the build', repeat: { kind: 'daily', time: '08:00' }, enabled: true });

    // Another, changed in the form before it is saved; it replaces the one there is.
    await send(page, 'At nine instead e2e:propose');
    const second = page.locator('.schedule-proposal').last();
    await expect(second).toContainText(en.proposal.replaces);
    await second.getByRole('button', { name: en.proposal.edit }).click();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    const message = drawer.getByRole('textbox', { name: en.schedule.message });
    await expect(message).toHaveValue('Check the build');
    await message.fill('Check the build and the tests');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(second).toContainText(en.proposal.created);
    conv = await relay.api<Conversation>(`/api/conversations/${id}`);
    expect(conv.schedule?.text).toBe('Check the build and the tests');

    // One whose trigger needs an account the agent could not know: the form, or dismissing it.
    await send(page, 'When CI mails me e2e:propose=mail');
    const third = page.locator('.schedule-proposal').last();
    await expect(third).toContainText(en.proposal.gapAccount);
    await expect(third.getByRole('button', { name: en.proposal.create })).toBeDisabled();
    await third.getByRole('button', { name: en.proposal.dismiss }).click();
    await expect(third).toContainText(en.proposal.dismissed);
    conv = await relay.api<Conversation>(`/api/conversations/${id}`);
    expect(conv.schedule?.text).toBe('Check the build and the tests');
  });
});

test('the lead agent suggests groups for the sidebar, and applies the ones the user ticks', async ({ page, relay }) => {
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Invoice for ACME');
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Fix the build');
  await page.getByRole('button', { name: en.groupsDraft.open }).click();
  const dialog = page.getByRole('dialog', { name: en.groupsDraft.title });
  await dialog.getByRole('button', { name: en.groupsDraft.ask }).click();
  await expect(dialog).toContainText('The fake lead agent put them all in one group.');
  await expect(dialog.getByRole('checkbox', { name: 'E2E projects', exact: true })).toBeChecked();
  const moveInvoice = dialog.getByRole('checkbox', { name: /Invoice for ACME/ });
  await expect(moveInvoice).toBeChecked();
  // Without its new group, a move into it cannot be made.
  await dialog.getByRole('checkbox', { name: 'E2E projects', exact: true }).uncheck();
  await expect(moveInvoice).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /^Apply/ })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'E2E projects', exact: true }).check();
  await dialog.getByRole('button', { name: en.groupsDraft.apply(3) }).click();
  await expect(dialog).toBeHidden();
  const group = page.getByRole('navigation', { name: 'Conversations' }).getByRole('region', { name: 'E2E projects' });
  await expect(group).toContainText('Invoice for ACME');
  await expect(group).toContainText('Fix the build');
});

test.describe('naming new chats', () => {
  test.use({ serverEnv: { RELAY_CHAT_TITLES: 'on' } });

  test('the lead agent names a new chat after its first message, until it is turned off in Settings', async ({ page }) => {
    await startChat(page, 'Can you find out why the test is flaky e2e:title=Flaky_test_hunt');
    await expect(page.locator('.conv-list').getByText('Flaky test hunt')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Settings' }).click();
    const titles = page.getByRole('checkbox', { name: new RegExp(en.settings.chatTitles) });
    await expect(titles).toBeChecked();
    await titles.uncheck();
    await expect(page.getByText(en.settings.chatTitlesSaved(false))).toBeVisible();
    await startChat(page, 'Second question e2e:title=Not_this_one');
    await expect(page.locator('.chat-head')).toContainText('Second question');
    await expect(page.locator('.conv-list').getByText('Not this one')).toHaveCount(0);
  });
});
