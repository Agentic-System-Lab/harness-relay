import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { TaskInput } from './TaskInput';
import { revealChosen } from './CliPicker';
import {
  browserTimeZone,
  draftProblems,
  editTriggers,
  formatWhen,
  localInput,
  previewRuns,
  shownZone,
  type ScheduleDraft,
  type TriggerDraft,
} from '../schedule';

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
  creation,
  children,
  disabled,
}: {
  draft: ScheduleDraft;
  onEdit: (patch: Partial<ScheduleDraft>) => void;
  /** The schedule saved so far: an interval keeps its cadence while its times stay the same. */
  saved?: ConversationSchedule;
  /** The conversation's settings (or the new one's): the hints depend on its mode and permission. */
  settings: Pick<ConversationSettings, 'mode' | 'permission' | 'approvals'>;
  /** The team's names; absent while there is no team yet (the lead agent names its members after the @mentions). */
  team?: string[];
  /** New automation only: Create a webhook too, under optional run settings (the drawer adds one to a saved automation). */
  creation?: { withHook: boolean; onHook: (on: boolean) => void };
  children?: ReactNode;
  disabled?: boolean;
}) {
  const { t, lang } = useI18n();
  const w = t.schedule.watch;
  const { turnTimeoutMinutes } = useLimits();
  const intervalHintId = useId();
  const messageId = useId();
  const goalId = useId();
  const goalHintId = useId();
  const whenId = useId();
  const kindsRow = useRef<HTMLDivElement>(null);
  useEffect(() => revealChosen(kindsRow.current), [draft.kind]);
  // @mentions that reach nobody on the team.
  const warning = useMemo(() => (team ? mentionWarning(draft.text, team, t, 'form') : undefined), [draft.text, team, t]);
  const now = Date.now();
  // "Add one once it is saved" only where the automation is not saved yet and no webhook can be made on the page.
  const manualHint = creation || saved ? t.schedule.manualHintNew : t.schedule.manualHint;
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
  // The first account (and calendar) until another is picked, for each thing it waits for.
  useEffect(() => {
    if (!watching) return;
    const account = mailAccounts?.[0]?.id;
    const calendar = calendars?.[0]?.id;
    const filled = draft.triggers.map((tr) => ({
      ...tr,
      ...(account && !tr.account ? { account } : {}),
      ...(calendar && !tr.calendar ? { calendar } : {}),
    }));
    if (filled.some((tr, i) => tr.account !== draft.triggers[i]!.account || tr.calendar !== draft.triggers[i]!.calendar))
      onEdit({ triggers: filled });
  }, [watching, mailAccounts, calendars, draft.triggers, onEdit]);
  const editTrigger = (index: number, patch: Partial<TriggerDraft>) =>
    onEdit({ triggers: draft.triggers.map((tr, i) => (i === index ? { ...tr, ...patch } : tr)) });
  const several = draft.triggers.length > 1;
  // Each source's hint once, in the order they come.
  const hints = [...new Set(draft.triggers.map((tr) => tr.source))].map((source) =>
    ({ mail: w.hint, calendar: w.calendarHint, github: w.githubHint, file: w.fileHint })[source](
      WATCH_LIMITS.checkMinutes,
      WATCH_LIMITS.settleSeconds,
    ),
  );
  const sourceHint = [...(several ? [w.severalHint] : []), ...hints].join(' ');

  const runOptions = (
    <>
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
    </>
  );

  return (
    <section className="schedule-form">
      <div className="field">
        <label className={creation ? 'first-question' : undefined} htmlFor={messageId}>
          {creation ? t.newSchedule.task : t.schedule.message}
        </label>
        <TaskInput
          creation={Boolean(creation)}
          id={messageId}
          text={draft.text}
          onText={(text) => onEdit({ text })}
          files={draft.files}
          onFiles={(files) => onEdit({ files })}
          saved={
            saved?.attachments && {
              files: saved.attachments.filter((f) => !draft.removeAttachments.includes(f.id)),
              remove: (id) => onEdit({ removeAttachments: [...draft.removeAttachments, id] }),
            }
          }
          disabled={disabled}
          maxLength={SCHEDULE_LIMITS.maxText}
          placeholder={creation ? t.newSchedule.example : t.schedule.messagePlaceholder}
        />
        {(!creation || draft.text.includes('@')) && (
          <span className="small muted">{team ? t.schedule.messageHint : t.schedule.messageHintNoTeam}</span>
        )}
        {warning && <span className="small warn-text">{warning}</span>}
      </div>

      <div className="field">
        <label htmlFor={goalId}>{t.schedule.goal}</label>
        <textarea
          id={goalId}
          aria-describedby={goalHintId}
          value={draft.goal}
          rows={2}
          maxLength={SCHEDULE_LIMITS.maxGoal}
          placeholder={t.schedule.goalPlaceholder}
          onChange={(e) => onEdit({ goal: e.target.value })}
        />
        <span className="small muted" id={goalHintId}>
          {creation ? t.newSchedule.goalHint : t.schedule.goalHint}
        </span>
      </div>

      <div className="field">
        {creation ? (
          <>
            <label htmlFor={whenId}>{t.schedule.repeat}</label>
            <select id={whenId} value={draft.kind} onChange={(e) => onEdit({ kind: e.target.value as ScheduleDraft['kind'] })}>
              {SCHEDULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t.schedule.kinds[k]}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
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
          </>
        )}

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
          <>
            {draft.triggers.map((trigger, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <span className="schedule-trigger-or small muted" aria-hidden="true">
                    {w.or}
                  </span>
                )}
                <TriggerFields
                  trigger={trigger}
                  index={i}
                  several={several}
                  mailAccounts={mailAccounts}
                  calendars={calendars}
                  onEdit={(patch) => editTrigger(i, patch)}
                  onRemove={() => onEdit({ triggers: editTriggers(draft, { remove: i }) })}
                />
              </Fragment>
            ))}
            {draft.triggers.length < WATCH_LIMITS.triggers && (
              <button
                type="button"
                className="ghost small-button schedule-trigger-add"
                title={w.addTitle(WATCH_LIMITS.triggers)}
                onClick={() => onEdit({ triggers: editTriggers(draft, { add: true }) })}
              >
                <span aria-hidden="true">+</span> {w.add}
              </button>
            )}
          </>
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

      {creation ? (
        <div className="automation-settings">
          {children}
          <details className="automation-options">
            <summary>{t.newSchedule.runOptions}</summary>
            <div className="schedule-form-options">
              <div className="field">
                <label className="check-row">
                  <input type="checkbox" checked={creation.withHook} onChange={(e) => creation.onHook(e.target.checked)} />
                  {t.newSchedule.withHook}
                </label>
                <span className="small muted">{creation.withHook ? t.newSchedule.withHookHint : t.schedule.hook.intro}</span>
              </div>
              {runOptions}
            </div>
          </details>
        </div>
      ) : (
        runOptions
      )}
    </section>
  );
}

