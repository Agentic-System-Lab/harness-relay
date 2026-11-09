import { useEffect, useRef, useState } from 'react';
import { SCHEDULE_KINDS, SCHEDULE_LIMITS, pendingPlan, type Conversation } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import {
  browserTimeZone,
  describeRepeat,
  draftChanged,
  draftFrom,
  draftProblems,
  formatWhen,
  localInput,
  previewRuns,
  scheduleState,
  scheduleTrouble,
  toUpdate,
  type ScheduleDraft,
} from '../schedule';
import { MemberDots } from './MemberDots';
import { useDialog } from './useDialog';

/** Monday first, as a week is read. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * The conversation's schedule: a message the team is sent at set times, and what happens when nobody
 * is watching. The team itself is changed in the team drawer (`onEditTeam`).
 */
export function ScheduleDrawer({
  conv,
  onClose,
  onEditTeam,
}: {
  conv: Conversation;
  onClose: () => void;
  onEditTeam: () => void;
}) {
  const { t, lang } = useI18n();
  const saved = conv.schedule;
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFrom(saved, Date.now()));
  /** The user changed the form: it no longer follows the saved schedule (which the server may update). */
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, onClose);

  // The schedule changes when it sends (a one-time schedule switches off): follow it until edited.
  useEffect(() => {
    if (!touched) setDraft(draftFrom(saved, Date.now()));
  }, [saved, touched]);

  const edit = (patch: Partial<ScheduleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTouched(true);
    setError('');
    setInfo('');
  };

  const now = Date.now();
  const problems = draftProblems(draft, now, t);
  const changed = draftChanged(draft, saved);
  const teamReady = !conv.settings.autoTeam && conv.agents.length > 0 && !pendingPlan(conv.messages);
  const upcoming = problems.length ? [] : previewRuns(draft, now);
  const { mode, rounds, maxHops, permission, cwd } = conv.settings;
  /** A one-time schedule is a moment, typed in this browser's time zone; the others use the schedule's. */
  const localZone = browserTimeZone();

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.saveSchedule(conv.id, toUpdate(draft));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(t.schedule.confirmRemove)) return;
    try {
      await api.deleteSchedule(conv.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runNow = async () => {
    setSending(true);
    setError('');
    setInfo('');
    try {
      const { queued } = await api.runSchedule(conv.id);
      setInfo(queued ? t.schedule.queuedNow : t.schedule.sentNow);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const toggleDay = (day: number) =>
    edit({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside
        ref={dialog}
        className="drawer schedule-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t.schedule.title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{t.schedule.title}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="muted small">{t.schedule.intro}</p>

        {saved && (
          <div className={`schedule-status ${scheduleTrouble(saved) ? 'warn' : ''}`}>
            <div className="schedule-status-text">
              <strong>
                {describeRepeat(saved.repeat, t, lang, saved.timeZone)} · {scheduleState(saved, t, lang)}
              </strong>
              {saved.lastResult && saved.lastRunAt !== undefined && (
                <span className="small">
                  {t.schedule.last(formatWhen(saved.lastRunAt, lang, saved.timeZone), t.schedule.results[saved.lastResult])}
                  {saved.lastError && (scheduleTrouble(saved) ? t.common.listSeparator + saved.lastError : '')}
                </span>
              )}
              {info && <span className="small schedule-info">{info}</span>}
            </div>
            <div className="schedule-status-actions">
              <button
                type="button"
                className="ghost small-button"
                disabled={sending || changed || !teamReady}
                title={changed ? t.schedule.runNowSaveFirst : t.schedule.runNowTitle}
                onClick={runNow}
              >
                {t.schedule.runNow}
              </button>
              <button type="button" className="ghost small-button danger" onClick={remove}>
                {t.schedule.remove}
              </button>
            </div>
          </div>
        )}

        {!teamReady && <p className="warn-line">{t.schedule.needsTeam}</p>}

        <section className="schedule-form">
          <label className="field">
            <span>{t.schedule.message}</span>
            <textarea
              value={draft.text}
              rows={4}
              maxLength={SCHEDULE_LIMITS.maxText}
              placeholder={t.schedule.messagePlaceholder}
              onChange={(e) => edit({ text: e.target.value })}
            />
            <span className="small muted">{t.schedule.messageHint}</span>
          </label>

          <div className="field">
            <span>{t.schedule.repeat}</span>
            <div className="segmented wide" role="radiogroup" aria-label={t.schedule.repeat}>
              {SCHEDULE_KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={draft.kind === k} className={draft.kind === k ? 'on' : ''} onClick={() => edit({ kind: k })}>
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
                onChange={(e) => edit({ at: e.target.value })}
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
                  onChange={(e) => edit({ time: e.target.value })}
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
                  onChange={(e) => edit({ hours: e.target.value === '' ? NaN : Number(e.target.value) })}
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
                  ? `${t.schedule.upcoming} ${upcoming.map((at) => formatWhen(at, lang, draft.kind === 'once' ? undefined : draft.timeZone)).join(t.common.listSeparator)}`
                  : t.schedule.never}
              {draft.kind !== 'once' && (
                <>
                  {' · '}
                  {t.schedule.timeZone(draft.timeZone)}
                  {draft.timeZone !== localZone && (
                    <>
                      {' · '}
                      <button type="button" className="link-button" onClick={() => edit({ timeZone: localZone })}>
                        {t.schedule.useLocalZone(localZone)}
                      </button>
                    </>
                  )}
                </>
              )}
            </span>
          </div>

          <h3 className="schedule-sub">{t.schedule.unattended}</h3>

          <div className="field">
            <span>{t.schedule.approvals}</span>
            <div className="segmented wide" role="radiogroup" aria-label={t.schedule.approvals}>
              {(['deny', 'ask'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={draft.approvals === v} className={draft.approvals === v ? 'on' : ''} onClick={() => edit({ approvals: v })}>
                  {v === 'deny' ? t.schedule.approvalsDeny : t.schedule.approvalsAsk}
                </button>
              ))}
            </div>
            <span className="small muted">
              {permission === 'full'
                ? t.schedule.approvalsFull
                : conv.settings.approvals === 'deny'
                  ? t.schedule.approvalsTeamDeny
                  : t.schedule.approvalsHint[draft.approvals]}
            </span>
          </div>

          <div className="field">
            <span>{t.schedule.missed}</span>
            <div className="segmented wide" role="radiogroup" aria-label={t.schedule.missed}>
              {(['skip', 'run'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={draft.missed === v} className={draft.missed === v ? 'on' : ''} onClick={() => edit({ missed: v })}>
                  {v === 'skip' ? t.schedule.missedSkip : t.schedule.missedRun}
                </button>
              ))}
            </div>
            <span className="small muted">{t.schedule.missedHint[draft.missed]}</span>
          </div>

          <div className="field">
            <span>{t.schedule.team}</span>
            <div className="schedule-team">
              <MemberDots agents={conv.agents} className="preset-dots" max={8} />
              <span className="badge">
                {t.modes[mode].label} · {mode === 'relay' ? t.chat.hops(maxHops) : t.chat.rounds(rounds)}
              </span>
              <span className={`badge ${permission === 'full' ? 'danger' : ''}`}>{t.permissions[permission].label}</span>
              <span className="muted small schedule-cwd" title={cwd}>
                {cwd}
              </span>
              <button type="button" className="link-button" onClick={onEditTeam}>
                {t.schedule.editTeam}
              </button>
            </div>
            {permission === 'full' && draft.enabled && <span className="small danger-text">{t.schedule.fullWarning}</span>}
          </div>
        </section>

        <footer className="drawer-foot">
          {error ? (
            <span className="error-line">{error}</span>
          ) : (
            touched && problems[0] && <span className="error-line">{problems[0]}</span>
          )}
          <label className="check-row schedule-enabled">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
            {t.schedule.enabled}
          </label>
          <button className="ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            className="primary"
            disabled={saving || problems.length > 0 || !changed || (draft.enabled && !teamReady)}
            onClick={save}
          >
            {saving ? t.schedule.saving : t.common.save}
          </button>
        </footer>
      </aside>
    </div>
  );
}
