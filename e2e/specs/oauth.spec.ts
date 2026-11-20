import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { TeamsConnection } from '../../src/shared/types';
import { expect, test as base } from '../fixtures';

/*
 * Accounts that sign in with OAuth (Settings → Tool library → Accounts you sign in to), against a
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

base(
  'seven common apps offer provider-owned connections while Gmail and Google Calendar stay in the tool library',
  async ({ page, relay }) => {
    await page.goto(relay.base + '/#/settings/apps');
    const apps = page.locator('.common-apps');
    await expect(apps.getByRole('listitem')).toHaveCount(7);
    for (const name of ['Gmail', 'Google Calendar']) await expect(apps.getByRole('listitem', { name, exact: true })).toHaveCount(0);
    for (const [name, claude, codex] of [
      ['Google Drive', 'b89f7865-a755-4f86-8062-c3bd651740ce', 'plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7'],
      ['Microsoft Teams', 'ce0c9cda-5ea5-44c5-9cf2-40810dfa6582', 'plugin_connector_1p_eba8b52fe53881918408d4b46b957644'],
      ['Slack', '597f662f-36de-437e-836e-5a81013cbfbe', 'plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d'],
    ]) {
      const card = apps.getByRole('listitem', { name, exact: true });
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
    const plugin = drive.getByRole('link', { name: 'Connect Google Drive in Codex' });
    const url = (await plugin.getAttribute('href'))!;
    await page.context().route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Install plugin</title>' }));
    const [tab] = await Promise.all([page.waitForEvent('popup'), plugin.click()]);
    await expect(tab).toHaveURL(url);
    await tab.close();
    await expect(drive).not.toContainText(/· Connected/);
    await drive.getByText('Set up and check your assistant').click();
    await drive.getByRole('link', { name: 'Open Codex settings' }).click();
    await expect(page).toHaveURL(/#\/settings\/codex$/);
    await page.goto(relay.base + '/#/settings/apps');
    await drive.getByText('Advanced · Connect with your own Google Cloud project').click();
    await expect(drive.getByRole('button', { name: 'Connect directly with Google' })).toHaveCount(0);
    await drive.getByRole('button', { name: 'Set up Google Cloud project' }).click();
    const form = drive.getByRole('form');
    await form.getByLabel('Client ID', { exact: true }).fill('456-user.apps.googleusercontent.com');
    await form.locator('input[type=password]').fill('GOCSPX-sample');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drive.getByRole('button', { name: 'Connect directly with Google' })).toBeVisible();
    await page.goto(relay.base + '/#/settings/tools');
    const google = page.locator('.oauth-provider').filter({ hasText: 'Google' });
    await expect(google.getByRole('button', { name: /Sign in with Google/ })).toBeEnabled();
  },
);

base('manual mail and calendar settings stay usable if OAuth settings cannot load', async ({ page, relay }) => {
  await page.route('**/api/oauth', (route) => route.fulfill({ status: 500, json: { error: 'OAuth unavailable' } }));
  await page.goto(relay.base + '/#/settings/tools');
  const tools = page.locator('#settings-tools');
  await expect(tools.getByText('OAuth unavailable')).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Add a mail account' })).toBeVisible();
});

