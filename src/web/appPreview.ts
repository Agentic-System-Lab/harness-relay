import { localFilePath } from '../shared/media';
import {
  PREVIEW_RECIPES,
  type AppPreviewRequest,
  type AppPreviewSession,
  type ChatMessage,
  type Permission,
  type PreviewTerminalEvent,
} from '../shared/types';

/** The path was decoded by localFilePath (reply), or comes straight from a Files listing. */
export function filePreviewTarget(path: string): AppPreviewRequest | undefined {
  const clean = path.replace(/\\/g, '/');
  const slash = clean.lastIndexOf('/');
  const entry = clean.slice(slash + 1);
  const container = (PREVIEW_RECIPES as readonly string[]).includes(entry);
  if (entry !== 'package.json' && !container && !/\.html?$/i.test(entry)) return;
  const prefix = clean.slice(0, slash + 1);
  const folder = /^(?:[a-z]:)?\/$/i.test(prefix) ? prefix : prefix.slice(0, -1);
  return { mode: container ? 'container' : entry === 'package.json' ? 'build' : 'static', folder, entry };
}

/** Complete SSE messages' data in what was read so far, and what is left for the next read. */
export function sseMessages(buffer: string): { messages: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const messages = parts.flatMap((part) => {
    const lines = part.split('\n');
    if (lines.some((line) => line.startsWith('event:') && line.slice(6).trim() !== 'message')) return [];
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
    return data.length ? [data.join('\n')] : [];
  });
  return { messages, rest };
}

/** A terminal stream's event, or nothing for anything else. */
export function terminalEvent(text: string): PreviewTerminalEvent | undefined {
  try {
    const event = JSON.parse(text) as PreviewTerminalEvent;
    if (event && ['output', 'phase', 'page', 'closed'].includes(event.type)) return event;
  } catch {
    /* not one */
  }
}

export function base64Bytes(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** What the panel shows of a container preview. */
export interface TerminalState {
  phase?: Extract<PreviewTerminalEvent, { type: 'phase' }>['phase'];
  code?: number;
  error?: string;
  command?: string;
  /** The app serves its page. */
  page: boolean;
  closed: boolean;
}

export const NO_TERMINAL: TerminalState = { page: false, closed: false };

export function nextTerminalState(state: TerminalState, event: PreviewTerminalEvent): TerminalState {
  switch (event.type) {
    case 'phase':
      return {
        ...state,
        phase: event.phase,
        code: event.code,
        error: event.error,
        // A new run says its command; the last one stays offered after it exits.
        command: event.command ?? (event.phase === 'exited' || event.phase === 'failed' ? state.command : undefined),
        page: event.phase === 'running' ? state.page : false,
      };
    case 'page':
      return { ...state, page: true };
    case 'closed':
      return { ...state, closed: true, page: false };
    default:
      return state;
  }
}

/** The text a terminal showed, without its escape sequences, as lines a message can quote. */
export function terminalText(raw: string): string {
  return (
    raw
      // OSC (titles, links) up to BEL or ST, then CSI and other ESC sequences.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r+\n/g, '\n')
      // A carriage return alone redraws its line: what follows it is what stayed.
      .split('\n')
      .map((line) => line.split('\r').pop()!)
      .join('\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

/** The terminal's last lines, for a message to an agent. */
export function terminalTail(raw: string, lines = 40): string {
  return terminalText(raw).replace(/\n+$/, '').split('\n').slice(-lines).join('\n');
}

/** A panel selection also knows who handed over the file, and, for Files, its displayed absolute folder. */
export interface PreviewSelection {
  request: AppPreviewRequest;
  label: string;
  folder?: string;
  agentName?: string;
  /** Relay opened it by itself, when the team made an app: Docker's setup waits for a click. */
  auto?: boolean;
  /** False: the panel shows the target and waits for Start preview (see `startsByItself`). */
  autoStart?: boolean;
  /** The chat's permission when Relay opened it: what the panel finds is checked against it again. */
  permission?: Permission;
}

// --- The app the team made: what the panel opens by itself, the card and the header's button ---

/** The local files a reply's text links to, as the chat makes links of them: outside code. */
export function linkedFiles(text: string): string[] {
  const prose: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    prose.push(line.replace(/(`+)[^`]*?\1/g, ''));
  }
  const body = prose.join('\n');
  const urls = [
    ...[...body.matchAll(/\]\(\s*<([^>\n]+)>/g)].map((m) => m[1]!),
    ...[...body.matchAll(/\]\(\s*([^\s)<][^\s)]*)/g)].map((m) => m[1]!),
    ...[...body.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)].map((m) => m[1]!),
    ...[...body.matchAll(/<(file:[^>\s]+)>/gi)].map((m) => m[1]!),
  ];
  return urls.flatMap((url) => localFilePath(url) ?? []);
}

