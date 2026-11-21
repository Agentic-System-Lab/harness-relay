import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolLibraryView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { appStates } from '../support/draft-apps';

// Install each test's routes before starting a new signed-in app window with the fixture's cookie.
test.beforeEach(async ({ page }) => {
  await page.goto('about:blank');
});

test('signed-in startup checks common apps before either composer opens and shares the answers with both', async ({ page, relay }) => {
  const requests: string[] = [];
  let verifyCalls = 0;
  let finishTeams!: () => void;
  const teams = new Promise<void>((resolve) => (finishTeams = resolve));
  await page.route('**/api/apps/availability/slack/verify', (route) => {
    verifyCalls++;
    return route.abort();
  });
  await page.route('**/api/apps/availability?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const group = params.get('app')!;
    requests.push(params.get('permission') + '/' + group);
    if (group === 'teams') await teams;
    await route.fulfill({ json: appStates({ mail: 'ready', teams: 'needs-connection' }) });
  });
  await page.goto(relay.base + '/#/');
  try {
    const expected = ['read-only/github', 'read-only/local', 'read-only/slack', 'read-only/teams'];
    await expect.poll(() => requests.slice().sort()).toEqual(expected);
    await expect(page.locator('.draft-app-toggle')).toHaveCount(0);
    for (const name of ['New chat', 'New automation']) {
      // Navigate through the signed-in shell so both composers use the same window and session.
      await page.getByRole('button', { name, exact: true }).click();
      await page.locator('.draft-app-toggle').click();
      await expect(page.getByRole('checkbox', { name: 'Mail', exact: true })).toBeEnabled();
      await expect(page.getByRole('checkbox', { name: 'Microsoft Teams', exact: true })).toBeDisabled();
      expect(requests.slice().sort()).toEqual(expected);
    }
    finishTeams();
    await expect(page.getByRole('checkbox', { name: 'Microsoft Teams', exact: true })).toHaveAccessibleDescription('Connection required');
    expect(verifyCalls).toBe(0);
  } finally {
    finishTeams();
  }
});

test('New chat enables only verified apps and refreshes connections and team access without losing the draft', async ({ page, relay }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let finishLocal!: () => void;
  const local = new Promise<void>((resolve) => {
    finishLocal = resolve;
  });
  let finishSlack!: () => void;
  const slack = new Promise<void>((resolve) => {
    finishSlack = resolve;
  });
  let githubFailed = true;
  const states = appStates({ drive: 'ready', mail: 'needs-connection', calendar: 'needs-assistant', browser: 'needs-install' });
  await page.route('**/api/apps/availability?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const group = params.get('app');
    if (group === 'local') await local;
    if (group === 'slack') await slack;
    if (group === 'github' && githubFailed) return route.fulfill({ status: 503, body: 'Unavailable' });
    return route.fulfill({
      json: { ...states, github: 'ready', browser: params.get('permission') === 'edit' ? 'ready' : 'needs-install' },
    });
  });
  await page.goto(relay.base + '/#/new');
  await page.locator('.task-input').fill('Prepare the agenda');
  await page.locator('.draft-app-toggle').click();
  const choices = page.getByRole('group', { name: 'Common apps', exact: true });
  const drive = choices.getByRole('checkbox', { name: 'Google Drive' });
  await expect(choices.locator('input:disabled')).toHaveCount(10);
  finishLocal();
  await expect(drive).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(choices.getByRole('checkbox', { name: 'Slack' })).toBeDisabled();
  const browser = choices.getByRole('checkbox', { name: 'Browser' });
  await expect(browser).toHaveAccessibleDescription('Installation required');
  await expect(choices.getByRole('checkbox', { name: 'Calendar' })).toHaveAccessibleDescription('Enable for an assistant');
  await drive.check();
  finishSlack();
  await expect(page.getByText('App availability could not be checked. Try again.')).toBeVisible();
  await expect(choices.getByRole('checkbox', { name: 'GitHub' })).toBeDisabled();
  githubFailed = false;
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(choices.getByRole('checkbox', { name: 'GitHub' })).toBeEnabled();
  await expect(drive).toBeChecked();
  await page.locator('.draft-app-toggle').click();
  states.mail = 'ready';
  await page.locator('.draft-app-toggle').click();
  await expect(choices.getByRole('checkbox', { name: 'Mail', exact: true })).toBeEnabled();
  await expect(drive).toBeChecked();
  await page.locator('.chat-options > summary').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(browser).toBeEnabled();
  await browser.check();
  states.drive = 'needs-connection';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(drive).toBeDisabled();
  await expect(drive).not.toBeChecked();
  await expect(browser).toBeChecked();
  await expect(page.locator('.draft-app-selection')).toHaveText('Please use Browser for this task.');
  await expect(page.locator('.task-input')).toHaveValue('Prepare the agenda');
  expect(await relay.api('/api/conversations')).toEqual([]);
});

for (const age of [1_000, 61_000]) {
  test(`a selected app survives a permission change with a ${age / 1000}s-old negative answer`, async ({ page, relay }) => {
    const start = new Date('2026-01-01T10:00:00Z');
    await page.clock.setFixedTime(start);
    let recheck = false;
    let pending = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    await page.route('**/api/apps/availability?*', async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const edit = params.get('permission') === 'edit' && params.get('app') === 'local';
      if (edit && recheck) {
        pending = true;
        await gate;
      }
      return route.fulfill({ json: appStates({ drive: edit && !recheck ? 'needs-assistant' : 'ready' }) });
    });
    try {
      await page.goto(relay.base + '/#/new');
      await page.locator('.draft-app-toggle').click();
      const drive = page.getByRole('checkbox', { name: 'Google Drive' });
      await expect(drive).toBeEnabled();
      await page.locator('.chat-options > summary').click();
      const edit = page.getByRole('button', { name: 'Edit', exact: true });
      await edit.click();
      await expect(drive).toHaveAccessibleDescription('Enable for an assistant');
      await page.getByRole('button', { name: 'Read-only', exact: true }).click();
      await drive.check();
      recheck = true;
      await page.clock.setFixedTime(new Date(start.getTime() + age));
      await edit.click();
      await expect.poll(() => pending).toBe(true);
      await expect(drive).toBeDisabled();
      await expect(page.locator('.draft-app-selection')).toContainText('Google Drive');
      finish();
      await expect(drive).toBeEnabled();
      await expect(drive).toBeChecked();
      await expect(page.locator('.draft-app-removed')).toHaveCount(0);
    } finally {
      finish();
    }
  });
}

