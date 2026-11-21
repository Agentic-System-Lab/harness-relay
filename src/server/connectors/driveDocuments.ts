import { matchesPreparedDocument } from '../outbox';
import type { OutboxPreview } from '../../shared/types';
import type { GatewayTool } from '../gateway';
import { t } from '../i18n';
import type { OAuthService } from '../oauth/service';
import { jsonObject } from '../oauth/broker';

const DOCS = 'https://docs.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/documents';
const QUERY = '?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE';
type Json = Record<string, unknown>;
type Preview = NonNullable<OutboxPreview['document']>;
const invalid = () => new Error(t().docsInvalid);
const changed = () => new Error(t().docsChanged);
const object = (v: unknown): v is Json => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const fileId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v) && !/\s/.test(v);
const tabId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(v) && !/\s/.test(v);
const revision = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\s\x00-\x1f\x7f]/.test(v);
const link = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
function hasDocsScope(scopes: unknown): boolean {
  return Array.isArray(scopes) && scopes.some((scope) => scope === SCOPE);
}

function textField(v: unknown, field: string, singleLine = false): string {
  // Docs strips control characters and BMP private-use characters. A preview must match the exact write.
  if (
    typeof v !== 'string' ||
    Buffer.byteLength(v) > 48 * 1024 ||
    Buffer.from(v).toString() !== v ||
    /[\x00-\x08\x0b-\x1f\x7f\uE000-\uF8FF]/.test(v) ||
    (singleLine && (!v.length || v.includes('\n')))
  )
    throw new Error(t().invalidField(field));
  return v;
}
function titleOf(value: unknown) {
  const text = textField(value, 'title', true);
  if (!text.trim() || text.length > 1024 || /[\t\u0085\u2028\u2029]/.test(text)) throw new Error(t().invalidField('title'));
  return text;
}
function endpoint(value: string | undefined): string {
  if (value === DOCS) return DOCS;
  if (value && URL.canParse(value)) {
    const u = new URL(value);
    // A stand-in may be supplied by the server on this computer. Document contents never supply URLs.
    if (
      u.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    )
      return value.replace(/\/$/, '');
  }
  throw invalid();
}

/** Every ordinary paragraph is addressed in the body segment. Cross-check the body and paragraph
 * offsets before translating a matching text run into an absolute write range. */
function checkBody(content: unknown[]) {
  let next = object(content[0]) && object(content[0].sectionBreak) ? 0 : 1;
  for (const row of content) {
    if (
      !object(row) ||
      (row.startIndex ?? 0) !== next ||
      typeof row.endIndex !== 'number' ||
      !Number.isSafeInteger(row.endIndex) ||
      row.endIndex <= next
    )
      throw invalid();
    if (object(row.paragraph)) {
      if (!Array.isArray(row.paragraph.elements)) throw invalid();
      for (const element of row.paragraph.elements) {
        if (
          !object(element) ||
          element.startIndex !== next ||
          typeof element.endIndex !== 'number' ||
          !Number.isSafeInteger(element.endIndex) ||
          element.endIndex <= next
        )
          throw invalid();
        if (
          object(element.textRun) &&
          (typeof element.textRun.content !== 'string' || element.endIndex - next !== element.textRun.content.length)
        )
          throw invalid();
        next = element.endIndex;
      }
      if (next !== row.endIndex) throw invalid();
    }
    next = row.endIndex;
  }
}

type Tab = { id: string; title: string; body: Json; document: Json };
function documentView(raw: Json, expected: string) {
  if (
    raw.documentId !== expected ||
    !revision(raw.revisionId) ||
    !Array.isArray(raw.tabs) ||
    (raw.suggestionsViewMode !== undefined && raw.suggestionsViewMode !== 'SUGGESTIONS_INLINE')
  )
    throw invalid();
  const tabs: Tab[] = [];
  const seen = new Set<string>();
  const queue: unknown[] = [...raw.tabs];
  while (queue.length) {
    const v = queue.pop();
    if (
      !object(v) ||
      !object(v.tabProperties) ||
      !tabId(v.tabProperties.tabId) ||
      !object(v.documentTab) ||
      !object(v.documentTab.body) ||
      !Array.isArray(v.documentTab.body.content)
    )
      throw invalid();
    checkBody(v.documentTab.body.content);
    const id = v.tabProperties.tabId;
    if (seen.has(id)) throw invalid();
    seen.add(id);
    tabs.push({ id, title: titleOf(v.tabProperties.title), body: v.documentTab.body, document: v.documentTab });
    if (v.childTabs !== undefined && !Array.isArray(v.childTabs)) throw invalid();
    if (Array.isArray(v.childTabs)) for (const child of v.childTabs) queue.push(child);
  }
  if (!tabs.length) throw invalid();
  return { title: titleOf(raw.title), version: raw.revisionId, tabs };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function boundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length || graphemes.segment(text).containing(offset)?.index === offset;
}

type Match = { tab: Tab; start: number; end: number; editable: boolean };
/** Look through every structural paragraph for ambiguity, including tables, headers, footers and footnotes.
 * Only regular body text yields an editable range. An inline object interrupts adjacent text runs. */
