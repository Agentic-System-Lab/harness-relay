import { chromium, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { findBrowser } from '../../src/server/browser/find';
import { fakeImap, fakeCalDav } from '../../test/fake-mail-servers';
import { fakeMcpAuth, type FakeMcpAuth } from '../../test/fake-mcp-auth-server';
import { test, expect } from '../fixtures';
import { checkToolOff, openCommonApp, selectAssistant } from '../support/app-access';
import { finishedReply, openTeamChat, openToolCategory, send } from '../support/app';
import type { RelayServer } from '../support/relay';

async function useNative(
  page: Page,
  relay: RelayServer,
  row: Locator,
  name: string,
  tool: string,
  args: Record<string, unknown>,
  proof: string,
) {
  await selectAssistant(row, true);
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, name + ' lifecycle');
  const chat = page.url();
  await send(page, 'Use the connected app: ' + JSON.stringify(args) + ' e2e:mcp=' + tool);
  const reply = await finishedReply(page, 'Claude');
  await expect(reply).toContainText('The ' + tool + ' tool said:');
  await expect(reply).toContainText(proof);
  await selectAssistant(await openCommonApp(page, relay, name), false);
  await checkToolOff(page, chat, tool, args);
}

test('Mail connects a mailbox, reads a fixture email, then withholds the tool', async ({ page, relay }) => {
  const mailbox = await fakeImap([
    {
      uid: 1,
      raw: 'From: Sender <sender@example.test>\r\nTo: me@example.com\r\nSubject: Lifecycle mailbox receipt\r\nDate: Mon, 5 Jan 2026 09:00:00 +0000\r\n\r\nMail read through Relay.',
    },
  ]);
  try {
    const row = await openCommonApp(page, relay, 'Mail');
    await row.getByRole('button', { name: 'Other mailbox' }).click();
    const form = row.getByRole('form');
    await form.getByLabel('Name', { exact: true }).fill('Lifecycle mailbox');
    await form.getByLabel('Your address (mail is sent from it)').fill('me@example.com');
    await form.getByLabel('User name').fill('me@example.com');
    for (const protocol of ['IMAP', 'SMTP']) {
      await form.getByLabel(protocol + ' server', { exact: true }).fill('127.0.0.1');
      await form.getByLabel(protocol + ' port', { exact: true }).fill(String(protocol === 'IMAP' ? mailbox.port : 9));
      await form.getByLabel(protocol + ' security', { exact: true }).selectOption('none');
    }
    await form.getByLabel('Password', { exact: true }).fill('app-pass');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.getByRole('list', { name: 'Mail accounts' })).toContainText('Lifecycle mailbox');
    await useNative(page, relay, row, 'Mail', 'mail_read', { uid: 1 }, 'Mail read through Relay.');
    expect(mailbox.commands.some((c) => c.includes('FETCH'))).toBe(true);
  } finally {
    await mailbox.close();
  }
});

test('Calendar connects a CalDAV calendar, reads its event, then withholds the tool', async ({ page, relay }) => {
  const calendar = await fakeCalDav([
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Relay//EN\r\nBEGIN:VEVENT\r\nUID:lifecycle@relay.test\r\nDTSTAMP:20260105T090000Z\r\nDTSTART:20260105T090000Z\r\nDTEND:20260105T093000Z\r\nSUMMARY:Lifecycle planning review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  ]);
  try {
    const row = await openCommonApp(page, relay, 'Calendar');
    await row.getByRole('button', { name: 'Other (CalDAV)' }).click();
    const form = row.getByRole('form');
    await form.getByLabel('Name', { exact: true }).fill('Lifecycle calendar');
    await form.getByLabel("The calendar's address, or its server's").fill(calendar.url);
    await form.getByLabel('User name').fill('me@example.com');
    await form.getByLabel('Password', { exact: true }).fill('app-pass');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row).toContainText('Lifecycle calendar');
    await useNative(page, relay, row, 'Calendar', 'calendar_events', { from: '2026-01-05', to: '2026-01-06' }, 'Lifecycle planning review');
    expect(calendar.reports.length).toBeGreaterThan(0);
  } finally {
    await calendar.close();
  }
});

test('Browser starts the selected Chromium, reads a local page, then withholds the tool', async ({ page, relay, browserName }) => {
  const site = createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Fixture site</title><p>Browser lifecycle receipt</p>'),
  );
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
  try {
    const row = await openCommonApp(page, relay, 'Browser');
    const pathEditor = row.locator('.browser-path');
    if (!(await pathEditor.evaluate((element) => (element as HTMLDetailsElement).open))) await pathEditor.locator('summary').click();
    // On Linux the installed browser runs with the runner's sandbox profile. On Windows
    // use the Chromium that CI installed, without depending on a separately updated Chrome.
    const configured = process.env.RELAY_BROWSER;
    const usePlaywright = process.platform === 'win32' && browserName === 'chromium' && !configured;
    let executable = usePlaywright ? undefined : findBrowser({ configured });
    if (!executable) {
      // CI may install only Playwright's headless shell. executablePath() names the full download.
      const shell = await chromium.launchServer();
      try {
        executable = shell.process().spawnfile;
      } finally {
        await shell.close();
      }
    }
    await row.getByRole('textbox', { name: 'Browser to start' }).fill(executable);
    await row.locator('.browser-path').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.browser-path summary')).toContainText(executable);
    await useNative(
      page,
      relay,
      row,
      'Browser',
      'browser_open',
      { url: 'http://127.0.0.1:' + (site.address() as { port: number }).port },
      'Browser lifecycle receipt',
    );
  } finally {
    await new Promise<void>((done) => site.close(() => done()));
  }
});

