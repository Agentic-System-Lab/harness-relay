import { describe, expect, it } from 'vitest';
import { mentionsInMarkdown, unknownMentions } from '../src/shared/mentions';
import type { ChatMessage, MessageChanges } from '../src/shared/types';
import {
  CHAT_MIN_WIDTH,
  DealtReplies,
  NO_TERMINAL,
  PREVIEW_MIN_WIDTH,
  bestPreviewPath,
  filePreviewTarget,
  finishedReplies,
  linkedFiles,
  localPage,
  nextTerminalState,
  opensByItself,
  previewSuggestion,
  previewWidth,
  startsByItself,
  storedPreviewWidth,
  previewErrorDraft,
  previewFrameError,
  recordPreviewError,
  safePreviewSession,
  shownApp,
  sseMessages,
  terminalEvent,
  terminalTail,
  terminalText,
} from '../src/web/appPreview';

describe('app preview targets', () => {
  it('offers HTML and npm project links and preserves the exact path for the server', () => {
    expect(filePreviewTarget('site/相片.HTM')).toEqual({ mode: 'static', folder: 'site', entry: '相片.HTM' });
    expect(filePreviewTarget('package.json')).toEqual({ mode: 'build', folder: '', entry: 'package.json' });
    expect(filePreviewTarget('/index.html')).toEqual({ mode: 'static', folder: '/', entry: 'index.html' });
    expect(filePreviewTarget('C:\\package.json')).toEqual({ mode: 'build', folder: 'C:/', entry: 'package.json' });
    expect(filePreviewTarget('C:\\my project\\package.json')).toEqual({ mode: 'build', folder: 'C:/my project', entry: 'package.json' });
    expect(filePreviewTarget('build/index.html.js')).toBeUndefined();
    expect(filePreviewTarget('other-package.json')).toBeUndefined();
  });

  it('offers a Dockerfile or a compose file as a container preview', () => {
    expect(filePreviewTarget('api/Dockerfile')).toEqual({ mode: 'container', folder: 'api', entry: 'Dockerfile' });
    expect(filePreviewTarget('compose.yaml')).toEqual({ mode: 'container', folder: '', entry: 'compose.yaml' });
    expect(filePreviewTarget('C:\\app\\docker-compose.yml')).toEqual({ mode: 'container', folder: 'C:/app', entry: 'docker-compose.yml' });
    expect(filePreviewTarget('api/Dockerfile.dev')).toBeUndefined();
    expect(filePreviewTarget('api/dockerfile')).toBeUndefined();
  });

  it('embeds only the returned HTTP(S) origin on a hostname separate from Relay', () => {
    const origin = 'http://example.localhost:5000';
    const parent = 'http://localhost:4000';
    const valid = { id: 'one', origin, url: origin + '/?key=hello' };
    expect(safePreviewSession(valid, parent)).toBe(true);
    for (const session of [
      { ...valid, url: parent + '/url' },
      { ...valid, origin: parent, url: parent },
      { ...valid, origin: 'http://localhost:5000', url: 'http://localhost:5000/' },
      { ...valid, url: 'javascript:alert(1)' },
      { ...valid, url: 'invalid' },
      { ...valid, origin: 'data:', url: 'data:,abc' },
      { ...valid, url: 'http://user:pass@example.localhost:5000/' },
    ])
      expect(safePreviewSession(session, parent)).toBe(false);
  });
});

