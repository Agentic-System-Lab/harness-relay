import { useEffect, useRef, useState } from 'react';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  type AgentConfig,
  type Conversation,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
  type TeamPreset,
} from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { leadLabel, newAgent } from '../util';
import { PencilIcon } from './icons';
import { Logo } from './Logo';
import { MemberDots } from './MemberDots';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';

const LAST_CWD_KEY = 'relay:lastCwd';
const LAST_CHOICE_KEY = 'relay:lastTemplate';
/** The "Auto team" card: the lead agent designs the team from the first message. */
const AUTO = 'auto';
/** The "Design your own" card: a blank team the user fills in. */
const CUSTOM = 'custom';

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function fromPreset(p: TeamPreset, cwd: string): Team {
  return {
    // Fresh ids so edits never leak back into the preset object.
    agents: p.agents.map((a) => ({ ...a, id: crypto.randomUUID() })),
    settings: { ...p.settings, cwd },
  };
}

function autoTeam(cwd: string, permission: Team['settings']['permission']): Team {
  return { agents: [], settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission, cwd, autoTeam: true } };
}

/** One member per CLI that is ready to use (all of them when none is known yet), roles left to the user. */
function blankTeam(cwd: string, permission: Team['settings']['permission'], providers: ProviderStatus[]): Team {
  const ready = providers.filter((s) => s.installed && (s.auth.loggedIn !== false || s.usingStoredApiKey)).map((s) => s.provider);
  const agents: AgentConfig[] = [];
  for (const p of ready.length ? ready : PROVIDERS) agents.push(newAgent(p, agents.map((a) => a.name)));
  return { agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission, cwd } };
}

interface Props {
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onCreated: (c: Conversation) => void;
}

export function NewChat({ providers, catalog, onCreated }: Props) {
  const { t, lang } = useI18n();
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [team, setTeam] = useState<Team | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const initialized = useRef(false);

  // Built-in templates come back in the UI language, so reload them when it changes.
  useEffect(() => {
    Promise.all([api.listPresets(), api.getSettings()])
      .then(([ps, settings]) => {
        setPresets(ps);
        setLead(settings.lead);
        if (initialized.current) return;
        initialized.current = true;
        // Start from the last choice (auto team the first time).
        const cwd = read(LAST_CWD_KEY) || settings.defaultCwd;
        const last = read(LAST_CHOICE_KEY);
        const preset = ps.find((p) => p.id === last);
        if (preset) {
          setChoice(preset.id);
          setTeam(fromPreset(preset, cwd));
        } else if (last === CUSTOM) {
          setChoice(CUSTOM);
          setTeam(blankTeam(cwd, 'read-only', providers));
        } else {
          setChoice(AUTO);
          setTeam(autoTeam(cwd, 'read-only'));
        }
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [lang]);

  if (!team) return <div className="page-center muted">{error || t.common.loading}</div>;

  const problems = teamProblems(team, t);
  const auto = Boolean(team.settings.autoTeam);
  const leadText = lead ? leadLabel(lead) : PROVIDER_LABEL.claude;

  const pick = (id: string) => {
    setChoice(id);
    if (id === AUTO) {
      setTeam(autoTeam(team.settings.cwd, team.settings.permission));
      return;
    }
    if (id === CUSTOM) {
      setTeam(blankTeam(team.settings.cwd, team.settings.permission, providers));
      return;
    }
    const p = presets.find((x) => x.id === id);
    if (p) setTeam(fromPreset(p, team.settings.cwd));
  };

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const conv = await api.createConversation({ title, agents: team.agents, settings: team.settings });
      write(LAST_CWD_KEY, conv.settings.cwd);
      write(LAST_CHOICE_KEY, choice);
      onCreated(conv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async () => {
    const name = prompt(t.newChat.templateNamePrompt, title || t.newChat.defaultTemplateName);
    if (!name) return;
    try {
      const saved = await api.savePreset({ name, agents: team.agents, settings: team.settings });
      setPresets((ps) => [...ps.filter((p) => p.id !== saved.id), saved]);
      setChoice(saved.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deletePreset = async (p: TeamPreset) => {
    if (!confirm(t.newChat.confirmDeleteTemplate(p.name))) return;
    try {
      await api.deletePreset(p.id);
      setPresets((ps) => ps.filter((x) => x.id !== p.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page scroll">
      <div className="page-inner">
        <header className="page-head">
          <h1>{t.newChat.title}</h1>
          <p className="muted">{t.newChat.intro}</p>
        </header>

        <section>
          <div className="section-head">
            <h3>{t.newChat.buildTeam}</h3>
          </div>
          <div className="preset-row build-modes">
            <div className={`preset-card auto ${choice === AUTO ? 'on' : ''}`}>
              <button className="preset-main" onClick={() => pick(AUTO)} aria-pressed={choice === AUTO}>
                <Logo size={18} />
                <strong>{t.newChat.autoName}</strong>
                <span className="muted small">{t.newChat.autoDescription(leadText)}</span>
              </button>
            </div>
            <div className={`preset-card custom ${choice === CUSTOM ? 'on' : ''}`}>
              <button className="preset-main" onClick={() => pick(CUSTOM)} aria-pressed={choice === CUSTOM}>
                <PencilIcon />
                <strong>{t.newChat.customName}</strong>
                <span className="muted small">{t.newChat.customDescription}</span>
              </button>
            </div>
          </div>
        </section>

        <section>
          <div className="section-head">
            <h3>{t.newChat.templates}</h3>
            <span className="muted small">{t.newChat.templatesHint}</span>
          </div>
          <div className="preset-row">
            {presets.map((p) => (
              <div key={p.id} className={`preset-card ${choice === p.id ? 'on' : ''}`}>
                <button className="preset-main" onClick={() => pick(p.id)} aria-pressed={choice === p.id}>
                  <MemberDots agents={p.agents} className="preset-dots" max={6} />
                  <strong>{p.name}</strong>
                  {p.description && <span className="muted small">{p.description}</span>}
                </button>
                {!p.builtin && (
                  <button className="icon-button preset-delete" aria-label={t.newChat.deleteTemplate} onClick={() => deletePreset(p)}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <TeamEditor value={team} onChange={setTeam} providers={providers} catalog={catalog} leadLabel={leadText} />

        {!auto && (
          <div className="save-template-row">
            <span className="muted small">{t.newChat.saveTemplateHint}</span>
            <button className="ghost" onClick={savePreset} disabled={problems.length > 0}>
              {t.newChat.saveTemplate}
            </button>
          </div>
        )}

        <footer className="start-bar">
          <input
            className="title-input"
            value={title}
            placeholder={t.newChat.titlePlaceholder}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="primary" onClick={start} disabled={busy || problems.length > 0}>
            {busy ? t.newChat.creating : t.newChat.start}
          </button>
        </footer>
        {(problems.length > 0 || error) && <p className="error-line">{error || problems[0]}</p>}
      </div>
    </div>
  );
}
