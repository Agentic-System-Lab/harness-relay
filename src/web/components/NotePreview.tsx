import type { OutboxPreview } from '../../shared/types';
import { useT } from '../i18n';

/** Preserve all lines, including their endings. Show unchanged context once and both versions of the changed block. */
function changeBlocks(before: string, after: string) {
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(before),
    b = lines(after);
  let start = 0,
    tail = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (tail < Math.min(a.length, b.length) - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return {
    context: a.slice(0, start).join(''),
    removed: a.slice(start, a.length - tail).join(''),
    added: b.slice(start, b.length - tail).join(''),
    end: a.slice(a.length - tail).join(''),
  };
}

export function NotePreview({ note }: { note: NonNullable<OutboxPreview['note']> }) {
  const n = useT().outbox.note;
  const blocks = note.before === null ? undefined : changeBlocks(note.before, note.after);
  const version = (value: string) => {
    if (!value) return <p className="small muted">{n.empty}</p>;
    const endings = new Set(value.match(/\r\n|\r|\n/g));
    const style = endings.size > 1 ? n.mixed : endings.has('\r\n') ? 'CRLF' : endings.has('\r') ? 'CR' : endings.has('\n') ? 'LF' : '';
    return (
      <>
        <pre className="outbox-body">{value}</pre>
        <small>
          {[value.startsWith('\uFEFF') ? n.bom : '', style, /[\n\r]$/.test(value) ? n.newline : n.noNewline].filter(Boolean).join(' · ')}
        </small>
      </>
    );
  };
  return (
    <div className="note-preview">
      <dl className="outbox-fields">
        <div>
          <dt>{n.vault}</dt>
          <dd>{note.vault}</dd>
        </div>
        <div>
          <dt>{n.path}</dt>
          <dd>{note.path}</dd>
        </div>
      </dl>
      {blocks && note.before !== note.after ? (
        <div className="note-diff" aria-label={n.changes}>
          {blocks.context && <pre>{blocks.context}</pre>}
          {blocks.removed && (
            <div className="note-removed">
              <strong>{n.removed}</strong>
              <pre>{blocks.removed}</pre>
            </div>
          )}
          {blocks.added && (
            <div className="note-added">
              <strong>{n.added}</strong>
              <pre>{blocks.added}</pre>
            </div>
          )}
          {blocks.end && <pre>{blocks.end}</pre>}
        </div>
      ) : null}
      {note.before !== null ? (
        <details>
          <summary>{n.complete}</summary>
          {[
            { label: n.before, value: note.before },
            { label: n.after, value: note.after },
          ].map(({ label, value }) => (
            <div key={label}>
              <strong>{label}</strong>
              {version(value)}
            </div>
          ))}
        </details>
      ) : (
        version(note.after)
      )}
    </div>
  );
}