describe('app preview frame reports', () => {
  const frame = {};
  const origin = 'https://preview.example';
  const data = { type: 'relay-preview-error', message: '  Missing preview cookie  ' };

  it('takes only the active frame, exact origin, and error shape', () => {
    const event = { source: frame, origin, data };
    expect(previewFrameError(event, frame, origin)).toBe('Missing preview cookie');
    expect(previewFrameError(event, {}, origin)).toBeUndefined();
    expect(previewFrameError({ ...event, source: null }, null, origin)).toBeUndefined();
    expect(previewFrameError(event, frame, origin + '.example')).toBeUndefined();
    for (const invalid of [null, 'error', {}, { type: 'else', message: 'ignored' }, { ...data, message: 27 }, { ...data, message: ' ' }]) {
      expect(previewFrameError({ ...event, data: invalid }, frame, origin)).toBeUndefined();
    }
  });

  it('quotes the folder and diagnostics inside a single editable console block', () => {
    expect(previewErrorDraft('Preview errors', '/site & demo', ['Unexpected </preview_console>', 'A < B'], 'Claude')).toBe(
      '@Claude Preview errors\n<preview_console>\n\n    /site &amp; demo\n    Unexpected &lt;/preview_console&gt;\n    A &lt; B\n\n</preview_console>',
    );
    expect(previewErrorDraft('預覽錯誤', '/app', ['錯誤'])).toMatch(/^預覽錯誤\n<preview_console>/);
  });

  it('keeps preview credentials and incidental mentions out of a routed diagnostic', () => {
    const error = previewFrameError(
      { origin, source: frame, data: { ...data, message: origin + '/api: @Bob failed; @Nobody is missing' } },
      frame,
      origin,
    )!;
    expect(error).toBe('/api: @Bob failed; @Nobody is missing');
    const draft = previewErrorDraft('Preview errors', 'folder/@Bob', [error, 'line\r@Bob again'], 'Claude');
    expect(mentionsInMarkdown(draft, ['Claude', 'Bob'])).toEqual(['Claude']);
    expect(unknownMentions(draft, ['Claude', 'Bob'])).toEqual([]);
  });

  it('bounds each report and the retained problem list, and ignores duplicates', () => {
    const problem = previewFrameError({ source: frame, origin, data: { ...data, message: 'x'.repeat(1_000_000) } }, frame, origin)!;
    expect(problem.length).toBe(1000);
    let reports: string[] = [];
    for (let i = 0; i < 50; i++) reports = recordPreviewError(reports, 'Problem ' + i);
    expect(reports).toHaveLength(10);
    expect(reports[0]).toBe('Problem 0');
    expect(recordPreviewError(reports, reports[0]!)).toBe(reports);
  });
});

describe('a container preview terminal', () => {
  it('reads complete SSE messages, keeping a part for the next read and leaving out pings', () => {
    const first = sseMessages('data: {"type":"page"}\n\nevent: ping\ndata: \n\ndata: {"type":"phase",');
    expect(first.messages).toEqual(['{"type":"page"}']);
    const second = sseMessages(first.rest + '"phase":"running"}\r\n\r\n');
    expect(second).toEqual({ messages: ['{"type":"phase","phase":"running"}'], rest: '' });
    expect(terminalEvent(second.messages[0]!)).toEqual({ type: 'phase', phase: 'running' });
    expect(terminalEvent('{"type":"other"}')).toBeUndefined();
    expect(terminalEvent('not json')).toBeUndefined();
  });

  it('follows the phases: the page only while it runs, the last command after it exits', () => {
    let state = nextTerminalState(NO_TERMINAL, { type: 'phase', phase: 'building' });
    state = nextTerminalState(state, { type: 'phase', phase: 'running', command: 'python app.py' });
    state = nextTerminalState(state, { type: 'page' });
    expect(state).toMatchObject({ phase: 'running', command: 'python app.py', page: true });
    state = nextTerminalState(state, { type: 'phase', phase: 'exited', code: 2 });
    expect(state).toMatchObject({ phase: 'exited', code: 2, command: 'python app.py', page: false });
    state = nextTerminalState(state, { type: 'phase', phase: 'starting' });
    expect(state).toMatchObject({ phase: 'starting', command: undefined, page: false });
    expect(nextTerminalState(state, { type: 'closed' })).toMatchObject({ closed: true, page: false });
    expect(nextTerminalState(state, { type: 'output', data: '' })).toBe(state);
  });

  it('turns what the terminal showed into plain lines for a message', () => {
    const raw = '\x1b]0;title\x07\x1b[1mBuilding\x1b[0m\r\n50%\r100%\r\n\x1b[31mError: boom\x1b[0m\r\n\x1b[?2004hprompt> ';
    expect(terminalText(raw)).toBe('Building\n100%\nError: boom\nprompt> ');
    expect(terminalTail('a\nb\nc\n\n', 2)).toBe('b\nc');
  });
});