/**
 * One thing an automation waits for, in the form: its source and that source's fields. With several,
 * a group named by its number, which can be removed.
 */
function TriggerFields({
  trigger,
  index,
  several,
  mailAccounts,
  calendars,
  onEdit,
  onRemove,
}: {
  trigger: TriggerDraft;
  index: number;
  several: boolean;
  /** The mail accounts and calendars from Settings (absent while they load). */
  mailAccounts?: MailAccountView[];
  calendars?: CalendarAccountView[];
  onEdit: (patch: Partial<TriggerDraft>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const w = t.schedule.watch;
  const source = trigger.source;
  return (
    <div
      className={`schedule-trigger ${several ? 'several' : ''}`}
      role={several ? 'group' : undefined}
      aria-label={several ? w.group(index + 1) : undefined}
    >
      <div className="schedule-trigger-head">
        <label className="field">
          <span>{w.source}</span>
          <select value={source} onChange={(e) => onEdit({ source: e.target.value as ScheduleTrigger['source'] })}>
            {TRIGGER_SOURCES.map((s) => (
              <option key={s} value={s}>
                {w.sources[s]}
              </option>
            ))}
          </select>
        </label>
        {several && (
          <button type="button" className="ghost small-button" aria-label={w.removeLabel(index + 1)} onClick={onRemove}>
            {w.remove}
          </button>
        )}
      </div>
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
              <select value={trigger.account} onChange={(e) => onEdit({ account: e.target.value })}>
                {!trigger.account && <option value="">…</option>}
                {/* An account removed since: kept until another is picked, so saving says what is wrong. */}
                {trigger.account && mailAccounts && !mailAccounts.some((m) => m.id === trigger.account) && (
                  <option value={trigger.account}>{trigger.account}</option>
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
              value={trigger.folder}
              maxLength={WATCH_LIMITS.field}
              placeholder="INBOX"
              onChange={(e) => onEdit({ folder: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{w.from}</span>
            <input
              value={trigger.from}
              maxLength={WATCH_LIMITS.field}
              placeholder={w.fromPlaceholder}
              onChange={(e) => onEdit({ from: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{w.subject}</span>
            <input
              value={trigger.subject}
              maxLength={WATCH_LIMITS.field}
              placeholder={w.subjectPlaceholder}
              onChange={(e) => onEdit({ subject: e.target.value })}
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
              <select value={trigger.calendar} onChange={(e) => onEdit({ calendar: e.target.value })}>
                {!trigger.calendar && <option value="">…</option>}
                {trigger.calendar && calendars && !calendars.some((c) => c.id === trigger.calendar) && (
                  <option value={trigger.calendar}>{trigger.calendar}</option>
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
              value={Number.isFinite(trigger.minutes) ? trigger.minutes : ''}
              onChange={(e) => onEdit({ minutes: e.target.value === '' ? NaN : Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>{w.title}</span>
            <input
              value={trigger.title}
              maxLength={WATCH_LIMITS.field}
              placeholder={w.titlePlaceholder}
              onChange={(e) => onEdit({ title: e.target.value })}
            />
          </label>
        </>
      )}
      {source === 'github' && (
        <>
          <label className="field">
            <span>{w.repo}</span>
            <input
              value={trigger.repo}
              maxLength={WATCH_LIMITS.field}
              placeholder={w.repoPlaceholder}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => onEdit({ repo: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{w.what}</span>
            <select value={trigger.on} onChange={(e) => onEdit({ on: e.target.value === 'ci' ? 'ci' : 'pr' })}>
              <option value="pr">{w.on.pr}</option>
              <option value="ci">{w.on.ci}</option>
            </select>
          </label>
          {trigger.on === 'ci' && (
            <label className="field">
              <span>{w.branch}</span>
              <input
                value={trigger.branch}
                maxLength={WATCH_LIMITS.field}
                placeholder={w.branchPlaceholder}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => onEdit({ branch: e.target.value })}
              />
            </label>
          )}
        </>
      )}
      {source === 'file' && (
        <label className="field">
          <span>{w.pattern}</span>
          <input
            value={trigger.pattern}
            maxLength={WATCH_LIMITS.field}
            placeholder={w.patternPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => onEdit({ pattern: e.target.value })}
          />
        </label>
      )}
    </div>
  );
}
