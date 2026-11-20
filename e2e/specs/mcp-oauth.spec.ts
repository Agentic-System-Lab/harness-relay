import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from '../../src/server/fsRemove';
import { openDatabase } from '../../src/server/db';
import { ToolLibrary } from '../../src/server/tools';
import { APP_SERVERS } from '../../src/shared/apps';
import type { ToolLibraryView } from '../../src/shared/types';
import { saveLegacySlackGrant } from '../support/legacy-slack-grant';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { expect, test as base } from '../fixtures';
import { finishedReply, openTeamChat, openToolCategory, send } from '../support/app';
import { logged } from '../support/clis';

/*
 * A tool library MCP server's own sign-in (MCP's authorization), against a stand-in MCP server and its
 * authorization server on this computer: the server answers 401 and names its protected resource
 * metadata, which names the authorization server; Settings → Apps and tools → Tool library's Sign in registers Harness
 * Relay there and opens its page in a new tab (opened on the click, navigated once the server answers),
 * whose Allow sends the browser back to the web app's /oauth/callback; the server then says it is signed
 * in, and a fake Claude Code's turn gets its access token in the server's Authorization header. Revoked at
 * the authorization server, the next turn goes without the server and the reply says so; Settings says it
 * needs a new sign-in, Sign in again mends it, and Sign out deletes and revokes its tokens. A server whose
 * sign-in page is on another host than its authorization server says where first, and opens it only on
 * Continue.
 */

interface FakeAuth {
  url: string;
  /** A second address of the same stand-in: where its sign-in page is when `pageElsewhere`. */
  pageUrl: string;
  /** Its metadata names its sign-in page at `pageUrl`, not on the issuer's own origin. */
  pageElsewhere: boolean;
  /** The clients registered: their redirect addresses. */
  clients: { id: string; redirects: string[] }[];
  /** The access tokens given, the newest last. */
  access: string[];
  /** The resource each token request named. */
  resources: string[];
  /** Its refresh tokens are refused (`invalid_grant`): the sign-in was revoked here. */
  refuseRefresh: boolean;
  revoked: string[];
}

