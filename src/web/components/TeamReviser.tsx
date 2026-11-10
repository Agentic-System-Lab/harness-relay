import { useEffect, useId, useRef, useState } from 'react';
import { REVISE_REQUEST_MAX, type MessageMeta } from '../../shared/types';
import { api } from '../api';
import { askAllowed, reviseRequest, revisionOutcome, sameTeam, type TeamChange } from '../chat';
import { teamChangeText } from '../copy';
import { useT } from '../i18n';
import { Logo } from './Logo';
import { MetaText, hasMeta } from './MessageItem';
import type { Team } from './TeamEditor';

interface Props {
  convId: string;
  /** The team in the drawer: the one the lead agent changes. */
  team: Team;
  /**
   * The team the drawer's copy was made from (`base`): a new one (the drawer loaded the team again)
   * clears what the lead agent said about the copy before.
   */
  base: Team;
  /** The drawer cannot save its team (it changed underneath): nothing to ask for until it is loaded again. */
  blocked: boolean;
  /** Who the lead agent is (Settings), named in the note. */
  leadText: string;
  onChange: (team: Team) => void;
  /** Told while the lead agent works: the drawer holds still, and cannot be saved meanwhile. */
  onBusy: (busy: boolean) => void;
}

/** What the lead agent did last: why, what changed, the team before and after (for Undo), its cost. */
interface Done {
  reason: string;
  changes: TeamChange[];
  before: Team;
  after?: Team;
  meta?: MessageMeta;
}

/**
 * The team drawer's "Ask the lead agent": the user says how the team should change, and the lead agent
 * changes the team in the drawer. Nothing is saved: the user reviews the team (what changed is listed)
 * and saves it, or undoes the change. Closing the drawer stops the lead agent.
 */
export function TeamReviser({ convId, team, base, blocked, leadText, onChange, onBusy }: Props) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** When the lead agent last answered (or was stopped): a click right after it does not ask again. */
  const answeredAt = useRef<number | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  /** The drawer now: its team and whether it can save it may change while the lead agent works. */
  const latest = useRef({ team, blocked });
  latest.current = { team, blocked };
  useEffect(() => () => abort.current?.abort(), []);
  // The drawer loaded the team again: what the lead said was about the copy before.
  useEffect(() => {
    setDone(null);
    setError('');
  }, [base]);

  const ask = async () => {
    const request = text.trim();
    if (!request || busy || blocked || !askAllowed(answeredAt.current, Date.now())) return;
    const sent = team;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    onBusy(true);
    setError('');
    setDone(null);
    try {
      const revision = await api.reviseTeam(convId, reviseRequest(request, sent), ctrl.signal);
      const outcome = revisionOutcome({ sent, now: latest.current.team, blocked: latest.current.blocked, revision });
      if (outcome.kind === 'stale') {
        setError(t.revise.changedMeanwhile);
        return;
      }
      if (outcome.kind === 'changed') onChange(outcome.team);
      setDone({
        reason: revision.reason,
        changes: outcome.kind === 'changed' ? outcome.changes : [],
        before: sent,
        after: outcome.kind === 'changed' ? outcome.team : undefined,
        meta: revision.meta,
      });
      // Kept when nothing changed, to say it another way.
      if (outcome.kind === 'changed') setText('');
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) abort.current = null;
      answeredAt.current = Date.now();
      setBusy(false);
      onBusy(false);
    }
  };

  // Once the lead agent is done, the button may be disabled (the box was emptied): focus that was on
  // it, or fell to the page, goes back to the box, so the keyboard stays here.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const active = document.activeElement;
      if (active === button.current || active === document.body || active === null) box.current?.focus();
    }
    wasBusy.current = busy;
  }, [busy]);

  // Undo only while the team is still as the lead agent left it: later edits are not thrown away.
  const undoable = done?.after && sameTeam(team, done.after);

  return (
    <section className="team-reviser" aria-labelledby={titleId}>
      <div className="team-reviser-head">
        <Logo size={16} />
        <h3 id={titleId}>{t.revise.title}</h3>
      </div>
      <p className="muted small" id={hintId}>
        {t.revise.hint(leadText)}
      </p>
      {/* Read-only, not disabled, while the lead agent works: the box keeps the focus. */}
      <textarea
        ref={box}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        rows={2}
        value={text}
        maxLength={REVISE_REQUEST_MAX}
        placeholder={t.revise.placeholder}
        readOnly={busy}
        aria-busy={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void ask();
          }
        }}
      />
      <div className="team-reviser-actions">
        {busy && (
          <span className="muted small" role="status">
            <span className="tool-icon spin" aria-hidden>
              ◌
            </span>{' '}
            {t.revise.working(leadText)}
          </span>
        )}
        {/* One button for asking and stopping, so the focus stays on it. */}
        <button
          ref={button}
          type="button"
          className={`${busy ? 'ghost' : 'primary'} small-button`}
          disabled={!busy && (!text.trim() || blocked)}
          onClick={() => (busy ? abort.current?.abort() : void ask())}
        >
          {busy ? t.revise.stop : t.revise.submit}
        </button>
      </div>
      {error && (
        <p className="error-line small" role="alert">
          {error}
        </p>
      )}
      {done && (
        <div className="team-reviser-result" role="status">
          {done.reason && <p>{done.reason}</p>}
          {done.changes.length > 0 && (
            <div className="team-reviser-changes small">
              <span>{t.revise.changesTitle}</span>
              <ul>
                {done.changes.map((c, i) => (
                  <li key={i}>{teamChangeText(c, t)}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="small">
            {done.after ? t.revise.review : t.revise.unchanged}
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
          {hasMeta(done.meta) && <MetaText m={done.meta} />}
        </div>
      )}
    </section>
  );
}
