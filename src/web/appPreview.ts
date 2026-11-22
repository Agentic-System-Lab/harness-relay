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

/** A file a turn changed, as a reply would link it: relative to the working directory it is in. */
export function changedFilePath(root: string, file: string, cwds: readonly string[]): string | undefined {
  const clean = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = `${clean(root)}/${clean(file)}`;
  for (const cwd of cwds.map(clean)) if (cwd && absolute.startsWith(cwd + '/')) return absolute.slice(cwd.length + 1);
  return undefined;
}

export interface PreviewSuggestion {
  /** The reply it comes from: its author's files (its own worktree in parallel mode). */
  messageId: string;
  agentName: string;
  /** As a reply links it (see `filePreviewTarget`). */
  path: string;
  /** Where the reply is in the conversation. */
  index: number;
}

/**
 * The app the team made last: the newest finished reply that links a page, a package.json, a
 * Dockerfile or a compose file, or whose turn added or changed one (a link first, as its author
 * pointed at it).
 */
export function previewSuggestion(messages: readonly ChatMessage[], cwds: readonly string[]): PreviewSuggestion | undefined {
  const dirs = cwds.join('\0');
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index]!;
    if (msg.author.kind !== 'agent' || msg.status !== 'done') continue;
    let read = replyPaths.get(msg);
    if (read?.dirs !== dirs) {
      read = { dirs, path: replyPreviewPath(msg, cwds) };
      replyPaths.set(msg, read);
    }
    if (read.path) return { messageId: msg.id, agentName: msg.agentName ?? '', path: read.path, index };
  }
  return undefined;
}

/** Each finished reply read once: the conversation is a new object with every word streamed. */
const replyPaths = new WeakMap<ChatMessage, { dirs: string; path?: string }>();

function replyPreviewPath(msg: ChatMessage, cwds: readonly string[]): string | undefined {
  const text = msg.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  const changed = (msg.changes ?? []).flatMap((c) =>
    c.files.filter((f) => f.status !== 'D').flatMap((f) => changedFilePath(c.root, f.path, cwds) ?? []),
  );
  return bestPreviewPath(linkedFiles(text)) ?? bestPreviewPath(changed);
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
