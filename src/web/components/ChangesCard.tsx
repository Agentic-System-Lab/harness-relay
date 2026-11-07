import { useState } from 'react';
import type { MessageChanges } from '../../shared/types';

const STATUS_LABEL = { A: '新增', M: '修改', D: '刪除' } as const;
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
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const { files } = changes;
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  const shown = expanded ? files : files.slice(0, PREVIEW);

  const apply = async () => {
    if (!confirm(`把 @${agentName} 的修改套用到工作目錄？\n會直接修改工作目錄中的檔案（不會 commit）。`)) return;
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
        <strong>改了 {files.length} 個檔案</strong>
        <span className="diffstat">
          <span className="plus">+{added}</span> <span className="minus">−{deleted}</span>
        </span>
        <span className={`changes-where ${changes.isolated ? 'isolated' : ''}`}>
          {changes.isolated ? `在 worktree · ${changes.branch ?? ''}` : '已寫入工作目錄'}
        </span>
      </div>
      <ul className="changes-files">
        {shown.map((f) => (
          <li key={f.path}>
            <span className={`file-status s-${f.status}`} title={STATUS_LABEL[f.status]}>
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
          {expanded ? '收合' : `還有 ${files.length - PREVIEW} 個檔案…`}
        </button>
      )}
      <div className="changes-actions">
        <button className="ghost small-button" onClick={() => onDiff('turn')}>
          查看這回合 diff
        </button>
        {applyState === 'available' && (
          <>
            <button className="ghost small-button" onClick={() => onDiff('agent')}>
              查看 @{agentName} 的完整結果
            </button>
            <button className="primary small-button" onClick={apply} disabled={busy}>
              {busy ? '套用中…' : '套用到工作目錄'}
            </button>
          </>
        )}
        {applyState === 'stale' && <span className="muted small">工作目錄已更新（已套用其中一份結果）</span>}
      </div>
    </div>
  );
}

/** A unified diff, coloured per line. */
export function DiffView({ text }: { text: string }) {
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
      {lines.length > max && <div className="d-meta">… 還有 {lines.length - max} 行未顯示</div>}
    </pre>
  );
}
