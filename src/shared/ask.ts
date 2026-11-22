import type { ChatMessage } from './types';

/**
 * An agent ends its reply with this to ask the user something before it answers: the team stops
 * until the user replies, then that agent answers first (see `Orchestrator.execute`).
 */
export const ASK_TOKEN = '[ASK_USER]';

/** The marker at the very end of a reply, also when wrapped in Markdown emphasis or code, or followed by punctuation. */
const ASK_AT_END = /[*_`]*\[ASK_USER\][*_`]*[\s.。!！]*$/i;

/**
 * A reply's text without a final ask marker, and whether it asks: only a reply that says something
 * besides the marker asks the user.
 */
export function splitAsk(text: string): { text: string; asks: boolean } {
  const m = ASK_AT_END.exec(text);
  if (!m) return { text, asks: false };
  const rest = text.slice(0, m.index).trimEnd();
  return { text: rest, asks: rest.length > 0 };
}

/**
 * The replies whose questions (or steps for the user to take) the team waits on while it is paused for
 * the user: those that asked since the user last wrote.
 */
export function askingReplies<M extends Pick<ChatMessage, 'author' | 'asked'>>(messages: readonly M[]): M[] {
  const lastUser = messages.findLastIndex((m) => m.author.kind === 'user');
  return messages.filter((m, i) => m.asked && i > lastUser);
}
