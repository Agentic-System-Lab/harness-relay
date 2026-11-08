import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { localMediaPath } from '../../shared/media';
import { findMentions } from '../../shared/mentions';
import { LocalMedia } from './LocalMedia';
import { MermaidBlock } from './Mermaid';

export { findMentions };

/** The few fields of a Markdown syntax tree (mdast) node used here. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  identifier?: string;
  label?: string | null;
  referenceType?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const MENTION = { hName: 'span', hProperties: { className: ['mention'] } };

function splitMentions(node: MdNode, names: string[]): MdNode[] {
  const text = node.value ?? '';
  const found = findMentions(text, names);
  if (!found.length) return [node];
  const out: MdNode[] = [];
  let last = 0;
  for (const { start, end } of found) {
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'text', value: text.slice(start, end), data: MENTION });
    last = end;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** An image as a link to it (or just its text inside another link: links do not nest). */
function imageAsLink(img: MdNode, inLink: boolean): MdNode {
  const text: MdNode = { type: 'text', value: img.alt || img.url || img.label || '' };
  if (inLink) return text;
  const data = { hProperties: { className: ['image-link'] } };
  return img.type === 'image'
    ? { type: 'link', url: img.url, title: img.title, children: [text], data }
    : { type: 'linkReference', identifier: img.identifier, label: img.label, referenceType: img.referenceType, children: [text], data };
}

/** A text node with each line break in it turned into a break node (`<br>`). */
function splitLines(node: MdNode): MdNode[] {
  const lines = (node.value ?? '').split(/\r?\n/);
  if (lines.length === 1) return [node];
  return lines.flatMap((line, i) => [...(i ? [{ type: 'break' }] : []), ...(line ? [{ type: 'text', value: line }] : [])]);
}

interface RelayOptions {
  names: string[];
  media: boolean;
  breaks: boolean;
}

function transform(node: MdNode, inLink: boolean, opts: RelayOptions): void {
  if (!node.children) return;
  const link = inLink || node.type === 'link' || node.type === 'linkReference';
  node.children = node.children.flatMap((child) => {
    // A file on this computer is shown (by path, through the server); anything else is a link.
    const local = opts.media && !link && child.type === 'image' ? localMediaPath(child.url ?? '') : undefined;
    if (local) return [{ ...child, data: { hProperties: { dataMedia: local } } }];
    if (child.type === 'image' || child.type === 'imageReference') return [imageAsLink(child, link)];
    // Code (inline, fenced, indented) is its own node type, so only prose text gets here.
    if (child.type === 'text') {
      const lines = opts.breaks ? splitLines(child) : [child];
      return link ? lines : lines.flatMap((n) => (n.type === 'text' ? splitMentions(n, opts.names) : [n]));
    }
    transform(child, link, opts);
    return [child];
  });
}

/**
 * Agent output is untrusted. Images become links: loading them would let a prompt-injected agent call
 * any URL. With `media`, images and videos that are files on this computer are kept, to be shown from
 * this app's server. And @mentions of the team (and `@user`) are highlighted in prose, not in code or link text.
 * With `breaks`, every line break in prose is kept (Markdown joins the lines of a paragraph).
 */
export function remarkRelay({ mentions, media = false, breaks = false }: { mentions: string[]; media?: boolean; breaks?: boolean }) {
  const names = mentions.length ? [...mentions, 'user'] : [];
  return (tree: MdNode) => transform(tree, false, { names, media, breaks });
}

const rehypePlugins: Options['rehypePlugins'] = [[rehypeHighlight, { detect: false, ignoreMissing: true, plainText: ['mermaid'] }]];

/** The few fields of an HTML syntax tree (hast) node used here. */
interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; dataMedia?: unknown };
  children?: HtmlNode[];
}

const textOf = (node: HtmlNode): string => (node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join(''));

/** The source of a ```mermaid code block, given its <pre>. */
export function mermaidSource(pre: HtmlNode | undefined): string | undefined {
  const code = pre?.children?.find((c) => c.type === 'element');
  const classes = code?.tagName === 'code' ? code.properties?.className : undefined;
  return code && Array.isArray(classes) && classes.includes('language-mermaid') ? textOf(code) : undefined;
}

/** East Asian wide characters (CJK, kana, Hangul, full-width forms, emoji): about 1em each. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6\p{Emoji_Presentation}]/u;

/** Roughly how wide `text` is on one line, in em: wide characters take 1em, the rest about half. */
export function textWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) em += WIDE.test(ch) ? 1 : 0.55;
  return em;
}

/** Keep in step with `min-width` of `.markdown td.wrap` in styles.css. */
const CELL_WRAP_EM = 12;

/**
 * How a table cell is laid out, so that a wide table scrolls sideways instead of squeezing its columns
 * down to a letter per line: a short cell stays on one line ('one-line'); a longer one wraps, but no
 * narrower than CELL_WRAP_EM ('wrap').
 */
export function tableCellClass(text: string): 'one-line' | 'wrap' {
  return textWidthEm(text.trim()) <= CELL_WRAP_EM ? 'one-line' : 'wrap';
}

function makeComponents(mediaBase: string | undefined): Components {
  return {
    th: ({ node, ...props }) => <th {...props} className={tableCellClass(node ? textOf(node as HtmlNode) : '')} />,
    td: ({ node, ...props }) => <td {...props} className={tableCellClass(node ? textOf(node as HtmlNode) : '')} />,
    a: ({ href, className, children }) => (
      <a href={href} className={className} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    pre: ({ node, children, ...props }) => {
      const mermaid = mermaidSource(node as HtmlNode | undefined);
      return mermaid === undefined ? <pre {...props}>{children}</pre> : <MermaidBlock code={mermaid} />;
    },
    // Only local media reach here as images (see remarkRelay); nothing else is ever loaded.
    img: ({ node, alt }) => {
      const path = (node as HtmlNode | undefined)?.properties?.dataMedia;
      return typeof path === 'string' && mediaBase ? (
        <LocalMedia src={`${mediaBase}?path=${encodeURIComponent(path)}`} path={path} alt={alt ?? ''} />
      ) : null;
    },
  };
}

/**
 * `mediaBase`: the URL that serves this message's images and videos (`…/media`); without it, every
 * image is a link. `breaks`: show each line break as it was typed (the user's own messages), instead of
 * joining the lines of a paragraph as Markdown does.
 */
export const Markdown = memo(function Markdown({
  text,
  mentions = [],
  mediaBase,
  breaks = false,
}: {
  text: string;
  mentions?: string[];
  mediaBase?: string;
  breaks?: boolean;
}) {
  const components = useMemo(() => makeComponents(mediaBase), [mediaBase]);
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkRelay, { mentions, media: Boolean(mediaBase), breaks }]]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
