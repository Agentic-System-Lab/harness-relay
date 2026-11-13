import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { memberSessionId } from '../../src/server/agentsview';
import type { Conversation, Provider, SettingsView } from '../../src/shared/types';
import { expect, test as base } from '../fixtures';
import { acceptNextDialog, composer, finishedReply, openTeamChat, replies, send, settled, type Member } from '../support/app';
import { chatOf, defaultHome, eachHalf, logged, needsFake, sessionFile, teamOf, withClis } from '../support/clis';
import { ROOT } from '../support/paths';
import type { RelayServer } from '../support/relay';

/*
 * Settings → Agent sessions. The fakes keep their sessions in their homes (`e2e-sessions/`; an open
 * agent's in its state folder there, `private/<key>/…`), so where a session lands tells which home
 * the CLI ran in (`sessionFile()` finds it). AgentsView is a server the user runs, which Harness
 * Relay only sends requests to: a small HTTP server in the test stands in for it.
 */

/** A request the fake AgentsView got. */
interface Hit {
  method: string;
  /** Decoded: `/api/v1/sessions/codex:<id>/parent`. */
  path: string;
  query: URLSearchParams;
  origin?: string;
  body: string;
}

interface FakeAgentsView {
  url: string;
  hits: Hit[];
  /** Answer uploads with an error, as an AgentsView that cannot take them. */
  failUploads: boolean;
}

const test = base.extend<{ agentsView: FakeAgentsView }>({
  agentsView: async ({}, use) => {
    const view: FakeAgentsView = { url: '', hits: [], failUploads: false };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://agentsview');
        const hit: Hit = { method: req.method ?? '', path: decodeURIComponent(u.pathname), query: u.searchParams, origin: req.headers.origin, body: Buffer.concat(chunks).toString('utf8') };
        view.hits.push(hit);
        const [status, body] = answer(view, hit);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    view.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await use(view);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});

/** AgentsView's API as Harness Relay uses it (`src/server/agentsview.ts`): it knows Codex's sessions, not Claude Code's. */
function answer(view: FakeAgentsView, hit: Hit): [number, unknown] {
  const session = /^\/api\/v1\/sessions\/([^/]+)$/.exec(hit.path);
  if (hit.method === 'GET' && session) {
    return session[1]!.startsWith('codex:') ? [200, { id: session[1], project: 'e2e-project', machine: 'e2e-machine' }] : [404, { error: 'session not found' }];
  }
  if (hit.method === 'POST' && hit.path === '/api/v1/sessions/upload') return view.failUploads ? [503, { error: 'e2e: AgentsView is down' }] : [200, { ok: true }];
  if (hit.method === 'PUT' && /^\/api\/v1\/sessions\/[^/]+\/parent$/.test(hit.path)) return [200, { ok: true }];
  return [404, { error: `no route ${hit.method} ${hit.path}` }];
}

/** The JSON records of an upload's transcript (the lines of its multipart body that are JSON). */
function records(hit: Hit): Record<string, any>[] {
  return hit.body.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try {
      return [JSON.parse(line) as Record<string, any>];
    } catch {
      return [];
    }
  });
}

/** The members AgentsView's tests ask: Claude Code, whose sessions it does not know, and Codex, whose it does. */
const VIEWED: Member[] = [
  { name: 'Claude', provider: 'claude' },
  { name: 'Codex', provider: 'codex' },
];

/** The Agent sessions card's parts: the CLIs' own folder, and AgentsView. */
async function sessionsCard(page: Page, relay: RelayServer): Promise<{ home: Locator; view: Locator }> {
  await page.goto(`${relay.base}/#/settings/sessions`);
  const card = page.locator('#settings-sessions');
  await expect(card.getByRole('heading', { name: 'Agent sessions' })).toBeVisible();
  return {
    home: card.locator('.settings-part', { has: page.getByRole('heading', { name: "The CLIs' own folder" }) }),
    view: card.locator('.settings-part', { has: page.getByRole('heading', { name: 'AgentsView', exact: true }) }),
  };
}

/** The sessions a CLI started, in order (from the fakes' log). */
const startedSessions = (relay: RelayServer, cli: Provider) =>
  relay.fakeLog().filter((e) => e.cli === cli && e.session && e.resumed === false).map((e) => e.session!);

