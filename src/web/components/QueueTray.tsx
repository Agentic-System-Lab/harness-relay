import { useRef } from 'react';
import type { ChatMessage } from '../../shared/types';
import { useT } from '../i18n';
import { ClockIcon, PaperclipIcon } from './icons';

/**
 * busy: the team replies, the messages go before its next turn; review: the team has answered and the
 * lead agent reviews its replies, the messages go to the team after it; confirm: they wait for the user
 * to confirm the lead agent's team design; folder: they wait for a folder another conversation is
 * changing, and the team starts with them once it is free (Stop stops waiting); stopped: the team was
 * stopped before they were delivered.
 */
export type QueueState = 'busy' | 'review' | 'confirm' | 'folder' | 'stopped';

interface Props {
  queue: ChatMessage[];
  state: QueueState;
  /** Send what is waiting now (stopping the team first when it replies). */
  onSendNow: () => Promise<unknown>;
  /** Take a message back; `edit` puts its text back in the composer. */
  onWithdraw: (msg: ChatMessage, edit: boolean) => Promise<unknown>;
}

const textOf = (m: ChatMessage) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim();

/** The user's messages waiting to be delivered, above the composer. */
export function QueueTray({ queue, state, onSendNow, onWithdraw }: Props) {
  const t = useT();
  // A ref, not state: a quick double click arrives before React re-renders.
  const busy = useRef(false);
  if (queue.length === 0) return null;

  const once = async (fn: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  };

  const title =
    state === 'busy' || state === 'review' || state === 'folder'
      ? t.queue.busy(queue.length)
      : state === 'confirm'
        ? t.queue.confirm
        : t.queue.stopped;

  return (
    <section className={`queue-tray ${state}`} aria-label={t.queue.label}>
      <header className="queue-head">
        <span className="queue-title">{title}</span>
        {state === 'busy' && <span className="queue-note muted">{t.queue.busyNote}</span>}
        {state === 'review' && <span className="queue-note muted">{t.queue.reviewNote}</span>}
        {state === 'folder' && <span className="queue-note muted">{t.queue.folderNote}</span>}
        {state !== 'confirm' && state !== 'folder' && (
          <button type="button" className="ghost small-button" onClick={() => void once(onSendNow)}>
            {state === 'busy' ? t.queue.sendNow : state === 'review' ? t.queue.skipReview : t.queue.send}
          </button>
        )}
      </header>
      <ul>
        {queue.map((m) => {
          const text = textOf(m);
          const files = m.parts.filter((p) => p.type === 'attachment').length;
          return (
            <li key={m.id} className="queue-item">
              {m.scheduled && (
                <span className="queue-scheduled" title={t.schedule.tagTitle}>
                  <ClockIcon size={12} />
                </span>
              )}
              <span className="queue-text" title={text}>
                {text.split('\n')[0]}
              </span>
              {files > 0 && (
                <span className="queue-files muted">
                  <PaperclipIcon size={12} />
                  {t.queue.files(files)}
                </span>
              )}
              {/* Attached files cannot go back into the composer: only text-only messages are edited. */}
              {files === 0 && (
                <button type="button" className="queue-action" onClick={() => void once(() => onWithdraw(m, true))}>
                  {t.queue.edit}
                </button>
              )}
              <button
                type="button"
                className="queue-action"
                onClick={() => void once(() => onWithdraw(m, false))}
                aria-label={`${t.queue.withdraw}: ${text.slice(0, 60)}`}
              >
                {t.queue.withdraw}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
