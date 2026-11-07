import { PROVIDER_LABEL, type ConversationSummary, type ProviderStatus } from '../../shared/types';
import { api } from '../api';
import { navigate, type Route } from '../App';
import { PROVIDER_COLOR, relativeTime } from '../util';

interface Props {
  route: Route;
  conversations: ConversationSummary[];
  providers: ProviderStatus[];
  onDeleted: (id: string) => void;
}

export function providerState(p?: ProviderStatus): 'ok' | 'warn' | 'off' {
  if (!p || !p.installed) return 'off';
  if (p.auth.loggedIn === false && !p.usingStoredApiKey) return 'warn';
  return 'ok';
}

export function Sidebar({ route, conversations, providers, onDeleted }: Props) {
  const remove = async (c: ConversationSummary) => {
    if (!confirm(`刪除對話「${c.title}」？`)) return;
    await api.deleteConversation(c.id);
    onDeleted(c.id);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-dots">
            <i style={{ background: 'var(--claude)' }} />
            <i style={{ background: 'var(--codex)' }} />
            <i style={{ background: 'var(--grok)' }} />
          </span>
          Harness Relay
        </div>
        <button className="new-chat" onClick={() => navigate({ page: 'new' })}>
          <span aria-hidden>＋</span> 新對話
        </button>
      </div>

      <nav className="conv-list" aria-label="對話列表">
        {conversations.length === 0 && <p className="muted small pad">還沒有對話</p>}
        {conversations.map((c) => {
          const active = route.page === 'chat' && route.id === c.id;
          return (
            <div key={c.id} className={`conv-item ${active ? 'active' : ''}`}>
              <a href={`#/c/${c.id}`} className="conv-link">
                <span className="conv-title">
                  {c.running && <span className="pulse" title="回覆中" />}
                  {c.title}
                </span>
                <span className="conv-meta">
                  <span className="conv-dots">
                    {c.agents.map((a, i) => (
                      <i key={i} style={{ background: PROVIDER_COLOR[a.provider] }} title={`@${a.name}`} />
                    ))}
                  </span>
                  {relativeTime(c.updatedAt)}
                </span>
              </a>
              <button className="icon-button conv-delete" aria-label="刪除對話" onClick={() => remove(c)}>
                ×
              </button>
            </div>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="provider-health">
          {(['claude', 'codex', 'grok'] as const).map((id) => {
            const p = providers.find((x) => x.provider === id);
            const s = providerState(p);
            return (
              <span key={id} className={`health ${s}`} title={healthTitle(p)}>
                <i />
                {PROVIDER_LABEL[id]}
              </span>
            );
          })}
        </div>
        <a href="#/settings" className={`settings-link ${route.page === 'settings' ? 'active' : ''}`}>
          ⚙ 設定與登入
        </a>
      </div>
    </aside>
  );
}

function healthTitle(p?: ProviderStatus): string {
  if (!p) return '檢查中…';
  if (!p.installed) return '未安裝';
  if (p.usingStoredApiKey) return '使用 API key';
  if (p.auth.loggedIn === false) return '未登入';
  if (p.auth.loggedIn) return `已登入${p.auth.account ? `：${p.auth.account}` : ''}`;
  return '狀態未知';
}
