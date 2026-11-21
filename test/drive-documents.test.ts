import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, OAuthUse, Permission } from '../src/shared/types';
import { ConnectorStore } from '../src/server/connectors/accounts';
import { driveDocumentTools } from '../src/server/connectors/driveDocuments';
import { openDatabase } from '../src/server/db';
import { ToolGateway, type GatewayContext } from '../src/server/gateway';
import { t, withLang } from '../src/server/i18n';
import { googleProvider } from '../src/server/oauth/providers';
import { OAuthService } from '../src/server/oauth/service';
import { OAuthStore } from '../src/server/oauth/store';
import { Outbox } from '../src/server/outbox';
import { Store } from '../src/server/store';

const scope = 'https://www.googleapis.com/auth/documents',
  docs = 'http://127.0.0.1:9999/docs/v1',
  email = 'user@example.test';
const paragraph = (runs: string[]) => {
  let index = 1;
  return {
    startIndex: 1,
    endIndex: 1 + runs.join('').length,
    paragraph: {
      elements: runs.map((text) => {
        const startIndex = index;
        index += text.length;
        return { startIndex, endIndex: index, textRun: { content: text } };
      }),
    },
  };
};
const tab = (id: string, runs: string[], title = 'Tab') => ({
  tabProperties: { tabId: id, title },
  documentTab: { body: { content: [paragraph(runs)] } },
});
const document = (tabs: unknown[], revisionId = 'rev1') => ({ documentId: 'doc_1', title: 'Project', revisionId, tabs });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body?: Record<string, unknown>; retry?: boolean };

