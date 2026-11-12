import { useState } from 'react';
import { PROVIDERS, PROVIDER_LABEL, accountUsable, isOpenProvider, type ConversationGroup, type ConversationSummary, type ProviderStatus } from '../../shared/types';
import { api } from '../api';
import { navigate, type Route } from '../App';
import { hashFor, settingsHref } from '../route';
import { useT, type Messages } from '../i18n';
import { branchCount, readHealthNames, readyCount, writeHealthNames } from '../sidebar';
import { CalendarPlusIcon, ChevronIcon, FolderPlusIcon, PanelIcon, ReportIcon, SearchIcon } from './icons';
import { Logo } from './Logo';
import { ReportDialog } from './ReportDialog';
import { NewGroupBox, SidebarGroups } from './SidebarGroups';
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
  /** The logo and name were clicked: on a phone the sidebar closes, also when the home page is open already. */
  onHome: () => void;
}

export function providerState(p?: ProviderStatus): 'ok' | 'warn' | 'off' {
  if (!p || !p.installed) return 'off';
  if (p.auth.loggedIn === false && !p.usingStoredApiKey) return 'warn';
  return 'ok';
}

export function Sidebar({ route, conversations, groups, seen, providers, onDeleted, onChanged, onCollapse, onHome }: Props) {
  const t = useT();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  /** Focuses the search field again when search is asked for while it is open. */
  const [searchFocus, setSearchFocus] = useState(0);
  const [creating, setCreating] = useState(false);
  /** The CLIs' names beside their dots at the sidebar's foot (else the dots alone, on one line). */
  const [healthNames, setHealthNames] = useState(readHealthNames);
  const [reporting, setReporting] = useState(false);

  const openSearch = () => {
    setCreating(false);
    setSearching(true);
    setSearchFocus((n) => n + 1);
  };
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  const remove = async (c: ConversationSummary) => {
    // The conversations branched from it stay, under its place in the sidebar.
    const branches = branchCount(conversations, c.id);
    if (!confirm(branches ? t.sidebar.confirmDeleteBranched(c.title, branches) : t.sidebar.confirmDelete(c.title))) return;
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
          {/* The logo and the name lead back to the home page. */}
          <a className="brand-home" href={hashFor({ page: 'home' })} onClick={onHome} aria-current={route.page === 'home' ? 'page' : undefined}>
            <Logo />
            Harness Relay
          </a>
          <button className="icon-button collapse-sidebar" onClick={onCollapse} aria-label={t.app.collapseSidebar} title={t.app.collapseSidebar}>
            <PanelIcon />
          </button>
        </div>
        <div className="new-row">
          <button className="new-chat" data-tour="new-chat" onClick={() => navigate({ page: 'new' })}>
            <span aria-hidden>＋</span> {t.sidebar.newChat}
          </button>
          {/* An icon only, so New chat keeps the row: a calendar with a plus, unlike Search's magnifier. */}
          <button
            className="new-chat new-schedule"
            data-tour="new-schedule"
            onClick={() => navigate({ page: 'schedule' })}
            aria-label={t.sidebar.newSchedule}
            title={t.sidebar.newSchedule}
          >
            <CalendarPlusIcon size={18} />
          </button>
        </div>
        {searching ? (
          <SearchBox query={query} onQuery={setQuery} onClose={closeSearch} focusToken={searchFocus} />
        ) : creating ? (
          <NewGroupBox onClose={() => setCreating(false)} onCreated={onChanged} />
        ) : (
          <div className="sidebar-actions" data-tour="organize">
            <button type="button" className="sidebar-action" onClick={() => setCreating(true)}>
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
            onChanged={onChanged}
            onDelete={remove}
          />
        )}
      </nav>

      <div className="sidebar-bottom" data-tour="settings">
        {(() => {
          // The open agents only once installed: most people have only some of them.
          const shown = PROVIDERS.filter((id) => !isOpenProvider(id) || providers.some((x) => x.provider === id && x.installed)).map((id) => {
            const p = providers.find((x) => x.provider === id);
            return { id, p, state: providerState(p) };
          });
          const { ready, total } = readyCount(shown.map((x) => x.state));
          const toggle = () => {
            writeHealthNames(!healthNames);
            setHealthNames(!healthNames);
          };
          return (
            // Dots alone on one line by default (each still names its CLI on hover and to a screen
            // reader), with how many are ready; the names beside them when asked for.
            <div className={`provider-health ${healthNames ? '' : 'compact'}`}>
              {shown.map(({ id, p, state }) => (
                <a key={id} href={settingsHref(id)} className={`health ${state}`} title={`${PROVIDER_LABEL[id]} · ${healthTitle(p, t)}`}>
                  <i aria-hidden />
                  <span className="health-name">{PROVIDER_LABEL[id]}</span>
                </a>
              ))}
              <button
                type="button"
                className="health-toggle"
                onClick={toggle}
                aria-expanded={healthNames}
                title={healthNames ? t.sidebar.healthHideNames : t.sidebar.healthShowNames}
              >
                {!healthNames && <span>{t.sidebar.healthReady(ready, total)}</span>}
                <ChevronIcon size={13} />
              </button>
            </div>
          );
        })()}
        {/* Report a problem: an icon only, at the row's end, so Settings keeps the row. */}
        <div className="sidebar-bottom-row">
          <a href="#/settings" className={`settings-link ${route.page === 'settings' ? 'active' : ''}`}>
            ⚙ {t.sidebar.settings}
          </a>
          <button
            type="button"
            className="icon-button report-button"
            onClick={() => setReporting(true)}
            aria-label={t.sidebar.report}
            title={t.sidebar.report}
          >
            <ReportIcon size={18} />
          </button>
        </div>
      </div>
      {reporting && <ReportDialog providers={providers} onClose={() => setReporting(false)} />}
    </aside>
  );
}

function healthTitle(p: ProviderStatus | undefined, t: Messages): string {
  const h = t.sidebar.health;
  if (!p) return h.checking;
  if (!p.installed) return h.notInstalled;
  if (isOpenProvider(p.provider)) return p.auth.loggedIn ? h.openReady : h.openNotReady;
  // The dot is the default account's; with more accounts, how many of them agents can run as.
  const more = p.accounts.length > 1 ? h.accounts(p.accounts.filter(accountUsable).length, p.accounts.length) : '';
  if (p.usingStoredApiKey) return h.apiKey + more;
  if (p.auth.loggedIn === false) return h.notLoggedIn + more;
  if (p.auth.loggedIn) return h.loggedIn(p.auth.account) + more;
  return h.unknown + more;
}