/** The sessions each of `providers` started, once each has started `count` (a fake in Harness Relay's own sandbox logs them a moment later). */
async function sessionsOf(relay: RelayServer, providers: Provider[], count: number): Promise<Map<Provider, string[]>> {
  for (const p of providers) await expect.poll(() => startedSessions(relay, p).length, { message: `${p}'s sessions` }).toBeGreaterThanOrEqual(count);
  return new Map(providers.map((p) => [p, startedSessions(relay, p)]));
}

test.describe("the CLIs' own folder", () => {
  // Each with a team of the CLIs with a sign-in, and of the open agents (`open agents: …`).
  eachHalf((half) => {
    test(half.title('the folder chosen in Settings is where each CLI keeps its sessions'), async ({ page, relay }) => {
      const TEAM = teamOf(half.clis);
      const { home } = await sessionsCard(page, relay);
      await home.getByRole('button', { name: 'Use ~/.relay-agents' }).click();
      const dir = join(relay.home, '.relay-agents');
      await expect(home).toContainText(`The CLIs now use the folders in ${dir}. Sign in to them again above.`);
      await expect(home.getByPlaceholder('~/.relay-agents')).toHaveValue(dir);
      expect((await relay.api<SettingsView>('/api/settings')).agentHome).toBe(dir);
      // Made for the CLIs' sign-ins: readable by its owner only.
      if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);

      const id = await chatOf(page, relay, TEAM.map((cli) => ({ cli })));
      await send(page, 'Where do you keep this?');
      for (const m of TEAM) await finishedReply(page, m.name);
      await settled(relay, id);
      const started = await sessionsOf(relay, TEAM.map((m) => m.provider), 1);
      for (const m of TEAM) {
        const [session, ...more] = started.get(m.provider)!;
        expect(more).toEqual([]);
        // In the CLI's folder of the one chosen, and nothing in its usual home.
        expect(sessionFile(join(dir, m.provider), session!), `${m.provider}'s session`).toBeDefined();
        expect(sessionFile(defaultHome(relay, m.provider), session!), `${m.provider}'s session`).toBeUndefined();
      }
    });

    test(half.title('after the folder changes, each member starts a fresh session there with the chat so far'), async ({ page, relay }) => {
      const TEAM = teamOf(half.clis);
      const id = await chatOf(page, relay, TEAM.map((cli) => ({ cli })));
      await send(page, 'Remember this');
      for (const m of TEAM) await finishedReply(page, m.name);
      await settled(relay, id);

      const { home } = await sessionsCard(page, relay);
      const dir = join(relay.root, 'agent-homes');
      await home.getByPlaceholder('~/.relay-agents').fill(dir);
      await home.getByRole('button', { name: 'Save' }).click();
      await expect(home).toContainText(`The CLIs now use the folders in ${dir}.`);

      await page.goto(`${relay.base}/#/c/${id}`);
      await expect(composer(page)).toBeVisible();
      await send(page, 'And this');
      for (const m of TEAM) {
        await expect(replies(page, m.name)).toHaveCount(2);
        await expect(await finishedReply(page, m.name)).toContainText('You said: “And this”.');
      }
      await settled(relay, id);
      const started = await sessionsOf(relay, TEAM.map((m) => m.provider), 2);
      for (const m of TEAM) {
        // Its session could not be resumed from the new home: a new one, given the whole chat.
        const last = (await logged(relay, (e) => e.cli === m.provider && e.prompt?.includes('And this'))).pop()!;
        expect(last.prompt).toContain('Here is the group chat so far:');
        expect(last.prompt).toContain('Remember this');
        const [before, after, ...more] = started.get(m.provider)!;
        expect(more).toEqual([]);
        // The earlier one stays where it was.
        expect(sessionFile(defaultHome(relay, m.provider), before!), `${m.provider}'s first session`).toBeDefined();
        expect(sessionFile(join(dir, m.provider), after!), `${m.provider}'s second session`).toBeDefined();
      }
    });
  });

  test("a folder inside Harness Relay's own folder or the default working directory is refused", async ({ page, relay }) => {
    const { home } = await sessionsCard(page, relay);
    const box = home.getByPlaceholder('~/.relay-agents');
    const why = "its snapshots would take in the CLIs' sign-ins and session records. Pick a place outside it, such as ~/.relay-agents";

    const inRelay = join(ROOT, `.e2e-agent-home-${randomUUID().slice(0, 8)}`);
    try {
      await box.fill(inRelay);
      await home.getByRole('button', { name: 'Save' }).click();
      await expect(home.locator('.error-line')).toContainText(`${inRelay} is inside `);
      await expect(home.locator('.error-line')).toContainText(why);

      const inWork = join(relay.workDir, '.agent-homes');
      await box.fill(inWork);
      await home.getByRole('button', { name: 'Save' }).click();
      await expect(home.locator('.error-line')).toContainText(`${inWork} is inside ${relay.workDir}: ${why}`);

      // Nothing was made, and the CLIs keep their usual homes.
      expect(existsSync(inRelay)).toBe(false);
      expect(existsSync(inWork)).toBe(false);
      expect((await relay.api<SettingsView>('/api/settings')).agentHome).toBe('');
    } finally {
      // Should the refusal ever break, the folder would be in this checkout.
      rmSync(inRelay, { recursive: true, force: true });
    }
  });

  test('the folder cannot change while a conversation runs', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Take your time e2e:slow');
    await expect(replies(page, 'Claude').last().locator('.live-tag')).toBeVisible();

    const { home } = await sessionsCard(page, relay);
    const dir = join(relay.root, 'agent-homes');
    await home.getByPlaceholder('~/.relay-agents').fill(dir);
    await home.getByRole('button', { name: 'Save' }).click();
    await expect(home.locator('.error-line')).toContainText("A conversation is running, or the lead agent is sorting one into a group or changing a team.");
    expect(existsSync(dir)).toBe(false);

    await relay.api(`/api/conversations/${id}/stop`, { body: {} });
    await settled(relay, id);
    await home.getByRole('button', { name: 'Save' }).click();
    await expect(home).toContainText(`The CLIs now use the folders in ${dir}.`);
    expect(existsSync(dir)).toBe(true);
  });
});

