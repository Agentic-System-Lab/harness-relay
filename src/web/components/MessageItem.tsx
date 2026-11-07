import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  PROVIDER_LABEL,
  isInlineImage,
  planSavable,
  type AgentConfig,
  type ApprovalAnswer,
  type ChatMessage,
  type MessageMeta,
  type MessagePart,
  type PlanEntry,
} from '../../shared/types';
import { api } from '../api';
import { messageText, planHeadline, speaker } from '../copy';
import { useT } from '../i18n';
import { PROVIDER_COLOR, formatBytes, formatDuration, formatTokens, initials, leadLabel } from '../util';
import { ChangesCard, type ApplyState } from './ChangesCard';
import { CopyButton } from './CopyButton';
import { PaperclipIcon } from './icons';
import { Logo } from './Logo';
import { Markdown } from './Markdown';
import { RoleText } from './RoleText';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type ApprovalPart = Extract<MessagePart, { type: 'approval' }>;
type Segment =
  | { kind: 'text'; text: string; key: number }
  | { kind: 'tools'; tools: ToolPart[]; key: number }
  | { kind: 'thinking'; text: string; key: number; last: boolean }
  | { kind: 'todo'; entries: PlanEntry[]; key: number }
  | { kind: 'approval'; part: ApprovalPart; key: number };

function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((p, i) => {
    const last = out[out.length - 1];
    switch (p.type) {
      case 'text':
        if (p.text.trim()) out.push({ kind: 'text', text: p.text, key: i });
        break;
      case 'thinking':
        if (p.text.trim()) out.push({ kind: 'thinking', text: p.text, key: i, last: i === parts.length - 1 });
        break;
      case 'plan':
        if (p.entries.length) out.push({ kind: 'todo', entries: p.entries, key: i });
        break;
      case 'approval':
        out.push({ kind: 'approval', part: p, key: i });
        break;
      case 'tool':
        if (last?.kind === 'tools') last.tools.push(p);
        else out.push({ kind: 'tools', tools: [p], key: i });
        break;
    }
  });
  return out;
}

function ToolLine({ x }: { x: ToolPart }) {
  const t = useT();
  return (
    <span className="tool-line">
      <span className="tool-status" aria-label={t.activity.status[x.status]}>
        {x.status === 'running' ? '…' : x.status === 'done' ? '✓' : '✗'}
      </span>
      <code className="tool-name">{x.name}</code>
      {x.detail && <span className="tool-detail">{x.detail}</span>}
    </span>
  );
}

