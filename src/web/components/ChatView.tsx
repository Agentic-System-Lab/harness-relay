import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  PROVIDER_LABEL,
  pendingPlan,
  type ApprovalAnswer,
  type ChatMessage,
  type Conversation,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
  type ServerEvent,
} from '../../shared/types';
import { api, type AttachmentUpload } from '../api';
import { afterStreamError, applyStates as findApplyStates, draftStatus } from '../chat';
import { conversationMarkdown } from '../copy';
import { useT } from '../i18n';
import { PROVIDER_COLOR, initials, leadLabel, modelSummary } from '../util';
import { DiffView } from './ChangesCard';
import { Composer } from './Composer';
import { CopyButton } from './CopyButton';
import { MessageItem } from './MessageItem';
import { RoleText } from './RoleText';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';
import { useDialog } from './useDialog';

/** How long to wait before reconnecting when the browser gave up on the event stream. */
const RECONNECT_MS = 3000;

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
  /** The conversation is gone (deleted): stop reconnecting. */
  const [gone, setGone] = useState(false);
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
    let es: EventSource;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      const source = new EventSource(`/api/conversations/${id}/events`);
      es = source;
      source.onmessage = (ev) => {
        const e = JSON.parse(ev.data) as ServerEvent;
        dispatch(e);
        if (e.type === 'status' || e.type === 'conversation') onChangedRef.current();
      };
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        // Only a 404 means the conversation is gone; anything else (e.g. the server restarting) is retried.
        const decide = (err: unknown) => {
          if (closed || source !== es) return;
          const next = afterStreamError(err, source.readyState === EventSource.CLOSED);
          if (next === 'stop') {
            source.close();
            setGone(true);
            setError((err as Error).message);
          } else if (next === 'reconnect' && timer === undefined) {
            timer = window.setTimeout(() => {
              timer = undefined;
              if (!closed) connect();
            }, RECONNECT_MS);
          }
        };
        api.getConversation(id).then(() => decide(undefined), decide);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      es.close();
    };
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

  const onConfirmPlan = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      setError('');
      await api.confirmPlan(c.id, messageId);
      onChangedRef.current(); // the sidebar stops asking
    } catch (e) {
      setError((e as Error).message);
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

  const retrying = useRef(false);
  const onRetry = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c || retrying.current) return; // a double click would get "busy" for the second request
    const later = c.messages.slice(c.messages.findIndex((m) => m.id === messageId) + 1);
    const changed = later.filter((m) => m.changes && m.changes.files.length > 0).length;
    if (later.length > 0 && !confirm(tRef.current.chat.retryConfirm(later.length, changed))) return;
    retrying.current = true;
    try {
      setError('');
      stick.current = true;
      await api.retry(c.id, messageId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      retrying.current = false;
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

  // Only each agent's latest result from its current worktree can be applied.
  const messages = state.conv?.messages;
  const worktrees = state.conv?.worktrees;
  const applyStates = useMemo(() => findApplyStates(messages ?? [], worktrees ?? {}), [messages, worktrees]);

  // Stable while messages stream, so MessageItem (memoised) only re-renders the message that changed.
  const agents = state.conv?.agents;
  const mentionNames = useMemo(() => (agents ?? []).map((a) => a.name), [agents]);

  const { conv, running, active } = state;
  if (!conv) return <div className="page-center muted">{error || t.common.loading}</div>;

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
  // The lead agent's team design waits for the user: they confirm it, then ask their first question.
  const awaitingConfirm = Boolean(pendingPlan(conv.messages));
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

      {!connected && !gone && <div className="banner">{t.chat.reconnecting}</div>}

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
              convId={conv.id}
              agents={conv.agents}
              mentionNames={mentionNames}
              showRound={conv.settings.mode !== 'relay' && conv.settings.rounds > 1}
              applyState={running ? undefined : applyStates.get(m.id)}
              running={running}
              onDiff={onDiff}
              onApply={onApply}
              onResend={onResend}
              onConfirmPlan={onConfirmPlan}
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
            ⏸ {pending.map((p) => `@${p.agent}`).join(t.common.listSeparator)} · {t.approval.waiting}
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
          locked={awaitingConfirm}
          placeholder={
            awaitingConfirm
              ? t.chat.placeholderConfirm
              : waitingForTeam
              ? t.chat.placeholderAuto
              : conv.settings.mode === 'relay' && conv.agents[0]
                ? t.chat.placeholderRelay(conv.agents[0].name)
                : t.chat.placeholder
          }
          onSend={send}
          onStop={() => api.stop(conv.id).catch((e: Error) => setError(e.message))}
          onContinue={() => send('', [])}
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
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);

  useEffect(() => {
    load().then(setText, (e: Error) => setError(e.message));
  }, [load]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
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
            {a.role.trim() ? (
              <RoleText text={a.role.trim()} lines={6} />
            ) : (
              <p className="intro-role">{t.chat.noRole}</p>
            )}
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
  const current = useMemo<Team>(() => ({ agents: conv.agents, settings: conv.settings }), [conv.agents, conv.settings]);
  /** The team as it was when the draft was copied from it. */
  const [base, setBase] = useState<Team>(current);
  const [team, setTeam] = useState<Team>(current);
  const [saving, setSaving] = useState(false);
  const problems = teamProblems(team, t);
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, onClose);

  // The team can change while the drawer is open (e.g. the lead agent designs it): follow it until
  // the user edits; after that, saving would overwrite it, so ask to reload first.
  const status = draftStatus(base, team, current);
  const reload = useCallback(() => {
    setBase(current);
    setTeam(current);
  }, [current]);
  useEffect(() => {
    if (status === 'refresh') reload();
  }, [status, reload]);

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
      <aside
        ref={dialog}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t.chat.teamSettings}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{t.chat.teamSettings}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="muted small">{t.chat.drawerNote}</p>
        <TeamEditor value={team} onChange={setTeam} providers={providers} catalog={catalog} leadLabel={leadText} />
        <footer className="drawer-foot">
          {status === 'conflict' ? (
            <span className="error-line">
              {t.chat.drawerChanged}{' '}
              <button type="button" className="link-button" onClick={reload}>
                {t.chat.drawerReload}
              </button>
            </span>
          ) : (
            problems[0] && <span className="error-line">{problems[0]}</span>
          )}
          {running && <span className="muted small">{t.chat.drawerBusy}</span>}
          <button className="ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            className="primary"
            disabled={saving || running || problems.length > 0 || status === 'conflict'}
            onClick={save}
          >
            {t.common.save}
          </button>
        </footer>
      </aside>
    </div>
  );
}
