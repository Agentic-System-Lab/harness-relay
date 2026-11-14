import { useEffect, useState } from 'react';
import type { GH_MISSING, GH_SIGNED_OUT, SharedPage } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { hashFor, sectionId } from '../route';
import { filesGistUrl, ghProblem, shareScope } from '../share';
import { GhHelp } from './GhHelp';
import { SectionTitle } from './SectionTitle';

type Note = { text: string; error?: boolean };

/**
 * The conversations shared as public links (secret gists), the newest first: open one to see what it
 * shows (or its gists on GitHub), and remove those that should go (their gists are deleted, the one
 * with the files that went along too), one at a time or several at once.
 */
export function SharesCard() {
  const { t, lang } = useI18n();
  const l = t.share.list;
  const [shares, setShares] = useState<SharedPage[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>({ text: '' });
  /** The GitHub CLI is missing or not signed in: what to do about it. */
  const [gh, setGh] = useState<typeof GH_MISSING | typeof GH_SIGNED_OUT>();

  useEffect(() => {
    api.listShares().then(setShares, (e: Error) => setNote({ text: e.message, error: true }));
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const all = shares !== null && shares.length > 0 && selected.size === shares.length;

  /** Removes them one by one, so each that goes leaves the list at once and one that fails stays. */
  const remove = async (ids: string[]) => {
    if (!ids.length || !confirm(l.confirm(ids.length))) return;
    setBusy(true);
    setNote({ text: '' });
    setGh(undefined);
    const failed: string[] = [];
    let problem: typeof GH_MISSING | typeof GH_SIGNED_OUT | undefined;
    let removed = 0;
    for (const id of ids) {
      try {
        await api.deleteShare(id);
        removed++;
        setShares((s) => s?.filter((x) => x.id !== id) ?? s);
        setSelected((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      } catch (e) {
        failed.push(l.failed(shares?.find((x) => x.id === id)?.title ?? id, (e as Error).message));
        problem = ghProblem(e);
        // Without a usable gh the others would fail the same way: stop and say what to do.
        if (problem) break;
      }
    }
    setBusy(false);
    setGh(problem);
    setNote(failed.length ? { text: failed.join('\n'), error: true } : { text: l.removed(removed) });
  };

  const when = (ms: number) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="card" id={sectionId('shares')}>
      <SectionTitle section="shares">{l.title}</SectionTitle>
      <p className="muted small">{l.hint}</p>
      {shares === null ? (
        !note.text && <p className="muted small">{t.common.loading}</p>
      ) : shares.length === 0 ? (
        <p className="muted small">{l.empty}</p>
      ) : (
        <>
          <div className="share-list-bar">
            <label className="check-row">
              <input
                type="checkbox"
                checked={all}
                disabled={busy}
                onChange={() => setSelected(all ? new Set() : new Set(shares.map((s) => s.id)))}
              />
              {l.selectAll}
            </label>
            <button
              type="button"
              className="ghost small-button danger"
              disabled={busy || selected.size === 0}
              onClick={() => void remove(shares.filter((s) => selected.has(s.id)).map((s) => s.id))}
            >
              {busy ? l.removing : l.removeSelected(selected.size)}
            </button>
          </div>
          <ul className="share-list">
            {shares.map((s) => (
              <li key={s.id} className={`share-row ${selected.has(s.id) ? 'selected' : ''}`}>
                <input type="checkbox" checked={selected.has(s.id)} disabled={busy} onChange={() => toggle(s.id)} aria-label={s.title} />
                <div className="share-row-text">
                  {/* An unfinished share has no page: only its files gist, on GitHub (if GitHub gave its address). */}
                  {s.unfinished ? (
                    s.gistUrl ? (
                      <a className="share-row-title" href={s.gistUrl} target="_blank" rel="noreferrer" title={s.gistUrl}>
                        {s.title}
                      </a>
                    ) : (
                      <span className="share-row-title">{s.title}</span>
                    )
                  ) : (
                    <a className="share-row-title" href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                      {s.title}
                    </a>
                  )}
                  {s.unfinished && <span className="small warn-text">{l.unfinished}</span>}
                  <span className="muted small">
                    {shareScope(s, t)} · {s.files ? `${l.files(s.files)} · ` : ''}
                    {when(s.createdAt)} ·{' '}
                    {s.conversationGone ? l.chatGone : <a href={hashFor({ page: 'chat', id: s.conversationId })}>{l.openChat}</a>}
                    {s.gistUrl && (
                      <>
                        {' · '}
                        <a href={s.gistUrl} target="_blank" rel="noreferrer" title={s.gistUrl}>
                          {s.unfinished ? l.openFiles : l.openGist}
                        </a>
                      </>
                    )}
                    {s.filesGist && !s.unfinished && (
                      <>
                        {' · '}
                        <a href={filesGistUrl(s.filesGist)} target="_blank" rel="noreferrer">
                          {l.openFiles}
                        </a>
                      </>
                    )}
                  </span>
                </div>
                <button type="button" className="ghost small-button danger" disabled={busy} onClick={() => void remove([s.id])}>
                  {l.remove}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {note.text && <p className={note.error ? 'error-line share-note' : 'muted small'}>{note.text}</p>}
      {gh && <GhHelp problem={gh} retry={t.share.gh.retryRemove} onSignedIn={() => setNote({ text: '' })} />}
    </section>
  );
}