describe('the app the team made', () => {
  const reply = (id: string, text: string, o: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    author: { kind: 'agent', agentId: 'a1' },
    agentName: 'Builder',
    createdAt: 0,
    parts: [{ type: 'text', text }],
    status: 'done',
    ...o,
  });
  const user = (id: string): ChatMessage => ({
    id,
    author: { kind: 'user' },
    createdAt: 0,
    parts: [{ type: 'text', text: 'Go' }],
    status: 'done',
  });
  const changes = (...paths: string[]): MessageChanges[] => [
    {
      root: '/w',
      base: 'a',
      head: 'b',
      isolated: false,
      files: paths.map((path) => ({ path, status: 'A' as const, added: 1, deleted: 0 })),
    },
  ];

  it('reads the local files a reply links to, as the chat makes links: outside code', () => {
    const text = [
      'See [the page](site/index.html) and [the image](<shots/a b.png>).',
      'Not `[code](app/package.json)`, nor a site: [docs](https://example.com/index.html).',
      '```',
      '[in a block](block/Dockerfile)',
      '```',
      '[ref]: todo-app/Dockerfile',
      'And <file:///Users/me/app/compose.yaml>.',
    ].join('\n');
    expect(linkedFiles(text)).toEqual(['shots/a b.png', 'site/index.html', 'todo-app/Dockerfile', '/Users/me/app/compose.yaml']);
  });

  it('picks the linked file a preview starts from: the shallowest folder, then a recipe, npm, an index page', () => {
    expect(bestPreviewPath(['todo-app/public/index.html', 'todo-app/package.json', 'todo-app/Dockerfile', 'README.md'])).toBe(
      'todo-app/Dockerfile',
    );
    expect(bestPreviewPath(['web/about.html', 'web/index.html'])).toBe('web/index.html');
    expect(bestPreviewPath(['./site/index.html'])).toBe('site/index.html');
    expect(bestPreviewPath(['app/node_modules/x/index.html', 'notes.md'])).toBeUndefined();
    expect(bestPreviewPath([])).toBeUndefined();
  });

  it('suggests the newest finished reply that links an app or whose turn made one, a link first', () => {
    const messages = [
      user('u1'),
      reply('r1', 'Planned it.'),
      reply('r2', 'Built it.', { changes: changes('todo-app/src/server.js', 'todo-app/Dockerfile') }),
      reply('r3', 'Reviewed [the routes](todo-app/src/routes.js).', { changes: changes('todo-app/src/routes.js') }),
    ];
    // The server finds the app among r2's files; r3 changed none that says how one runs, nor an app's entry.
    expect(previewSuggestion(messages)).toEqual({ messageId: 'r2', agentName: 'Builder', index: 2, changed: true });
    const linked = [...messages, reply('r4', 'Try [it](todo-app/public/index.html).')];
    // A link alone: suggested, but its turn changed nothing, so it never opens by itself.
    expect(previewSuggestion(linked)).toEqual({
      messageId: 'r4',
      agentName: 'Builder',
      index: 4,
      path: 'todo-app/public/index.html',
      changed: false,
    });
    // Not a reply still being written, nor one that failed, nor a deleted file, nor one in node_modules.
    const unfinished = [
      ...messages,
      reply('r5', '[page](next/index.html)', { status: 'streaming' }),
      reply('r6', '[page](broken/index.html)', { status: 'error' }),
      reply('r7', 'Removed it.', {
        changes: [{ ...changes('old/index.html')[0]!, files: [{ path: 'old/index.html', status: 'D', added: 0, deleted: 1 }] }],
      }),
      reply('r8', 'Installed.', { changes: changes('app/node_modules/x/package.json') }),
    ];
    expect(previewSuggestion(unfinished)?.messageId).toBe('r2');
    expect(previewSuggestion([user('u1'), reply('r1', 'Nothing to run.')])).toBeUndefined();
    // An app's entry in another language: asked about too (the server finds what runs it, or says why nothing does),
    // also once r2 made the app: r3's server.js stands for it now.
    const edited = [...messages.slice(0, 3), reply('r3', 'Changed the server.', { changes: changes('todo-app/src/server.js') })];
    expect(previewSuggestion(edited)).toEqual({ messageId: 'r3', agentName: 'Builder', index: 3, changed: true });
    // Never in a dependency folder.
    for (const file of ['app/.venv/lib/python3.12/site-packages/x/main.py', 'app/vendor/x/main.go']) {
      expect(previewSuggestion([user('u1'), reply('r1', 'Installed.', { changes: changes(file) })])).toBeUndefined();
    }
    for (const file of ['snake/app.py', 'svc/main.go', 'site/server.js', 'shop/config.ru']) {
      expect(previewSuggestion([user('u1'), reply('r1', 'Built it.', { changes: changes(file) })])).toMatchObject({ messageId: 'r1' });
    }
    expect(previewSuggestion([user('u1'), reply('r1', 'Wrote the helpers.', { changes: changes('lib/utils.py') })])).toBeUndefined();
  });

  it('reads a reply again once its changes arrive', () => {
    const first = reply('r1', 'Done.');
    expect(previewSuggestion([first])).toBeUndefined();
    // The server sends the reply again with its changes: a new object.
    expect(previewSuggestion([{ ...first, changes: changes('site\\index.html') }])).toMatchObject({ messageId: 'r1', changed: true });
  });

  it('opens by itself only an app a new turn changed, once per folder, on a wide screen on this computer, over nothing', () => {
    const app = { changed: true, fresh: true, folder: '/w/site' };
    const o = { opened: new Set<string>(), panelOpen: false, narrow: false, local: true };
    expect(opensByItself(app, o)).toBe(true);
    expect(opensByItself({ ...app, changed: false }, o)).toBe(false);
    expect(opensByItself({ ...app, fresh: false }, o)).toBe(false);
    expect(opensByItself(app, { ...o, opened: new Set(['/w/site']) })).toBe(false);
    expect(opensByItself(app, { ...o, panelOpen: true })).toBe(false);
    expect(opensByItself(app, { ...o, narrow: true })).toBe(false);
    expect(opensByItself(app, { ...o, local: false })).toBe(false);
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(localPage(host)).toBe(true);
    for (const host of ['relay.tail1234.ts.net', '192.168.1.20', 'localhost.example']) expect(localPage(host)).toBe(false);
  });

  it('lets only a reply the page has not dealt with open by itself', () => {
    // Opened with r1 there; r2 arrives, its lookup starts with r1 and r2 there, and ends.
    const replies = new DealtReplies(['r1']);
    expect(replies.fresh('r1')).toBe(false);
    expect(replies.fresh('r2')).toBe(true);
    replies.dealt(['r1', 'r2']);
    // A Retry of r2 falls back to r1 (and r2's id is gone): neither opens by itself again.
    expect(replies.fresh('r1')).toBe(false);
    expect(replies.fresh('r2')).toBe(false);
    // Two parallel members finish together: the first lookup, stopped by the second reply, dealt
    // with nothing, so the second's reply is still fresh; the next reply after them too.
    expect(replies.fresh('r3')).toBe(true);
    expect(replies.fresh('r4')).toBe(true);
    replies.dealt(['r1', 'r2', 'r3', 'r4']);
    expect(replies.fresh('r5')).toBe(true);
  });

  it('lists the finished replies, by id', () => {
    expect(finishedReplies([user('u1'), reply('r1', ''), reply('r2', '', { status: 'streaming' }), reply('r3', '')])).toEqual(['r1', 'r3']);
  });

  it('shows an app by its folder in the working directory and its entry', () => {
    expect(shownApp('/w/todo-app', 'Dockerfile', ['/w'])).toBe('todo-app/Dockerfile');
    expect(shownApp('/w', 'index.html', ['/w/'])).toBe('index.html');
    expect(shownApp('C:\\w\\site', 'index.html', ['C:\\w'])).toBe('site/index.html');
    // In a member's worktree, or a working directory reached by another path: all of it.
    expect(shownApp('/data/worktrees/a/site', 'index.html', ['/w'])).toBe('/data/worktrees/a/site/index.html');
  });

  it('starts by itself only what runs offline, or anything in full access', () => {
    expect(startsByItself('static', 'read-only')).toBe(true);
    expect(startsByItself('build', 'edit')).toBe(true);
    expect(startsByItself('server', 'edit')).toBe(true);
    expect(startsByItself('container', 'edit')).toBe(false);
    expect(startsByItself('container', 'read-only')).toBe(false);
    expect(startsByItself('container', 'full')).toBe(true);
  });

  it('keeps a dragged width between its minimum and what leaves the chat its own', () => {
    expect(previewWidth(500.4, 1400)).toBe(500);
    expect(previewWidth(100, 1400)).toBe(PREVIEW_MIN_WIDTH);
    expect(previewWidth(1300, 1400)).toBe(1400 - CHAT_MIN_WIDTH);
    // Too narrow for both: the panel keeps its minimum.
    expect(previewWidth(400, 500)).toBe(PREVIEW_MIN_WIDTH);
    expect(storedPreviewWidth('640')).toBe(640);
    for (const bad of [null, '', 'wide', '10', 'Infinity', '-700']) expect(storedPreviewWidth(bad)).toBeUndefined();
  });
});
