import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { StepsPart } from '../../shared/steps';
import { STEPS_LIMITS } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { answerBody, firstOpen, shownDone, stepMark, stepWords, stepsCardState, unsettled } from '../steps';
import { CheckIcon, StepsIcon } from './icons';
import { Markdown } from './Markdown';

/** Where the note being written for a card waits in this tab, should the chat be left and opened again. */
const draftKey = (messageId: string) => `relay:steps-note:${messageId}`;

function readDraft(messageId: string): string {
  try {
    return sessionStorage.getItem(draftKey(messageId)) ?? '';
  } catch {
    return '';
  }
}

function keepDraft(messageId: string, note: string): void {
  try {
    if (note) sessionStorage.setItem(draftKey(messageId), note);
    else sessionStorage.removeItem(draftKey(messageId));
  } catch {
    /* not kept: the note stays while the card is on screen */
  }
}

/**
 * Steps an agent asked the user to take outside Harness Relay (its `<steps>` block): a box to tick for
 * each as they go, kept on the server; then Done (with the steps not ticked reported as not done), or
 * "I'm stuck" at a step, with a note either way. The answer is posted as the user's message and the
 * team goes on, the agent that asked first. Once answered, the card shows the answer and no longer changes.
 */
export function StepsCard({
  part,
  convId,
  messageId,
  agentName,
  waiting,
  othersWaiting,
  mentions,
  mediaBase,
  downloadBase,
  onPreview,
}: {
  part: StepsPart;
  convId: string;
  messageId: string;
  agentName: string;
  /** The team waits for this reply's answer now. */
  waiting: boolean;
  /** Other agents that wait for the user too, as `@name`s: an answer here goes to this one alone. */
  othersWaiting?: string;
  mentions: string[];
  mediaBase?: string;
  downloadBase?: string;
  onPreview?: (path: string) => void;
}) {
  const t = useT();
  const c = t.stepCard;
  const id = useId();
  const state = stepsCardState(part, waiting);
  const editable = state === 'waiting';
  const [pending, setPending] = useState<Map<number, boolean>>(() => new Map());
  // A tick the server shows back (here, or from another browser) is no longer on its way.
  useEffect(() => setPending((p) => (p.size ? unsettled(part, p) : p)), [part]);
  const done = editable ? shownDone(part, pending) : part.items.map((s) => Boolean(s.done));
  const [note, setNote] = useState(() => readDraft(messageId));
  const [stuckAt, setStuckAt] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stuckRef = useRef<HTMLSelectElement>(null);
  const total = part.items.length;
  const count = done.filter(Boolean).length;
  const answer = part.answer;

  // The card as the server has it now, for a tick's answer that comes after it.
  const latest = useRef(part);
  useLayoutEffect(() => {
    latest.current = part;
  }, [part]);
  const stuck = stuckAt !== undefined;
  // "I'm stuck" asks where first.
  useEffect(() => {
    if (stuck) stuckRef.current?.focus();
  }, [stuck]);

  const drop = (i: number) =>
    setPending((p) => {
      const next = new Map(p);
      next.delete(i);
      return next;
    });
  const tick = async (i: number, value: boolean) => {
    setPending((p) => new Map(p).set(i, value));
    setError('');
    try {
      await api.tickStep(convId, messageId, i, value);
      // The server had it so already (it then shows nothing back), or showed it back first.
      if (Boolean(latest.current.items[i]?.done) === value) drop(i);
    } catch (e) {
      drop(i);
      setError((e as Error).message);
    }
  };

  const send = async (at?: number) => {
    setBusy(true);
    setError('');
    try {
      await api.answerSteps(convId, messageId, answerBody(done, at, note));
      keepDraft(messageId, '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const markText = { done: c.stepDone, open: c.stepOpen, stuck: c.stepStuck };
  const status = answer ? (answer.stuckAt !== undefined ? c.answeredStuck(answer.stuckAt + 1) : c.answered) : c.count(count, total);

  return (
    <section className={`steps-card steps-card-${state}`} id={editable ? `ask-${messageId}` : undefined} aria-labelledby={`${id}-title`}>
      <header className="steps-head">
        <span className="steps-icon" aria-hidden>
          <StepsIcon size={16} />
        </span>
        <strong id={`${id}-title`}>{c.label(agentName)}</strong>
        <span className="steps-status">{status}</span>
      </header>
      {editable && <p className="steps-wait">{c.waiting(agentName)}</p>}
      {editable && othersWaiting && <p className="steps-wait steps-others">{c.othersWaiting(othersWaiting, agentName)}</p>}
      <ol className="steps-list">
        {part.items.map((s, i) => {
          const mark = stepMark(part, done, i);
          return (
            <li key={i} className={`step-item step-${mark}`}>
              <span className="step-check">
                {editable && (
                  <input
                    type="checkbox"
                    className="step-input"
                    checked={done[i]}
                    disabled={busy}
                    aria-labelledby={`${id}-n${i} ${id}-s${i}`}
                    onChange={(e) => void tick(i, e.target.checked)}
                  />
                )}
                <span className="step-box" aria-hidden>
                  {mark === 'done' ? <CheckIcon size={14} /> : mark === 'stuck' ? '!' : null}
                </span>
              </span>
              <span className="step-num" id={`${id}-n${i}`}>
                {i + 1}.{!editable && <span className="visually-hidden">{` (${markText[mark]})`}</span>}
              </span>
              <div className="step-text" id={`${id}-s${i}`}>
                <Markdown text={s.text} mentions={mentions} mediaBase={mediaBase} downloadBase={downloadBase} onPreview={onPreview} />
              </div>
            </li>
          );
        })}
      </ol>
      {answer?.note && (
        <p className="steps-note">
          <strong>{c.note}</strong> <span className="steps-note-text">{answer.note}</span>
        </p>
      )}
      {state === 'closed' && <p className="muted small steps-closed">{c.closed}</p>}
      {editable && (
        <div className="steps-actions">
          {stuckAt !== undefined && (
            <label className="steps-field">
              <span>{c.stuckAt}</span>
              <select ref={stuckRef} value={stuckAt} disabled={busy} onChange={(e) => setStuckAt(Number(e.target.value))}>
                {part.items.map((s, i) => (
                  <option key={i} value={i}>
                    {c.stepOption(i + 1, stepWords(s.text))}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="steps-field">
            <span>{c.noteLabel}</span>
            <textarea
              rows={2}
              value={note}
              maxLength={STEPS_LIMITS.noteChars}
              disabled={busy}
              placeholder={stuckAt !== undefined ? c.stuckPlaceholder : c.notePlaceholder}
              onChange={(e) => {
                setNote(e.target.value);
                keepDraft(messageId, e.target.value);
              }}
            />
          </label>
          {stuckAt === undefined && count < total && <p className="muted small steps-hint">{c.untickedHint}</p>}
          <div className="approval-actions">
            {stuckAt === undefined ? (
              <>
                <button type="button" className="primary small-button" disabled={busy} onClick={() => void send()}>
                  {count === total ? c.done : c.doneSome(count, total)}
                </button>
                <button type="button" className="ghost small-button" disabled={busy} onClick={() => setStuckAt(firstOpen(done))}>
                  {c.stuck}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="primary small-button" disabled={busy} onClick={() => void send(stuckAt)}>
                  {c.sendStuck}
                </button>
                <button type="button" className="ghost small-button" disabled={busy} onClick={() => setStuckAt(undefined)}>
                  {t.common.cancel}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
