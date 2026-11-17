import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  SCHEDULE_KINDS,
  SCHEDULE_LIMITS,
  WATCH_LIMITS,
  type ConversationSchedule,
  type ConversationSettings,
  type MailAccountView,
} from '../../shared/types';
import { api } from '../api';
import { mentionWarning } from '../copy';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { hashFor } from '../route';
import { revealChosen } from './CliPicker';
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
  hook,
}: {
  draft: ScheduleDraft;
  onEdit: (patch: Partial<ScheduleDraft>) => void;
  /** The schedule saved so far: an interval keeps its cadence while its times stay the same. */
  saved?: ConversationSchedule;
  /** The conversation's settings (or the new one's): the hints depend on its mode and permission. */
  settings: Pick<ConversationSettings, 'mode' | 'permission' | 'approvals'>;
  /** The team's names; absent while there is no team yet (the lead agent names its members after the @mentions). */
  team?: string[];
  /** New automation only: Create a webhook too, folded away under When (the drawer adds one to a saved automation). */
  hook?: { checked: boolean; onChange: (on: boolean) => void };
}) {
  const { t, lang } = useI18n();
  const { turnTimeoutMinutes } = useLimits();
  const intervalHintId = useId();
  const kindsRow = useRef<HTMLDivElement>(null);
  useEffect(() => revealChosen(kindsRow.current), [draft.kind]);
  // @mentions that reach nobody on the team.
  const warning = useMemo(() => (team ? mentionWarning(draft.text, team, t, 'form') : undefined), [draft.text, team, t]);
  const now = Date.now();
  // "Add one once it is saved" only where the automation is not saved yet and no webhook can be made on the page.
  const manualHint = hook || saved ? t.schedule.manualHintNew : t.schedule.manualHint;
  // The preview under the times is about the times: a message still to be typed is said elsewhere.
  const problems = draftProblems({ ...draft, text: draft.text.trim() || '-' }, now, t);
  const upcoming = problems.length ? [] : previewRuns(draft, now, saved);
  const { mode, permission } = settings;
  /** Times of day are in the schedule's time zone; a moment or an interval does not depend on one. */
  const localZone = browserTimeZone();
  const draftZone = shownZone({ repeat: { kind: draft.kind }, timeZone: draft.timeZone });

  const toggleDay = (day: number) =>
    onEdit({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });

  // The mail accounts from Settings, once the automation is to wait for a new mail.
  const [mailAccounts, setMailAccounts] = useState<MailAccountView[]>();
  const watching = draft.kind === 'event';
  useEffect(() => {
    if (!watching || mailAccounts) return;
    let live = true;
    api.connectors().then(
      (v) => live && setMailAccounts(v.mail),
      () => live && setMailAccounts([]),
    );
    return () => {
      live = false;
    };
  }, [watching, mailAccounts]);
  // The first account until another is picked.
  useEffect(() => {
    if (watching && mailAccounts?.length && !draft.trigger.account) onEdit({ trigger: { ...draft.trigger, account: mailAccounts[0]!.id } });
  }, [watching, mailAccounts, draft.trigger, onEdit]);
  const editTrigger = (patch: Partial<ScheduleDraft['trigger']>) => onEdit({ trigger: { ...draft.trigger, ...patch } });

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

      <label className="field">
        <span>{t.schedule.goal}</span>
        <textarea
          value={draft.goal}
          rows={2}
          maxLength={SCHEDULE_LIMITS.maxGoal}
          placeholder={t.schedule.goalPlaceholder}
          onChange={(e) => onEdit({ goal: e.target.value })}
        />
        <span className="small muted">{t.schedule.goalHint}</span>
      </label>

      <div className="field">
        <span>{t.schedule.repeat}</span>
        {/* One row, scrolled sideways where it does not fit (a phone), the chosen kind in view. */}
        <div ref={kindsRow} className="segmented schedule-kinds" role="radiogroup" aria-label={t.schedule.repeat}>
          {SCHEDULE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={draft.kind === k}
              className={draft.kind === k ? 'on' : ''}
              onClick={() => onEdit({ kind: k })}
            >
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
          <>
            <label className="field inline">
              <span>{t.schedule.every}</span>
              <input
                type="number"
                min={1}
                max={SCHEDULE_LIMITS.maxHours}
                value={Number.isNaN(draft.hours) ? '' : draft.hours}
                onChange={(e) => onEdit({ hours: e.target.value === '' ? NaN : Number(e.target.value) })}
                aria-describedby={intervalHintId}
              />
              <span className="unit muted small">{t.schedule.hoursUnit}</span>
            </label>
            {/* A line of its own (as part of the unit, which never wraps, it scrolled a phone's page
                sideways), and still the hours box's description. */}
            <span id={intervalHintId} className="small muted">
              {t.schedule.intervalHint}
            </span>
          </>
        )}

        {watching && (
          <div className="schedule-trigger">
            <label className="field">
              <span>{t.schedule.watch.source}</span>
              <select value={draft.trigger.source} onChange={() => undefined}>
                <option value="mail">{t.schedule.watch.sources.mail}</option>
              </select>
            </label>
            {mailAccounts && !mailAccounts.length ? (
              <p className="small warn-text">
                {t.schedule.watch.noAccounts}{' '}
                <a className="link-button" href={hashFor({ page: 'settings', section: 'tools' })}>
                  {t.schedule.watch.openSettings}
                </a>
              </p>
            ) : (
              <label className="field">
                <span>{t.schedule.watch.account}</span>
                <select value={draft.trigger.account} onChange={(e) => editTrigger({ account: e.target.value })}>
                  {!draft.trigger.account && <option value="">…</option>}
                  {/* An account removed since: kept until another is picked, so saving says what is wrong. */}
                  {draft.trigger.account && mailAccounts && !mailAccounts.some((m) => m.id === draft.trigger.account) && (
                    <option value={draft.trigger.account}>{draft.trigger.account}</option>
                  )}
                  {(mailAccounts ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.address}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>{t.schedule.watch.folder}</span>
              <input
                value={draft.trigger.folder}
                maxLength={WATCH_LIMITS.field}
                placeholder="INBOX"
                onChange={(e) => editTrigger({ folder: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t.schedule.watch.from}</span>
              <input
                value={draft.trigger.from}
                maxLength={WATCH_LIMITS.field}
                placeholder={t.schedule.watch.fromPlaceholder}
                onChange={(e) => editTrigger({ from: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t.schedule.watch.subject}</span>
              <input
                value={draft.trigger.subject}
                maxLength={WATCH_LIMITS.field}
                placeholder={t.schedule.watch.subjectPlaceholder}
                onChange={(e) => editTrigger({ subject: e.target.value })}
              />
            </label>
          </div>
        )}

        <span className="small muted schedule-preview">
          {problems.length
            ? problems[0]
            : watching
              ? t.schedule.watch.hint(WATCH_LIMITS.checkMinutes)
              : draft.kind === 'manual'
                ? manualHint
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

      {/* Folded away at first, under words anyone can read: most people never need a webhook. */}
      {hook && (
        <details className="sub">
          <summary>{t.schedule.hook.title}</summary>
          <div className="sub-body">
            <p className="small muted">{t.schedule.hook.intro}</p>
            <div className="field">
              <label className="check-row">
                <input type="checkbox" checked={hook.checked} onChange={(e) => hook.onChange(e.target.checked)} />
                {t.newSchedule.withHook}
              </label>
              <span className="small muted">{t.newSchedule.withHookHint}</span>
            </div>
          </div>
        </details>
      )}

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
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={draft.approvals === v}
              className={draft.approvals === v ? 'on' : ''}
              onClick={() => onEdit({ approvals: v })}
            >
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

      {/* No set times: nothing comes due while Harness Relay is closed, so nothing is missed (new mail
          that came meanwhile is found at the first check). */}
      {draft.kind !== 'manual' && !watching && (
        <div className="field">
          <span>{t.schedule.missed}</span>
          <div className="segmented wide" role="radiogroup" aria-label={t.schedule.missed}>
            {(['skip', 'run'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={draft.missed === v}
                className={draft.missed === v ? 'on' : ''}
                onClick={() => onEdit({ missed: v })}
              >
                {v === 'skip' ? t.schedule.missedSkip : t.schedule.missedRun}
              </button>
            ))}
          </div>
          <span className="small muted">{t.schedule.missedHint[draft.missed]}</span>
        </div>
      )}
    </section>
  );
}
