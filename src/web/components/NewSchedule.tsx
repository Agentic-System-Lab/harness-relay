import { useEffect, useState } from 'react';
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
import { autoTeam, lastAutoConfirm, rememberAutoConfirm } from './NewChat';
import { ScheduleForm } from './ScheduleForm';
import { TemplateLibrary } from './TemplateLibrary';
import { settingsHref } from '../route';
import { CreationOptions, CreationTeamOptions } from './CreationOptions';
import { teamProblems, type Team } from './TeamEditor';

export interface NewAutomationDraft {
  form: ScheduleDraft;
  title: string;
  withHook: boolean;
  team?: Team;
}

interface Props {
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
export function NewSchedule({ providers, catalog, onCreated, draft: savedDraft, onDraft, busy, setBusy, error, setError }: Props) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [defaults, setDefaults] = useState<Team | null>(null);
  const [initial] = useState<NewAutomationDraft>(() => ({ form: draftFrom(undefined, Date.now()), title: '', withHook: false }));
  const current = savedDraft ?? initial;
  const { form: draft, title, withHook } = current;
  const team = current.team ?? defaults;
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let live = true;
    api
      .getSettings()
      .then((settings) => {
        if (!live) return;
        setLead(settings.lead);
        // The default working directory from Settings; asking first unless the last chat did not.
        setDefaults(autoTeam(cwdsOf({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds }), lastAutoConfirm()));
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
    onDraft({ ...current, form: { ...draft, ...patch } });
    setError('');
  };
  const problems = [...draftProblems(draft, Date.now(), t), ...teamProblems(team, t, { maxAgents: maxTeamAgents })];
  const automatic = Boolean(team.settings.autoConfirm);
  // What the team editor warns about: the runs this schedule starts may have nobody watching.
  const schedule: ConversationSchedule = { ...toUpdate(draft), lang, updatedAt: 0 };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      // The drawer that shows a webhook's token, loaded before the token is made: in a page open across an
      // update it cannot be, and the page reloads for it (`loadPart`), which would lose a token made first.
      if (withHook) await loadPart(() => import('./ScheduleDrawer'));
      const { newHook, ...conv } = await orCreateCwd(
        (createCwd) =>
          api.createSchedule({
            title: title.trim() || undefined,
            settings: team.settings,
            createCwd,
            schedule: toUpdate(draft),
            ...(withHook ? { hook: true } : {}),
          }),
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
    <div className="page new-chat-page">
      <div className="scroll new-chat-body">
        <div className="page-inner">
          <header className="page-head">
            <h1>{t.newSchedule.title}</h1>
            <p className="muted">
              {t.newSchedule.intro(leadLabel(lead), automatic)} <a href={settingsHref('lead')}>{t.newChat.changeLead}</a>
            </p>
          </header>
          <fieldset className="first-task automation-task" disabled={busy} aria-label={t.newSchedule.title}>
            <ScheduleForm
              draft={draft}
              onEdit={edit}
              settings={team.settings}
              creation={{ withHook, onHook: (checked) => onDraft({ ...current, withHook: checked }) }}
            >
              <CreationOptions
                team={team}
                onTeam={(next) => onDraft({ ...current, team: next })}
                providers={providers}
                catalog={catalog}
                title={title}
                onTitle={(next) => onDraft({ ...current, title: next })}
                titlePlaceholder={t.newSchedule.titlePlaceholder}
                schedule={schedule}
              />
            </ScheduleForm>
            <TemplateLibrary providers={providers} catalog={catalog} />
            <div className="start-bar first-task-actions">
              <CreationTeamOptions
                team={team}
                onTeam={(next) => onDraft({ ...current, team: next })}
                automaticLabel={t.newSchedule.useTeam}
              />
              <button className="primary" onClick={create} disabled={busy || problems.length > 0}>
                {busy ? t.newSchedule.creating : t.newSchedule.create}
              </button>
            </div>
            {(error || (savedDraft && problems.length > 0)) && (
              <p role="alert" className="error-line">
                {error || problems[0]}
              </p>
            )}
          </fieldset>
        </div>
      </div>
    </div>
  );
}
