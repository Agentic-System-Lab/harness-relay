import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test as base } from '../fixtures';
import { finishedReply, openTeamChat, send } from '../support/app';
import { logged } from '../support/clis';

/*
 * A tool library MCP server's own sign-in (MCP's authorization), against a stand-in MCP server and its
 * authorization server on this computer: the server answers 401 and names its protected resource
 * metadata, which names the authorization server; Settings → Tool library's Sign in registers Harness
 * Relay there and opens its page in a new tab, whose Allow sends the browser back to the web app's
 * /oauth/callback; the server then says it is signed in, and a fake Claude Code's turn gets its access
 * token in the server's Authorization header. Revoked at the authorization server, the next turn goes
 * without the server and the reply says so; Settings says it needs a new sign-in, Sign in again mends it,
 * and Sign out deletes and revokes its tokens.
 */

interface FakeAuth {
  url: string;
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
async function fakeAuth(): Promise<{ fake: FakeAuth; server: Server }> {
  const codes = new Map<string, { challenge: string; redirect: string; resource: string }>();
  const good = new Set<string>();
  const refresh = new Set<string>();
  const fake: FakeAuth = { url: '', clients: [], access: [], resources: [], refuseRefresh: false, revoked: [] };
  const tokens = () => {
    const access = `mcp-access-${randomUUID()}`;
    const next = `mcp-refresh-${randomUUID()}`;
    good.add(access);
    refresh.add(next);
    fake.access.push(access);
    // Ten minutes or less: each turn gets one renewed.
    return { access_token: access, refresh_token: next, token_type: 'Bearer', expires_in: 300 };
  };
  const server = createServer((req, res) => {
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
          authorization_endpoint: `${issuer}/authorize`,
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
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { fake, server };
}

const test = base.extend<{ auth: FakeAuth }>({
  auth: async ({}, use) => {
    const { fake, server } = await fakeAuth();
    await use(fake);
    await new Promise((r) => server.close(r));
  },
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

  // Revoked at the authorization server: the next turn goes without it, and the reply says so.
  auth.refuseRefresh = true;
  const before = relay.fakeLog().filter((e) => e.cli === 'claude' && e.mcpEnv?.linear).length;
  await send(page, 'And now?');
  const reply = await finishedReply(page, 'Claude');
  await expect(reply.getByRole('note')).toHaveText(
    'The MCP server "linear" was left out of this turn: its sign-in no longer works (invalid_grant). Sign in to it again in Settings → Tool library.',
  );
  expect(relay.fakeLog().filter((e) => e.cli === 'claude' && e.mcpEnv?.linear)).toHaveLength(before);

  // Settings says it needs a new sign-in; Sign in again mends it (the kept client: no new registration).
  auth.refuseRefresh = false;
  await page.goto(`${relay.base}/#/settings/tools`);
  await expect(row.locator('.badge')).toHaveText('Needs a new sign-in');
  await expect(row).toContainText('Its sign-in no longer works (invalid_grant)');
  const [again] = await Promise.all([page.waitForEvent('popup'), row.getByRole('button', { name: 'Sign in again' }).click()]);
  await again.getByRole('link', { name: 'Allow' }).click();
  await expect(again.getByRole('status')).toHaveText('Signed in to the MCP server linear.');
  await again.close();
  await expect(row.locator('.badge')).toHaveText('Signed in');
  expect(auth.clients).toHaveLength(1);

  // Sign out: its tokens deleted and revoked; Sign in is offered again.
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Sign out' }).click();
  await expect(row).toContainText('Signed out of linear.');
  await expect(row.locator('.badge')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(auth.revoked).toHaveLength(1);
});
