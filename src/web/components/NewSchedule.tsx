import { useEffect, useRef, useState } from 'react';
import {
  cwdsOf,
  type Conversation,
  type ConversationSchedule,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
} from '../../shared/types';
import { api, orCreateCwd } from '../api';
import { loadPart } from '../chunks';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { draftFrom, draftProblems, handOverHook, toUpdate, type ScheduleDraft } from '../schedule';
import { leadLabel } from '../util';
import { lastAutoConfirm, rememberAutoConfirm } from '../autoConfirm';
import { autoTeam } from './NewChat';
import { readUploads } from './MessageFiles';
import { ScheduleForm } from './ScheduleForm';
import { TemplateLibrary } from './TemplateLibrary';
import type { DraftApp } from '../../shared/apps';
import { taskWithApps } from '../draftApps';
import type { DraftAppStatus } from '../draftAppStatus';
import { useDraftApps } from '../useDraftApps';
import { settingsHref } from '../route';
import { CreationPage } from './CreationPage';
import { CreationOptions, CreationTeamOptions } from './CreationOptions';
import { teamProblems, type Team } from './TeamEditor';

export interface NewAutomationDraft {
  apps?: DraftApp[];
  form: ScheduleDraft;
  title: string;
  withHook: boolean;
  team?: Team;
}

interface Props {
  appStatus: DraftAppStatus;
  draft: NewAutomationDraft | null;
  onDraft: (draft: NewAutomationDraft) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (message: string) => void;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onCreated: (c: Conversation) => void;
}

/**
 * A new schedule (New schedule in the sidebar): its message, times and choices, and the settings of the
 * conversation it lives in. Once created, the lead agent designs the team for the message; nothing runs
 * until the schedule sends it.
 */
export function NewSchedule({
  appStatus,
  providers,
  catalog,
  onCreated,
  draft: savedDraft,
  onDraft,
  busy,
  setBusy,
  error,
  setError,
}: Props) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [defaults, setDefaults] = useState<Team | null>(null);
  const [initial] = useState<NewAutomationDraft>(() => ({ form: draftFrom(undefined, Date.now()), title: '', withHook: false }));
  const current = savedDraft ?? initial;
  const { form: draft, title, withHook } = current;
  /** The draft now: what the lead agent writes (or its Undo) lands on it, not on the draft as it was when it was asked. */
  const latest = useRef(current);
  latest.current = current;
  const update = (patch: Partial<NewAutomationDraft>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    onDraft(next);
  };
  const team = current.team ?? defaults;
  const appChoices = useDraftApps(appStatus, current.apps ?? [], (apps) => onDraft({ ...current, apps }), team?.settings.permission);
  const [loadError, setLoadError] = useState('');
  /** The lead agent drafts the form, or the team checks: the automation cannot be created meanwhile. */
  const [drafting, setDrafting] = useState(false);
  const [checksDrafting, setChecksDrafting] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getSettings()
      .then((settings) => {
        if (!live) return;
        setLead(settings.lead);
        // The default working directory from Settings; answering right away unless the last chat waited to be confirmed.
        setDefaults(
          autoTeam(cwdsOf({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds }), lastAutoConfirm(), settings.checksDefault),
        );
      })
      .catch((e) => {
        if (live) setLoadError(String(e.message ?? e));
      });
    return () => {
      live = false;
    };
  }, [lang]);

  if (!team || !lead) return <div className="page-center muted">{loadError || t.common.loading}</div>;

  const edit = (patch: Partial<ScheduleDraft>) => {
    update({ form: { ...latest.current.form, ...patch } });
    setError('');
  };
  const task = { ...draft, text: taskWithApps(draft.text, current.apps ?? [], t) };
  const problems = [...draftProblems(task, Date.now(), t), ...teamProblems(team, t, { maxAgents: maxTeamAgents })];
  const automatic = Boolean(team.settings.autoConfirm);
  // What the team editor warns about: the runs this schedule starts may have nobody watching.
  const schedule: ConversationSchedule = { ...toUpdate(task), lang, updatedAt: 0 };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      // The drawer that shows a webhook's token, loaded before the token is made: in a page open across an
      // update it cannot be, and the page reloads for it (`loadPart`), which would lose a token made first.
      if (withHook) await loadPart(() => import('./ScheduleDrawer'));
      const attachments = await readUploads(draft.files, t.composer.readFailed);
      const { newHook, ...conv } = await orCreateCwd(
        async (createCwd) => {
          await appChoices.verify();
          return api.createSchedule({
            title: title.trim() || undefined,
            settings: team.settings,
            createCwd,
            schedule: { ...toUpdate(task), ...(attachments.length ? { attachments } : {}) },
            ...(withHook ? { hook: true } : {}),
          });
        },
        (missing) => confirm(t.newChat.confirmCreateCwd(missing)),
      );
      rememberAutoConfirm(team.settings.autoConfirm);
      if (newHook) handOverHook(conv.id, newHook);
      onCreated(conv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CreationPage
      title={t.newSchedule.title}
      intro={
        <>
          {t.newSchedule.intro(leadLabel(lead), automatic)} <a href={settingsHref('lead')}>{t.newChat.changeLead}</a>
        </>
      }
      busy={busy}
      error={error}
      problem={savedDraft ? problems[0] : undefined}
      automation
      onSubmit={create}
      submitLabel={busy ? t.newSchedule.creating : t.newSchedule.create}
      disabled={problems.length > 0 || appChoices.checkingSelection || drafting || checksDrafting}
    >
      <ScheduleForm
        draft={draft}
        disabled={busy}
        onEdit={edit}
        onDrafting={setDrafting}
        settings={team.settings}
        creation={{
          apps: appChoices.selection,
          withHook,
          onHook: (checked) => update({ withHook: checked }),
        }}
      >
        <CreationOptions
          team={team}
          onTeam={(next) => update({ team: next })}
          providers={providers}
          catalog={catalog}
          title={title}
          onTitle={(next) => update({ title: next })}
          titlePlaceholder={t.newSchedule.titlePlaceholder}
          schedule={schedule}
          onDrafting={setChecksDrafting}
        />
      </ScheduleForm>
      <TemplateLibrary providers={providers} catalog={catalog} />
      <CreationTeamOptions team={team} onTeam={(next) => onDraft({ ...current, team: next })} automaticLabel={t.newSchedule.useTeam} />
    </CreationPage>
  );
}
