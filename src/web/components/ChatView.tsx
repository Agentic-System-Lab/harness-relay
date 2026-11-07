import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  PROVIDER_LABEL,
  type ChatMessage,
  type AgentConfig,
  type Conversation,
  type ProviderModels,
  type ProviderStatus,
  type ServerEvent,
} from '../../shared/types';
import { api } from '../api';
import { conversationMarkdown } from '../copy';
import { MODE_INFO, PERMISSION_INFO, PROVIDER_COLOR, effortLabel, initials } from '../util';
import { DiffView, type ApplyState } from './ChangesCard';
import { Composer } from './Composer';
import { CopyButton } from './CopyButton';
import { MessageItem } from './MessageItem';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';

interface State {
  conv: Conversation | null;
  running: boolean;
  active: string[];
}

function upsert(messages: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((x) => x.id === m.id);
  if (i < 0) return [...messages, m];
  const next = [...messages];
  next[i] = m;
  return next;
}

function reducer(s: State, e: ServerEvent): State {
  if (e.type === 'snapshot') return { conv: e.conversation, running: e.running, active: e.activeAgentIds };
  if (e.type === 'status') return { ...s, running: e.running, active: e.activeAgentIds };
  if (!s.conv) return s;
  switch (e.type) {
    case 'message':
      return { ...s, conv: { ...s.conv, messages: upsert(s.conv.messages, e.message) } };
    case 'delta': {
      const msg = s.conv.messages.find((m) => m.id === e.messageId);
      if (!msg) return s;
      const parts = [...msg.parts];
      const cur = parts[e.partIndex];
      parts[e.partIndex] = cur?.type === 'text' ? { ...cur, text: cur.text + e.text } : { type: 'text', text: e.text };
      return { ...s, conv: { ...s.conv, messages: upsert(s.conv.messages, { ...msg, parts }) } };
    }
    case 'conversation':
      return {
        ...s,
        conv: { ...s.conv, title: e.title, agents: e.agents, settings: e.settings, worktrees: e.worktrees },
      };
  }
  return s;
}

/** "gpt-6.1-sol · 高（high）" — only the parts the agent overrides. */
function modelSummary(a: AgentConfig): string {
  return [a.model, a.effort && effortLabel(a.effort)].filter(Boolean).join(' · ');
}

interface Props {
  id: string;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onChanged: () => void;
}

