import { useEffect, useRef, useState } from 'react';
import {
  LANGS,
  PROVIDERS,
  PROVIDER_LABEL,
  inheritedEffort,
  type LeadAgentSettings,
  type LoginMethod,
  type LoginSessionView,
  type Provider,
  type ProviderModels,
  type ProviderSettingsView,
  type ProviderStatus,
  type SettingsView,
} from '../../shared/types';
import { api, ApiError } from '../api';
import { LANG_NAMES, useI18n, useT, type Messages } from '../i18n';
import { PROVIDER_COLOR } from '../util';
import { ModelPicker } from './ModelPicker';
import { providerState } from './Sidebar';
import { VoiceCard } from './VoiceSettings';

interface Props {
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  refreshProviders: (force?: boolean) => Promise<void>;
  onShowTour: () => void;
}

export function SettingsPage({ providers, catalog, refreshProviders, onShowTour }: Props) {
  const { t, lang, setLang } = useI18n();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [cwd, setCwd] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.getSettings().then(
      (s) => {
        setSettings(s);
        setCwd(s.defaultCwd);
      },
      (e: Error) => setMsg(e.message),
    );
    void refreshProviders(true);
  }, [refreshProviders]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshProviders(true);
    } finally {
      setRefreshing(false);
    }
  };

  const saveCwd = async () => {
    try {
      setSettings(await api.updateSettings({ defaultCwd: cwd }));
      setMsg(t.settings.cwdSaved);
    } catch (e) {
      // 404: the folder does not exist yet; create it if the user agrees.
      if (!(e instanceof ApiError && e.status === 404)) return setMsg((e as Error).message);
      if (!confirm(t.settings.confirmCreateCwd(cwd.trim()))) return setMsg(e.message);
      try {
        const s = await api.updateSettings({ defaultCwd: cwd, createCwd: true });
        setSettings(s);
        setCwd(s.defaultCwd);
        setMsg(t.settings.cwdCreated(s.defaultCwd));
      } catch (e2) {
        setMsg((e2 as Error).message);
      }
    }
  };

  return (
    <div className="page scroll">
      <div className="page-inner">
        <header className="page-head row">
          <div>
            <h1>{t.settings.title}</h1>
            <p className="muted">{t.settings.intro}</p>
          </div>
          <button className="ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? t.settings.checking : t.settings.recheck}
          </button>
        </header>

        <section className="card">
          <h3>{t.settings.language}</h3>
          <p className="muted small">{t.settings.languageHint}</p>
          <div className="segmented lang-switch" role="radiogroup" aria-label={t.settings.language}>
            {LANGS.map((l) => (
              <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
                {LANG_NAMES[l]}
              </button>
            ))}
          </div>
        </section>

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

        {settings && <LeadCard lead={settings.lead} providers={providers} catalog={catalog} onSettings={setSettings} />}

        <VoiceCard />

        <section className="card">
          <h3>{t.settings.cwd}</h3>
          <p className="muted small">{t.settings.cwdHint}</p>
          <div className="input-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <button className="primary" onClick={saveCwd} disabled={!settings || cwd === settings.defaultCwd}>
              {t.common.save}
            </button>
          </div>
          {msg && <p className="muted small">{msg}</p>}
        </section>

        <section className="card">
          <h3>{t.settings.tour}</h3>
          <p className="muted small">{t.settings.tourHint}</p>
          <div className="button-row">
            <button className="ghost" onClick={onShowTour}>
              {t.settings.replayTour}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The agent that designs the team in auto-team conversations. */
function LeadCard({
  lead: saved,
  providers,
  catalog,
  onSettings,
}: {
  lead: LeadAgentSettings;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onSettings: (s: SettingsView) => void;
}) {
  const t = useT();
  const [lead, setLead] = useState<LeadAgentSettings>(saved);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Saving any other setting returns a new (equal) lead object: keep the user's unsaved edits then.
  useEffect(() => setLead(saved), [saved.provider, saved.model, saved.effort]);

  const status = providers.find((p) => p.provider === lead.provider);
  const pm = catalog.find((c) => c.provider === lead.provider);
  const unchanged =
    lead.provider === saved.provider && (lead.model ?? '') === (saved.model ?? '') && (lead.effort ?? '') === (saved.effort ?? '');

  const save = async () => {
    setBusy(true);
    setNote('');
    try {
      onSettings(await api.updateSettings({ lead }));
      setNote(t.settings.leadSaved);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ ['--accent' as string]: PROVIDER_COLOR[lead.provider] }}>
      <h3>✦ {t.settings.lead}</h3>
      <p className="muted small">{t.settings.leadHint}</p>
      <div className="segmented" role="radiogroup" aria-label={t.settings.lead}>
        {PROVIDERS.map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={lead.provider === p}
            className={lead.provider === p ? 'on' : ''}
            style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
            onClick={() => lead.provider !== p && setLead({ provider: p })}
          >
            {PROVIDER_LABEL[p]}
          </button>
        ))}
      </div>
      <ModelPicker
        key={lead.provider}
        catalog={pm}
        model={lead.model ?? ''}
        effort={lead.effort ?? ''}
        onChange={(v) => setLead({ ...lead, model: v.model, effort: v.effort })}
        inheritModelLabel={t.team.defaultModel(pm?.defaultModel ?? (pm ? t.team.cliDecides : t.common.loading))}
        inheritEffortLabel={(model) => {
          const e = pm && inheritedEffort(pm, model);
          return t.team.defaultModel(e ? t.effortLabel(e) : t.team.cliDecides);
        }}
      />
      {status && providerState(status) !== 'ok' && (
        <p className="warn-line">{t.settings.leadNotReady(PROVIDER_LABEL[lead.provider])}</p>
      )}
      <div className="button-row">
        <button className="primary" onClick={save} disabled={busy || unchanged}>
          {t.common.save}
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </section>
  );
}