function findPassage(tabs: Tab[], which: unknown, before: string, insert: boolean): Match {
  const selected = which === undefined ? tabs : tabs.filter((x) => x.id === which);
  const choose = () =>
    new Error(
      t().docsTabs(
        tabs
          .slice(0, 32)
          .map((t) => `${t.title} (${t.id})`)
          .join(', '),
      ),
    );
  if (!selected.length) throw choose();
  let hit: Match | undefined;
  for (const tab of selected) {
    const body = new Set(tab.body.content as unknown[]);
    const todo: unknown[] = [tab.document];
    while (todo.length) {
      const row = todo.pop();
      if (Array.isArray(row)) {
        for (const entry of row) todo.push(entry);
        continue;
      }
      if (!object(row)) continue;
      if (!object(row.paragraph)) {
        for (const entry of Object.values(row)) if (typeof entry === 'object') todo.push(entry);
        continue;
      }
      const elements = row.paragraph.elements;
      if (!Array.isArray(elements)) throw invalid();
      const editable = body.has(row) && !/"suggested[A-Z][^"]*"\s*:/.test(JSON.stringify(row));
      let text = '';
      let start = 0;
      const scan = () => {
        const index = text.indexOf(before);
        if (index >= 0) {
          if (hit || text.indexOf(before, index + 1) !== -1) {
            if (hit && hit.tab.id !== tab.id && which === undefined) throw choose();
            throw new Error(t().docsMatch);
          }
          const end = index + before.length;
          const safe = boundary(text, index) && boundary(text, end) && (!insert || boundary(text.slice(0, index) + text.slice(end), index));
          hit = { tab, start: start + index, end: start + end, editable: editable && safe };
        }
        text = '';
      };
      for (const el of elements) {
        if (!object(el) || !object(el.textRun)) {
          scan();
          continue;
        }
        const run = el.textRun.content;
        if (typeof run !== 'string') throw invalid();
        if (!text) start = Number(el.startIndex);
        text += run;
      }
      scan();
    }
  }
  if (!hit?.editable) throw new Error(t().docsMatch);
  return hit;
}

