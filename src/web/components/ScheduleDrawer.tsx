import { useEffect, useMemo, useRef, useState } from 'react';
import { pendingPlan, permissionLevel, type Conversation, type FixedCommand } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { hashFor } from '../route';
import {
  combinedWatch,
  draftChanged,
  draftFrom,
  draftProblems,
  formatWhen,
  scheduleStatus,
  scheduleTrouble,
  shownZone,
  toUpdate,
  type ScheduleDraft,
} from '../schedule';
import { MemberDots } from './MemberDots';
import { readUploads } from './MessageFiles';
import { ScheduleForm } from './ScheduleForm';
import { ScheduleHookPanel, ScheduleProgress } from './ScheduleTracking';
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
  proposal,
}: {
  conv: Conversation;
  /** The team (or the lead agent designing it) is at work. */
  running: boolean;
  onClose: () => void;
  onEditTeam: () => void;
  /** A schedule a reply proposed, opened to be changed before saving it: the form starts with it. */
  proposal?: { messageId: string; draft: ScheduleDraft };
}) {
  const { t, lang } = useI18n();
  const saved = conv.schedule;
  const [draft, setDraft] = useState<ScheduleDraft>(() => proposal?.draft ?? draftFrom(saved, Date.now()));
  /** The user changed the form (or it holds a proposed schedule): it no longer follows the saved schedule (which the server may update). */
  const [touched, setTouched] = useState(Boolean(proposal));
  /** The lead agent drafts the form: it cannot be saved meanwhile. */
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
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
  const status = saved && scheduleStatus(saved, t, lang);
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
  // The working directory's fixed commands, which the schedule may run first.
  const [commands, setCommands] = useState<FixedCommand[]>();
  useEffect(() => {
    let live = true;
    api.conversationCommands(conv.id).then(
      (list) => live && setCommands(list),
      () => live && setCommands([]),
    );
    return () => {
      live = false;
    };
  }, [conv.id]);

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
      const attachments = await readUploads(draft.files, t.composer.readFailed);
      // The drawer can be dismissed while a file is still being read. Drop that unfinished edit.
      if (!dialog.current) return;
      await api.saveSchedule(conv.id, {
        ...toUpdate(draft),
        ...(attachments.length ? { attachments } : {}),
        ...(draft.removeAttachments.length ? { removeAttachments: draft.removeAttachments } : {}),
        // The reply whose proposed schedule this is: its card then says it was created.
        ...(proposal ? { fromProposal: proposal.messageId } : {}),
      });
      if (dialog.current) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (saving || !confirm(t.schedule.confirmRemove)) return;
    setSaving(true);
    try {
      await api.deleteSchedule(conv.id);
      if (dialog.current) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
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

  const checkNow = async () => {
    setChecking(true);
    setError('');
    setInfo('');
    setRanIn(undefined);
    try {
      // What the check found shows, also while the automation is off (its state then says paused only).
      const after = await api.checkSchedule(conv.id);
      // Every trigger was checked: as one (the first error, the last check).
      const w = after ? combinedWatch(after) : undefined;
      // On, the status line above says how it went (its error too); off, it says only paused.
      if (after?.enabled) setInfo(t.schedule.watch.done);
      else if (w?.error) setError(t.schedule.watch.error(w.error));
      else if (w?.checkedAt) setInfo(t.schedule.watch.checked(formatWhen(w.checkedAt, lang)));
      else setInfo(t.schedule.watch.done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
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

        {saved && status && (
          <div className={`schedule-status ${scheduleTrouble(saved) ? 'warn' : ''}`}>
            <div className="schedule-status-text">
              <strong>{status.title}</strong>
              {/* Several things to wait for: how each one's checks go, one line each. */}
              {status.lines.map((line, i) => (
                <span key={i} className="small schedule-trigger-state">
                  {line}
                </span>
              ))}
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
              {saved.repeat.kind === 'event' && (
                <button
                  type="button"
                  className="ghost small-button"
                  disabled={checking || changed}
                  title={changed ? t.schedule.watch.checkSaveFirst : t.schedule.watch.checkNowTitle}
                  onClick={checkNow}
                >
                  {t.schedule.watch.checkNow}
                </button>
              )}
              <button
                type="button"
                className="ghost small-button"
                disabled={sending || changed || !teamReady}
                title={changed ? t.schedule.runNowSaveFirst : t.schedule.runNowTitle}
                onClick={runNow}
              >
                {t.schedule.runNow}
              </button>
              <button type="button" className="ghost small-button danger" disabled={saving} onClick={remove}>
                {t.schedule.remove}
              </button>
            </div>
          </div>
        )}

        {saved?.goal && <ScheduleProgress schedule={saved} />}
        {saved && <ScheduleHookPanel convId={conv.id} schedule={saved} onError={setError} />}

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
          <ScheduleForm
            disabled={saving}
            draft={draft}
            onEdit={edit}
            saved={saved}
            settings={conv.settings}
            team={teamNames}
            convId={conv.id}
            onDrafting={setDrafting}
            commands={commands}
          />

          <div className="field">
            <span>{t.schedule.team}</span>
            <div className="schedule-team">
              <MemberDots agents={conv.agents} className="preset-dots" max={8} />
              <span className="badge">
                {t.modes[mode].label} · {mode === 'relay' ? t.chat.hops(maxHops) : t.chat.rounds(rounds)}
              </span>
              <span className={`badge ${permission === 'full' ? 'danger' : ''}`}>
                {t.permissions[permissionLevel(conv.settings)].label}
              </span>
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
          {/* No set times: nothing to switch on or off, Run once now and the webhook send it; one its
              reached goal switched off is turned on again by saving it. */}
          {draft.kind === 'manual' && saved && !saved.enabled && <span className="small muted">{t.schedule.manualOff}</span>}
          {draft.kind !== 'manual' && (
            <label className="check-row schedule-enabled">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
              {t.schedule.enabled}
            </label>
          )}
          <button className="ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            className="primary"
            disabled={saving || drafting || problems.length > 0 || !changed || (draft.enabled && !teamReady)}
            onClick={save}
          >
            {saving ? t.schedule.saving : t.common.save}
          </button>
        </footer>
      </aside>
    </div>
  );
}
