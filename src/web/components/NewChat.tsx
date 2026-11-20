import { useEffect, useState } from 'react';
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
import { startingChecks } from '../checks';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { settingsHref } from '../route';
import { leadLabel } from '../util';
import { readUploads, type PendingFile } from './MessageFiles';
import { TaskInput } from './TaskInput';
import { TemplateLibrary } from './TemplateLibrary';
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
  files: PendingFile[];
  question: string;
  title: string;
  team?: Team;
}
export const emptyChatDraft: NewChatDraft = { question: '', title: '', files: [] };

interface Props {
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

export function NewChat({ providers, catalog, draft, onDraft, busy, setBusy, error, setError, onCreated }: Props) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [defaults, setDefaults] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState('');

  const team = draft.team ?? defaults;

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

  const firstMessage = draft.question.trim();
  const canStart = Boolean(firstMessage) && !busy && problems.length === 0;
  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError('');
    try {
      const attachments = await readUploads(draft.files, t.composer.readFailed);
      const conv = await orCreateCwd(
        (createCwd) =>
          api.createConversation({
            title: draft.title,
            firstMessage,
            ...(attachments.length ? { attachments } : {}),
            agents: [],
            settings: team.settings,
            createCwd,
          }),
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
    <div className="page new-chat-page">
      <div className="scroll new-chat-body">
        <div className="page-inner">
          <header className="page-head">
            <h1>{t.newChat.title}</h1>
            <p className="muted">
              {t.newChat.intro(leadText, Boolean(team.settings.autoConfirm))} <a href={settingsHref('lead')}>{t.newChat.changeLead}</a>
            </p>
          </header>
          <fieldset className="first-task" disabled={busy} aria-label={t.newChat.title}>
            <label className="first-question" htmlFor="first-question">
              {t.newChat.question}
            </label>
            <TaskInput
              id="first-question"
              className="task-input"
              text={draft.question}
              onText={(question) => onDraft({ ...draft, question })}
              files={draft.files}
              onFiles={(files) => onDraft({ ...draft, files })}
              disabled={busy}
            />
            <CreationOptions
              team={team}
              onTeam={(next) => onDraft({ ...draft, team: next })}
              providers={providers}
              catalog={catalog}
              title={draft.title}
              onTitle={(title) => onDraft({ ...draft, title })}
              titlePlaceholder={t.newChat.titlePlaceholder}
            />
            <TemplateLibrary providers={providers} catalog={catalog} />
            <div className="start-bar first-task-actions">
              <CreationTeamOptions
                team={team}
                onTeam={(next) => onDraft({ ...draft, team: next })}
                automaticLabel={t.newChat.startImmediately}
              />
              <button className="primary" onClick={start} disabled={!canStart}>
                {busy ? t.newChat.creating : t.newChat.sendQuestion}
              </button>
            </div>
            {(problems.length > 0 || error) && (
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
