import type { ReviewHighlight, ReviewKind } from '../shared/types';
import { findQuote } from '../shared/review';

/*
 * The lead agent's review marks the words it quotes in the replies they come from, with the CSS Custom
 * Highlight API (`::highlight(review-<kind>)` in styles.css): ranges over the reply's rendered text, so
 * nothing in the reply's own DOM changes. A browser without that API shows the review card alone.
 */

/** The ranges marked for each kind, across the chat's replies. */
const highlights = new Map<ReviewKind, Highlight>();

function highlightFor(kind: ReviewKind): Highlight | undefined {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return undefined;
  let h = highlights.get(kind);
  if (!h) {
    h = new Highlight();
    highlights.set(kind, h);
    CSS.highlights.set(`review-${kind}`, h);
  }
  return h;
}

/** The text nodes of one piece of rendered reply text, in order. */
function textNodes(el: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * Mark the words each highlight quotes in the reply rendered in `root` (its `.markdown` blocks, each on
 * its own: a quote does not run from one into the next). Returns what takes the marks off again.
 */
export function markQuotes(root: HTMLElement, marks: readonly ReviewHighlight[]): () => void {
  const added: { h: Highlight; range: Range }[] = [];
  const blocks = [...root.querySelectorAll('.markdown')].map(textNodes);
  for (const mark of marks) {
    if (!mark.quote) continue;
    const h = highlightFor(mark.kind);
    if (!h) break;
    for (const nodes of blocks) {
      const span = findQuote(
        nodes.map((n) => n.data),
        mark.quote,
      );
      if (!span) continue;
      const range = document.createRange();
      range.setStart(nodes[span.start.part]!, span.start.offset);
      range.setEnd(nodes[span.end.part]!, span.end.offset);
      h.add(range);
      added.push({ h, range });
      break;
    }
  }
  return () => {
    for (const { h, range } of added) h.delete(range);
  };
}

/** Bring a message into view (a reply, or a review card) and flash it for a moment. */
export function revealMessage(elementId: string): void {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  // Restarted on each click: the class is put back on the next frame.
  requestAnimationFrame(() => {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  });
}

/** The element ids a review links: a reply, and a review card. */
export const replyElementId = (messageId: string) => `msg-${messageId}`;
export const reviewElementId = (messageId: string) => `review-${messageId}`;
