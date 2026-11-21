import type { OutboxPreview } from '../../shared/types';
import { useT } from '../i18n';
import { changeBlocks, noteFormat } from '../notePreview';

export function NotePreview({ note }: { note: NonNullable<OutboxPreview['note']> }) {
  const n = useT().outbox.note;
  const blocks = note.before === null ? undefined : changeBlocks(note.before, note.after);
  const version = (value: string) => {
    if (!value) return <p className="small muted">{n.empty}</p>;
    const { bom, lineEnding, finalNewline } = noteFormat(value);
    const style = lineEnding === 'mixed' ? n.mixed : lineEnding;
    return (
      <>
        <pre className="outbox-body">{value}</pre>
        <small>{[bom ? n.bom : '', style, finalNewline ? n.newline : n.noNewline].filter(Boolean).join(' · ')}</small>
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
