import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { TURN_MS, finishedReply, openTeamChat, send } from '../support/app';
import { selectAssistant } from '../support/app-access';
import { notInstalledBut } from '../support/fake-cli';

test.describe('PowerShell distribution', () => {
  // Codex too, whose app links the row must not offer either.
  test.use({
    missingClis: notInstalledBut(['codex']),
    serverEnv: { NODE_OPTIONS: '--import=' + new URL('../support/teams-download-loader.mjs', import.meta.url).href },
  });
  test('a missing PowerShell installation can be retried after a failed download, including across reloads', async ({ page, relay }) => {
    const file = (name: string) => join(relay.home, 'e2e-teams', name);
    // Fail closed before ever offering the installer if the server did not load its offline transport.
    expect(existsSync(file('distribution-loaded'))).toBe(true);
    writeFileSync(file('require-private-runtime'), '');
    writeFileSync(file('corrupt-download'), '');
    await page.goto(relay.base + '/#/settings/apps');
    const row = page.getByRole('listitem', { name: 'Microsoft Teams', exact: true });
    await row.locator('.app-options > summary').click();
    await expect(row.getByRole('link', { name: /in (Claude|Codex)/ })).toHaveCount(0);
    await row.getByRole('button', { name: 'Install PowerShell 7', exact: true }).click();
    const installing = row.getByRole('status');
    await expect(installing).toContainText('Preparing Teams sign-in');
    await page.reload();
    await expect(installing).toContainText('Preparing Teams sign-in');
    await expect.poll(() => existsSync(file('downloads'))).toBe(true);
    writeFileSync(file('release-download'), '');
    await expect(row.getByRole('alert')).toContainText(/download|checksum|verified/i);
    unlinkSync(file('corrupt-download'));
    await row.getByRole('button', { name: 'Retry installation', exact: true }).click();
    await expect(row.getByRole('status')).toContainText('Preparing Teams sign-in');
    writeFileSync(file('allow-module-install'), '');
    await expect(row.getByRole('button', { name: 'Sign in to Microsoft Teams', exact: true })).toBeEnabled();
    expect(existsSync(join(relay.dataDir, 'clis', 'teams-modules', 'Microsoft.Graph.Authentication', 'module.fixture'))).toBe(true);
    expect(existsSync(file('graph-module'))).toBe(false);
    const downloads = readFileSync(file('downloads'), 'utf8').trimEnd().split('\n');
    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toMatch(/^https:\/\/github\.com\/PowerShell\/PowerShell\/releases\/download\/v7\./);
    expect(downloads[1]).toBe(downloads[0]);
    await page.reload();
    await row.locator('.app-options > summary').click();
    await expect(row.getByRole('button', { name: 'Sign in to Microsoft Teams', exact: true })).toBeEnabled();
  });
});

test('Teams reuses an importable Graph module and repairs a broken one with a verified private copy', async ({ page, relay }) => {
  const folder = join(relay.home, 'e2e-teams');
  mkdirSync(folder, { recursive: true });
  const original = join(folder, 'graph-module');
  const privateCopy = join(relay.dataDir, 'clis', 'teams-modules', 'Microsoft.Graph.Authentication', 'module.fixture');
  writeFileSync(original, 'working');
  // Even an explicit preparation request reuses the working system copy without downloading.
  await relay.api('/api/apps/teams/install', { method: 'POST', body: {} });
  await expect.poll(async () => (await relay.api<{ status: string }>('/api/apps/teams')).status).toBe('signed-out');
  expect(existsSync(privateCopy)).toBe(false);
  expect(readFileSync(original, 'utf8')).toBe('working');

  writeFileSync(original, 'broken');
  const badStage = join(folder, 'bad-staged-module');
  writeFileSync(badStage, '');
  writeFileSync(join(folder, 'allow-module-install'), '');
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Microsoft Teams', exact: true });
  await row.locator('.app-options > summary').click();
  const signIn = row.getByRole('button', { name: 'Sign in to Microsoft Teams', exact: true });
  await expect(signIn).toHaveCount(0);
  await row.getByRole('button', { name: 'Install Microsoft Graph for Teams', exact: true }).click();
  const retry = row.getByRole('button', { name: 'Retry installation', exact: true });
  await expect(retry).toBeVisible();
  expect(existsSync(privateCopy)).toBe(false);
  expect(readFileSync(original, 'utf8')).toBe('broken');
  unlinkSync(badStage);
  await retry.click();
  await expect(signIn).toBeEnabled();
  expect(readFileSync(privateCopy, 'utf8')).toBe('Microsoft.Graph.Authentication');
  expect(readFileSync(original, 'utf8')).toBe('broken');

  // If that private copy itself later becomes unloadable, repair the same installation.
  writeFileSync(privateCopy, 'broken');
  await page.reload();
  await row.locator('.app-options > summary').click();
  await row.getByRole('button', { name: 'Install Microsoft Graph for Teams', exact: true }).click();
  await expect(signIn).toBeEnabled();
  expect(readFileSync(privateCopy, 'utf8')).toBe('Microsoft.Graph.Authentication');
  expect(readFileSync(original, 'utf8')).toBe('broken');
});