/** How well a file says how its folder runs: a compose file or Dockerfile, then npm, then an index page. */
function entryRank(entry: string): number {
  if ((PREVIEW_RECIPES as readonly string[]).includes(entry)) return 0;
  if (entry === 'package.json') return 1;
  return /^index\.html?$/i.test(entry) ? 2 : 3;
}

/** Of these files, the one a preview starts from: the shallowest folder, then its best entry. Never one in node_modules. */
export function bestPreviewPath(paths: readonly string[]): string | undefined {
  const candidates = paths
    .map((path) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, ''))
    .filter((path) => filePreviewTarget(path) && !path.split('/').includes('node_modules'));
  const depth = (path: string) => path.split('/').length;
  const entry = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return candidates.sort((a, b) => depth(a) - depth(b) || entryRank(entry(a)) - entryRank(entry(b)))[0];
}

export interface PreviewSuggestion {
  /** The reply it comes from: its author's files (its own worktree in parallel mode). */
  messageId: string;
  agentName: string;
  /** Where the reply is in the conversation. */
  index: number;
  /** A file the reply links to, as written (see `filePreviewTarget`); none: the app is in the files its turn changed, which the server finds (`changedPreviewTarget`). */
  path?: string;
  /** Its turn added or changed files: only such a reply may open by itself (a link alone may not). */
  changed: boolean;
}

/** A file a turn added or changed that may say how an app runs, or be its page. */
function appFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Boolean(filePreviewTarget(name)) && !path.split('/').includes('node_modules');
}

/**
 * The app the team made last: the newest finished reply that links a page, a package.json, a
 * Dockerfile or a compose file (a link first, as its author pointed at it), or whose turn added or
 * changed one.
 */
export function previewSuggestion(messages: readonly ChatMessage[]): PreviewSuggestion | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index]!;
    if (msg.author.kind !== 'agent' || msg.status !== 'done') continue;
    let read = replyApps.get(msg);
    if (!read) {
      read = replyApp(msg);
      replyApps.set(msg, read);
    }
    if (read.path || read.changedApp)
      return {
        messageId: msg.id,
        agentName: msg.agentName ?? '',
        index,
        ...(read.path !== undefined && { path: read.path }),
        changed: read.changed,
      };
  }
  return undefined;
}

/** Each finished reply read once: the conversation is a new object with every word streamed. */
const replyApps = new WeakMap<ChatMessage, { path?: string; changed: boolean; changedApp: boolean }>();

function replyApp(msg: ChatMessage): { path?: string; changed: boolean; changedApp: boolean } {
  const text = msg.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  const files = (msg.changes ?? []).flatMap((c) => c.files.filter((f) => f.status !== 'D').map((f) => f.path.replace(/\\/g, '/')));
  return { path: bestPreviewPath(linkedFiles(text)), changed: files.length > 0, changedApp: files.some(appFile) };
}

/** The conversation's finished replies, by id. */
export function finishedReplies(messages: readonly ChatMessage[]): string[] {
  return messages.filter((m) => m.author.kind === 'agent' && m.status === 'done').map((m) => m.id);
}

