import { useCallback, useEffect, useState } from 'react';
import type { ConversationSummary, ProviderModels, ProviderStatus } from '../shared/types';
import { api } from './api';
import { ChatView } from './components/ChatView';
import { NewChat } from './components/NewChat';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';

export type Route = { page: 'new' } | { page: 'chat'; id: string } | { page: 'settings' };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('c/')) return { page: 'chat', id: h.slice(2) };
  if (h === 'settings') return { page: 'settings' };
  return { page: 'new' };
}

export function navigate(r: Route): void {
  window.location.hash = r.page === 'chat' ? `#/c/${r.id}` : r.page === 'settings' ? '#/settings' : '#/';
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [catalog, setCatalog] = useState<ProviderModels[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setSidebarOpen(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshConversations = useCallback(() => {
    api.listConversations().then(setConversations).catch(console.error);
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

  // Keep "running" badges in the sidebar fresh while something is running.
  useEffect(() => {
    if (!conversations.some((c) => c.running)) return;
    const t = setInterval(refreshConversations, 3000);
    return () => clearInterval(t);
  }, [conversations, refreshConversations]);

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <Sidebar
        route={route}
        conversations={conversations}
        providers={providers}
        onDeleted={(id) => {
          refreshConversations();
          if (route.page === 'chat' && route.id === id) navigate({ page: 'new' });
        }}
      />
      <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        <button className="menu-button" aria-label="開啟側邊欄" onClick={() => setSidebarOpen(true)}>
          ☰
        </button>
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
          />
        )}
      </main>
    </div>
  );
}
