import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  PROVIDER_LABEL,
  isInlineImage,
  planSavable,
  type AgentConfig,
  type ApprovalAnswer,
  type ChatMessage,
  type MessageMeta,
  type PlanEntry,
} from '../../shared/types';
import { splitAsk } from '../../shared/ask';
import { api } from '../api';
import {
  activityCounts,
  enterSends,
  isTouchScreen,
  segments,
  thoughtTail,
  thoughtTitle,
  type ActivityItem,
  type ApprovalPart,
  type ToolPart,
} from '../chat';
import { mentionWarning, messageText, planChecksMentions, planHeadline, planWording, speaker } from '../copy';
import { useT } from '../i18n';
import { PROVIDER_COLOR, formatBytes, formatDuration, formatTokens, initials, leadLabel } from '../util';
import { ChangesCard, type ApplyState } from './ChangesCard';
import { CopyButton } from './CopyButton';
import { GrokTrustNote, asksGrokTrust } from './GrokTrust';
import { BranchIcon, ClockIcon, CopyIcon, PaperclipIcon, PencilIcon, RetryIcon, ShareIcon } from './icons';
import { Logo } from './Logo';
import { Markdown } from './Markdown';
import { RoleText } from './RoleText';

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

function ToolStep({ x }: { x: ToolPart }) {
  const t = useT();
  return (
    <li className={`tool ${x.status}`}>
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
  );
}

/** A stretch of reasoning in the open list: its first line, click to read all of it. */
function ThoughtStep({ text }: { text: string }) {
  const t = useT();
  return (
    <li className="tool thought">
      <details className="tool-row">
        <summary>
          <span className="tool-line">
            <span className="tool-status" aria-hidden>
              💭
            </span>
            <span className="thought-title">{thoughtTitle(text) || t.activity.thought}</span>
          </span>
        </summary>
        <div className="thinking-body">{text.trim()}</div>
      </details>
    </li>
  );
}

/**
 * The tool calls and thinking between two pieces of reply text, as one collapsed row: how many actions
 * and thoughts, or while it streams, the step in progress. Open it to see every step in order.
 */
