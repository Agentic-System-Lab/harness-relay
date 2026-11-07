import {
  PROVIDERS,
  PROVIDER_LABEL,
  inheritedEffort,
  type AgentConfig,
  type ConversationSettings,
  type Mode,
  type Permission,
  type ProviderModels,
  type ProviderStatus,
} from '../../shared/types';
import { useT, type Messages } from '../i18n';
import { PROVIDER_COLOR, initials, newAgent } from '../util';
import { ModelPicker } from './ModelPicker';
import { providerState } from './Sidebar';

export interface Team {
  agents: AgentConfig[];
  settings: ConversationSettings;
}

interface Props {
  value: Team;
  onChange: (t: Team) => void;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  /** Auto team: the lead agent decides members, mode and rounds; only shown when set. */
  leadLabel?: string;
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];
const PERMISSIONS: Permission[] = ['read-only', 'edit', 'full'];

export function teamProblems(team: Team, t: Messages): string[] {
  const p = t.team.problems;
  const out: string[] = [];
  if (!team.settings.autoTeam) {
    if (team.agents.length === 0) out.push(p.needAgent);
    const seen = new Set<string>();
    for (const a of team.agents) {
      if (!NAME_RE.test(a.name)) out.push(p.badName(a.name));
      else if (seen.has(a.name.toLowerCase())) out.push(p.duplicate(a.name));
      seen.add(a.name.toLowerCase());
    }
  }
  if (!team.settings.cwd.trim()) out.push(p.needCwd);
  return out;
}

