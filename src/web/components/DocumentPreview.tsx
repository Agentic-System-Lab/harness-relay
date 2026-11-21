import type { OutboxPreview } from '../../shared/types';
import { useT } from '../i18n';

export function DocumentPreview({ document }: { document: NonNullable<OutboxPreview['document']> }) {
  const t = useT().outbox.document;
  const id = document.id;
  const tab = document.tabId;
  const url = id && /^[A-Za-z0-9_-]+$/.test(id) ? new URL('https://docs.google.com/document/d/' + id + '/edit') : undefined;
  if (url && tab) url.searchParams.set('tab', tab);
  return (
    <div className="document-preview">
      <dl className="outbox-fields">
        <div>
          <dt>{t.account}</dt>
          <dd>{document.account}</dd>
        </div>
        <div>
          <dt>{t.document}</dt>
          <dd>
            {url ? (
              <a href={url.href} target="_blank" rel="noreferrer">
                {document.title}
              </a>
            ) : (
              document.title
            )}
          </dd>
        </div>
        {document.tab && (
          <div>
            <dt>{t.tab}</dt>
            <dd>{document.tab}</dd>
          </div>
        )}
      </dl>
      {document.before !== null && (
        <div className="note-removed">
          <strong>{t.before}</strong>
          <pre className="outbox-body">{document.before}</pre>
        </div>
      )}
      <div className={document.before !== null ? 'note-added' : undefined}>
        <strong>{document.before !== null ? t.after : t.content}</strong>
        {document.after ? (
          <pre className="outbox-body">{document.after}</pre>
        ) : (
          <p className="muted small">{document.before === null ? t.blank : t.removed}</p>
        )}
      </div>
    </div>
  );
}

/** Only link the canonical Google Docs URL constructed by the Relay tool. */
export function DocumentResult({ text }: { text: string }) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit$/.test(line));
  if (index < 0) return <>{text}</>;
  const url = lines[index]!;
  return (
    <>
      {lines
        .slice(0, index)
        .map((line) => line + '\n')
        .join('')}
      <a href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      {lines
        .slice(index + 1)
        .map((line) => '\n' + line)
        .join('')}
    </>
  );
}
