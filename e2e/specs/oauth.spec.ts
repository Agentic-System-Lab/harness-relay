import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { Locator, Page } from '@playwright/test';
import type { ConnectorsView, OAuthCalendar, OAuthSignInView, OAuthView } from '../../src/shared/types';
import { expect, test as base } from '../fixtures';
import { withClis } from '../support/clis';

// Codex and Grok besides Claude Code, the one CLI a test server has by default: tests here use them.
withClis('codex', 'grok');

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

async function openApp(page: Page, name: 'Mail' | 'Calendar' | 'Google Drive') {
  const row = page.locator('.common-apps').getByRole('listitem', { name, exact: true });
  const details = row.locator(':scope > details');
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
  return row;
}

function signInSettings(page: Page) {
  return page.locator('details#oauth-client-settings');
}

async function openSignInSettings(page: Page) {
  const panel = signInSettings(page);
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) await panel.locator(':scope > summary').click();
  return panel;
}

async function expectSetupNeeded(section: Locator, provider: 'Google' | 'Microsoft', action: string) {
  const trigger = section.getByRole('button', { name: action, exact: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveJSProperty('disabled', true);
  await expect(section.getByRole('button', { name: 'Set up ' + provider + ' sign-in', exact: true })).toBeEnabled();
  await expect(section.getByRole('link', { name: provider + ' OAuth 2.0 setup guide', exact: true })).toHaveAttribute(
    'href',
    '/help/oauth/en/' + provider.toLowerCase() + '.html',
  );
}

async function selectUnconfigured(section: Locator, provider: 'Google' | 'Microsoft', name: string) {
  const choice = section.getByRole('button', { name, exact: true });
  await expect(section.locator('.oauth-setup-hint')).toHaveCount(0);
  await expect(choice).toBeEnabled();
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expectSetupNeeded(section, provider, provider === 'Google' ? 'Sign in with Google' : 'Sign in with Microsoft 365 / Outlook.com');
  await expect(section.locator('.oauth-setup-hint')).toHaveCount(1);
}

async function verticalGap(above: Locator, below: Locator) {
  const a = (await above.boundingBox())!;
  const b = (await below.boundingBox())!;
  return b.y - a.y - a.height;
}

interface FakeMicrosoft {
  url: string;
  /** The token requests: the code exchanged with its verifier, once. */
  exchanges: number;
  email: string;
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
  const fake: FakeMicrosoft = { url: '', exchanges: 0, email: 'ming@contoso.com', revoked: false, tokens: new Map() };
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
      if (url.pathname === '/v1.0/me') return json(200, { id: fake.email, mail: fake.email });
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

base('the common apps keep Slack’s provider connections and use direct sign-in for Teams and Drive', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const apps = page.locator('.common-apps');
  await expect(apps.locator('.app-row')).toHaveCount(11);
  for (const name of ['Gmail', 'Google Calendar']) await expect(apps.getByRole('listitem', { name, exact: true })).toHaveCount(0);
  const slack = apps.getByRole('listitem', { name: 'Slack', exact: true });
  const options = slack.locator('.app-options > summary');
  const claudeLink = slack.getByRole('link', { name: 'Connect Slack in Claude' });
  await expect(claudeLink).toBeHidden();
  await options.press('Enter');
  await expect(claudeLink).toHaveAttribute('href', 'https://claude.ai/directory/597f662f-36de-437e-836e-5a81013cbfbe');
  await expect(slack.getByRole('link', { name: 'Connect Slack in Codex' })).toHaveAttribute(
    'href',
    'https://chatgpt.com/plugins/plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d',
  );
  const teams = apps.getByRole('listitem', { name: 'Microsoft Teams', exact: true });
  await teams.locator('.app-options > summary').click();
  await expect(teams.getByRole('link', { name: /in Claude|in Codex/ })).toHaveCount(0);
  await expect(teams.getByRole('button', { name: 'Check connections' })).toHaveCount(0);
  const drive = await openApp(page, 'Google Drive');
  await expect(drive.getByRole('link', { name: /in Claude|in Codex/ })).toHaveCount(0);
  await expect(drive.getByText(/Connected in (Claude|Codex)/)).toHaveCount(0);
  await expect(drive.getByRole('combobox', { name: 'Access for this account' })).toHaveValue('read');
  await expect(drive.getByRole('option', { name: /create and edit/i })).toHaveCount(2);
  const plugin = slack.getByRole('link', { name: 'Connect Slack in Codex' });
  const url = (await plugin.getAttribute('href'))!;
  await page.context().route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Install plugin</title>' }));
  const [tab] = await Promise.all([page.waitForEvent('popup'), plugin.click()]);
  await expect(tab).toHaveURL(url);
  await tab.close();
  await expect(slack).not.toContainText(/· Connected/);
  await expect(page).toHaveURL(/#\/settings\/apps$/);
});

base('Mail, Calendar and Drive open the same Google registration and use its saved settings', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const panel = signInSettings(page);
  const summary = panel.locator(':scope > summary');
  await expect(summary).toHaveText('Account sign-in settings (OAuth 2.0)');
  await expect(summary).toBeVisible();
  await expect(panel).toHaveJSProperty('open', false);
  await summary.click();
  for (const provider of ['Google', 'Microsoft']) {
    await expect(panel.getByRole('group', { name: provider, exact: true })).toContainText('Not set up');
  }
  await summary.click();
  const firstApp = page.getByRole('listitem', { name: 'Mail', exact: true });
  expect((await summary.boundingBox())!.y).toBeLessThan((await firstApp.boundingBox())!.y);
  await expect(panel.locator('xpath=ancestor::*[@role="listitem" or self::li]')).toHaveCount(0);
  const google = panel.getByRole('form', { name: 'Google sign-in settings' });
  const clientId = google.getByRole('textbox', { name: 'Client ID' });
  const secret = google.getByLabel('Client secret');
  const mail = await openApp(page, 'Mail');
  const calendar = await openApp(page, 'Calendar');
  const drive = await openApp(page, 'Google Drive');
  for (const [row, action] of [
    [mail, 'Gmail'],
    [calendar, 'Google Calendar'],
    [drive, 'Sign in with Google'],
  ] as const) {
    if (row === drive) await expectSetupNeeded(row, 'Google', action);
    else await selectUnconfigured(row, 'Google', action);
    const setup = row.getByRole('button', { name: 'Set up Google sign-in', exact: true });
    await setup.press('Enter');
    await expect(panel).toHaveJSProperty('open', true);
    await expect(clientId).toBeFocused();
    await expect(row.getByRole('form')).toHaveCount(0);
    await expect(clientId).toHaveValue('');
    if (row !== drive) {
      await clientId.fill('cancelled-draft');
      await google.getByRole('button', { name: 'Cancel' }).click();
      await expect(google).toBeHidden();
      await expect(panel).toHaveJSProperty('open', false);
      await expect(setup).toBeFocused();
    }
  }
  await clientId.fill('first.apps.googleusercontent.com');
  await secret.fill('fixture-secret');
  await google.getByRole('button', { name: 'Save' }).click();
  const signIn = 'Sign in with Google';
  for (const row of [mail, calendar]) {
    const actions = row.locator('.oauth-provider');
    await expect(actions.getByRole('button')).toHaveText([signIn]);
    await expect(actions.getByRole('link')).toHaveCount(0);
    await expect(actions.locator('input')).toHaveCount(0);
  }
  await expect(drive.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
  await page.reload();

  // Reopen the saved registration directly and edit it once for all three services.
  await summary.press('Enter');
  await panel.getByRole('button', { name: 'Google sign-in settings' }).click();
  await expect(clientId).toHaveValue('first.apps.googleusercontent.com');
  await expect(secret).toHaveValue('');
  const editedId = 'edited.apps.googleusercontent.com';
  await clientId.fill(editedId);
  await secret.fill('edited-fixture-secret');
  await google.getByRole('button', { name: 'Save' }).click();
  await expect(google).toBeHidden();
  await openApp(page, 'Mail');
  await openApp(page, 'Calendar');
  await openApp(page, 'Google Drive');
  await mail.getByRole('button', { name: 'Gmail', exact: true }).click();
  await calendar.getByRole('button', { name: 'Google Calendar', exact: true }).click();
  await page.context().route('https://accounts.google.com/o/oauth2/v2/auth*', (route) => route.fulfill({ body: 'Fixture sign-in' }));
  for (const [row, button, scope] of [
    [mail, signIn, 'https://mail.google.com/'],
    [calendar, signIn, 'https://www.googleapis.com/auth/calendar'],
    [drive, 'Sign in with Google', 'https://www.googleapis.com/auth/drive.readonly'],
  ] as const) {
    const trigger = row.getByRole('button', { name: button, exact: true });
    const [popup] = await Promise.all([page.waitForEvent('popup'), trigger.click()]);
    await popup.waitForURL('https://accounts.google.com/o/oauth2/v2/auth*');
    const params = new URL(popup.url()).searchParams;
    expect(params.get('client_id')).toBe(editedId);
    expect(params.get('scope')!.split(' ').sort()).toEqual(['openid', 'email', 'profile', scope].sort());
    await popup.close();
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeEnabled();
  }
});

base(
  'an incomplete Google registration disables Google actions while Outlook and manual accounts remain available',
  async ({ page, relay }) => {
    const id = 'partial.apps.googleusercontent.com';
    await relay.api('/api/oauth/clients/google', { method: 'PUT', body: { clientId: id } });
    await relay.api('/api/oauth/clients/microsoft', { method: 'PUT', body: { clientId: 'ready-microsoft' } });
    await page.goto(relay.base + '/#/settings/apps');
    const mail = await openApp(page, 'Mail');
    const calendar = await openApp(page, 'Calendar');
    for (const [row, service] of [
      [mail, 'Gmail'],
      [calendar, 'Google Calendar'],
    ] as const) {
      await selectUnconfigured(row, 'Google', service);
      await row.getByRole('button', { name: 'Outlook', exact: true }).click();
      await expect(row.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com', exact: true })).toBeEnabled();
      await expect(row.getByRole('button', { name: 'Sign in on another device', exact: true })).toBeEnabled();
      await expect(row.getByRole('button', { name: 'Set up Microsoft sign-in', exact: true })).toHaveCount(0);
      await expect(row.getByRole('link', { name: 'Microsoft OAuth 2.0 setup guide', exact: true })).toHaveCount(0);
    }
    // Both rows currently show Outlook. Clearing its registration also disables the actions already on screen.
    const settings = signInSettings(page);
    await settings.locator(':scope > summary').click();
    await settings.getByRole('button', { name: 'Microsoft sign-in settings' }).click();
    const microsoft = settings.getByRole('form', { name: 'Microsoft sign-in settings' });
    await microsoft.getByRole('textbox', { name: 'Client ID' }).fill('');
    await microsoft.getByRole('button', { name: 'Save' }).click();
    for (const row of [mail, calendar]) {
      await expectSetupNeeded(row, 'Microsoft', 'Sign in with Microsoft 365 / Outlook.com');
      await expect(row.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' })).toHaveJSProperty('disabled', true);
      await expect(row.getByRole('button', { name: 'Sign in on another device' })).toHaveJSProperty('disabled', true);
    }
    await mail.getByRole('button', { name: 'iCloud Mail', exact: true }).click();
    await expect(mail.getByRole('form', { name: 'iCloud Mail' }).getByLabel('App-specific password')).toBeEditable();
    await calendar.getByRole('button', { name: 'Other (CalDAV)', exact: true }).click();
    await expect(calendar.getByRole('form', { name: 'Add a calendar' }).getByLabel('Password', { exact: true })).toBeEditable();
    const drive = await openApp(page, 'Google Drive');
    await expectSetupNeeded(drive, 'Google', 'Sign in with Google');
    const permissions = drive.getByRole('combobox', { name: 'Access for this account' });
    await expect(permissions).toBeDisabled();
    await expect(drive.locator('.oauth-setup-hint')).toHaveCount(1);
    await drive.getByRole('button', { name: 'Set up Google sign-in', exact: true }).click();
    const google = signInSettings(page).getByRole('form', { name: 'Google sign-in settings' });
    await expect(google.getByRole('textbox', { name: 'Client ID' })).toHaveValue(id);
    await google.getByLabel('Client secret').fill('missing-secret');
    await google.getByRole('button', { name: 'Save', exact: true }).click();
    for (const [row, service] of [
      [mail, 'Gmail'],
      [calendar, 'Google Calendar'],
    ] as const) {
      await row.getByRole('button', { name: service, exact: true }).click();
      await expect(row.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeEnabled();
      const outlook = row.getByRole('button', { name: 'Outlook', exact: true });
      await expect(outlook).toBeEnabled();
      await expect(row.locator('.oauth-setup-hint')).toHaveCount(0);
      await outlook.click();
      await expectSetupNeeded(row, 'Microsoft', 'Sign in with Microsoft 365 / Outlook.com');
    }
    await expect(drive.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeEnabled();
    await expect(permissions).toBeEnabled();
    await expect(drive.getByRole('link', { name: /OAuth 2.0 setup guide/ })).toHaveCount(0);
  },
);

for (const lang of ['en', 'zh-TW'] as const) {
  base.describe(lang + ' OAuth setup guides', () => {
    base.use({ lang });
    base('opens local illustrated guides in the current language, including full-size images', async ({ page, relay }) => {
      await page.goto(relay.base + '/#/settings/apps');
      const panel = signInSettings(page);
      await panel.locator(':scope > summary').press('Enter');
      const guide = '/help/oauth/' + lang + '/';
      const linkName = lang === 'en' ? ' OAuth 2.0 setup guide' : ' OAuth 2.0 設定圖解';
      const editName = lang === 'en' ? ' sign-in settings' : ' 登入設定';
      const drive = await openApp(page, 'Google Drive');
      const inlineGuide = drive.getByRole('link', { name: 'Google' + linkName, exact: true });
      await expect(inlineGuide).toBeVisible();
      await expect(inlineGuide).toHaveAttribute('href', guide + 'google.html');
      await expect(panel.getByRole('link')).toHaveCount(2);
      for (const provider of ['Google', 'Microsoft']) {
        const link = panel.getByRole('link', { name: provider + linkName, exact: true });
        const path = guide + provider.toLowerCase() + '.html';
        await expect(link).toHaveAttribute('href', path);
        const [article] = await Promise.all([page.waitForEvent('popup'), link.click()]);
        await expect(article).toHaveURL(relay.base + path);
        await expect(article.locator('html')).toHaveAttribute('lang', lang);
        const title = (lang === 'en' ? 'Set up ' : '設定 ') + provider + ' OAuth 2.0';
        await expect(article.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
        const steps = article.locator('main > ol > li');
        await expect(steps).toHaveCount(provider === 'Google' ? 6 : 5);
        await expect(steps.filter({ hasText: provider === 'Google' ? 'https://mail.google.com/' : 'IMAP.AccessAsUser.All' })).toHaveCount(
          1,
        );
        const pictures = article.locator('figure img');
        await expect(pictures).toHaveCount(2);
        for (const width of [390, 1100]) {
          await article.setViewportSize({ width, height: 800 });
          for (const picture of await pictures.all()) {
            await picture.scrollIntoViewIfNeeded();
            const size = await picture.evaluate(async (img: HTMLImageElement) => {
              await img.decode();
              const rect = img.getBoundingClientRect();
              return {
                width: rect.width,
                height: rect.height,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                url: img.currentSrc,
              };
            });
            expect(size.url).toMatch(new RegExp('^' + relay.base + '/help/oauth/images/'));
            expect(size.width).toBeGreaterThan(0);
            expect(size.width).toBeLessThanOrEqual(Math.min(width, size.naturalWidth));
            expect(Math.abs(size.height - (size.width * size.naturalHeight) / size.naturalWidth)).toBeLessThan(1);
          }
        }
        const original = await pictures.first().evaluate((img: HTMLImageElement) => img.currentSrc);
        await pictures.first().click();
        await expect(article).toHaveURL(original);
        await expect(article.locator('body > img')).toBeVisible();
        await article.close();
      }
      for (const provider of ['Google', 'Microsoft']) {
        await panel.getByRole('button', { name: provider + editName, exact: true }).click();
        await expect(panel.getByRole('link')).toHaveCount(1);
        await expect(panel.getByRole('link')).toHaveAccessibleName(provider + linkName);
      }
    });
  });
}

base('a delayed OAuth save preserves a newer draft and a failed save can be retried', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const panel = signInSettings(page);
  await panel.locator(':scope > summary').press('Enter');
  const googleButton = panel.getByRole('button', { name: 'Google sign-in settings' });
  const microsoftButton = panel.getByRole('button', { name: 'Microsoft sign-in settings' });
  const google = panel.getByRole('form', { name: 'Google sign-in settings' });
  const microsoft = panel.getByRole('form', { name: 'Microsoft sign-in settings' });
  await googleButton.click();
  const clientId = google.getByRole('textbox', { name: 'Client ID' });
  const save = google.getByRole('button', { name: 'Save' });
  await clientId.fill('saved.apps.googleusercontent.com');
  await google.getByLabel('Client secret').fill('fixture-secret');
  let releaseSave!: () => void;
  const resume = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saved = false;
  await page.route(
    '**/api/oauth/clients/google',
    async (route) => {
      const response = await route.fetch();
      saved = response.ok();
      await resume;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await save.click();
  await expect.poll(() => saved).toBe(true);

  // While the first editor waits for its save response, open a fresh draft of the same registration.
  await microsoftButton.click();
  await expect(microsoft).toBeVisible();
  await googleButton.click();
  await clientId.fill('new-draft.apps.googleusercontent.com');
  releaseSave();
  await expect(google.getByRole('alert')).toContainText('This shared registration was updated elsewhere');
  await expect(clientId).toHaveValue('new-draft.apps.googleusercontent.com');
  await expect(save).toBeDisabled();
  await google.getByRole('button', { name: 'Cancel' }).click();
  await googleButton.click();
  await expect(clientId).toHaveValue('saved.apps.googleusercontent.com');

  await microsoftButton.click();
  const msId = microsoft.getByRole('textbox', { name: 'Client ID' });
  const msSave = microsoft.getByRole('button', { name: 'Save' });
  await msId.fill('outlook-fixture');
  await page.route(
    '**/api/oauth/clients/microsoft',
    (route) => route.fulfill({ status: 503, json: { error: 'Could not save settings' } }),
    { times: 1 },
  );
  await msSave.click();
  await expect(microsoft).toContainText('Could not save settings');
  await expect(msId).toHaveValue('outlook-fixture');
  await msSave.click();
  await expect(microsoft).toBeHidden();
  const clients = (await relay.api<OAuthView>('/api/oauth')).clients;
  expect(clients.find((client) => client.provider === 'microsoft')?.clientId).toBe('outlook-fixture');
  expect(clients.find((client) => client.provider === 'google')?.clientId).toBe('saved.apps.googleusercontent.com');
});

base('OAuth setup leaves room between hints, actions and the shared editor on desktop and phones', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings/apps');
  const mail = await openApp(page, 'Mail');
  const calendar = await openApp(page, 'Calendar');
  await selectUnconfigured(mail, 'Google', 'Gmail');
  await selectUnconfigured(calendar, 'Microsoft', 'Outlook');
  const panel = signInSettings(page);
  await panel.locator(':scope > summary').press('Enter');
  const google = panel.getByRole('button', { name: 'Google sign-in settings' });
  const microsoft = panel.getByRole('button', { name: 'Microsoft sign-in settings' });
  await google.click();
  const form = panel.getByRole('form', { name: 'Google sign-in settings' });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await verticalGap(panel.locator('p').first(), google)).toBeGreaterThanOrEqual(16);
    expect(await verticalGap(microsoft, form)).toBeGreaterThanOrEqual(16);
    const bounds = (await form.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    for (const row of [mail, calendar]) {
      const hints = row.locator('.oauth-setup-hint');
      await expect(hints).toHaveCount(1);
      for (const hint of await hints.all()) {
        const guide = hint.getByRole('link');
        const setup = hint.getByRole('button');
        expect(await verticalGap(hint.locator('p').first(), setup)).toBeGreaterThanOrEqual(16);
        for (const action of [guide, setup]) {
          const box = (await action.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        }
      }
    }
  }
});

base('manual mail and calendar settings stay usable if OAuth settings cannot load', async ({ page, relay }) => {
  await page.route('**/api/oauth', (route) => route.fulfill({ status: 500, json: { error: 'OAuth unavailable' } }));
  await page.goto(relay.base + '/#/settings/apps');
  await expect(page.locator('#settings-apps').getByText('OAuth unavailable')).toBeVisible();
  const mail = await openApp(page, 'Mail');
  await mail.getByRole('button', { name: 'Other mailbox' }).click();
  const mailbox = mail.getByRole('form');
  await mailbox.getByLabel('Provider').selectOption('fastmail');
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

base('Obsidian connects two local vaults, keeps them after reload and disconnects them without deleting notes', async ({ page, relay }) => {
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
  await page.goto(`${relay.base}/#/settings/apps`);
  const apps = page.locator('.common-apps');
  await expect(apps.locator('.app-row')).toHaveCount(11);
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
  await page.reload();
  await expect(obsidian).toContainText('2 vaults connected');
  await obsidian.locator('.app-options > summary').click();
  const removals = vaultList.getByRole('button', { name: /^Disconnect / });
  await removals.nth(1).click();
  await expect(obsidian.locator('.app-options > summary')).toContainText('My notes · Connected');
  await expect(vaultList).not.toContainText(otherVault);
  await removals.first().click();
  await expect(vaultList).toHaveCount(0);
  expect(readFileSync(join(vault, 'Meeting.md'), 'utf8')).toBe('Meeting notes');
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
  await selectUnconfigured(accounts, 'Microsoft', 'Outlook');
  // No app of Harness Relay's own yet: the user's, with the addresses its registration must allow.
  await expect(accounts.getByRole('form')).toHaveCount(0);
  await accounts.getByRole('button', { name: 'Set up Microsoft sign-in' }).click();
  const form = signInSettings(page).getByRole('form', { name: 'Microsoft sign-in settings' });
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
  const calendars = app.getByRole('list', { name: 'Calendars', exact: true });
  const row = calendars.getByRole('group', { name: 'ming@contoso.com', exact: true });
  const own = row.locator('.connector-resource').filter({ hasText: 'Outlook' });
  await expect(accounts.getByRole('heading', { name: 'Accounts you sign in to' })).toHaveCount(0);
  await expect(row.getByText('ming@contoso.com', { exact: true })).toHaveCount(1);
  await expect(row).toContainText('Connected');
  await expect(own.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  const found = row.getByRole('list', { name: 'Calendars · ming@contoso.com' });
  const team = found.locator('li', { hasText: 'Team' });
  const main = found.locator('li', { hasText: 'Calendar' });
  await expect(main).toContainText('Added');
  await team.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(team).toContainText('Added');
  await expect(row.locator('.connector-resource')).toHaveCount(2);
  await expect(row.getByRole('button', { name: 'Manage calendars', exact: true })).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Disconnect account', exact: true })).toHaveCount(0);

  // Removing every calendar keeps the account and the picker. Either resource can be added again.
  for (const resource of [row.locator('.connector-resource').filter({ hasText: 'Team' }), own]) {
    page.once('dialog', (dialog) => dialog.accept());
    await resource.getByRole('button', { name: 'Remove calendar' }).click();
  }
  await expect(row.locator('.connector-resource')).toHaveCount(0);
  await expect(row.getByText('No calendars selected.')).toBeVisible();
  const choose = row.getByRole('button', { name: 'Choose calendars', exact: true });
  await choose.click();
  await expect(found).toHaveCount(0);
  await choose.click();
  await main.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(main).toContainText('Added');
  const restored = row.locator('.connector-resource').filter({ hasText: 'Calendar' });

  // The sign-in revoked at Microsoft: a calendar's Test finds its token refused and its refresh too,
  // and the account then says it needs a new sign-in.
  microsoft.revoked = true;
  await restored.getByRole('button', { name: 'Test' }).click();
  await expect(restored).toContainText('The sign-in of ming@contoso.com no longer works');
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
  await row.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  await expect(row).toContainText('Needs a new sign-in');

  // Another identity on the same registration stays separate, alongside a manual calendar.
  microsoft.revoked = false;
  microsoft.email = 'alex@example.test';
  const [second] = await Promise.all([
    page.waitForEvent('popup'),
    accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' }).click(),
  ]);
  await second.getByRole('link', { name: 'Allow' }).click();
  await expect(second.getByRole('status')).toHaveText('Signed in as alex@example.test.');
  await second.close();
  const other = calendars.getByRole('group', { name: 'alex@example.test', exact: true });
  await expect(other.locator('.connector-resource')).toHaveCount(1);
  await relay.api('/api/connectors/calendar/local-team', {
    method: 'PUT',
    body: { name: 'Manual calendar', url: 'https://calendar.example.test/team/', username: 'reader', password: 'test' },
  });
  await page.reload();
  await openApp(page, 'Calendar');
  const manual = calendars.getByRole('listitem').filter({ hasText: 'Manual calendar' });
  await expect(manual.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  const settings = await openSignInSettings(page);
  const microsoftGroup = settings.getByRole('group', { name: 'Microsoft', exact: true });
  const accountSettings = microsoftGroup.getByRole('group', { name: 'ming@contoso.com', exact: true });
  await expect(microsoftGroup.getByRole('group')).toHaveCount(2);
  page.once('dialog', (d) => void d.accept());
  await accountSettings.getByRole('button', { name: 'Disconnect account', exact: true }).click();
  await expect(settings).toContainText('Microsoft cannot revoke one token');
  await expect(accountSettings).toHaveCount(0);
  await expect(microsoftGroup.getByRole('group', { name: 'alex@example.test', exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(other.getByRole('button', { name: 'Manage calendars' })).toBeVisible();
  await expect(manual).toBeVisible();
});

test('an account signed in with Microsoft for mail adds its mail account, whose Test signs in over XOAUTH2 to its IMAP and SMTP servers', async ({
  page,
  relay,
  microsoft,
  mail,
}) => {
  await page.goto(`${relay.base}/#/settings/apps`);
  const app = await openApp(page, 'Mail');
  const accounts = app.locator('.oauth-accounts');
  await selectUnconfigured(accounts, 'Microsoft', 'Outlook');
  await accounts.getByRole('button', { name: 'Set up Microsoft sign-in' }).click();
  const form = signInSettings(page).getByRole('form', { name: 'Microsoft sign-in settings' });
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

  const mailList = app.getByRole('list', { name: 'Mail accounts' });
  const row = mailList.getByRole('group', { name: 'ming@contoso.com', exact: true });
  const own = row.locator('.connector-resource');
  await expect(accounts.getByRole('heading', { name: 'Accounts you sign in to' })).toHaveCount(0);
  await expect(row.getByText('ming@contoso.com', { exact: true })).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Manage calendars' })).toHaveCount(0);
  await expect(own).toContainText('127.0.0.1');
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
  await own.getByRole('button', { name: 'Remove mailbox' }).click();
  await expect(own).toHaveCount(0);
  await row.getByRole('button', { name: 'Add mailbox' }).click();
  await expect(accounts).toContainText('The mail of ming@contoso.com was added to the mail tools.');
  await expect(own).toBeVisible();
  await expect(row.getByRole('button', { name: 'Add mailbox' })).toHaveCount(0);
  expect(microsoft.exchanges).toBe(1);

  // Adding calendar access explicitly preserves the Mail grant on the same account.
  const calendar = await openApp(page, 'Calendar');
  const calendarAccounts = calendar.locator('.oauth-accounts');
  await calendarAccounts.getByRole('button', { name: 'Outlook', exact: true }).click();
  await expect(calendarAccounts.getByText('Use an existing sign-in', { exact: true })).toHaveCount(0);
  await expect(calendarAccounts.getByRole('button', { name: 'Use for calendars' })).toHaveCount(0);
  const [consent] = await Promise.all([
    page.waitForEvent('popup'),
    calendarAccounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' }).click(),
  ]);
  await expect(accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' })).toBeDisabled();
  await expect(accounts.getByText('Finish or cancel the sign-in in Calendar first.', { exact: true })).toBeVisible();
  await expect(consent.getByRole('link', { name: 'Allow' })).toBeVisible();
  const consentParams = new URL(consent.url()).searchParams;
  expect(consentParams.has('login_hint')).toBe(false);
  const scopes = consentParams.get('scope');
  expect(scopes).toContain('Calendars.ReadWrite');
  expect(scopes).not.toContain('IMAP.AccessAsUser.All');
  expect(scopes).not.toContain('Channel.Read');
  await consent.getByRole('link', { name: 'Allow' }).click();
  await expect(consent.getByRole('link', { name: "Back to Harness Relay's Settings" })).toHaveAttribute('href', '/#/settings/apps');
  await consent.close();
  await expect(row.getByRole('button', { name: 'Disconnect account' })).toHaveCount(0);
  const shared = (await relay.api<OAuthView>('/api/oauth')).accounts;
  expect(shared).toHaveLength(1);
  expect(shared[0]?.uses).toEqual(['calendar', 'mail']);
  const calendars = calendar.getByRole('list', { name: 'Calendars', exact: true });
  await expect(calendars.getByRole('group', { name: 'ming@contoso.com' })).toContainText('Outlook');

  await own.getByRole('button', { name: 'Test' }).click();
  await expect.poll(() => mail.signIns.length).toBe(4);
  expect(mail.signIns.slice(2)).toEqual([
    { server: 'imap', user: 'ming@contoso.com', ok: true },
    { server: 'smtp', user: 'ming@contoso.com', ok: true },
  ]);

  // The sign-in can expire even after its mailbox was removed. Warn on the collapsed row,
  // then reauthorize all existing uses without silently adding the mailbox back.
  page.once('dialog', (d) => void d.accept());
  await own.getByRole('button', { name: 'Remove mailbox' }).click();
  await expect(own).toHaveCount(0);
  await expect(row.getByText('No mailbox added.')).toBeVisible();
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
  await expect(own).toHaveCount(0);
  await expect(row.getByText('No mailbox added.')).toBeVisible();
  await row.getByRole('button', { name: 'Add mailbox' }).click();
  await expect(own).toBeVisible();

  // The mailbox Test re-reads the account state. A late reply must preserve a newer central settings change.
  const panel = await openSignInSettings(page);
  const ms = panel.getByRole('group', { name: 'Microsoft', exact: true });
  await expect(ms).toContainText('Configured');
  let releaseRead!: () => void;
  const holdRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let snapshotTaken = false;
  await page.route(
    '**/api/oauth',
    async (route) => {
      const response = await route.fetch();
      expect(((await response.json()) as OAuthView).clients.find((c) => c.provider === 'microsoft')?.disabled).toBeFalsy();
      snapshotTaken = true;
      await holdRead;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await own.getByRole('button', { name: 'Test' }).click();
  await expect.poll(() => snapshotTaken).toBe(true);
  page.once('dialog', (d) => d.accept());
  await ms.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(ms).toContainText('Turned off');
  const oldReply = page.waitForResponse('**/api/oauth');
  releaseRead();
  await (await oldReply).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(ms).toContainText('Turned off');
  await expect(accounts.getByRole('button', { name: 'Sign in with Microsoft 365 / Outlook.com' })).toBeDisabled();

  // Removing this shared sign-in identifies both services before either is disconnected.
  const sharedAccount = ms.getByRole('group', { name: 'ming@contoso.com', exact: true });
  await expect(sharedAccount).toContainText('Outlook calendar, Outlook mail');
  const removing = page.waitForEvent('dialog');
  const clickRemove = sharedAccount.getByRole('button', { name: 'Disconnect account' }).click();
  const dialog = await removing;
  expect(dialog.message()).toContain('This disconnects Outlook calendar, Outlook mail');
  await dialog.accept();
  await clickRemove;
  await expect(accounts.locator('.lib-row')).toHaveCount(0);
  await expect(mailList).toHaveCount(0);
  await expect(calendars).toHaveCount(0);
});

test.describe('shared registrations', () => {
  test.use({
    serverEnv: async ({ serverEnv }, use) =>
      use({ ...serverEnv, NODE_OPTIONS: '--import=' + new URL('../support/google-documents.mjs', import.meta.url).href }),
  });

  test('disconnecting an account in OAuth settings preserves the other provider with the same email', async ({
    page,
    relay,
    microsoft,
  }) => {
    const email = 'editor@example.test';
    microsoft.email = email;
    await relay.api('/api/oauth/clients/microsoft', { method: 'PUT', body: { clientId: 'e2e-client' } });
    const ms = await relay.api<OAuthSignInView>('/api/oauth/signins', {
      method: 'POST',
      body: { provider: 'microsoft', uses: ['calendar', 'teams'], origin: relay.base },
    });
    await page.goto(ms.authorizeUrl!);
    await page.getByRole('link', { name: 'Allow' }).click();
    await expect(page.getByRole('status')).toHaveText('Signed in as ' + email + '.');
    await relay.api('/api/oauth/clients/google', {
      method: 'PUT',
      body: { clientId: 'fixture.apps.googleusercontent.com', secret: 'fake' },
    });
    const google = await relay.api<OAuthSignInView>('/api/oauth/signins', {
      method: 'POST',
      body: { provider: 'google', uses: ['mail', 'drive', 'documents'], origin: relay.base },
    });
    const consent = new URL(google.authorizeUrl!).searchParams;
    writeFileSync(
      join(relay.dataDir, 'google-docs-consent.json'),
      JSON.stringify({
        challenge: consent.get('code_challenge'),
        redirect: consent.get('redirect_uri'),
        scopes: consent.get('scope')!.split(' '),
      }),
    );
    const result = await relay.api<OAuthSignInView>('/api/oauth/callback', {
      method: 'POST',
      body: { state: consent.get('state'), code: 'fixture-docs-code' },
    });
    expect(result.status).toBe('done');
    await page.goto(relay.base + '/#/settings/apps');
    const settings = await openSignInSettings(page);
    const centralAccount = (provider: string) =>
      settings.getByRole('group', { name: provider, exact: true }).getByRole('group', { name: email, exact: true });
    const outlook = centralAccount('Microsoft');
    const gmail = centralAccount('Google');
    for (const service of ['Outlook calendar', 'Microsoft Teams']) await expect(outlook).toContainText(service);
    for (const service of ['Gmail', 'Google Drive', 'Google Docs editing']) await expect(gmail).toContainText(service);
    for (const service of ['Mail', 'Calendar', 'Google Drive'] as const) {
      const app = await openApp(page, service);
      await expect(app.getByRole('group', { name: email, exact: true })).toBeVisible();
      await expect(app.getByRole('button', { name: /disconnect/i })).toHaveCount(0);
    }
    const teams = page.locator('.common-apps').getByRole('listitem', { name: 'Microsoft Teams', exact: true });
    await teams.locator(':scope > details > summary').click();
    await expect(teams).toContainText(email);
    await expect(teams.getByRole('button', { name: /disconnect/i })).toHaveCount(0);
    const disconnect = outlook.getByRole('button', { name: 'Disconnect account', exact: true });
    page.once('dialog', async (dialog) => {
      for (const name of [email, 'Microsoft Teams', 'Outlook calendar']) expect(dialog.message()).toContain(name);
      expect(dialog.message()).not.toMatch(/Gmail|Google Drive|Google Docs/);
      await dialog.dismiss();
    });
    await disconnect.click();
    await expect(outlook).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await disconnect.click();
    await expect(outlook).toHaveCount(0);
    await expect(teams).not.toContainText(email);
    await expect(gmail).toBeVisible();
    await page.reload();
    await openSignInSettings(page);
    await expect(outlook).toHaveCount(0);
    await expect(gmail).toBeVisible();
    const connectors = await relay.api<ConnectorsView>('/api/connectors');
    expect(connectors.calendar).toHaveLength(0);
    expect(connectors.mail.map((mailbox) => mailbox.address)).toEqual([email]);
  });
});

test('delayed calendar removals and connector reads cannot restore removed mail or calendars', async ({ page, relay }) => {
  await relay.api('/api/oauth/clients/microsoft', { method: 'PUT', body: { clientId: 'e2e-client' } });
  const signIn = await relay.api<OAuthSignInView>('/api/oauth/signins', {
    method: 'POST',
    body: { provider: 'microsoft', uses: ['calendar', 'mail'], origin: relay.base },
  });
  await page.goto(signIn.authorizeUrl!);
  await page.getByRole('link', { name: 'Allow' }).click();
  await expect(page.getByRole('status')).toHaveText('Signed in as ming@contoso.com.');
  const {
    accounts: [account],
  } = await relay.api<OAuthView>('/api/oauth');
  const calendarUrl = '/api/oauth/accounts/' + account.id + '/calendars';
  const team = (await relay.api<OAuthCalendar[]>(calendarUrl)).find((c) => c.name === 'Team')!;
  await relay.api(calendarUrl, { method: 'POST', body: { name: 'Team', url: team.url } });
  const resources = await relay.api<ConnectorsView>('/api/connectors');
  const firstCalendar = resources.calendar.find((c) => c.name.startsWith('Outlook'))!;
  await page.goto(relay.base + '/#/settings/apps');
  const calendar = (await openApp(page, 'Calendar')).getByRole('group', { name: account.email, exact: true });
  const mail = (await openApp(page, 'Mail')).getByRole('group', { name: account.email, exact: true });
  await expect(calendar.locator('.connector-resource')).toHaveCount(2);
  await expect(mail.locator('.connector-resource')).toHaveCount(1);

  // Commit the real request, hold its response and continue accepting other browser requests.
  const holdResponse = async (path: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = false;
    await page.route(
      '**' + path,
      async (route) => {
        const result = await route.fetch();
        captured = true;
        await gate;
        await route.fulfill({ response: result });
      },
      { times: 1 },
    );
    return { release, captured: () => expect.poll(() => captured).toBe(true) };
  };
  const delayedRemoval = await holdResponse('/api/connectors/calendar/' + firstCalendar.id);
  page.on('dialog', (dialog) => dialog.accept());
  await calendar.locator('.connector-resource').filter({ hasText: 'Outlook' }).getByRole('button', { name: 'Remove calendar' }).click();
  await delayedRemoval.captured();
  await calendar.locator('.connector-resource').filter({ hasText: 'Team' }).getByRole('button', { name: 'Remove calendar' }).click();
  await expect(calendar.getByText('No calendars selected.')).toBeVisible();

  // The first DELETE's snapshot still contains Team. Its follow-up GET sees the latest calendars
  // but is about to become stale for Mail. Release it only after a newer GET has updated both lists.
  const staleRead = await holdResponse('/api/connectors');
  delayedRemoval.release();
  await staleRead.captured();
  await mail.getByRole('button', { name: 'Remove mailbox' }).click();
  await expect(mail.getByRole('button', { name: 'Add mailbox' })).toBeVisible();
  const late = page.waitForResponse((resp) => new URL(resp.url()).pathname === '/api/connectors');
  staleRead.release();
  await (await late).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(calendar.getByRole('button', { name: 'Choose calendars' })).toBeVisible();
  await expect(mail.getByRole('button', { name: 'Add mailbox' })).toBeVisible();
  await expect(calendar.locator('.connector-resource')).toHaveCount(0);
  await expect(mail.locator('.connector-resource')).toHaveCount(0);
});