export function ChatView({ id, providers, catalog, onChanged }: Props) {
  const [state, dispatch] = useReducer(reducer, { conv: null, running: false, active: [] });
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [teamOpen, setTeamOpen] = useState(false);
  const [diff, setDiff] = useState<{ title: string; load: () => Promise<string> } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    const es = new EventSource(`/api/conversations/${id}/events`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as ServerEvent;
      dispatch(e);
      if (e.type === 'status' || e.type === 'conversation') onChangedRef.current();
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // 404: the conversation is gone; stop retrying.
      api.getConversation(id).catch((err: Error) => {
        setError(err.message);
        es.close();
      });
    };
    return () => es.close();
  }, [id]);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const convId = state.conv?.id;
  const onDiff = useCallback(
    (msg: ChatMessage, scope: 'turn' | 'agent') => {
      if (!convId) return;
      const name = msg.agentName ?? 'agent';
      if (scope === 'turn') setDiff({ title: `@${name} 這回合的修改`, load: () => api.messageDiff(convId, msg.id) });
      else if (msg.author.kind === 'agent') {
        const agentId = msg.author.agentId;
        setDiff({ title: `@${name} 的完整結果（相對於起始快照）`, load: () => api.agentDiff(convId, agentId) });
      }
    },
    [convId],
  );
  const onApply = useCallback(
    async (agentId: string) => {
      if (!convId) return;
      try {
        await api.applyAgent(convId, agentId);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [convId],
  );

  // Read through a ref so the callbacks stay stable while messages stream (MessageItem is memoised).
  const convRef = useRef(state.conv);
  convRef.current = state.conv;

  const onResend = useCallback(
    async (messageId: string, text: string) => {
      const c = convRef.current;
      if (!c) return false;
      const index = c.messages.findIndex((m) => m.id === messageId);
      const later = c.messages.slice(index + 1);
      const changed = later.filter((m) => m.changes && m.changes.files.length > 0).length;
      if (
        changed > 0 &&
        !confirm(
          `這則之後有 ${changed} 則回覆修改過檔案。重新傳送會刪除之後的對話，但那些檔案修改不會還原。\n\n確定要重新傳送嗎？`,
        )
      ) {
        return false;
      }
      try {
        setError('');
        stick.current = true;
        await api.resend(c.id, messageId, text);
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [],
  );

  // Only each agent's latest worktree result can be applied.
  const applyStates = useMemo(() => {
    const out = new Map<string, ApplyState>();
    if (!state.conv) return out;
    const seen = new Set<string>();
    for (let i = state.conv.messages.length - 1; i >= 0; i--) {
      const m: ChatMessage = state.conv.messages[i]!;
      if (m.author.kind !== 'agent' || !m.changes?.isolated || m.status === 'streaming') continue;
      const agentId = m.author.agentId;
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const wt = state.conv.worktrees?.[agentId];
      if (wt && wt.branch === m.changes.branch) out.set(m.id, wt.needsReset ? 'stale' : 'available');
    }
    return out;
  }, [state.conv]);

  const { conv, running, active } = state;
  if (!conv) return <div className="page-center muted">{error || '載入中…'}</div>;

  const mentionNames = conv.agents.map((a) => a.name);
  const hasUserMessage = conv.messages.some((m) => m.author.kind === 'user');

  const send = async (text: string) => {
    setError('');
    try {
      stick.current = true;
      await api.send(conv.id, text);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const rename = async () => {
    const title = prompt('對話標題', conv.title);
    if (!title?.trim()) return;
    await api.updateConversation(conv.id, { title }).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="chat-title" onClick={rename} title="重新命名">
          {conv.title}
        </button>
        <div className="team-chips">
          {conv.agents.map((a) => (
            <span
              key={a.id}
              className={`team-chip ${active.includes(a.id) ? 'speaking' : ''}`}
              style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}
              title={`${PROVIDER_LABEL[a.provider]}${modelSummary(a) ? ` · ${modelSummary(a)}` : ''}\n${a.role}`}
            >
              <span className="avatar sm">{initials(a.name)}</span>@{a.name}
            </span>
          ))}
        </div>
        <span className="badge" title={MODE_INFO[conv.settings.mode].hint}>
          {MODE_INFO[conv.settings.mode].label}
          {conv.settings.mode === 'relay' ? ` · ${conv.settings.maxHops} 棒` : ` · ${conv.settings.rounds} 輪`}
        </span>
        <span className={`badge ${conv.settings.permission === 'full' ? 'danger' : ''}`}>
          {PERMISSION_INFO[conv.settings.permission].label}
        </span>
        <CopyButton
          className="ghost small-button"
          label="複製對話"
          title="把整段對話複製成 Markdown"
          disabled={conv.messages.length === 0}
          text={() => (convRef.current ? conversationMarkdown(convRef.current) : '')}
        />
        <button className="ghost small-button" onClick={() => setTeamOpen(true)}>
          團隊設定
        </button>
      </header>

      {!connected && !error && <div className="banner">連線中斷，重新連線中…</div>}

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {conv.messages.length === 0 && <TeamIntro conv={conv} />}
          {conv.messages.map((m) => (
            <MessageItem
              key={m.id}
              msg={m}
              conv={conv}
              mentionNames={mentionNames}
              applyState={running ? undefined : applyStates.get(m.id)}
              running={running}
              onDiff={onDiff}
              onApply={onApply}
              onResend={onResend}
            />
          ))}
        </div>
      </div>

      <div className="composer-dock">
        {error && (
          <div className="error-line" role="alert">
            {error}
            <button className="icon-button" onClick={() => setError('')} aria-label="關閉">
              ×
            </button>
          </div>
        )}
        <Composer
          agents={conv.agents}
          running={running}
          canContinue={hasUserMessage}
          placeholder={
            conv.settings.mode === 'relay'
              ? `傳訊息給團隊（預設由 @${conv.agents[0]?.name} 先接）`
              : '傳訊息給團隊…'
          }
          onSend={send}
          onStop={() => api.stop(conv.id).catch((e: Error) => setError(e.message))}
          onContinue={() => void send('')}
        />
        <p className="cwd-line muted small" title={conv.settings.cwd}>
          📁 {conv.settings.cwd}
        </p>
      </div>

      {diff && <DiffModal title={diff.title} load={diff.load} onClose={() => setDiff(null)} />}

      {teamOpen && (
        <TeamDrawer
          conv={conv}
          providers={providers}
          catalog={catalog}
          running={running}
          onClose={() => setTeamOpen(false)}
          onError={setError}
        />
      )}
    </div>
  );
}

function DiffModal({ title, load, onClose }: { title: string; load: () => Promise<string>; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load().then(setText, (e: Error) => setError(e.message));
  }, [load]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        {error ? (
          <p className="error-line">{error}</p>
        ) : text === null ? (
          <p className="muted">載入中…</p>
        ) : text.trim() ? (
          <DiffView text={text} />
        ) : (
          <p className="muted">沒有差異。</p>
        )}
      </div>
    </div>
  );
}

function TeamIntro({ conv }: { conv: Conversation }) {
  return (
    <div className="team-intro">
      <h2>團隊已就位</h2>
      <p className="muted">{MODE_INFO[conv.settings.mode].hint}</p>
      <div className="intro-grid">
        {conv.agents.map((a, i) => (
          <div key={a.id} className="intro-card" style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}>
            <div className="intro-head">
              <span className="avatar">{initials(a.name)}</span>
              <div>
                <strong>@{a.name}</strong>
                <div className="muted small">
                  {PROVIDER_LABEL[a.provider]}
                  {modelSummary(a) ? ` · ${modelSummary(a)}` : ''}
                  {conv.settings.mode === 'relay' && i === 0 ? ' · 隊長' : ''}
                </div>
              </div>
            </div>
            <p className="intro-role">{a.role || '（未設定角色）'}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamDrawer({
  conv,
  providers,
  catalog,
  running,
  onClose,
  onError,
}: {
  conv: Conversation;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  running: boolean;
  onClose: () => void;
  onError: (s: string) => void;
}) {
  const [team, setTeam] = useState<Team>({ agents: conv.agents, settings: conv.settings });
  const [saving, setSaving] = useState(false);
  const problems = teamProblems(team);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateConversation(conv.id, { agents: team.agents, settings: team.settings });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="團隊設定">
        <header className="drawer-head">
          <h2>團隊設定</h2>
          <button className="icon-button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <p className="muted small">
          角色修改會在下一個回合生效。更換成員的 coding agent 會讓他從頭讀一次對話紀錄。
        </p>
        <TeamEditor value={team} onChange={setTeam} providers={providers} catalog={catalog} />
        <footer className="drawer-foot">
          {problems[0] && <span className="error-line">{problems[0]}</span>}
          {running && <span className="muted small">團隊回覆中，停止後才能儲存</span>}
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={saving || running || problems.length > 0} onClick={save}>
            儲存
          </button>
        </footer>
      </aside>
    </div>
  );
}
