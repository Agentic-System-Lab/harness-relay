import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { OAuthView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { checkToolOff, openCommonApp, selectAssistant } from '../support/app-access';
import { finishedReply, openTeamChat, replies, send } from '../support/app';

test('Obsidian previews the exact note in full access, supports discard, and checks for changes before saving', async ({ page, relay }) => {
  const vault = join(relay.root, 'Personal notes');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  const path = join(vault, 'Project.md');
  await relay.api('/api/apps/obsidian', { method: 'PUT', body: { path: vault } });
  await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { obsidian: ['claude'] } } });
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Project notes');
  const propose = async (tool: string, content: string, n: number, vaultId?: string) => {
    await send(page, JSON.stringify({ path: 'Project.md', content, vault: vaultId }) + ' e2e:mcp=obsidian_' + tool);
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
  const otherVault = join(relay.root, 'Team notes');
  mkdirSync(join(otherVault, '.obsidian'), { recursive: true });
  const otherNote = join(otherVault, 'Project.md');
  writeFileSync(otherNote, 'Team project');
  const library = await relay.api<import('../../src/shared/types').ToolLibraryView>('/api/apps/obsidian', {
    method: 'POST',
    body: { paths: [otherVault] },
  });
  const personal = library.obsidianVaults!.find((v) => v.path === realpathSync.native(vault))!;
  const team = library.obsidianVaults!.find((v) => v.path === realpathSync.native(otherVault))!;
  card = await propose('edit', '# Project\nApproved plan.\n', 3, personal.id);
  await expect(card.locator('.note-preview dd').first()).toHaveText(personal.path);
  await expect(card.locator('.note-removed')).toContainText('First draft.');
  await expect(card.locator('.note-added')).toContainText('Approved plan.');
  expect(readFileSync(path, 'utf8')).toContain('First draft.');
  await page.reload();
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('Saved');
  expect(readFileSync(path, 'utf8')).toBe('# Project\nApproved plan.\n');
  card = await propose('edit', 'Outdated proposal', 4, personal.id);
  writeFileSync(path, 'Updated in Obsidian');
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('Could not save');
  expect(readFileSync(path, 'utf8')).toBe('Updated in Obsidian');
  expect(readFileSync(otherNote, 'utf8')).toBe('Team project');
  card = await propose('edit', 'Pending team change', 5, team.id);
  await expect(card.locator('.note-preview dd').first()).toHaveText(team.path);
  await relay.api('/api/apps/obsidian/' + team.id, { method: 'DELETE', body: {} });
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('Could not save');
  expect(readFileSync(otherNote, 'utf8')).toBe('Team project');
});

