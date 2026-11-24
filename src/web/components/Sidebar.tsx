import { useState, type ReactNode } from 'react';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  accountUsable,
  isOpenProvider,
  type ConversationGroup,
  type ConversationSummary,
  type InboxSummary,
  type ProviderStatus,
} from '../../shared/types';
import { api } from '../api';
import { navigate, type Route } from '../App';
import { hashFor, settingsHref } from '../route';
import { useT, type Messages } from '../i18n';
import { branchCount, readHealthNames, readyCount, writeHealthNames } from '../sidebar';
import { Deferred, lazyPart } from './Deferred';
import { InboxButton } from './InboxButton';
import { ChevronIcon, FolderPlusIcon, PanelIcon, PlusIcon, ReportIcon, SearchIcon, SettingsIcon, StarIcon, ZapIcon } from './icons';
import { Logo } from './Logo';
import { NewGroupBox, SidebarGroups } from './SidebarGroups';
import { SearchBox, SearchResults } from './SidebarSearch';

// Loaded when first opened, not with the page.
const ReportDialog = lazyPart(() => import('./ReportDialog').then((m) => m.ReportDialog));
const StarDialog = lazyPart(() => import('./StarDialog').then((m) => m.StarDialog));
const GroupOrganizer = lazyPart(() => import('./GroupOrganizer').then((m) => m.GroupOrganizer));

interface Props {
  phoneLink: ReactNode;
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
  /** The notification inbox's summary: the bell's unread count. */
  inbox: InboxSummary;
  /** The bell was clicked: open the notification inbox. */
  onOpenInbox: () => void;
  /** The logo and name were clicked: on a phone the sidebar closes, also when the home page is open already. */
  onHome: () => void;
}

export function providerState(p?: ProviderStatus): 'ok' | 'warn' | 'off' {
  if (!p || !p.installed) return 'off';
  if (p.auth.loggedIn === false && !p.usingStoredApiKey) return 'warn';
  return 'ok';
}

