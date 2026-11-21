import { useId, useMemo, useState } from 'react';
import type { FileChange, MessageChanges } from '../../shared/types';
import { diffLineClass, diffTotals, parseDiff } from '../diff';
import { useT } from '../i18n';
import { ChevronIcon } from './icons';

const PREVIEW = 8;

export type ApplyState = 'available' | 'stale' | undefined;

interface Props {
  /** One entry for each repository the turn changed. */
  changes: MessageChanges[];
  agentName: string;
  /** Only the agent's latest isolated result can be applied. */
  applyState: ApplyState;
  onDiff: (scope: 'turn' | 'agent') => void;
  onApply: () => Promise<void>;
}

/**
 * Files an agent changed in one turn, with diff and (for worktree results) apply actions. A turn that
 * changed more than one repository (the conversation has several working directories) lists the
 * files under each one's folder.
 */
export function ChangesCard({ changes, agentName, applyState, onDiff, onApply }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const sets = changes.filter((c) => c.files.length);
  const files = sets.flatMap((c) => c.files);
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  const isolated = sets.find((c) => c.isolated);
  // The first PREVIEW files in all, in their repositories' order.
  let room = expanded ? files.length : PREVIEW;
  const groups = sets
    .map((c) => {
      const shown = c.files.slice(0, Math.max(0, room));
      room -= shown.length;
      return { root: c.root, shown };
    })
    .filter((g) => g.shown.length);

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
        <span className={`changes-where ${isolated ? 'isolated' : ''}`}>
          {isolated ? t.changes.inWorktree(isolated.branch ?? '') : t.changes.written}
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.root} className="changes-repo">
          {sets.length > 1 && (
            <div className="changes-repo-name muted small" title={g.root}>
              📁 {g.root}
            </div>
          )}
          <FileList files={g.shown} />
        </div>
      ))}
      {files.length > PREVIEW && (
        <button className="link-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
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

/** Files changed in one repository. */
function FileList({ files }: { files: FileChange[] }) {
  return (
    <ul className="changes-files">
      {files.map((f) => (
        <li key={f.path}>
          <FileStatus status={f.status} />
          <code className="file-path">{f.path}</code>
          <FileStat added={f.added} deleted={f.deleted} />
        </li>
      ))}
    </ul>
  );
}

/** A file's status as its letter, read out as its word ("Added"). */
function FileStatus({ status }: { status: FileChange['status'] }) {
  const t = useT();
  return (
    <span className={`file-status s-${status}`} title={t.changes.status[status]}>
      <span aria-hidden="true">{status}</span>
      <span className="visually-hidden">{t.changes.status[status]}</span>
    </span>
  );
}

/** A file's lines added and removed, or that it is binary (null). */
function FileStat({ added, deleted }: { added: number | null; deleted: number | null }) {
  const t = useT();
  return (
    <span className="diffstat small">
      {added === null ? (
        t.changes.binary
      ) : (
        <>
          {added > 0 && <span className="plus">+{added}</span>} {(deleted ?? 0) > 0 && <span className="minus">−{deleted}</span>}
        </>
      )}
    </span>
  );
}

/** The most lines a file's section shows. */
const MAX_LINES = 6000;

/**
 * A unified diff, one section for each file: its status, path and lines added and removed, folded
 * until opened, so that the files it changed are seen at once and each one's lines only when asked
 * for (`Expand all` opens them all). A diff the server cut short says so in its head (its counts
 * are those of what is shown), and the file it was cut in says so too.
 */
export function DiffView({ text }: { text: string }) {
  const t = useT();
  const id = useId();
  const diff = useMemo(() => parseDiff(text), [text]);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  // Text that is not git's (no file in it): its lines as they are.
  if (!diff.files.length) return <DiffLines lines={text.split('\n')} header={false} />;
  const { added, deleted } = diffTotals(diff.files);
  const allOpen = open.size === diff.files.length;
  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <div className="diff-files">
      <div className="diff-files-head">
        <strong>{diff.notes.length ? t.changes.filesShown(diff.files.length) : t.changes.files(diff.files.length)}</strong>
        <span className="diffstat">
          <span className="plus">+{added}</span> <span className="minus">−{deleted}</span>
        </span>
        {diff.files.length > 1 && (
          <button type="button" className="link-button" onClick={() => setOpen(allOpen ? new Set() : new Set(diff.files.map((_, i) => i)))}>
            {allOpen ? t.changes.collapseAll : t.changes.expandAll}
          </button>
        )}
      </div>
      <div className="diff-files-list">
        {diff.lead.length > 0 && <DiffLines lines={diff.lead} header={false} />}
        {diff.files.map((f, i) => {
          const isOpen = open.has(i);
          const body = `${id}-${i}`;
          return (
            <section key={i} className="diff-file">
              <button
                type="button"
                className="diff-file-head"
                aria-expanded={isOpen}
                aria-controls={isOpen ? body : undefined}
                onClick={() => toggle(i)}
              >
                <span className={`group-chevron ${isOpen ? 'open' : ''}`}>
                  <ChevronIcon size={14} />
                </span>
                <FileStatus status={f.status} />
                <code className="file-path">{f.path}</code>
                {f.truncated && <span className="diff-cut">{t.changes.cutShort}</span>}
                <FileStat added={f.added} deleted={f.deleted} />
              </button>
              {isOpen && <DiffLines id={body} lines={f.lines} header />}
            </section>
          );
        })}
      </div>
      {diff.notes.map((note, i) => (
        <p key={i} className="muted small diff-note">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Lines of a diff, coloured: a file's (`header`: its own header first, up to its first hunk, and
 * again after a second `diff --git` line, as a file whose type changed has), or text that is not one
 * file's, with `+` and `-` lines coloured all the way.
 */
function DiffLines({ id, lines, header }: { id?: string; lines: string[]; header: boolean }) {
  const t = useT();
  let inHunks = !header;
  return (
    <pre id={id} className="diff-view">
      {lines.slice(0, MAX_LINES).map((line, i) => {
        if (header && line.startsWith('diff --git ')) inHunks = false;
        else if (line.startsWith('@@')) inHunks = true;
        return (
          <div key={i} className={diffLineClass(line, inHunks)}>
            {line || ' '}
          </div>
        );
      })}
      {lines.length > MAX_LINES && <div className="d-meta">{t.changes.moreLines(lines.length - MAX_LINES)}</div>}
    </pre>
  );
}
