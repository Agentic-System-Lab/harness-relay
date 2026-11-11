import { useMemo } from 'react';
import { SCHEDULE_KINDS, SCHEDULE_LIMITS, type ConversationSchedule, type ConversationSettings } from '../../shared/types';
import { mentionWarning } from '../copy';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { browserTimeZone, draftProblems, formatWhen, localInput, previewRuns, shownZone, type ScheduleDraft } from '../schedule';

/** Monday first, as a week is read. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * A schedule's form: the message, when it is sent, where (this chat or a new one each time), and what
 * happens when nobody is watching. Shared by the schedule drawer and the New schedule page.
 */
export function ScheduleForm({
  draft,
  onEdit,
  saved,
  settings,
  team,
}: {
  draft: ScheduleDraft;
  onEdit: (patch: Partial<ScheduleDraft>) => void;
  /** The schedule saved so far: an interval keeps its cadence while its times stay the same. */
  saved?: ConversationSchedule;
  /** The conversation's settings (or the new one's): the hints depend on its mode and permission. */
  settings: Pick<ConversationSettings, 'mode' | 'permission' | 'approvals'>;
  /** The team's names; absent while there is no team yet (the lead agent names its members after the @mentions). */
  team?: string[];
}) {
  const { t, lang } = useI18n();
  const { turnTimeoutMinutes } = useLimits();
  // @mentions that reach nobody on the team.
  const warning = useMemo(() => (team ? mentionWarning(draft.text, team, t, 'form') : undefined), [draft.text, team, t]);
  const now = Date.now();
  // The preview under the times is about the times: a message still to be typed is said elsewhere.
  const problems = draftProblems({ ...draft, text: draft.text.trim() || '-' }, now, t);
  const upcoming = problems.length ? [] : previewRuns(draft, now, saved);
  const { mode, permission } = settings;
  /** Times of day are in the schedule's time zone; a moment or an interval does not depend on one. */
  const localZone = browserTimeZone();
  const draftZone = shownZone({ repeat: { kind: draft.kind }, timeZone: draft.timeZone });

  const toggleDay = (day: number) =>
    onEdit({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });

  return (
    <section className="schedule-form">
      <label className="field">
        <span>{t.schedule.message}</span>
        <textarea
          value={draft.text}
          rows={4}
          maxLength={SCHEDULE_LIMITS.maxText}
          placeholder={t.schedule.messagePlaceholder}
          onChange={(e) => onEdit({ text: e.target.value })}
        />
        <span className="small muted">{team ? t.schedule.messageHint : t.schedule.messageHintNoTeam}</span>
        {warning && <span className="small warn-text">{warning}</span>}
      </label>

      <div className="field">
        <span>{t.schedule.repeat}</span>
        <div className="segmented wide" role="radiogroup" aria-label={t.schedule.repeat}>
          {SCHEDULE_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={draft.kind === k} className={draft.kind === k ? 'on' : ''} onClick={() => onEdit({ kind: k })}>
              {t.schedule.kinds[k]}
            </button>
          ))}
        </div>

        {draft.kind === 'once' && (
          <input
            type="datetime-local"
            className="schedule-input"
            aria-label={t.schedule.at}
            value={draft.at}
            min={localInput(now)}
            onChange={(e) => onEdit({ at: e.target.value })}
          />
        )}

        {(draft.kind === 'daily' || draft.kind === 'weekly') && (
          <div className="schedule-when">
            {draft.kind === 'weekly' && (
              <div className="day-picker" role="group" aria-label={t.schedule.days}>
                {WEEK.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={draft.days.includes(d) ? 'on' : ''}
                    aria-pressed={draft.days.includes(d)}
                    aria-label={t.schedule.weekdayNames[d]}
                    title={t.schedule.weekdayNames[d]}
                    onClick={() => toggleDay(d)}
                  >
                    {t.schedule.weekdays[d]}
                  </button>
                ))}
              </div>
            )}
            <input
              type="time"
              className="schedule-input"
              aria-label={t.schedule.time}
              value={draft.time}
              onChange={(e) => onEdit({ time: e.target.value })}
            />
          </div>
        )}

        {draft.kind === 'interval' && (
          <label className="field inline">
            <span>{t.schedule.every}</span>
            <input
              type="number"
              min={1}
              max={SCHEDULE_LIMITS.maxHours}
              value={Number.isNaN(draft.hours) ? '' : draft.hours}
              onChange={(e) => onEdit({ hours: e.target.value === '' ? NaN : Number(e.target.value) })}
            />
            <span className="unit muted small">
              {t.schedule.hoursUnit} · {t.schedule.intervalHint}
            </span>
          </label>
        )}

        <span className="small muted schedule-preview">
          {problems.length
            ? problems[0]
            : upcoming.length
              ? `${t.schedule.upcoming} ${upcoming.map((at) => formatWhen(at, lang, draftZone)).join(t.common.listSeparator)}`
              : t.schedule.never}
          {draftZone && (
            <>
              {' · '}
              {t.schedule.timeZone(draft.timeZone)}
              {draft.timeZone !== localZone && (
                <>
                  {' · '}
                  <button type="button" className="link-button" onClick={() => onEdit({ timeZone: localZone })}>
                    {t.schedule.useLocalZone(localZone)}
                  </button>
                </>
              )}
            </>
          )}
        </span>
      </div>

      <div className="field">
        <label className="check-row">
          <input type="checkbox" checked={draft.newChat} onChange={(e) => onEdit({ newChat: e.target.checked })} />
          {t.schedule.newChat}
        </label>
        <span className="small muted">{t.schedule.newChatHint[draft.newChat ? 'on' : 'off']}</span>
        {draft.newChat && mode === 'parallel' && permission !== 'read-only' && (
          <span className="small warn-text">{t.schedule.newChatParallel}</span>
        )}
      </div>

      <h3 className="schedule-sub">{t.schedule.unattended}</h3>

      <div className="field">
        <span>{t.schedule.approvals}</span>
        <div className="segmented wide" role="radiogroup" aria-label={t.schedule.approvals}>
          {(['deny', 'ask'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={draft.approvals === v} className={draft.approvals === v ? 'on' : ''} onClick={() => onEdit({ approvals: v })}>
              {v === 'deny' ? t.schedule.approvalsDeny : t.schedule.approvalsAsk}
            </button>
          ))}
        </div>
        <span className="small muted">
          {permission === 'full'
            ? t.schedule.approvalsFull
            : settings.approvals === 'deny'
              ? t.schedule.approvalsTeamDeny
              : draft.approvals === 'ask'
                ? t.schedule.approvalsHint.ask(turnTimeoutMinutes)
                : t.schedule.approvalsHint.deny}
        </span>
      </div>

      <div className="field">
        <span>{t.schedule.missed}</span>
        <div className="segmented wide" role="radiogroup" aria-label={t.schedule.missed}>
          {(['skip', 'run'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={draft.missed === v} className={draft.missed === v ? 'on' : ''} onClick={() => onEdit({ missed: v })}>
              {v === 'skip' ? t.schedule.missedSkip : t.schedule.missedRun}
            </button>
          ))}
        </div>
        <span className="small muted">{t.schedule.missedHint[draft.missed]}</span>
      </div>
    </section>
  );
}