export function Sidebar({
  phoneLink,
  route,
  conversations,
  groups,
  seen,
  providers,
  onDeleted,
  onChanged,
  onCollapse,
  inbox,
  onOpenInbox,
  onHome,
}: Props) {
  const t = useT();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  /** Focuses the search field again when search is asked for while it is open. */
  const [searchFocus, setSearchFocus] = useState(0);
  const [creating, setCreating] = useState(false);
  /** The lead agent's suggestions for the groups, in their dialog. */
  const [organizing, setOrganizing] = useState(false);
  /** The CLIs' names beside their dots at the sidebar's foot (else the dots alone, on one line). */
  const [healthNames, setHealthNames] = useState(readHealthNames);
  const [reporting, setReporting] = useState(false);
  const [starring, setStarring] = useState(false);

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
          <a
            className="brand-home"
            href={hashFor({ page: 'home' })}
            onClick={onHome}
            aria-current={route.page === 'home' ? 'page' : undefined}
          >
            <Logo />
            Harness Relay
          </a>
          {/* The notification inbox, left of the collapse button (alone at the row's end on a phone). */}
          <InboxButton unread={inbox.unread} onOpen={onOpenInbox} />
          <button
            className="icon-button collapse-sidebar"
            onClick={onCollapse}
            aria-label={t.app.collapseSidebar}
            title={t.app.collapseSidebar}
          >
            <PanelIcon />
          </button>
        </div>
        <div className="new-row">
          {/* Two halves. */}
          <button className="new-chat" data-tour="new-chat" onClick={() => navigate({ page: 'new' })}>
            <PlusIcon size={15} />
            <span className="new-label">{t.sidebar.newChat}</span>
          </button>
          {/* Its label is short where "New automation" does not fit half the row (English); its name says it whole,
              and holds the label's words. */}
          <button
            className="new-chat new-schedule"
            data-tour="new-schedule"
            onClick={() => navigate({ page: 'schedule' })}
            aria-label={t.sidebar.newSchedule}
            title={t.sidebar.newSchedule}
          >
            <ZapIcon size={15} />
            <span className="new-label">{t.sidebar.newScheduleLabel}</span>
          </button>
        </div>
        {searching ? (
          <SearchBox query={query} onQuery={setQuery} onClose={closeSearch} focusToken={searchFocus} />
        ) : creating ? (
          <NewGroupBox onClose={() => setCreating(false)} onCreated={onChanged} />
        ) : (
          <div className="sidebar-actions" data-tour="organize">
            <button type="button" className="sidebar-action" onClick={openSearch}>
              <SearchIcon size={16} /> {t.sidebar.search}
            </button>
            {/* An icon only, so Search keeps the row. */}
            <button
              type="button"
              className="sidebar-action new-group"
              onClick={() => setCreating(true)}
              aria-label={t.sidebar.newGroup}
              title={t.sidebar.newGroup}
            >
              <FolderPlusIcon size={16} />
            </button>
            {/* The lead agent organizes the conversations into groups, once there is something to organize. */}
            {conversations.length > 0 && (
              <button
                type="button"
                className="sidebar-action organize-groups"
                onClick={() => setOrganizing(true)}
                aria-label={t.groupsDraft.open}
                title={t.groupsDraft.open}
              >
                <Logo size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      <nav className="conv-list" aria-label={t.sidebar.conversations}>
        {searching && query.trim() ? (
          <SearchResults query={query} route={route} groups={groups} />
        ) : (
          <SidebarGroups route={route} conversations={conversations} groups={groups} seen={seen} onChanged={onChanged} onDelete={remove} />
        )}
      </nav>

      <div className="sidebar-bottom" data-tour="settings">
        {(() => {
          // The open agents only once installed (or found too old): most people have only some of them.
          const shown = PROVIDERS.filter(
            (id) => !isOpenProvider(id) || providers.some((x) => x.provider === id && (x.installed || x.tooOld)),
          ).map((id) => {
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
        {phoneLink}
        {/* Star on GitHub and Report a problem: icons only, at the row's end, so Settings keeps the row. */}
        <div className="sidebar-bottom-row">
          <a href="#/settings" className={`settings-link ${route.page === 'settings' ? 'active' : ''}`}>
            <SettingsIcon size={18} />
            <span>{t.sidebar.settings}</span>
          </a>
          <button
            type="button"
            className="icon-button star-button"
            onClick={() => setStarring(true)}
            aria-label={t.sidebar.star}
            title={t.sidebar.star}
          >
            <StarIcon size={18} />
          </button>
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
      {reporting && (
        <Deferred onClose={() => setReporting(false)}>
          <ReportDialog providers={providers} onClose={() => setReporting(false)} />
        </Deferred>
      )}
      {starring && (
        <Deferred onClose={() => setStarring(false)}>
          <StarDialog onClose={() => setStarring(false)} />
        </Deferred>
      )}
      {organizing && (
        <Deferred onClose={() => setOrganizing(false)}>
          <GroupOrganizer groups={groups} onApplied={onChanged} onClose={() => setOrganizing(false)} />
        </Deferred>
      )}
    </aside>
  );
}

function healthTitle(p: ProviderStatus | undefined, t: Messages): string {
  const h = t.sidebar.health;
  if (!p) return h.checking;
  if (p.tooOld) return h.tooOld;
  if (!p.installed) return h.notInstalled;
  if (isOpenProvider(p.provider)) return p.auth.loggedIn ? h.openReady : h.openNotReady;
  // The dot is the default account's; with more accounts, how many of them agents can run as.
  const more = p.accounts.length > 1 ? h.accounts(p.accounts.filter(accountUsable).length, p.accounts.length) : '';
  if (p.usingStoredApiKey) return h.apiKey + more;
  if (p.auth.loggedIn === false) return h.notLoggedIn + more;
  if (p.auth.loggedIn) return h.loggedIn(p.auth.account) + more;
  return h.unknown + more;
}
