import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationGroup, ConversationSummary, ProviderModels, ProviderStatus, UpdateStatus } from '../shared/types';
import { codeFromHash } from '../shared/auth';
import { SIGNED_OUT_EVENT, api } from './api';
import { ChatView } from './components/ChatView';
import { NewChat } from './components/NewChat';
import { NewSchedule } from './components/NewSchedule';
import { Onboarding, onboardingDone } from './components/Onboarding';
import { SettingsPage } from './components/SettingsPage';
import { SignIn } from './components/SignIn';
import { UpdateDialog } from './components/UpdateDialog';
import { hashFor, routeFromHash, type Route } from './route';
import { signInWhere } from './signin';
import { Sidebar } from './components/Sidebar';
import { PanelIcon } from './components/icons';
import { useT } from './i18n';
import { AFTER_UPDATE_MS, isAppWindow, offerShows, pollDelay, readDismissed, shouldOffer, writeDismissed } from './update';
import { useDialogsOpen } from './components/useDialog';

type SeenMap = Record<string, number>;
const SEEN_KEY = 'relay:seen';

function readSeen(): SeenMap | null {
  try {
    const v = localStorage.getItem(SEEN_KEY);
    return v ? (JSON.parse(v) as SeenMap) : null;
  } catch {
    return null;
  }
}

function writeSeen(m: SeenMap): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

export type { Route };

const parseHash = (): Route => routeFromHash(window.location.hash);

const COLLAPSED_KEY = 'relay:sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function navigate(r: Route): void {
  window.location.hash = hashFor(r);
}

/**
 * The app once this browser is signed in; before that, the sign-in page. A sign-in link's code
 * (`#code=…`) is taken out of the address first, so it stays in neither the history nor a shared link.
 */
export function App() {
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  const [error, setError] = useState<string>();
  /** Started by the desktop app: the sign-in page points at its menu, not at a terminal. */
  const [desktopApp, setDesktopApp] = useState(false);
  const state = useRef(auth);
  state.current = auth;

  useEffect(() => {
    let live = true;
    /**
     * Signs in with the code a sign-in link carries, also one opened in a tab that shows the app
     * already (only its fragment changes then), and takes the code out of the address. The code is
     * used up also in a browser signed in already (its new session replaces the old one), so it does
     * not keep working in the browser's history. True when there was one to sign in with.
     */
    const fromLink = async (): Promise<boolean> => {
      const code = codeFromHash(window.location.hash);
      if (!code) return false;
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
      try {
        await api.signIn(code);
        if (live) setAuth('in');
      } catch (e) {
        // A link that no longer works changes nothing for a browser that is signed in.
        const signedIn = state.current === 'in' || (await api.authStatus().catch(() => ({ signedIn: false }))).signedIn;
        if (live && signedIn) setAuth('in');
        else if (live) {
          setError((e as Error).message);
          setAuth('out');
        }
      }
      return true;
    };
    void (async () => {
      // First, also when the page opens with a link (the desktop app always opens it with one): a link
      // that no longer works, or a sign-out later, shows the sign-in page, which then points at the
      // app's menu rather than a terminal.
      const status = await api.authStatus().catch(() => ({ signedIn: false, desktop: false }));
      if (live) setDesktopApp(status.desktop === true);
      if (await fromLink()) return;
      if (live) setAuth(status.signedIn ? 'in' : 'out');
    })();
    const onHash = () => void fromLink();
    const out = () => setAuth('out');
    window.addEventListener('hashchange', onHash);
    window.addEventListener(SIGNED_OUT_EVENT, out);
    return () => {
      live = false;
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(SIGNED_OUT_EVENT, out);
    };
  }, []);

  if (auth === 'checking') return null;
  // Keyed by the error, so a link with a wrong code shows its message on a page already open.
  if (auth === 'out') {
    const where = signInWhere({ desktopServer: desktopApp, userAgent: navigator.userAgent });
    return <SignIn key={error} error={error} where={where} onSignedIn={() => setAuth('in')} />;
  }
  return <RelayApp />;
}