test.describe('Slack workspace posting', () => {
  test.use({ serverEnv: { NODE_OPTIONS: '--import=' + new URL('../support/slack-posting.mjs', import.meta.url).href } });
  test('a workspace token enables a Slack message preview, and only Send posts the exact message once', async ({ page, relay }) => {
    const posts = join(relay.dataDir, 'slack-posts.jsonl');
    await page.goto(relay.base + '/#/settings/apps');
    const row = page.getByRole('listitem', { name: 'Slack', exact: true });
    await row.locator('.app-options > summary').click();
    const direct = row.getByText('Send from Relay', { exact: true }).locator('..');
    const accessLabel = 'Assistants who can draft messages';
    await expect(row.getByText(accessLabel, { exact: true })).toHaveCount(0);
    await direct.locator(':scope > summary').click();
    await expect(direct.getByText(accessLabel, { exact: true })).toHaveCount(0);
    await direct.getByLabel('Slack OAuth token').fill('xoxb-fixture-for-relay');
    await row.getByRole('button', { name: 'Enable sending' }).click();
    await expect(row).toContainText('Demo bot · Demo workspace');
    await expect(direct.getByText(accessLabel, { exact: true })).toBeVisible();
    await expect(direct.getByRole('button', { name: 'Claude Code', exact: true })).toBeHidden();
    await direct.getByText(accessLabel, { exact: true }).click();
    await direct.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await expect(direct).toContainText('Assistants who can draft messages · 1');
    await direct.locator(':scope > summary').click();
    await expect(direct.getByText('Assistants who can draft messages · 1', { exact: true })).toBeHidden();
    await expect(row.getByRole('link', { name: 'Connect Slack in Claude' })).toBeVisible();
    await expect(row.locator('.app-options > summary')).not.toContainText('Connected in Claude');
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
    const chat = page.url();
    const settings = await openCommonApp(page, relay, 'Slack');
    await settings.getByText('Send from Relay', { exact: true }).click();
    await selectAssistant(settings, false);
    await checkToolOff(page, chat, 'slack_send_message', { destination: 'CPLANS', text });
    expect(readFileSync(posts, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });
});

test('common app disclosure typography matches and setup labels stay above fields on desktop and phone', async ({ page, relay }) => {
  await relay.api('/api/oauth/clients/google', {
    method: 'PUT',
    body: { clientId: 'layout.apps.googleusercontent.com', secret: 'layout' },
  });
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Google Drive', exact: true });
  const mailStyle = page.getByRole('listitem', { name: 'Mail', exact: true });
  await mailStyle.locator('.app-options > summary').click();
  const typography = (e: Element) => {
    const css = getComputedStyle(e);
    return [css.fontFamily, css.fontSize, css.fontWeight];
  };
  const slack = page.getByRole('listitem', { name: 'Slack', exact: true });
  await slack.locator('.app-options > summary').click();
  await row.locator('.app-options > summary').click();
  await row.getByRole('combobox', { name: 'Access for this account' }).selectOption('both');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const expected = await mailStyle.locator('.app-chat-access > summary').evaluate(typography);
    expect(await slack.getByText('Send from Relay', { exact: true }).evaluate(typography)).toEqual(expected);
    await expect(row.getByText('Choose assistants to enable this tool')).toHaveCount(0);
    const help = (await row.locator('.drive-permission-form > p').boundingBox())!;
    const action = (await row.getByRole('button', { name: 'Sign in with Google' }).boundingBox())!;
    expect(action.y - help.y - help.height).toBeGreaterThanOrEqual(16);
  }
  const calendar = page.getByRole('listitem', { name: 'Calendar', exact: true });
  await calendar.locator('.app-options > summary').click();
  const mail = mailStyle;
  const firstContentGap = async (row: typeof calendar, first: typeof calendar) => {
    const summary = await row.locator('.app-options > summary').boundingBox();
    const content = await first.boundingBox();
    return content!.y - summary!.y - summary!.height;
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const baseline = await firstContentGap(slack, slack.locator('.app-row-body > p').first());
    expect(await firstContentGap(calendar, calendar.getByRole('heading', { name: 'Choose your calendar service' }))).toBeCloseTo(
      baseline,
      0,
    );
    expect(await firstContentGap(mail, mail.getByRole('heading', { name: 'Choose your mail service' }))).toBeCloseTo(baseline, 0);
  }
  for (const width of [1280, 775, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const buttons = page.locator('.service-choices > button:visible');
    const dims = await buttons.evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        return { height: rect.height, width: rect.width, label: range.getBoundingClientRect().width, lines: range.getClientRects().length };
      }),
    );
    expect(dims).toHaveLength(8);
    for (const d of dims) {
      expect(d.lines).toBe(1);
      expect(d.height).toBe(dims[0]!.height);
      expect(d.width - d.label).toBeLessThan(32);
    }
  }
  await calendar.getByRole('button', { name: 'Other (CalDAV)' }).click();
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

test('Apple Calendar starts from its own button and saves only a selected iCloud calendar with the current credentials', async ({
  page,
  relay,
}) => {
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Calendar', exact: true });
  await row.locator('.app-options > summary').press('Enter');
  const trigger = row.getByRole('button', { name: 'iCloud Calendar' });
  const choices = row.getByRole('group', { name: 'Choose your calendar service' });
  await expect(choices.getByRole('button')).toHaveText(['Google Calendar', 'iCloud Calendar', 'Outlook', 'Other (CalDAV)']);
  await expect(row.getByRole('form')).toHaveCount(0);
  await expect(row.locator('.oauth-setup-hint')).toHaveCount(0);
  await choices.getByRole('button', { name: 'Google Calendar' }).click();
  await expect(row.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Set up Google sign-in', exact: true })).toBeEnabled();
  await choices.getByRole('button', { name: 'Other (CalDAV)' }).click();
  await expect(row.getByRole('form', { name: 'Add a calendar' })).toBeVisible();
  await trigger.press('Enter');
  const form = row.getByRole('form', { name: 'Connect Apple Calendar (iCloud)' });
  const email = form.getByRole('textbox', { name: 'Apple Account email' });
  const password = form.getByLabel('App-specific password', { exact: true });
  const find = form.getByRole('button', { name: 'Find calendars' });
  await expect(find).toBeDisabled();
  await expect(form.getByRole('link', { name: 'Create an app-specific password' })).toHaveAttribute('href', 'https://account.apple.com/');
  await expect(form.getByRole('combobox')).toHaveCount(0);
  await email.fill('sample@example.test');
  await password.fill('first-example-password');
  const address = 'https://p42-caldav.icloud.com/example/';
  let queries = 0;
  let release!: () => void;
  const delay = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/connectors/calendar/discover', async (route) => {
    const query = route.request().postDataJSON();
    expect(query.url).toBe('https://caldav.icloud.com/');
    expect(query.username).toBe('sample@example.test');
    queries++;
    if (queries === 1) {
      expect(query.password).toBe('first-example-password');
      await delay;
      return route.fulfill({ json: { ok: true, calendars: [{ name: 'Stale calendar', url: address + 'old/' }] } }).catch(() => {});
    }
    expect(query.password).toBe('new-example-password');
    await route.fulfill({
      json: {
        ok: true,
        calendars: [
          { name: 'Personal', url: address + 'home/' },
          { name: 'Family', url: address + 'family/' },
        ],
      },
    });
  });
  await find.click();
  await expect.poll(() => queries).toBe(1);
  await password.fill('new-example-password');
  release();
  await expect(form.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await find.click();
  const selection = form.getByRole('combobox', { name: 'Choose an iCloud calendar' });
  await expect(selection).toBeFocused();
  await expect(selection.locator('option')).toHaveText(['Choose an iCloud calendar', 'Personal', 'Family']);
  const save = form.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await selection.selectOption({ label: 'Family' });
  await save.press('Enter');
  await expect(form).toBeHidden();
  await expect(trigger).toBeFocused();
  const calendar = (await relay.api<import('../../src/shared/types').ConnectorsView>('/api/connectors')).calendar;
  expect(calendar).toHaveLength(1);
  expect(calendar[0]).toMatchObject({ name: 'Family', url: address + 'family/', username: 'sample@example.test' });
  expect(JSON.stringify(calendar)).not.toContain('new-example-password');
  await trigger.click();
  await expect(email).toHaveValue('');
  await expect(password).toHaveValue('');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();
});

test('GitHub sign-out confirms the shared CLI account and permits signing back in', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'GitHub', exact: true });
  const summary = row.locator('.app-options > summary');
  await expect(summary).toContainText('relay-test');
  await summary.click();
  const signOut = row.getByRole('button', { name: 'Sign out of GitHub' });
  const cancel = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('relay-test');
    expect(dialog.message()).toContain('other apps using GitHub CLI');
    await dialog.dismiss();
  });
  await Promise.all([cancel, signOut.click()]);
  await expect(signOut).toBeVisible();
  expect(await relay.api('/api/apps/github')).toMatchObject({ login: 'relay-test' });
  const accept = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await Promise.all([accept, signOut.click()]);
  await expect(row.getByRole('status')).toHaveText('Signed out of relay-test on this computer.');
  const signIn = row.getByRole('button', { name: 'Sign in to GitHub' });
  await expect(signIn).toBeVisible();
  expect(await relay.api('/api/apps/github')).toEqual({ status: 'signed-out' });
  await page.reload();
  await summary.click();
  await signIn.click();
  await expect(row).toContainText('ABCD-1234');
  writeFileSync(join(relay.root, 'fake-github', 'approve'), '');
  await expect(summary).toContainText('relay-test');
  await expect(signOut).toBeVisible();
});

