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
import { MODE_INFO, PERMISSION_INFO, PROVIDER_COLOR, effortLabel, initials, newAgent } from '../util';
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
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

export function teamProblems(t: Team): string[] {
  const out: string[] = [];
  if (t.agents.length === 0) out.push('至少需要一個 agent');
  const seen = new Set<string>();
  for (const a of t.agents) {
    if (!NAME_RE.test(a.name)) out.push(`名稱「${a.name || '(空白)'}」只能用字母、數字、_ 或 -`);
    else if (seen.has(a.name.toLowerCase())) out.push(`名稱 @${a.name} 重複`);
    seen.add(a.name.toLowerCase());
  }
  if (!t.settings.cwd.trim()) out.push('請填寫工作目錄');
  return out;
}

export function TeamEditor({ value, onChange, providers, catalog }: Props) {
  const { agents, settings } = value;
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
      <section>
        <div className="section-head">
          <h3>團隊成員</h3>
          <span className="muted small">
            {settings.mode === 'relay' ? '第一位是隊長：訊息沒有 @ 任何人時由他先接。' : '順序就是發言順序。'}
          </span>
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
                      aria-label="Agent 名稱"
                      maxLength={32}
                    />
                  </label>
                  <div className="card-actions">
                    <button className="icon-button" aria-label="往前" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button
                      className="icon-button"
                      aria-label="往後"
                      disabled={i === agents.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="icon-button danger"
                      aria-label="移除"
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
                  <span>定位 / 角色</span>
                  <textarea
                    value={a.role}
                    rows={5}
                    placeholder={'例如：你是資深後端工程師，負責 API 設計與實作。\n完成後 @Reviewer 請他審查。'}
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
                    {status.installed ? `${PROVIDER_LABEL[a.provider]} 尚未登入。` : `找不到 ${PROVIDER_LABEL[a.provider]} CLI。`}
                    <a href="#/settings">前往設定 →</a>
                  </p>
                )}
              </div>
            );
          })}

          <div className="agent-card add-card">
            <span className="muted small">新增成員</span>
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

      <section>
        <div className="section-head">
          <h3>對話規則</h3>
        </div>
        <div className="option-row">
          {(Object.keys(MODE_INFO) as Mode[]).map((m) => (
            <button
              key={m}
              className={`option-card ${settings.mode === m ? 'on' : ''}`}
              onClick={() => setSettings({ mode: m })}
              aria-pressed={settings.mode === m}
            >
              <strong>{MODE_INFO[m].label}</strong>
              <span>{MODE_INFO[m].hint}</span>
            </button>
          ))}
        </div>

        <div className="settings-grid">
          {settings.mode === 'relay' ? (
            <label className="field inline">
              <span>接力上限</span>
              <input
                type="number"
                min={1}
                max={30}
                value={settings.maxHops}
                onChange={(e) => setSettings({ maxHops: Number(e.target.value) })}
              />
              <span className="muted small">棒 / 每則訊息</span>
            </label>
          ) : (
            <label className="field inline">
              <span>討論輪數</span>
              <input
                type="number"
                min={1}
                max={5}
                value={settings.rounds}
                onChange={(e) => setSettings({ rounds: Number(e.target.value) })}
              />
              <span className="muted small">輪 / 每則訊息</span>
            </label>
          )}

          <label className="field inline grow">
            <span>工作目錄</span>
            <input
              value={settings.cwd}
              placeholder="/path/to/project"
              onChange={(e) => setSettings({ cwd: e.target.value })}
              spellCheck={false}
            />
          </label>
        </div>

        <div className="field">
          <span>檔案權限（所有成員共用）</span>
          <div className="segmented wide">
            {(Object.keys(PERMISSION_INFO) as Permission[]).map((p) => (
              <button
                key={p}
                className={`${settings.permission === p ? 'on' : ''} ${p === 'full' ? 'danger' : ''}`}
                onClick={() => setSettings({ permission: p })}
                aria-pressed={settings.permission === p}
              >
                {PERMISSION_INFO[p].label}
              </button>
            ))}
          </div>
          <span className={`small ${settings.permission === 'full' ? 'danger-text' : 'muted'}`}>
            {PERMISSION_INFO[settings.permission].hint}
          </span>
          {settings.permission !== 'read-only' && (
            <span className="small muted">
              {settings.mode === 'parallel'
                ? '平行模式：每位成員在自己的 git worktree 工作，不會互相覆蓋；完成後在聊天中檢視 diff，再選擇要套用誰的結果。'
                : '成員直接在工作目錄修改檔案，每回合改了什麼都會記錄下來；同一個目錄一次只允許一個對話修改。'}
              工作目錄若還不是 git repository，會自動 git init。
            </span>
          )}
        </div>
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
  return (
    <ModelPicker
      catalog={catalog}
      model={agent.model ?? ''}
      effort={agent.effort ?? ''}
      onChange={onChange}
      inheritModelLabel={`預設：${catalog?.defaultModel ?? (catalog ? 'CLI 決定' : '載入中…')}`}
      inheritEffortLabel={(model) => {
        const e = catalog && inheritedEffort(catalog, model);
        return `預設：${e ? effortLabel(e) : 'CLI 決定'}`;
      }}
    />
  );
}
