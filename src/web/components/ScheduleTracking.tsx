import { useState } from 'react';
import { TRACKING_LIMITS, type ConversationSchedule } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { hashFor } from '../route';
import { formatWhen, hookExample } from '../schedule';
import { CopyButton } from './CopyButton';

/**
 * Where the goal a schedule tracks stands: its status, a retry under way, and what the runs said of it,
 * the newest first (each linked to the chat it was written in, when a schedule opened it).
 */
export function ScheduleProgress({ schedule }: { schedule: ConversationSchedule }) {
  const { t, lang } = useI18n();
  const tracking = schedule.tracking;
  const status = tracking?.status ?? 'working';
  const notes = [...(tracking?.notes ?? [])].reverse().slice(0, TRACKING_LIMITS.shown);
  return (
    <section className="schedule-progress" aria-label={t.schedule.progress.label}>
      <h3 className="schedule-sub">
        {t.schedule.progress.title} <span className={`progress-badge progress-${status}`}>{t.schedule.progress.status[status]}</span>
      </h3>
      {tracking?.retry && <p className="small warn-text">{t.schedule.progress.retry(formatWhen(tracking.retry.at, lang))}</p>}
      {notes.length === 0 ? (
        <p className="small muted">{t.schedule.progress.empty}</p>
      ) : (
        <ol className="progress-notes">
          {notes.map((n, i) => (
            <li key={`${n.at}-${i}`} className={`progress-note progress-${n.status}`}>
              <span className="small muted">
                {formatWhen(n.at, lang)}
                {n.agent ? ` · @${n.agent}` : ''} · {t.schedule.progress.status[n.status]}
                {n.chatId && (
                  <>
                    {' · '}
                    <a className="link-button" href={hashFor({ page: 'chat', id: n.chatId })}>
                      {t.schedule.progress.openChat}
                    </a>
                  </>
                )}
              </span>
              {n.text && <span className="progress-text">{n.text}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The schedule's webhook: add one (its token shown this once, with a command to call it: curl, or PowerShell's on Windows), make a
 * new token, or remove it.
 */
export function ScheduleHookPanel({
  convId,
  schedule,
  onError,
}: {
  convId: string;
  schedule: ConversationSchedule;
  onError: (message: string) => void;
}) {
  const { t, lang } = useI18n();
  const [shown, setShown] = useState<{ token: string; url: string; platform: string }>();
  const [busy, setBusy] = useState(false);
  const hook = schedule.hook;

  const create = async () => {
    if (hook && !confirm(t.schedule.hook.confirmReplace)) return;
    setBusy(true);
    try {
      const made = await api.createScheduleHook(convId);
      setShown({ token: made.token, url: made.url, platform: made.platform });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(t.schedule.hook.confirmRemove)) return;
    setBusy(true);
    try {
      await api.deleteScheduleHook(convId);
      setShown(undefined);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const example = shown ? hookExample(shown.url, shown.token, shown.platform) : '';
  return (
    <section className="schedule-hook" aria-label={t.schedule.hook.title}>
      <h3 className="schedule-sub">{t.schedule.hook.title}</h3>
      <p className="small muted">{t.schedule.hook.intro}</p>
      {hook && (
        <p className="small">
          {t.schedule.hook.created(formatWhen(hook.createdAt, lang))} ·{' '}
          {hook.lastAt !== undefined ? t.schedule.hook.lastCalled(formatWhen(hook.lastAt, lang)) : t.schedule.hook.never}
        </p>
      )}
      {shown && (
        <div className="hook-token">
          <span className="small">{t.schedule.hook.once}</span>
          <code className="hook-example">{example}</code>
          <CopyButton className="ghost small-button" text={() => example} />
        </div>
      )}
      <div className="schedule-status-actions">
        <button type="button" className="ghost small-button" disabled={busy} onClick={create}>
          {hook ? t.schedule.hook.replace : t.schedule.hook.create}
        </button>
        {hook && (
          <button type="button" className="ghost small-button danger" disabled={busy} onClick={remove}>
            {t.schedule.hook.remove}
          </button>
        )}
      </div>
    </section>
  );
}
