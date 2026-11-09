/*
 * Where a bare URL ends (one written without `<…>` or `[text](…)`). GFM ends it only at a space, so in
 * Chinese or Japanese, written without spaces, the words right after it become part of the link:
 * `檢查https://github.com/a/b及https://github.com/a/c是否…` is one long link to nowhere. Here a bare URL
 * also ends at CJK or full-width punctuation (`，。、「」（）`…, curly quotes, dashes, the ellipsis), and at
 * a CJK character that cannot start or continue a part of the URL: one that follows neither another CJK
 * character nor `/ ? # & = . - _ + (`. So `/wiki/臺灣_(消歧義)`, `?q=中文` and `https://中文.tw` stay links,
 * while `…/WrenAI-saas及…` and `…/Foo_(bar)及…` end before `及`. GFM's trailing punctuation (`.`, `,`, `)`…) is
 * then left out as it would be before a space. Used by the UI (what is a link) and by the @mention rule
 * (what is prose), so both read a message alike.
 */

/** Characters no URL written in prose contains: CJK and full-width punctuation, curly quotes, dashes, the ellipsis. */
const STOP = '\\u2014\\u2015\\u2018\\u2019\\u201c\\u201d\\u2026\\u3000-\\u303f\\uff00-\\uffef';
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}';
const URL_END = new RegExp(`[\\s<${STOP}]|(?<![/?#&=.\\-_+(${CJK}])[${CJK}]`, 'u');

/** Where GFM finds a bare URL: `http(s)://` after anything but an ASCII letter; `www.` after a space or punctuation. */
const URL_START = /(?<![A-Za-z])https?:\/\/(?=[A-Za-z0-9])|(?<=^|[\s\p{P}\p{S}])www\.(?=[A-Za-z0-9])/giu;

/** Trailing punctuation GFM leaves out of a bare URL (a `)` only when it closes no `(` in the URL). */
const TRAILING = '!"\'),.:;?]}*_~';

const count = (text: string, ch: string) => text.split(ch).length - 1;

/** How much of `url`, a bare URL with the text after it, is the URL (see above). */
export function urlLength(url: string): number {
  const stop = URL_END.exec(url);
  if (!stop) return url.length;
  let end = stop.index;
  while (end > 0 && TRAILING.includes(url[end - 1]!)) {
    if (url[end - 1] === ')' && count(url.slice(0, end), '(') >= count(url.slice(0, end), ')')) break;
    end--;
  }
  // Nothing left after `https://` or `www.`: no link at all.
  return /^(?:https?:\/\/|www\.)?$/i.test(url.slice(0, end)) ? 0 : end;
}

/** A piece of text, with the URL it links to when it is a bare URL. */
export interface TextPart {
  text: string;
  url?: string;
}

const href = (text: string) => (/^www\./i.test(text) ? `http://${text}` : text);

/** `text` split into prose and the bare URLs in it, each ending as above (and at a space or `<`). */
export function splitUrls(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const prose = (t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.url === undefined) last.text += t;
    else parts.push({ text: t });
  };
  const starts = new RegExp(URL_START.source, URL_START.flags);
  let done = 0;
  for (let m = starts.exec(text); m; m = starts.exec(text)) {
    const length = urlLength(text.slice(m.index));
    if (!length) continue;
    prose(text.slice(done, m.index));
    const url = text.slice(m.index, m.index + length);
    parts.push({ text: url, url: href(url) });
    done = m.index + length;
    starts.lastIndex = done;
  }
  prose(text.slice(done));
  return parts;
}

/** The few fields of a Markdown syntax tree (mdast) node used here. */
export interface LinkNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: LinkNode[];
  position?: { start: { offset?: number } };
}

/**
 * The nodes a link GFM found as a bare URL stands for, ended as above: the link, then the prose after
 * it, with any further bare URLs in that prose as links. Undefined for any other link (`<…>`,
 * `[text](…)`, an e-mail address), or a URL that ends where GFM ended it.
 */
function endBareLink(link: LinkNode): LinkNode[] | undefined {
  const child = link.children?.length === 1 ? link.children[0] : undefined;
  const value = child?.type === 'text' ? (child.value ?? '') : '';
  if (!/^(?:https?:\/\/|www\.)/i.test(value) || link.url !== href(value)) return undefined;
  // `<…>` and `[text](…)` start a character before their text; a bare URL is its own text.
  if (link.position?.start.offset !== child?.position?.start.offset) return undefined;
  const length = urlLength(value);
  if (length === value.length) return undefined;
  const parts = length ? [{ text: value.slice(0, length), url: href(value.slice(0, length)) }, ...splitUrls(value.slice(length))] : splitUrls(value);
  return parts.map(({ text, url }) =>
    url === undefined ? { type: 'text', value: text } : { type: 'link', title: null, url, children: [{ type: 'text', value: text }] },
  );
}

/** Adjacent text nodes as one, so the prose after a URL that was ended reads as one piece. */
function joinTexts(nodes: LinkNode[]): LinkNode[] {
  const out: LinkNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text') out[out.length - 1] = { type: 'text', value: (last.value ?? '') + (node.value ?? '') };
    else out.push(node);
  }
  return out;
}

/** End every bare URL in a Markdown syntax tree as above (GFM ends them only at a space). */
export function endBareUrls(node: LinkNode): void {
  if (!node.children) return;
  let ended = false;
  const children = node.children.flatMap((child) => {
    // Links do not nest, so there are no bare URLs inside one.
    if (child.type !== 'link') {
      endBareUrls(child);
      return [child];
    }
    const parts = endBareLink(child);
    if (parts) ended = true;
    return parts ?? [child];
  });
  node.children = ended ? joinTexts(children) : children;
}
