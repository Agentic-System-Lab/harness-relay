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
import { api, orCreateCwd } from '../api';
import { LANG_NAMES, useI18n, useT, type Messages } from '../i18n';
import { SETTINGS_SECTIONS, currentSection, readingLine, scrollToSection, sectionId, settingsHref, type SettingsSection } from '../route';
import { PROVIDER_COLOR, switchProvider, type ModelChoice } from '../util';
import { CwdInput } from './CwdInput';
import { ModelPicker } from './ModelPicker';
import { NativeSetupPanel } from './NativeSetupPanel';
import { SectionTitle } from './SectionTitle';
import { SessionsCard } from './SessionsSettings';
import { providerState } from './Sidebar';
import { ToolsCard } from './ToolsSettings';
import { VoiceCard } from './VoiceSettings';

interface Props {
  /** The card to scroll to (#/settings/<section>). */
  section?: SettingsSection;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  refreshProviders: (force?: boolean) => Promise<void>;
  onShowTour: () => void;
}

export function SettingsPage({ section, providers, catalog, refreshProviders, onShowTour }: Props) {
  const { t, lang, setLang } = useI18n();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [cwd, setCwd] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>({ text: '' });

  // A link such as #/settings/tools: scroll to that card once the cards above it have their content
  // (not again when a save brings new settings).
  const loaded = settings !== null;
  useEffect(() => {
    if (!section || !loaded) return;
    const id = window.setTimeout(() => scrollToSection(section), 150);
    return () => window.clearTimeout(id);
  }, [section, loaded]);

  useEffect(() => {
    api.getSettings().then(
      (s) => {
        setSettings(s);
        setCwd(s.defaultCwd);
      },
      (e: Error) => setMsg({ text: e.message, error: true }),
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
    let created = false;
    try {
      const s = await orCreateCwd(
        (createCwd) => api.updateSettings({ defaultCwd: cwd, createCwd }),
        () => (created = confirm(t.settings.confirmCreateCwd(cwd.trim()))),
      );
      setSettings(s);
      setCwd(s.defaultCwd);
      setMsg({ text: created ? t.settings.cwdCreated(s.defaultCwd) : t.settings.cwdSaved });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <div className="page scroll">
      <div className="page-inner">
        {/* The title and its button share a row; the intro below takes the whole width (phones too). */}
        <header className="page-head">
          <div className="page-title-row">
            <h1>{t.settings.title}</h1>
            <button className="ghost" onClick={refresh} disabled={refreshing}>
              {refreshing ? t.settings.checking : t.settings.recheck}
            </button>
          </div>
          <p className="muted">{t.settings.intro}</p>
        </header>

        <SettingsNav section={section} />

        <section className="card" id={sectionId('language')}>
          <SectionTitle section="language">{t.settings.language}</SectionTitle>
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

        <ToolsCard />

        <VoiceCard />

        <section className="card" id={sectionId('cwd')}>
          <SectionTitle section="cwd">{t.settings.cwd}</SectionTitle>
          <p className="muted small">{t.settings.cwdHint}</p>
          <div className="input-row">
            <CwdInput value={cwd} onChange={setCwd} ariaLabel={t.settings.cwd} />
            <button className="primary" onClick={saveCwd} disabled={!settings || cwd === settings.defaultCwd}>
              {t.common.save}
            </button>
          </div>
          {msg.text && <p className={msg.error ? 'error-line' : 'muted small'}>{msg.text}</p>}
        </section>

        {settings && <SessionsCard settings={settings} onSettings={setSettings} onHomeChanged={() => void refreshProviders(true)} />}

        <section className="card" id={sectionId('tour')}>
          <SectionTitle section="tour">{t.settings.tour}</SectionTitle>
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
  // A failed save is shown as an error, so it cannot pass for "saved".
  const [note, setNote] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  /** The model and effort picked for each CLI while switching between them, so switching back restores them. */
  const kept = useRef<Partial<Record<Provider, ModelChoice>>>({});
  // Saving any other setting returns a new (equal) lead object: keep the user's unsaved edits then.
  useEffect(() => setLead(saved), [saved.provider, saved.model, saved.effort]);

  const status = providers.find((p) => p.provider === lead.provider);
  const pm = catalog.find((c) => c.provider === lead.provider);
  const unchanged =
    lead.provider === saved.provider && (lead.model ?? '') === (saved.model ?? '') && (lead.effort ?? '') === (saved.effort ?? '');

  const save = async () => {
    setBusy(true);
    setNote({ text: '' });
    try {
      onSettings(await api.updateSettings({ lead }));
      setNote({ text: t.settings.leadSaved });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" id={sectionId('lead')} style={{ ['--accent' as string]: PROVIDER_COLOR[lead.provider] }}>
      <SectionTitle section="lead">✦ {t.settings.lead}</SectionTitle>
      <p className="muted small">{t.settings.leadHint}</p>
      <div className="segmented" role="radiogroup" aria-label={t.settings.lead}>
        {PROVIDERS.map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={lead.provider === p}
            className={lead.provider === p ? 'on' : ''}
            style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
            onClick={() => {
              if (lead.provider === p) return;
              const next = switchProvider(lead, p, kept.current);
              kept.current = next.kept;
              setLead(next.value);
            }}
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
        <p className="warn-line">
          {t.settings.leadNotReady(PROVIDER_LABEL[lead.provider])}{' '}
          <a href={settingsHref(lead.provider)} onClick={() => scrollToSection(lead.provider)}>
            {t.settings.goSignIn(PROVIDER_LABEL[lead.provider])}
          </a>
        </p>
      )}
      <div className="button-row">
        <button className="primary" onClick={save} disabled={busy || unchanged}>
          {t.common.save}
        </button>
      </div>
      {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
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

  // Pick up a login still running from before (the page was left or reloaded). A finished one's
  // result was shown where it finished; coming back to the page starts clean.
  useEffect(() => {
    api.getLogin(provider).then(
      (v) => setLogin(v?.state === 'running' ? v : null),
      (e: Error) => setNote(e.message),
    );
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
    <section className="card provider-card" id={sectionId(provider)} style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}>
      <header className="provider-head">
        <span className="provider-swatch" />
        <SectionTitle section={provider}>{PROVIDER_LABEL[provider]}</SectionTitle>
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

      <NativeSetupPanel provider={provider} settings={settings} onSettings={onSettings} />

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

/** Links to every card of the page, in page order; they stay at the top while the page scrolls. */
function SettingsNav({ section }: { section?: SettingsSection }) {
  const t = useT();
  // Whether the links are stuck to the top: on phones they then make room for the menu button.
  const marker = useRef<HTMLSpanElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = marker.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([e]) => setStuck(!e!.isIntersecting), { root: el.closest('.scroll') });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The card being read is highlighted: checked as the page scrolls, and when cards change size (they load their content).
  const nav = useRef<HTMLElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SettingsSection>();
  // A card picked with a link stays highlighted while the page scrolls there, and until the reader scrolls on.
  const picked = useRef<{ until: number } | null>(null);
  const pick = (s: SettingsSection) => {
    picked.current = { until: Date.now() + 600 };
    setActive(s);
  };
  useEffect(() => {
    if (section) pick(section);
  }, [section]);
  useEffect(() => {
    const scroller = marker.current?.closest<HTMLElement>('.scroll');
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const tops = SETTINGS_SECTIONS.flatMap((s) => {
        const card = document.getElementById(sectionId(s));
        return card ? [{ section: s, top: card.getBoundingClientRect().top }] : [];
      });
      const view = scroller.getBoundingClientRect();
      const line = readingLine({
        linksBottom: nav.current?.getBoundingClientRect().bottom ?? view.top,
        viewBottom: view.bottom,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      });
      setActive(currentSection(tops, line));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onScroll = () => {
      const p = picked.current;
      if (p) {
        const now = Date.now();
        // Still the jump's own scrolling: keep the picked card.
        if (now < p.until) {
          p.until = Math.max(p.until, now + 250);
          return;
        }
        picked.current = null;
      }
      later();
    };
    const onResize = () => {
      if (!picked.current) later();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize);
    if (scroller.firstElementChild) sizes?.observe(scroller.firstElementChild);
    if (!picked.current) update();
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      sizes?.disconnect();
    };
  }, []);

  // Cards stop below the links when scrolled to, however tall the links are.
  useEffect(() => {
    const el = nav.current;
    const scroller = el?.closest<HTMLElement>('.scroll');
    if (!el || !scroller || typeof ResizeObserver === 'undefined') return;
    const sizes = new ResizeObserver(() => scroller.style.setProperty('--settings-nav-height', `${el.offsetHeight}px`));
    sizes.observe(el);
    return () => sizes.disconnect();
  }, []);

  // Where the links do not fit, a mouse wheel over them scrolls them sideways (its scrollbar is hidden).
  useEffect(() => {
    const links = row.current;
    if (!links) return;
    const onWheel = (e: WheelEvent) => {
      if (links.scrollWidth <= links.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const before = links.scrollLeft;
      links.scrollLeft += e.deltaY;
      // At either end the wheel scrolls the page as usual.
      if (links.scrollLeft !== before) e.preventDefault();
    };
    links.addEventListener('wheel', onWheel, { passive: false });
    return () => links.removeEventListener('wheel', onWheel);
  }, []);

  // Where the links do not fit (narrow windows, phones), they scroll sideways: keep the highlighted one in view.
  useEffect(() => {
    const links = row.current;
    const chip = active && links?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!links || !chip || links.scrollWidth <= links.clientWidth) return;
    links.scrollTo({ left: chip.offsetLeft - (links.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
  }, [active]);
  // Short labels, so the links fit on one line in every language (the cards keep their full titles).
  const short = t.settings.nav;
  const label: Record<SettingsSection, string> = {
    language: short.language,
    claude: PROVIDER_LABEL.claude,
    codex: PROVIDER_LABEL.codex,
    grok: PROVIDER_LABEL.grok,
    lead: short.lead,
    tools: short.tools,
    voice: short.voice,
    cwd: short.cwd,
    sessions: short.sessions,
    tour: short.tour,
  };
  return (
    <>
      <span ref={marker} className="settings-nav-marker" aria-hidden="true" />
      {/* The links scroll inside their own row, so nothing scrolls under the menu button beside it. */}
      <nav ref={nav} className={`settings-nav ${stuck ? 'stuck' : ''}`} aria-label={t.settings.sections}>
        <div ref={row} className="settings-nav-links">
          {SETTINGS_SECTIONS.map((s) => (
            <a
              key={s}
              href={settingsHref(s)}
              data-section={s}
              className={active === s ? 'active' : undefined}
              aria-current={active === s ? 'location' : undefined}
              onClick={() => {
                pick(s);
                scrollToSection(s);
              }}
            >
              {label[s]}
            </a>
          ))}
        </div>
      </nav>
    </>
  );
}
