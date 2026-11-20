import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { checkToolOff, openCommonApp, selectAssistant } from '../support/app-access';
import { finishedReply, openTeamChat, send } from '../support/app';

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
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Google Drive', exact: true });
  await row.locator('.app-options > summary').click();
  const mailStyle = page.getByRole('listitem', { name: 'Mail', exact: true });
  await mailStyle.locator('.app-options > summary').click();
  const typography = (e: Element) => {
    const css = getComputedStyle(e);
    return [css.fontFamily, css.fontSize, css.fontWeight];
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const expected = await mailStyle.locator('.app-chat-access > summary').evaluate(typography);
    for (const summary of await row.locator('.app-secondary > summary').all()) expect(await summary.evaluate(typography)).toEqual(expected);
    await expect(row.getByText('Choose assistants to enable this tool')).toHaveCount(0);
  }
  const docs = row.locator('.app-secondary').filter({ has: page.getByText('Create or edit Google Docs in Relay', { exact: true }) });
  const project = row
    .locator('.app-secondary')
    .filter({ has: page.getByText('Advanced · Connect with your own Google Cloud project', { exact: true }) });
  await docs.locator('summary').click();
  for (const panel of [docs, project]) {
    if (panel === project) await panel.locator('summary').click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const setup = row.getByRole('button', { name: 'Set up Google Cloud project', exact: true });
      await expect(setup).toHaveCount(1);
      const text = await panel.locator('p').first().boundingBox();
      const button = await setup.boundingBox();
      expect(button!.y - text!.y - text!.height).toBeGreaterThanOrEqual(11);
    }
  }
  await project.locator('summary').click();
  await docs.locator('summary').click();
  await mailStyle.locator('.app-options > summary').click();
  const calendar = page.getByRole('listitem', { name: 'Calendar', exact: true });
  await calendar.locator('.app-options > summary').click();
  const mail = page.getByRole('listitem', { name: 'Mail', exact: true });
  await mail.locator('.app-options > summary').click();
  const firstContentGap = async (row: typeof calendar, first: typeof calendar) => {
    const summary = await row.locator('.app-options > summary').boundingBox();
    const content = await first.boundingBox();
    return content!.y - summary!.y - summary!.height;
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const baseline = await firstContentGap(row, row.locator('.app-row-body > p').first());
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
  await expect(choices.getByRole('button')).toHaveText(['iCloud Calendar', 'Google Calendar', 'Outlook', 'Other (CalDAV)']);
  await expect(row.getByRole('form')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Set up the app' })).toHaveCount(0);
  await choices.getByRole('button', { name: 'Google Calendar' }).click();
  await expect(row.getByRole('button', { name: 'Set up the app' })).toHaveCount(1);
  await expect(row.getByText('To sign in with Google', { exact: false })).toBeVisible();
  await choices.getByRole('button', { name: 'Other (CalDAV)' }).click();
  await expect(row.getByRole('form', { name: 'Add a calendar' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Set up the app' })).toHaveCount(0);
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

test('Mail shows one service at a time and saves Gmail and iCloud mailboxes without server fields', async ({ page, relay }) => {
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
  await expect(choices.getByRole('button')).toHaveText(['Gmail', 'Outlook', 'iCloud Mail', 'Other mailbox']);
  await expect(mail.getByRole('form')).toHaveCount(0);
  await expect(mail.getByRole('button', { name: 'Set up the app' })).toHaveCount(0);
  await choices.getByRole('button', { name: 'Gmail' }).click();
  const gmail = mail.getByRole('form', { name: 'Use a Gmail app password' });
  await gmail.getByLabel('Email address').fill('discard@example.test');
  await gmail.getByLabel('App-specific password').fill('discard-me');
  releaseOAuth();
  await expect(choices.getByRole('button', { name: 'Outlook' })).toBeEnabled();
  await expect(gmail.getByLabel('App-specific password')).toBeFocused();
  await expect(gmail.getByLabel('App-specific password')).toHaveValue('discard-me');
  await choices.getByRole('button', { name: 'Outlook' }).click();
  await expect(gmail).toHaveCount(0);
  await expect(mail.locator('.oauth-provider')).toContainText('Microsoft');
  const stored = () => relay.api<import('../../src/shared/types').ConnectorsView>('/api/connectors');
  for (const [button, provider, host] of [
    ['iCloud Mail', 'icloud', 'imap.mail.me.com'],
    ['Gmail', 'gmail', 'imap.gmail.com'],
  ]) {
    const service = choices.getByRole('button', { name: button, exact: true });
    await service.press('Enter');
    const form = mail.getByRole('form', { name: provider === 'icloud' ? 'iCloud Mail' : 'Use a Gmail app password' });
    await expect(form.getByLabel('App-specific password')).toHaveValue('');
    await expect(form.locator('input')).toHaveCount(2);
    const address = provider + '.finance.approvals@example-industries.test';
    await form.getByLabel('Email address').fill(address);
    await form.getByLabel('App-specific password').fill('demo-only');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(mail.getByRole('list', { name: 'Mail accounts' })).toContainText(address);
    await expect(service).toBeFocused();
    const saved = (await stored()).mail.find((m) => m.address === address);
    expect(saved).toMatchObject({
      username: address,
      imap: { host },
      smtp: { host: provider === 'gmail' ? 'smtp.gmail.com' : 'smtp.mail.me.com' },
    });
    expect(JSON.stringify(saved)).not.toContain('demo-only');
  }
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
  await manual.getByLabel('Provider').selectOption('fastmail');
  await expect(manual.getByLabel('IMAP server', { exact: true })).toHaveValue('imap.fastmail.com');
  await manual.getByLabel('Password', { exact: true }).fill('old-fastmail-pass');
  await manual.getByLabel('Provider').selectOption('yahoo');
  await expect(manual.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(manual.getByLabel('IMAP server', { exact: true })).toHaveValue('imap.mail.yahoo.com');
});

test.describe('Google Docs editing with Relay confirmation', () => {
  test.use({ serverEnv: { NODE_OPTIONS: '--import=' + new URL('../support/google-documents.mjs', import.meta.url).href } });

  test('the Google Docs write grant allows exact create and edit previews that wait for confirmation', async ({ page, relay }) => {
    const stateFile = join(relay.dataDir, 'google-docs-state.json');
    const state = (): { id: string; title: string; content: string; revision: number; creates: number; updates: number } =>
      JSON.parse(readFileSync(stateFile, 'utf8'));
    const email = 'editor@example.test';
    const docsScope = 'https://www.googleapis.com/auth/documents';
    await relay.api('/api/oauth/clients/google', {
      method: 'PUT',
      body: { clientId: 'fixture.apps.googleusercontent.com', secret: 'fake' },
    });
    await page.context().route(/^https:\/\/(?:[^/]+\.)?(?:google\.com|googleapis\.com|googleusercontent\.com)\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin + url.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth') return route.abort();
      const q = url.searchParams;
      expect(q.get('client_id')).toBe('fixture.apps.googleusercontent.com');
      expect(q.get('scope')!.split(' ').sort()).toEqual(['openid', 'email', 'profile', docsScope].sort());
      expect(q.get('code_challenge_method')).toBe('S256');
      const redirect = q.get('redirect_uri')!;
      expect(redirect).toBe(relay.base + '/oauth/callback');
      expect(q.get('state')).toBeTruthy();
      writeFileSync(join(relay.dataDir, 'google-docs-consent.json'), JSON.stringify({ challenge: q.get('code_challenge'), redirect }));
      const back = new URL(redirect);
      back.searchParams.set('state', q.get('state')!);
      back.searchParams.set('code', 'fixture-docs-code');
      await route.fulfill({
        contentType: 'text/html',
        body: '<a href="' + back.href.replaceAll('&', '&amp;') + '">Allow Google Docs editing</a>',
      });
    });
    await page.goto(relay.base + '/#/settings/apps');
    const drive = page.getByRole('listitem', { name: 'Google Drive', exact: true });
    await drive.locator('.app-options > summary').click();
    await drive.getByText('Create or edit Google Docs in Relay', { exact: true }).click();
    const [auth] = await Promise.all([page.waitForEvent('popup'), drive.getByRole('button', { name: 'Enable document editing' }).click()]);
    await auth.getByRole('link', { name: 'Allow Google Docs editing' }).click();
    await expect(auth.getByRole('status')).toHaveText('Signed in as ' + email + '.');
    await auth.close();
    await expect(drive).toContainText(email);
    await drive.getByText('Choose assistants to enable this tool', { exact: true }).click();
    await drive.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await expect(drive).toContainText('Assistants using this tool · 1');

    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Google Docs decisions');
    const propose = async (tool: 'drive_create_document' | 'drive_edit_document', args: Record<string, string>, count: number) => {
      await send(page, JSON.stringify(args) + ' e2e:mcp=' + tool);
      const cards = page.locator('.outbox-card');
      await expect(cards).toHaveCount(count);
      await finishedReply(page, 'Claude');
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
    writeFileSync(stateFile, JSON.stringify(external));
    await card.getByRole('button', { name: 'Save changes' }).click();
    await expect(card.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(card).toContainText('Check the result');
    await expect(card).toContainText('Request a fresh preview.');
    expect(state()).toEqual(external);
    const chat = page.url();
    const settings = await openCommonApp(page, relay, 'Google Drive');
    await selectAssistant(settings, false);
    await checkToolOff(page, chat, 'drive_edit_document', edit);
    expect(state()).toEqual(external);
  });
});
