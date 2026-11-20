import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { Page } from '@playwright/test';
import type { OAuthView, TeamsConnection } from '../../src/shared/types';
import { expect, test as base } from '../fixtures';

/*
 * Accounts that sign in with OAuth (Common apps → Mail or Calendar), against a
 * stand-in for Microsoft's sign-in page and Graph on this computer, which the server is pointed at
 * (`RELAY_MICROSOFT_LOGIN_URL`, `RELAY_MICROSOFT_GRAPH_URL`): the app set up, the sign-in page opened
 * in a new tab, its Allow sending the browser back to the web app's /oauth/callback, the account and
 * its own calendar shown, another calendar added, the sign-in revoked at Microsoft (a calendar's Test
 * then finds it needs a new one, which the account says), signed in again and revoked once more (the
 * list of its calendars then finds it, and the account says so again), and the account removed with
 * its calendars. Then a sign-in for mail alone: its mail account added, at stand-ins for Exchange
 * Online's IMAP and SMTP on this computer (`RELAY_MICROSOFT_IMAP`, `RELAY_MICROSOFT_SMTP`), whose Test
 * signs in to both over XOAUTH2 with Exchange Online's token; removed alone and added again from its
 * account, then removed with it.
 */

async function openApp(page: Page, name: 'Mail' | 'Calendar') {
  const row = page.locator('.common-apps').getByRole('listitem', { name, exact: true });
  const details = row.locator(':scope > details');
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
  return row;
}

interface FakeMicrosoft {
  url: string;
  /** The token requests: the code exchanged with its verifier, once. */
  exchanges: number;
  /** The account's sign-in revoked at Microsoft: Graph refuses its tokens, and a refresh is refused (`invalid_grant`). */
  revoked: boolean;
  /** Each access token it gave, and what it is for: Graph, or Exchange Online's IMAP and SMTP (as the request's scope says). */
  tokens: Map<string, 'graph' | 'outlook'>;
}

/**
 * Microsoft's sign-in page (Allow sends the browser back with a code), its token endpoint (PKCE checked;
 * a refresh token that rotates; a token for the resource the scope names) and a little of Graph.
 */
async function fakeMicrosoft(): Promise<{ fake: FakeMicrosoft; server: Server }> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const refreshTokens = new Set<string>();
  const fake: FakeMicrosoft = { url: '', exchanges: 0, revoked: false, tokens: new Map() };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', fake.url);
      const json = (status: number, v: unknown) => (
        res.writeHead(status, { 'content-type': 'application/json' }),
        res.end(JSON.stringify(v))
      );
      if (url.pathname.endsWith('/oauth2/v2.0/authorize')) {
        const q = url.searchParams;
        const code = `code-${randomUUID()}`;
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect: q.get('redirect_uri') ?? '' });
        const back = new URL(q.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state')!);
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(
          `<!doctype html><title>Sign in to your account</title><h1>Let Harness Relay use your calendars?</h1><a href="${back.href.replace(/&/g, '&amp;')}">Allow</a>`,
        );
      }
      if (url.pathname.endsWith('/oauth2/v2.0/token')) {
        const form = new URLSearchParams(body);
        const issue = () => {
          const access = `access-${randomUUID()}`;
          const refresh = `refresh-${randomUUID()}`;
          // Exchange Online's token, by a scope on its host (each scope a URL, or a word such as `openid`).
          const outlook = (form.get('scope') ?? '')
            .split(/\s+/)
            .some((scope) => URL.canParse(scope) && new URL(scope).host === 'outlook.office.com');
          fake.tokens.set(access, outlook ? 'outlook' : 'graph');
          refreshTokens.add(refresh);
          return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
        };
        if (form.get('grant_type') === 'refresh_token') {
          if (fake.revoked || !refreshTokens.delete(form.get('refresh_token') ?? ''))
            return json(400, {
              error: 'invalid_grant',
              error_description: 'AADSTS50173: The provided grant has expired due to it being revoked',
            });
          return issue();
        }
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verified =
          c &&
          c.redirect === form.get('redirect_uri') &&
          c.challenge ===
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url');
        if (form.get('client_id') !== 'e2e-client' || !verified) return json(400, { error: 'invalid_grant' });
        fake.exchanges++;
        return issue();
      }
      // Graph takes a token for Graph only, never Exchange Online's.
      if (fake.revoked || fake.tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '') !== 'graph')
        return json(401, { error: { message: 'no token' } });
      if (url.pathname === '/v1.0/me') return json(200, { id: 'e2e-subject', displayName: 'Ming', mail: 'ming@contoso.com' });
      if (url.pathname === '/v1.0/me/calendars')
        return json(200, {
          value: [
            { id: 'main', name: 'Calendar', canEdit: true, isDefaultCalendar: true },
            { id: 'team', name: 'Team', canEdit: true },
          ],
        });
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { fake, server };
}

