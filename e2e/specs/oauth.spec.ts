import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test as base } from '../fixtures';

/*
 * Accounts that sign in with OAuth (Settings → Tool library → Accounts you sign in to), against a
 * stand-in for Microsoft's sign-in page and Graph on this computer, which the server is pointed at
 * (`RELAY_MICROSOFT_LOGIN_URL`, `RELAY_MICROSOFT_GRAPH_URL`): the app set up, the sign-in page opened
 * in a new tab, its Allow sending the browser back to the web app's /oauth/callback, the account and
 * its own calendar shown, another calendar added, and the account removed with its calendars.
 */

interface FakeMicrosoft {
  url: string;
  /** The token requests: the code exchanged with its verifier, once. */
  exchanges: number;
}

/** Microsoft's sign-in page (Allow sends the browser back with a code), its token endpoint (PKCE checked) and a little of Graph. */
async function fakeMicrosoft(): Promise<{ fake: FakeMicrosoft; server: Server }> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const tokens = new Set<string>();
  const fake: FakeMicrosoft = { url: '', exchanges: 0 };
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
        const access = `access-${randomUUID()}`;
        tokens.add(access);
        return json(200, { access_token: access, refresh_token: `refresh-${randomUUID()}`, expires_in: 3600 });
      }
      if (!tokens.has(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''))
        return json(401, { error: { message: 'no token' } });
      if (url.pathname === '/v1.0/me') return json(200, { id: 'e2e-subject', displayName: 'Ming', mail: 'ming@contoso.com' });
      if (url.pathname === '/v1.0/me/calendars')
        return json(200, {
          value: [
            { id: 'main', name: 'Calendar', canEdit: true },
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

/** The server signs Microsoft accounts in at the stand-in, and reaches their calendars there. */
const test = base.extend<{ microsoft: FakeMicrosoft }>({
  microsoft: async ({}, use) => {
    const { fake, server } = await fakeMicrosoft();
    await use(fake);
    await new Promise((r) => server.close(r));
  },
  serverEnv: async ({ microsoft }, use) => use({ RELAY_MICROSOFT_LOGIN_URL: microsoft.url, RELAY_MICROSOFT_GRAPH_URL: microsoft.url }),
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

  // Another of its calendars, added.
  await row.getByRole('button', { name: 'Calendars' }).click();
  const found = row.getByRole('list', { name: 'Calendars · ming@contoso.com' });
  await found.locator('li', { hasText: 'Team' }).getByRole('button', { name: 'Add' }).click();
  await expect(found.locator('li', { hasText: 'Team' })).toContainText('Added');
  await expect(calendars).toContainText('Team · ming@contoso.com');

  // Removed: its calendars go with it, and where to take the app's access away at Microsoft is said.
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Remove ming@contoso.com' }).click();
  await expect(accounts).toContainText('Microsoft cannot revoke one token');
  await expect(accounts.locator('.lib-row')).toHaveCount(0);
  await expect(calendars).not.toContainText('ming@contoso.com');
});
