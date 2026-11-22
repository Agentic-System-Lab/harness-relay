import { useEffect, useRef, useState } from 'react';
import {
  cwdSettings,
  cwdsOf,
  type CheckList,
  type Conversation,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
} from '../../shared/types';
import { api, orCreateCwd } from '../api';
import type { DraftApp } from '../../shared/apps';
import { taskWithApps } from '../draftApps';
import type { DraftAppStatus } from '../draftAppStatus';
import { useDraftApps } from '../useDraftApps';
import { startingChecks } from '../checks';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { settingsHref } from '../route';
import { leadLabel } from '../util';
import { readUploads, type PendingFile } from './MessageFiles';
import { TaskInput } from './TaskInput';
import { TemplateLibrary } from './TemplateLibrary';
import { CreationPage } from './CreationPage';
import { CreationOptions, CreationTeamOptions } from './CreationOptions';
import { teamProblems, type Team } from './TeamEditor';

/** Whether the last new chat used the lead agent's teams without asking ("1"), so the next one starts the same way. */
const AUTO_CONFIRM_KEY = 'relay:autoConfirm';

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** Whether the last new chat (or schedule) used the lead agent's teams without asking. */
export const lastAutoConfirm = () => read(AUTO_CONFIRM_KEY) === '1';

/** Remember whether this one did, so the next one starts the same way. */
export const rememberAutoConfirm = (on: boolean | undefined) => write(AUTO_CONFIRM_KEY, on ? '1' : '');

/**
 * A new conversation: the lead agent designs the team for each question, so only the settings are
 * chosen here. It starts in the default working directories (`cwds`, the first where agents start),
 * with lead review on (the box ticked each time: only the user turns it off, here or later in the chat),
 * and with Settings' default team checks (`checksDefault`), there to change or remove.
 */
export function autoTeam(cwds: string[], autoConfirm: boolean, checksDefault?: CheckList): Team {
  const checks = startingChecks(checksDefault);
  return {
    agents: [],
    settings: {
      mode: 'roundtable',
      rounds: 1,
      maxHops: 8,
      permission: 'read-only',
      ...cwdSettings(cwds),
      autoTeam: true,
      ...(autoConfirm ? { autoConfirm } : {}),
      leadReview: true,
      ...(checks ? { checks } : {}),
    },
  };
}

/** Kept by the signed-in application while the user visits settings or another chat. */
export interface NewChatDraft {
  apps?: DraftApp[];
  files: PendingFile[];
  question: string;
  title: string;
  team?: Team;
}
export const emptyChatDraft: NewChatDraft = { question: '', title: '', files: [] };

interface Props {
  appStatus: DraftAppStatus;
  draft: NewChatDraft;
  onDraft: (draft: NewChatDraft) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (message: string) => void;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onCreated: (c: Conversation) => void;
}

export function NewChat({ appStatus, providers, catalog, draft, onDraft, busy, setBusy, error, setError, onCreated }: Props) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [defaults, setDefaults] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState('');
  /** The lead agent writes the team checks: the chat cannot be started meanwhile. */
  const [drafting, setDrafting] = useState(false);
  /** The draft now: what the lead agent writes lands on it, not on the draft as it was when it was asked. */
  const latest = useRef(draft);
  latest.current = draft;
  const update = (patch: Partial<NewChatDraft>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    onDraft(next);
  };

  const team = draft.team ?? defaults;
  const appChoices = useDraftApps(appStatus, draft.apps ?? [], (apps) => onDraft({ ...draft, apps }), team?.settings.permission);

  useEffect(() => {
    let current = true;
    api
      .getSettings()
      .then((settings) => {
        if (!current) return;
        setLead(settings.lead);
        // The default working directory from Settings; asking first unless the last chat did not.
        setDefaults(
          autoTeam(cwdsOf({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds }), lastAutoConfirm(), settings.checksDefault),
        );
      })
      .catch((e) => {
        if (current) setLoadError(String(e.message ?? e));
      });
    return () => {
      current = false;
    };
  }, [lang]);

  if (!team || !lead) return <div className="page-center muted">{loadError || t.common.loading}</div>;

  const problems = teamProblems(team, t, { maxAgents: maxTeamAgents });
  const leadText = leadLabel(lead);

  const firstMessage = taskWithApps(draft.question, draft.apps ?? [], t);
  const canStart = Boolean(firstMessage) && !busy && !appChoices.checkingSelection && problems.length === 0;
  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError('');
    try {
      const attachments = await readUploads(draft.files, t.composer.readFailed);
      const conv = await orCreateCwd(
        async (createCwd) => {
          await appChoices.verify();
          return api.createConversation({
            title: draft.title,
            firstMessage,
            ...(attachments.length ? { attachments } : {}),
            agents: [],
            settings: team.settings,
            createCwd,
          });
        },
        (missing) => confirm(t.newChat.confirmCreateCwd(missing)),
      );
      rememberAutoConfirm(team.settings.autoConfirm);
      onCreated(conv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CreationPage
      title={t.newChat.title}
      intro={
        <>
          {t.newChat.intro(leadText, Boolean(team.settings.autoConfirm))} <a href={settingsHref('lead')}>{t.newChat.changeLead}</a>
        </>
      }
      busy={busy}
      error={error}
      problem={problems[0]}
      onSubmit={start}
      submitLabel={busy ? t.newChat.creating : t.newChat.sendQuestion}
      disabled={!canStart || drafting}
    >
      <label className="first-question" htmlFor="first-question">
        {t.newChat.question}
      </label>
      <TaskInput
        id="first-question"
        placeholder={t.newChat.example}
        creation
        apps={appChoices.selection}
        text={draft.question}
        onText={(question) => onDraft({ ...draft, question })}
        files={draft.files}
        onFiles={(files) => onDraft({ ...draft, files })}
        disabled={busy}
      />
      <CreationOptions
        team={team}
        onTeam={(next) => update({ team: next })}
        providers={providers}
        catalog={catalog}
        title={draft.title}
        onTitle={(title) => update({ title })}
        titlePlaceholder={t.newChat.titlePlaceholder}
        onDrafting={setDrafting}
      />
      <TemplateLibrary providers={providers} catalog={catalog} />
      <CreationTeamOptions team={team} onTeam={(next) => onDraft({ ...draft, team: next })} automaticLabel={t.newChat.startImmediately} />
    </CreationPage>
  );
}
