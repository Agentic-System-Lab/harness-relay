import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  PROVIDER_LABEL,
  type ApprovalAnswer,
  type ChatMessage,
  type Conversation,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
  type ServerEvent,
} from '../../shared/types';
import { api, type AttachmentUpload } from '../api';
import { conversationMarkdown } from '../copy';
import { useT } from '../i18n';
import { PROVIDER_COLOR, initials, leadLabel, modelSummary } from '../util';
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
      parts[e.partIndex] =
        cur?.type === 'text' || cur?.type === 'thinking' ? { ...cur, text: cur.text + e.text } : { type: 'text', text: e.text };
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

interface Props {
  id: string;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onChanged: () => void;
}

export function ChatView({ id, providers, catalog, onChanged }: Props) {
  const t = useT();
  const [state, dispatch] = useReducer(reducer, { conv: null, running: false, active: [] });
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [teamOpen, setTeamOpen] = useState(false);
  const [diff, setDiff] = useState<{ title: string; load: () => Promise<string> } | null>(null);
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  // The team row fades out on the right while more chips are hidden there.
  const [moreChips, setMoreChips] = useState(false);
  useEffect(() => {
    const row = chipsRef.current;
    if (!row) return;
    const check = () => setMoreChips(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    row.addEventListener('scroll', check, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', check);
    };
  }, [state.conv?.agents.length]);

  // Keep whoever is speaking visible in the team row (it scrolls when the team is large).
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector<HTMLElement>('.team-chip.speaking');
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
  }, [state.active]);
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

  // Who designs the team, for auto-team conversations that have not started yet.
  const autoTeam = Boolean(state.conv?.settings.autoTeam);
  useEffect(() => {
    if (autoTeam) api.getSettings().then((s) => setLead(s.lead), () => {});
  }, [autoTeam]);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // Read through a ref so the callbacks stay stable while messages stream (MessageItem is memoised).
  const convRef = useRef(state.conv);
  convRef.current = state.conv;
  const tRef = useRef(t);
  tRef.current = t;

  const onDiff = useCallback((msg: ChatMessage, scope: 'turn' | 'agent') => {
    const c = convRef.current;
    if (!c) return;
    const name = msg.agentName ?? 'agent';
    if (scope === 'turn') setDiff({ title: tRef.current.chat.turnDiffTitle(name), load: () => api.messageDiff(c.id, msg.id) });
    else if (msg.author.kind === 'agent') {
      const agentId = msg.author.agentId;
      setDiff({ title: tRef.current.chat.agentDiffTitle(name), load: () => api.agentDiff(c.id, agentId) });
    }
  }, []);

  const onApply = useCallback(async (agentId: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      await api.applyAgent(c.id, agentId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onResend = useCallback(async (messageId: string, text: string) => {
    const c = convRef.current;
    if (!c) return false;
    const index = c.messages.findIndex((m) => m.id === messageId);
    const changed = c.messages.slice(index + 1).filter((m) => m.changes && m.changes.files.length > 0).length;
    if (changed > 0 && !confirm(tRef.current.chat.resendConfirm(changed))) return false;
    try {
      setError('');
      stick.current = true;
      await api.resend(c.id, messageId, text);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  const onSavePlan = useCallback(async (messageId: string, name: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      await api.savePlan(c.id, messageId, name);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onAdjustTeam = useCallback(() => setTeamOpen(true), []);

  const onRetry = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c) return;
    const later = c.messages.slice(c.messages.findIndex((m) => m.id === messageId) + 1);
    const changed = later.filter((m) => m.changes && m.changes.files.length > 0).length;
    if (later.length > 0 && !confirm(tRef.current.chat.retryConfirm(later.length, changed))) return;
    try {
      setError('');
      stick.current = true;
      await api.retry(c.id, messageId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onApproval = useCallback(async (approvalId: string, answer: ApprovalAnswer) => {
    const c = convRef.current;
    if (!c) return;
    try {
      await api.answerApproval(c.id, approvalId, answer);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

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
  if (!conv) return <div className="page-center muted">{error || t.common.loading}</div>;

  const mentionNames = conv.agents.map((a) => a.name);
  // Approval requests still waiting for an answer (only while the agent's turn is running).
  const pending = conv.messages.flatMap((m) =>
    m.status === 'streaming'
      ? m.parts
          .filter((p) => p.type === 'approval' && p.status === 'pending')
          .map((p) => ({ id: (p as { id: string }).id, agent: m.agentName ?? 'agent' }))
      : [],
  );
  const hasUserMessage = conv.messages.some((m) => m.author.kind === 'user');
  const waitingForTeam = autoTeam && conv.agents.length === 0;
  const leadText = leadLabel(lead ?? { provider: 'claude' });

  const send = async (text: string, attachments: AttachmentUpload[]) => {
    setError('');
    try {
      stick.current = true;
      await api.send(conv.id, text, attachments);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const rename = async () => {
    const title = prompt(t.chat.renamePrompt, conv.title);
    if (!title?.trim()) return;
    await api.updateConversation(conv.id, { title }).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-head-main">
          <button className="chat-title" onClick={rename} title={t.chat.rename}>
            {conv.title}
          </button>
          {/* One row that scrolls sideways when the team is large (the wheel scrolls it too). */}
          <div
            className={`team-chips ${moreChips ? 'more' : ''}`}
            ref={chipsRef}
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {waitingForTeam && <span className="team-chip auto-chip">✦ {t.chat.autoTeam}</span>}
            {conv.agents.map((a) => (
              <span
                key={a.id}
                className={`team-chip ${active.includes(a.id) ? 'speaking' : ''}`}
                style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}
                title={`${PROVIDER_LABEL[a.provider]}${modelSummary(a, t) ? ` · ${modelSummary(a, t)}` : ''}\n${a.role}`}
              >
                <span className="avatar sm">{initials(a.name)}</span>@{a.name}
              </span>
            ))}
          </div>
        </div>
        <div className="chat-head-actions">
          {!waitingForTeam && (
            <span className="badge" title={t.modes[conv.settings.mode].hint}>
              {t.modes[conv.settings.mode].label} ·{' '}
              {conv.settings.mode === 'relay' ? t.chat.hops(conv.settings.maxHops) : t.chat.rounds(conv.settings.rounds)}
            </span>
          )}
          <span className={`badge ${conv.settings.permission === 'full' ? 'danger' : ''}`}>
            {t.permissions[conv.settings.permission].label}
          </span>
          <CopyButton
            className="ghost small-button"
            label={t.chat.copyChat}
            title={t.chat.copyChatTitle}
            disabled={conv.messages.length === 0}
            text={() => (convRef.current ? conversationMarkdown(convRef.current, tRef.current) : '')}
          />
          <button className="ghost small-button" onClick={() => setTeamOpen(true)}>
            {t.chat.teamSettings}
          </button>
        </div>
      </header>

      {!connected && !error && <div className="banner">{t.chat.reconnecting}</div>}

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {conv.messages.length === 0 && <TeamIntro conv={conv} leadText={leadText} />}
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
              onSavePlan={onSavePlan}
              onAdjustTeam={onAdjustTeam}
              onApproval={onApproval}
              onRetry={onRetry}
            />
          ))}
        </div>
      </div>

      <div className="composer-dock">
        {pending.length > 0 && (
          <button
            type="button"
            className="approval-banner"
            onClick={() => document.getElementById(`approval-${pending[0]!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            ⏸ {pending.map((p) => `@${p.agent}`).join('、')} · {t.approval.waiting}
          </button>
        )}
        {error && (
          <div className="error-line" role="alert">
            {error}
            <button className="icon-button" onClick={() => setError('')} aria-label={t.common.close}>
              ×
            </button>
          </div>
        )}
        <Composer
          agents={conv.agents}
          running={running}
          canContinue={hasUserMessage}
          placeholder={
            waitingForTeam
              ? t.chat.placeholderAuto
              : conv.settings.mode === 'relay' && conv.agents[0]
                ? t.chat.placeholderRelay(conv.agents[0].name)
                : t.chat.placeholder
          }
          onSend={send}
          onStop={() => api.stop(conv.id).catch((e: Error) => setError(e.message))}
          onContinue={() => void send('', [])}
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
          leadText={leadText}
          onClose={() => setTeamOpen(false)}
          onError={setError}
        />
      )}
    </div>
  );
}

function DiffModal({ title, load, onClose }: { title: string; load: () => Promise<string>; onClose: () => void }) {
  const t = useT();
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
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {error ? (
          <p className="error-line">{error}</p>
        ) : text === null ? (
          <p className="muted">{t.common.loading}</p>
        ) : text.trim() ? (
          <DiffView text={text} />
        ) : (
          <p className="muted">{t.chat.noDiff}</p>
        )}
      </div>
    </div>
  );
}

function TeamIntro({ conv, leadText }: { conv: Conversation; leadText: string }) {
  const t = useT();
  if (conv.settings.autoTeam && conv.agents.length === 0) {
    return (
      <div className="team-intro">
        <h2>{t.chat.autoIntroTitle}</h2>
        <p className="muted">{t.chat.autoIntro(leadText)}</p>
      </div>
    );
  }
  return (
    <div className="team-intro">
      <h2>{t.chat.teamReady}</h2>
      <p className="muted">{t.modes[conv.settings.mode].hint}</p>
      <div className="intro-grid">
        {conv.agents.map((a, i) => (
          <div key={a.id} className="intro-card" style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}>
            <div className="intro-head">
              <span className="avatar">{initials(a.name)}</span>
              <div>
                <strong>@{a.name}</strong>
                <div className="muted small">
                  {PROVIDER_LABEL[a.provider]}
                  {modelSummary(a, t) ? ` · ${modelSummary(a, t)}` : ''}
                  {conv.settings.mode === 'relay' && i === 0 ? ` · ${t.chat.leader}` : ''}
                </div>
              </div>
            </div>
            <p className="intro-role">{a.role || t.chat.noRole}</p>
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
  leadText,
  onClose,
  onError,
}: {
  conv: Conversation;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  running: boolean;
  leadText: string;
  onClose: () => void;
  onError: (s: string) => void;
}) {
  const t = useT();
  const [team, setTeam] = useState<Team>({ agents: conv.agents, settings: conv.settings });
  const [saving, setSaving] = useState(false);
  const problems = teamProblems(team, t);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    try {
      // While the lead agent has not designed the team yet, only the settings can change.
      const auto = team.settings.autoTeam && team.agents.length === 0;
      await api.updateConversation(conv.id, auto ? { settings: team.settings } : { agents: team.agents, settings: team.settings });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={t.chat.teamSettings}>
        <header className="drawer-head">
          <h2>{t.chat.teamSettings}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="muted small">{t.chat.drawerNote}</p>
        <TeamEditor value={team} onChange={setTeam} providers={providers} catalog={catalog} leadLabel={leadText} />
        <footer className="drawer-foot">
          {problems[0] && <span className="error-line">{problems[0]}</span>}
          {running && <span className="muted small">{t.chat.drawerBusy}</span>}
          <button className="ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button className="primary" disabled={saving || running || problems.length > 0} onClick={save}>
            {t.common.save}
          </button>
        </footer>
      </aside>
    </div>
  );
}
