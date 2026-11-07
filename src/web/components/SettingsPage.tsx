import { useEffect, useRef, useState } from 'react';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  type LoginMethod,
  type ProviderModels,
  type LoginSessionView,
  type Provider,
  type ProviderSettingsView,
  type ProviderStatus,
  type SettingsView,
} from '../../shared/types';
import { api } from '../api';
import { PROVIDER_COLOR, effortLabel } from '../util';
import { ModelPicker } from './ModelPicker';

interface Props {
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  refreshProviders: (force?: boolean) => Promise<void>;
}

export function SettingsPage({ providers, catalog, refreshProviders }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [cwd, setCwd] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setCwd(s.defaultCwd);
    });
    void refreshProviders(true);
  }, [refreshProviders]);

  const refresh = async () => {
    setRefreshing(true);
    await refreshProviders(true);
    setRefreshing(false);
  };

  const saveCwd = async () => {
    try {
      setSettings(await api.updateSettings({ defaultCwd: cwd }));
      setMsg('已儲存預設工作目錄');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="page scroll">
      <div className="page-inner">
        <header className="page-head row">
          <div>
            <h1>設定與登入</h1>
            <p className="muted">
              Harness Relay 透過你電腦上的 CLI 呼叫各個 coding agent。在這裡分別登入、設定 API key 或執行檔路徑。
            </p>
          </div>
          <button className="ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? '檢查中…' : '重新檢查狀態'}
          </button>
        </header>

        <div className="provider-list">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              status={providers.find((x) => x.provider === p)}
              catalog={catalog.find((x) => x.provider === p)}
              settings={settings?.providers.find((x) => x.provider === p)}
              onSettings={setSettings}
              onRefresh={() => refreshProviders(true)}
            />
          ))}
        </div>

        <section className="card">
          <h3>預設工作目錄</h3>
          <p className="muted small">新對話預設讓 agent 在這個目錄工作（每個對話仍可個別修改）。</p>
          <div className="input-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <button className="primary" onClick={saveCwd} disabled={!settings || cwd === settings.defaultCwd}>
              儲存
            </button>
          </div>
          {msg && <p className="muted small">{msg}</p>}
        </section>
      </div>
    </div>
  );
}

function statusPill(s?: ProviderStatus): { text: string; cls: string } {
  if (!s) return { text: '檢查中…', cls: '' };
  if (!s.installed) return { text: '未安裝', cls: 'off' };
  if (s.usingStoredApiKey) return { text: '使用 API key', cls: 'ok' };
  if (s.auth.loggedIn) return { text: '已登入', cls: 'ok' };
  if (s.auth.loggedIn === false) return { text: '未登入', cls: 'warn' };
  return { text: '狀態未知', cls: '' };
}

const API_KEY_HELP: Record<Provider, string> = {
  claude: '儲存後，Harness Relay 啟動 Claude Code 時會帶入 ANTHROPIC_API_KEY（改用 API 計費，優先於訂閱登入）。',
  codex: '會執行 codex login --with-api-key，金鑰由 Codex 自己保存（取代目前的 ChatGPT 登入）。',
  grok: '儲存後，Harness Relay 啟動 Grok 時會帶入 XAI_API_KEY。',
};