export function driveDocumentTools(oauth: OAuthService): GatewayTool[] {
  const granted = () =>
    oauth.store
      .accounts()
      .filter(
        (a) =>
          a.provider === 'google' &&
          a.status === 'connected' &&
          a.uses.includes('documents') &&
          hasDocsScope(oauth.store.account(a.id)?.scopes),
      );
  const account = (id: string) => {
    const a = oauth.store.account(id);
    if (!a || a.provider !== 'google' || a.status !== 'connected' || !a.subject || !a.uses.includes('documents') || !hasDocsScope(a.scopes))
      throw new Error(t().docsGrant);
    const provider = oauth.provider('google');
    return { id: a.id, subject: a.subject, email: a.email, api: endpoint(provider.docsApi), client: provider.clientId };
  };
  type Account = ReturnType<typeof account>;
  const verify = (a: Account) => {
    const now = account(a.id);
    if (now.subject !== a.subject || now.api !== a.api || now.client !== a.client || now.email !== a.email) throw changed();
  };
  const request = async (a: Account, suffix: string, target: string, body?: Json): Promise<Json> => {
    verify(a);
    const fetch = oauth.broker.fetch(a.id, 'documents', body ? { retryUnauthorized: false } : undefined);
    let res: Response;
    try {
      res = await fetch(a.api + '/documents' + suffix, {
        method: body ? 'POST' : 'GET',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(body ? t().docsUnknown(target) : t().docsInvalid);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (suffix.endsWith(':batchUpdate') && [400, 409, 412].includes(res.status)) throw changed();
      throw new Error(body && (res.status >= 500 || res.status === 408) ? t().docsUnknown(target) : t().docsHttp(res.status));
    }
    const out = await jsonObject(res, 3 * 1024 * 1024);
    if (!out) throw new Error(body ? t().docsUnknown(target) : t().docsInvalid);
    return out;
  };
  const get = async (a: Account, id: string) => documentView(await request(a, '/' + id + QUERY, id), id);
  const batch = async (a: Account, id: string, version: string, requests: Json[]) => {
    const response = await request(a, '/' + id + ':batchUpdate', link(id), { writeControl: { requiredRevisionId: version }, requests });
    if (
      response.documentId !== id ||
      !Array.isArray(response.replies) ||
      response.replies.length !== requests.length ||
      !response.replies.every(object) ||
      !object(response.writeControl) ||
      !revision(response.writeControl.requiredRevisionId) ||
      response.writeControl.requiredRevisionId === version
    )
      throw new Error(t().docsUnknown(link(id)));
  };
  const string = { type: 'string' };
  return (['create', 'edit'] as const).map((operation): GatewayTool => {
    const create = operation === 'create';
    return {
      name: 'drive_' + operation + '_document',
      group: 'drive',
      tier: 'send',
      description: create
        ? 'Propose creating a native Google Doc with the given title and exact plain text. The user must confirm in the chat.'
        : 'Propose replacing one unique literal passage in a regular Google Docs body paragraph. Pass the document ID, exact before and after text, and a tab ID for ambiguous tabs. Nothing is edited until the user confirms.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Google account email. Required with multiple editing accounts.' },
          ...(create ? { title: string, content: string } : { id: string, before: string, after: string, tabId: string }),
        },
        required: create ? ['title', 'content'] : ['id', 'before', 'after'],
        additionalProperties: false,
      },
      unavailable: () => oauth.clientProblem('google') ?? (granted().length ? undefined : t().docsGrant),
      describe: () => ({ title: 'Google Docs' }),
      async prepare(input) {
        const candidates = granted().filter((a) => input.account === undefined || input.account === a.email);
        if (candidates.length !== 1) throw new Error(t().docsAccount);
        const owner = account(candidates[0].id);
        let doc: Preview,
          target: Json = {};
        if (create) {
          doc = { account: owner.email, title: titleOf(input.title), before: null, after: textField(input.content, 'content') };
        } else {
          if (!fileId(input.id) || (input.tabId !== undefined && !tabId(input.tabId))) throw new Error(t().invalidField('id'));
          const before = textField(input.before, 'before', true),
            after = textField(input.after, 'after');
          if (before === after) throw new Error(t().invalidField('after'));
          const view = await get(owner, input.id);
          const match = findPassage(view.tabs, input.tabId, before, Boolean(after));
          doc = {
            account: owner.email,
            title: view.title,
            id: input.id,
            tab: match.tab.title + ' (' + match.tab.id + ')',
            tabId: match.tab.id,
            before,
            after,
          };
          target = { version: view.version, tabId: match.tab.id, start: match.start, end: match.end };
        }
        verify(owner);
        return {
          title: create ? t().docsCreate(doc.title) : t().docsEdit(doc.title),
          preview: { fields: [], document: doc },
          args: { ...target, owner, document: structuredClone(doc) },
        };
      },
      async send(args, item, recordProgress) {
        const doc = item.preview.document,
          frozen = args.owner;
        if (!doc || !matchesPreparedDocument(args, doc) || !object(frozen) || typeof frozen.id !== 'string') throw changed();
        const owner = account(frozen.id);
        if (
          owner.email !== doc.account ||
          owner.email !== frozen.email ||
          owner.subject !== frozen.subject ||
          owner.api !== frozen.api ||
          owner.client !== frozen.client
        )
          throw changed();
        const after = textField(doc.after, 'after');
        if (create) {
          if (doc.before !== null || doc.id !== undefined) throw changed();
          const created = await request(owner, '', doc.title, { title: titleOf(doc.title) });
          if (!fileId(created.documentId)) throw new Error(t().docsUnknown(doc.title));
          const id = created.documentId,
            receipt = t().docsCreatedCheck(doc.title, link(id));
          try {
            recordProgress?.(receipt);
            if (created.title !== doc.title) throw invalid();
            if (after) {
              if (!revision(created.revisionId)) throw invalid();
              const view = await get(owner, id);
              const [tab] = view.tabs;
              const paragraphs = (tab.body.content as unknown[]).filter((x) => object(x) && !x.sectionBreak);
              const p = paragraphs[0];
              if (
                view.version !== created.revisionId ||
                view.title !== doc.title ||
                view.tabs.length !== 1 ||
                paragraphs.length !== 1 ||
                !object(p) ||
                !object(p.paragraph) ||
                !Array.isArray(p.paragraph.elements) ||
                p.paragraph.elements.length !== 1
              )
                throw changed();
              const blank = p.paragraph.elements[0];
              if (
                !object(blank) ||
                !object(blank.textRun) ||
                blank.textRun.content !== '\n' ||
                blank.startIndex !== 1 ||
                blank.endIndex !== 2
              )
                throw changed();
              await batch(owner, id, view.version, [{ insertText: { location: { index: 1, tabId: tab.id }, text: after } }]);
            }
          } catch (error) {
            throw new Error(receipt + '\n' + (error as Error).message);
          }
          return t().docsSaved(doc.title, link(id));
        }
        if (!fileId(doc.id) || !revision(args.version) || !tabId(args.tabId) || args.tabId !== doc.tabId || typeof doc.before !== 'string')
          throw changed();
        const view = await get(owner, doc.id);
        if (view.title !== doc.title || view.version !== args.version) throw changed();
        const match = findPassage(view.tabs, args.tabId, doc.before, Boolean(after));
        if (match.tab.title + ' (' + match.tab.id + ')' !== doc.tab || match.start !== args.start || match.end !== args.end)
          throw changed();
        const requests: Json[] = [{ deleteContentRange: { range: { tabId: match.tab.id, startIndex: match.start, endIndex: match.end } } }];
        if (after) requests.push({ insertText: { location: { tabId: match.tab.id, index: match.start }, text: after } });
        await batch(owner, doc.id, view.version, requests);
        return t().docsSaved(doc.title, link(doc.id));
      },
    };
  });
}
