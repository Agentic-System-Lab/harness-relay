import { useEffect, useMemo, useRef, useState } from 'react';
import { pendingPlan, type Conversation } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { hashFor } from '../route';
import {
  describeRepeat,
  draftChanged,
  draftFrom,
  draftProblems,
  formatWhen,
  scheduleState,
  scheduleTrouble,
  shownZone,
  toUpdate,
  type ScheduleDraft,
} from '../schedule';
import { MemberDots } from './MemberDots';
import { ScheduleForm } from './ScheduleForm';
import { useDialog } from './useDialog';

/**
 * The conversation's schedule: a message the team is sent at set times, and what happens when nobody
 * is watching. The team itself is changed in the team drawer (`onEditTeam`).
 */
export function ScheduleDrawer({
  conv,
  running,
  onClose,
  onEditTeam,
}: {
  conv: Conversation;
  /** The team (or the lead agent designing it) is at work. */
  running: boolean;
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
  /** The conversation "Run now" just opened (a schedule that opens a new one each time). */
  const [ranIn, setRanIn] = useState<string>();
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
    setRanIn(undefined);
  };

  const problems = draftProblems(draft, Date.now(), t);
  const changed = draftChanged(draft, saved);
  // Scheduled messages go to the current team (the lead agent designs none when one comes due).
  const waitingPlan = Boolean(pendingPlan(conv.messages));
  const teamReady = conv.agents.length > 0 && !waitingPlan;
  // The latest team design is for the schedule's message (New schedule), not for a question.
  const forSchedule = Boolean(conv.messages.findLast((m) => m.plan)?.plan?.forSchedule);
  const { mode, rounds, maxHops, permission, cwd } = conv.settings;
  /** The team the scheduled message goes to; none yet while the lead agent still has to design one. */
  const teamNames = useMemo(() => (conv.agents.length ? conv.agents.map((a) => a.name) : undefined), [conv.agents]);
  /** A saved schedule without a team, in a chat whose lead agent may design one for it now. */
  const mayDesign = Boolean(saved) && !teamReady && !waitingPlan && !running && Boolean(conv.settings.autoTeam);
  const [designing, setDesigning] = useState(false);

  const design = async () => {
    setDesigning(true);
    setError('');
    try {
      await api.designSchedule(conv.id);
      onClose(); // the team's card is in the chat
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDesigning(false);
    }
  };

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
    setRanIn(undefined);
    try {
      const { queued, chatId } = await api.runSchedule(conv.id);
      setInfo(chatId ? t.schedule.sentInNewChat : queued ? t.schedule.queuedNow : t.schedule.sentNow);
      setRanIn(chatId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

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
                {describeRepeat(saved.repeat, t, lang)} · {scheduleState(saved, t, lang)}
              </strong>
              {saved.lastResult && saved.lastRunAt !== undefined && (
                <span className="small">
                  {t.schedule.last(formatWhen(saved.lastRunAt, lang, shownZone(saved)), t.schedule.results[saved.lastResult])}
                  {saved.lastError && (scheduleTrouble(saved) ? t.common.listSeparator + saved.lastError : '')}
                  {saved.lastChatId && saved.lastResult === 'sent' && (
                    <>
                      {' · '}
                      <a className="link-button" href={hashFor({ page: 'chat', id: saved.lastChatId })}>
                        {t.schedule.openChat}
                      </a>
                    </>
                  )}
                </span>
              )}
              {info && (
                <span className="small schedule-info">
                  {info}
                  {ranIn && (
                    <>
                      {' · '}
                      <a className="link-button" href={hashFor({ page: 'chat', id: ranIn })}>
                        {t.schedule.openChat}
                      </a>
                    </>
                  )}
                </span>
              )}
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

        {!teamReady && (
          <p className="warn-line">
            {waitingPlan && forSchedule
              ? t.schedule.confirmTeamFirst
              : running && forSchedule
                ? t.schedule.designingTeam
                : mayDesign
                  ? t.schedule.noTeamYet
                  : t.schedule.needsTeam}
            {mayDesign && (
              <button type="button" className="link-button" disabled={designing} onClick={design}>
                {t.schedule.designTeam}
              </button>
            )}
          </p>
        )}

        <div className="schedule-form">
          <ScheduleForm draft={draft} onEdit={edit} saved={saved} settings={conv.settings} team={teamNames} />

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
            {conv.settings.autoTeam && <span className="small muted">{t.schedule.currentTeam}</span>}
            {permission === 'full' && draft.enabled && <span className="small danger-text">{t.schedule.fullWarning}</span>}
          </div>
        </div>

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