function statusPill(s: ProviderStatus | undefined, t: Messages): { text: string; cls: string } {
  const p = t.settings.pill;
  if (!s) return { text: p.checking, cls: '' };
  if (!s.installed) return { text: p.notInstalled, cls: 'off' };
  if (s.usingStoredApiKey) return { text: p.apiKey, cls: 'ok' };
  if (s.auth.loggedIn) return { text: p.loggedIn, cls: 'ok' };
  if (s.auth.loggedIn === false) return { text: p.notLoggedIn, cls: 'warn' };
  return { text: p.unknown, cls: '' };
}

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
  const { t, lang } = useI18n();
  const [methods, setMethods] = useState<LoginMethod[]>([]);
  const [method, setMethod] = useState('');
  const [login, setLogin] = useState<LoginSessionView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [bin, setBin] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pill = statusPill(status, t);

  // Method labels come from the server in the UI language.
  useEffect(() => {
    api.loginMethods(provider).then(
      (m) => {
        setMethods(m);
        setMethod((cur) => (m.some((x) => x.id === cur) ? cur : (m[0]?.id ?? '')));
      },
      (e: Error) => setNote(e.message),
    );
  }, [provider, lang]);

  useEffect(() => {
    api.getLogin(provider).then(setLogin, (e: Error) => setNote(e.message));
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
    const timer = setInterval(async () => {
      const v = await api.getLogin(provider).catch(() => null);
      setLogin(v);
      if (v && v.state !== 'running') void onRefreshRef.current();
    }, 1000);
    return () => clearInterval(timer);
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
    if (provider === 'codex' && status?.auth.loggedIn && !confirm(t.settings.confirmCodexRelogin)) return;
    void act(async () => setLogin(await api.startLogin(provider, method)));
  };

  const logout = () => {
    if (!confirm(t.settings.confirmLogout(PROVIDER_LABEL[provider]))) return;
    void act(async () => {
      await api.logout(provider);
      await onRefresh();
    }, t.settings.loggedOut);
  };

  const saveKey = (remove = false) =>
    act(async () => {
      onSettings(await api.updateProvider(provider, { apiKey: remove ? null : apiKey }));
      setApiKey('');
      await onRefresh();
    }, remove ? t.settings.keyRemoved : t.settings.keySaved);

  const saveAdvanced = () =>
    act(async () => {
      onSettings(await api.updateProvider(provider, { bin, defaultModel: model, defaultEffort: effort }));
      await onRefresh();
    }, t.settings.saved);

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
        <p className="warn-line">
          {status.auth.detail ?? t.settings.cliMissing(status.bin)}
          {t.settings.setBinBelow}
        </p>
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
            {status?.auth.loggedIn ? t.settings.relogin : t.settings.login}
          </button>
          {status?.auth.loggedIn && (
            <button className="ghost" onClick={logout} disabled={busy || running}>
              {t.settings.logout}
            </button>
          )}
        </div>
        {login && <LoginPanel login={login} provider={provider} onUpdate={setLogin} onError={setNote} />}
      </div>

      <details className="sub">
        <summary>
          {t.settings.apiKey}
          {settings?.apiKeyMasked ? t.settings.apiKeySet(settings.apiKeyMasked) : ''}
        </summary>
        <div className="sub-body">
          <p className="muted small">
            {t.settings.apiKeyHelp[provider]}
            {settings?.apiKeyStorage && t.settings.keyStorage(t.settings.keyStorageName[settings.apiKeyStorage])}
            {settings?.apiKeyStorage === 'database' && t.settings.keyEnvHint(provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'XAI_API_KEY')}
          </p>
          <div className="input-row">
            <input
              type="password"
              value={apiKey}
              placeholder={provider === 'claude' ? 'sk-ant-…' : provider === 'codex' ? 'sk-…' : 'xai-…'}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <button className="primary" onClick={() => saveKey()} disabled={busy || !apiKey.trim()}>
              {t.common.save}
            </button>
            {settings?.apiKeyMasked && (
              <button className="ghost" onClick={() => saveKey(true)} disabled={busy}>
                {t.common.remove}
              </button>
            )}
          </div>
        </div>
      </details>

      <details className="sub">
        <summary>
          {t.settings.defaults}
          {(settings?.defaultModel || settings?.defaultEffort) &&
            ` (${[settings.defaultModel, settings.defaultEffort && t.effortLabel(settings.defaultEffort)].filter(Boolean).join(' · ')})`}
        </summary>
        <div className="sub-body">
          <p className="muted small">{t.settings.defaultsHint(PROVIDER_LABEL[provider])}</p>
          {catalog?.error && <p className="warn-line">{t.settings.modelsError(catalog.error)}</p>}
          <ModelPicker
            key={`${settings?.defaultModel}|${catalog?.models.length ?? 0}`}
            catalog={catalog}
            model={model}
            effort={effort}
            onChange={(v) => {
              setModel(v.model);
              setEffort(v.effort);
            }}
            inheritModelLabel={t.settings.cliDefault(catalog?.cliDefaultModel ?? t.settings.unknown)}
            inheritEffortLabel={(m) => {
              const e = catalog?.cliDefaultEffort ?? catalog?.models.find((x) => x.id === (m || catalog.cliDefaultModel))?.defaultEffort;
              return t.settings.cliDefault(e ? t.effortLabel(e) : t.settings.unknown);
            }}
          />
          <label className="field inline">
            <span>{t.settings.bin}</span>
            <input value={bin} placeholder={provider} onChange={(e) => setBin(e.target.value)} spellCheck={false} />
          </label>
          <div className="button-row">
            <button className="ghost" onClick={saveAdvanced} disabled={busy}>
              {t.common.save}
            </button>
          </div>
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
  onError,
}: {
  login: LoginSessionView;
  provider: Provider;
  onUpdate: (v: LoginSessionView | null) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
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
    try {
      onUpdate(await api.loginInput(provider, code));
      setCode('');
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const cancel = () =>
    api
      .cancelLogin(provider)
      .then(() => api.getLogin(provider))
      .then(onUpdate, (e: Error) => onError(e.message));

  return (
    <div className={`login-panel ${login.state}`}>
      <div className="login-state">
        {running && <span className="pulse" />}
        <strong>{t.settings.loginState[login.state]}</strong>
        {running && (
          <button className="ghost small-button" onClick={cancel}>
            {t.common.cancel}
          </button>
        )}
      </div>

      {running && login.urls.length > 0 && (
        <div className="login-step">
          <span className="step-no">1</span>
          <div>
            <p>{t.settings.openAuthPage}</p>
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
            <p>{t.settings.enterCode}</p>
            {login.codes.map((c) => (
              <button key={c} className="device-code" onClick={() => copy(c)} title={t.common.clickToCopy}>
                {c}
                <span className="small muted">{copied === c ? t.common.copied : t.common.copy}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {askForCode && (
        <div className="login-step">
          <span className="step-no">2</span>
          <div className="grow">
            <p>{t.settings.pasteCode}</p>
            <div className="input-row">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
                placeholder={t.settings.codePlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
              <button className="primary" onClick={submitCode} disabled={!code.trim()}>
                {t.settings.submit}
              </button>
            </div>
          </div>
        </div>
      )}

      <details className="login-output" open={login.state === 'failed'}>
        <summary className="small muted">{t.settings.cliOutput}</summary>
        <pre>{login.output.trim() || t.settings.noOutput}</pre>
      </details>
    </div>
  );
}