export function TeamEditor({ value, onChange, providers, catalog, leadLabel }: Props) {
  const t = useT();
  const { agents, settings } = value;
  const auto = Boolean(settings.autoTeam);
  const setAgents = (next: AgentConfig[]) => onChange({ ...value, agents: next });
  const setSettings = (patch: Partial<ConversationSettings>) => onChange({ ...value, settings: { ...settings, ...patch } });
  const updateAgent = (id: string, patch: Partial<AgentConfig>) =>
    setAgents(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...agents];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setAgents(next);
  };

  return (
    <div className="team-editor">
      {!auto && (
        <section>
          <div className="section-head">
            <h3>{t.team.members}</h3>
            <span className="muted small">{settings.mode === 'relay' ? t.team.relayOrder : t.team.order}</span>
          </div>

          <div className="agent-grid">
            {agents.map((a, i) => {
              const status = providers.find((p) => p.provider === a.provider);
              const state = providerState(status);
              return (
                <div key={a.id} className="agent-card" style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}>
                  <div className="agent-card-head">
                    <span className="avatar">{initials(a.name)}</span>
                    <label className="handle-input">
                      <span>@</span>
                      <input
                        value={a.name}
                        onChange={(e) => updateAgent(a.id, { name: e.target.value.replace(/[\s@]/g, '') })}
                        aria-label={t.team.agentName}
                        maxLength={32}
                      />
                    </label>
                    <div className="card-actions">
                      <button className="icon-button" aria-label={t.team.moveUp} disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button
                        className="icon-button"
                        aria-label={t.team.moveDown}
                        disabled={i === agents.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={t.common.remove}
                        onClick={() => setAgents(agents.filter((x) => x.id !== a.id))}
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div className="segmented" role="radiogroup" aria-label="Coding agent">
                    {PROVIDERS.map((p) => (
                      <button
                        key={p}
                        role="radio"
                        aria-checked={a.provider === p}
                        className={a.provider === p ? 'on' : ''}
                        style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
                        onClick={() => a.provider !== p && updateAgent(a.id, { provider: p, model: '', effort: '' })}
                      >
                        {PROVIDER_LABEL[p]}
                      </button>
                    ))}
                  </div>

                  <label className="field">
                    <span>{t.team.role}</span>
                    <textarea
                      value={a.role}
                      rows={5}
                      placeholder={t.team.rolePlaceholder}
                      onChange={(e) => updateAgent(a.id, { role: e.target.value })}
                    />
                  </label>

                  <AgentModelPicker
                    key={a.provider}
                    agent={a}
                    catalog={catalog.find((c) => c.provider === a.provider)}
                    onChange={(v) => updateAgent(a.id, v)}
                  />

                  {state !== 'ok' && status && (
                    <p className="warn-line">
                      {status.installed ? t.team.notLoggedIn(PROVIDER_LABEL[a.provider]) : t.team.cliMissing(PROVIDER_LABEL[a.provider])}
                      <a href="#/settings">{t.team.goSettings}</a>
                    </p>
                  )}
                </div>
              );
            })}

            <div className="agent-card add-card">
              <span className="muted small">{t.team.addMember}</span>
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  className="add-agent"
                  style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
                  disabled={agents.length >= 8}
                  onClick={() => setAgents([...agents, newAgent(p, agents.map((a) => a.name))])}
                >
                  ＋ {PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h3>{t.team.rules}</h3>
        </div>
        {auto ? (
          leadLabel && <p className="muted small auto-note">{t.newChat.autoNote(leadLabel)}</p>
        ) : (
          <div className="option-row">
            {MODES.map((m) => (
              <button
                key={m}
                className={`option-card ${settings.mode === m ? 'on' : ''}`}
                onClick={() => setSettings({ mode: m })}
                aria-pressed={settings.mode === m}
              >
                <strong>{t.modes[m].label}</strong>
                <span>{t.modes[m].hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="settings-grid">
          {!auto &&
            (settings.mode === 'relay' ? (
              <label className="field inline">
                <span>{t.team.relayLimit}</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={settings.maxHops}
                  onChange={(e) => setSettings({ maxHops: Number(e.target.value) })}
                />
                <span className="muted small">{t.team.hopsUnit}</span>
              </label>
            ) : (
              <label className="field inline">
                <span>{t.team.rounds}</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={settings.rounds}
                  onChange={(e) => setSettings({ rounds: Number(e.target.value) })}
                />
                <span className="muted small">{t.team.roundsUnit}</span>
              </label>
            ))}

          <label className="field inline grow">
            <span>{t.team.cwd}</span>
            <input
              value={settings.cwd}
              placeholder="/path/to/project"
              onChange={(e) => setSettings({ cwd: e.target.value })}
              spellCheck={false}
            />
          </label>
        </div>

        <div className="field">
          <span>{t.team.permission}</span>
          <div className="segmented wide">
            {PERMISSIONS.map((p) => (
              <button
                key={p}
                className={`${settings.permission === p ? 'on' : ''} ${p === 'full' ? 'danger' : ''}`}
                onClick={() => setSettings({ permission: p })}
                aria-pressed={settings.permission === p}
              >
                {t.permissions[p].label}
              </button>
            ))}
          </div>
          <span className={`small ${settings.permission === 'full' ? 'danger-text' : 'muted'}`}>
            {t.permissions[settings.permission].hint}
          </span>
          {settings.permission !== 'read-only' && (
            <span className="small muted">
              {!auto && (settings.mode === 'parallel' ? t.team.parallelNote : t.team.sharedNote)} {t.team.gitInitNote}
            </span>
          )}
        </div>

        {settings.permission !== 'full' && (
          <div className="field">
            <span>{t.team.approvals}</span>
            <div className="segmented" role="radiogroup" aria-label={t.team.approvals}>
              {(['ask', 'deny'] as const).map((v) => {
                const on = (settings.approvals ?? 'ask') === v;
                return (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={on}
                    className={on ? 'on' : ''}
                    onClick={() => setSettings({ approvals: v === 'ask' ? undefined : 'deny' })}
                  >
                    {v === 'ask' ? t.team.approvalsAsk : t.team.approvalsDeny}
                  </button>
                );
              })}
            </div>
            <span className="small muted">{t.team.approvalsHint[settings.approvals ?? 'ask']}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function AgentModelPicker({
  agent,
  catalog,
  onChange,
}: {
  agent: AgentConfig;
  catalog?: ProviderModels;
  onChange: (v: { model: string; effort: string }) => void;
}) {
  const t = useT();
  return (
    <ModelPicker
      catalog={catalog}
      model={agent.model ?? ''}
      effort={agent.effort ?? ''}
      onChange={onChange}
      inheritModelLabel={t.team.defaultModel(catalog?.defaultModel ?? (catalog ? t.team.cliDecides : t.common.loading))}
      inheritEffortLabel={(model) => {
        const e = catalog && inheritedEffort(catalog, model);
        return t.team.defaultModel(e ? t.effortLabel(e) : t.team.cliDecides);
      }}
    />
  );
}
