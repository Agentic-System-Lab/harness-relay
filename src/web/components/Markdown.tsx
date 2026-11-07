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

function transform(node: MdNode, inLink: boolean, names: string[], media: boolean): void {
  if (!node.children) return;
  const link = inLink || node.type === 'link' || node.type === 'linkReference';
  node.children = node.children.flatMap((child) => {
    // A file on this computer is shown (by path, through the server); anything else is a link.
    const local = media && !link && child.type === 'image' ? localMediaPath(child.url ?? '') : undefined;
    if (local) return [{ ...child, data: { hProperties: { dataMedia: local } } }];
    if (child.type === 'image' || child.type === 'imageReference') return [imageAsLink(child, link)];
    // Code (inline, fenced, indented) is its own node type, so only prose text gets here.
    if (child.type === 'text') return link ? [child] : splitMentions(child, names);
    transform(child, link, names, media);
    return [child];
  });
}

/**
 * Agent output is untrusted. Images become links: loading them would let a prompt-injected agent call
 * any URL. With `media`, images and videos that are files on this computer are kept, to be shown from
 * this app's server. And @mentions of the team (and `@user`) are highlighted in prose, not in code or link text.
 */
export function remarkRelay({ mentions, media = false }: { mentions: string[]; media?: boolean }) {
  const names = mentions.length ? [...mentions, 'user'] : [];
  return (tree: MdNode) => transform(tree, false, names, media);
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

function makeComponents(mediaBase: string | undefined): Components {
  return {
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
 * image is a link.
 */
export const Markdown = memo(function Markdown({
  text,
  mentions = [],
  mediaBase,
}: {
  text: string;
  mentions?: string[];
  mediaBase?: string;
}) {
  const components = useMemo(() => makeComponents(mediaBase), [mediaBase]);
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkRelay, { mentions, media: Boolean(mediaBase) }]]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
