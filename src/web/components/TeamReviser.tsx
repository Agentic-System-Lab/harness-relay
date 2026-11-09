import { useEffect, useId, useRef, useState } from 'react';
import { REVISE_REQUEST_MAX } from '../../shared/types';
import { api } from '../api';
import { revisedTeam, sameTeam, teamTurns } from '../chat';
import { useT } from '../i18n';
import { Logo } from './Logo';
import type { Team } from './TeamEditor';

interface Props {
  convId: string;
  /** The team in the drawer: the one the lead agent changes. */
  team: Team;
  /** Who the lead agent is (Settings), named in the note. */
  leadText: string;
  onChange: (team: Team) => void;
  /** Told while the lead agent works: the drawer holds still, and cannot be saved meanwhile. */
  onBusy: (busy: boolean) => void;
}

/** What the lead agent did last: why, and the team before and after, for Undo. */
interface Done {
  reason: string;
  before: Team;
  after: Team;
  changed: boolean;
}

/**
 * The team drawer's "Ask the lead agent": the user says how the team should change, and the lead agent
 * changes the team in the drawer. Nothing is saved: the user reviews the team and saves it (or undoes
 * the change). Closing the drawer stops the lead agent.
 */
export function TeamReviser({ convId, team, leadText, onChange, onBusy }: Props) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** The drawer's team now: it may change while the lead agent works (the drawer reloaded it). */
  const latest = useRef(team);
  latest.current = team;
  useEffect(() => () => abort.current?.abort(), []);

  const ask = async () => {
    const request = text.trim();
    if (!request || busy) return;
    const sent = team;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    onBusy(true);
    setError('');
    setDone(null);
    try {
      const revision = await api.reviseTeam(convId, { request, ...teamTurns(sent) }, ctrl.signal);
      // The drawer loaded another team meanwhile: the change was made to the one before it.
      if (!sameTeam(latest.current, sent)) {
        setError(t.revise.changedMeanwhile);
        return;
      }
      const after = revisedTeam(sent, revision);
      const changed = !sameTeam(sent, after);
      onChange(after);
      setDone({ reason: revision.reason, before: sent, after, changed });
      // Kept when nothing changed, to say it another way.
      if (changed) setText('');
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy(false);
      onBusy(false);
    }
  };

  // Undo only while the team is still as the lead agent left it: later edits are not thrown away.
  const undoable = done?.changed && sameTeam(team, done.after);

  return (
    <section className="team-reviser" aria-labelledby={titleId}>
      <div className="team-reviser-head">
        <Logo size={16} />
        <h3 id={titleId}>{t.revise.title}</h3>
      </div>
      <p className="muted small" id={hintId}>
        {t.revise.hint(leadText)}
      </p>
      <textarea
        aria-labelledby={titleId}
        aria-describedby={hintId}
        rows={2}
        value={text}
        maxLength={REVISE_REQUEST_MAX}
        placeholder={t.revise.placeholder}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void ask();
          }
        }}
      />
      <div className="team-reviser-actions">
        {busy ? (
          <>
            <span className="muted small" role="status">
              <span className="tool-icon spin" aria-hidden>
                ◌
              </span>{' '}
              {t.revise.working(leadText)}
            </span>
            <button type="button" className="ghost small-button" onClick={() => abort.current?.abort()}>
              {t.revise.stop}
            </button>
          </>
        ) : (
          <button type="button" className="primary small-button" disabled={!text.trim()} onClick={() => void ask()}>
            {t.revise.submit}
          </button>
        )}
      </div>
      {error && (
        <p className="error-line small" role="alert">
          {error}
        </p>
      )}
      {done && (
        <div className="team-reviser-result" role="status">
          {done.reason && <p>{done.reason}</p>}
          <p className="small">
            {done.changed ? t.revise.review : t.revise.unchanged}
            {undoable && (
              <>
                {' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    onChange(done.before);
                    setDone(null);
                  }}
                >
                  {t.revise.undo}
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
