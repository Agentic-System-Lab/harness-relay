import { useEffect, useState } from 'react';
import {
  cwdSettings,
  cwdsOf,
  type Conversation,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
  type TeamPreset,
} from '../../shared/types';
import { api, orCreateCwd } from '../api';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { settingsHref } from '../route';
import { leadLabel } from '../util';
import { Deferred, lazyPart } from './Deferred';
import { MemberDots } from './MemberDots';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';

// Loaded when a template is first opened, not with the page.
const TemplateEditor = lazyPart(() => import('./TemplateEditor').then((m) => m.TemplateEditor));

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
 * with lead review on (the box ticked each time: only the user turns it off, here or later in the chat).
 */
export function autoTeam(cwds: string[], autoConfirm: boolean): Team {
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
    },
  };
}

/** The template open in the dialog (none: a new one); `key` gives each opening a fresh editor. */
type Editing = { key: string; preset?: TeamPreset };

/** Kept by the signed-in application while the user visits settings or another chat. */
export interface NewChatDraft {
  question: string;
  title: string;
  team?: Team;
}
export const emptyChatDraft: NewChatDraft = { question: '', title: '' };

interface Props {
  draft: NewChatDraft;
  onDraft: (draft: NewChatDraft) => void;
  onVisitLead: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onCreated: (c: Conversation) => void;
}

export function NewChat({ providers, catalog, draft, onDraft, onVisitLead, busy, setBusy, onCreated }: Props) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [defaults, setDefaults] = useState<Team | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState('');

  const team = draft.team ?? defaults;

  // Built-in templates come back in the UI language, so reload them when it changes.
  useEffect(() => {
    let current = true;
    Promise.all([api.listPresets(), api.getSettings()])
      .then(([ps, settings]) => {
        if (!current) return;
        setPresets(ps);
        setLead(settings.lead);
        // The default working directory from Settings; asking first unless the last chat did not.
        setDefaults(autoTeam(cwdsOf({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds }), lastAutoConfirm()));
      })
      .catch((e) => {
        if (current) setError(String(e.message ?? e));
      });
    return () => {
      current = false;
    };
  }, [lang]);

  if (!team || !lead) return <div className="page-center muted">{error || t.common.loading}</div>;

  const problems = teamProblems(team, t, { maxAgents: maxTeamAgents });
  const leadText = leadLabel(lead);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const conv = await orCreateCwd(
        (createCwd) =>
          api.createConversation({
            title: draft.title,
            firstMessage: draft.question.trim() || undefined,
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

  const open = (preset?: TeamPreset) => setEditing({ key: preset ? preset.id : `new-${Date.now()}`, preset });

  const saved = (p: TeamPreset) => {
    setPresets((ps) => (ps.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [...ps, p]));
    setEditing(null);
  };

  const deletePreset = async (p: TeamPreset) => {
    if (!confirm(t.newChat.confirmDeleteTemplate(p.name))) return;
    try {
      await api.deletePreset(p.id);
      setPresets((ps) => ps.filter((x) => x.id !== p.id));
      if (editing?.preset?.id === p.id) setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page new-chat-page">
      <div className="scroll new-chat-body">
        <div className="page-inner">
          <header className="page-head">
            <h1>{t.newChat.title}</h1>
            <p className="muted">
              {t.newChat.intro(leadText, Boolean(team.settings.autoConfirm))}{' '}
              <a href={settingsHref('lead')} onClick={onVisitLead}>
                {t.newChat.changeLead}
              </a>
            </p>
          </header>
          <fieldset className="first-task" disabled={busy} aria-label={t.newChat.title}>
            <label className="first-question" htmlFor="first-question">
              {t.newChat.question}
            </label>
            <textarea
              id="first-question"
              rows={4}
              value={draft.question}
              onChange={(e) => onDraft({ ...draft, question: e.target.value })}
            />
            <details className="chat-options">
              <summary>
                <strong>{t.newChat.options}</strong>
                <span className="muted small">{[t.permissions[team.settings.permission].label, ...cwdsOf(team.settings)].join(' · ')}</span>
              </summary>
              <TeamEditor
                value={team}
                onChange={(next) => onDraft({ ...draft, team: next })}
                providers={providers}
                catalog={catalog}
                confirmInEditor={false}
              />
              <label className="field">
                <span>{t.newChat.optionalTitle}</span>
                <input
                  className="title-input"
                  value={draft.title}
                  placeholder={t.newChat.titlePlaceholder}
                  onChange={(e) => onDraft({ ...draft, title: e.target.value })}
                />
              </label>
            </details>
            <div className="start-bar first-task-actions">
              <fieldset className="team-confirmation">
                <legend>{t.newChat.afterDesign}</legend>
                {[false, true].map((auto) => (
                  <label key={String(auto)}>
                    <input
                      type="radio"
                      name="team-confirmation"
                      checked={Boolean(team.settings.autoConfirm) === auto}
                      onChange={() =>
                        onDraft({ ...draft, team: { ...team, settings: { ...team.settings, autoConfirm: auto || undefined } } })
                      }
                    />
                    {auto ? t.newChat.startImmediately : t.newChat.waitForMe}
                  </label>
                ))}
              </fieldset>
              <button className="primary" onClick={start} disabled={busy || problems.length > 0}>
                {busy ? t.newChat.creating : draft.question.trim() ? t.newChat.sendQuestion : t.newChat.start}
              </button>
            </div>
            {(problems.length > 0 || error) && (
              <p role="alert" className="error-line">
                {error || problems[0]}
              </p>
            )}
          </fieldset>
          <details className="template-library">
            <summary>{t.newChat.templates}</summary>
            <p className="muted small">{t.newChat.templatesHint}</p>
            <div className="preset-row">
              {presets.map((p) => (
                <div key={p.id} className="preset-card">
                  {/* Every card the same size: a long name or description ends in "…" (in full on hover). */}
                  <button className="preset-main" onClick={() => open(p)} aria-haspopup="dialog">
                    <span className="preset-top">
                      <MemberDots agents={p.agents} className="preset-dots" max={6} />
                      {p.builtin && <span className="preset-tag">{t.newChat.builtin}</span>}
                    </span>
                    <strong className="preset-name" title={p.name}>
                      {p.name}
                    </strong>
                    {p.description && (
                      <span className="muted small preset-desc" title={p.description}>
                        {p.description}
                      </span>
                    )}
                  </button>
                  {!p.builtin && (
                    <button className="icon-button preset-delete" aria-label={t.newChat.deleteTemplate} onClick={() => deletePreset(p)}>
                      ×
                    </button>
                  )}
                </div>
              ))}
              <div className="preset-card new-template">
                <button className="preset-main" onClick={() => open()} aria-haspopup="dialog">
                  <strong className="preset-name">＋ {t.newChat.newTemplate}</strong>
                  <span className="muted small preset-desc">{t.newChat.newTemplateDescription}</span>
                </button>
              </div>
            </div>
          </details>
        </div>
      </div>
      {editing && (
        <Deferred onClose={() => setEditing(null)}>
          <TemplateEditor
            key={editing.key}
            preset={editing.preset}
            providers={providers}
            catalog={catalog}
            onSaved={saved}
            onClose={() => setEditing(null)}
          />
        </Deferred>
      )}
    </div>
  );
}
