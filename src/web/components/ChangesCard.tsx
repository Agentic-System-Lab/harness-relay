import { useState } from 'react';
import type { MessageChanges } from '../../shared/types';
import { useT } from '../i18n';

const PREVIEW = 8;

export type ApplyState = 'available' | 'stale' | undefined;

interface Props {
  changes: MessageChanges;
  agentName: string;
  /** Only the agent's latest isolated result can be applied. */
  applyState: ApplyState;
  onDiff: (scope: 'turn' | 'agent') => void;
  onApply: () => Promise<void>;
}

/** Files an agent changed in one turn, with diff and (for worktree results) apply actions. */
export function ChangesCard({ changes, agentName, applyState, onDiff, onApply }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const { files } = changes;
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  const shown = expanded ? files : files.slice(0, PREVIEW);

  const apply = async () => {
    if (!confirm(t.changes.confirmApply(agentName))) return;
    setBusy(true);
    try {
      await onApply();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="changes-card">
      <div className="changes-head">
        <strong>{t.changes.files(files.length)}</strong>
        <span className="diffstat">
          <span className="plus">+{added}</span> <span className="minus">−{deleted}</span>
        </span>
        <span className={`changes-where ${changes.isolated ? 'isolated' : ''}`}>
          {changes.isolated ? t.changes.inWorktree(changes.branch ?? '') : t.changes.written}
        </span>
      </div>
      <ul className="changes-files">
        {shown.map((f) => (
          <li key={f.path}>
            <span className={`file-status s-${f.status}`} title={t.changes.status[f.status]}>
              {f.status}
            </span>
            <code className="file-path">{f.path}</code>
            <span className="diffstat small">
              {f.added === null ? (
                'binary'
              ) : (
                <>
                  {f.added > 0 && <span className="plus">+{f.added}</span>}{' '}
                  {(f.deleted ?? 0) > 0 && <span className="minus">−{f.deleted}</span>}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {files.length > PREVIEW && (
        <button className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? t.changes.collapse : t.changes.more(files.length - PREVIEW)}
        </button>
      )}
      <div className="changes-actions">
        <button className="ghost small-button" onClick={() => onDiff('turn')}>
          {t.changes.turnDiff}
        </button>
        {applyState === 'available' && (
          <>
            <button className="ghost small-button" onClick={() => onDiff('agent')}>
              {t.changes.agentResult(agentName)}
            </button>
            <button className="primary small-button" onClick={apply} disabled={busy}>
              {busy ? t.changes.applying : t.changes.apply}
            </button>
          </>
        )}
        {applyState === 'stale' && <span className="muted small">{t.changes.stale}</span>}
      </div>
    </div>
  );
}

/** A unified diff, coloured per line. */
export function DiffView({ text }: { text: string }) {
  const t = useT();
  const lines = text.split('\n');
  const max = 6000;
  return (
    <pre className="diff-view">
      {lines.slice(0, max).map((line, i) => {
        const cls = line.startsWith('diff --git')
          ? 'd-file'
          : line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')
            ? 'd-meta'
            : line.startsWith('@@')
              ? 'd-hunk'
              : line.startsWith('+')
                ? 'd-add'
                : line.startsWith('-')
                  ? 'd-del'
                  : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
      {lines.length > max && <div className="d-meta">{t.changes.moreLines(lines.length - max)}</div>}
    </pre>
  );
}
