import { useEffect, useState } from 'react';
import { PROVIDER_LABEL, type ConversationGroup, type ConversationSummary, type ProviderStatus } from '../../shared/types';
import { api } from '../api';
import { navigate, type Route } from '../App';
import { useT, type Messages } from '../i18n';
import { FolderPlusIcon, PanelIcon, SearchIcon } from './icons';
import { Logo } from './Logo';
import { SidebarGroups } from './SidebarGroups';
import { SearchBox, SearchResults } from './SidebarSearch';

interface Props {
  route: Route;
  conversations: ConversationSummary[];
  groups: ConversationGroup[];
  /** When the user last saw each conversation (its updatedAt then). */
  seen: Record<string, number>;
  providers: ProviderStatus[];
  onDeleted: (id: string) => void;
  /** Groups or conversations changed: load them again. */
  onChanged: () => void;
  /** Hide the sidebar (wide screens). */
  onCollapse: () => void;
  /** Goes up when search should open and take the focus (the button of the collapsed sidebar). */
  searchRequest: number;
}

export function providerState(p?: ProviderStatus): 'ok' | 'warn' | 'off' {
  if (!p || !p.installed) return 'off';
  if (p.auth.loggedIn === false && !p.usingStoredApiKey) return 'warn';
  return 'ok';
}

export function Sidebar({ route, conversations, groups, seen, providers, onDeleted, onChanged, onCollapse, searchRequest }: Props) {
  const t = useT();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  /** Focuses the search field again when search is asked for while it is open. */
  const [searchFocus, setSearchFocus] = useState(0);
  const [creating, setCreating] = useState(false);

  const openSearch = () => {
    setCreating(false);
    setSearching(true);
    setSearchFocus((n) => n + 1);
  };
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };
  useEffect(() => {
    if (searchRequest) openSearch();
  }, [searchRequest]);

  const remove = async (c: ConversationSummary) => {
    if (!confirm(t.sidebar.confirmDelete(c.title))) return;
    try {
      await api.deleteConversation(c.id);
    } catch (e) {
      alert(t.sidebar.deleteFailed((e as Error).message));
      return;
    }
    onDeleted(c.id);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <Logo />
          Harness Relay
          <button className="icon-button collapse-sidebar" onClick={onCollapse} aria-label={t.app.collapseSidebar} title={t.app.collapseSidebar}>
            <PanelIcon />
          </button>
        </div>
        <button className="new-chat" data-tour="new-chat" onClick={() => navigate({ page: 'new' })}>
          <span aria-hidden>＋</span> {t.sidebar.newChat}
        </button>
        {searching ? (
          <SearchBox query={query} onQuery={setQuery} onClose={closeSearch} focusToken={searchFocus} />
        ) : (
          <div className="sidebar-actions">
            <button type="button" className="sidebar-action" onClick={() => setCreating(true)} aria-pressed={creating}>
              <FolderPlusIcon size={16} /> {t.sidebar.newGroup}
            </button>
            <button type="button" className="sidebar-action" onClick={openSearch}>
              <SearchIcon size={16} /> {t.sidebar.search}
            </button>
          </div>
        )}
      </div>

      <nav className="conv-list" aria-label={t.sidebar.conversations}>
        {searching && query.trim() ? (
          <SearchResults query={query} route={route} groups={groups} />
        ) : (
          <SidebarGroups
            route={route}
            conversations={conversations}
            groups={groups}
            seen={seen}
            creating={creating}
            onCreatingDone={() => setCreating(false)}
            onChanged={onChanged}
            onDelete={remove}
          />
        )}
      </nav>

      <div className="sidebar-bottom" data-tour="settings">
        <div className="provider-health">
          {(['claude', 'codex', 'grok'] as const).map((id) => {
            const p = providers.find((x) => x.provider === id);
            const s = providerState(p);
            return (
              <span key={id} className={`health ${s}`} title={healthTitle(p, t)}>
                <i />
                {PROVIDER_LABEL[id]}
              </span>
            );
          })}
        </div>
        <a href="#/settings" className={`settings-link ${route.page === 'settings' ? 'active' : ''}`}>
          ⚙ {t.sidebar.settings}
        </a>
      </div>
    </aside>
  );
}

function healthTitle(p: ProviderStatus | undefined, t: Messages): string {
  const h = t.sidebar.health;
  if (!p) return h.checking;
  if (!p.installed) return h.notInstalled;
  if (p.usingStoredApiKey) return h.apiKey;
  if (p.auth.loggedIn === false) return h.notLoggedIn;
  if (p.auth.loggedIn) return h.loggedIn(p.auth.account);
  return h.unknown;
}
