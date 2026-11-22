import { PREVIEW_RECIPES, type AppPreviewRequest, type AppPreviewSession, type PreviewTerminalEvent } from '../shared/types';

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
