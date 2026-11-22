import { describe, expect, it } from 'vitest';
import { mentionsInMarkdown, unknownMentions } from '../src/shared/mentions';
import {
  NO_TERMINAL,
  filePreviewTarget,
  nextTerminalState,
  previewErrorDraft,
  previewFrameError,
  recordPreviewError,
  safePreviewSession,
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
