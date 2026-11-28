import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  LANGS,
  MAX_ACCOUNT_LABEL,
  OPEN_PROVIDERS,
  PROVIDERS,
  PROVIDER_LABEL,
  SANDBOX_TERMINAL_SUPPORT,
  accountUsable,
  catalogFor,
  cwdsOf,
  keyOnlyAccount,
  inheritedEffort,
  isEndpointCli,
  isOpenProvider,
  type AccountStatus,
  type CliInstallView,
  type Lang,
  type LeadAgentSettings,
  type LoginMethod,
  type LoginSessionView,
  type OpenProvider,
  type Provider,
  type ProviderAccountView,
  type ProviderModels,
  type ProviderSettingsView,
  type ProviderStatus,
  type SettingsView,
  type UpdateStatus,
} from '../../shared/types';
import { api, orCreateCwd } from '../api';
import { LANG_NAMES, useI18n, useT, type Messages } from '../i18n';
import { useLimits } from '../limits';
import { setThemeChoice, THEMES, useThemeChoice } from '../theme';
import {
  AGENT_SECTIONS,
  SETTINGS_NAV,
  SETTINGS_SECTIONS,
  currentSection,
  isAgentSection,
  makeRoomForCorner,
  menuMove,
  navEntryOf,
  openItem,
  readingLine,
  revealLink,
  rowFitsUnderCard,
  scrollToSection,
  sectionId,
  settingsCard,
  hashFor,
  settingsHref,
  type SettingsItem,
  type SettingsSection,
  type SettingsReturn,
} from '../route';
import { hasNativePanel, hasSubagents } from '../native';
import { CliFeatures } from './CliFeatures';
import { AgentEnvSettings } from './AgentEnvSettings';
import { assistantReadiness, statusBeforeInstall } from '../clis';
import { useCliInstalls } from '../useCliInstalls';
import { PROVIDER_COLOR, accountName, accountOf, accountState, inheritModelLabel, switchProvider, type ModelChoice } from '../util';
import { AccountPicker } from './AccountPicker';
import { BackendsCard } from './BackendsSettings';
import { LabsCard } from './LabsSettings';
import { CliInstall } from './CliInstall';
import { CwdInput } from './CwdInput';
import { LoginLinks, LoginOutput } from './LoginLinks';
import { CliPicker } from './CliPicker';
import { ModelPicker } from './ModelPicker';
import { NotificationsCard } from './NotificationsSettings';
import { SandboxSetupCard } from './SandboxSetup';
import { NativeSetupPanel } from './NativeSetupPanel';
import { UsagePanel } from './UsagePanel';
import { SectionTitle } from './SectionTitle';
import type { BrowserSessions } from '../browserSessions';
import { BrowsersCard } from './BrowsersSettings';
import { HomeScreenGuide } from './HomeScreenGuide';
import { SessionsCard } from './SessionsSettings';
import { SharesCard } from './SharesSettings';
import { PublishCard } from './PublishSettings';
import { HandoffsCard } from './HandoffsSettings';
import { ToolsCard } from './ToolsSettings';
import { VersionCard } from './VersionSettings';
import { VoiceCard } from './VoiceSettings';
import { CheckIcon, ChevronIcon } from './icons';
import { LogoSpinner } from './Logo';

interface Props {
  browsers: BrowserSessions;
  /** The card to scroll to (#/settings/<section>). */
  section?: SettingsSection;
  /** The row of Apps and tools to open in it, and scroll to (#/settings/apps/<item>, #/settings/tools/<item>). */
  item?: SettingsItem;
  settingsReturn?: SettingsReturn;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  refreshProviders: (force?: boolean) => Promise<void>;
  onShowTour: () => void;
  /** This version and the desktop app's updates (undefined until the server answered). */
  update?: UpdateStatus;
  /** Has the desktop app check GitHub for a new version now. */
  onCheckUpdate: () => Promise<void>;
  /** Has the desktop app update (it asks the user first). */
  onInstallUpdate: () => Promise<void>;
}

/** The CLIs with a sign-in of their own, and so with accounts and API keys (not the open agents). */
type SignInCli = Exclude<Provider, OpenProvider>;

/** The variable each CLI reads its API key from, as the server's own environment may set it (Codex keeps its key itself). */
const KEY_ENV: Record<SignInCli, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'CODEX_API_KEY',
  grok: 'XAI_API_KEY',
  cursor: 'CURSOR_API_KEY',
  antigravity: 'GEMINI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
  muse: 'META_API_KEY',
};

/** How each CLI's API keys start, as the key box's placeholder. */
const KEY_PLACEHOLDER: Record<SignInCli, string> = {
  claude: 'sk-ant-…',
  codex: 'sk-…',
  grok: 'xai-…',
  cursor: 'key_…',
  antigravity: 'AIza…',
  copilot: 'github_pat_…',
  muse: 'meta-…',
};

