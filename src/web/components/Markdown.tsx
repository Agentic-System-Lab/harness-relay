import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/** Highlight @mentions outside code by turning them into inline links the CSS styles as chips. */
function linkMentions(text: string, names: string[]): string {
  if (!names.length) return text;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(^|[^\\w@\`/])@(${alt}|user)(?![\\p{L}\\p{N}_-])`, 'giu');
  // Leave fenced code untouched.
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((chunk) => (chunk.startsWith('```') ? chunk : chunk.replace(re, (_m, pre, name) => `${pre}[@${name}](#mention)`)))
    .join('');
}

export const Markdown = memo(function Markdown({ text, mentions = [] }: { text: string; mentions?: string[] }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) =>
            href === '#mention' ? (
              <span className="mention">{children}</span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {linkMentions(text, mentions)}
      </ReactMarkdown>
    </div>
  );
});
