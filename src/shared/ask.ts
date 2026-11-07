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
