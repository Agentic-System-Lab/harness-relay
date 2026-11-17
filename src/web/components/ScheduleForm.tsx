import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  SCHEDULE_KINDS,
  SCHEDULE_LIMITS,
  TRIGGER_SOURCES,
  WATCH_LIMITS,
  type CalendarAccountView,
  type ConversationSchedule,
  type ConversationSettings,
  type MailAccountView,
  type ScheduleTrigger,
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
  const w = t.schedule.watch;
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

  // The mail accounts and calendars from Settings, once the automation is to wait for something.
  const [accounts, setAccounts] = useState<{ mail: MailAccountView[]; calendar: CalendarAccountView[] }>();
  const watching = draft.kind === 'event';
  useEffect(() => {
    if (!watching || accounts) return;
    let live = true;
    api.connectors().then(
      (v) => live && setAccounts({ mail: v.mail, calendar: v.calendar }),
      () => live && setAccounts({ mail: [], calendar: [] }),
    );
    return () => {
      live = false;
    };
  }, [watching, accounts]);
  const mailAccounts = accounts?.mail;
  const calendars = accounts?.calendar;
  // The first account (and calendar) until another is picked.
  useEffect(() => {
    if (!watching) return;
    const patch: Partial<ScheduleDraft['trigger']> = {
      ...(mailAccounts?.length && !draft.trigger.account ? { account: mailAccounts[0]!.id } : {}),
      ...(calendars?.length && !draft.trigger.calendar ? { calendar: calendars[0]!.id } : {}),
    };
    if (Object.keys(patch).length) onEdit({ trigger: { ...draft.trigger, ...patch } });
  }, [watching, mailAccounts, calendars, draft.trigger, onEdit]);
  const editTrigger = (patch: Partial<ScheduleDraft['trigger']>) => onEdit({ trigger: { ...draft.trigger, ...patch } });
  const source = draft.trigger.source;
  const sourceHint = {
    mail: w.hint,
    calendar: w.calendarHint,
    github: w.githubHint,
    file: w.fileHint,
  }[source](WATCH_LIMITS.checkMinutes);

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
              <span>{w.source}</span>
              <select value={source} onChange={(e) => editTrigger({ source: e.target.value as ScheduleTrigger['source'] })}>
                {TRIGGER_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {w.sources[s]}
                  </option>
                ))}
              </select>
            </label>
            {source === 'mail' && (
              <>
                {mailAccounts && !mailAccounts.length ? (
                  <p className="small warn-text">
                    {w.noAccounts}{' '}
                    <a className="link-button" href={hashFor({ page: 'settings', section: 'tools' })}>
                      {w.openSettings}
                    </a>
                  </p>
                ) : (
                  <label className="field">
                    <span>{w.account}</span>
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
                  <span>{w.folder}</span>
                  <input
                    value={draft.trigger.folder}
                    maxLength={WATCH_LIMITS.field}
                    placeholder="INBOX"
                    onChange={(e) => editTrigger({ folder: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{w.from}</span>
                  <input
                    value={draft.trigger.from}
                    maxLength={WATCH_LIMITS.field}
                    placeholder={w.fromPlaceholder}
                    onChange={(e) => editTrigger({ from: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{w.subject}</span>
                  <input
                    value={draft.trigger.subject}
                    maxLength={WATCH_LIMITS.field}
                    placeholder={w.subjectPlaceholder}
                    onChange={(e) => editTrigger({ subject: e.target.value })}
                  />
                </label>
              </>
            )}
            {source === 'calendar' && (
              <>
                {calendars && !calendars.length ? (
                  <p className="small warn-text">
                    {w.noCalendars}{' '}
                    <a className="link-button" href={hashFor({ page: 'settings', section: 'tools' })}>
                      {w.openSettings}
                    </a>
                  </p>
                ) : (
                  <label className="field">
                    <span>{w.calendarAccount}</span>
                    <select value={draft.trigger.calendar} onChange={(e) => editTrigger({ calendar: e.target.value })}>
                      {!draft.trigger.calendar && <option value="">…</option>}
                      {draft.trigger.calendar && calendars && !calendars.some((c) => c.id === draft.trigger.calendar) && (
                        <option value={draft.trigger.calendar}>{draft.trigger.calendar}</option>
                      )}
                      {(calendars ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span>{w.minutes}</span>
                  <input
                    type="number"
                    min={1}
                    max={WATCH_LIMITS.maxMinutes}
                    step={1}
                    value={Number.isFinite(draft.trigger.minutes) ? draft.trigger.minutes : ''}
                    onChange={(e) => editTrigger({ minutes: e.target.value === '' ? NaN : Number(e.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>{w.title}</span>
                  <input
                    value={draft.trigger.title}
                    maxLength={WATCH_LIMITS.field}
                    placeholder={w.titlePlaceholder}
                    onChange={(e) => editTrigger({ title: e.target.value })}
                  />
                </label>
              </>
            )}
            {source === 'github' && (
              <>
                <label className="field">
                  <span>{w.repo}</span>
                  <input
                    value={draft.trigger.repo}
                    maxLength={WATCH_LIMITS.field}
                    placeholder={w.repoPlaceholder}
                    spellCheck={false}
                    autoCapitalize="off"
                    onChange={(e) => editTrigger({ repo: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{w.what}</span>
                  <select value={draft.trigger.on} onChange={(e) => editTrigger({ on: e.target.value === 'ci' ? 'ci' : 'pr' })}>
                    <option value="pr">{w.on.pr}</option>
                    <option value="ci">{w.on.ci}</option>
                  </select>
                </label>
                {draft.trigger.on === 'ci' && (
                  <label className="field">
                    <span>{w.branch}</span>
                    <input
                      value={draft.trigger.branch}
                      maxLength={WATCH_LIMITS.field}
                      placeholder={w.branchPlaceholder}
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(e) => editTrigger({ branch: e.target.value })}
                    />
                  </label>
                )}
              </>
            )}
            {source === 'file' && (
              <label className="field">
                <span>{w.pattern}</span>
                <input
                  value={draft.trigger.pattern}
                  maxLength={WATCH_LIMITS.field}
                  placeholder={w.patternPlaceholder}
                  spellCheck={false}
                  autoCapitalize="off"
                  onChange={(e) => editTrigger({ pattern: e.target.value })}
                />
              </label>
            )}
          </div>
        )}

        <span className="small muted schedule-preview">
          {problems.length
            ? problems[0]
            : watching
              ? sourceHint
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