function RelayApp() {
  const t = useT();
  const [tourOpen, setTourOpen] = useState(() => !onboardingDone());
  const [route, setRoute] = useState<Route>(parseHash);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [catalog, setCatalog] = useState<ProviderModels[]>([]);
  /** Mobile: the sidebar drawer is open. */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Wide screens: the sidebar is collapsed (remembered in this browser). */
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setSidebarOpen(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [loaded, setLoaded] = useState(false);
  // The conversations and the groups they are in (the lead agent sorts new ones in the background).
  const refreshConversations = useCallback(() => {
    Promise.all([api.listConversations(), api.listGroups()])
      .then(([list, g]) => {
        setConversations(list);
        setGroups(g);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const refreshProviders = useCallback((force = false) => {
    return api
      .providers(force)
      .then(setProviders)
      .catch(console.error);
  }, []);

  const refreshCatalog = useCallback((force = false) => {
    return api
      .models(force)
      .then(setCatalog)
      .catch(console.error);
  }, []);

  // Stable identity: the settings page re-checks on mount via an effect that depends on it.
  const refreshProviderInfo = useCallback(
    async (force = false) => {
      await Promise.all([refreshProviders(force), refreshCatalog(force)]);
    },
    [refreshProviders, refreshCatalog],
  );

  useEffect(() => {
    refreshConversations();
    void refreshProviderInfo();
  }, [refreshConversations, refreshProviderInfo]);

  // What you have already seen of each conversation, to mark replies that arrived while you were elsewhere.
  const [seen, setSeen] = useState<SeenMap | null>(readSeen);
  useEffect(() => {
    if (!loaded) return;
    // First visit: everything that already exists counts as seen.
    const base = seen ?? Object.fromEntries(conversations.map((c) => [c.id, c.updatedAt]));
    const open = route.page === 'chat' ? conversations.find((c) => c.id === route.id) : undefined;
    const next = open && (base[open.id] ?? 0) < open.updatedAt ? { ...base, [open.id]: open.updatedAt } : base;
    if (next !== seen) {
      setSeen(next);
      writeSeen(next);
    }
  }, [loaded, conversations, route, seen]);

  // The tab title tells you when a conversation needs you: an approval, or a team to confirm.
  const waiting = conversations.filter((c) => c.waiting || c.confirmTeam || (c.asking && !c.running)).length;
  useEffect(() => {
    document.title = waiting ? t.approval.pageTitle(waiting) : 'Harness Relay';
  }, [waiting, t]);

  // Keep the sidebar's states fresh for every conversation, including runs started elsewhere
  // (another tab, or still going after you switched away). The list is a cheap local query.
  useEffect(() => {
    const timer = setInterval(refreshConversations, 3000);
    window.addEventListener('focus', refreshConversations);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshConversations);
    };
  }, [refreshConversations]);

  // This version and the desktop app's updates: asked now and then (often while one is under way).
  const [update, setUpdate] = useState<UpdateStatus>();
  const pollUpdate = useRef<() => void>(() => {});
  /** Asked often until then: Update was pressed, and the app's own dialog may start the update. */
  const fastUntil = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      let next: UpdateStatus | undefined;
      try {
        next = await api.update();
        if (!stopped) setUpdate(next);
      } catch {
        /* asked again later */
      }
      if (!stopped) timer = setTimeout(() => void tick(), pollDelay(next, Date.now(), fastUntil.current));
    };
    pollUpdate.current = () => void tick();
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  const checkUpdate = useCallback(async () => {
    try {
      setUpdate(await api.checkUpdate());
    } catch {
      /* shown as it was */
    }
  }, []);
  // The newer version, offered once with a dialog in the app's own window (src/web/update.ts).
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = (version: string) => {
    writeDismissed(version);
    setDismissed(version);
  };
  const installUpdate = useCallback(async () => {
    const version = update?.available?.version;
    await api.installUpdate();
    if (version) dismiss(version);
    fastUntil.current = Date.now() + AFTER_UPDATE_MS;
    pollUpdate.current();
  }, [update]);
  // Shown only while no other dialog is open (it would take that one's keys), then kept while on offer.
  const dialogs = useDialogsOpen();
  const offerable = shouldOffer(update, dismissed, isAppWindow(navigator.userAgent));
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    setOffer((showing) => offerShows(showing, { offerable, tourOpen, dialogsOpen: dialogs }));
  }, [offerable, tourOpen, dialogs]);

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        onCollapse={() => setCollapsed(true)}
        route={route}
        conversations={conversations}
        groups={groups}
        seen={seen ?? {}}
        providers={providers}
        onChanged={refreshConversations}
        onDeleted={(id) => {
          refreshConversations();
          if (route.page === 'chat' && route.id === id) navigate({ page: 'new' });
        }}
      />
      <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        <button className="menu-button" aria-label={t.app.openSidebar} onClick={() => setSidebarOpen(true)}>
          ☰
        </button>
        {collapsed && (
          <div className="sidebar-tools">
            <button className="icon-button" onClick={() => setCollapsed(false)} aria-label={t.app.expandSidebar} title={t.app.expandSidebar}>
              <PanelIcon />
            </button>
          </div>
        )}
        {route.page === 'new' && (
          <NewChat
            providers={providers}
            catalog={catalog}
            onCreated={(conv) => {
              refreshConversations();
              navigate({ page: 'chat', id: conv.id });
            }}
          />
        )}
        {route.page === 'schedule' && (
          <NewSchedule
            providers={providers}
            catalog={catalog}
            onCreated={(conv) => {
              refreshConversations();
              navigate({ page: 'chat', id: conv.id });
            }}
          />
        )}
        {route.page === 'chat' && (
          <ChatView
            key={route.id}
            id={route.id}
            providers={providers}
            catalog={catalog}
            conversations={loaded ? conversations : undefined}
            onChanged={refreshConversations}
          />
        )}
        {route.page === 'settings' && (
          <SettingsPage
            section={route.section}
            providers={providers}
            catalog={catalog}
            refreshProviders={refreshProviderInfo}
            onShowTour={() => setTourOpen(true)}
            update={update}
            onCheckUpdate={checkUpdate}
            onInstallUpdate={installUpdate}
          />
        )}
      </main>
      {tourOpen && <Onboarding onClose={() => setTourOpen(false)} />}
      {offer && update?.available && (
        <UpdateDialog
          version={update.available.version}
          current={update.current}
          page={update.available.page}
          onUpdate={installUpdate}
          onLater={() => dismiss(update.available!.version)}
        />
      )}
    </div>
  );
}
