import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send } from '../support/app';

test('Obsidian previews the exact note in full access, supports discard, and checks for changes before saving', async ({ page, relay }) => {
  const vault = join(relay.root, 'Personal notes');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  const path = join(vault, 'Project.md');
  await relay.api('/api/apps/obsidian', { method: 'PUT', body: { path: vault } });
  await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { obsidian: ['claude'] } } });
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Project notes');
  const propose = async (tool: string, content: string, n: number) => {
    await send(page, JSON.stringify({ path: 'Project.md', content }) + ' e2e:mcp=obsidian_' + tool);
    await expect(page.locator('.outbox-card')).toHaveCount(n);
    await finishedReply(page, 'Claude');
    return page.locator('.outbox-card').nth(n - 1);
  };
  let card = await propose('create', '# Project\nFirst draft.\n', 1);
  await expect(card).toContainText('Project.md');
  await expect(card.locator('pre')).toHaveText('# Project\nFirst draft.\n', { useInnerText: false });
  expect(existsSync(path)).toBe(false);
  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(card).toContainText('Discarded');
  expect(existsSync(path)).toBe(false);
  card = await propose('create', '# Project\nFirst draft.\n', 2);
  await card.getByRole('button', { name: 'Create note' }).click();
  await expect(card).toContainText('Saved');
  expect(readFileSync(path, 'utf8')).toBe('# Project\nFirst draft.\n');
  card = await propose('edit', '# Project\nApproved plan.\n', 3);
  await expect(card.locator('.note-removed')).toContainText('First draft.');
  await expect(card.locator('.note-added')).toContainText('Approved plan.');
  expect(readFileSync(path, 'utf8')).toContain('First draft.');
  await page.reload();
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('Saved');
  expect(readFileSync(path, 'utf8')).toBe('# Project\nApproved plan.\n');
  card = await propose('edit', 'Outdated proposal', 4);
  writeFileSync(path, 'Updated in Obsidian');
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('Could not save');
  expect(readFileSync(path, 'utf8')).toBe('Updated in Obsidian');
});

test.describe('Slack workspace posting', () => {
  test.use({ serverEnv: { NODE_OPTIONS: '--import=' + new URL('../support/slack-posting.mjs', import.meta.url).href } });
  test('a workspace token enables a Slack message preview, and only Send posts the exact message once', async ({ page, relay }) => {
    const posts = join(relay.dataDir, 'slack-posts.jsonl');
    await page.goto(relay.base + '/#/settings/apps');
    const row = page.getByRole('listitem', { name: 'Slack', exact: true });
    await row.locator('.app-options > summary').click();
    await row.getByText('Send from Relay', { exact: true }).click();
    await row.getByLabel('Slack OAuth token').fill('xoxb-fixture-for-relay');
    await row.getByRole('button', { name: 'Enable sending' }).click();
    await expect(row).toContainText('Demo bot · Demo workspace');
    await row.getByText('Choose assistants to enable this tool').click();
    await row.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await expect(row).toContainText('Assistants using this tool · 1');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Slack message');
    const text = 'Ready to share?\nThe update is ready.';
    const proposal = JSON.stringify({ destination: 'https://relay-demo.slack.com/archives/CPLANS', text }) + ' e2e:mcp=slack_send_message';
    await send(page, proposal);
    const first = page.locator('.outbox-card').first();
    await expect(first).toContainText('#planning · CPLANS');
    await expect(first).toContainText('Demo bot · URELAY');
    await expect(first.locator('.outbox-body')).toHaveJSProperty('textContent', text);
    await finishedReply(page, 'Claude');
    expect(existsSync(posts)).toBe(false);
    await first.getByRole('button', { name: 'Discard' }).click();
    await expect(first).toContainText('Discarded');
    expect(existsSync(posts)).toBe(false);
    await send(page, proposal);
    const last = page.locator('.outbox-card').nth(1);
    await expect(last).toContainText('Waiting for you');
    await page.reload();
    expect(existsSync(posts)).toBe(false);
    await last.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(last).toContainText('Delivered to Slack');
    const [payload] = readFileSync(posts, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(readFileSync(posts, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(payload).toMatchObject({ channel: 'CPLANS', text, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] });
  });
});

test('common app disclosure typography matches and setup labels stay above fields on desktop and phone', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Google Drive', exact: true });
  await row.locator('.app-options > summary').click();
  const typography = (e: Element) => {
    const css = getComputedStyle(e);
    return [css.fontFamily, css.fontSize, css.fontWeight];
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await row.locator('.app-secondary > summary').evaluate(typography)).toEqual(
      await row.locator('.app-chat-access > summary').evaluate(typography),
    );
    await expect(row.getByText('Choose assistants to enable this tool')).toBeVisible();
  }
  const calendar = page.getByRole('listitem', { name: 'Calendar', exact: true });
  await calendar.locator('.app-options > summary').click();
  await calendar.getByRole('button', { name: 'Add a calendar' }).click();
  await calendar.getByRole('combobox', { name: 'Provider' }).selectOption('icloud');
  await expect(calendar.getByRole('link', { name: 'Create an app-specific password' })).toBeVisible();
  await page.goto(relay.base + '/#/settings/openhands');
  const app = page.locator('#settings-openhands');
  await app.locator('summary', { hasText: 'Default model and reasoning effort' }).first().click();
  const field = app.getByRole('textbox', { name: 'Executable', exact: true });
  await field.fill('my-openhands');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(field).toBeVisible();
    expect(
      await field.evaluate(
        (el) => el.closest('label')!.querySelector('span')!.getBoundingClientRect().bottom <= el.getBoundingClientRect().top,
      ),
    ).toBe(true);
    await expect(field).toHaveValue('my-openhands');
  }
});