/**
 * Whether the app a reply made opens by itself: only from a turn that changed files, only a reply
 * the page had not dealt with yet (never one there when it opened, nor one a Retry or an edit falls
 * back to), each folder once, never over another preview, nor on a phone or tablet, where it would
 * cover the chat, nor in a browser elsewhere, which may not reach the preview's hostname.
 */
export function opensByItself(
  app: { changed: boolean; fresh: boolean; folder: string },
  o: { opened: ReadonlySet<string>; panelOpen: boolean; narrow: boolean; local: boolean },
): boolean {
  return app.changed && app.fresh && !o.opened.has(app.folder) && !o.panelOpen && !o.narrow && o.local;
}

/** This page was opened on the computer running Relay (its own hostnames reach the previews). */
export function localPage(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** What the card shows of an app: its folder relative to the working directory it is in, and its entry. */
export function shownApp(folder: string, entry: string, cwds: readonly string[]): string {
  const clean = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
  const where = clean(folder);
  for (const cwd of cwds.map(clean)) {
    if (where === cwd) return entry;
    if (cwd && where.startsWith(cwd + '/')) return `${where.slice(cwd.length + 1)}/${entry}`;
  }
  return `${where}/${entry}`;
}

/**
 * Whether a preview Relay opened by itself also starts by itself. A static page and an npm project
 * run offline; a Dockerfile's or compose file's build can reach the network, so below full access it
 * waits for the user's click, as it did before Relay opened anything by itself.
 */
export function startsByItself(mode: AppPreviewRequest['mode'], permission: Permission): boolean {
  return mode !== 'container' || permission === 'full';
}

/** The panel's width when dragged: at least 320 pixels, and the chat keeps at least 360. */
export const PREVIEW_MIN_WIDTH = 320;
export const CHAT_MIN_WIDTH = 360;

export function previewWidth(width: number, total: number): number {
  const max = Math.max(PREVIEW_MIN_WIDTH, total - CHAT_MIN_WIDTH);
  return Math.round(Math.min(max, Math.max(PREVIEW_MIN_WIDTH, width)));
}

/** This browser's dragged width, kept in localStorage. */
export const PREVIEW_WIDTH_KEY = 'relay:preview-width';

export function storedPreviewWidth(value: string | null): number | undefined {
  const width = Number(value);
  return value && Number.isFinite(width) && width >= PREVIEW_MIN_WIDTH && width <= 10000 ? Math.round(width) : undefined;
}

export function safePreviewSession(session: AppPreviewSession, parent: string): boolean {
  try {
    const url = new URL(session.url);
    const relay = new URL(parent);
    return Boolean(
      session.id &&
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === session.origin &&
      url.hostname !== relay.hostname &&
      !url.username &&
      !url.password &&
      (relay.protocol !== 'https:' || url.protocol === 'https:'),
    );
  } catch {
    return false;
  }
}

export function previewFrameError(
  event: { origin: string; source: unknown; data: unknown },
  frame: unknown,
  origin: string,
): string | undefined {
  if (!frame || event.source !== frame || event.origin !== origin) return;
  const data = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('type' in data) ||
    data.type !== 'relay-preview-error' ||
    !('message' in data) ||
    typeof data.message !== 'string'
  )
    return;
  const message = data.message.slice(0, 2048).replaceAll(origin, '').replaceAll(new URL(origin).hostname, '[preview]');
  return message.slice(0, 1000).trim() || undefined;
}

export function recordPreviewError(problems: string[], error: string): string[] {
  return problems.length >= 10 || problems.includes(error) ? problems : [...problems, error];
}

/** The agent's briefing treats this block as page output; page text cannot close it. */
export function previewErrorDraft(heading: string, folder: string, issues: string[], agentName?: string): string {
  const output = [folder, ...issues].join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Indented Markdown code keeps mentions inside diagnostics out of the chat's recipient list.
  const lines = output
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n');
  return `${agentName ? '@' + agentName + ' ' : ''}${heading}\n<preview_console>\n\n${lines}\n\n</preview_console>`;
}
