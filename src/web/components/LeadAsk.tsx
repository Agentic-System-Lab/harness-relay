import { useEffect, useId, useRef, useState } from 'react';
import { REVISE_REQUEST_MAX, type MessageMeta } from '../../shared/types';
import { BUTTON_HOLD_MS, buttonHeld, focusBoxAfterAnswer } from '../chat';
import { useT } from '../i18n';
import { Logo, LogoSpinner } from './Logo';
import { MetaText, hasMeta } from './MessageItem';

/** What the lead agent answered, once the editor shows it. */
export interface LeadAnswer {
  /** What the lead agent said about it, for the user. */
  reason: string;
  /** What changed in the editor, a line each; none: the lead agent left it as it was. */
  changes: string[];
  /** Puts the editor back as it was before the answer; only when something changed. */
  undo?: () => void;
  /** Whether the editor is still as the answer left it: Undo is offered only then, so later edits are not thrown away. */
  undoable?: () => boolean;
  meta?: MessageMeta;
}

interface Props {
  title: string;
  hint: string;
  placeholder: string;
  /** The button's text (the team drawer's "Ask the lead agent" by default). */
  submit?: string;
  /** Said while the lead agent works. */
  working: string;
  /** Said under the answer when something changed (what the user does next) and when nothing did. */
  review: string;
  unchanged: string;
  /** Said when the editor changed while the lead agent worked, so its answer was not applied. */
  changedMeanwhile: string;
  /**
   * Asks the lead agent, and applies its answer to the editor: resolves to it, or to `'stale'` when the
   * editor changed meanwhile and nothing was applied. Rejects with the reason it could not be had.
   */
  ask: (request: string, signal: AbortSignal) => Promise<LeadAnswer | 'stale'>;
  /** Nothing can be asked now (the editor cannot be saved as it is). */
  blocked?: boolean;
  /** Changes when the editor is loaded again: what the lead agent said was about it as it was before. */
  resetKey?: unknown;
  /** Told while the lead agent works: the editor holds still meanwhile. */
  onBusy?: (busy: boolean) => void;
}

/**
 * "Ask the lead agent" in an editor: the user says what they want, and the lead agent changes what the
 * editor holds (a team, a template, team checks, a schedule). Nothing is saved: the user reviews the
 * change (what changed is listed) and saves it, or undoes it. Leaving the editor stops the lead agent.
 */
export function LeadAsk({
  title,
  hint,
  placeholder,
  submit: submitText,
  working,
  review,
  unchanged,
  changedMeanwhile,
  ask,
  blocked = false,
  resetKey,
  onBusy,
}: Props) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<LeadAnswer | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** When the button last changed (Ask ⇄ Stop): it is held for a moment after (`buttonHeld`). */
  const changedAt = useRef<number | undefined>(undefined);
  const [held, setHeld] = useState(false);
  const hold = () => {
    const at = Date.now();
    changedAt.current = at;
    setHeld(true);
    // Cleared by the timer of the latest change (a clock read a moment early must not keep it held).
    setTimeout(() => changedAt.current === at && setHeld(false), BUTTON_HOLD_MS);
  };
  const box = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  // The editor was loaded again: what the lead said was about it as it was.
  useEffect(() => {
    setDone(null);
    setError('');
  }, [resetKey]);

  const submit = async () => {
    const request = text.trim();
    if (!request || busy || blocked || buttonHeld(changedAt.current, Date.now())) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    hold();
    setBusy(true);
    onBusy?.(true);
    setError('');
    setDone(null);
    try {
      const answer = await ask(request, ctrl.signal);
      if (answer === 'stale') {
        setError(changedMeanwhile);
        return;
      }
      setDone(answer);
      // Kept when nothing changed, to say it another way.
      if (answer.changes.length) setText('');
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) abort.current = null;
      hold();
      setBusy(false);
      onBusy?.(false);
    }
  };

  // Once the lead agent is done, focus that would be lost (on the page, or on the button now disabled
  // because the box was emptied) goes back to the box, so the keyboard stays here.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const active = document.activeElement;
      const onPage = active === document.body || active === null;
      if (focusBoxAfterAnswer({ onPage, onButton: active === button.current, buttonDisabled: Boolean(button.current?.disabled) })) {
        box.current?.focus({ preventScroll: true });
      }
    }
    wasBusy.current = busy;
  }, [busy]);
  const stop = () => {
    if (!buttonHeld(changedAt.current, Date.now())) abort.current?.abort();
  };

  const undoable = Boolean(done?.undo && (done.undoable?.() ?? true));

  return (
    <section className="team-reviser" aria-labelledby={titleId}>
      <div className="team-reviser-head">
        <Logo size={16} />
        <h3 id={titleId}>{title}</h3>
      </div>
      <p className="muted small" id={hintId}>
        {hint}
      </p>
      {/* Read-only, not disabled, while the lead agent works: the box keeps the focus. */}
      <textarea
        ref={box}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        rows={2}
        value={text}
        maxLength={REVISE_REQUEST_MAX}
        placeholder={placeholder}
        readOnly={busy}
        aria-busy={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="team-reviser-actions">
        {busy && (
          <span className="muted small" role="status">
            <LogoSpinner /> {working}
          </span>
        )}
        {/* One button for asking and stopping, so the focus stays on it while the lead agent works.
            Held for a moment after it changes: dimmed (aria-disabled keeps the focus), clicks do nothing. */}
        <button
          ref={button}
          type="button"
          className={`${busy ? 'ghost' : 'primary'} small-button ${held ? 'held' : ''}`}
          disabled={!busy && (!text.trim() || blocked)}
          aria-disabled={held || undefined}
          onClick={() => (busy ? stop() : void submit())}
        >
          {busy ? t.revise.stop : (submitText ?? t.revise.submit)}
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
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="small">
            {done.changes.length ? review : unchanged}
            {undoable && (
              <>
                {' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    done.undo?.();
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