test('GitHub signs in through its CLI, reads a fixture pull request, then withholds the tool', async ({ page, relay }) => {
  const gh = join(relay.root, 'fake-github');
  mkdirSync(gh, { recursive: true });
  writeFileSync(join(gh, 'signed-out'), 'relay-test');
  const repo = join(gh, 'repos', 'demo', 'project');
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, 'pulls.json'),
    JSON.stringify([{ number: 7, title: 'Lifecycle pull request', state: 'OPEN', url: 'https://github.com/demo/project/pull/7' }]),
  );
  const row = await openCommonApp(page, relay, 'GitHub');
  await row.getByRole('button', { name: 'Sign in to GitHub' }).click();
  await expect(row).toContainText('ABCD-1234');
  writeFileSync(join(gh, 'approve'), '');
  await expect(row.getByRole('button', { name: 'Sign out of GitHub' })).toBeVisible();
  await useNative(page, relay, row, 'GitHub', 'github_pull_requests', { repo: 'demo/project' }, 'Lifecycle pull request');
});

test('Obsidian selects a vault, reads its Markdown, then withholds the tool', async ({ page, relay }) => {
  const vault = join(relay.root, 'Vault');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  writeFileSync(join(vault, 'Decisions.md'), 'Lifecycle vault note');
  // The native folder dialog is outside Chromium. All selection validation and reads still use Relay's server.
  await page.route('**/api/cwds', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), pick: true } });
  });
  await page.route('**/api/cwds/pick*', (route) => route.fulfill({ json: { paths: [vault], path: vault } }));
  const row = await openCommonApp(page, relay, 'Obsidian');
  await row.getByRole('button', { name: 'Choose vault' }).click();
  await expect(row.getByRole('list', { name: 'Connected vaults' })).toContainText(vault);
  await useNative(page, relay, row, 'Obsidian', 'obsidian_read', { path: 'Decisions.md' }, 'Lifecycle vault note');
});

type RemoteApp = 'notion' | 'heptabase';
interface RemoteCatalog {
  auth: Record<RemoteApp, FakeMcpAuth>;
  calls: Record<RemoteApp, string[]>;
}
const remoteTest = test.extend<{ catalog: RemoteCatalog }>({
  catalog: async ({}, use) => {
    const calls: RemoteCatalog['calls'] = { notion: [], heptabase: [] };
    const notion = await fakeMcpAuth({ name: 'search', text: 'Lifecycle Notion page', calls: calls.notion });
    const heptabase = await fakeMcpAuth({ name: 'search', text: 'Lifecycle Heptabase card', calls: calls.heptabase });
    try {
      await use({ auth: { notion, heptabase }, calls });
    } finally {
      await Promise.all([notion.close(), heptabase.close()]);
    }
  },
  serverEnv: async ({ catalog }, use) => {
    await use({
      NODE_OPTIONS: '--import=' + new URL('../support/catalog-mcp.mjs', import.meta.url).href,
      E2E_CATALOG_MCP: JSON.stringify({ notion: catalog.auth.notion.mcpUrl, heptabase: catalog.auth.heptabase.mcpUrl }),
    });
  },
});

async function setMcpAccess(page: Page, relay: RelayServer, server: string, on: boolean) {
  await page.goto(relay.base + '/#/settings/tools');
  const library = await openToolCategory(page, 'MCP servers');
  const entry = library.locator('.lib-row', { has: page.locator('.lib-name', { hasText: new RegExp('^' + server + '$') }) });
  await entry.getByRole('button', { name: 'Edit' }).click();
  const form = library.locator('.mcp-form');
  await form.locator('summary', { hasText: 'Given by default to' }).click();
  const button = form.getByRole('group', { name: 'Given by default to' }).getByRole('button', { name: 'Claude Code', exact: true });
  await expect(button).toHaveAttribute('aria-pressed', String(!on));
  await button.click();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
}

for (const [id, name, proof] of [
  ['notion', 'Notion', 'Lifecycle Notion page'],
  ['heptabase', 'Heptabase', 'Lifecycle Heptabase card'],
] as const) {
  remoteTest(
    name + ' connects through OAuth, its approved assistant searches, and removing access withholds the MCP server',
    async ({ page, relay, catalog }) => {
      await page.goto(relay.base + '/#/settings/apps');
      const row = page.getByRole('listitem', { name, exact: true });
      const [consent] = await Promise.all([
        page.waitForEvent('popup'),
        row.getByRole('button', { name: 'Connect ' + name, exact: true }).click(),
      ]);
      await consent.getByRole('link', { name: 'Allow' }).click();
      await expect(consent.getByRole('status')).toContainText('Signed in');
      await consent.close();
      await expect(row.locator('.app-options > summary')).toContainText('Connected');
      // A newly connected HTTP MCP server starts with the library's default provider selection.
      await setMcpAccess(page, relay, id, false);
      await setMcpAccess(page, relay, id, true);
      await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, name + ' lifecycle');
      const chat = page.url();
      await send(page, 'Find the fixture: {"query":"lifecycle"} e2e:mcp=search e2e:mcpserver=' + id);
      await expect(await finishedReply(page, 'Claude')).toContainText('The search tool said: ' + proof);
      expect(catalog.calls[id]).toEqual(['search']);
      await setMcpAccess(page, relay, id, false);
      await checkToolOff(page, chat, 'search', { query: 'lifecycle' }, id);
      expect(catalog.calls[id]).toEqual(['search']);
    },
  );
}
