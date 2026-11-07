import { useCallback, useEffect, useState } from 'react';
import type { ConversationGroup, ConversationSummary, ProviderModels, ProviderStatus } from '../shared/types';
import { api } from './api';
import { ChatView } from './components/ChatView';
import { NewChat } from './components/NewChat';
import { Onboarding, onboardingDone } from './components/Onboarding';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';
import { PanelIcon, PlusIcon, SearchIcon } from './components/icons';
import { useT } from './i18n';

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

export type Route = { page: 'new' } | { page: 'chat'; id: string } | { page: 'settings' };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('c/')) return { page: 'chat', id: h.slice(2) };
  if (h === 'settings') return { page: 'settings' };
  return { page: 'new' };
}

const COLLAPSED_KEY = 'relay:sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function navigate(r: Route): void {
  window.location.hash = r.page === 'chat' ? `#/c/${r.id}` : r.page === 'settings' ? '#/settings' : '#/';
}

export function App() {
  const t = useT();
  const [tourOpen, setTourOpen] = useState(() => !onboardingDone());
  const [route, setRoute] = useState<Route>(parseHash);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  /** Goes up when the sidebar should open its search (the button of the collapsed sidebar). */
  const [searchRequest, setSearchRequest] = useState(0);
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
        searchRequest={searchRequest}
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
            <button className="icon-button" onClick={() => navigate({ page: 'new' })} aria-label={t.sidebar.newChat} title={t.sidebar.newChat}>
              <PlusIcon />
            </button>
            <button
              className="icon-button"
              onClick={() => {
                setCollapsed(false);
                setSearchRequest((n) => n + 1);
              }}
              aria-label={t.sidebar.search}
              title={t.sidebar.search}
            >
              <SearchIcon />
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
        {route.page === 'chat' && (
          <ChatView
            key={route.id}
            id={route.id}
            providers={providers}
            catalog={catalog}
            onChanged={refreshConversations}
          />
        )}
        {route.page === 'settings' && (
          <SettingsPage
            providers={providers}
            catalog={catalog}
            refreshProviders={refreshProviderInfo}
            onShowTour={() => setTourOpen(true)}
          />
        )}
      </main>
      {tourOpen && <Onboarding onClose={() => setTourOpen(false)} />}
    </div>
  );
}