export function SettingsPage({
  browsers,
  section,
  item,
  settingsReturn,
  providers,
  catalog,
  refreshProviders,
  onShowTour,
  update,
  onCheckUpdate,
  onInstallUpdate,
}: Props) {
  const { t, lang, setLang } = useI18n();
  const [lastToolsTab, setLastToolsTab] = useState<'apps' | 'tools'>('apps');
  const requestedTab = section === 'tools' || section === 'apps' ? section : undefined;
  useEffect(() => {
    if (requestedTab) setLastToolsTab(requestedTab);
  }, [requestedTab]);
  /** A language chosen whose words could not be loaded. */
  const [langFailed, setLangFailed] = useState<Lang | null>(null);
  const returnText = settingsReturn?.page === 'new' ? t.newChat : t.newSchedule;
  const draftLink = settingsReturn && (
    <a
      className="settings-return-draft"
      href={hashFor(settingsReturn.createdId ? { page: 'chat', id: settingsReturn.createdId } : { page: settingsReturn.page })}
    >
      <span aria-hidden="true">{settingsReturn.createdId ? '→' : '←'}</span>{' '}
      <span aria-live="polite">{settingsReturn.createdId ? returnText.openCreated : returnText.returnToDraft}</span>
    </a>
  );
  const theme = useThemeChoice();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  /** The default working directories, as the box has them (saved or not). */
  const [cwds, setCwds] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>({ text: '' });

  // Account and CLI cards above a deep link fill in asynchronously. Keep the target in place
  // as its offset changes, until the reader takes over scrolling or follows a different link.
  // A row of Apps and tools is opened once it is on the page (the library loads by itself), and kept in
  // place instead of its card; until then the card is. Coming from a draft, the card stays at the top with
  // its link back to the draft while the row's title fits below it (Mail and Calendar, the rows the drafts
  // link to, come first).
  const loaded = settings !== null;
  const fromDraft = Boolean(settingsReturn);
  useEffect(() => {
    if (!section || section === 'agents' || !loaded) return;
    const card = document.getElementById(sectionId(section));
    const layout = card?.closest('.page-inner');
    const scroller = layout?.closest<HTMLElement>('.scroll');
    if (!card || !layout || !scroller) return;
    let previous: number | undefined;
    let row: HTMLElement | null = null;
    const underCard = (el: HTMLElement) => {
      const title = el.querySelector<HTMLElement>(':scope > details > summary:not([hidden]), :scope > summary') ?? el;
      return rowFitsUnderCard({
        titleBottom: title.getBoundingClientRect().bottom - card.getBoundingClientRect().top,
        linksHeight: parseFloat(scroller.style.getPropertyValue('--settings-nav-height')) || 56,
        viewHeight: scroller.clientHeight,
      });
    };
    const align = () => {
      if (item && !row) row = openItem(item);
      const target = row && !(fromDraft && underCard(row)) ? row : card;
      const offset = Math.round(target.getBoundingClientRect().top - layout.getBoundingClientRect().top);
      if (offset === previous) return;
      previous = offset;
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
    };
    align();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(align);
    const gestures = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
    const stop = () => {
      watch.disconnect();
      for (const event of gestures) window.removeEventListener(event, stop, true);
    };
    watch.observe(layout);
    for (const event of gestures) window.addEventListener(event, stop, { capture: true, passive: true });
    return stop;
  }, [section, item, loaded, fromDraft]);

  useEffect(() => {
    api.getSettings().then(
      (s) => {
        setSettings(s);
        setCwds(cwdsOf({ cwd: s.defaultCwd, extraCwds: s.defaultExtraCwds }));
      },
      (e: Error) => setMsg({ text: e.message, error: true }),
    );
    void refreshProviders(true);
  }, [refreshProviders]);

  // A CLI installed or removed from its card: its status, its models and its executable path changed.
  const cliChanged = useCallback(async () => {
    await Promise.all([refreshProviders(true), api.getSettings().then(setSettings, () => {})]);
  }, [refreshProviders]);
  const installs = useCliInstalls(() => void cliChanged());

  // The CLIs' status, and whether there is a new version (the desktop app asks GitHub now).
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshProviders(true), onCheckUpdate()]);
    } finally {
      setRefreshing(false);
    }
  };

  const saveCwd = async () => {
    let created = false;
    try {
      let missing = '';
      const s = await orCreateCwd(
        (createCwd) => api.updateSettings({ defaultCwd: cwds[0] ?? '', defaultExtraCwds: cwds.slice(1), createCwd }),
        (dirs) => (created = confirm(t.settings.confirmCreateCwd((missing = dirs)))),
      );
      setSettings(s);
      setCwds(cwdsOf({ cwd: s.defaultCwd, extraCwds: s.defaultExtraCwds }));
      setMsg({ text: created ? t.settings.cwdCreated(missing.split('\n').join(', ')) : t.settings.cwdSaved });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <div className="page scroll">
      <div className="page-inner">
        {/* The title and its button share a row (phones too). */}
        <header className="page-head">
          <div className="page-title-row">
            <h1>{t.settings.title}</h1>
            <button className="ghost" onClick={refresh} disabled={refreshing}>
              {refreshing ? t.settings.checking : t.settings.recheck}
            </button>
          </div>
        </header>

        {section !== 'lead' && section !== 'apps' && section !== 'tools' && draftLink}
        <SettingsNav section={section} />

        <AssistantOverview providers={providers} installs={installs.views} />

        <VersionCard status={update} onUpdate={onInstallUpdate} />

        <section className="card" id={sectionId('language')}>
          <SectionTitle section="language">{t.settings.language}</SectionTitle>
          <p className="muted small">{t.settings.languageHint}</p>
          <div className="segmented lang-switch" role="radiogroup" aria-label={t.settings.language}>
            {LANGS.map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={lang === l}
                className={lang === l ? 'on' : ''}
                onClick={() => {
                  setLangFailed(null);
                  setLang(l).catch(() => setLangFailed(l));
                }}
              >
                {LANG_NAMES[l]}
              </button>
            ))}
          </div>
          {langFailed && (
            <p className="error-line" role="alert">
              {t.settings.languageFailed(LANG_NAMES[langFailed])}
            </p>
          )}
        </section>

        <section className="card" id={sectionId('appearance')}>
          <SectionTitle section="appearance">{t.settings.appearance}</SectionTitle>
          <p className="muted small">{t.settings.appearanceHint}</p>
          <div className="segmented theme-switch" role="radiogroup" aria-label={t.settings.appearance}>
            {THEMES.map((choice) => (
              <button
                key={choice}
                role="radio"
                aria-checked={theme === choice}
                className={theme === choice ? 'on' : ''}
                onClick={() => setThemeChoice(choice)}
              >
                {t.settings.themes[choice]}
              </button>
            ))}
          </div>
        </section>

        <NotificationsCard />

        <SandboxSetupCard />

        {/* The model backends first: the open agents run on them, and the other CLIs on their endpoints too. */}
        <BackendsCard onChanged={() => void refreshProviders(true)} />

        <div className="provider-list">
          {PROVIDERS.filter((p) => !isOpenProvider(p)).map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              status={providers.find((x) => x.provider === p)}
              catalog={catalog.filter((x) => x.provider === p)}
              settings={settings?.providers.find((x) => x.provider === p)}
              install={installs.views.find((x) => x.provider === p)}
              onInstallView={installs.update}
              onCliChanged={cliChanged}
              onSettings={setSettings}
              onRefresh={() => refreshProviders(true)}
              onDefaults={() => refreshProviders()}
            />
          ))}
        </div>

        <div className="provider-list">
          {OPEN_PROVIDERS.map((p) => (
            <OpenAgentCard
              key={p}
              provider={p}
              status={providers.find((x) => x.provider === p)}
              catalog={catalog.find((x) => x.provider === p)}
              settings={settings?.providers.find((x) => x.provider === p)}
              install={installs.views.find((x) => x.provider === p)}
              onInstallView={installs.update}
              onCliChanged={cliChanged}
              onSettings={setSettings}
              onRefresh={() => refreshProviders(true)}
            />
          ))}
        </div>

        {settings && (
          <LeadCard
            lead={settings.lead}
            chatTitles={settings.chatTitles}
            draftLink={section === 'lead' ? draftLink : undefined}
            providers={providers}
            catalog={catalog}
            onSettings={setSettings}
          />
        )}

        <ToolsCard
          activeApps={section === 'apps'}
          settings={settings}
          tab={requestedTab ?? lastToolsTab}
          draftLink={section === 'tools' || section === 'apps' ? draftLink : undefined}
        />

        <VoiceCard />

        <section className="card" id={sectionId('cwd')}>
          <SectionTitle section="cwd">{t.settings.cwd}</SectionTitle>
          <p className="muted small">{t.settings.cwdHint}</p>
          <div className="input-row">
            <CwdInput value={cwds} onChange={setCwds} ariaLabel={t.settings.cwd} />
            <button
              className="primary"
              onClick={saveCwd}
              disabled={
                !settings ||
                !cwds.length ||
                cwds.join('\n') === cwdsOf({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds }).join('\n')
              }
            >
              {t.common.save}
            </button>
          </div>
          {msg.text && <p className={msg.error ? 'error-line' : 'muted small'}>{msg.text}</p>}
        </section>

        {settings && <SessionsCard settings={settings} onSettings={setSettings} onHomeChanged={() => void refreshProviders(true)} />}

        <SharesCard />
        <PublishCard />
        <HandoffsCard />

        <BrowsersCard browsers={browsers} />
        <HomeScreenGuide phone={browsers.phone} />

        <section className="card" id={sectionId('tour')}>
          <SectionTitle section="tour">{t.settings.tour}</SectionTitle>
          <p className="muted small">{t.settings.tourHint}</p>
          <div className="button-row">
            <button className="ghost" onClick={onShowTour}>
              {t.settings.replayTour}
            </button>
          </div>
        </section>

        <LabsCard providers={providers} catalog={catalog} />
      </div>
    </div>
  );
}