interface FakeMail {
  imapPort: number;
  smtpPort: number;
  /** Each XOAUTH2 sign-in: which server, as whom, and whether the token was taken. */
  signIns: { server: 'imap' | 'smtp'; user: string; ok: boolean }[];
}

/**
 * Exchange Online's IMAP and SMTP, enough for a Test: IMAP's AUTHENTICATE XOAUTH2 (and CAPABILITY,
 * LOGOUT), SMTP's EHLO and AUTH XOAUTH2 (and QUIT), each taking the token `accepts` takes.
 */
async function fakeMailServers(accepts: (user: string, token: string) => boolean): Promise<{ mail: FakeMail; servers: TcpServer[] }> {
  const signIns: FakeMail['signIns'] = [];
  const check = (server: 'imap' | 'smtp', b64: string) => {
    const m = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(Buffer.from(b64, 'base64').toString('utf8'));
    const ok = Boolean(m && accepts(m[1]!, m[2]!));
    signIns.push({ server, user: m?.[1] ?? '', ok });
    return ok;
  };
  const lines = (sock: import('node:net').Socket, onLine: (line: string) => void) => {
    let buf = '';
    sock.on('error', () => undefined);
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (let eol = buf.indexOf('\r\n'); eol >= 0; eol = buf.indexOf('\r\n')) {
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        onLine(line);
      }
    });
  };
  const imap = createTcpServer((sock) => {
    let sasl: string | undefined;
    sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2] e2e IMAP\r\n');
    lines(sock, (line) => {
      if (sasl) {
        const tag = sasl;
        sasl = undefined;
        return sock.write(check('imap', line) ? `${tag} OK AUTHENTICATE completed.\r\n` : `${tag} NO AUTHENTICATE failed.\r\n`);
      }
      const [tag, ...rest] = line.split(' ');
      const cmd = rest.join(' ').toUpperCase();
      if (cmd === 'AUTHENTICATE XOAUTH2') {
        sasl = tag;
        sock.write('+ \r\n');
      } else if (cmd === 'CAPABILITY') sock.write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK\r\n`);
      else if (cmd === 'LOGOUT') {
        sock.write(`* BYE\r\n${tag} OK\r\n`);
        sock.end();
      } else sock.write(`${tag} BAD not here\r\n`);
    });
  });
  const smtp = createTcpServer((sock) => {
    sock.write('220 e2e SMTP\r\n');
    lines(sock, (line) => {
      if (/^EHLO /i.test(line)) sock.write('250-e2e\r\n250 AUTH XOAUTH2\r\n');
      else if (/^AUTH XOAUTH2 /i.test(line))
        sock.write(check('smtp', line.slice(13)) ? '235 2.7.0 Accepted\r\n' : '535 5.7.3 Authentication unsuccessful\r\n');
      else if (/^QUIT$/i.test(line)) {
        sock.write('221 bye\r\n');
        sock.end();
      } else sock.write('500 not here\r\n');
    });
  });
  for (const s of [imap, smtp]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s: TcpServer) => (s.address() as { port: number }).port;
  return { mail: { imapPort: port(imap), smtpPort: port(smtp), signIns }, servers: [imap, smtp] };
}

/** The server signs Microsoft accounts in at the stand-in, reaches their calendars there, and their mail at the stand-in mail servers. */
const test = base.extend<{ microsoft: FakeMicrosoft; mail: FakeMail }>({
  microsoft: async ({}, use) => {
    const { fake, server } = await fakeMicrosoft();
    await use(fake);
    await new Promise((r) => server.close(r));
  },
  // Exchange Online's token only, for the account's address.
  mail: async ({ microsoft }, use) => {
    const { mail, servers } = await fakeMailServers(
      (user, token) => user === 'ming@contoso.com' && microsoft.tokens.get(token) === 'outlook',
    );
    await use(mail);
    for (const s of servers) await new Promise((r) => s.close(r));
  },
  serverEnv: async ({ microsoft, mail }, use) =>
    use({
      RELAY_MICROSOFT_LOGIN_URL: microsoft.url,
      RELAY_MICROSOFT_GRAPH_URL: microsoft.url,
      RELAY_MICROSOFT_IMAP: `127.0.0.1:${mail.imapPort}`,
      RELAY_MICROSOFT_SMTP: `127.0.0.1:${mail.smtpPort}`,
    }),
});

base('ten common apps offer provider-owned connections and separate Mail and Calendar account settings', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const apps = page.locator('.common-apps');
  await expect(apps.locator('.app-row')).toHaveCount(10);
  for (const name of ['Gmail', 'Google Calendar']) await expect(apps.getByRole('listitem', { name, exact: true })).toHaveCount(0);
  for (const [name, claude, codex] of [
    ['Google Drive', 'b89f7865-a755-4f86-8062-c3bd651740ce', 'plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7'],
    ['Microsoft Teams', 'ce0c9cda-5ea5-44c5-9cf2-40810dfa6582', 'plugin_connector_1p_eba8b52fe53881918408d4b46b957644'],
    ['Slack', '597f662f-36de-437e-836e-5a81013cbfbe', 'plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d'],
  ]) {
    const card = apps.getByRole('listitem', { name, exact: true });
    const row = card.locator('.app-options > summary');
    await expect(card.getByRole('link', { name: 'Connect ' + name + ' in Claude' })).toBeHidden();
    await row.focus();
    await row.press('Enter');
    await expect(card.getByRole('link', { name: 'Connect ' + name + ' in Claude' })).toHaveAttribute(
      'href',
      'https://claude.ai/directory/' + claude,
    );
    await expect(card.getByRole('link', { name: 'Connect ' + name + ' in Codex' })).toHaveAttribute(
      'href',
      'https://chatgpt.com/plugins/' + codex,
    );
  }
  const drive = apps.getByRole('listitem', { name: 'Google Drive', exact: true });
  await drive.getByText('Create or edit Google Docs in Relay', { exact: true }).click();
  await expect(drive.getByText(/before Relay writes/)).toBeVisible();
  await drive.getByText('Create or edit Google Docs in Relay', { exact: true }).click();
  const plugin = drive.getByRole('link', { name: 'Connect Google Drive in Codex' });
  const url = (await plugin.getAttribute('href'))!;
  await page.context().route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Install plugin</title>' }));
  const [tab] = await Promise.all([page.waitForEvent('popup'), plugin.click()]);
  await expect(tab).toHaveURL(url);
  await tab.close();
  await expect(drive).not.toContainText(/· Connected/);
  await expect(page).toHaveURL(/#\/settings\/apps$/);
  const driveRow = drive.locator('.app-options > summary');
  if (!(await drive.locator('.app-options').evaluate((el) => (el as HTMLDetailsElement).open))) await driveRow.click();
  const mail = await openApp(page, 'Mail');
  await mail.getByRole('button', { name: 'Gmail', exact: true }).click();
  const google = mail.locator('.oauth-provider').filter({ hasText: 'Google' });
  await google.getByRole('button', { name: 'Set up the app' }).click();
  const mailForm = google.getByRole('form');
  await mailForm.getByLabel('Client ID', { exact: true }).fill('unfinished-account');
  await drive.getByText('Advanced · Connect with your own Google Cloud project').click();
  await expect(drive.getByRole('button', { name: 'Connect directly with Google' })).toHaveCount(0);
  await drive.getByRole('button', { name: 'Set up Google Cloud project' }).click();
  const form = drive.getByRole('form');
  await form.getByLabel('Client ID', { exact: true }).fill('456-user.apps.googleusercontent.com');
  await driveRow.click();
  await expect(form).toBeHidden();
  await driveRow.click();
  await expect(form.getByLabel('Client ID', { exact: true })).toHaveValue('456-user.apps.googleusercontent.com');
  await form.locator('input[type=password]').fill('GOCSPX-sample');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(drive.getByRole('button', { name: 'Connect directly with Google' })).toBeVisible();
  await expect(mailForm.getByRole('alert')).toContainText('This shared registration was updated elsewhere');
  await expect(mailForm.getByLabel('Client ID', { exact: true })).toHaveValue('unfinished-account');
  await expect(mailForm.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await mailForm.getByRole('button', { name: 'Cancel' }).click();
  await expect(google.getByRole('button', { name: /Sign in with Google/ })).toBeEnabled();
  // A saved Google registration can finish after Outlook. Its late response must not replace the newer settings.
  const calendar = await openApp(page, 'Calendar');
  await calendar.getByRole('button', { name: 'Google Calendar', exact: true }).click();
  await calendar.getByRole('button', { name: 'The app to sign in with', exact: true }).click();
  const googleCalendarForm = calendar.getByRole('form');
  let resumeGoogle!: () => void;
  const resume = new Promise<void>((resolve) => {
    resumeGoogle = resolve;
  });
  let googleSaved = false;
  await page.route('**/api/oauth/clients/google', async (route) => {
    const response = await route.fetch();
    googleSaved = response.ok();
    await resume;
    await route.fulfill({ response });
  });
  await googleCalendarForm.locator('input[type=password]').fill('GOCSPX-sample-updated');
  await googleCalendarForm.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => googleSaved).toBe(true);
  await calendar.getByRole('button', { name: 'Outlook', exact: true }).click();
  await calendar.getByRole('button', { name: 'Set up the app' }).click();
  await calendar.getByRole('textbox', { name: 'Client ID', exact: true }).fill('example-outlook');
  await calendar.getByRole('button', { name: 'Save', exact: true }).click();
  const outlook = calendar.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' });
  await expect(outlook).toBeVisible();
  const reread = page.waitForResponse((r) => r.url().endsWith('/api/oauth') && r.ok());
  resumeGoogle();
  await reread;
  await expect(outlook).toBeVisible();
});

base('manual mail and calendar settings stay usable if OAuth settings cannot load', async ({ page, relay }) => {
  await page.route('**/api/oauth', (route) => route.fulfill({ status: 500, json: { error: 'OAuth unavailable' } }));
  await page.goto(relay.base + '/#/settings/apps');
  await expect(page.locator('#settings-apps').getByText('OAuth unavailable')).toBeVisible();
  const mail = await openApp(page, 'Mail');
  await mail.getByRole('button', { name: 'Other mailbox' }).click();
  const mailbox = mail.getByRole('form');
  await mailbox.getByLabel('Provider').selectOption('gmail');
  await mailbox.getByLabel('Name', { exact: true }).fill('Work mail');
  await mailbox.getByLabel('Your address (mail is sent from it)').fill('work@example.com');
  await mailbox.getByLabel('Password', { exact: true }).fill('sample-password');
  await mailbox.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mail.getByRole('list', { name: 'Mail accounts' })).toContainText('Work mail');

  const calendar = await openApp(page, 'Calendar');
  await calendar.getByRole('button', { name: 'Other (CalDAV)' }).click();
  const caldav = calendar.getByRole('form');
  await caldav.getByLabel('Name', { exact: true }).fill('Work calendar');
  await caldav.getByLabel("The calendar's address, or its server's").fill('https://example.com/calendar');
  await caldav.getByLabel('User name').fill('work');
  await caldav.getByLabel('Password', { exact: true }).fill('sample-password');
  await caldav.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(calendar.getByRole('list', { name: 'Calendars', exact: true })).toContainText('Work calendar');
  await page.reload();
  await openApp(page, 'Mail');
  await openApp(page, 'Calendar');
  await expect(mail.getByRole('list', { name: 'Mail accounts' })).toContainText('Work mail');
  await expect(calendar.getByRole('list', { name: 'Calendars', exact: true })).toContainText('Work calendar');
});

base('common apps connects Teams and a local Obsidian vault, keeps them after reload and disconnects them', async ({ page, relay }) => {
  const vault = join(relay.workDir, 'My notes');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  writeFileSync(join(vault, 'Meeting.md'), 'Meeting notes');
  const otherVault = join(relay.workDir, 'Team', 'My notes');
  mkdirSync(join(otherVault, '.obsidian'), { recursive: true });
  const ordinary = join(relay.workDir, 'Markdown only');
  mkdirSync(ordinary);
  let picked = [vault, ordinary];
  // The OS folder dialog cannot be driven in Chromium. The selected path goes through the real vault endpoint.
  await page.route('**/api/cwds', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), pick: true } });
  });
  await page.route('**/api/cwds/pick', (route) => route.fulfill({ json: { paths: picked } }));
  // Microsoft runs the device challenge outside the app. Keep the transition pending until the
  // test finishes the approval; reloading the card must recover the same pending challenge.
  let graph: TeamsConnection = { status: 'missing-powershell' };
  await page.route('**/api/apps/teams', (route) => route.fulfill({ json: graph }));
  await page.route('**/api/apps/teams/install', (route) => {
    expect(route.request().method()).toBe('POST');
    graph = { status: 'installing' };
    return route.fulfill({ json: graph });
  });
  await page.route('**/api/apps/teams/signin', (route) => {
    graph =
      route.request().method() === 'POST'
        ? { status: 'signing-in', code: 'TEAMS1234', url: 'https://microsoft.com/devicelogin' }
        : { status: 'signed-out' };
    return route.fulfill({ json: graph });
  });
  await page.goto(`${relay.base}/#/settings/apps`);
  const apps = page.locator('.common-apps');
  await expect(apps.locator('.app-row')).toHaveCount(10);
  const obsidian = apps.getByRole('listitem', { name: 'Obsidian' });
  await expect(obsidian.getByRole('button', { name: 'Choose vault' })).toBeHidden();
  await expect(obsidian.locator('.app-chat-access > summary')).toBeHidden();
  await obsidian.locator('.app-options > summary').press('Enter');
  const chooser = obsidian.getByRole('button', { name: 'Choose vault' });
  await expect(chooser).toBeEnabled();
  await chooser.press('Enter');
  await expect(obsidian.getByRole('alert')).toContainText('.obsidian');
  await expect(obsidian.getByRole('list', { name: 'Connected vaults' })).toHaveCount(0);
  picked = [vault, otherVault];
  await chooser.click();
  const addVaults = obsidian.getByRole('button', { name: 'Add vaults' });
  await expect(obsidian.locator('.app-options > summary')).toContainText('2 vaults connected');
  await expect(addVaults).toBeFocused();
  const vaultList = obsidian.getByRole('list', { name: 'Connected vaults' });
  await expect(vaultList.getByRole('listitem')).toHaveCount(2);
  await expect(vaultList).toContainText(otherVault);
  const teams = apps.getByRole('listitem', { name: 'Microsoft Teams', exact: true });
  await teams.locator('.app-options > summary').click();
  await teams.getByText('Read and send Teams messages in Relay', { exact: true }).click();
  await expect(teams.getByRole('link', { name: 'Get PowerShell' })).toBeVisible();
  graph = { status: 'missing-module' };
  await teams.getByRole('button', { name: 'Check again' }).click();
  await teams.getByRole('button', { name: 'Install Microsoft Graph for Teams' }).click();
  await expect(teams.locator('details.app-secondary').getByRole('status')).toContainText('Installing Microsoft Graph');
  graph = { status: 'signed-out' };
  await teams.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(teams).toContainText('TEAMS1234');
  await page.reload();
  await expect(teams.getByRole('link', { name: 'Open Microsoft sign-in' })).toHaveAttribute('href', 'https://microsoft.com/devicelogin');
  await teams.getByRole('button', { name: 'Cancel' }).click();
  await teams.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(teams).toContainText('TEAMS1234');
  graph = { status: 'connected', account: 'ming@contoso.com' };
  await expect(teams).toContainText('ming@contoso.com · Connected');
  await page.route('**/api/apps/teams/posting', (route) => {
    graph =
      route.request().method() === 'POST'
        ? {
            status: 'connected',
            account: 'ming@contoso.com',
            posting: { status: 'signing-in', code: 'POST1234', url: 'https://microsoft.com/devicelogin' },
          }
        : { status: 'connected', account: 'ming@contoso.com' };
    return route.fulfill({ json: graph });
  });
  await teams.getByRole('button', { name: 'Enable sending' }).click();
  await expect(teams).toContainText('POST1234');
  await page.reload();
  await expect(teams.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await teams.getByRole('button', { name: 'Cancel' }).click();
  await teams.getByRole('button', { name: 'Enable sending' }).click();
  graph = { status: 'connected', account: 'ming@contoso.com', canPost: true };
  await expect(teams.getByRole('button', { name: 'Turn off sending' })).toBeVisible();
  await teams.getByRole('button', { name: 'Turn off sending' }).click();
  await expect(teams.getByRole('button', { name: 'Enable sending' })).toBeVisible();
  const access = teams.locator('.app-chat-access');
  await access.locator('summary').click();
  await access.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(access.locator('summary')).toHaveText('Assistants using this tool · 1');
  await page.reload();
  await expect(teams.locator('.app-options > summary')).toContainText('ming@contoso.com');
  await teams.locator('.app-options > summary').click();
  await teams.getByText('Read and send Teams messages in Relay', { exact: true }).click();
  await access.locator('summary').click();
  await expect(access.getByRole('button', { pressed: true })).toHaveText('Codex');
  await access.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(access.locator('summary')).toHaveText('Choose assistants to enable this tool');
  await expect(obsidian).toContainText('2 vaults connected');
  await obsidian.locator('.app-options > summary').click();
  const removals = vaultList.getByRole('button', { name: /^Disconnect / });
  await removals.nth(1).click();
  await expect(obsidian.locator('.app-options > summary')).toContainText('My notes · Connected');
  await expect(vaultList).not.toContainText(otherVault);
  await removals.first().click();
  await expect(vaultList).toHaveCount(0);
  expect(readFileSync(join(vault, 'Meeting.md'), 'utf8')).toBe('Meeting notes');
  await teams.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(teams.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(teams).not.toContainText('ming@contoso.com');
});

test("an account signs in with Microsoft in a new tab, comes back to the web app's own callback page, and its calendars join the calendar tools", async ({
  page,
  relay,
  microsoft,
}) => {
  await page.goto(`${relay.base}/#/settings/apps`);
  const app = await openApp(page, 'Calendar');
  const accounts = app.locator('.oauth-accounts');
  await expect(accounts.getByRole('heading', { name: 'Choose your calendar service' })).toBeVisible();
  await expect(accounts.getByRole('button', { name: 'Set up the app' })).toHaveCount(0);
  await accounts.getByRole('button', { name: 'Outlook', exact: true }).click();
  // No app of Harness Relay's own yet: the user's, with the addresses its registration must allow.
  await expect(accounts.getByRole('form')).toHaveCount(0);
  await accounts.getByRole('button', { name: 'Set up the app' }).first().click();
  const form = accounts.getByRole('form', { name: 'The app to sign in with · Microsoft 365 / Outlook.com' });
  await expect(form).toContainText('http://127.0.0.1/oauth/callback');
  await form.getByRole('textbox', { name: 'Client ID' }).fill('e2e-client');
  await form.getByRole('button', { name: 'Save', exact: true }).click();

  // The sign-in page opens in a new tab; Allow sends that tab back to /oauth/callback, which finishes it.
  const [tab] = await Promise.all([
    page.waitForEvent('popup'),
    accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' }).click(),
  ]);
  await expect(accounts.getByRole('status')).toContainText("Waiting for Microsoft 365 / Outlook.com's sign-in page");
  await expect(tab.getByRole('link', { name: 'Allow' })).toBeVisible();
  expect(new URL(tab.url()).searchParams.get('scope')).not.toContain('IMAP');
  await tab.getByRole('link', { name: 'Allow' }).click();
  await expect(tab.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  await expect(tab.getByRole('link', { name: "Back to Harness Relay's Settings" })).toHaveAttribute('href', '/#/settings/apps');
  // The code and state are spent: off the tab's address.
  expect(new URL(tab.url()).search).toBe('');
  await tab.close();
  expect(microsoft.exchanges).toBe(1);
  expect((await relay.api<OAuthView>('/api/oauth')).accounts[0]?.uses).toEqual(['calendar']);

  // Back in Settings: the account, and its own calendar among the calendar tools' (no password to edit).
  await expect(accounts).toContainText('Signed in as ming@contoso.com.');
  const row = accounts.locator('.lib-row', { hasText: 'ming@contoso.com' });
  await expect(row).toContainText('Connected');
  const calendars = app.getByRole('list', { name: 'Calendars', exact: true });
  await expect(calendars).toContainText('Outlook · ming@contoso.com');
  await expect(calendars.locator('.lib-row', { hasText: 'Outlook · ming@contoso.com' }).getByRole('button', { name: 'Edit' })).toHaveCount(
    0,
  );

  // Its own calendar is listed as added already; another of them is added.
  await row.getByRole('button', { name: 'Calendars' }).click();
  const found = row.getByRole('list', { name: 'Calendars · ming@contoso.com' });
  await expect(found.locator('li', { hasText: 'Calendar' }).first()).toContainText('Added');
  await found.locator('li', { hasText: 'Team' }).getByRole('button', { name: 'Add' }).click();
  await expect(found.locator('li', { hasText: 'Team' })).toContainText('Added');
  await expect(calendars).toContainText('Team · ming@contoso.com');

  // The sign-in revoked at Microsoft: a calendar's Test finds its token refused and its refresh too,
  // and the account then says it needs a new sign-in.
  microsoft.revoked = true;
  const own = calendars.locator('.lib-row', { hasText: 'Outlook · ming@contoso.com' });
  await own.getByRole('button', { name: 'Test' }).click();
  await expect(own).toContainText('The sign-in of ming@contoso.com no longer works');
  await expect(row).toContainText('Needs a new sign-in');
  await expect(row).toContainText('invalid_grant');
  await expect(row.getByRole('button', { name: 'Sign in again' })).toBeEnabled();

  // Signed in again, it is connected again. Revoked once more, the list of its calendars, read anew,
  // finds it (a 409), and the account says so without a Test.
  microsoft.revoked = false;
  const [again] = await Promise.all([page.waitForEvent('popup'), row.getByRole('button', { name: 'Sign in again' }).click()]);
  await again.getByRole('link', { name: 'Allow' }).click();
  await expect(again.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  await again.close();
  await expect(row).toContainText('Connected');
  expect(microsoft.exchanges).toBe(2);
  microsoft.revoked = true;
  await row.getByRole('button', { name: 'Calendars' }).click();
  await expect(found).toHaveCount(0);
  await row.getByRole('button', { name: 'Calendars' }).click();
  await expect(row.locator('.error-line')).toContainText('The sign-in of ming@contoso.com no longer works');
  await expect(row).toContainText('Needs a new sign-in');

  // Removed: its calendars go with it, and where to take the app's access away at Microsoft is said.
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Remove ming@contoso.com' }).click();
  await expect(accounts).toContainText('Microsoft cannot revoke one token');
  await expect(accounts.locator('.lib-row')).toHaveCount(0);
  await expect(calendars).toHaveCount(0);
});

test('an account signed in with Microsoft for mail adds its mail account, whose Test signs in over XOAUTH2 to its IMAP and SMTP servers', async ({
  page,
  relay,
  microsoft,
  mail,
}) => {
  await page.goto(`${relay.base}/#/settings/apps`);
  const app = await openApp(page, 'Mail');
  await app.getByRole('button', { name: 'Outlook', exact: true }).click();
  const accounts = app.locator('.oauth-accounts');
  await accounts.getByRole('button', { name: 'Set up the app' }).first().click();
  const form = accounts.getByRole('form', { name: 'The app to sign in with · Microsoft 365 / Outlook.com' });
  await form.getByRole('textbox', { name: 'Client ID' }).fill('e2e-client');
  await form.getByRole('button', { name: 'Save', exact: true }).click();

  // A new sign-in for mail alone.
  const [tab] = await Promise.all([
    page.waitForEvent('popup'),
    accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' }).click(),
  ]);
  await expect(tab.getByRole('link', { name: 'Allow' })).toBeVisible();
  expect(new URL(tab.url()).searchParams.get('scope')).not.toContain('Calendars.ReadWrite');
  await tab.getByRole('link', { name: 'Allow' }).click();
  await expect(tab.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  await expect(tab.getByRole('link', { name: "Back to Harness Relay's Settings" })).toHaveAttribute('href', '/#/settings/apps');
  await tab.close();
  expect(microsoft.exchanges).toBe(1);

  // The account, for mail, with a sign-in for calendars on offer; its mail account among the mail
  // tools', at Microsoft's servers (here the stand-ins), with no password nor servers to edit.
  const row = accounts.locator('.lib-row', { hasText: 'ming@contoso.com' });
  await expect(row).toContainText('Used for: Mail');
  await expect(row.getByRole('button', { name: 'Use for calendars' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Calendars', exact: true })).toHaveCount(0);
  const mailList = app.getByRole('list', { name: 'Mail accounts' });
  const own = mailList.locator('.lib-row', { hasText: 'Outlook · ming@contoso.com' });
  await expect(own).toContainText('ming@contoso.com · 127.0.0.1');
  await expect(own.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  expect((await relay.api<OAuthView>('/api/oauth')).accounts[0]?.uses).toEqual(['mail']);

  // Test: IMAP, then SMTP, each over XOAUTH2 with Exchange Online's token.
  await own.getByRole('button', { name: 'Test' }).click();
  await expect(own).toContainText('Connected: the sign-in works.');
  expect(mail.signIns).toEqual([
    { server: 'imap', user: 'ming@contoso.com', ok: true },
    { server: 'smtp', user: 'ming@contoso.com', ok: true },
  ]);
  expect([...microsoft.tokens.values()]).toContain('outlook');

  // Removed from the mail accounts alone: Use for mail adds it again, without signing in again.
  page.once('dialog', (d) => void d.accept());
  await own.getByRole('button', { name: 'Remove' }).click();
  await expect(own).toHaveCount(0);
  await row.getByRole('button', { name: 'Use for mail' }).click();
  await expect(accounts).toContainText('The mail of ming@contoso.com was added to the mail tools.');
  await expect(own).toBeVisible();
  await expect(row.getByRole('button', { name: 'Use for mail' })).toHaveCount(0);
  expect(microsoft.exchanges).toBe(1);

  // Adding calendar access explicitly preserves the Mail grant on the same account.
  const calendar = await openApp(page, 'Calendar');
  const calendarAccounts = calendar.locator('.oauth-accounts');
  await calendarAccounts.getByText('Use an existing sign-in', { exact: true }).click();
  const [consent] = await Promise.all([page.waitForEvent('popup'), calendar.getByRole('button', { name: 'Use for calendars' }).click()]);
  await expect(accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' })).toBeDisabled();
  await expect(accounts.getByRole('status')).toContainText('Finish or cancel the sign-in in Calendar first.');
  await expect(consent.getByRole('link', { name: 'Allow' })).toBeVisible();
  const scopes = new URL(consent.url()).searchParams.get('scope');
  expect(scopes).toContain('Calendars.ReadWrite');
  expect(scopes).toContain('IMAP.AccessAsUser.All');
  expect(scopes).not.toContain('Channel.Read');
  await consent.getByRole('link', { name: 'Allow' }).click();
  await expect(consent.getByRole('link', { name: "Back to Harness Relay's Settings" })).toHaveAttribute('href', '/#/settings/apps');
  await consent.close();
  await expect(row).toContainText('Used for: Calendars, Mail');
  const shared = (await relay.api<OAuthView>('/api/oauth')).accounts;
  expect(shared).toHaveLength(1);
  expect(shared[0]?.uses).toEqual(['calendar', 'mail']);
  const calendars = calendar.getByRole('list', { name: 'Calendars', exact: true });
  await expect(calendars).toContainText('Outlook · ming@contoso.com');

  // The sign-in can expire even after its mailbox was removed. Warn on the collapsed row,
  // then reauthorize all existing uses without silently adding the mailbox back.
  page.once('dialog', (d) => void d.accept());
  await own.getByRole('button', { name: 'Remove' }).click();
  await expect(mailList).toHaveCount(0);
  await app.locator('.app-options > summary').click();
  microsoft.revoked = true;
  await calendars.getByRole('button', { name: 'Test' }).click();
  await expect(app.locator('.app-options > summary')).toContainText('Needs a new sign-in');
  await openApp(page, 'Mail');
  microsoft.revoked = false;
  const [again] = await Promise.all([page.waitForEvent('popup'), row.getByRole('button', { name: 'Sign in again' }).click()]);
  await expect(again.getByRole('link', { name: 'Allow' })).toBeVisible();
  const previousScopes = new URL(again.url()).searchParams.get('scope');
  expect(previousScopes).toContain('Calendars.ReadWrite');
  expect(previousScopes).toContain('IMAP.AccessAsUser.All');
  expect(previousScopes).not.toContain('Channel.Read');
  await again.getByRole('link', { name: 'Allow' }).click();
  await expect(again.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  await again.close();
  await expect(row).toContainText('Connected');
  await expect(app.locator('.app-options > summary')).not.toContainText('Needs a new sign-in');
  await expect(mailList).toHaveCount(0);
  await row.getByRole('button', { name: 'Use for mail' }).click();
  await expect(own).toBeVisible();

  // Removing this shared sign-in identifies both services before either is disconnected.
  const removing = page.waitForEvent('dialog');
  const clickRemove = row.getByRole('button', { name: 'Remove ming@contoso.com' }).click();
  const dialog = await removing;
  expect(dialog.message()).toContain('This disconnects Calendars, Mail');
  await dialog.accept();
  await clickRemove;
  await expect(accounts.locator('.lib-row')).toHaveCount(0);
  await expect(mailList).toHaveCount(0);
  await expect(calendars).toHaveCount(0);
});