/** The MCP server (`/mcp`), its protected resource metadata, and its authorization server under `/tenant`. */
async function fakeAuth(): Promise<{ fake: FakeAuth; servers: Server[] }> {
  const codes = new Map<string, { challenge: string; redirect: string; resource: string }>();
  const good = new Set<string>();
  const refresh = new Set<string>();
  const fake: FakeAuth = {
    url: '',
    pageUrl: '',
    pageElsewhere: false,
    clients: [],
    access: [],
    resources: [],
    refuseRefresh: false,
    revoked: [],
  };
  const tokens = () => {
    const access = `mcp-access-${randomUUID()}`;
    const next = `mcp-refresh-${randomUUID()}`;
    good.add(access);
    refresh.add(next);
    fake.access.push(access);
    // A second: each turn gets one renewed (less than half of it is left by then).
    return { access_token: access, refresh_token: next, token_type: 'Bearer', expires_in: 1 };
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', fake.url);
      const json = (status: number, v: unknown) => (
        res.writeHead(status, { 'content-type': 'application/json' }),
        res.end(JSON.stringify(v))
      );
      const issuer = `${fake.url}/tenant`;
      if (url.pathname === '/mcp') {
        if (good.has(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''))
          return json(200, { jsonrpc: '2.0', id: 1, result: {} });
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${fake.url}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
        return json(200, { resource: `${fake.url}/mcp`, authorization_servers: [issuer], scopes_supported: ['mcp:tools'] });
      if (url.pathname === '/.well-known/oauth-authorization-server/tenant')
        return json(200, {
          issuer,
          authorization_endpoint: `${fake.pageElsewhere ? `${fake.pageUrl}/tenant` : issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          revocation_endpoint: `${issuer}/revoke`,
          code_challenge_methods_supported: ['S256'],
        });
      if (url.pathname === '/tenant/register') {
        const asked = JSON.parse(body) as { redirect_uris: string[] };
        const id = `client-${fake.clients.length + 1}`;
        fake.clients.push({ id, redirects: asked.redirect_uris });
        return json(201, { ...asked, client_id: id });
      }
      if (url.pathname === '/tenant/authorize') {
        const q = url.searchParams;
        const client = fake.clients.find((c) => c.id === q.get('client_id'));
        if (!client?.redirects.includes(q.get('redirect_uri') ?? '')) return json(400, { error: 'invalid_request' });
        const code = `code-${randomUUID()}`;
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect: q.get('redirect_uri')!, resource: q.get('resource') ?? '' });
        const back = new URL(q.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state')!);
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(
          `<!doctype html><title>Sign in to Linear</title><h1>Let Harness Relay use Linear?</h1><a href="${back.href.replace(/&/g, '&amp;')}">Allow</a>`,
        );
      }
      if (url.pathname === '/tenant/token') {
        const form = new URLSearchParams(body);
        fake.resources.push(form.get('resource') ?? '');
        if (form.get('grant_type') === 'refresh_token') {
          const old = form.get('refresh_token') ?? '';
          if (fake.refuseRefresh || !refresh.delete(old)) return json(400, { error: 'invalid_grant' });
          return json(200, tokens());
        }
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verified =
          c &&
          c.redirect === form.get('redirect_uri') &&
          c.resource === form.get('resource') &&
          c.challenge ===
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url');
        if (!verified) return json(400, { error: 'invalid_grant' });
        return json(200, tokens());
      }
      if (url.pathname === '/tenant/revoke') {
        fake.revoked.push(new URLSearchParams(body).get('token') ?? '');
        return json(200, {});
      }
      json(404, {});
    });
  };
  const server = createServer(handle);
  const page = createServer(handle);
  for (const s of [server, page]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  return { fake, servers: [server, page] };
}

const test = base.extend<{ auth: FakeAuth }>({
  auth: async ({}, use) => {
    const { fake, servers } = await fakeAuth();
    await use(fake);
    for (const s of servers) await new Promise((r) => s.close(r));
  },
});

base('Notion and Heptabase connect from the full row and keep sign-in controls and keyboard focus accessible', async ({ page, relay }) => {
  const library = await relay.api<ToolLibraryView>('/api/tools');
  const authorizeUrl = 'https://notion.example.test/consent';
  const challenge = { id: '', provider: 'mcp', expiresAt: Date.now() + 120000, authorizeUrl };
  let connected = false;
  await page.context().route(authorizeUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Notion consent</title>' }));
  const started: string[] = [];
  let cancelled = 0;
  await page.route(/\/api\/apps\/(notion|heptabase)\/signin$/, (route) => {
    started.push(new URL(route.request().url()).pathname.split('/')[3]);
    challenge.id = randomUUID();
    return route.fulfill({ json: { ...challenge, status: 'waiting' } });
  });
  await page.route('**/api/oauth/signins/*', (route) => {
    if (route.request().method() === 'DELETE') {
      cancelled++;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ...challenge, status: connected ? 'done' : 'waiting' } });
  });
  await page.route('**/api/tools', (route) => {
    const view: ToolLibraryView = connected
      ? {
          ...library,
          mcpServers: [
            ...library.mcpServers,
            {
              app: 'notion',
              id: 'notion',
              name: 'notion',
              transport: 'http',
              command: '',
              args: [],
              url: APP_SERVERS.notion,
              env: [],
              headers: [],
              providers: [],
              oauth: { status: 'signed-in', signedInAt: Date.now() },
            },
          ],
        }
      : library;
    return route.fulfill({ json: view });
  });
  await page.route('**/api/tools/mcp/notion/signin', (route) => {
    expect(route.request().method()).toBe('DELETE');
    connected = false;
    return route.fulfill({ json: library });
  });
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name: 'Notion', exact: true });
  const connect = row.getByRole('button', { name: 'Connect Notion', exact: true });
  const other = page.getByRole('button', { name: 'Connect Heptabase', exact: true });
  await connect.focus();
  await page.keyboard.press('Tab');
  await expect(other).toBeFocused();
  await expect(other).toHaveCSS('outline-style', 'solid');

  const quickApps = [
    { name: 'Notion', colorScheme: 'light', button: connect },
    { name: 'Heptabase', colorScheme: 'dark', button: other },
  ] as const;
  const backgrounds: string[] = [];
  for (const { name, colorScheme, button } of quickApps) {
    await page.emulateMedia({ colorScheme });
    const app = page.getByRole('listitem', { name, exact: true });
    const title = button.getByText(name, { exact: true });
    await expect(button).toHaveAccessibleDescription(await button.locator('.app-row-copy .small').innerText());
    await expect(app.getByRole('button')).toHaveCount(1);
    await app.scrollIntoViewIfNeeded();
    const box = (await app.boundingBox())!;
    // The padding above the copy and Connect label is part of the same button as the title.
    const padding = { x: Math.round(box.width / 2), y: 3 };
    await app.hover({ position: padding });
    expect(await button.evaluate((el) => el.matches(':hover'))).toBe(true);
    const background = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).not.toBe('rgba(0, 0, 0, 0)');
    backgrounds.push(background);

    const [tab] = await Promise.all([page.waitForEvent('popup'), name === 'Notion' ? title.click() : app.click({ position: padding })]);
    await expect(tab).toHaveURL(authorizeUrl);
    await tab.close();
    await expect(button).toBeDisabled();
    const waiting = app.getByRole('status');
    const address = waiting.getByRole('textbox');
    await address.click();
    await address.fill('A pasted address');
    await expect(address).toBeFocused();
    const [reopened] = await Promise.all([page.context().waitForEvent('page'), waiting.getByRole('link').click()]);
    await expect(reopened).toHaveURL(authorizeUrl);
    await reopened.close();
    await waiting.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(button).toBeEnabled();
    await expect(waiting).toHaveCount(0);
  }
  expect(new Set(backgrounds).size).toBe(2);
  expect(started).toEqual(['notion', 'heptabase']);
  expect(cancelled).toBe(2);
  for (const stayInRow of [true, false]) {
    const [tab] = await Promise.all([page.waitForEvent('popup'), connect.press(stayInRow ? 'Enter' : 'Space')]);
    await expect(tab).toHaveURL(authorizeUrl);
    await tab.close();
    const cancel = row.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeVisible();
    await (stayInRow ? cancel : other).focus();
    connected = true;
    await expect(row.getByRole('status')).toHaveText('Signed in to Notion.');
    await expect(row.locator('summary')).toBeVisible();
    await expect(stayInRow ? row.locator('summary') : other).toBeFocused();
    page.once('dialog', (dialog) => void dialog.accept());
    await row.getByRole('button', { name: 'Sign out', exact: true }).press('Enter');
    await expect(row.getByRole('status')).toHaveText('Signed out of Notion.');
    await expect(connect).toBeFocused();
  }
});

base("Slack opens Claude's official connector and leaves Relay's shared tools and members alone", async ({ page, relay }) => {
  const directory = 'https://claude.ai/directory/597f662f-36de-437e-836e-5a81013cbfbe';
  const library = () => relay.api<{ mcpServers: unknown[] }>('/api/tools');
  const before = await library();
  const writes: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && /^\/api\/(?:apps\/slack|tools|conversations|settings|oauth)(?:\/|$)/.test(pathname))
      writes.push(pathname);
  });
  // Exercise the external link offline; opening a page alone cannot attest to a Slack grant.
  await page
    .context()
    .route(directory, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Claude connector</title>' }));
  await page.goto(`${relay.base}/#/settings/apps`);
  const slack = page.getByRole('listitem', { name: 'Slack', exact: true });
  await slack.locator('.app-options > summary').click();
  const connect = slack.getByRole('link', { name: 'Connect Slack in Claude' });
  await expect(connect).toHaveAttribute('href', directory);
  const [tab] = await Promise.all([page.context().waitForEvent('page'), connect.click()]);
  await expect(tab).toHaveURL(directory);
  await tab.close();
  await expect(slack.locator('.app-options > summary')).not.toContainText(/connected|signed in|sending enabled/i);
  await expect(slack.getByRole('status')).toHaveCount(0);
  await expect(slack.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/settings\/apps$/);
  expect((await library()).mcpServers).toEqual(before.mcpServers);
  expect(writes).toEqual([]);
});

const legacySlack = base.extend({
  serverEnv: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-slack-'));
    try {
      const db = openDatabase(join(dir, 'relay.db'));
      try {
        saveLegacySlackGrant(new ToolLibrary(db));
      } finally {
        db.close();
      }
      await use({ RELAY_DATA_DIR: dir });
    } finally {
      removeTree(dir, { restore: true });
    }
  },
});

legacySlack('a saved Slack grant can reauthorize and sign out without enabling a new shared Slack sign-in', async ({ page, relay }) => {
  await page.goto(`${relay.base}/#/settings/apps`);
  const slack = page.getByRole('listitem', { name: 'Slack', exact: true });
  await slack.locator('.app-options > summary').click();
  await expect(slack).toContainText('Existing tool library connection · slack-work');
  await slack.getByRole('button', { name: 'Sign in again' }).click();
  await expect(slack.getByRole('alert')).toContainText('slack.com');
  await slack.getByRole('button', { name: 'Cancel', exact: true }).click();
  page.once('dialog', (d) => void d.accept());
  await slack.getByRole('button', { name: 'Sign out' }).click();
  await expect(slack).toContainText('Signed out of Slack.');
  await expect(slack.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
  await page.goto(`${relay.base}/#/settings/tools`);
  await openToolCategory(page, 'MCP servers');
  const row = page.locator('#settings-tools .lib-row', { hasText: 'slack-work' });
  await expect(row.getByRole('link', { name: 'Set up Slack in Common apps' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
});

test("a library MCP server signs in in a new tab, comes back to the web app's callback page, and a member's turn gets its token in the server's headers", async ({
  page,
  relay,
  auth,
}) => {
  await relay.api('/api/tools/mcp/linear', {
    method: 'PUT',
    body: { transport: 'http', url: `${auth.url}/mcp`, headers: [], providers: ['claude'] },
  });
  await page.goto(`${relay.base}/#/settings/tools`);
  await openToolCategory(page, 'MCP servers');
  const row = page.locator('#settings-tools .lib-row', { hasText: 'linear' });
  await expect(row).toContainText(`${auth.url}/mcp`);

  // Sign in: discovery and a registration, then the authorization server's page in a new tab.
  const [tab] = await Promise.all([page.waitForEvent('popup'), row.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  await expect(row.getByRole('status')).toContainText("Waiting for linear's sign-in page");
  expect(auth.clients).toEqual([{ id: 'client-1', redirects: [`${relay.base}/oauth/callback`] }]);
  await tab.getByRole('link', { name: 'Allow' }).click();
  await expect(tab.getByRole('status')).toHaveText('Signed in to the MCP server linear.');
  expect(new URL(tab.url()).search).toBe('');
  await tab.close();
  await expect(row).toContainText('Signed in to linear.');
  await expect(row.locator('.badge')).toHaveText('Signed in');
  await expect(row).toContainText('Signed in on ');
  expect(auth.resources).toEqual([`${auth.url}/mcp`]);

  // A member's turn: the server with an access token in its Authorization header (renewed for the turn).
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Linear');
  await send(page, 'What is on my board?');
  await finishedReply(page, 'Claude');
  const given = await logged(relay, (e) => e.cli === 'claude' && e.mcpEnv?.linear);
  expect(given.at(-1)!.mcpEnv!.linear!.Authorization).toBe(`Bearer ${auth.access.at(-1)}`);
  expect(auth.resources.every((r) => r === `${auth.url}/mcp`)).toBe(true);

  // Revoked at the authorization server: the next turn goes without it, and the reply says so (its token,
  // good for a second, has less than half of it left by then: renewed, and refused).
  auth.refuseRefresh = true;
  await page.waitForTimeout(1_000);
  const before = relay.fakeLog().filter((e) => e.cli === 'claude' && e.mcpEnv?.linear).length;
  await send(page, 'And now?');
  const reply = await finishedReply(page, 'Claude');
  await expect(reply.getByRole('note')).toHaveText(
    'The MCP server "linear" was left out of this turn: its sign-in no longer works (invalid_grant). Sign in to it again in Settings → Apps and tools → Tool library → MCP servers.',
  );
  expect(relay.fakeLog().filter((e) => e.cli === 'claude' && e.mcpEnv?.linear)).toHaveLength(before);

  // Reauthorize the custom MCP server against its existing client and revoke both replaced tokens.
  await page.goto(`${relay.base}/#/settings/tools`);
  await openToolCategory(page, 'MCP servers');
  await expect(row.locator('.badge')).toHaveText('Needs a new sign-in');
  await expect(row).toContainText('Its sign-in no longer works (invalid_grant)');
  auth.refuseRefresh = false;
  const [again] = await Promise.all([page.waitForEvent('popup'), row.getByRole('button', { name: 'Sign in again' }).click()]);
  await again.getByRole('link', { name: 'Allow' }).click();
  await expect(again.getByRole('status')).toHaveText('Signed in to the MCP server linear.');
  await again.close();
  await expect(row.locator('.badge')).toHaveText('Signed in');
  expect(auth.clients).toHaveLength(1);
  await expect.poll(() => auth.revoked.length).toBe(1);
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Sign out' }).click();
  await expect(row.locator('.badge')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(auth.revoked).toHaveLength(2);
});

test('a library MCP server whose sign-in page is on another host says where first, and opens it only on Continue', async ({
  page,
  relay,
  auth,
}) => {
  auth.pageElsewhere = true;
  await relay.api('/api/tools/mcp/linear', {
    method: 'PUT',
    body: { transport: 'http', url: `${auth.url}/mcp`, headers: [], providers: ['claude'] },
  });
  await page.goto(`${relay.base}/#/settings/tools`);
  await openToolCategory(page, 'MCP servers');
  const row = page.locator('#settings-tools .lib-row', { hasText: 'linear' });
  const pageHost = new URL(auth.pageUrl).host;
  const issuerHost = new URL(auth.url).host;

  // Sign in: where the page is, and no page yet (the tab opened on the click closes again).
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  const ask = row.getByRole('alert');
  await expect(ask).toContainText(`You will sign in at ${pageHost}, which is not ${issuerHost}.`);
  await expect(row.getByRole('status')).toHaveCount(0);
  // Cancel: nothing opens, and Sign in is offered again.
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(row.locator('.badge')).toHaveCount(0);

  // Continue: the page opens in a new tab, at the host it named, and signs in.
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(ask).toContainText(pageHost);
  const [tab] = await Promise.all([page.waitForEvent('popup'), ask.getByRole('button', { name: 'Continue' }).click()]);
  await tab.getByRole('link', { name: 'Allow' }).click();
  await expect(tab.getByRole('status')).toHaveText('Signed in to the MCP server linear.');
  await tab.close();
  await expect(row.locator('.badge')).toHaveText('Signed in');
  // A client is kept once a sign-in works: the cancelled one's was registered apart.
  expect(auth.clients).toHaveLength(2);
});