test.describe('AgentsView', () => {
  test("a conversation is sent after each turn and when it is renamed, with its members' sessions under it", async ({ page, relay, agentsView }) => {
    const { view } = await sessionsCard(page, relay);
    await view.getByPlaceholder('http://127.0.0.1:8080').fill(agentsView.url);
    await view.getByRole('button', { name: 'Save' }).click();
    await expect(view).toContainText('AgentsView is set; it is updated after every turn');
    await expect(view.getByRole('link', { name: 'Open AgentsView ↗' })).toHaveAttribute('href', agentsView.url);

    const team = VIEWED;
    const id = await openTeamChat(page, relay, team, {}, 'Pelican report');
    await send(page, 'Count the pelicans');
    for (const m of team) await finishedReply(page, m.name);
    await settled(relay, id);

    // The upload after the last turn holds the whole conversation.
    const uploads = () => agentsView.hits.filter((h) => h.method === 'POST' && h.path === '/api/v1/sessions/upload');
    await expect.poll(() => uploads().some((h) => h.body.includes('**Codex** · codex'))).toBe(true);
    const upload = uploads().find((h) => h.body.includes('**Codex** · codex'))!;
    // AgentsView's own origin (it refuses writes without it), in the project of the first session it knows.
    expect(upload.origin).toBe(agentsView.url);
    expect(Object.fromEntries(upload.query)).toEqual({ project: 'e2e-project', machine: 'e2e-machine', allow_shorter: 'true' });
    expect(upload.body).toContain(`filename="${id}.jsonl"`);
    const thread = records(upload);
    expect(thread.every((r) => r.sessionId === id)).toBe(true);
    expect(thread.map((r) => r.type)).toEqual(['user', 'assistant', 'assistant', 'custom-title']);
    expect(thread[0]!.message.content).toBe('Count the pelicans');
    expect(thread[1]!.message.content[0].text).toMatch(/^\*\*Claude\*\* · claude\n\nHello from Claude \(Claude Code\)\. You said: “Count the pelicans”\./);
    expect(thread[3]!.customTitle).toBe('Pelican report');

    // Each member's session is filed under it (after the upload): Claude Code's by its id, Codex's with its prefix.
    const members = [startedSessions(relay, 'claude')[0]!, `codex:${startedSessions(relay, 'codex')[0]!}`];
    for (const session of members) {
      const link = () => agentsView.hits.find((h) => h.method === 'PUT' && h.path === `/api/v1/sessions/${session}/parent`);
      await expect.poll(() => Boolean(link()), { message: session }).toBe(true);
      expect(JSON.parse(link()!.body)).toEqual({ parent_session_id: id });
      expect(link()!.origin).toBe(agentsView.url);
    }

    acceptNextDialog(page, 'Pelican census');
    await page.locator('.chat-title').click();
    await expect(page.locator('.chat-title')).toHaveText('Pelican census');
    await expect.poll(() => uploads().some((h) => records(h).some((r) => r.customTitle === 'Pelican census'))).toBe(true);
    expect((await relay.api<SettingsView>('/api/settings')).agentsViewError).toBeUndefined();
  });

  test.describe(() => {
    withClis('cursor');

    test("a Cursor member's session is the one Harness Relay recorded, sent after the thread and filed under it", async ({ page, relay, agentsView }) => {
      needsFake('cursor');
      const { view } = await sessionsCard(page, relay);
      await view.getByPlaceholder('http://127.0.0.1:8080').fill(agentsView.url);
      await view.getByRole('button', { name: 'Save' }).click();
      await expect(view).toContainText('AgentsView is set; it is updated after every turn');

      const team: Member[] = [VIEWED[1]!, { name: 'Cursor', provider: 'cursor' }];
      const id = await openTeamChat(page, relay, team, {}, 'Pelican report');
      await send(page, 'Count the pelicans e2e:think e2e:tool');
      for (const m of team) await finishedReply(page, m.name);
      await settled(relay, id);

      const conv = await relay.api<Conversation>(`/api/conversations/${id}`);
      const cursor = conv.agents.find((a) => a.provider === 'cursor')!;
      const session = memberSessionId(id, cursor.id);
      const uploads = () => agentsView.hits.filter((h) => h.method === 'POST' && h.path === '/api/v1/sessions/upload');
      const recorded = () => uploads().filter((h) => h.body.includes(`filename="${session}.jsonl"`));
      await expect.poll(() => recorded().some((h) => records(h).some((r) => r.type === 'custom-title'))).toBe(true);
      // In the thread's place, after it.
      const upload = recorded().at(-1)!;
      expect(Object.fromEntries(upload.query)).toEqual({ project: 'e2e-project', machine: 'e2e-machine', allow_shorter: 'true' });
      expect(agentsView.hits.indexOf(upload)).toBeGreaterThan(agentsView.hits.findIndex((h) => h.method === 'POST' && h.body.includes(`filename="${id}.jsonl"`)));

      const r = records(upload);
      expect(r.every((x) => !x.sessionId || x.sessionId === session)).toBe(true);
      // What it heard, then its thinking and its call (listing the folder: Claude Code's Read, with the folder), the call's result, its reply.
      expect(r[0]!).toMatchObject({ type: 'user', message: { content: expect.stringContaining('Count the pelicans') } });
      const calls = r.filter((x) => x.type === 'assistant').flatMap((x) => x.message.content);
      expect(calls.some((b: { type: string }) => b.type === 'thinking')).toBe(true);
      const read = calls.find((b: { type: string }) => b.type === 'tool_use');
      expect(read).toMatchObject({ name: 'Read', input: { file_path: expect.any(String) } });
      const result = r.find((x) => x.type === 'user' && Array.isArray(x.message.content))!.message.content[0];
      expect(result).toMatchObject({ type: 'tool_result', tool_use_id: read.id });
      expect(calls.some((b: { type: string; text?: string }) => b.type === 'text' && b.text?.includes('Hello from Cursor'))).toBe(true);
      expect(r.at(-1)).toEqual({ type: 'custom-title', customTitle: 'Cursor · Cursor — Pelican report', sessionId: session });

      // Linked under the thread; Cursor's own session id is never sent.
      const link = () => agentsView.hits.find((h) => h.method === 'PUT' && h.path === `/api/v1/sessions/${session}/parent`);
      await expect.poll(() => Boolean(link())).toBe(true);
      expect(JSON.parse(link()!.body)).toEqual({ parent_session_id: id });
      const cursorSession = startedSessions(relay, 'cursor')[0]!;
      expect(agentsView.hits.some((h) => h.path.includes(cursorSession))).toBe(false);
    });
  });

  test.describe(() => {
    withClis('copilot', 'muse');

    test("Copilot's and Muse Code's own sessions are filed under the thread as AgentsView names them, with none recorded for them", async ({ page, relay, agentsView }) => {
      needsFake('copilot');
      needsFake('muse');
      const { view } = await sessionsCard(page, relay);
      await view.getByPlaceholder('http://127.0.0.1:8080').fill(agentsView.url);
      await view.getByRole('button', { name: 'Save' }).click();
      await expect(view).toContainText('AgentsView is set; it is updated after every turn');

      const team: Member[] = [
        { name: 'Copilot', provider: 'copilot' },
        { name: 'Muse', provider: 'muse' },
      ];
      const id = await openTeamChat(page, relay, team, {}, 'Pelican report');
      await send(page, 'Count the pelicans');
      for (const m of team) await finishedReply(page, m.name);
      await settled(relay, id);

      // Each member's own session, by the id its CLI gave it after AgentsView's prefix for that CLI
      // (its Copilot and Muse Code read `session-state/<id>/` and `muse/sessions/…/<id>/`): asked where
      // it is for the thread's place, then linked under the thread.
      const own = [`copilot:${startedSessions(relay, 'copilot')[0]!}`, `muse:${startedSessions(relay, 'muse')[0]!}`];
      for (const session of own) {
        const link = () => agentsView.hits.find((h) => h.method === 'PUT' && h.path === `/api/v1/sessions/${session}/parent`);
        await expect.poll(() => Boolean(link()), { message: session }).toBe(true);
        expect(JSON.parse(link()!.body)).toEqual({ parent_session_id: id });
        expect(link()!.origin).toBe(agentsView.url);
        expect(agentsView.hits.some((h) => h.method === 'GET' && h.path === `/api/v1/sessions/${session}`)).toBe(true);
      }

      // AgentsView reads these sessions itself: only the thread is uploaded, and no member's recorded session.
      const uploads = () => agentsView.hits.filter((h) => h.method === 'POST' && h.path === '/api/v1/sessions/upload');
      // Whichever member replied last, the newest upload holds the question, both replies and the title.
      const newest = () => {
        const last = uploads().at(-1);
        return last ? records(last).map((r) => r.type) : [];
      };
      await expect.poll(newest).toEqual(['user', 'assistant', 'assistant', 'custom-title']);
      for (const upload of uploads()) expect(upload.body).toContain(`filename="${id}.jsonl"`);
      const conv = await relay.api<Conversation>(`/api/conversations/${id}`);
      for (const a of conv.agents) {
        const recorded = memberSessionId(id, a.id);
        expect(agentsView.hits.some((h) => h.path.includes(recorded) || h.body.includes(recorded)), a.name).toBe(false);
      }
    });
  });

  test('an address elsewhere is refused, and when an update fails Settings says why while the chat goes on', async ({ page, relay, agentsView }) => {
    const { view } = await sessionsCard(page, relay);
    const box = view.getByPlaceholder('http://127.0.0.1:8080');
    // Only this computer: conversations are sent there.
    await box.fill('http://192.0.2.1:9999');
    await view.getByRole('button', { name: 'Save' }).click();
    await expect(view.locator('.error-line')).toContainText(
      'Invalid AgentsView address: http://192.0.2.1:9999. Only http(s) addresses on this computer are accepted, such as http://127.0.0.1:8080',
    );
    expect((await relay.api<SettingsView>('/api/settings')).agentsViewUrl).toBe('');

    agentsView.failUploads = true;
    await box.fill(agentsView.url);
    await view.getByRole('button', { name: 'Save' }).click();
    await expect(view).toContainText('AgentsView is set; it is updated after every turn');

    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Anyone there?');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “Anyone there?”.');
    await settled(relay, id);
    await expect(page.locator('.msg-error')).toHaveCount(0);
    await expect.poll(async () => (await relay.api<SettingsView>('/api/settings')).agentsViewError).toBe('POST /api/v1/sessions/upload: HTTP 503 e2e: AgentsView is down');

    const again = await sessionsCard(page, relay);
    await expect(again.view).toContainText('The last update of AgentsView failed: POST /api/v1/sessions/upload: HTTP 503 e2e: AgentsView is down');
  });
});