function ToolGroup({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  const t = useT();
  const running = tools.find((x) => x.status === 'running');
  const failed = tools.filter((x) => x.status === 'error').length;
  const summary = running && live ? `${running.name}${running.detail ? ` · ${running.detail}` : ''}` : t.message.actions(tools.length);
  return (
    <details className="tool-group">
      <summary>
        <span className={`tool-icon ${running && live ? 'spin' : ''}`} aria-hidden>
          {running && live ? '◌' : '⚙'}
        </span>
        <span className="tool-summary">{summary}</span>
        {failed > 0 && <span className="tool-failed">{t.message.failed(failed)}</span>}
      </summary>
      <ul>
        {tools.map((x) => (
          <li key={x.id} className={`tool ${x.status}`}>
            {x.output ? (
              <details className="tool-row">
                <summary>
                  <ToolLine x={x} />
                </summary>
                <pre className="tool-output" aria-label={t.activity.output}>
                  {x.output}
                </pre>
              </details>
            ) : (
              <ToolLine x={x} />
            )}
            {x.status === 'error' && x.error && <div className="tool-error">{x.error}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The agent's reasoning: collapsed, with the latest line showing while it streams. */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const t = useT();
  const lastLine = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return (
    <details className={`thinking ${live ? 'live' : ''}`}>
      <summary>
        <span className={`tool-icon ${live ? 'spin' : ''}`} aria-hidden>
          {live ? '◌' : '💭'}
        </span>
        <span className="thinking-label">{live ? t.activity.thinking : t.activity.thought}</span>
        {live && <span className="thinking-tail">{lastLine}</span>}
      </summary>
      <div className="thinking-body">{text.trim()}</div>
    </details>
  );
}

/** The agent's plan / to-do list. */
function TodoList({ entries }: { entries: PlanEntry[] }) {
  const t = useT();
  const done = entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="todo">
      <div className="todo-head">
        <strong>{t.activity.todo}</strong>
        <span className="muted small">
          {done} / {entries.length}
        </span>
      </div>
      <ul>
        {entries.map((e, i) => (
          <li key={i} className={`todo-item ${e.status}`}>
            <span className="todo-mark" aria-hidden>
              {e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An agent asks to do something its permission does not cover. */
function ApprovalCard({
  part,
  agentName,
  live,
  onAnswer,
}: {
  part: ApprovalPart;
  agentName: string;
  live: boolean;
  onAnswer: (approvalId: string, answer: ApprovalAnswer) => Promise<void>;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const status = part.status === 'pending' && !live ? 'expired' : part.status;
  const heading = `@${agentName} ${t.approval.heading[part.kind]}${part.kind === 'other' && part.tool ? ` ${part.tool}` : ''}`;

  if (status !== 'pending') {
    const outcome =
      status === 'allowed'
        ? part.auto
          ? t.approval.allowedAuto
          : part.always
            ? t.approval.allowedAlways
            : t.approval.allowed
        : status === 'denied'
          ? t.approval.denied
          : t.approval.expired;
    return (
      <div className={`approval-done ${status}`}>
        <span className="approval-mark" aria-hidden>
          {status === 'allowed' ? '✓' : status === 'denied' ? '✗' : '–'}
        </span>
        <span className="approval-what">{part.detail ? <code>{part.detail}</code> : heading}</span>
        <span className="approval-outcome">
          {outcome}
          {part.note ? t.approval.withNote(part.note) : ''}
        </span>
      </div>
    );
  }

  const answer = async (a: ApprovalAnswer) => {
    setSending(true);
    try {
      await onAnswer(part.id, a);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="approval-card" id={`approval-${part.id}`} aria-label={heading}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          ⏸
        </span>
        <strong>{heading}</strong>
        <span className="approval-waiting">{t.approval.waiting}</span>
      </header>
      {part.detail && <pre className="approval-detail">{part.detail}</pre>}
      {part.reason && part.reason !== part.detail && <p className="approval-reason">{part.reason}</p>}
      <input
        className="approval-note"
        value={note}
        placeholder={t.approval.notePlaceholder}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && note.trim()) void answer({ allow: false, note });
        }}
      />
      <div className="approval-actions">
        <button type="button" className="primary small-button" disabled={sending} onClick={() => answer({ allow: true })}>
          {t.approval.allow}
        </button>
        {part.ruleLabel && (
          <button type="button" className="ghost small-button" disabled={sending} onClick={() => answer({ allow: true, always: true })}>
            {part.kind === 'edit' ? t.approval.alwaysEdits : t.approval.always(part.ruleLabel)}
          </button>
        )}
        <button
          type="button"
          className="ghost small-button approval-deny"
          disabled={sending}
          onClick={() => answer({ allow: false, note: note.trim() || undefined })}
        >
          {t.approval.deny}
        </button>
      </div>
    </section>
  );
}

function hasMeta(m?: MessageMeta): m is MessageMeta {
  return Boolean(m && (m.durationMs || m.costUsd || m.outputTokens));
}

function MetaText({ m }: { m: MessageMeta }) {
  const t = useT();
  return (
    <span className="msg-meta">
      {formatDuration(m.durationMs)}
      {m.costUsd !== undefined && ` · $${m.costUsd.toFixed(3)}`}
      {m.inputTokens !== undefined && ` · ${t.message.tokensIn(formatTokens(m.inputTokens))}`}
      {m.outputTokens !== undefined && ` / ${t.message.tokensOut(formatTokens(m.outputTokens))}`}
    </span>
  );
}

// Every prop must keep its identity while other messages stream, so this item skips re-rendering.
interface Props {
  msg: ChatMessage;
  /** The conversation's id (for links to attached files). */
  convId: string;
  /** The team (the conversation's array, which only changes when the team does). */
  agents: AgentConfig[];
  /** Memoised list of the team's names. */
  mentionNames: string[];
  /** Label replies with their round (roundtable / parallel with more than one round). */
  showRound: boolean;
  applyState?: ApplyState;
  /** The team is replying: messages cannot be edited until it stops. */
  running: boolean;
  onDiff: (msg: ChatMessage, scope: 'turn' | 'agent') => void;
  onApply: (agentId: string) => Promise<void>;
  /** Replace a user message and run the team again from it; resolves true once sent. */
  onResend: (messageId: string, text: string) => Promise<boolean>;
  /** Accept the team the lead agent designed (auto team), so the user can ask their first question. */
  onConfirmPlan: (messageId: string) => Promise<void>;
  /** Save the team the lead agent designed (auto team) as a template. */
  onSavePlan: (messageId: string, name: string) => Promise<void>;
  onAdjustTeam: () => void;
  /** Answer an agent's approval request. */
  onApproval: (approvalId: string, answer: ApprovalAnswer) => Promise<void>;
  /** Let the agent answer again (drops this reply and what follows). */
  onRetry: (messageId: string) => Promise<void>;
}

/** The lead agent's team design for an auto-team conversation. */
function PlanCard({
  msg,
  onConfirmPlan,
  onSavePlan,
  onAdjustTeam,
}: Pick<Props, 'msg' | 'onConfirmPlan' | 'onSavePlan' | 'onAdjustTeam'>) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const plan = msg.plan!;
  const lead = leadLabel(plan.lead);

  if (plan.status === 'planning') {
    const live = msg.status === 'streaming';
    return (
      <div className="plan-card planning" role="status">
        <span className={`tool-icon ${live ? 'spin' : ''}`} aria-hidden>
          {live ? '◌' : '✦'}
        </span>
        <span>{live ? t.plan.planning(lead) : t.plan.aborted}</span>
      </div>
    );
  }

  const s = plan.settings!;
  const detail = s.mode === 'relay' ? t.chat.hops(s.maxHops) : t.chat.rounds(s.rounds);
  const save = async () => {
    const name = prompt(t.newChat.templateNamePrompt, plan.name ?? '');
    if (!name?.trim()) return;
    setSaving(true);
    try {
      await onSavePlan(msg.id, name.trim());
    } finally {
      setSaving(false);
    }
  };

  const awaiting = Boolean(plan.awaitingConfirmation);
  const confirm = async () => {
    setConfirming(true);
    try {
      await onConfirmPlan(msg.id);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <section className={`plan-card ${plan.source ?? ''} ${awaiting ? 'awaiting' : ''}`} aria-label={t.plan.title}>
      <header className="plan-head">
        <Logo size={18} />
        <strong>{t.plan.title}</strong>
        <span className="muted small">{t.plan.by(lead)}</span>
      </header>
      <p className="plan-headline">
        <strong>{planHeadline(plan, t)}</strong>
        <span className="muted small">{t.plan.howTheyWork(t.modes[s.mode].label, detail)}</span>
      </p>
      {plan.reason && <p className="plan-reason">{plan.reason}</p>}
      <ul className="plan-members">
        {plan.agents?.map((a) => (
          <li key={a.id} style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}>
            <div className="plan-member-head">
              <span className="avatar sm">{initials(a.name)}</span>
              <strong>@{a.name}</strong>
              <span className="provider-tag">{PROVIDER_LABEL[a.provider]}</span>
            </div>
            {a.role.trim() && <RoleText text={a.role.trim()} className="plan-member-role" />}
          </li>
        ))}
      </ul>
      {awaiting && (
        <div className="plan-confirm">
          <span className="small">{t.plan.confirmHint}</span>
          <button type="button" className="primary small-button" onClick={confirm} disabled={confirming}>
            {confirming ? t.plan.confirming : t.plan.confirm}
          </button>
          <button type="button" className="ghost small-button" onClick={onAdjustTeam}>
            {t.plan.adjust}
          </button>
        </div>
      )}
      <div className="plan-actions">
        {plan.confirmedAt && <span className="small plan-saved">✓ {t.plan.confirmed}</span>}
        {planSavable(plan) &&
          (plan.savedPresetId ? (
            <span className="small plan-saved">✓ {t.plan.saved(plan.name ?? '')}</span>
          ) : (
            <>
              <span className="small">{t.plan.askSave}</span>
              <button type="button" className={`${awaiting ? 'ghost' : 'primary'} small-button`} onClick={save} disabled={saving}>
                {saving ? t.plan.saving : t.plan.save}
              </button>
            </>
          ))}
        {!awaiting && (
          <button type="button" className="ghost small-button" onClick={onAdjustTeam}>
            {t.plan.adjust}
          </button>
        )}
        {hasMeta(msg.meta) && <MetaText m={msg.meta} />}
      </div>
    </section>
  );
}

/** One of the user's messages, editable in place. */
/** Files attached to a user message: image thumbnails, and chips for other files. */
function Attachments({ msg, convId }: { msg: ChatMessage; convId: string }) {
  const t = useT();
  const files = msg.parts.flatMap((p) => (p.type === 'attachment' ? [p] : []));
  if (!files.length) return null;
  const images = files.filter((f) => isInlineImage(f.mimeType));
  const others = files.filter((f) => !isInlineImage(f.mimeType));
  return (
    <div className="msg-attachments">
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((f) => (
            <a key={f.id} href={api.attachmentUrl(convId, f.id)} target="_blank" rel="noreferrer" title={t.message.openImage(f.name)}>
              <img src={api.attachmentUrl(convId, f.id)} alt={f.name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {others.map((f) => (
        <a key={f.id} className="file-chip" href={api.attachmentUrl(convId, f.id)} download={f.name} title={t.message.download(f.name)}>
          <PaperclipIcon size={14} />
          <span className="ellipsis">{f.name}</span>
          <span className="muted">{formatBytes(f.size)}</span>
        </a>
      ))}
    </div>
  );
}

/** Height a long user message is folded to (CSS `.bubble.folded`), and how much longer it must be to fold. */
const FOLDED_HEIGHT = 240;
const FOLD_MARGIN = 80;

/** A user message's text; long ones are folded to a few lines with "Show more". */
function UserBubble({ text, mentions }: { text: string; mentions: string[] }) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setLong(el.scrollHeight > FOLDED_HEIGHT + FOLD_MARGIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const toggle = () => {
    setOpen((o) => !o);
    // Folding a long message back: keep it in view instead of leaving the reader far below it.
    if (open) requestAnimationFrame(() => body.current?.closest('.msg-user')?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div className={`bubble ${long && !open ? 'folded' : ''}`}>
      <div className="bubble-body" ref={body}>
        <Markdown text={text} mentions={mentions} />
      </div>
      {long && (
        <button type="button" className="show-more" onClick={toggle} aria-expanded={open}>
          {open ? t.message.showLess : t.message.showMore}
        </button>
      )}
    </div>
  );
}

function UserMessage({
  msg,
  convId,
  mentionNames,
  canEdit,
  onResend,
}: {
  msg: ChatMessage;
  convId: string;
  mentionNames: string[];
  canEdit: boolean;
  onResend: Props['onResend'];
}) {
  const t = useT();
  const text = messageText(msg);
  const [draft, setDraft] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow, like the composer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft]);

  if (draft === null) {
    return (
      <div className="msg-user">
        <Attachments msg={msg} convId={convId} />
        {text && <UserBubble text={text} mentions={mentionNames} />}
        <div className="msg-actions">
          <CopyButton text={() => text} />
          {canEdit && (
            <button type="button" className="msg-action" onClick={() => setDraft(text)}>
              {t.message.edit}
            </button>
          )}
        </div>
      </div>
    );
  }

  const hasFiles = msg.parts.some((p) => p.type === 'attachment');
  const ready = (draft.trim().length > 0 || hasFiles) && canEdit && !sending;
  const submit = async () => {
    // A ref, not state: a quick double Enter comes before the re-render that disables sending.
    if (!ready || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const ok = await onResend(msg.id, draft);
      if (ok) setDraft(null);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME candidate selection
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="msg-user">
      <Attachments msg={msg} convId={convId} />
      <div className="edit-box">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          autoFocus
          aria-label={t.message.editLabel}
        />
        <div className="edit-foot">
          <span className="muted small">{canEdit ? t.message.resendNote : t.message.busyNote}</span>
          <button type="button" className="ghost small-button" onClick={() => setDraft(null)}>
            {t.common.cancel}
          </button>
          <button type="button" className="primary small-button" disabled={!ready} onClick={submit}>
            {sending ? t.common.sending : t.common.send}
          </button>
        </div>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  msg,
  convId,
  agents,
  mentionNames,
  showRound,
  applyState,
  running,
  onDiff,
  onApply,
  onResend,
  onConfirmPlan,
  onSavePlan,
  onAdjustTeam,
  onApproval,
  onRetry,
}: Props) {
  const t = useT();

  if (msg.author.kind === 'system') {
    if (msg.plan) return <PlanCard msg={msg} onConfirmPlan={onConfirmPlan} onSavePlan={onSavePlan} onAdjustTeam={onAdjustTeam} />;
    return (
      <div className="msg-system">
        <span>{msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</span>
      </div>
    );
  }

  if (msg.author.kind === 'user') {
    return <UserMessage msg={msg} convId={convId} mentionNames={mentionNames} canEdit={!running} onResend={onResend} />;
  }

  const agentId = msg.author.agentId;
  const who = speaker(msg, agents);
  const name = who.name;
  const provider = who.provider ?? 'claude';
  const live = msg.status === 'streaming';
  const segs = segments(msg.parts);
  const m = msg.meta;
  const copyable = !msg.passed && messageText(msg).length > 0;

  return (
    <div className={`msg-agent ${msg.passed ? 'passed' : ''}`} style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}>
      <span className="avatar">{initials(name)}</span>
      <div className="msg-body">
        <div className="msg-head">
          <strong>@{name}</strong>
          <span className="provider-tag">{PROVIDER_LABEL[provider]}</span>
          {m?.round && showRound && (
            <span className="round-tag">{t.message.round(m.round)}</span>
          )}
          {live && <span className="live-tag">{t.message.live}</span>}
        </div>

        {msg.passed && msg.status === 'done' ? (
          <p className="muted small">{t.message.passed}</p>
        ) : (
          segs.map((s) => {
            switch (s.kind) {
              case 'text':
                return <Markdown key={s.key} text={s.text} mentions={mentionNames} mediaBase={api.mediaBase(convId, msg.id)} />;
              case 'tools':
                return <ToolGroup key={s.key} tools={s.tools} live={live} />;
              case 'thinking':
                return <ThinkingBlock key={s.key} text={s.text} live={live && s.last} />;
              case 'todo':
                return <TodoList key={s.key} entries={s.entries} />;
              case 'approval':
                return <ApprovalCard key={s.key} part={s.part} agentName={name} live={live} onAnswer={onApproval} />;
            }
          })
        )}

        {live && segs.length === 0 && (
          <div className="typing" aria-label={t.message.thinking}>
            <i />
            <i />
            <i />
          </div>
        )}
        {msg.changes && msg.changes.files.length > 0 && (
          <ChangesCard
            changes={msg.changes}
            agentName={name}
            applyState={applyState}
            onDiff={(scope) => onDiff(msg, scope)}
            onApply={() => onApply(agentId)}
          />
        )}
        {msg.status === 'error' && <div className="msg-error">⚠ {msg.error}</div>}
        {msg.status === 'aborted' && <p className="muted small">{t.message.aborted}</p>}

        {!live && (
          <div className="msg-actions">
            {hasMeta(m) && <MetaText m={m} />}
            {copyable && <CopyButton text={() => messageText(msg)} />}
            {!running && (
              <button type="button" className="msg-action" title={t.message.retryTitle} onClick={() => void onRetry(msg.id)}>
                ↻ {t.message.retry}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
