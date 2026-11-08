import { useEffect, useState } from 'react';
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
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import { settingsHref } from '../route';
import { defaultOn, hasTool, itemsFor, setTool, toolItems, type ToolItem } from '../tools';
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
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [toolsError, setToolsError] = useState('');
  useEffect(() => {
    api.tools().then(
      (lib) => setTools(toolItems(lib)),
      (e: Error) => setToolsError(e.message),
    );
  }, []);
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

                  <div className="segmented" role="radiogroup" aria-label={t.team.codingAgent}>
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

                  <AgentTools agent={a} items={tools} error={toolsError} onChange={(next) => updateAgent(a.id, { tools: next })} />

                  {state !== 'ok' && status && (
                    <p className="warn-line">
                      {status.installed ? t.team.notLoggedIn(PROVIDER_LABEL[a.provider]) : t.team.cliMissing(PROVIDER_LABEL[a.provider])}
                      <a href={settingsHref(a.provider)}>{t.team.goSettings}</a>
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
          leadLabel && (
            <p className="muted small auto-note">
              {t.newChat.autoNote(leadLabel)} <a href={settingsHref('lead')}>{t.newChat.changeLead}</a>
            </p>
          )
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
                <span className="unit muted small">{t.team.hopsUnit}</span>
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
                <span className="unit muted small">{t.team.roundsUnit}</span>
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
              {!auto && (settings.mode === 'parallel' ? t.team.parallelNote : t.team.sharedNote)}
              {t.team.gitInitNote}
            </span>
          )}
        </div>

        {settings.permission !== 'full' && (
          <div className="field">
            <span>{t.team.approvals}</span>
            <div className="segmented wide" role="radiogroup" aria-label={t.team.approvals}>
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

/** The tool library items this agent gets, as chips; "Change" opens the list to tick them. */
function AgentTools({
  agent,
  items: all,
  error,
  onChange,
}: {
  agent: AgentConfig;
  items: ToolItem[];
  /** The library could not be loaded: say so rather than call it empty. */
  error: string;
  onChange: (tools: AgentConfig['tools']) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const items = itemsFor(all, agent.provider);
  const given = items.filter((i) => hasTool(agent, i));
  const label = (i: ToolItem) =>
    i.kind !== 'memory' ? i.name : i.name === 'all' ? t.team.toolMemory : t.team.toolProviderMemory(PROVIDER_LABEL[agent.provider]);
  const kind = (i: ToolItem) => (i.kind === 'mcp' ? 'MCP' : i.kind === 'skill' ? 'Skill' : '');
  return (
    <div className="field agent-tools">
      <span>{t.team.tools}</span>
      {error ? (
        <p className="warn-line small">{error}</p>
      ) : items.length === 0 ? (
        <p className="muted small">
          {t.team.toolsEmpty} <a href={settingsHref('tools')}>{t.team.goToolLibrary}</a>
        </p>
      ) : (
        <>
          <div className="agent-tools-summary">
            {given.length ? (
              given.map((i) => (
                <span key={i.key} className="tool-chip" title={i.problem}>
                  {kind(i) && <span className="tool-kind">{kind(i)}</span>}
                  {label(i)}
                </span>
              ))
            ) : (
              <span className="muted small">{t.team.toolsNone}</span>
            )}
            <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t.team.toolsDone : t.team.toolsEdit}
            </button>
          </div>
          {open && (
            <>
              <p className="muted small">{t.team.toolsHint}</p>
              <ul>
                {items.map((i) => (
                  <li key={i.key}>
                    <label className="check-row">
                      <input type="checkbox" checked={hasTool(agent, i)} onChange={(e) => onChange(setTool(agent, i, e.target.checked))} />
                      {kind(i) && <span className="tool-kind">{kind(i)}</span>}
                      <span>{label(i)}</span>
                      {!defaultOn(i, agent.provider) && <span className="muted small">· {t.team.toolOffByDefault}</span>}
                      {i.problem && (
                        <span className="warn-line small" title={i.problem}>
                          · {t.team.toolProblem}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
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