test('New automation rechecks the selected app at submission and keeps its draft if availability changed', async ({ page, relay }) => {
  const states = appStates({ calendar: 'ready', github: 'ready' });
  const checked: string[] = [];
  await page.route('**/api/apps/availability?*', (route) => {
    const group = new URL(route.request().url()).searchParams.get('app')!;
    checked.push(group);
    return route.fulfill({ json: states });
  });
  await page.goto(relay.base + '/#/schedule');
  const task = page.locator('.task-input');
  await task.fill('Review calendar changes');
  await page
    .locator('.first-input input[type=file]')
    .setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Review') });
  await page.locator('.draft-app-toggle').click();
  const choices = page.getByRole('group', { name: 'Common apps', exact: true });
  await choices.getByRole('checkbox', { name: 'Calendar', exact: true }).check();
  await choices.getByRole('checkbox', { name: 'GitHub', exact: true }).check();
  await choices.getByRole('link', { name: 'Manage app connections' }).click();
  states.github = 'needs-assistant';
  await page.getByRole('link', { name: 'Return to automation draft' }).click();
  await expect(page.locator('.draft-app-selection')).toHaveText('Please use Calendar for this task.');
  await expect(page.getByText('Removed GitHub from this draft because access is unavailable.')).toBeVisible();
  await expect.poll(() => checked.length).toBeGreaterThanOrEqual(8);
  checked.length = 0;
  states.calendar = 'needs-connection';
  await page.getByRole('button', { name: 'Create automation', exact: true }).click();
  await expect(page.getByText('App availability changed. Review your draft before sending.')).toBeVisible();
  expect(checked).toEqual(['local']);
  await expect(page.locator('.draft-app-selection')).toHaveCount(0);
  await expect(task).toHaveValue('Review calendar changes');
  await expect(page.locator('.attach-tray')).toContainText('plan.txt');
  expect(await relay.api('/api/conversations')).toEqual([]);
});

test('Slack profile verification requires an explicit choice and the selected connection is checked again on send', async ({
  page,
  relay,
}) => {
  const states = appStates({ slack: 'needs-verification' });
  let checks = 0;
  let localReads = 0;
  let finishVerification!: () => void;
  const waiting = new Promise<void>((resolve) => (finishVerification = resolve));
  await page.route('**/api/apps/availability?*', (route) => {
    if (new URL(route.request().url()).searchParams.get('app') === 'local') localReads++;
    return route.fulfill({ json: states });
  });
  await page.route('**/api/apps/availability/slack/verify', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ permission: 'read-only' });
    checks++;
    if (checks === 1) await waiting;
    states.slack = checks === 1 ? 'ready' : 'needs-connection';
    await route.fulfill({ json: states });
  });
  await page.goto(relay.base + '/#/new');
  await page.locator('.task-input').fill('Summarize my team updates');
  await page.locator('.draft-app-toggle').click();
  const choices = page.getByRole('group', { name: 'Common apps', exact: true });
  const slack = choices.getByRole('checkbox', { name: 'Slack', exact: true });
  const verify = choices.getByRole('button', { name: 'Check Slack connection', exact: true });
  await expect(verify).toHaveAccessibleDescription('Codex checks your own Slack profile.');
  await expect(slack).toBeDisabled();
  expect(checks).toBe(0);
  try {
    await verify.press('Enter');
    await expect.poll(() => checks).toBe(1);
    const beforeFocus = localReads;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => localReads).toBeGreaterThan(beforeFocus);
    expect(checks).toBe(1);
  } finally {
    finishVerification();
  }
  await expect(slack).toBeEnabled();
  await expect(slack).toBeFocused();
  await slack.check();
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.getByText('App availability changed. Review your draft before sending.')).toBeVisible();
  await expect(slack).toBeDisabled();
  await expect(slack).not.toBeChecked();
  expect(checks).toBe(2);
  expect(await relay.api('/api/conversations')).toEqual([]);
});

test('The draft picker uses the actual vault connection and assistant grant returned by Relay', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/new');
  const picker = page.locator('.draft-app-toggle');
  await picker.click();
  const obsidian = page.getByRole('checkbox', { name: 'Obsidian', exact: true });
  await expect(obsidian).toHaveAccessibleDescription('Connection required');
  await expect(obsidian).toBeDisabled();
  const vault = join(relay.root, 'Draft notes');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  const library = await relay.api<ToolLibraryView>('/api/apps/obsidian', { method: 'POST', body: { paths: [vault] } });
  await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { obsidian: [] } } });
  await picker.click();
  await picker.click();
  await expect(obsidian).toHaveAccessibleDescription('Enable for an assistant');
  await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { obsidian: ['claude'] } } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await obsidian.check();
  await relay.api('/api/apps/obsidian/' + library.obsidianVaults![0]!.id, { method: 'DELETE', body: {} });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(obsidian).toHaveAccessibleDescription('Connection required');
  await expect(obsidian).not.toBeChecked();
  await expect(page.locator('.draft-app-selection')).toHaveCount(0);
});