function ActivityGroup({ items, live, last }: { items: ActivityItem[]; live: boolean; last: boolean }) {
  const t = useT();
  const { actions, thoughts, failed } = activityCounts(items);
  const tail = items[items.length - 1];
  const thinking = live && last && tail.kind === 'thinking' ? tail.text : undefined;
  const running = live
    ? items.find((i): i is Extract<ActivityItem, { kind: 'tool' }> => i.kind === 'tool' && i.part.status === 'running')?.part
    : undefined;
  const counts = [actions > 0 && t.message.actions(actions), thoughts > 0 && t.message.thoughts(thoughts)].filter(Boolean).join(' · ');
  const busy = thinking !== undefined || running !== undefined;
  return (
    <details className="tool-group">
      <summary>
        <span className={`tool-icon ${busy ? 'spin' : ''}`} aria-hidden>
          {busy ? '◌' : actions > 0 ? '⚙' : '💭'}
        </span>
        {thinking !== undefined ? (
          <span className="tool-summary">
            <span className="thinking-label">{t.activity.thinking}</span> <span className="thinking-tail">{thoughtTail(thinking)}</span>
          </span>
        ) : running ? (
          <span className="tool-summary">
            {running.name}
            {running.detail ? ` · ${running.detail}` : ''}
          </span>
        ) : (
          <span className="tool-summary">{actions === 0 && thoughts === 1 ? t.activity.thought : counts}</span>
        )}
        {busy && items.length > 1 && <span className="activity-count">{counts}</span>}
        {failed > 0 && <span className="tool-failed">{t.message.failed(failed)}</span>}
      </summary>
      <ul>
        {items.map((i) => (i.kind === 'tool' ? <ToolStep key={i.key} x={i.part} /> : <ThoughtStep key={i.key} text={i.text} />))}
      </ul>
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
        {/* One run of text, so a long command wraps under itself and the mark stays beside it. */}
        <span className="approval-text">
          <span className="approval-what">{part.detail ? <code>{part.detail}</code> : heading}</span>
          <span className="approval-outcome">
            {outcome}
            {part.note ? t.approval.withNote(part.note) : ''}
          </span>
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

export function hasMeta(m?: MessageMeta): m is MessageMeta {
  return Boolean(m && (m.durationMs || m.costUsd || m.outputTokens));
}

/** How long a reply (or the lead agent) took, what it cost, and its tokens. */
export function MetaText({ m }: { m: MessageMeta }) {
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
  /** The conversation's working directory (whether Grok trusts it, for a team design to confirm). */
  cwd: string;
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
  /** Accept the team the lead agent designed for a question (auto team), so it answers. */
  onConfirmPlan: (messageId: string) => Promise<void>;
  /** Decline it: the current team answers instead. */
  onDeclinePlan: (messageId: string) => Promise<void>;
  /** The conversation's latest team design: one used at once still says how Grok trusts the folder. */
  latestPlan?: boolean;
  /** The message of the conversation's schedule: a team design should have the members it @mentions. */
  scheduleText?: string;
  /** Save the team the lead agent designed (auto team) as a template. */
  onSavePlan: (messageId: string, name: string) => Promise<void>;
  onAdjustTeam: () => void;
  /** Answer an agent's approval request. */
  onApproval: (approvalId: string, answer: ApprovalAnswer) => Promise<void>;
  /** Let the agent answer again (drops this reply and what follows). */
  onRetry: (messageId: string) => Promise<void>;
  /** This reply's question waits for the user's answer (the team stopped for it). */
  waitingAnswer?: boolean;
  /** Let the team go on without answering. */
  onSkipQuestion?: () => void;
  /** Copy or share the conversation up to and including this reply. */
  onShare?: (messageId: string) => void;
  /** Branch the conversation from this reply: a new one with the messages up to and including it. */
  onBranch?: (messageId: string) => void;
}

/** Names the conversation's scheduled message @mentions that a team design does not have. */
function MissedMentions({ text, names }: { text: string; names: string[] }) {
  const t = useT();
  const warning = mentionWarning(text, names, t, 'card');
  return warning ? <p className="small warn-text plan-note">{warning}</p> : null;
}

/** The lead agent's team design for a question in an auto-team conversation. */
function PlanCard({
  msg,
  cwd,
  agents,
  latestPlan,
  scheduleText,
  onConfirmPlan,
  onDeclinePlan,
  onSavePlan,
  onAdjustTeam,
}: Pick<Props, 'msg' | 'cwd' | 'agents' | 'latestPlan' | 'scheduleText' | 'onConfirmPlan' | 'onDeclinePlan' | 'onSavePlan' | 'onAdjustTeam'>) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const plan = msg.plan!;
  const lead = leadLabel(plan.lead);
  const wording = planWording(plan, t, lead);

  if (plan.status === 'planning') {
    const live = msg.status === 'streaming';
    return (
      <div className="plan-card planning" role="status">
        <span className={`tool-icon ${live ? 'spin' : ''}`} aria-hidden>
          {live ? '◌' : '✦'}
        </span>
        <span>{live ? wording.planning : wording.aborted}</span>
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
  // Declining keeps the current team: offered when there is one and the design is another team.
  const keepsTeam = plan.source === 'kept' || (plan.source === 'fallback' && !plan.presetId);
  const declinable = awaiting && agents.length > 0 && !keepsTeam;
  const answer = async (fn: (id: string) => Promise<void>) => {
    setConfirming(true);
    try {
      await fn(msg.id);
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
      {/* A team that misses someone the schedule's message @mentions (any design, in a chat with a schedule). */}
      {scheduleText && planChecksMentions(plan, Boolean(latestPlan)) && (
        <MissedMentions text={scheduleText} names={(plan.agents ?? []).map((a) => a.name)} />
      )}
      {/* Before the user lets a team with a Grok member answer: Grok may not load this project's own setup. */}
      {(awaiting || (plan.autoConfirmed && latestPlan)) && asksGrokTrust(plan.agents ?? [], cwd) && <GrokTrustNote cwd={cwd} />}
      {awaiting && (
        <div className="plan-confirm">
          <span className="small">{wording.confirmHint}</span>
          <button type="button" className="primary small-button" onClick={() => answer(onConfirmPlan)} disabled={confirming}>
            {confirming ? t.plan.confirming : t.plan.confirm}
          </button>
          <button type="button" className="ghost small-button" onClick={onAdjustTeam}>
            {t.plan.adjust}
          </button>
          {declinable && (
            <button type="button" className="ghost small-button" onClick={() => answer(onDeclinePlan)} disabled={confirming}>
              {t.plan.decline}
            </button>
          )}
        </div>
      )}
      <div className="plan-actions">
        {plan.confirmedAt && <span className="small plan-saved">✓ {plan.autoConfirmed ? t.plan.autoConfirmed : t.plan.confirmed}</span>}
        {plan.declinedAt && <span className="small plan-saved">{t.plan.declined}</span>}
        {planSavable(plan) &&
          (plan.savedPresetId ? (
            <span className="small plan-saved">✓ {t.plan.saved(plan.name ?? '')}</span>
          ) : (
            <>
              <span className="small plan-ask-save">{t.plan.askSave}</span>
              <button type="button" className={`${awaiting ? 'ghost' : 'primary'} small-button`} onClick={save} disabled={saving}>
                {saving ? t.plan.saving : t.plan.save}
              </button>
            </>
          ))}
        {/* Only the latest design is the team now: an earlier card has nothing left to adjust. */}
        {!awaiting && latestPlan && (
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
        {/* Line breaks as typed: Enter (Shift+Enter with a keyboard) starts a new line. */}
        <Markdown text={text} mentions={mentions} breaks />
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
          <CopyButton className="msg-action icon-action" iconOnly icon={<CopyIcon size={16} />} text={() => text} />
          {canEdit && (
            <button
              type="button"
              className="msg-action icon-action"
              title={t.message.edit}
              aria-label={t.message.edit}
              onClick={() => setDraft(text)}
            >
              <PencilIcon size={16} />
            </button>
          )}
          {/* Last, so the tag sits at the right edge under the bubble: copy and edit only turn transparent off hover and still take their space. */}
          {msg.scheduled ? (
            <span className="queued-tag scheduled-tag" title={t.schedule.tagTitle}>
              <ClockIcon size={11} />
              {t.schedule.tag}
            </span>
          ) : (
            msg.queued && (
              <span className="queued-tag" title={t.message.queuedTitle}>
                {t.message.queuedTag}
              </span>
            )
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
    } else if (enterSends(e, isTouchScreen())) {
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
  cwd,
  agents,
  mentionNames,
  showRound,
  applyState,
  running,
  onDiff,
  onApply,
  onResend,
  onConfirmPlan,
  onDeclinePlan,
  latestPlan,
  scheduleText,
  onSavePlan,
  onAdjustTeam,
  onApproval,
  onRetry,
  waitingAnswer,
  onSkipQuestion,
  onShare,
  onBranch,
}: Props) {
  const t = useT();

  if (msg.author.kind === 'system') {
    if (msg.plan) {
      return (
        <PlanCard
          msg={msg}
          cwd={cwd}
          agents={agents}
          latestPlan={latestPlan}
          scheduleText={scheduleText}
          onConfirmPlan={onConfirmPlan}
          onDeclinePlan={onDeclinePlan}
          onSavePlan={onSavePlan}
          onAdjustTeam={onAdjustTeam}
        />
      );
    }
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
          {msg.asked && !waitingAnswer && <span className="round-tag">{t.message.askedTag}</span>}
        </div>

        {msg.passed && msg.status === 'done' ? (
          <p className="muted small">{t.message.passed}</p>
        ) : (
          segs.map((s) => {
            switch (s.kind) {
              case 'text':
                // A question's closing marker is taken out when the reply ends; hide it while it streams.
                return (
                  <Markdown
                    key={s.key}
                    text={live ? splitAsk(s.text).text : s.text}
                    mentions={mentionNames}
                    mediaBase={api.mediaBase(convId, msg.id)}
                    downloadBase={api.downloadBase(convId, msg.id)}
                  />
                );
              case 'activity':
                return <ActivityGroup key={s.key} items={s.items} live={live} last={s.last} />;
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
        {waitingAnswer && (
          <div className="ask-card" id={`ask-${msg.id}`}>
            <strong>{t.message.askWaiting}</strong>
            <span className="muted">{t.message.askNote(name)}</span>
            {onSkipQuestion && (
              <button type="button" className="ghost small-button" onClick={onSkipQuestion}>
                {t.message.askSkip}
              </button>
            )}
          </div>
        )}
        {msg.status === 'error' && <div className="msg-error">⚠ {msg.error}</div>}
        {msg.status === 'aborted' && <p className="muted small">{t.message.aborted}</p>}

        {!live && (
          <div className="msg-actions">
            {copyable && (
              <CopyButton className="msg-action icon-action" iconOnly icon={<CopyIcon size={16} />} text={() => messageText(msg)} />
            )}
            {!running && (
              <button
                type="button"
                className="msg-action icon-action"
                title={t.message.retryTitle}
                aria-label={t.message.retry}
                onClick={() => void onRetry(msg.id)}
              >
                <RetryIcon size={16} />
              </button>
            )}
            {copyable && onShare && (
              <button
                type="button"
                className="msg-action icon-action"
                title={t.message.shareTitle}
                aria-label={t.message.share}
                onClick={() => onShare(msg.id)}
              >
                <ShareIcon size={16} />
              </button>
            )}
            {onBranch && (
              <button
                type="button"
                className="msg-action icon-action"
                title={t.message.branchTitle}
                aria-label={t.message.branch}
                onClick={() => onBranch(msg.id)}
              >
                <BranchIcon size={16} />
              </button>
            )}
            {/* The buttons sit on the left, like a chat app's; the time, cost and tokens at the right edge. */}
            {hasMeta(m) && <MetaText m={m} />}
          </div>
        )}
      </div>
    </div>
  );
});