base('common apps connects Teams and a local Obsidian vault, keeps them after reload and disconnects them', async ({ page, relay }) => {
  const vault = join(relay.workDir, 'My notes');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  writeFileSync(join(vault, 'Meeting.md'), 'Meeting notes');
  // The OS folder dialog cannot be driven in Chromium. The selected path goes through the real vault endpoint.
  await page.route('**/api/cwds', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), pick: true } });
  });
  await page.route('**/api/cwds/pick', (route) => route.fulfill({ json: { paths: [vault] } }));
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
  await expect(apps.getByRole('listitem')).toHaveCount(7);
  const obsidian = apps.getByRole('listitem', { name: 'Obsidian' });
  await obsidian.getByRole('button', { name: 'Choose vault' }).click();
  await expect(obsidian).toContainText('My notes · Connected');
  const teams = apps.getByRole('listitem', { name: 'Microsoft Teams', exact: true });
  await expect(teams.getByRole('link', { name: 'Get PowerShell' })).toBeVisible();
  graph = { status: 'missing-module' };
  await teams.getByRole('button', { name: 'Check again' }).click();
  await teams.getByRole('button', { name: 'Install Microsoft Graph for Teams' }).click();
  await expect(teams.getByRole('status')).toContainText('Installing Microsoft Graph');
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
  await teams.getByRole('button', { name: 'Enable in chats for supported assistants' }).click();
  await page.reload();
  await expect(teams).toContainText('Enabled for selected assistants');
  await teams.getByRole('button', { name: 'Turn off default chat access' }).click();
  await expect(teams.getByRole('button', { name: 'Enable in chats for supported assistants' })).toBeVisible();
  await expect(obsidian).toContainText('My notes · Connected');
  await obsidian.getByRole('button', { name: 'Disconnect' }).click();
  await expect(obsidian).not.toContainText('My notes');
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
  await page.goto(`${relay.base}/#/settings/tools`);
  const accounts = page.locator('.oauth-accounts');
  await expect(accounts.getByRole('heading', { name: 'Accounts you sign in to' })).toBeVisible();
  // No app of Harness Relay's own yet: the user's, with the addresses its registration must allow.
  await expect(accounts).toContainText(
    'Signing in with Microsoft 365 / Outlook.com needs an app registered with Microsoft 365 / Outlook.com first',
  );
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
  await tab.getByRole('link', { name: 'Allow' }).click();
  await expect(tab.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  // The code and state are spent: off the tab's address.
  expect(new URL(tab.url()).search).toBe('');
  await tab.close();
  expect(microsoft.exchanges).toBe(1);

  // Back in Settings: the account, and its own calendar among the calendar tools' (no password to edit).
  await expect(accounts).toContainText('Signed in as ming@contoso.com.');
  const row = accounts.locator('.lib-row', { hasText: 'ming@contoso.com' });
  await expect(row).toContainText('Connected');
  const calendars = page.locator('.connectors > .lib-list').nth(1);
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
  await expect(calendars).not.toContainText('ming@contoso.com');
});

test('an account signed in with Microsoft for mail adds its mail account, whose Test signs in over XOAUTH2 to its IMAP and SMTP servers', async ({
  page,
  relay,
  microsoft,
  mail,
}) => {
  await page.goto(`${relay.base}/#/settings/tools`);
  const accounts = page.locator('.oauth-accounts');
  await accounts.getByRole('button', { name: 'Set up the app' }).first().click();
  const form = accounts.getByRole('form', { name: 'The app to sign in with · Microsoft 365 / Outlook.com' });
  await form.getByRole('textbox', { name: 'Client ID' }).fill('e2e-client');
  await form.getByRole('button', { name: 'Save', exact: true }).click();

  // A new sign-in for mail alone.
  const uses = accounts.getByRole('group', { name: 'A new sign-in is for:' });
  await uses.getByRole('checkbox', { name: 'Calendars' }).uncheck();
  await uses.getByRole('checkbox', { name: 'Mail' }).check();
  const [tab] = await Promise.all([
    page.waitForEvent('popup'),
    accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' }).click(),
  ]);
  await tab.getByRole('link', { name: 'Allow' }).click();
  await expect(tab.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  await tab.close();
  expect(microsoft.exchanges).toBe(1);

  // The account, for mail, with a sign-in for calendars on offer; its mail account among the mail
  // tools', at Microsoft's servers (here the stand-ins), with no password nor servers to edit.
  const row = accounts.locator('.lib-row', { hasText: 'ming@contoso.com' });
  await expect(row).toContainText('Used for: Mail');
  await expect(row.getByRole('button', { name: 'Use for calendars' })).toBeEnabled();
  await expect(row.getByRole('button', { name: 'Calendars', exact: true })).toHaveCount(0);
  const mailList = page.locator('.connectors > .lib-list').first();
  const own = mailList.locator('.lib-row', { hasText: 'Outlook · ming@contoso.com' });
  await expect(own).toContainText('ming@contoso.com · 127.0.0.1');
  await expect(own.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.locator('.connectors > .lib-list').nth(1)).not.toContainText('ming@contoso.com');

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

  // Removed with its account.
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Remove ming@contoso.com' }).click();
  await expect(accounts.locator('.lib-row')).toHaveCount(0);
  await expect(mailList).not.toContainText('ming@contoso.com');
});
