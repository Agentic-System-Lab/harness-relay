import type { AppPreviewRequest, AppPreviewSession } from '../shared/types';

/** The path was decoded by localFilePath (reply), or comes straight from a Files listing. */
export function filePreviewTarget(path: string): AppPreviewRequest | undefined {
  const clean = path.replace(/\\/g, '/');
  const slash = clean.lastIndexOf('/');
  const entry = clean.slice(slash + 1);
  if (entry !== 'package.json' && !/\.html?$/i.test(entry)) return;
  const prefix = clean.slice(0, slash + 1);
  const folder = /^(?:[a-z]:)?\/$/i.test(prefix) ? prefix : prefix.slice(0, -1);
  return { mode: entry === 'package.json' ? 'build' : 'static', folder, entry };
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
