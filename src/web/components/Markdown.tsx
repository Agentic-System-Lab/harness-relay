import { memo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { findMentions } from '../../shared/mentions';

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

function transform(node: MdNode, inLink: boolean, names: string[]): void {
  if (!node.children) return;
  const link = inLink || node.type === 'link' || node.type === 'linkReference';
  node.children = node.children.flatMap((child) => {
    if (child.type === 'image' || child.type === 'imageReference') return [imageAsLink(child, link)];
    // Code (inline, fenced, indented) is its own node type, so only prose text gets here.
    if (child.type === 'text') return link ? [child] : splitMentions(child, names);
    transform(child, link, names);
    return [child];
  });
}

/**
 * Agent output is untrusted. Images become links: loading them would let a prompt-injected agent call
 * any URL. And @mentions of the team (and `@user`) are highlighted in prose, not in code or link text.
 */
export function remarkRelay({ mentions }: { mentions: string[] }) {
  const names = mentions.length ? [...mentions, 'user'] : [];
  return (tree: MdNode) => transform(tree, false, names);
}

const rehypePlugins: Options['rehypePlugins'] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

const components: Components = {
  a: ({ href, className, children }) => (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text, mentions = [] }: { text: string; mentions?: string[] }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkRelay, { mentions }]]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
