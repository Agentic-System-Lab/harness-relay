import { useMemo } from 'react';
import { lineCount } from '../files';
import { highlightHtml } from '../highlight';

/** Highlighting a very long file would hold up the page; past this it is shown as plain text. */
const HIGHLIGHT_MAX_CHARS = 200_000;

/** Text with line numbers, highlighted when the language is known and the file is not too long. */
export function CodeView({ text, language }: { text: string; language?: string }) {
  const html = useMemo(() => {
    if (!language || text.length > HIGHLIGHT_MAX_CHARS) return null;
    try {
      // Escaped text in <span class="hljs-…"> elements only (highlightHtml).
      return highlightHtml(text, language);
    } catch {
      return null;
    }
  }, [text, language]);
  const numbers = useMemo(() => Array.from({ length: Math.max(1, lineCount(text)) }, (_, i) => i + 1).join('\n'), [text]);
  return (
    <div className="code-view">
      <pre className="code-lines" aria-hidden="true">
        {numbers}
      </pre>
      {html !== null ? (
        <pre className="code-text hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-text">{text}</pre>
      )}
    </div>
  );
}