describe('direct Google Docs proposals', () => {
  let db: ReturnType<typeof openDatabase>, store: OAuthStore, oauth: OAuthService, gateway: ToolGateway, outbox: Outbox, id: string;
  let calls: Call[], handle: (c: Call) => Response | Promise<Response>, base: string;
  function signIn(uses: OAuthUse[] = ['drive', 'documents'], scopes = [scope], address = email) {
    return store.signedIn('google', { subject: 'sub-' + address, email: address }, uses, scopes, 'refresh', 1).id;
  }
  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new OAuthStore(db);
    new Store(db).create({
      id: 'c',
      title: 'Docs',
      createdAt: 0,
      updatedAt: 0,
      agents: [],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 1, permission: 'full', cwd: '/tmp', approvals: 'ask' },
      messages: [],
      agentState: {},
      worktrees: {},
    } as Conversation);
    store.saveClient('google', { clientId: 'desk', secret: 'fixture-secret' });
    id = signIn();
    base = docs;
    oauth = new OAuthService(store, new ConnectorStore(db), { provider: (_id, client) => ({ ...googleProvider(client), docsApi: base }) });
    calls = [];
    handle = () => {
      throw new Error('Unexpected external request');
    };
    vi.spyOn(oauth.broker, 'fetch').mockImplementation((account, use, opts) => async (url, init = {}) => {
      expect(account).toBe(id);
      expect(use).toBe('documents');
      const c = {
        url,
        method: init.method ?? 'GET',
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
        retry: opts?.retryUnauthorized,
      };
      calls.push(c);
      return handle(c);
    });
    gateway = new ToolGateway('/tmp', '/tmp', () => process.execPath);
    gateway.register(driveDocumentTools(oauth));
    outbox = new Outbox(db);
  });
  afterEach(() => db.close());
  const propose = (kind: 'edit' | 'create', input: Record<string, unknown>, permission: Permission = 'full') =>
    withLang('en', () =>
      gateway.call(gateway.tool('drive_' + kind + '_document')!, input, {
        convId: 'c',
        messageId: 'm',
        agentId: 'a',
        agentName: 'Ana',
        permission,
        cwd: '/tmp',
        unattended: true,
        signal: new AbortController().signal,
        toOutbox: ({ args, ...item }) => outbox.add({ ...item, convId: 'c', messageId: 'm', agentId: 'a', agentName: 'Ana' }, args).item,
      } satisfies GatewayContext),
    );
  const answer = (id: string, action: 'send' | 'discard' = 'send') =>
    withLang('en', () => outbox.answer('c', id, action, (name) => gateway.tool(name)));
  const preview = { title: 'Project', content: 'Hello 🍵\n' };
  const edit = { id: 'doc_1', before: 'target', after: 'reviewed' };
  const blank = document([tab('t.0', ['\n'])]);
  const done = (n: number) =>
    json({ documentId: 'doc_1', replies: Array.from({ length: n }, () => ({})), writeControl: { requiredRevisionId: 'rev2' } });

  it('queues creation without external writes, deduplicates previews and confirms exactly once with a revision-pinned native insert', async () => {
    for (const permission of ['full', 'read-only', 'edit'] as const)
      expect((await propose('create', preview, permission)).text).toContain('No Google document has been written');
    expect(calls).toEqual([]);
    expect(outbox.waiting('c')).toBe(1);
    outbox = new Outbox(db);
    const item = outbox.list('c')[0];
    expect(item.preview.document).toEqual({ account: email, title: 'Project', before: null, after: preview.content });
    handle = (c) => {
      if (c.method === 'GET') return json(blank);
      if (c.url.endsWith('/documents')) {
        expect(c.body).toEqual({ title: 'Project' });
        return json({ documentId: 'doc_1', title: 'Project', revisionId: 'rev1' });
      }
      expect(c.body).toEqual({
        writeControl: { requiredRevisionId: 'rev1' },
        requests: [{ insertText: { location: { index: 1, tabId: 't.0' }, text: preview.content } }],
      });
      expect(outbox.get(item.id)?.result).toContain('https://docs.google.com/document/d/doc_1/edit');
      return done(1);
    };
    const saved = await answer(item.id);
    expect(saved.status).toBe('sent');
    expect(saved.result?.split('\n')).toContain('https://docs.google.com/document/d/doc_1/edit');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.retry)).toEqual([false, false]);
    await expect(answer(item.id)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(3);
    await propose('create', { ...preview, title: 'Discard me' });
    expect((await answer(outbox.list('c').at(-1)!.id, 'discard')).status).toBe('discarded');
    expect(calls).toHaveLength(3);
  });

  it.each(['current', 'legacy'] as const)('checks the original preview for %s drafts when a user confirms', async (format) => {
    for (const modified of [false, true]) {
      await propose('create', { title: 'Approval', content: '' });
      const item = outbox.list('c').find((x) => x.status === 'pending')!;
      if (format === 'legacy') {
        const row = db.prepare('SELECT args FROM outbox WHERE id = ?').get(item.id) as { args: string };
        const { document, ...args } = JSON.parse(row.args);
        args.digest = createHash('sha256').update(JSON.stringify(document)).digest('hex');
        db.prepare('UPDATE outbox SET args = ? WHERE id = ?').run(JSON.stringify(args), item.id);
      }
      await propose('create', { title: 'Approval', content: '' });
      expect(
        outbox
          .list('c')
          .filter((x) => x.status === 'pending')
          .map((x) => x.id),
      ).toEqual([item.id]);
      if (modified) {
        item.preview.document!.after = 'unreviewed';
        db.prepare('UPDATE outbox SET preview = ? WHERE id = ?').run(JSON.stringify(item.preview), item.id);
      }
      calls.length = 0;
      handle = () => json({ documentId: 'doc_1', title: 'Approval', revisionId: 'rev1' });
      expect((await answer(item.id)).status).toBe(modified ? 'failed' : 'sent');
      expect(calls).toHaveLength(modified ? 0 : 1);
    }
  });

  it('requires a complete documents scope entry in a valid scope list', async () => {
    for (const malformed of [scope, [scope + '.other'], ['prefix-' + scope]]) {
      Object.assign(store.account(id)!, { scopes: malformed });
      expect((await propose('create', preview)).isError).toBe(true);
      expect(outbox.waiting('c')).toBe(0);
    }
  });

  it('keeps UTF-16 ranges within the chosen nested tab and refuses another waiting edit after the first changes the revision', async () => {
    let version = 'rev1';
    const nested = tab('t.child', ['🍵 tar', 'get\n'], 'Child');
    handle = (c) => {
      if (c.method === 'GET') return json(document([{ ...tab('t.root', ['target\n']), childTabs: [nested] }], version));
      expect(c.body).toEqual({
        writeControl: { requiredRevisionId: 'rev1' },
        requests: [
          { deleteContentRange: { range: { startIndex: 4, endIndex: 10, tabId: 't.child' } } },
          { insertText: { location: { index: 4, tabId: 't.child' }, text: 'reviewed' } },
        ],
      });
      version = 'rev2';
      return done(2);
    };
    expect((await propose('edit', edit)).isError).toBe(true);
    for (const after of ['reviewed', 'other']) expect((await propose('edit', { ...edit, tabId: 't.child', after })).isError).toBeFalsy();
    expect(
      calls.every((c) => c.method === 'GET' && c.url.startsWith(docs + '/documents/doc_1?') && c.url.includes('includeTabsContent=true')),
    ).toBe(true);
    const [one, two] = outbox.list('c');
    expect(one.preview.document).toEqual({
      account: email,
      title: 'Project',
      id: 'doc_1',
      tab: 'Child (t.child)',
      tabId: 't.child',
      before: 'target',
      after: 'reviewed',
    });
    expect((await answer(one.id)).status).toBe('sent');
    expect((await answer(two.id)).status).toBe('failed');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('refuses ambiguous text, non-body or suggested matches, invalid resources and provider responses', async () => {
    const section = tab('t.0', ['target\n']);
    for (const data of [
      document([tab('t.0', ['target target\n'])]),
      document([{ ...section, documentTab: { ...section.documentTab, headers: { h: { content: [paragraph(['target\n'])] } } } }]),
      document([
        {
          ...section,
          documentTab: { body: { content: [{ table: { tableRows: [{ tableCells: [{ content: [paragraph(['target\n'])] }] }] } }] } },
        },
      ]),
      document([{ ...section, documentTab: { body: { content: [{ ...paragraph(['target\n']), suggestedInsertionIds: ['change'] }] } } }]),
      { ...document([section]), documentId: 'other' },
      { ...document([section]), revisionId: '' },
      document([{ ...section, documentTab: { body: { content: [{ ...paragraph(['target\n']), endIndex: 100 }] } } }]),
      { ...document([section]), suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS' },
    ]) {
      handle = () => json(data);
      expect((await propose('edit', edit)).isError).toBe(true);
    }
    const previous = calls.length;
    for (const bad of ['../other', 'https://unexpected.invalid/file', 'a?x', 'a\n'])
      expect((await propose('edit', { ...edit, id: bad })).isError).toBe(true);
    for (const bad of ['bad\r\n', '\ue000', '\udcff']) expect((await propose('create', { ...preview, content: bad })).isError).toBe(true);
    base = 'https://unexpected.invalid/v1';
    expect((await propose('create', preview)).isError).toBe(true);
    expect(calls).toHaveLength(previous);
    expect(outbox.waiting('c')).toBe(0);
  });

  it('uses one revision-guarded deletion and requests a new preview on a conflict at the write itself', async () => {
    handle = (c) => {
      if (c.method === 'GET') return json(document([tab('t.0', ['target\n'])]));
      expect(c.retry).toBe(false);
      expect(c.body).toEqual({
        writeControl: { requiredRevisionId: 'rev1' },
        requests: [{ deleteContentRange: { range: { tabId: 't.0', startIndex: 1, endIndex: 7 } } }],
      });
      return json({}, 400);
    };
    expect((await propose('edit', { ...edit, after: '' })).isError).toBeFalsy();
    const item = outbox.list('c')[0];
    expect(await answer(item.id)).toMatchObject({ status: 'failed', result: expect.stringContaining('fresh preview') });
    await expect(answer(item.id)).rejects.toMatchObject({ status: 409 });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('refuses splitting a grapheme or inserting inside a grapheme formed by deletion', async () => {
    for (const [source, before] of [
      ['e\u0301 changed\n', 'e'],
      ['🇦X🇧\n', 'X'],
      ['👩‍👩‍👧 then\n', '👧'],
    ]) {
      handle = () => json(document([tab('t.0', [source])]));
      expect((await propose('edit', { ...edit, before })).isError).toBe(true);
    }
    handle = () => json(document([tab('t.0', ['e\u0301 changed\n'])]));
    expect((await propose('edit', { ...edit, before: 'e\u0301' })).isError).toBeFalsy();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('keeps old previews from writing after removing and reconnecting the same Drive account', async () => {
    const draft = { title: 'Project', content: '' };
    await propose('create', draft);
    const [old] = outbox.list('c');
    await propose('create', { ...draft, title: 'Before unlink' });
    const whileDetached = outbox.list('c').find((i) => i.id !== old.id)!;
    oauth.removeDrive(id);
    expect((await propose('create', draft)).isError).toBe(true);
    expect((await answer(whileDetached.id)).status).toBe('failed');
    expect(signIn()).toBe(id);
    outbox = new Outbox(db);
    await propose('create', draft);
    expect(outbox.waiting('c')).toBe(2);
    expect((await answer(old.id)).status).toBe('failed');
    expect(calls).toEqual([]);
    handle = () => json({ documentId: 'doc_1', title: draft.title, revisionId: 'rev1' });
    const fresh = outbox.list('c').find((i) => i.status === 'pending')!;
    expect((await answer(fresh.id)).status).toBe('sent');
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('requires the reviewed account, its Google subject, current document permission, origin and OAuth project', async () => {
    signIn(['drive'], [], 'reader@example.test');
    expect((await propose('create', { ...preview, account: 'reader@example.test' })).isError).toBe(true);
    signIn(['drive', 'documents'], [scope], 'editor@example.test');
    expect((await propose('create', preview)).isError).toBe(true);
    const original = store.account(id)!;
    for (const reason of ['subject', 'scope', 'status', 'email', 'project', 'origin', 'disabled', 'incomplete']) {
      await propose('create', { ...preview, account: email });
      const item = outbox.list('c').at(-1)!;
      const saved = { ...original, scopes: [...original.scopes] };
      if (reason === 'subject') original.subject = 'new';
      if (reason === 'scope') original.scopes = [];
      if (reason === 'status') original.status = 'reauth';
      if (reason === 'email') original.email = 'different@example.test';
      if (reason === 'project') store.saveClient('google', { clientId: 'other', secret: 'other-secret' });
      if (reason === 'origin') base = docs + '/different';
      if (reason === 'disabled') oauth.setClientDisabled('google', true);
      if (reason === 'incomplete') oauth.saveClient('google', { clientId: 'desk', secret: '' });
      expect((await answer(item.id)).status).toBe('failed');
      Object.assign(original, saved);
      oauth.setClientDisabled('google', false);
      store.saveClient('google', { clientId: 'desk', secret: 'fixture-secret' });
      base = docs;
    }
    expect(calls).toEqual([]);
  });

  it.each([
    'no-id',
    'no-version',
    'wrong-title',
    'no-longer-blank',
    'lost-response',
    'unauthorized',
    'wrong-batch-id',
    'unchanged-batch-version',
  ])('reports a partial or uncertain creation without replaying it (%s)', async (failure) => {
    await propose('create', preview);
    const item = outbox.list('c')[0];
    handle = (c) => {
      if (c.url.endsWith('/documents'))
        return json({
          documentId: failure === 'no-id' ? '../../other' : 'doc_1',
          revisionId: failure === 'no-version' ? undefined : 'rev1',
          title: failure === 'wrong-title' ? 'Other' : 'Project',
        });
      if (c.method === 'GET') return json(failure === 'no-longer-blank' ? document([tab('t.0', ['changed\n'])]) : blank);
      if (failure === 'lost-response') throw new Error('transport broke after the server received the write');
      if (failure === 'unauthorized') return json({}, 401);
      return json({
        documentId: failure === 'wrong-batch-id' ? 'other' : 'doc_1',
        replies: [{}],
        writeControl: { requiredRevisionId: failure === 'unchanged-batch-version' ? 'rev1' : 'rev2' },
      });
    };
    const result = await answer(item.id);
    expect(result.status).toBe('failed');
    expect(result.result).toContain(failure === 'no-id' ? 'outcome is uncertain' : 'Google Doc “Project” was created');
    if (failure !== 'no-id') expect(result.result?.split('\n')).toContain('https://docs.google.com/document/d/doc_1/edit');
    expect(calls.filter((c) => c.url.endsWith('/documents'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('batchUpdate')).length).toBe(
      ['lost-response', 'unauthorized', 'wrong-batch-id', 'unchanged-batch-version'].includes(failure) ? 1 : 0,
    );
    await expect(answer(item.id)).rejects.toMatchObject({ status: 409 });
  });

  it('preserves a created-document receipt across interruption without replay, and needs no insert for an intentionally blank document', async () => {
    await propose('create', { ...preview, content: '' });
    handle = () => json({ documentId: 'doc_1', title: 'Project' });
    const created = outbox.list('c')[0];
    expect((await answer(created.id)).status).toBe('sent');
    expect(calls).toHaveLength(1);
    await propose('create', preview);
    const waiting = outbox.list('c').at(-1)!;
    const receipt = withLang('en', () => t().docsCreatedCheck('Project', 'https://docs.google.com/document/d/doc_1/edit'));
    db.prepare("UPDATE outbox SET status='sending', result=? WHERE id=?").run(receipt, waiting.id);
    outbox = new Outbox(db);
    expect(outbox.get(waiting.id)).toMatchObject({ status: 'failed', result: receipt });
    await expect(answer(waiting.id)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });
});