test('Mail keeps Google sign-in separate from manual mailboxes and saves iCloud without server fields', async ({ page, relay }) => {
  let releaseOAuth!: () => void;
  const oauthReply = new Promise<void>((resolve) => {
    releaseOAuth = resolve;
  });
  await page.route('**/api/oauth', async (route) => {
    await oauthReply;
    await route.continue();
  });
  await page.goto(relay.base + '/#/settings/apps');
  const mail = page.getByRole('listitem', { name: 'Mail', exact: true });
  await mail.locator('.app-options > summary').press('Enter');
  const choices = mail.getByRole('group', { name: 'Choose your mail service' });
  await expect(choices.getByRole('button')).toHaveText(['Gmail', 'iCloud Mail', 'Outlook', 'Other mailbox']);
  await expect(mail.getByRole('form')).toHaveCount(0);
  await expect(mail.getByRole('button', { name: 'Set up Google sign-in', exact: true })).toHaveCount(0);
  const gmail = choices.getByRole('button', { name: 'Gmail', exact: true });
  const service = choices.getByRole('button', { name: 'iCloud Mail', exact: true });
  await service.press('Enter');
  const form = mail.getByRole('form', { name: 'iCloud Mail' });
  const address = 'icloud.finance.approvals@example-industries.test';
  await form.getByLabel('Email address').fill(address);
  await form.getByLabel('App-specific password').fill('demo-only');
  releaseOAuth();
  await expect(mail.getByRole('button', { name: 'Set up Google sign-in', exact: true })).toHaveCount(0);
  await expect(gmail).toBeEnabled();
  await expect(form.getByLabel('App-specific password')).toBeFocused();
  await expect(form.getByLabel('App-specific password')).toHaveValue('demo-only');
  await expect(form.locator('input')).toHaveCount(2);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(mail.getByRole('list', { name: 'Mail accounts' })).toContainText(address);
  await expect(service).toBeFocused();
  const stored = await relay.api<import('../../src/shared/types').ConnectorsView>('/api/connectors');
  expect(stored.mail[0]).toMatchObject({ username: address, imap: { host: 'imap.mail.me.com' }, smtp: { host: 'smtp.mail.me.com' } });
  expect(JSON.stringify(stored)).not.toContain('demo-only');
  await expect(mail.locator('.oauth-setup-hint')).toHaveCount(0);
  await gmail.click();
  await expect(mail.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeDisabled();
  await expect(mail.getByRole('button', { name: 'Set up Google sign-in', exact: true })).toBeVisible();
  await expect(mail.getByRole('form')).toHaveCount(0);
  await expect(mail.locator('input[type=password]')).toHaveCount(0);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const panel = (await mail.boundingBox())!;
    const buttons = mail.getByRole('list', { name: 'Mail accounts' }).getByRole('button');
    for (const button of await buttons.all()) {
      const rect = (await button.boundingBox())!;
      expect(rect.x + rect.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
  }
  await choices.getByRole('button', { name: 'Other mailbox' }).click();
  const manual = mail.getByRole('form', { name: 'Add a mail account' });
  await expect(manual.getByRole('option', { name: 'Gmail', exact: true })).toHaveCount(0);
  await manual.getByLabel('Provider').selectOption('fastmail');
  await expect(manual.getByLabel('IMAP server', { exact: true })).toHaveValue('imap.fastmail.com');
  await manual.getByLabel('Password', { exact: true }).fill('old-fastmail-pass');
  await manual.getByLabel('Provider').selectOption('yahoo');
  await expect(manual.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(manual.getByLabel('IMAP server', { exact: true })).toHaveValue('imap.mail.yahoo.com');
});

test('a saved Gmail password mailbox can still be edited', async ({ page, relay }) => {
  const address = 'previous@gmail.com';
  await relay.api('/api/connectors/mail/previous-gmail', {
    method: 'PUT',
    body: {
      name: 'Previous Gmail',
      address,
      username: address,
      password: 'fixture-app-password',
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    },
  });
  const row = await openCommonApp(page, relay, 'Mail');
  await row.getByRole('listitem').filter({ hasText: 'Previous Gmail' }).getByRole('button', { name: 'Edit' }).click();
  const edit = row.getByRole('form', { name: 'Edit Previous Gmail' });
  await expect(edit.getByLabel('IMAP server', { exact: true })).toHaveValue('imap.gmail.com');
  await expect(edit.getByLabel('SMTP server', { exact: true })).toHaveValue('smtp.gmail.com');
  await edit.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed Gmail');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.getByRole('listitem').filter({ hasText: 'Renamed Gmail' })).toBeVisible();
  const view = await relay.api<import('../../src/shared/types').ConnectorsView>('/api/connectors');
  expect(view.mail[0]).toMatchObject({
    id: 'previous-gmail',
    address,
    name: 'Renamed Gmail',
    imap: { host: 'imap.gmail.com' },
    smtp: { host: 'smtp.gmail.com' },
  });
  expect(view.mail[0]!.password).toBeTruthy();
});

test.describe('Google Docs editing with Relay confirmation', () => {
  test.use({ serverEnv: { NODE_OPTIONS: '--import=' + new URL('../support/google-documents.mjs', import.meta.url).href } });

  const email = 'editor@example.test';
  const docsScope = 'https://www.googleapis.com/auth/documents';
  const driveScope = 'https://www.googleapis.com/auth/drive.readonly';

  test.beforeEach(async ({ page, relay }) => {
    await relay.api('/api/oauth/clients/google', {
      method: 'PUT',
      body: { clientId: 'fixture.apps.googleusercontent.com', secret: 'fake' },
    });
    await page.context().route(/^https:\/\/(?:[^/]+\.)?(?:google\.com|googleapis\.com|googleusercontent\.com)\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin + url.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth') return route.abort();
      const q = url.searchParams;
      expect(q.get('client_id')).toBe('fixture.apps.googleusercontent.com');
      expect(q.get('code_challenge_method')).toBe('S256');
      const redirect = q.get('redirect_uri')!;
      expect(redirect).toBe(relay.base + '/oauth/callback');
      expect(q.get('state')).toBeTruthy();
      writeFileSync(
        join(relay.dataDir, 'google-docs-consent.json'),
        JSON.stringify({
          challenge: q.get('code_challenge'),
          redirect,
          scopes: q.get('scope')!.split(' '),
          incremental: q.get('include_granted_scopes') === 'true',
        }),
      );
      const back = new URL(redirect);
      back.searchParams.set('state', q.get('state')!);
      back.searchParams.set('code', 'fixture-docs-code');
      const other = new URL(back);
      other.searchParams.set('code', 'fixture-reader-code');
      await route.fulfill({
        contentType: 'text/html',
        body:
          '<a href="' +
          back.href.replaceAll('&', '&amp;') +
          '">Allow Google access</a>' +
          '<a href="' +
          other.href.replaceAll('&', '&amp;') +
          '">Use other test account</a>',
      });
    });
  });

  async function authorize(page: Page, trigger: Locator, scopes: string[], loginHint: string | null = null, identity = email) {
    const [tab] = await Promise.all([page.waitForEvent('popup'), trigger.click()]);
    const allow = tab.getByRole('link', { name: identity === email ? 'Allow Google access' : 'Use other test account', exact: true });
    await expect(allow).toBeVisible();
    const q = new URL(tab.url()).searchParams;
    expect(q.get('scope')!.split(' ').sort()).toEqual(['openid', 'email', 'profile', ...scopes].sort());
    expect(q.get('login_hint')).toBe(loginHint);
    if (!loginHint && scopes.some((scope) => scope === driveScope || scope === docsScope)) {
      await expect(page.getByRole('combobox', { name: 'Access for this account' })).toBeDisabled();
    }
    await allow.click();
    await expect(tab.getByRole('status')).toHaveText('Signed in as ' + identity + '.');
    await tab.close();
  }

  async function manageDrive(drive: Locator) {
    const details = drive.locator('.app-options');
    const summary = details.locator(':scope > summary');
    await expect(summary).toContainText('Manage');
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await summary.click();
  }

  async function googleAccountSettings(page: Page, email: string) {
    const settings = page.locator('#oauth-client-settings');
    if (!(await settings.evaluate((details) => (details as HTMLDetailsElement).open))) {
      await settings.locator(':scope > summary').click();
    }
    return settings.getByRole('group', { name: 'Google', exact: true }).getByRole('group', { name: email, exact: true });
  }

  test('Drive starts with read-only access, adds Docs editing to the same account and disconnects both grants', async ({ page, relay }) => {
    await page.goto(relay.base + '/#/settings/apps');
    const drive = page.getByRole('listitem', { name: 'Google Drive', exact: true });
    const connect = drive.getByRole('button', { name: 'Sign in with Google', exact: true });
    const summary = drive.locator('.app-options > summary');
    await summary.click();
    await authorize(page, connect, [driveScope]);
    await expect(summary).toContainText('1 account connected');
    await expect(summary).not.toContainText(email);
    const account = drive.getByRole('group', { name: email, exact: true });
    await expect(account).toContainText('Read-only');
    await expect(account.getByRole('button', { name: 'Allow creating and editing documents' })).toHaveAccessibleDescription(
      /confirm each change in Relay/,
    );
    await expect(account.getByRole('button', { name: 'Add another Google account' })).toHaveCount(0);
    await expect(account.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
    await expect(connect).toBeHidden();
    const accounts = async () => (await relay.api<OAuthView>('/api/oauth')).accounts;
    const [readOnly] = await accounts();
    expect(readOnly).toMatchObject({ email, uses: ['drive'], status: 'connected' });

    await page.reload();
    await manageDrive(drive);
    const addAccount = drive.getByRole('button', { name: 'Add another Google account', exact: true });
    await addAccount.click();
    await expect(drive.getByRole('combobox', { name: 'Access for this account' })).toHaveValue('read');
    await expect(connect).toBeVisible();
    await addAccount.click();
    await authorize(
      page,
      account.getByRole('button', { name: 'Allow creating and editing documents', exact: true }),
      [driveScope, docsScope],
      email,
    );
    await expect(account).toContainText('Can search and read files, and create or edit Google Docs after your confirmation');
    await expect(account.getByRole('button', { name: 'Allow creating and editing documents' })).toHaveCount(0);
    const updated = await accounts();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.id).toBe(readOnly!.id);
    expect([...updated[0]!.uses].sort()).toEqual(['documents', 'drive']);
    await selectAssistant(drive, true);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Drive search');
    await send(page, '{"query":"Planning"} e2e:mcp=drive_search');
    await expect(await finishedReply(page, 'Claude')).toContainText('Planning notes');
    const chat = page.url();
    await page.goto(relay.base + '/#/settings/apps');
    await manageDrive(drive);
    await expect(drive.getByRole('button', { name: /disconnect/i })).toHaveCount(0);
    const settingsAccount = await googleAccountSettings(page, email);
    await expect(settingsAccount).toContainText('Google Docs editing');
    await expect(settingsAccount).toContainText('Google Drive');
    const disconnect = settingsAccount.getByRole('button', { name: 'Disconnect account', exact: true });
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain(email);
      expect(dialog.message()).toContain('Google Docs editing');
      expect(dialog.message()).toContain('Google Drive');
      await dialog.dismiss();
    });
    await disconnect.click();
    await expect(disconnect).toBeEnabled();
    expect(await accounts()).toHaveLength(1);
    page.once('dialog', (dialog) => dialog.accept());
    await disconnect.click();
    await expect(connect).toBeVisible();
    await expect(summary).toContainText('Connect');
    await expect(drive.locator('.app-chat-access')).toHaveCount(0);
    expect(await accounts()).toEqual([]);
    expect(JSON.parse(readFileSync(join(relay.dataDir, 'google-docs-consent.json'), 'utf8')).revoked).toBe(true);
    await page.goto(chat);
    await send(page, 'Search again: {"query":"Planning"} e2e:mcp=drive_search');
    await expect(await finishedReply(page, 'Claude')).toContainText('drive_search cannot be used now: Connect an account');
  });

  test('removing Drive and Docs from one account preserves Gmail, Calendar and a second Drive account', async ({ page, relay }) => {
    const drive = await openCommonApp(page, relay, 'Google Drive');
    const permission = drive.getByRole('combobox', { name: 'Access for this account' });
    const signIn = drive.getByRole('button', { name: 'Sign in with Google', exact: true });
    await permission.selectOption('both');
    await authorize(page, signIn, [driveScope, docsScope]);
    await drive.getByRole('button', { name: 'Add another Google account' }).click();
    await expect(permission).toHaveValue('read');
    const reader = 'reader@example.test';
    await authorize(page, signIn, [driveScope], null, reader);
    await expect(drive.locator('.app-options > summary')).toContainText('2 accounts connected');
    await page.reload();
    await manageDrive(drive);
    const first = drive.getByRole('group', { name: email, exact: true });
    const second = drive.getByRole('group', { name: reader, exact: true });
    await expect(first).toContainText('create or edit Google Docs');
    await expect(second).toContainText('Read-only');
    const mail = await openCommonApp(page, relay, 'Mail');
    await mail.getByRole('button', { name: 'Gmail', exact: true }).click();
    await authorize(page, mail.getByRole('button', { name: 'Sign in with Google' }), ['https://mail.google.com/']);
    await expect(mail.getByRole('group', { name: email })).toBeVisible();
    const calendar = await openCommonApp(page, relay, 'Calendar');
    await calendar.getByRole('button', { name: 'Google Calendar', exact: true }).click();
    await authorize(page, calendar.getByRole('button', { name: 'Sign in with Google' }), ['https://www.googleapis.com/auth/calendar']);
    await expect(calendar.getByRole('group', { name: email })).toBeVisible();
    await page.reload();
    await manageDrive(drive);
    const remove = first.getByRole('button', { name: 'Remove Google Drive' });
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain(email);
      expect(dialog.message()).toContain('Google Docs');
      expect(dialog.message()).toContain('Gmail, Calendar');
      expect(dialog.message()).not.toContain(reader);
      await dialog.dismiss();
    });
    await remove.click();
    await expect(first).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await remove.click();
    await expect(first).toHaveCount(0);
    await expect(drive.locator('.app-options > summary')).toBeFocused();
    await expect(second).toBeVisible();
    await expect(drive.locator('.app-options > summary')).toContainText('1 account connected');
    const accounts = async () => (await relay.api<OAuthView>('/api/oauth')).accounts;
    const kept = (await accounts()).find((account) => account.email === email)!;
    expect([...kept.uses].sort()).toEqual(['calendar', 'mail']);
    await mail.locator('.app-options > summary').click();
    await expect(mail.getByRole('group', { name: email })).toBeVisible();
    await calendar.locator('.app-options > summary').click();
    await expect(calendar.getByRole('group', { name: email })).toBeVisible();
    await selectAssistant(drive, true);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Remaining Drive account');
    await send(page, '{"query":"Planning"} e2e:mcp=drive_search');
    await expect(await finishedReply(page, 'Claude')).toContainText('Planning notes');
    await page.goto(relay.base + '/#/settings/apps');
    await manageDrive(drive);
    await drive.getByRole('button', { name: 'Add another Google account' }).click();
    await expect(permission).toHaveValue('read');
    await authorize(page, signIn, [driveScope]);
    await expect(first).toContainText('Read-only');
    await expect(second).toContainText('Read-only');
    const restored = (await accounts()).find((account) => account.id === kept.id)!;
    expect([...restored.uses].sort()).toEqual(['calendar', 'drive', 'mail']);
  });

  test('removing the last editing-only Drive connection keeps its Google sign-in until the user disconnects it', async ({
    page,
    relay,
  }) => {
    const drive = await openCommonApp(page, relay, 'Google Drive');
    const permission = drive.getByRole('combobox', { name: 'Access for this account' });
    await permission.selectOption('documents');
    await authorize(page, drive.getByRole('button', { name: 'Sign in with Google' }), [docsScope]);
    const card = drive.getByRole('group', { name: email });
    await expect(card.getByRole('button', { name: 'Enable file search and reading' })).toBeVisible();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Google Docs editing');
      expect(dialog.message()).not.toContain('Drive file access');
      await dialog.accept();
    });
    await card.getByRole('button', { name: 'Remove Google Drive' }).click();
    await expect(card).toHaveCount(0);
    await expect(permission).toHaveValue('read');
    await expect(drive.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
    await expect(drive.locator('.app-chat-access')).toHaveCount(0);
    const central = await googleAccountSettings(page, email);
    await expect(central).toContainText('No connected services');
    const grant = () => JSON.parse(readFileSync(join(relay.dataDir, 'google-docs-consent.json'), 'utf8'));
    expect(grant().revoked).not.toBe(true);
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain(email);
      expect(dialog.message()).toContain('removes the saved sign-in');
      await dialog.accept();
    });
    await central.getByRole('button', { name: 'Disconnect account' }).click();
    await expect(central).toHaveCount(0);
    expect(grant().revoked).toBe(true);
  });

  test('turning off Google pauses its connected account across reloads and turning it on restores access', async ({ page, relay }) => {
    await relay.api('/api/oauth/clients/microsoft', { method: 'PUT', body: { clientId: 'fixture-microsoft' } });
    await page.goto(relay.base + '/#/settings/apps');
    const drive = page.getByRole('listitem', { name: 'Google Drive', exact: true });
    const connect = drive.getByRole('button', { name: 'Sign in with Google', exact: true });
    await drive.locator('.app-options > summary').click();
    await authorize(page, connect, [driveScope]);
    await expect(drive.locator('.app-options > summary')).toContainText('1 account connected');
    await selectAssistant(drive, true);
    const mail = page.getByRole('listitem', { name: 'Mail', exact: true });
    const calendar = page.getByRole('listitem', { name: 'Calendar', exact: true });
    await mail.locator('.app-options > summary').click();
    await calendar.locator('.app-options > summary').click();
    await mail.getByRole('button', { name: 'Gmail', exact: true }).click();
    await calendar.getByRole('button', { name: 'Outlook', exact: true }).click();
    const gmail = mail.getByRole('button', { name: 'Sign in with Google', exact: true });
    const outlook = calendar.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com', exact: true });
    const panel = page.locator('#oauth-client-settings');
    await panel.locator(':scope > summary').click();
    const google = panel.getByRole('group', { name: 'Google', exact: true });
    const microsoft = panel.getByRole('group', { name: 'Microsoft', exact: true });
    await expect(google).toContainText('Configured');
    await expect(microsoft).toContainText('Configured');
    const turnOff = google.getByRole('button', { name: 'Turn off', exact: true });
    page.once('dialog', async (dialog) => {
      for (const app of ['Gmail', 'Google Calendar', 'Google Drive']) expect(dialog.message()).toContain(app);
      await dialog.dismiss();
    });
    await turnOff.click();
    await expect(gmail).toBeEnabled();
    await expect(google).toContainText('Configured');
    const accounts = async () => (await relay.api<OAuthView>('/api/oauth')).accounts;
    const before = await accounts();
    expect(before).toHaveLength(1);
    page.once('dialog', (dialog) => dialog.accept());
    await turnOff.click();
    await expect(google).toContainText('Turned off');
    const gmailChoice = mail.getByRole('button', { name: 'Gmail', exact: true });
    await expect(gmailChoice).toBeEnabled();
    await expect(gmailChoice).toHaveAttribute('aria-pressed', 'true');
    await expect(mail.locator('.oauth-setup-hint')).toContainText(/Google sign-in is turned off/i);
    await expect(mail.getByRole('button', { name: 'Google sign-in settings' })).toBeEnabled();
    await expect(mail.getByRole('link', { name: 'Google OAuth 2.0 setup guide' })).toBeVisible();
    await expect(gmail).toHaveJSProperty('disabled', true);
    await expect(drive.getByRole('button', { name: 'Add another Google account', exact: true })).toHaveJSProperty('disabled', true);
    await expect(outlook).toBeEnabled();
    await expect(microsoft).toContainText('Configured');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Drive access');
    const chat = page.url();
    const search = '{"query":"Planning"} e2e:mcp=drive_search';
    await send(page, search);
    await expect(await finishedReply(page, 'Claude')).toContainText('Google sign-in is disabled');

    await page.goto(relay.base + '/#/settings/apps');
    await page.reload();
    await panel.locator(':scope > summary').click();
    await expect(google).toContainText('Turned off');
    await expect(microsoft).toContainText('Configured');
    await manageDrive(drive);
    const account = drive.getByRole('group', { name: email, exact: true });
    await expect(account.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
    await expect(account.getByRole('button', { name: /disconnect/i })).toHaveCount(0);
    const settingsAccount = await googleAccountSettings(page, email);
    await expect(settingsAccount.getByRole('button', { name: 'Disconnect account', exact: true })).toBeEnabled();
    await google.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(google).toContainText('Configured');
    await expect(drive.getByRole('button', { name: 'Add another Google account', exact: true })).toBeEnabled();
    await expect(account.getByRole('button', { name: 'Allow creating and editing documents' })).toBeEnabled();
    const after = await relay.api<OAuthView>('/api/oauth');
    expect(after.accounts).toEqual(before);
    expect(after.clients.find((item) => item.provider === 'google')).toMatchObject({
      clientId: 'fixture.apps.googleusercontent.com',
      secret: '••••',
    });
    await page.goto(chat);
    await send(page, search);
    await expect(await finishedReply(page, 'Claude')).toContainText('Planning notes');
  });

  test('the Google Docs write grant allows exact create and edit previews that wait for confirmation', async ({ page, relay }) => {
    // Four proposal turns and the final tool-access check each start a CLI and its gateway on Windows.
    test.setTimeout(150_000);
    const stateFile = join(relay.dataDir, 'google-docs-state.json');
    const state = (): { id: string; title: string; content: string; revision: number; creates: number; updates: number } =>
      JSON.parse(readFileSync(stateFile, 'utf8'));
    await page.goto(relay.base + '/#/settings/apps');
    const drive = page.getByRole('listitem', { name: 'Google Drive', exact: true });
    await drive.locator('.app-options > summary').click();
    await drive.getByRole('combobox', { name: 'Access for this account' }).selectOption('documents');
    await authorize(page, drive.getByRole('button', { name: 'Sign in with Google' }), [docsScope]);
    await expect(drive.locator('.app-options > summary')).toContainText('1 account connected');
    await expect(drive.getByRole('group', { name: email })).toContainText('Can create and edit Google Docs after your confirmation');
    await expect(drive.getByRole('button', { name: 'Enable file search and reading' })).toBeVisible();
    await drive.getByText('Choose assistants to enable this tool', { exact: true }).click();
    await drive.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await expect(drive).toContainText('Assistants using this tool · 1');

    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Google Docs decisions');
    const propose = async (tool: 'drive_create_document' | 'drive_edit_document', args: Record<string, string>, count: number) => {
      await send(page, JSON.stringify(args) + ' e2e:mcp=' + tool);
      await expect(replies(page, 'Claude')).toHaveCount(count, { timeout: 45_000 });
      await expect(await finishedReply(page, 'Claude')).toContainText('The ' + tool + ' tool said:');
      const cards = page.locator('.outbox-card');
      await expect(cards).toHaveCount(count);
      return cards.nth(count - 1);
    };
    const unrelated = 'https://docs.google.com/document/d/other/edit';
    const title = 'Release decisions ' + unrelated;
    const content = 'Launch checklist\nDecision 📌: share the draft on Monday.  ';
    let card = await propose('drive_create_document', { title, content }, 1);
    await expect(card).toContainText(email);
    await expect(card).toContainText(title);
    await expect(card.locator('.document-preview pre')).toHaveJSProperty('textContent', content);
    expect(existsSync(stateFile)).toBe(false);
    await card.getByRole('button', { name: 'Discard' }).click();
    await expect(card).toContainText('Discarded');
    expect(existsSync(stateFile)).toBe(false);

    card = await propose('drive_create_document', { title, content }, 2);
    await page.reload();
    await expect(card.locator('.document-preview pre')).toHaveJSProperty('textContent', content);
    expect(existsSync(stateFile)).toBe(false);
    await card.getByRole('button', { name: 'Create document' }).click();
    await expect.poll(() => existsSync(stateFile) && state().content).toBe(content);
    expect(state()).toMatchObject({ title, creates: 1, updates: 1 });
    const documentUrl = 'https://docs.google.com/document/d/' + state().id + '/edit';
    await expect(card.getByRole('link', { name: documentUrl, exact: true })).toHaveAttribute('href', documentUrl);
    await expect(card.locator('a[href=' + JSON.stringify(unrelated) + ']')).toHaveCount(0);

    const edit = { id: state().id, before: 'the draft', after: 'the approved plan' };
    card = await propose('drive_edit_document', edit, 3);
    await expect(card).toContainText(email);
    await expect(card).toContainText(title);
    await expect(card.getByRole('link', { name: title, exact: true })).toHaveAttribute('href', documentUrl + '?tab=t.decision');
    await expect(card.getByText('Decision (t.decision)', { exact: true })).toBeVisible();
    await expect(card.locator('.note-removed pre')).toHaveJSProperty('textContent', edit.before);
    await expect(card.locator('.note-added pre')).toHaveJSProperty('textContent', edit.after);
    expect(state().content).toBe(content);
    await card.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => state().content).toBe(content.replace(edit.before, edit.after));
    expect(state()).toMatchObject({ creates: 1, updates: 2 });

    card = await propose('drive_edit_document', { id: state().id, before: 'Monday', after: 'Tuesday' }, 4);
    const external = state();
    external.content += ' Changed in Google Docs.';
    external.revision++;
    const externalEdit = stateFile + '.external-edit';
    writeFileSync(externalEdit, JSON.stringify(external));
    renameSync(externalEdit, stateFile);
    await card.getByRole('button', { name: 'Save changes' }).click();
    await expect(card.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(card).toContainText('Check the result');
    await expect(card).toContainText('Request a fresh preview.');
    expect(state()).toEqual(external);
    const chat = page.url();
    await page.goto(relay.base + '/#/settings/apps');
    await manageDrive(drive);
    await selectAssistant(drive, false);
    await checkToolOff(page, chat, 'drive_edit_document', edit);
    expect(state()).toEqual(external);

    // This account still exists if its installation loses the client secret later.
    await relay.api('/api/oauth/clients/google', { method: 'PUT', body: { clientId: 'fixture.apps.googleusercontent.com', secret: '' } });
    await page.goto(relay.base + '/#/settings/apps');
    await manageDrive(drive);
    const account = drive.getByRole('group', { name: email, exact: true });
    await expect(account.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
    await expect(drive.getByRole('button', { name: 'Enable file search and reading' })).toHaveJSProperty('disabled', true);
    await expect(account.getByRole('button', { name: /disconnect/i })).toHaveCount(0);
    const settingsAccount = await googleAccountSettings(page, email);
    await expect(settingsAccount.getByRole('button', { name: 'Disconnect account', exact: true })).toBeEnabled();
  });
});
