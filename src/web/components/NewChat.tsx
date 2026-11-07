import { useEffect, useState } from 'react';
import type { Conversation, ProviderModels, ProviderStatus, TeamPreset } from '../../shared/types';
import { api } from '../api';
import { PROVIDER_COLOR } from '../util';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';

const LAST_CWD_KEY = 'relay:lastCwd';

function readLastCwd(): string {
  try {
    return localStorage.getItem(LAST_CWD_KEY) ?? '';
  } catch {
    return '';
  }
}

function fromPreset(p: TeamPreset, cwd: string): Team {
  return {
    // Fresh ids so edits never leak back into the preset object.
    agents: p.agents.map((a) => ({ ...a, id: crypto.randomUUID() })),
    settings: { ...p.settings, cwd },
  };
}

interface Props {
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onCreated: (c: Conversation) => void;
}

export function NewChat({ providers, catalog, onCreated }: Props) {
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [presetId, setPresetId] = useState<string>('');
  const [team, setTeam] = useState<Team | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.listPresets(), api.getSettings()])
      .then(([ps, settings]) => {
        setPresets(ps);
        const first = ps[0];
        const cwd = readLastCwd() || settings.defaultCwd;
        if (first) {
          setPresetId(first.id);
          setTeam(fromPreset(first, cwd));
        }
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  if (!team) return <div className="page-center muted">{error || '載入中…'}</div>;

  const problems = teamProblems(team);

  const applyPreset = (p: TeamPreset) => {
    setPresetId(p.id);
    setTeam(fromPreset(p, team.settings.cwd));
  };

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const conv = await api.createConversation({ title, agents: team.agents, settings: team.settings });
      try {
        localStorage.setItem(LAST_CWD_KEY, conv.settings.cwd);
      } catch {
        /* storage unavailable */
      }
      onCreated(conv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async () => {
    const name = prompt('範本名稱', title || '我的團隊');
    if (!name) return;
    try {
      const saved = await api.savePreset({ name, agents: team.agents, settings: team.settings });
      setPresets((ps) => [...ps.filter((p) => p.id !== saved.id), saved]);
      setPresetId(saved.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deletePreset = async (p: TeamPreset) => {
    if (!confirm(`刪除範本「${p.name}」？`)) return;
    await api.deletePreset(p.id);
    setPresets((ps) => ps.filter((x) => x.id !== p.id));
  };

  return (
    <div className="page scroll">
      <div className="page-inner">
        <header className="page-head">
          <h1>設計這次的團隊</h1>
          <p className="muted">
            挑一個範本或從頭開始，決定每個 coding agent 的定位，以及他們怎麼互相溝通。對話中也能隨時調整。
          </p>
        </header>

        <section>
          <div className="section-head">
            <h3>範本</h3>
          </div>
          <div className="preset-row">
            {presets.map((p) => (
              <div key={p.id} className={`preset-card ${presetId === p.id ? 'on' : ''}`}>
                <button className="preset-main" onClick={() => applyPreset(p)}>
                  <span className="preset-dots">
                    {p.agents.map((a) => (
                      <i key={a.id} style={{ background: PROVIDER_COLOR[a.provider] }} />
                    ))}
                  </span>
                  <strong>{p.name}</strong>
                  {p.description && <span className="muted small">{p.description}</span>}
                </button>
                {!p.builtin && (
                  <button className="icon-button preset-delete" aria-label="刪除範本" onClick={() => deletePreset(p)}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <TeamEditor value={team} onChange={setTeam} providers={providers} catalog={catalog} />

        <footer className="start-bar">
          <input
            className="title-input"
            value={title}
            placeholder="對話標題（選填，預設取第一則訊息）"
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="ghost" onClick={savePreset} disabled={problems.length > 0}>
            存成範本
          </button>
          <button className="primary" onClick={start} disabled={busy || problems.length > 0}>
            {busy ? '建立中…' : '開始對話 →'}
          </button>
        </footer>
        {(problems.length > 0 || error) && <p className="error-line">{error || problems[0]}</p>}
      </div>
    </div>
  );
}