function ProviderCard({
  provider,
  status,
  catalog,
  settings,
  onSettings,
  onRefresh,
}: {
  provider: Provider;
  status?: ProviderStatus;
  catalog?: ProviderModels;
  settings?: ProviderSettingsView;
  onSettings: (s: SettingsView) => void;
  onRefresh: () => Promise<void>;
}) {
  const [methods, setMethods] = useState<LoginMethod[]>([]);
  const [method, setMethod] = useState('');
  const [login, setLogin] = useState<LoginSessionView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [bin, setBin] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pill = statusPill(status);

  useEffect(() => {
    api.loginMethods(provider).then((m) => {
      setMethods(m);
      setMethod(m[0]?.id ?? '');
    });
    api.getLogin(provider).then(setLogin);
  }, [provider]);

  useEffect(() => {
    setBin(settings?.bin ?? '');
    setModel(settings?.defaultModel ?? '');
    setEffort(settings?.defaultEffort ?? '');
  }, [settings?.bin, settings?.defaultModel, settings?.defaultEffort]);

  // Poll the login session while it runs.
  const running = login?.state === 'running';
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const v = await api.getLogin(provider).catch(() => null);
      setLogin(v);
      if (v && v.state !== 'running') void onRefreshRef.current();
    }, 1000);
    return () => clearInterval(t);
  }, [running, provider]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setNote('');
    try {
      await fn();
      if (ok) setNote(ok);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startLogin = () => {
    if (provider === 'codex' && status?.auth.loggedIn && !confirm('開始新的 Codex 登入會先登出目前的帳號，確定要繼續？')) return;
    void act(async () => setLogin(await api.startLogin(provider, method)));
  };

  const logout = () => {
    if (!confirm(`登出 ${PROVIDER_LABEL[provider]}？這會影響這台電腦上所有使用此 CLI 的地方。`)) return;
    void act(async () => {
      await api.logout(provider);
      await onRefresh();
    }, '已登出');
  };

  const saveKey = (remove = false) =>
    act(async () => {
      onSettings(await api.updateProvider(provider, { apiKey: remove ? null : apiKey }));
      setApiKey('');
      await onRefresh();
    }, remove ? '已移除 API key' : '已儲存 API key');

  const saveAdvanced = () =>
    act(async () => {
      onSettings(await api.updateProvider(provider, { bin, defaultModel: model, defaultEffort: effort }));
      await onRefresh();
    }, '已儲存');

  const selected = methods.find((m) => m.id === method);

  return (
    <section className="card provider-card" style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}>
      <header className="provider-head">
        <span className="provider-swatch" />
        <h3>{PROVIDER_LABEL[provider]}</h3>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
        <span className="muted small">
          {status?.version && `v${status.version}`}
          {status?.auth.account && ` · ${status.auth.account}`}
          {status?.auth.method && ` · ${status.auth.method}`}
          {status?.auth.detail && ` · ${status.auth.detail}`}
        </span>
      </header>

      {status && !status.installed && (
        <p className="warn-line">{status.auth.detail ?? `找不到 ${status.bin}`}（可在下方「進階」指定執行檔路徑）</p>
      )}

      <div className="login-block">
        <div className="method-list" role="radiogroup">
          {methods.map((m) => (
            <label key={m.id} className={`method ${method === m.id ? 'on' : ''}`}>
              <input type="radio" name={`m-${provider}`} checked={method === m.id} onChange={() => setMethod(m.id)} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
        {selected && <p className="muted small">{selected.description}</p>}
        <div className="button-row">
          <button className="primary" onClick={startLogin} disabled={busy || running || !status?.installed}>
            {status?.auth.loggedIn ? '重新登入' : '登入'}
          </button>
          {status?.auth.loggedIn && (
            <button className="ghost" onClick={logout} disabled={busy || running}>
              登出
            </button>
          )}
        </div>
        {login && <LoginPanel login={login} provider={provider} onUpdate={setLogin} />}
      </div>

      <details className="sub">
        <summary>API key{settings?.apiKeyMasked ? `（已設定 ${settings.apiKeyMasked}）` : ''}</summary>
        <p className="muted small">{API_KEY_HELP[provider]}</p>
        <div className="input-row">
          <input
            type="password"
            value={apiKey}
            placeholder={provider === 'claude' ? 'sk-ant-…' : provider === 'codex' ? 'sk-…' : 'xai-…'}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <button className="primary" onClick={() => saveKey()} disabled={busy || !apiKey.trim()}>
            儲存
          </button>
          {settings?.apiKeyMasked && (
            <button className="ghost" onClick={() => saveKey(true)} disabled={busy}>
              移除
            </button>
          )}
        </div>
      </details>

      <details className="sub">
        <summary>
          預設模型與推理強度
          {(settings?.defaultModel || settings?.defaultEffort) &&
            `（${[settings.defaultModel, settings.defaultEffort && effortLabel(settings.defaultEffort)].filter(Boolean).join(' · ')}）`}
        </summary>
        <p className="muted small">成員的模型 / 推理強度選「預設」時使用這裡的值；這裡也選「CLI 預設」就交給 {PROVIDER_LABEL[provider]} 自己的設定。</p>
        {catalog?.error && <p className="warn-line">無法從 CLI 取得模型清單：{catalog.error}</p>}
        <ModelPicker
          key={`${settings?.defaultModel}|${catalog?.models.length ?? 0}`}
          catalog={catalog}
          model={model}
          effort={effort}
          onChange={(v) => {
            setModel(v.model);
            setEffort(v.effort);
          }}
          inheritModelLabel={`CLI 預設：${catalog?.cliDefaultModel ?? '未知'}`}
          inheritEffortLabel={(m) => {
            const e = catalog?.cliDefaultEffort ?? catalog?.models.find((x) => x.id === (m || catalog.cliDefaultModel))?.defaultEffort;
            return `CLI 預設：${e ? effortLabel(e) : '未知'}`;
          }}
        />
        <label className="field inline">
          <span>執行檔</span>
          <input value={bin} placeholder={provider} onChange={(e) => setBin(e.target.value)} spellCheck={false} />
        </label>
        <div className="button-row">
          <button className="ghost" onClick={saveAdvanced} disabled={busy}>
            儲存
          </button>
        </div>
      </details>

      {note && <p className="muted small">{note}</p>}
    </section>
  );
}

function LoginPanel({
  login,
  provider,
  onUpdate,
}: {
  login: LoginSessionView;
  provider: Provider;
  onUpdate: (v: LoginSessionView | null) => void;
}) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState('');
  const running = login.state === 'running';
  // Claude's flow prints a URL and then waits for the code shown after authorising.
  const askForCode = running && (login.wantsInput || provider === 'claude');

  const copy = async (c: string) => {
    await navigator.clipboard?.writeText(c).catch(() => {});
    setCopied(c);
    setTimeout(() => setCopied(''), 1500);
  };

  const submitCode = async () => {
    if (!code.trim()) return;
    onUpdate(await api.loginInput(provider, code));
    setCode('');
  };

  const stateText = { running: '等待授權中…', success: '登入成功 ✓', failed: '登入失敗', cancelled: '已取消' }[login.state];

  return (
    <div className={`login-panel ${login.state}`}>
      <div className="login-state">
        {running && <span className="pulse" />}
        <strong>{stateText}</strong>
        {running && (
          <button className="ghost small-button" onClick={() => api.cancelLogin(provider).then(() => api.getLogin(provider)).then(onUpdate)}>
            取消
          </button>
        )}
      </div>

      {running && login.urls.length > 0 && (
        <div className="login-step">
          <span className="step-no">1</span>
          <div>
            <p>開啟授權頁面：</p>
            {login.urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="login-url">
                {u.length > 90 ? u.slice(0, 89) + '…' : u} ↗
              </a>
            ))}
          </div>
        </div>
      )}

      {running && login.codes.length > 0 && (
        <div className="login-step">
          <span className="step-no">2</span>
          <div>
            <p>在頁面中輸入或確認這個代碼：</p>
            {login.codes.map((c) => (
              <button key={c} className="device-code" onClick={() => copy(c)} title="點擊複製">
                {c}
                <span className="small muted">{copied === c ? '已複製' : '複製'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {askForCode && (
        <div className="login-step">
          <span className="step-no">2</span>
          <div className="grow">
            <p>授權後頁面會顯示一組授權碼，貼到這裡：</p>
            <div className="input-row">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
                placeholder="貼上授權碼"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="primary" onClick={submitCode} disabled={!code.trim()}>
                送出
              </button>
            </div>
          </div>
        </div>
      )}

      <details className="login-output" open={login.state === 'failed'}>
        <summary className="small muted">CLI 輸出</summary>
        <pre>{login.output.trim() || '(尚無輸出)'}</pre>
      </details>
    </div>
  );
}
