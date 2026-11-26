import type { Conversation } from './types';

const SHORT_TITLE = 40;
const firstLine = (text: string) => text.split('\n', 1)[0]!.trim();

/** The compact name saved for chats and automations named from their question. */
export function titleFrom(text: string): string {
  const line = firstLine(text);
  return line.length > SHORT_TITLE ? line.slice(0, SHORT_TITLE - 1) + '…' : line;
}

/** Recover the first line when the saved name exactly matches the compact one. */
export function conversationHeading(conv: Pick<Conversation, 'title' | 'messages' | 'branch'> & { schedule?: { text: string } }): string {
  const { title, messages, branch } = conv;
  if (title[SHORT_TITLE - 1] !== '…') return title;
  const savedName = title.slice(0, SHORT_TITLE);
  const suffix = title.slice(SHORT_TITLE);
  // A fresh chat for each automation run appends scheduleTime (en or zh-TW, with an ISO fallback).
  if (suffix && !/^ · (?:\d{1,2}\/\d{1,2},?\s+\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u.test(suffix)) return title;

  const copiedThrough = branch ? messages.findIndex((m) => m.id === branch.afterId) : -1;
  const question = !branch || copiedThrough !== -1 ? messages.find((m, i) => i > copiedThrough && m.author.kind === 'user') : undefined;
  if (suffix && !question?.scheduled) return title;
  const text = question?.parts.find((p) => p.type === 'text')?.text.trimStart();
  const sourceName = text || question?.parts.find((p) => p.type === 'attachment')?.name;
  // A new automation can have a question before it has any user messages.
  for (const source of [sourceName, conv.schedule?.text]) {
    if (!source) continue;
    const line = firstLine(source);
    if (line.length <= SHORT_TITLE) continue;
    const compact = titleFrom(line);
    // A compact name cut between an emoji's surrogates comes back from SQLite with a replacement character.
    if (compact !== savedName && compact.replace(/[\uD800-\uDBFF]…$/u, '�…') !== savedName) continue;
    // Keep the header within the same 200-character budget as a typed title, including the ellipsis.
    const room = 200 - suffix.length;
    return (line.length <= room ? line : line.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…') + suffix;
  }
  return title;
}