test('Graph device sign-in lets the chosen assistant read Teams and each approved Send delivers one message', async ({ page, relay }) => {
  // Three turns through the gateway and two device sign-ins: on a busy Windows runner each turn first
  // waited 9 s for its snapshot's git processes (nine of them then, seven since), and the test took 65 s.
  test.setTimeout(150_000);
  const folder = join(relay.home, 'e2e-teams');
  const posts = join(folder, 'posts.jsonl');
  const allow = (name: string) => writeFileSync(join(folder, name), '');
  const address = 'ming@example.test';
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Microsoft Teams', exact: true });
  const summary = row.locator('.app-options > summary');
  await summary.press('Enter');
  await row.getByRole('button', { name: 'Install Microsoft Graph for Teams', exact: true }).click();
  await expect(row.getByRole('status')).toContainText('Preparing Teams sign-in');
  allow('allow-module-install');
  const signIn = row.getByRole('button', { name: 'Sign in to Microsoft Teams', exact: true });
  await signIn.click();
  await expect(row.getByRole('status')).toContainText('TEAMS1234');
  await page.reload();
  await expect(row.getByRole('link', { name: 'Open Microsoft sign-in' })).toHaveAttribute('href', 'https://microsoft.com/devicelogin');
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await signIn.click();
  await expect(row.getByRole('status')).toContainText('TEAMS1234');
  allow('approve-read');
  await expect(summary).toContainText(address);
  const enablePost = row.getByRole('button', { name: 'Enable sending', exact: true });
  await expect(enablePost).toBeEnabled();
  await selectAssistant(row, true);
  await page.reload();
  await expect(summary).toContainText(address);
  await summary.click();
  await expect(row.locator('.app-chat-access > summary')).toContainText('Assistants using this tool · 1');
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Teams planning');
  const chat = page.url();
  await send(page, 'List my teams e2e:mcp=teams_list');
  await expect(await finishedReply(page, 'Claude')).toContainText('Product team');

  await page.goto(relay.base + '/#/settings/apps');
  await summary.click();
  await enablePost.click();
  await expect(row.getByRole('status')).toContainText('POST12345');
  await page.reload();
  await expect(row.getByRole('status')).toContainText('POST12345');
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(summary).toContainText(address);
  await enablePost.click();
  await expect(row.getByRole('status')).toContainText('POST12345');
  allow('approve-post');
  await expect(row.getByRole('button', { name: 'Turn off sending', exact: true })).toBeEnabled();

  await page.goto(chat);
  const destination =
    'https://teams.microsoft.com/l/channel/19%3Aplanning%40thread.tacv2/Planning?groupId=22222222-2222-4222-8222-222222222222';
  const text = 'Share the release plan.\nReady for review.';
  const proposal = JSON.stringify({ destination, text }) + ' e2e:mcp=teams_send_message';
  for (const [index, decision] of ['Discard', 'Send'].entries()) {
    await send(page, proposal);
    const card = page.locator('.outbox-card').nth(index);
    // The card comes during the turn, which may take as long as a turn.
    await expect(card).toContainText('Product team / Planning', { timeout: TURN_MS });
    await expect(card).toContainText(address);
    await expect(card.locator('.outbox-body')).toHaveJSProperty('textContent', text);
    await finishedReply(page, 'Claude');
    if (decision === 'Send') await page.reload();
    expect(existsSync(posts)).toBe(false);
    await card.getByRole('button', { name: decision, exact: true }).click();
    await expect(card).toContainText(decision === 'Send' ? 'Delivered to Microsoft Teams.' : 'Discarded');
  }
  const writes = readFileSync(posts, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(writes).toEqual([{ path: '/v1.0/teams/22222222-2222-4222-8222-222222222222/channels/19:planning@thread.tacv2/messages', text }]);
  await page.goto(relay.base + '/#/settings/apps');
  await summary.click();
  await row.getByRole('button', { name: 'Turn off sending', exact: true }).click();
  await expect(enablePost).toBeEnabled();
  await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(signIn).toBeEnabled();
  await expect(summary).not.toContainText(address);
  await expect(row.locator('.app-chat-access')).toHaveCount(0);
});