/** The first Settings card. The same links work when bookmarked or when the destination is already in the URL. */
function AssistantOverview({ providers, installs }: { providers: ProviderStatus[]; installs: CliInstallView[] }) {
  const t = useT();
  const a = t.settings.assistants;
  const assistants = PROVIDERS.map((provider) => {
    const status = providers.find((s) => s.provider === provider);
    return {
      provider,
      state: assistantReadiness(
        status,
        installs.find((i) => i.provider === provider),
      ),
      installed: status?.installed,
    };
  });
  const ready = assistants.filter(({ state }) => state.kind === 'ready');
  const others = assistants
    .filter(({ state }) => state.kind !== 'ready')
    .sort((left, right) => Number(!!right.installed) - Number(!!left.installed));
  const checking = assistants.some(({ state }) => state.kind === 'checking');

  const links = (items: typeof assistants) => (
    <ul className="settings-assistant-list">
      {items.map(({ provider, state }) => {
        const target = state.kind === 'backend' ? 'backends' : provider;
        const label =
          state.kind === 'checking'
            ? t.settings.checking
            : state.kind === 'ready' && state.account
              ? a.readyAccount(accountName(state.account, t))
              : a[state.kind];
        return (
          <li key={provider}>
            <a
              href={settingsHref(target)}
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) scrollToSection(target, true);
              }}
              className="settings-assistant-link"
            >
              <span className="settings-assistant-name">
                <i style={{ background: PROVIDER_COLOR[provider] }} aria-hidden="true" />
                {PROVIDER_LABEL[provider]}
              </span>
              <span className="settings-assistant-state">
                {state.kind === 'ready' && <CheckIcon size={13} />}
                {label}
              </span>
              <ChevronIcon size={15} />
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <section className="card settings-overview" id={sectionId('overview')}>
      <SectionTitle section="overview">{a.title}</SectionTitle>
      {ready.length > 0 ? (
        links(ready)
      ) : (
        <p className="muted small" role="status">
          {checking ? t.settings.checking : a.empty}
        </p>
      )}
      {providers.length > 0 && others.length > 0 && (
        <details className="settings-assistant-more" open={!ready.length}>
          <summary>
            <ChevronIcon size={16} />
            {ready.length ? a.connect : a.connectFirst}
          </summary>
          {links(others)}
        </details>
      )}
    </section>
  );
}

/** The agent that designs the team in auto-team conversations. */
function LeadCard({
  lead: saved,
  chatTitles,
  draftLink,
  providers,
  catalog,
  onSettings,
}: {
  lead: LeadAgentSettings;
  /** Whether the lead agent names new chats (saved as soon as it is switched). */
  chatTitles: boolean;
  draftLink?: React.ReactNode;
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
  useEffect(() => setLead(saved), [saved.provider, saved.model, saved.effort, saved.account]);

  const status = providers.find((p) => p.provider === lead.provider);
  // As its account runs it: that account's models and defaults.
  const pm = catalogFor(catalog, lead.provider, lead.account);
  const account = accountOf(status, lead.account);
  const unchanged =
    lead.provider === saved.provider &&
    (lead.model ?? '') === (saved.model ?? '') &&
    (lead.effort ?? '') === (saved.effort ?? '') &&
    (lead.account ?? '') === (saved.account ?? '');

  const [naming, setNaming] = useState(false);
  // Shown switched at once, and back again if saving it fails.
  const [titles, setTitlesShown] = useState(chatTitles);
  useEffect(() => setTitlesShown(chatTitles), [chatTitles]);
  const setTitles = async (on: boolean) => {
    setNaming(true);
    setTitlesShown(on);
    setNote({ text: '' });
    try {
      onSettings(await api.updateSettings({ chatTitles: on }));
      setNote({ text: t.settings.chatTitlesSaved(on) });
    } catch (e) {
      setTitlesShown(!on);
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setNaming(false);
    }
  };

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
      {draftLink}
      <p className="muted small">{t.settings.leadHint}</p>
      <CliPicker
        value={lead.provider}
        label={t.settings.lead}
        onPick={(p) => {
          const next = switchProvider(lead, p, kept.current);
          kept.current = next.kept;
          setLead(next.value);
        }}
      />
      <AccountPicker status={status} value={lead.account} onChange={(a) => setLead({ ...lead, account: a })} />
      <ModelPicker
        key={`${lead.provider}|${lead.account ?? ''}`}
        catalog={pm}
        model={lead.model ?? ''}
        effort={lead.effort ?? ''}
        onChange={(v) => setLead({ ...lead, model: v.model, effort: v.effort })}
        inheritModelLabel={inheritModelLabel(pm, lead.provider, t)}
        inheritEffortLabel={(model) => {
          const e = pm && inheritedEffort(pm, model);
          return t.team.defaultModel(e ? t.effortLabel(e) : t.team.cliDecides);
        }}
      />
      {status && accountState(status, lead.account) !== 'ok' && (
        <p className="warn-line">
          {/* Not installed: its card (the executable path). An open agent without a backend: API Key. Else: sign in. */}
          {!status.installed ? (
            <>
              {status.tooOld
                ? t.settings.leadTooOld(PROVIDER_LABEL[lead.provider], status.tooOld)
                : t.settings.leadNotInstalled(PROVIDER_LABEL[lead.provider])}{' '}
              <a href={settingsHref(lead.provider)} onClick={() => scrollToSection(lead.provider)}>
                {t.settings.goCard(PROVIDER_LABEL[lead.provider])}
              </a>
            </>
          ) : isOpenProvider(lead.provider) ? (
            <>
              {t.settings.leadNoBackend(PROVIDER_LABEL[lead.provider])}{' '}
              <a href={settingsHref('backends')} onClick={() => scrollToSection('backends')}>
                {t.settings.open.goBackends}
              </a>
            </>
          ) : (
            <>
              {account && status.accounts.length > 1
                ? t.accounts.notLoggedIn(PROVIDER_LABEL[lead.provider], accountName(account, t))
                : t.settings.leadNotReady(PROVIDER_LABEL[lead.provider])}{' '}
              <a href={settingsHref(lead.provider)} onClick={() => scrollToSection(lead.provider)}>
                {t.settings.goSignIn(PROVIDER_LABEL[lead.provider])}
              </a>
            </>
          )}
        </p>
      )}
      <div className="button-row">
        <button className="primary" onClick={save} disabled={busy || unchanged}>
          {t.common.save}
        </button>
      </div>
      {/* Saved as soon as it is switched, apart from the lead agent above. */}
      <label className="check-row chat-titles">
        <input type="checkbox" checked={titles} disabled={naming} onChange={(e) => void setTitles(e.target.checked)} />
        <span>
          {t.settings.chatTitles}
          <span className="small muted checks-flag-hint">{t.settings.chatTitlesHint}</span>
        </span>
      </label>
      {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
    </section>
  );
}

function statusPill(
  s: (Pick<ProviderStatus, 'installed' | 'tooOld' | 'auth' | 'usingStoredApiKey'> & { provider?: Provider }) | undefined,
  t: Messages,
): { text: string; cls: string } {
  const p = t.settings.pill;
  if (!s) return { text: p.checking, cls: '' };
  if (s.tooOld) return { text: p.tooOld, cls: 'warn' };
  if (!s.installed) return { text: p.notInstalled, cls: 'off' };
  // An open agent has no sign-in: it is ready once a model backend is set up (and its adapter is done).
  if (s.provider && isOpenProvider(s.provider))
    return s.auth.loggedIn ? { text: p.openReady, cls: 'ok' } : { text: p.openNotReady, cls: 'warn' };
  if (s.usingStoredApiKey) return { text: p.apiKey, cls: 'ok' };
  if (s.auth.loggedIn) return { text: p.loggedIn, cls: 'ok' };
  if (s.auth.loggedIn === false) return { text: p.notLoggedIn, cls: 'warn' };
  return { text: p.unknown, cls: '' };
}

/**
 * Why a CLI that is there cannot run: older than Harness Relay supports (`tooOld`), with the version it
 * needs and how to get it (the buttons are `CliInstall`'s: Install for another copy, Update for one
 * Harness Relay installed); or its program could not start (it cannot be run, or it was killed as it
 * started), in the server's words. A CLI that is simply not found says nothing here (`CliInstall`).
 */
function CliProblemLine({
  provider,
  status,
  install,
  checking,
}: {
  provider: Provider;
  status?: ProviderStatus;
  install?: CliInstallView;
  /** Just installed, its status being checked again (`statusBeforeInstall`): what it said before is old. */
  checking: boolean;
}) {
  const t = useT();
  if (checking) return null;
  if (status && !status.installed && !status.tooOld && status.auth.detail) return <p className="warn-line">{status.auth.detail}</p>;
  if (!status?.tooOld) return null;
  const label = PROVIDER_LABEL[provider];
  return (
    <p className="warn-line">
      {t.settings.tooOld(label, status.version ?? '?', status.tooOld)}
      {/* Install is offered only while Harness Relay has no copy of its own (with one, Update or Remove),
          and can install it here (else the card says why not). */}
      {!install?.installed && !install?.blocked && <> {t.settings.tooOldUpdate}</>}
    </p>
  );
}

/** What a CLI's card needs to install it, or remove what Harness Relay installed (`CliInstall`). */
interface InstallProps {
  install?: CliInstallView;
  onInstallView: (view: CliInstallView) => void;
  onCliChanged: () => Promise<void>;
}

function ProviderCard({
  provider,
  status,
  catalog,
  settings,
  install,
  onInstallView,
  onCliChanged,
  onSettings,
  onRefresh,
  onDefaults,
}: InstallProps & {
  provider: Provider;
  status?: ProviderStatus;
  /** This CLI's models, one entry per account (`catalogFor`). */
  catalog: ProviderModels[];
  settings?: ProviderSettingsView;
  onSettings: (s: SettingsView) => void;
  onRefresh: () => Promise<void>;
  /** An account's defaults changed: the models again, without asking the CLIs again. */
  onDefaults: () => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const { maxAccounts } = useLimits();
  const [methods, setMethods] = useState<LoginMethod[]>([]);
  const [bin, setBin] = useState('');
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const accounts = settings?.accounts ?? [];
  /** More than one account: each says that what it loads and leaves out is its own. */
  const multi = accounts.length > 1;
  // Just installed from here, its status still being checked again: not "not installed".
  const checking = statusBeforeInstall(status, install);
  const pill = statusPill(checking ? undefined : status, t);

  // Method labels come from the server in the UI language.
  useEffect(() => {
    api.loginMethods(provider).then(setMethods, (e: Error) => setNote(e.message));
  }, [provider, lang]);

  useEffect(() => setBin(settings?.bin ?? ''), [settings?.bin]);

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

  // The executable every account of this CLI runs.
  const saveBin = () =>
    act(async () => {
      onSettings(await api.updateProvider(provider, { bin }));
      await onRefresh();
    }, t.settings.saved);

  // A name for the next account that no account has yet ("Account 2", "Account 3"…).
  const suggested = (() => {
    const taken = new Set(accounts.map((a) => accountName(a, t).toLowerCase()));
    let n = accounts.length + 1;
    while (taken.has(t.accounts.nextName(n).toLowerCase())) n++;
    return t.accounts.nextName(n);
  })();

  const addAccount = () => {
    const name = newName.trim() || suggested;
    void act(async () => {
      const r = await api.addAccount(provider, name);
      onSettings(r.settings);
      setNewName('');
      await onRefresh();
    }, t.accounts.added(name));
  };

  return (
    <section className="card provider-card" id={sectionId(provider)} style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}>
      <header className="provider-head">
        <span className="provider-swatch" />
        <SectionTitle section={provider}>{PROVIDER_LABEL[provider]}</SectionTitle>
        {/* Each account says how it is signed in, in its own block; here only whether the CLI is there. */}
        {!status?.installed && <span className={`pill ${pill.cls}`}>{pill.text}</span>}
        {/* A CLI that is not installed is explained once, in the line below. */}
        {(status?.installed || status?.tooOld) && status.version && <span className="muted small">v{status.version}</span>}
      </header>

      <CliProblemLine provider={provider} status={status} install={install} checking={checking} />
      <CliInstall provider={provider} status={status} view={install} onView={onInstallView} onChanged={onCliChanged} />

      {/* Once for the CLI: every account's members can run on the user's own endpoints. */}
      {isEndpointCli(provider) && (
        <p className="muted small">
          {t.settings.ownEndpoint[provider]}{' '}
          <a href={settingsHref('backends')} onClick={() => scrollToSection('backends')}>
            {t.settings.open.goBackends}
          </a>
        </p>
      )}

      {(accounts.length ? accounts : [undefined]).map((a) => (
        <AccountBlock
          key={a?.id ?? ''}
          provider={provider}
          account={a}
          status={status?.accounts.find((x) => x.id === (a?.id ?? '')) ?? (a?.id ? undefined : status?.accounts[0])}
          installed={Boolean(status?.installed)}
          tooOld={status?.tooOld}
          methods={methods}
          multi={multi}
          catalog={catalogFor(catalog, provider, a?.id)}
          onSettings={onSettings}
          onRefresh={onRefresh}
          onDefaults={onDefaults}
        />
      ))}

      <details className="sub">
        <summary>{t.accounts.add}</summary>
        <div className="sub-body">
          <p className="muted small">{t.accounts.addHint(PROVIDER_LABEL[provider])}</p>
          <div className="input-row">
            <input
              value={newName}
              placeholder={suggested}
              aria-label={t.accounts.nameLabel}
              maxLength={MAX_ACCOUNT_LABEL}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && accounts.length < maxAccounts && addAccount()}
            />
            <button className="primary" onClick={addAccount} disabled={busy || !settings || accounts.length >= maxAccounts}>
              {t.accounts.add}
            </button>
          </div>
          {accounts.length >= maxAccounts && <p className="muted small">{t.accounts.limit(maxAccounts)}</p>}
        </div>
      </details>

      {settings?.environment && <AgentEnvSettings provider={provider} view={settings.environment} onSettings={onSettings} />}

      <details className="sub">
        <summary>
          {t.settings.bin}
          {settings?.bin && ` (${settings.bin})`}
        </summary>
        <div className="sub-body">
          <p className="muted small">{t.settings.binHint(PROVIDER_LABEL[provider], provider)}</p>
          <div className="input-row">
            <input
              value={bin}
              placeholder={provider}
              aria-label={t.settings.bin}
              onChange={(e) => setBin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && settings && bin !== settings.bin && void saveBin()}
              spellCheck={false}
            />
            <button className="ghost" onClick={() => void saveBin()} disabled={busy || !settings || bin === settings.bin}>
              {t.common.save}
            </button>
          </div>
        </div>
      </details>

      {note && <p className="muted small">{note}</p>}
    </section>
  );
}

/**
 * One account of a CLI, in a box of its own also while it is the only one: a head with its name, its
 * sign-in state, and renaming and removing it (the default account cannot be removed); signing it in
 * and out with the CLI's own flow, its API key, and how Harness Relay runs it: its default model and
 * effort, and what its runs leave out of what the CLI loads by itself in its home. `multi`: the CLI has
 * other accounts too.
 */
function AccountBlock({
  provider,
  account,
  status,
  installed,
  tooOld,
  methods,
  multi,
  catalog,
  onSettings,
  onRefresh,
  onDefaults,
}: {
  provider: Provider;
  /** Undefined until the settings have loaded (the default account then). */
  account?: ProviderAccountView;
  status?: AccountStatus;
  installed: boolean;
  /** The CLI is too old (the version it needs): its accounts say so, not that it is missing. */
  tooOld?: string;
  methods: LoginMethod[];
  multi: boolean;
  /** The models of the CLI in this account's home, with its defaults. */
  catalog?: ProviderModels;
  onSettings: (s: SettingsView) => void;
  onRefresh: () => Promise<void>;
  onDefaults: () => Promise<void>;
}) {
  const t = useT();
  const id = account?.id ?? '';
  const name = accountName({ id, label: account?.label ?? '' }, t);
  const [method, setMethod] = useState('');
  const [login, setLogin] = useState<LoginSessionView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pill = statusPill(status && { installed, tooOld, auth: status.auth, usingStoredApiKey: status.usingStoredApiKey }, t);
  const loggedIn = Boolean(status?.auth.loggedIn);
  const keyOnly = keyOnlyAccount(provider, id);

  useEffect(() => setMethod((cur) => (methods.some((x) => x.id === cur) ? cur : (methods[0]?.id ?? ''))), [methods]);

  // Pick up a login still running from before (the page was left or reloaded). A finished one's
  // result was shown where it finished; coming back to the page starts clean.
  useEffect(() => {
    api.getLogin(provider, id).then(
      (v) => setLogin(v?.state === 'running' ? v : null),
      (e: Error) => setNote(e.message),
    );
  }, [provider, id]);

  // Poll the login session while it runs.
  const running = login?.state === 'running';
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const v = await api.getLogin(provider, id).catch(() => null);
      setLogin(v);
      if (v && v.state !== 'running') void onRefreshRef.current();
    }, 1000);
    return () => clearInterval(timer);
  }, [running, provider, id]);

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
    if (provider === 'codex' && loggedIn && !confirm(t.settings.confirmCodexRelogin)) return;
    void act(async () => setLogin(await api.startLogin(provider, method, id)));
  };

  const logout = () => {
    if (!confirm(id ? t.accounts.confirmLogout(name, PROVIDER_LABEL[provider]) : t.settings.confirmLogout(PROVIDER_LABEL[provider])))
      return;
    void act(async () => {
      await api.logout(provider, id);
      await onRefresh();
    }, t.settings.loggedOut);
  };

  const saveKey = (remove = false) =>
    act(
      async () => {
        onSettings(await api.updateAccount(provider, id, { apiKey: remove ? null : apiKey }));
        setApiKey('');
        await onRefresh();
      },
      remove ? t.settings.keyRemoved : t.settings.keySaved,
    );

  const rename = () =>
    act(async () => {
      onSettings(await api.updateAccount(provider, id, { label: renaming ?? '' }));
      setRenaming(null);
      await onRefresh();
    }, t.accounts.renamed);

  const remove = () => {
    if (!confirm(t.accounts.confirmRemove(name, PROVIDER_LABEL[provider], account?.home ?? ''))) return;
    void act(async () => {
      onSettings(await api.removeAccount(provider, id));
      await onRefresh();
    });
  };

  const selected = methods.find((m) => m.id === method);

  return (
    <div className="login-block account-block">
      <div className="account-head">
        {renaming === null ? (
          <>
            <strong>{name}</strong>
            <span className={`pill ${pill.cls}`}>{pill.text}</span>
            {installed && status && (
              <span className="muted small">
                {[status.auth.account, status.auth.method, status.auth.detail].filter(Boolean).join(' · ')}
              </span>
            )}
            <span className="account-actions">
              <button className="ghost small-button" onClick={() => setRenaming(account?.label || name)} disabled={busy || !account}>
                {t.accounts.rename}
              </button>
              {id && (
                <button className="ghost small-button danger" onClick={remove} disabled={busy || running}>
                  {t.accounts.remove}
                </button>
              )}
            </span>
          </>
        ) : (
          <div className="input-row">
            <input
              value={renaming}
              aria-label={t.accounts.nameLabel}
              maxLength={MAX_ACCOUNT_LABEL}
              autoFocus
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
            <button className="primary" onClick={() => void rename()} disabled={busy}>
              {t.common.save}
            </button>
            <button className="ghost" onClick={() => setRenaming(null)} disabled={busy}>
              {t.common.cancel}
            </button>
          </div>
        )}
      </div>
      {id && account?.home && <p className="muted small mono-path">{t.accounts.folder(account.home)}</p>}

      <UsagePanel
        provider={provider}
        account={id}
        name={name}
        usable={installed && status !== undefined && accountUsable(status)}
        signIn={
          status
            ? [status.auth.loggedIn, status.auth.account, status.auth.method, status.usingStoredApiKey, account?.apiKeyMasked].join('|')
            : ''
        }
      />

      {keyOnly ? (
        <p className="muted small">
          {provider === 'antigravity'
            ? t.settings.keyOnlyAntigravity
            : provider === 'muse'
              ? t.settings.keyOnlyMuse
              : t.settings.keyOnlyAccount}
        </p>
      ) : (
        <>
          <div className="method-list" role="radiogroup">
            {methods.map((m) => (
              <label key={m.id} className={`method ${method === m.id ? 'on' : ''}`}>
                <input type="radio" name={`m-${provider}-${id}`} checked={method === m.id} onChange={() => setMethod(m.id)} />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
          {selected && <p className="muted small">{selected.description}</p>}
          <div className="button-row">
            <button className="primary" onClick={startLogin} disabled={busy || running || !installed}>
              {loggedIn ? t.settings.relogin : t.settings.login}
            </button>
            {loggedIn && (
              <button className="ghost" onClick={logout} disabled={busy || running}>
                {t.settings.logout}
              </button>
            )}
          </div>
        </>
      )}
      {login && <LoginPanel login={login} provider={provider} account={id} onUpdate={setLogin} onError={setNote} />}

      <details className="sub" open={keyOnly || undefined}>
        <summary>
          {t.settings.apiKey}
          {account?.apiKeyMasked ? t.settings.apiKeySet(account.apiKeyMasked) : ''}
        </summary>
        <div className="sub-body">
          <p className="muted small">
            {t.settings.apiKeyHelp[provider as SignInCli]}
            {account?.apiKeyStorage && t.settings.keyStorage(t.settings.keyStorageName[account.apiKeyStorage])}
            {/* The server's own environment is the default account's only. */}
            {!id &&
              (account?.apiKeyStorage === 'encrypted' || account?.apiKeyStorage === 'database') &&
              t.settings.keyEnvHint(KEY_ENV[provider as SignInCli])}
          </p>
          <div className="input-row">
            <input
              type="password"
              value={apiKey}
              placeholder={KEY_PLACEHOLDER[provider as SignInCli]}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <button className="primary" onClick={() => saveKey()} disabled={busy || !apiKey.trim()}>
              {t.common.save}
            </button>
            {account?.apiKeyMasked && (
              <button className="ghost" onClick={() => saveKey(true)} disabled={busy}>
                {t.common.remove}
              </button>
            )}
          </div>
        </div>
      </details>

      <AccountDefaults provider={provider} account={account} catalog={catalog} onSettings={onSettings} onSaved={onDefaults} />

      {hasSubagents(provider) && <CliFeatures provider={provider} account={account} onSettings={onSettings} />}

      <NativeSetupPanel provider={provider} account={account} multi={multi} onSettings={onSettings} />

      {note && <p className="muted small">{note}</p>}
    </div>
  );
}

/**
 * An account's default model and effort: what its members (and the lead agent, when it runs as this
 * account) run when they leave them on "default". Empty: the CLI's own, from the config in its home.
 */
function AccountDefaults({
  provider,
  account,
  catalog,
  onSettings,
  onSaved,
}: {
  provider: Provider;
  account?: ProviderAccountView;
  catalog?: ProviderModels;
  onSettings: (s: SettingsView) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const savedModel = account?.defaultModel ?? '';
  const savedEffort = account?.defaultEffort ?? '';

  useEffect(() => {
    setModel(savedModel);
    setEffort(savedEffort);
  }, [savedModel, savedEffort]);

  const save = async () => {
    if (!account) return;
    setBusy(true);
    setNote({ text: '' });
    try {
      onSettings(await api.updateAccount(provider, account.id, { defaultModel: model, defaultEffort: effort }));
      await onSaved();
      setNote({ text: t.settings.saved });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="sub">
      <summary>
        {t.settings.defaults}
        {(savedModel || savedEffort) && ` (${[savedModel, savedEffort && t.effortLabel(savedEffort)].filter(Boolean).join(' · ')})`}
      </summary>
      <div className="sub-body">
        <p className="muted small">{t.settings.defaultsHint(PROVIDER_LABEL[provider])}</p>
        {catalog?.error && <p className="warn-line">{t.settings.modelsError(catalog.error)}</p>}
        <ModelPicker
          key={`${savedModel}|${catalog?.models.length ?? 0}`}
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
        <div className="button-row">
          <button
            className="ghost"
            onClick={() => void save()}
            disabled={busy || !account || (model === savedModel && effort === savedEffort)}
          >
            {t.common.save}
          </button>
        </div>
        {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
      </div>
    </details>
  );
}

/**
 * An open agent's card (OpenCode, Goose, Cline, OpenHands, Pi): no sign-in and no key of its own, since
 * it uses the model backends; its default model and effort, its executable, and what it loads by itself
 * once its adapter can ask it.
 */
function OpenAgentCard({
  provider,
  status,
  catalog,
  settings,
  install,
  onInstallView,
  onCliChanged,
  onSettings,
  onRefresh,
}: InstallProps & {
  provider: OpenProvider;
  status?: ProviderStatus;
  catalog?: ProviderModels;
  settings?: ProviderSettingsView;
  onSettings: (s: SettingsView) => void;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const o = t.settings.open;
  const [bin, setBin] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Just installed from here, its status still being checked again: not "not installed".
  const checking = statusBeforeInstall(status, install);
  const pill = statusPill(checking ? undefined : status, t);
  const label = PROVIDER_LABEL[provider];
  // An open agent has its default account only (no sign-in): its defaults and what it leaves out are that account's.
  const account = settings?.accounts[0];

  useEffect(() => {
    setBin(settings?.bin ?? '');
    setModel(account?.defaultModel ?? '');
    setEffort(account?.defaultEffort ?? '');
  }, [settings?.bin, account?.defaultModel, account?.defaultEffort]);

  // The terminal switch saves at once; what is being saved shows until then.
  const [terminal, setTerminal] = useState<boolean | null>(null);
  const saveTerminal = async (on: boolean) => {
    setTerminal(on);
    setNote('');
    try {
      onSettings(await api.updateProvider(provider, { sandboxTerminal: on }));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setTerminal(null);
    }
  };

  const save = async () => {
    setBusy(true);
    setNote('');
    try {
      await api.updateProvider(provider, { bin });
      onSettings(await api.updateAccount(provider, '', { defaultModel: model, defaultEffort: effort }));
      await onRefresh();
      setNote(t.settings.saved);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card provider-card" id={sectionId(provider)} style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}>
      <header className="provider-head">
        <span className="provider-swatch" />
        <SectionTitle section={provider}>{label}</SectionTitle>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
        <span className="muted small">
          {status?.version && `v${status.version}`}
          {status?.installed && status.auth.detail && ` · ${status.auth.detail}`}
        </span>
      </header>

      <CliProblemLine provider={provider} status={status} install={install} checking={checking} />
      <CliInstall provider={provider} status={status} view={install} onView={onInstallView} onChanged={onCliChanged} />

      <p className="muted small">
        {o.intro(label)}{' '}
        <a href={settingsHref('backends')} onClick={() => scrollToSection('backends')}>
          {o.goBackends}
        </a>
      </p>
      <p className="muted small">{o.noSubscription}</p>
      <p className="muted small">{o.sandbox}</p>
      {o.notes[provider] && <p className="muted small">{o.notes[provider]}</p>}

      <details className="sub">
        <summary>
          {t.settings.defaults}
          {(account?.defaultModel || account?.defaultEffort) &&
            ` (${[account.defaultModel, account.defaultEffort && t.effortLabel(account.defaultEffort)].filter(Boolean).join(' · ')})`}
        </summary>
        <div className="sub-body">
          <p className="muted small">{t.settings.defaultsHint(label)}</p>
          {catalog?.error && <p className="warn-line">{t.settings.modelsError(catalog.error)}</p>}
          <ModelPicker
            key={`${account?.defaultModel}|${catalog?.models.length ?? 0}`}
            catalog={catalog}
            model={model}
            effort={effort}
            onChange={(v) => {
              setModel(v.model);
              setEffort(v.effort);
            }}
            inheritModelLabel={
              catalog?.cliDefaultModel
                ? t.settings.cliDefault(catalog.cliDefaultModel)
                : catalog
                  ? o.noCliDefault
                  : t.settings.cliDefault(t.settings.unknown)
            }
            inheritEffortLabel={() =>
              t.settings.cliDefault(catalog?.cliDefaultEffort ? t.effortLabel(catalog.cliDefaultEffort) : t.settings.unknown)
            }
          />
          <label className="field">
            <span>{t.settings.bin}</span>
            <input value={bin} placeholder={provider} onChange={(e) => setBin(e.target.value)} spellCheck={false} />
          </label>
          <div className="button-row">
            <button className="ghost" onClick={save} disabled={busy}>
              {t.common.save}
            </button>
          </div>
        </div>
      </details>

      {SANDBOX_TERMINAL_SUPPORT.includes(provider) && (
        <div className="sandbox-terminal">
          <label className="check-row">
            <input
              type="checkbox"
              checked={terminal ?? settings?.sandboxTerminal ?? false}
              disabled={terminal !== null || !settings}
              onChange={(e) => void saveTerminal(e.target.checked)}
            />
            <span>{o.sandboxTerminal.label}</span>
          </label>
          <p className="muted small">{o.sandboxTerminal.detail}</p>
        </div>
      )}

      {hasSubagents(provider) && <CliFeatures provider={provider} account={account} onSettings={onSettings} />}

      {hasNativePanel(provider) && <NativeSetupPanel provider={provider} account={account} onSettings={onSettings} />}

      {note && <p className="muted small">{note}</p>}
    </section>
  );
}

function LoginPanel({
  login,
  provider,
  account,
  onUpdate,
  onError,
}: {
  login: LoginSessionView;
  provider: Provider;
  /** Empty for the default account. */
  account: string;
  onUpdate: (v: LoginSessionView | null) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const running = login.state === 'running';
  // Claude's flow prints a URL and then waits for the code shown after authorising.
  const askForCode = running && (login.wantsInput || provider === 'claude');

  const submitCode = async () => {
    if (!code.trim()) return;
    try {
      onUpdate(await api.loginInput(provider, code, account));
      setCode('');
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const cancel = () =>
    api
      .cancelLogin(provider, account)
      .then(() => api.getLogin(provider, account))
      .then(onUpdate, (e: Error) => onError(e.message));

  return (
    <div className={`login-panel ${login.state}`}>
      <div className="login-state">
        {running && <LogoSpinner />}
        <strong>{t.settings.loginState[login.state]}</strong>
        {running && (
          <button className="ghost small-button" onClick={cancel}>
            {t.common.cancel}
          </button>
        )}
      </div>

      <LoginLinks login={login} />

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

      <LoginOutput login={login} />
    </div>
  );
}

/** Links to every card of the page, in page order, the agents' in one menu; they stay at the top while the page scrolls. */
function SettingsNav({ section }: { section?: SettingsSection }) {
  const t = useT();
  const marker = useRef<HTMLSpanElement>(null);
  const nav = useRef<HTMLElement>(null);
  const row = useRef<HTMLDivElement>(null);
  // Whether the links make room for the button in the top-left corner (the menu on phones, the
  // collapsed sidebar's): from the moment their row comes up to it as the page scrolls, so that it never
  // covers a link (`makeRoomForCorner`). Checked as the page scrolls, and when the window or the main
  // area changes size (the sidebar collapsed or opened).
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const links = row.current;
    const scroller = links?.closest<HTMLElement>('.scroll');
    const main = links?.closest<HTMLElement>('.main');
    if (!links || !scroller || !main) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const corner = [...main.querySelectorAll<HTMLElement>(':scope > .menu-button, :scope > .sidebar-tools')].find(
        (el) => el.getClientRects().length > 0,
      );
      setStuck(makeRoomForCorner(links.getBoundingClientRect().top, corner?.getBoundingClientRect().bottom));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(later);
    sizes?.observe(main);
    update();
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
      sizes?.disconnect();
    };
  }, []);

  // The card being read is highlighted: checked as the page scrolls, and when cards change size (they load their content).
  const [active, setActive] = useState<SettingsSection>();
  // A card picked with a link stays highlighted while the page scrolls there, and until the reader scrolls on.
  const picked = useRef<{ until: number } | null>(null);
  const pick = (s: SettingsSection) => {
    picked.current = { until: Date.now() + 600 };
    setActive(s);
  };
  useEffect(() => {
    if (section) pick(settingsCard(section));
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

  // Where the links do not fit (narrow windows, phones), they scroll sideways: bring the highlighted one
  // into view when it is not, and otherwise leave the row where it is, so it does not slide as the page scrolls.
  useEffect(() => {
    const links = row.current;
    // An agent's card is reached through the agents' menu: its button is what shows.
    const chip = active && links?.querySelector<HTMLElement>(`[data-section="${navEntryOf(active)}"]`);
    if (!links || !chip) return;
    const left = revealLink(links, { left: chip.offsetLeft, width: chip.offsetWidth });
    if (left !== undefined) links.scrollTo({ left, behavior: 'smooth' });
    // Again when the row narrows or widens as it makes room for the corner's button (`stuck`).
  }, [active, stuck]);
  // The agents' menu: one entry in the row for every agent's card (`SETTINGS_NAV`), which shows the
  // agent being read. A menu button: arrows, Home and End move in it, scrolling it to the item;
  // Escape closes it back to its button (also once a click on its heading has taken the focus);
  // Tab closes it and goes on from its button; a tap or focus elsewhere closes it. It follows its
  // button as the row scrolls sideways or sticks, or the window changes size, inside the window and
  // no taller than the room below its button.
  const activeAgent = active !== undefined && isAgentSection(active) ? active : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  /** Where the menu opens: under its button, inside the window (in the nav's own coordinates), and how tall it may be there. */
  const [menuAt, setMenuAt] = useState<{ left: number; top: number; maxHeight: number }>();
  /** Which item takes the focus once the menu shows. */
  const focusOnOpen = useRef<'active' | 'first' | 'last'>('active');
  const menuId = useId();
  const agentsButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) agentsButton.current?.focus({ preventScroll: true });
  }, []);
  // The Tool library links to the same picker as the navigation. A bookmarked link
  // or a return with Back opens it with the keyboard focus on a choice.
  useLayoutEffect(() => {
    if (section === 'agents') {
      agentsButton.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      focusOnOpen.current = 'first';
      setMenuOpen(true);
    } else if (section && isAgentSection(section) && menu.current) {
      // Close when the chosen card becomes current. A quick Back can already be opening the picker again.
      closeMenu(true);
    }
  }, [section, closeMenu]);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  /** Focuses an item, scrolling the menu (and only it) just far enough to show it. */
  const focusItem = (item: HTMLElement | undefined) => {
    const list = menu.current;
    if (!item || !list) return;
    item.focus({ preventScroll: true });
    const pad = 6;
    if (item.offsetTop - pad < list.scrollTop) list.scrollTop = item.offsetTop - pad;
    else if (item.offsetTop + item.offsetHeight + pad > list.scrollTop + list.clientHeight)
      list.scrollTop = item.offsetTop + item.offsetHeight + pad - list.clientHeight;
  };
  const openMenu = (focus: 'active' | 'first' | 'last') => {
    focusOnOpen.current = focus;
    setMenuOpen(true);
  };
  useLayoutEffect(() => {
    if (!menuOpen) return setMenuAt(undefined);
    const place = () => {
      const button = agentsButton.current?.getBoundingClientRect();
      const box = nav.current?.getBoundingClientRect();
      const width = menu.current?.offsetWidth ?? 0;
      if (!button || !box) return;
      // Under the button, its left edge with the button's, moved left as far as it must to stay in the window.
      const left = Math.max(8, Math.min(button.left, window.innerWidth - width - 8)) - box.left;
      // As tall as the room below the button (the nav sits lower before it sticks), at least a few items.
      const maxHeight = Math.max(120, Math.min(520, window.innerHeight - button.bottom - 6 - 8));
      setMenuAt({ left, top: button.bottom - box.top + 6, maxHeight });
    };
    place();
    const links = row.current;
    links?.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    return () => {
      links?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
    };
    // Again when the row sticks, which moves the button.
  }, [menuOpen, stuck]);
  useEffect(() => {
    if (!menuOpen || !menuAt) return;
    const all = items();
    const at =
      focusOnOpen.current === 'first'
        ? 0
        : focusOnOpen.current === 'last'
          ? all.length - 1
          : Math.max(
              0,
              all.findIndex((el) => el.dataset.section === active),
            );
    focusItem(all[at]);
    // Only once, as it opens: the focus is the reader's from then on.
    focusOnOpen.current = 'active';
  }, [menuOpen, menuAt !== undefined]);
  useEffect(() => {
    if (!menuOpen) return;
    // As the chat's ⋯ menu: a tap or focus elsewhere closes it, and the focus stays where it went;
    // focus outside the app (copy.ts's textarea) is left alone.
    const app = document.getElementById('root');
    const outside = (e: Event) => {
      const target = e.target as Node;
      if (e.type === 'focusin' && !app?.contains(target)) return;
      if (!agentsButton.current?.contains(target) && !menu.current?.contains(target)) closeMenu(false);
    };
    // Escape closes it from anywhere, and the arrows go back into it, while the focus is on no item
    // (the page's, after a click on the menu's heading, say).
    const onKey = (e: KeyboardEvent) => {
      if (menu.current?.contains(document.activeElement) || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
        return;
      }
      if (document.activeElement !== document.body) return;
      const all = items();
      const next = menuMove(e.key, -1, all.length);
      if (next === undefined) return;
      e.preventDefault();
      focusItem(all[next]);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, closeMenu]);
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = menuMove(e.key, at, all.length);
    if (next !== undefined) {
      e.preventDefault();
      focusItem(all[next]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === 'Tab') {
      // On from the button in the row, as if the menu were there: back to it, or the next entry,
      // which the row brings into view (it scrolls sideways; focus does not move it here).
      e.preventDefault();
      closeMenu(!e.shiftKey);
      if (e.shiftKey) return agentsButton.current?.focus({ preventScroll: true });
      const after = agentsButton.current?.nextElementSibling as HTMLElement | null;
      const links = row.current;
      after?.focus({ preventScroll: true });
      const left = after && links ? revealLink(links, { left: after.offsetLeft, width: after.offsetWidth }) : undefined;
      if (links && left !== undefined) links.scrollTo({ left, behavior: 'smooth' });
    }
  };

  /** One agent in the menu: its colour, its name, and a check while its card is read. */
  const agentItem = (p: Provider) => (
    <a
      key={p}
      href={settingsHref(p)}
      role="menuitem"
      tabIndex={-1}
      data-section={p}
      className={active === p ? 'active' : undefined}
      aria-current={active === p ? 'location' : undefined}
      onClick={() => {
        pick(p);
        scrollToSection(p);
        if (section === p) closeMenu(true);
      }}
    >
      <i style={{ background: PROVIDER_COLOR[p] }} aria-hidden="true" />
      <span>{PROVIDER_LABEL[p]}</span>
      {active === p && <CheckIcon size={14} />}
    </a>
  );

  // Short labels, so the links fit on one line in every language (the cards keep their full titles).
  const short = t.settings.nav;
  return (
    <>
      <span ref={marker} className="settings-nav-marker" aria-hidden="true" />
      {/* The links scroll inside their own row, so nothing scrolls under the menu button beside it. */}
      <nav ref={nav} className={`settings-nav ${stuck ? 'stuck' : ''}`} aria-label={t.settings.sections}>
        <div ref={row} className="settings-nav-links">
          {SETTINGS_NAV.map((s) =>
            s === 'agents' ? (
              <button
                key={s}
                ref={agentsButton}
                type="button"
                data-section={s}
                className={`settings-nav-agents ${activeAgent ? 'active' : ''}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                onClick={() => (menuOpen ? closeMenu(false) : openMenu('active'))}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  openMenu(e.key === 'ArrowDown' ? 'first' : 'last');
                }}
              >
                {/* As wide as its widest label (each laid over the others, unseen), so the links after it stay put as it changes. */}
                <span className="settings-nav-agents-label">
                  <span>{activeAgent ? short.agentsAt(PROVIDER_LABEL[activeAgent]) : short.agents}</span>
                  {[short.agents, ...AGENT_SECTIONS.map((p) => short.agentsAt(PROVIDER_LABEL[p]))].map((text) => (
                    <span key={text} className="sizer" aria-hidden="true">
                      {text}
                    </span>
                  ))}
                </span>
                <ChevronIcon size={14} />
              </button>
            ) : (
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
                {short[s]}
              </a>
            ),
          )}
        </div>
        {/* Beside the row, not in it: the row scrolls sideways and fades its ends, which would cut the menu off. */}
        {menuOpen && (
          <div
            ref={menu}
            id={menuId}
            className="settings-agents-menu"
            role="menu"
            aria-label={short.agents}
            style={menuAt}
            onKeyDown={onMenuKey}
            // A click on its heading or padding leaves the focus where it is (its keys keep working).
            onMouseDown={(e) => {
              if (!(e.target as Element).closest('[role="menuitem"]')) e.preventDefault();
            }}
          >
            {AGENT_SECTIONS.filter((p) => !isOpenProvider(p)).map(agentItem)}
            {/* The open-source agents after the others, under their heading, as on the page. */}
            <div role="group" aria-label={short.openAgents} className="settings-agents-group">
              <div className="settings-agents-heading" aria-hidden="true">
                {short.openAgents}
              </div>
              {AGENT_SECTIONS.filter(isOpenProvider).map(agentItem)}
            </div>
          </div>
        )}
      </nav>
    </>
  );
}
