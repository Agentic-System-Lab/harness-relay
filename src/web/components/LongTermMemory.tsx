import { useEffect, useState } from 'react';
import { MEMORY_LIMITS, type MemoryNote, type MemorySettings, type MemoryState, type MemoryView } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import {
  authorText,
  firstFilter,
  folderName,
  folderOptions,
  memoryCounts,
  memoryManaged,
  replacedBy,
  shownNotes,
  tidyStatus,
} from '../memory';
import { PinIcon } from './icons';

/** How often the view is read again while the lead agent tidies the notes. */
const TIDY_POLL_MS = 3000;

/**
 * Settings → Labs → Long-term memory: its switches, the lead agent's tidying, and every note, by state,
 * to keep, change, pin, set aside, restore or delete. Off (the default) with no notes kept, only its
 * explanation and the switch that turns it on (`memoryManaged()`).
 */
export function LongTermMemorySection() {
  const { t, lang } = useI18n();
  const m = t.longTerm;
  const [view, setView] = useState<MemoryView>();
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<MemoryState>();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [draftCwd, setDraftCwd] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (call: () => Promise<MemoryView>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      setView(await call());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(() => api.memory());
    api
      .cwds()
      .then((w) => setFolders(w.dirs.map((d) => d.path)))
      .catch(() => undefined);
  }, []);

  // While the lead agent tidies, its changes show up as they are made.
  useEffect(() => {
    if (!view?.tidying) return;
    const timer = setInterval(() => {
      api
        .memory()
        .then(setView)
        .catch(() => undefined);
    }, TIDY_POLL_MS);
    return () => clearInterval(timer);
  }, [view?.tidying]);

  if (!view) return error ? <p className="error-line">{error}</p> : <p className="muted small">{t.common.loading}</p>;

  const counts = memoryCounts(view.notes);
  const state = filter ?? firstFilter(counts);
  const notes = shownNotes(view.notes, state, query);
  const when = (ms: number) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  const setting = (patch: Partial<MemorySettings>) => void run(() => api.memorySettings(patch));
  const options = folderOptions(view.notes, folders);

  return (
    <div className="long-term-memory">
      <p className="muted small">{m.hint}</p>
      <label className="check-row">
        <input type="checkbox" checked={view.settings.enabled} disabled={busy} onChange={(e) => setting({ enabled: e.target.checked })} />
        <span>{m.enabled}</span>
      </label>
      {memoryManaged(view) && (
        <>
          <fieldset className="memory-options" disabled={!view.settings.enabled || busy}>
            <label className="check-row">
              <input type="checkbox" checked={view.settings.review} onChange={(e) => setting({ review: e.target.checked })} />
              <span>{m.review}</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={view.settings.autoTidy} onChange={(e) => setting({ autoTidy: e.target.checked })} />
              <span>{m.autoTidy}</span>
            </label>
            <p className="muted small">{m.autoTidyHint(MEMORY_LIMITS.tidyAfterChanges, MEMORY_LIMITS.tidyHours)}</p>
            <div className="button-row memory-tidy">
              <span className="muted small" role="status">
                {tidyStatus(t, view, when)}
              </span>
              <button
                type="button"
                className="ghost small-button"
                disabled={view.tidying || !counts.active}
                onClick={() => void run(() => api.tidyMemory())}
              >
                {m.tidyNow}
              </button>
            </div>
          </fieldset>

          <div className="memory-add">
            <textarea
              className="memory-note-input"
              rows={2}
              value={draft}
              maxLength={MEMORY_LIMITS.noteChars}
              aria-label={m.add}
              placeholder={m.addPlaceholder}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="button-row">
              <label className="memory-scope">
                <span className="small">{m.scope}</span>
                <select value={draftCwd} onChange={(e) => setDraftCwd(e.target.value)}>
                  <option value="">{m.everywhere}</option>
                  {options.map((f) => (
                    <option key={f} value={f} title={f}>
                      {m.folder(folderName(f))}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy || !draft.trim()}
                onClick={async () => {
                  if (await run(() => api.addMemoryNote({ text: draft, ...(draftCwd ? { cwd: draftCwd } : {}) }))) {
                    setDraft('');
                    setFilter('active');
                  }
                }}
              >
                {m.add}
              </button>
            </div>
          </div>

          <div className="memory-list-head">
            <div className="segmented" role="tablist" aria-label={m.title}>
              {(['active', 'pending', 'archived'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={state === s}
                  className={state === s ? 'on' : ''}
                  onClick={() => setFilter(s)}
                >
                  {m.filters[s](counts[s])}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="memory-search"
              value={query}
              placeholder={m.search}
              aria-label={m.search}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </>
      )}
      {error && <p className="error-line">{error}</p>}
      {memoryManaged(view) &&
        (notes.length ? (
          <ul className="memory-list">
            {notes.map((n) => (
              <NoteRow key={n.id} note={n} view={view} options={options} when={when} busy={busy} run={run} />
            ))}
          </ul>
        ) : (
          <p className="muted small">{query.trim() ? m.noMatch : m.empty[state]}</p>
        ))}
    </div>
  );
}

function NoteRow({
  note: n,
  view,
  options,
  when,
  busy,
  run,
}: {
  note: MemoryNote;
  view: MemoryView;
  options: string[];
  when: (ms: number) => string;
  busy: boolean;
  run: (call: () => Promise<MemoryView>) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const m = t.longTerm;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.text);
  const [cwd, setCwd] = useState(n.cwd ?? '');
  const source = n.conversationId ? view.sources[n.conversationId] : undefined;
  const after = n.state === 'archived' ? replacedBy(view.notes, n.id) : undefined;
  const folders = n.cwd && !options.includes(n.cwd) ? [n.cwd, ...options] : options;

  return (
    <li className={`memory-row memory-${n.state}`}>
      {editing ? (
        <div className="memory-edit">
          <textarea
            className="memory-note-input"
            rows={3}
            value={text}
            maxLength={MEMORY_LIMITS.noteChars}
            aria-label={m.edit}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="button-row">
            <label className="memory-scope">
              <span className="small">{m.scope}</span>
              <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
                <option value="">{m.everywhere}</option>
                {folders.map((f) => (
                  <option key={f} value={f} title={f}>
                    {m.folder(folderName(f))}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !text.trim()}
              onClick={async () => {
                const patch = { ...(text !== n.text ? { text } : {}), ...(cwd !== (n.cwd ?? '') ? { cwd: cwd || null } : {}) };
                if (await run(() => api.editMemoryNote(n.id, patch))) setEditing(false);
              }}
            >
              {t.common.save}
            </button>
          </div>
        </div>
      ) : (
        <p className="memory-row-text">
          {n.pinned && (
            <span
              className="memory-pin"
              title={n.pinned === 'user' ? m.pinned : m.pinnedByLead}
              aria-label={n.pinned === 'user' ? m.pinned : m.pinnedByLead}
            >
              <PinIcon size={14} upright />
            </span>
          )}
          {n.text}
        </p>
      )}
      <p className="memory-meta muted small">
        <span title={n.cwd}>{n.cwd ? m.folder(folderName(n.cwd)) : m.everywhere}</span>
        <span>{m.basis[n.basis]}</span>
        <span>{m.by(authorText(t, n))}</span>
        <span>{when(n.updatedAt)}</span>
        {source !== undefined && <span>{m.from(source)}</span>}
        {n.replaces?.length ? <span>{m.replaces(n.replaces.length)}</span> : null}
        {after && <span>{m.replacedBy(after)}</span>}
        {n.reason && <span>{m.reason(n.reason)}</span>}
        <code className="memory-id">{n.id}</code>
      </p>
      {!editing && (
        <div className="memory-row-actions">
          {n.state === 'pending' && (
            <>
              <button
                type="button"
                className="primary small-button"
                disabled={busy}
                onClick={() => void run(() => api.editMemoryNote(n.id, { state: 'active' }))}
              >
                {m.keep}
              </button>
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => void run(() => api.deleteMemoryNote(n.id))}
              >
                {m.discard}
              </button>
            </>
          )}
          {n.state === 'active' && (
            <button
              type="button"
              className="ghost small-button"
              disabled={busy}
              onClick={() => void run(() => api.editMemoryNote(n.id, { pinned: !n.pinned }))}
            >
              {n.pinned ? m.unpin : m.pin}
            </button>
          )}
          {n.state !== 'archived' && (
            <button
              type="button"
              className="ghost small-button"
              disabled={busy}
              onClick={() => {
                setText(n.text);
                setCwd(n.cwd ?? '');
                setEditing(true);
              }}
            >
              {m.edit}
            </button>
          )}
          {n.state === 'active' && (
            <button
              type="button"
              className="ghost small-button"
              disabled={busy}
              onClick={() => void run(() => api.editMemoryNote(n.id, { state: 'archived' }))}
            >
              {m.archive}
            </button>
          )}
          {n.state === 'archived' && (
            <>
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => void run(() => api.editMemoryNote(n.id, { state: 'active' }))}
              >
                {m.restore}
              </button>
              <button
                type="button"
                className="ghost small-button danger-text"
                disabled={busy}
                onClick={() => {
                  if (confirm(m.deleteConfirm)) void run(() => api.deleteMemoryNote(n.id));
                }}
              >
                {m.delete}
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
