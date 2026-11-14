import type { ReviewHighlight, ReviewKind } from '../shared/types';
import { findQuote } from '../shared/review';

/*
 * The lead agent's review marks the words it quotes in the replies they come from, with the CSS Custom
 * Highlight API (`::highlight(review-<kind>)` in styles.css): ranges over the reply's rendered text, so
 * nothing in the reply's own DOM changes. A browser without that API shows the review card alone.
 */

/** The ranges marked for each kind, across the chat's replies; and `focus`, the words just jumped to. */
const highlights = new Map<ReviewKind | 'focus', Highlight>();

function highlightFor(kind: ReviewKind | 'focus'): Highlight | undefined {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return undefined;
  let h = highlights.get(kind);
  if (!h) {
    h = new Highlight();
    // The words jumped to show over their kind's colour.
    if (kind === 'focus') h.priority = 1;
    highlights.set(kind, h);
    CSS.highlights.set(`review-${kind}`, h);
  }
  return h;
}

/** The elements that are blocks of a reply's text: words in two of them are apart, with no space between their nodes. */
const BLOCKS = 'p, li, td, th, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, dt, dd, div';

/** The text nodes of one piece of rendered reply text, in order, and which of them start a new block. */
function textNodes(el: Element): { nodes: Text[]; breaks: boolean[] } {
  const nodes: Text[] = [];
  const breaks: boolean[] = [];
  let block: Element | null = null;
  const walker = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const own = n.parentElement?.closest(BLOCKS) ?? null;
    breaks.push(nodes.length > 0 && own !== block);
    block = own;
    nodes.push(n as Text);
  }
  return { nodes, breaks };
}

/**
 * What finds quotes in the reply rendered in `root` (its `.markdown` pieces, each on its own: a quote
 * does not run from one into the next): the range of a quote's words in the first piece that has them.
 * Read once, for the text as it is now: a reply that re-renders needs a new one.
 */
export function quoteFinder(root: Element): (quote: string) => Range | undefined {
  const blocks = [...root.querySelectorAll('.markdown')].map(textNodes);
  return (quote) => {
    for (const { nodes, breaks } of blocks) {
      const span = findQuote(
        nodes.map((n) => n.data),
        quote,
        breaks,
      );
      if (!span) continue;
      const range = (root.ownerDocument ?? document).createRange();
      range.setStart(nodes[span.start.part]!, span.start.offset);
      range.setEnd(nodes[span.end.part]!, span.end.offset);
      return range;
    }
    return undefined;
  };
}

/**
 * Mark the words each highlight quotes in the reply rendered in `root` (see quoteFinder). Returns what
 * takes the marks off again.
 */
export function markQuotes(root: HTMLElement, marks: readonly ReviewHighlight[]): () => void {
  const added: { h: Highlight; range: Range }[] = [];
  const find = quoteFinder(root);
  for (const mark of marks) {
    if (!mark.quote) continue;
    const h = highlightFor(mark.kind);
    if (!h) break;
    const range = find(mark.quote);
    if (!range) continue;
    h.add(range);
    added.push({ h, range });
  }
  return () => {
    for (const { h, range } of added) h.delete(range);
  };
}

/** Whether to move at once: for those who asked for less motion (the flash is turned off for them by the stylesheet). */
const still = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Focus goes along to what a jump brings into view, for keyboards and screen readers (the scroll places it). */
function focusQuietly(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/** Flash an element for a moment: restarted on each click, the class is put back on the next frame. */
function flash(el: HTMLElement): void {
  el.classList.remove('flash');
  requestAnimationFrame(() => {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  });
}

/** Bring a message into view (a reply, or a review card) and flash it for a moment. */
export function revealMessage(elementId: string): void {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
  focusQuietly(el);
  flash(el);
}

/** The nearest ancestor of `el` that scrolls up and down (the chat's message list), else the page. */
function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * How far to scroll for words at `target` (top and height on screen) to stand in the middle of a view
 * at `view`; words taller than most of the view start near its top instead, so their first line shows.
 */
export function scrollToCenter(target: { top: number; height: number }, view: { top: number; height: number }): number {
  if (target.height > view.height * 0.8) return target.top - view.top - 16;
  return target.top + target.height / 2 - (view.top + view.height / 2);
}

/** The words just jumped to: shown over their kind's colour for a moment. */
let focused: { range: Range; timer: ReturnType<typeof setTimeout> } | undefined;

/**
 * Bring the words a review point quotes into view in the reply they come from, and show them for a
 * moment over their kind's colour. A point without words, or whose words the reply no longer has as
 * written, brings the reply into view instead (revealMessage).
 */
export function revealQuote(messageId: string, quote?: string): void {
  const el = document.getElementById(replyElementId(messageId));
  const range = el && quote ? quoteFinder(el)(quote) : undefined;
  if (!el || !range) return revealMessage(replyElementId(messageId));
  const scroller = scrollerOf(el);
  const page = scroller === document.scrollingElement || scroller === document.documentElement;
  const box = page ? { top: 0, height: window.innerHeight } : scroller.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  scroller.scrollBy({ top: scrollToCenter(rect, box), behavior: still() ? 'auto' : 'smooth' });
  focusQuietly(el);
  const h = highlightFor('focus');
  // Without the Highlight API the words cannot be shown apart: the reply flashes as a whole.
  if (!h) return flash(el);
  if (focused) {
    clearTimeout(focused.timer);
    h.delete(focused.range);
  }
  h.add(range);
  const timer = setTimeout(() => {
    h.delete(range);
    if (focused?.range === range) focused = undefined;
  }, 1600);
  focused = { range, timer };
}

/** The element ids a review links: a reply, and a review card. */
export const replyElementId = (messageId: string) => `msg-${messageId}`;
export const reviewElementId = (messageId: string) => `review-${messageId}`;
/** A shared page's mark around the words a review's point quotes (the `index`-th of review `reviewId`): what its @name links to. */
export const quoteElementId = (reviewId: string, index: number) => `quote-${reviewId}-${index}`;
