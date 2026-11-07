import { PROVIDER_LABEL, type ConversationSummary, type ProviderStatus } from '../../shared/types';
import { api } from '../api';
import { navigate, type Route } from '../App';
import { useT, type Messages } from '../i18n';
import { convStatus, relativeTime } from '../util';
import { PanelIcon } from './icons';
import { MemberDots } from './MemberDots';
import { Logo } from './Logo';

interface Props {
  route: Route;
  conversations: ConversationSummary[];
  /** When the user last saw each conversation (its updatedAt then). */
  seen: Record<string, number>;
  providers: ProviderStatus[];
  onDeleted: (id: string) => void;
  /** Hide the sidebar (wide screens). */
  onCollapse: () => void;
}

export function providerState(p?: ProviderStatus): 'ok' | 'warn' | 'off' {
  if (!p || !p.installed) return 'off';
  if (p.auth.loggedIn === false && !p.usingStoredApiKey) return 'warn';
  return 'ok';
}

export function Sidebar({ route, conversations, seen, providers, onDeleted, onCollapse }: Props) {
  const t = useT();
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
      </div>

      <nav className="conv-list" aria-label={t.sidebar.conversations}>
        {conversations.length === 0 && <p className="muted small pad">{t.sidebar.empty}</p>}
        {conversations.map((c) => {
          const active = route.page === 'chat' && route.id === c.id;
          const status = convStatus(c, seen[c.id]);
          return (
            <div key={c.id} className={`conv-item ${active ? 'active' : ''}`}>
              <a href={`#/c/${c.id}`} className="conv-link">
                <span className="conv-title">
                  {status && <span className={`status-dot ${status}`} aria-hidden />}
                  {c.title}
                </span>
                <span className="conv-meta">
                  <MemberDots agents={c.agents} className="conv-dots" />
                  {status && <span className={`conv-status ${status}`}>{t.sidebar.status[status]}</span>}
                  {relativeTime(c.updatedAt, t)}
                </span>
              </a>
              <button
                className="icon-button conv-delete"
                aria-label={t.sidebar.deleteConversation}
                onClick={() => remove(c)}
              >
                ×
              </button>
            </div>
          );
        })}
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
