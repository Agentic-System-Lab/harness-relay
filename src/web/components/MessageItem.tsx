import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  PROVIDER_LABEL,
  isInlineImage,
  planSavable,
  type AgentConfig,
  type ApprovalAnswer,
  type ChatMessage,
  type EventSource,
  type MessageMeta,
  type PlanEntry,
  type ProgressStatus,
  type ReviewHighlight,
  type ScheduleProposal,
} from '../../shared/types';
import { mostSerious, type ReplyMarks } from '../../shared/review';
import { splitAsk } from '../../shared/ask';
import { withoutStepsTail } from '../../shared/steps';
import { withoutProgressTail } from '../../shared/tracking';
import { withoutMemoryBlocks } from '../../shared/memory';
import { withoutHandoffBlocks } from '../../shared/handoffs';
import { cardEntry } from '../memory';
import { api } from '../api';
import { settingsHref } from '../route';
import {
  activityCounts,
  enterSends,
  foldedDetail,
  isPathDetail,
  isSubagent,
  isTeamResult,
  isTouchScreen,
  resultOwner,
  runningStep,
  segments,
  shownSegments,
  subagentName,
  steeredNames,
  thoughtTail,
  thoughtTitle,
  type ActivityItem,
  type ApprovalPart,
  type ToolItem,
  type ToolPart,
  type MemoryPart,
  type SchedulePart,
  type OutboxPart,
} from '../chat';
import { fallbackExplanation, mentionWarning, messageText, planChecksMentions, planHeadline, planWording, speaker } from '../copy';
import { useI18n, useT } from '../i18n';
import { PROVIDER_COLOR, formatBytes, formatDuration, formatTokens, initials, leadLabel } from '../util';
import { ChangesCard, type ApplyState } from './ChangesCard';
import { StepsCard } from './StepsCard';
import { HandoverCard } from './HandoverCard';
import { ChecksCard } from './ChecksCard';
import { CopyButton } from './CopyButton';
import { GrokTrustNote, asksGrokTrust } from './GrokTrust';
import { BranchIcon, ClockIcon, CopyIcon, MemoryIcon, PaperclipIcon, PencilIcon, RetryIcon, ShareIcon } from './icons';
import { AnimatedLogo, Logo, LogoSpinner } from './Logo';
import { Markdown } from './Markdown';
import { DocumentPreview, DocumentResult } from './DocumentPreview';
import { CommandCard, InteractiveCard, SecretsCard } from './HandoffCards';
import { NotePreview } from './NotePreview';
import { RoleText } from './RoleText';
import { markQuotes, replyElementId, revealMessage, revealQuote, reviewElementId } from '../review';
import { browserTimeZone, describeRepeat, shownEvent } from '../schedule';
import { proposalGaps, proposalUpdate, withoutScheduleBlocks } from '../../shared/scheduleProposal';

/**
 * A tool call's detail on one line. A path too long for it loses its start, not its file name: it is
 * laid out right to left around a left-to-right run, so the ellipsis goes at its start.
 */
function ToolDetail({ detail, className }: { detail: string; className: string }) {
  return isPathDetail(detail) ? (
    <span className={`${className} path`} title={detail}>
      <bdi dir="ltr">{detail}</bdi>
    </span>
  ) : (
    <span className={className} title={detail}>
      {detail}
    </span>
  );
}

function ToolLine({ x }: { x: ToolPart }) {
  const t = useT();
  return (
    <span className="tool-line">
      <span className="tool-status" aria-label={t.activity.status[x.status]}>
        {x.status === 'running' ? '…' : x.status === 'done' ? '✓' : '✗'}
      </span>
      <code className="tool-name">{x.name}</code>
      {x.detail && <ToolDetail detail={x.detail} className="tool-detail" />}
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

/**
 * A call that started a subagent: the subagent's name, model and how many actions it took, opening to
 * its own calls (joined to it by a line, a subagent of its own the same way, one level further in), then
 * what it reported back.
 */
function SubagentStep({ item }: { item: ToolItem }) {
  const t = useT();
  const x = item.part;
  const steps = item.steps ?? [];
  const { actions, failed } = activityCounts(steps);
  const name = subagentName(x);
  return (
    <li className={`tool subagent ${x.status}`}>
      <details className="tool-row subagent-row">
        <summary>
          <span className="tool-line">
            <span className="tool-status" aria-label={t.activity.status[x.status]}>
              {x.status === 'running' ? '…' : x.status === 'done' ? '✓' : '✗'}
            </span>
            <code className="tool-name" title={x.agent ? x.name : undefined}>
              {name}
            </code>
            {x.model && <span className="subagent-model">{x.model}</span>}
            {x.detail && <ToolDetail detail={x.detail} className="tool-detail" />}
            {actions > 0 && <span className="activity-count">{t.message.actions(actions)}</span>}
            {failed > 0 && <span className="tool-failed">{t.message.failed(failed)}</span>}
          </span>
        </summary>
        {steps.length > 0 && (
          <ul className="subagent-steps" aria-label={t.activity.subagentSteps(name)}>
            {steps.map((i) => (
              <ActivityStep key={i.key} item={i} />
            ))}
          </ul>
        )}
        {x.output && (
          <pre className="tool-output subagent-result" aria-label={t.activity.subagentResult}>
            {x.output}
          </pre>
        )}
      </details>
      {x.status === 'error' && x.error && <div className="tool-error">{x.error}</div>}
    </li>
  );
}

/** One step in an open activity list: a subagent, a tool call or a stretch of reasoning. */
function ActivityStep({ item }: { item: ActivityItem }) {
  if (item.kind === 'thinking') return <ThoughtStep text={item.text} />;
  return isSubagent(item) ? <SubagentStep item={item} /> : <ToolStep x={item.part} />;
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
function ActivityGroup({
  items,
  live,
  last,
  label,
  children,
}: {
  items: ActivityItem[];
  live: boolean;
  last: boolean;
  label?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const { actions, thoughts, failed } = activityCounts(items);
  const tail = items[items.length - 1];
  const thinking = live && last && tail.kind === 'thinking' ? tail.text : undefined;
  // Inside a subagent, the step it is on, after the names of the subagents it is in (`Explore › Read`).
  const at = live ? runningStep(items) : undefined;
  const running = at?.part;
  const runningName = at ? [...at.agents, subagentName(at.part)].join(' › ') : undefined;
  const counts = [actions > 0 && t.message.actions(actions), thoughts > 0 && t.message.thoughts(thoughts)].filter(Boolean).join(' · ');
  const busy = thinking !== undefined || running !== undefined;
  return (
    <details className="tool-group" aria-label={label}>
      <summary>
        <span className="tool-icon" aria-hidden>
          {busy ? <LogoSpinner /> : actions > 0 ? '⚙' : '💭'}
        </span>
        {thinking !== undefined ? (
          <span className="tool-summary">
            <span className="thinking-label">{t.activity.thinking}</span> <span className="thinking-tail">{thoughtTail(thinking)}</span>
          </span>
        ) : running ? (
          <span className="tool-summary running-step">
            <span className="running-name" title={runningName}>
              {runningName}
            </span>
            {running.detail && (
              <span className="running-more">
                <span className="running-sep" aria-hidden>
                  ·
                </span>
                <ToolDetail detail={running.detail} className="running-detail" />
              </span>
            )}
          </span>
        ) : (
          <span className="tool-summary">{label ?? (actions === 0 && thoughts === 1 ? t.activity.thought : counts)}</span>
        )}
        {(label || (busy && items.length > 1)) && <span className="activity-count">{counts}</span>}
        {failed > 0 && <span className="tool-failed">{t.message.failed(failed)}</span>}
      </summary>
      <ul>
        {items.map((i) => (
          <ActivityStep key={i.key} item={i} />
        ))}
      </ul>
      {children}
    </details>
  );
}

/**
 * Something the agent asked to send (an outbox item): what goes where, as it will go out, with Send
 * and Discard while it waits; then what became of it. Only Send sends it.
 */
function OutboxCard({ part, convId, agentName }: { part: OutboxPart; convId: string; agentName: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answer = async (action: 'send' | 'discard') => {
    setBusy(true);
    setError('');
    try {
      await api.answerOutbox(convId, part.id, action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const waiting = part.status === 'pending';
  const note = part.preview.note;
  const doc = part.preview.document;
  const saving = note || doc;
  const approve =
    doc && doc.before === null ? t.outbox.document.create : note && note.before === null ? t.outbox.note.create : t.outbox.note.save;
  const posting = part.tool === 'slack_send_message' || part.tool === 'teams_send_message';
  const status =
    doc && part.status === 'failed'
      ? t.outbox.document.check
      : saving
        ? t.outbox.note.status[part.status]
        : posting && part.status === 'failed'
          ? t.outbox.deliveryFailed
          : t.outbox.status[part.status];
  return (
    <section
      className={`outbox-card outbox-${part.status}`}
      aria-label={doc ? t.outbox.document.label(agentName) : note ? t.outbox.note.label(agentName) : t.outbox.label(agentName)}
    >
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          {saving ? <PencilIcon /> : '✉'}
        </span>
        <strong>{part.title}</strong>
        <span className="approval-waiting">{status}</span>
      </header>
      {part.preview.fields.length > 0 && (
        <dl className="outbox-fields">
          {part.preview.fields.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {doc && <DocumentPreview document={doc} />}
      {note && <NotePreview note={note} />}
      {part.preview.body && <pre className="outbox-body">{part.preview.body}</pre>}
      {part.result && <p className="approval-reason">{doc ? <DocumentResult text={part.result} /> : part.result}</p>}
      {error && <p className="error-line">{error}</p>}
      {waiting && (
        <>
          <p className="muted small">{doc ? t.outbox.document.hint : note ? t.outbox.note.hint : t.outbox.hint}</p>
          <div className="approval-actions">
            <button type="button" className="primary small-button" disabled={busy} onClick={() => answer('send')}>
              {saving ? approve : t.outbox.send}
            </button>
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => answer('discard')}>
              {t.outbox.discard}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A schedule the reply proposed (its `<schedule>` block): what it would send and when, and, while it
 * waits, creating it as it is, changing it in the schedule's form first, or dismissing it. Its times are
 * this browser's time zone's.
 */
function ScheduleCard({
  part,
  convId,
  messageId,
  agentName,
  hasSchedule,
  onEdit,
}: {
  part: SchedulePart;
  convId: string;
  messageId: string;
  agentName: string;
  hasSchedule: boolean;
  onEdit?: (messageId: string, proposal: ScheduleProposal) => void;
}) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = part.proposal;
  const zone = browserTimeZone();
  const gaps = proposalGaps(p, zone, Date.now());
  const when = describeRepeat(proposalUpdate(p, zone).repeat, t, lang);
  const waiting = !part.status;
  const answer = async (action: 'create' | 'dismiss') => {
    setBusy(true);
    setError('');
    try {
      await api.answerProposal(convId, messageId, action, zone);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={`outbox-card schedule-proposal ${part.status ? `outbox-${part.status === 'created' ? 'sent' : 'discarded'}` : 'outbox-pending'}`}
      aria-label={`${t.proposal.title} · @${agentName}`}
    >
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          <ClockIcon size={16} />
        </span>
        <strong>{t.proposal.title}</strong>
        {part.status && <span className="approval-waiting">{part.status === 'created' ? t.proposal.created : t.proposal.dismissed}</span>}
      </header>
      <dl className="outbox-fields">
        <div>
          <dt>{t.proposal.message}</dt>
          <dd className="schedule-proposal-text">{p.text}</dd>
        </div>
        <div>
          <dt>{t.proposal.when}</dt>
          <dd>{when}</dd>
        </div>
        {p.goal && (
          <div>
            <dt>{t.proposal.goal}</dt>
            <dd>{p.goal}</dd>
          </div>
        )}
      </dl>
      {p.newChat && <p className="small">{t.proposal.newChat}</p>}
      {error && <p className="error-line">{error}</p>}
      {waiting && (
        <>
          <p className="muted small">
            {gaps.includes('past') ? t.proposal.gapPast : gaps.includes('account') ? t.proposal.gapAccount : t.proposal.note}
            {hasSchedule ? ` ${t.proposal.replaces}` : ''}
          </p>
          <div className="approval-actions">
            <button type="button" className="primary small-button" disabled={busy || gaps.length > 0} onClick={() => answer('create')}>
              {busy ? t.proposal.creating : t.proposal.create}
            </button>
            {onEdit && (
              <button type="button" className="ghost small-button" disabled={busy} onClick={() => onEdit(messageId, p)}>
                {t.proposal.edit}
              </button>
            )}
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => answer('dismiss')}>
              {t.proposal.dismiss}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * What a reply saved to long-term memory: each note, where it stands now (the server updates the card
 * when the note changes), and what the user can do with it here; the rest is in Settings.
 */
function MemoryCard({ part }: { part: MemoryPart }) {
  const t = useT();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const act = async (id: string, call: () => Promise<unknown>) => {
    setBusy(id);
    setError('');
    try {
      await call();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const c = t.longTerm.card;
  return (
    <section className="memory-card" aria-label={c.title}>
      <header className="memory-card-head">
        <MemoryIcon size={16} />
        <strong>{c.title}</strong>
      </header>
      <ul className="memory-card-notes">
        {part.notes.map((n, i) => {
          const id = n.id;
          const entry = cardEntry(n);
          return (
            <li key={`${id ?? ''}-${i}`} className={`memory-card-note memory-${n.status}`}>
              <span className="memory-op">{c.op[n.op]}</span>
              <span className="memory-text">{n.text || id}</span>
              {entry.status && (
                <span className="memory-status">{n.status === 'skipped' && n.skipped ? c.skipped[n.skipped] : c.status[n.status]}</span>
              )}
              {id && entry.action === 'keep' && (
                <span className="memory-actions">
                  <button
                    type="button"
                    className="primary small-button"
                    disabled={busy === id}
                    onClick={() => void act(id, () => api.editMemoryNote(id, { state: 'active' }))}
                  >
                    {t.longTerm.keep}
                  </button>
                  <button
                    type="button"
                    className="ghost small-button"
                    disabled={busy === id}
                    onClick={() => void act(id, () => api.deleteMemoryNote(id))}
                  >
                    {t.longTerm.discard}
                  </button>
                </span>
              )}
              {id && (entry.action === 'archive' || entry.action === 'restore') && (
                <span className="memory-actions">
                  <button
                    type="button"
                    className="ghost small-button"
                    disabled={busy === id}
                    onClick={() =>
                      void act(id, () => api.editMemoryNote(id, { state: entry.action === 'archive' ? 'archived' : 'active' }))
                    }
                  >
                    {entry.action === 'archive' ? t.longTerm.archive : t.longTerm.restore}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="error-line">{error}</p>}
    </section>
  );
}

/** What a reply said about the goal its schedule tracks (its `<progress>` block). */
function ProgressCard({ status, text }: { status: ProgressStatus; text: string }) {
  const t = useT();
  return (
    <div className={`progress-card progress-${status}`} role="note" aria-label={t.schedule.progress.label}>
      <span className="progress-status">{t.schedule.progress.status[status]}</span>
      {text && <span className="progress-text">{text}</span>}
    </div>
  );
}

/** The body a program sent through the schedule's webhook with this message: data, shown as it came. */
function EventBlock({ event, source }: { event: string; source?: EventSource }) {
  const t = useT();
  return (
    <details className="event-block">
      <summary>{source && source !== 'webhook' ? t.schedule.watch.eventTags[source] : t.schedule.hook.eventTag}</summary>
      <pre>{shownEvent(event, source)}</pre>
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
  onAnswer: ((approvalId: string, answer: ApprovalAnswer) => Promise<void>) | undefined;
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
          : part.review?.status === 'approved'
            ? t.approval.reviewApproved
            : part.always
              ? t.approval.allowedAlways
              : t.approval.allowed
        : status === 'denied'
          ? t.approval.denied
          : t.approval.expired;
    // The lead agent's reason it approved it ("Approve for me").
    const why = status === 'allowed' && part.review?.status === 'approved' && part.review.reason ? part.review.reason : '';
    const said = (
      <span className="approval-outcome">
        {outcome}
        {why ? t.approval.withNote(why) : ''}
        {part.note ? t.approval.withNote(part.note) : ''}
      </span>
    );
    const mark = (
      <span className="approval-mark" aria-hidden>
        {status === 'allowed' ? '✓' : status === 'denied' ? '✗' : '–'}
      </span>
    );
    // A long command: its first line beside the answer, click it to read all of it.
    const fold = part.detail ? foldedDetail(part.detail) : undefined;
    if (fold) {
      return (
        <details className={`approval-done approval-fold ${status}`}>
          <summary>
            {mark}
            <span className="approval-text">
              <code className="approval-head-line">{fold.head}</code>
              {fold.more > 0 && <span className="approval-more">{t.approval.moreLines(fold.more)}</span>}
              {said}
            </span>
          </summary>
          <pre className="approval-full">{part.detail}</pre>
        </details>
      );
    }
    return (
      <div className={`approval-done ${status}`}>
        {mark}
        {/* One run of text, so a command that wraps goes under itself and the mark stays beside it. */}
        <span className="approval-text">
          <span className="approval-what">{part.detail ? <code>{part.detail}</code> : heading}</span>
          {said}
        </span>
      </div>
    );
  }

  const reviewing = part.review?.status === 'reviewing';
  const answer = async (a: ApprovalAnswer) => {
    if (!onAnswer) return;
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
        <span className={`approval-waiting${reviewing ? ' approval-reviewing' : ''}`}>
          {reviewing ? t.approval.reviewing : t.approval.waiting}
        </span>
      </header>
      {part.detail && <pre className="approval-detail">{part.detail}</pre>}
      {part.reason && part.reason !== part.detail && <p className="approval-reason">{part.reason}</p>}
      {part.outsideSandbox && <p className="approval-reason approval-sandbox">{t.approval.outsideSandbox}</p>}
      {part.readOnlySandbox && <p className="approval-reason approval-sandbox">{t.approval.readOnlySandbox}</p>}
      {/* "Approve for me": what the lead agent says of it, or Harness Relay's reason it was never reviewed.
          One it approved goes through at once, so nothing is said of it here. */}
      {part.review && part.review.status !== 'approved' && (
        <p className={`approval-reason approval-review ${part.review.status}`} role={reviewing ? 'status' : undefined}>
          {reviewing
            ? t.approval.reviewingHint
            : part.review.status === 'flagged'
              ? t.approval.reviewFlagged(part.review.reason ?? '')
              : part.review.status === 'skipped'
                ? part.review.reason
                : t.approval.reviewFailed(part.review.reason ?? '')}
        </p>
      )}
      {part.review?.status === 'flagged' && part.ruleLabel && <p className="muted small approval-once">{t.approval.flaggedOnce}</p>}
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
        <button type="button" className="primary small-button" disabled={sending || !onAnswer} onClick={() => answer({ allow: true })}>
          {t.approval.allow}
        </button>
        {/* One the lead agent flagged is allowed once only: a rule would let the next one like it through unreviewed. */}
        {part.ruleLabel && part.review?.status !== 'flagged' && (
          <button
            type="button"
            className="ghost small-button"
            disabled={sending || !onAnswer}
            onClick={() => answer({ allow: true, always: true })}
          >
            {part.kind === 'edit' ? t.approval.alwaysEdits : part.ruleExact ? t.approval.alwaysExact : t.approval.always(part.ruleLabel)}
          </button>
        )}
        <button
          type="button"
          className="ghost small-button approval-deny"
          disabled={sending || !onAnswer}
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
  onPreview?: (messageId: string, agentName: string, path: string) => void;
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
  /** What the user can do now, only on a fallback card for the current question. */
  fallbackStatus?: string;
  /** The message of the conversation's schedule: a team design should have the members it @mentions. */
  scheduleText?: string;
  /** Save the team the lead agent designed (auto team) as a template. */
  onSavePlan: (messageId: string, name: string) => Promise<void>;
  /** Whether the conversation has lead review on (given to team design cards and review cards only). */
  leadReview?: boolean;
  /** A stopped or failed review card: the next review reads the replies it left (`nextReviewStart()`). */
  readNext?: boolean;
  /** Turn lead review on or off (the latest team design card's box); resolves whether the server took it. */
  onLeadReview?: (on: boolean) => Promise<boolean>;
  onAdjustTeam: () => void;
  /** Answer an agent's approval request. */
  onApproval: ((approvalId: string, answer: ApprovalAnswer) => Promise<void>) | undefined;
  /** Let the agent answer again (drops this reply and what follows). */
  onRetry: (messageId: string) => Promise<void>;
  /** This reply's question waits for the user's answer (the team stopped for it). */
  waitingAnswer?: boolean;
  /** The other agents that wait for the user's answer too, as `@name`s (its steps card says an answer there is this reply's alone). */
  othersWaiting?: string;
  /** This reply's steps still wait for the user, while the team replies to another card's answer. */
  answerLater?: boolean;
  /** Let the team go on without answering. */
  onSkipQuestion?: () => void;
  /** Copy or share the conversation up to and including this reply. */
  onShare?: (messageId: string) => void;
  /** What the lead agent's reviews point out in this reply (lead review): marked in it. */
  marks?: ReplyMarks;
  /** Put a next step the lead agent suggests in the message box (lead review). */
  onUseStep?: (text: string) => void;
  /** Branch the conversation from this reply: a new one with the messages up to and including it. */
  onBranch?: (messageId: string) => void;
  /** A team checks card: whether it is the conversation's latest result (only it offers anything). */
  latestChecks?: boolean;
  /** Team checks: check the latest result again, go on without it, or ask a member to fix it. */
  onRecheckChecks?: (messageId: string, confirm?: boolean) => Promise<unknown>;
  onSkipChecks?: (messageId: string) => Promise<unknown>;
  onFixChecks?: (messageId: string, agentId: string) => Promise<unknown>;
  /** Apply a member's parallel-mode result the team checks held back. */
  onApplyAnyway?: (agentId: string, how: 'force' | 'confirm') => Promise<unknown>;
  /** Opens a schedule the reply proposed in the schedule's form, to change it before saving it. */
  onEditProposal?: (messageId: string, proposal: ScheduleProposal) => void;
  /** The conversation has a schedule already (a proposed one replaces it). */
  hasSchedule?: boolean;
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
  fallbackStatus,
  scheduleText,
  onConfirmPlan,
  onDeclinePlan,
  onSavePlan,
  onAdjustTeam,
  running,
  leadReview,
  onLeadReview,
}: Pick<
  Props,
  | 'msg'
  | 'cwd'
  | 'agents'
  | 'latestPlan'
  | 'fallbackStatus'
  | 'scheduleText'
  | 'onConfirmPlan'
  | 'onDeclinePlan'
  | 'onSavePlan'
  | 'onAdjustTeam'
  | 'running'
  | 'leadReview'
  | 'onLeadReview'
>) {
  const { t, lang } = useI18n();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const plan = msg.plan!;
  const lead = leadLabel(plan.lead);
  const wording = planWording(plan, t, lead);
  const changeLead = plan.leadUnavailable && <a href={settingsHref('lead')}>{t.plan.leadUnavailableHint}</a>;
  const leadWarning = plan.leadUnavailable && (
    <div className="plan-lead-warning" role="status">
      <strong>{t.plan.leadUnavailable(lead)}</strong>
      {changeLead}
    </div>
  );

  if (plan.status === 'failed')
    return (
      <PlanCardLayout msg={msg} className="failed">
        {leadWarning}
        <div className="msg-error" role="status">
          ⚠ {plan.reason}
        </div>
      </PlanCardLayout>
    );

  if (plan.status === 'planning') {
    const live = msg.status === 'streaming';
    const status = plan.leadUnavailable ? t.plan.preparingFallback : wording.planning;
    return (
      <PlanCardLayout msg={msg} className="planning">
        <div className="plan-status" role="status">
          {/* While the lead agent designs the team: the home page's mark, turning until the design is in. */}
          {live ? (
            <AnimatedLogo className="plan-logo" turning />
          ) : (
            <span className="tool-icon plan-logo-stopped" aria-hidden>
              ✦
            </span>
          )}
          <span>{live ? status : wording.aborted}</span>
        </div>
        {leadWarning}
      </PlanCardLayout>
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
  // While agents are at work (the team answering, the lead agent reviewing), the team cannot be saved.
  const adjust = (
    <button
      type="button"
      className="ghost small-button"
      onClick={onAdjustTeam}
      disabled={running}
      title={running ? t.plan.adjustBusy : undefined}
    >
      {t.plan.adjust}
    </button>
  );
  const answer = async (fn: (id: string) => Promise<void>) => {
    setConfirming(true);
    try {
      await fn(msg.id);
    } finally {
      setConfirming(false);
    }
  };

  const confirmation = awaiting && (
    <div className="plan-confirm">
      <span className="small">{plan.checkOnConfirm ? t.plan.checkOnConfirm : wording.confirmHint}</span>
      <button type="button" className="primary small-button" onClick={() => answer(onConfirmPlan)} disabled={confirming || running}>
        {confirming || msg.status === 'streaming' ? t.plan.confirming : t.plan.confirm}
      </button>
      {adjust}
      {declinable && (
        <button type="button" className="ghost small-button" onClick={() => answer(onDeclinePlan)} disabled={confirming || running}>
          {t.plan.decline}
        </button>
      )}
    </div>
  );
  const fallback = plan.source === 'fallback' ? fallbackExplanation(plan, t, lang) : undefined;
  return (
    <PlanCardLayout msg={msg} className={`${plan.source ?? ''} ${awaiting ? 'awaiting' : ''}`}>
      <header className="plan-head">
        <Logo size={18} />
        <strong>{fallback ? planHeadline(plan, t) : t.plan.title}</strong>
        {!fallback && !plan.leadUnavailable && <span className="muted small">{t.plan.by(lead)}</span>}
      </header>
      {fallback ? (
        <>
          {fallback.explanation && <p className="plan-reason">{fallback.explanation}</p>}
          {plan.fallback && plan.reason && <p className="plan-reason">{plan.reason}</p>}
          {changeLead && <p className="small">{changeLead}</p>}
          {confirmation}
          {fallbackStatus && (
            <p className="plan-next plan-reason" role="status">
              {fallbackStatus}
            </p>
          )}
          {fallback.diagnostic && (
            <details className="plan-diagnostic">
              <summary>{t.plan.technicalDetails}</summary>
              <pre>{fallback.diagnostic}</pre>
            </details>
          )}
          <span className="muted small">{t.plan.howTheyWork(t.modes[s.mode].label, detail)}</span>
        </>
      ) : (
        <>
          {leadWarning}
          <p className="plan-headline">
            <strong>{planHeadline(plan, t)}</strong>
            <span className="muted small">{t.plan.howTheyWork(t.modes[s.mode].label, detail)}</span>
          </p>
          {plan.reason && <p className="plan-reason">{plan.reason}</p>}
        </>
      )}
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
      {/* Lead review: the latest design has its box, for the conversation from now on. */}
      {latestPlan && onLeadReview && <LeadReviewBox on={Boolean(leadReview)} onChange={onLeadReview} />}
      {/* A team that misses someone the schedule's message @mentions (any design, in a chat with a schedule). */}
      {scheduleText && planChecksMentions(plan, Boolean(latestPlan)) && (
        <MissedMentions text={scheduleText} names={(plan.agents ?? []).map((a) => a.name)} />
      )}
      {/* Before the user lets a team with a Grok member answer: Grok may not load this project's own setup. */}
      {(awaiting || (plan.autoConfirmed && latestPlan)) && asksGrokTrust(plan.agents ?? [], cwd) && <GrokTrustNote cwd={cwd} />}
      {!fallback && confirmation}
      <div className="plan-actions">
        {plan.confirmedAt && <span className="small plan-saved">✓ {plan.autoConfirmed ? t.plan.autoConfirmed : t.plan.confirmed}</span>}
        {plan.declinedAt && <span className="small plan-saved">{t.plan.declined}</span>}
        {plan.adjustedAt && <span className="small plan-saved">✎ {t.plan.adjusted}</span>}
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
        {!awaiting && latestPlan && adjust}
        {hasMeta(msg.meta) && <MetaText m={msg.meta} />}
      </div>
    </PlanCardLayout>
  );
}

/** The disclosure stays mounted inside the card when the design changes from planning to its result. */
function PlanCardLayout({ msg, className, children }: { msg: ChatMessage; className: string; children: ReactNode }) {
  const t = useT();
  return (
    <section className={`plan-card ${className}`} aria-label={t.plan.title}>
      {children}
      <PlanActivity msg={msg} />
    </section>
  );
}

function PlanActivity({ msg }: { msg: ChatMessage }) {
  const t = useT();
  const groups = segments(msg.parts);
  const items = groups.flatMap((segment) => (segment.kind === 'activity' ? segment.items : []));
  const todo = groups.find((segment) => segment.kind === 'todo');
  return items.length ? (
    <ActivityGroup items={items} label={t.plan.activity} live={msg.status === 'streaming'} last>
      {todo && <TodoList entries={todo.entries} />}
    </ActivityGroup>
  ) : null;
}

/** The lead agent's review of the team's replies (lead review): what to look at closely, and what to do next. */
function ReviewCard({ msg, onUseStep, leadReview, readNext }: Pick<Props, 'msg' | 'onUseStep' | 'leadReview' | 'readNext'>) {
  const t = useT();
  const review = msg.review!;
  const lead = leadLabel(review.lead);
  // A stopped or failed review that the next one reads back over says so (and that it waits for lead
  // review to be on again, when it is off); one it will not reach says nothing of a next review.
  const later = readNext && (
    <>
      {' '}
      <span className="review-later">{leadReview === false ? t.review.later.off : t.review.later.on}</span>
    </>
  );

  if (review.status === 'reviewing') {
    const live = msg.status === 'streaming';
    return (
      <div className="plan-card planning review-card" role="status" id={reviewElementId(msg.id)}>
        {/* While the lead agent reviews: the team design card's mark, turning until the review is in. */}
        {live ? (
          <AnimatedLogo className="plan-logo" turning />
        ) : (
          <span className="tool-icon plan-logo-stopped" aria-hidden>
            ✦
          </span>
        )}
        <span>
          {live ? t.review.reviewing(lead) : t.review.aborted}
          {!live && later}
        </span>
      </div>
    );
  }

  if (review.status === 'failed') {
    return (
      <div className="plan-card planning review-card failed" id={reviewElementId(msg.id)}>
        <span className="tool-icon plan-logo-stopped" aria-hidden>
          ✦
        </span>
        <span>
          {review.error ? t.review.failed(review.error) : t.review.failedNoReason}
          {later}
        </span>
        {hasMeta(msg.meta) && <MetaText m={msg.meta} />}
      </div>
    );
  }

  const highlights = review.highlights ?? [];
  const steps = review.nextSteps ?? [];
  return (
    <section className="plan-card review-card" aria-label={t.review.title} id={reviewElementId(msg.id)}>
      <header className="plan-head">
        <Logo size={18} />
        <strong>{t.review.title}</strong>
        <span className="muted small">{t.review.by(lead)}</span>
      </header>
      {review.summary && <p className="plan-reason review-summary">{review.summary}</p>}
      <div className="review-section">
        <h4>{t.review.attention}</h4>
        {highlights.length ? (
          <ul className="review-highlights">
            {highlights.map((h, i) => (
              <ReviewPoint key={i} h={h} />
            ))}
          </ul>
        ) : (
          <p className="muted small review-none">{t.review.nothingToFlag}</p>
        )}
      </div>
      {steps.length > 0 && (
        <div className="review-section">
          <h4>{t.review.nextSteps}</h4>
          <ol className="review-steps">
            {steps.map((s, i) => (
              <li key={i} className={`review-step ${s.by}`}>
                <span className="review-by">{s.by === 'team' ? t.review.byTeam : t.review.byUser}</span>
                <span className="review-step-text">{s.text}</span>
                {s.by === 'team' && onUseStep && (
                  <button
                    type="button"
                    className="ghost small-button review-use"
                    title={t.review.useStepTitle}
                    onClick={() => onUseStep(s.message ?? s.text)}
                  >
                    {t.review.useStep}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {/* How many replies it read beside its time and cost: the header keeps to its title on a phone. */}
      {(review.replyIds || hasMeta(msg.meta)) && (
        <div className="plan-actions">
          {review.replyIds && <span className="muted small">{t.review.read(review.replyIds.length)}</span>}
          {hasMeta(msg.meta) && <MetaText m={msg.meta} />}
        </div>
      )}
    </section>
  );
}

/** One thing the lead agent points out: its kind, the reply and words it is about, and why it matters. */
function ReviewPoint({ h }: { h: ReviewHighlight }) {
  const t = useT();
  return (
    <li className={`review-point ${h.kind}`}>
      <div className="review-point-head">
        <span className={`review-kind ${h.kind}`}>{t.review.kinds[h.kind]}</span>
        {h.messageId && h.agentName ? (
          <button
            type="button"
            className="review-reply-link"
            title={h.quote ? t.review.goToQuote(h.agentName) : t.review.goToReply(h.agentName)}
            onClick={() => revealQuote(h.messageId!, h.quote)}
          >
            @{h.agentName}
          </button>
        ) : h.agentName ? (
          <span className="muted small">@{h.agentName}</span>
        ) : (
          !h.messageId && <span className="muted small">{t.review.whole}</span>
        )}
      </div>
      {h.quote && <blockquote className={`review-quote ${h.kind}`}>{h.quote}</blockquote>}
      <p className="review-note">{h.note}</p>
    </li>
  );
}

/**
 * Lead review's box on the latest team design card: on or off for the conversation (the question being
 * answered and the ones after it), and what that means. Only the user switches it.
 */
function LeadReviewBox({ on, onChange }: { on: boolean; onChange: (on: boolean) => Promise<boolean> }) {
  const t = useT();
  const hint = useId();
  // What the user just chose, shown until the conversation says so too (or the server refused it).
  const [chosen, setChosen] = useState<boolean | null>(null);
  useEffect(() => {
    if (chosen !== null && chosen === on) setChosen(null);
  }, [chosen, on]);
  const checked = chosen ?? on;
  // The box is the app's own control: a shared page leaves it out.
  return (
    <div className="plan-review">
      <label className="check-row">
        <input
          type="checkbox"
          aria-describedby={hint}
          checked={checked}
          onChange={async (e) => {
            const next = e.target.checked;
            setChosen(next);
            if (!(await onChange(next))) setChosen(null);
          }}
        />
        <span>{t.team.leadReview}</span>
      </label>
      <span className="small muted" id={hint}>
        {checked ? t.team.leadReviewHint.on : t.team.leadReviewHint.off}
      </span>
    </div>
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
  agents,
  canEdit,
  onResend,
}: {
  msg: ChatMessage;
  convId: string;
  mentionNames: string[];
  agents: AgentConfig[];
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
        {msg.event !== undefined && <EventBlock event={msg.event} source={msg.eventSource} />}
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
          ) : msg.autoFix ? (
            <span className="queued-tag" title={t.checks.autoFixTagTitle}>
              {t.checks.autoFixTag(msg.autoFix.attempt, msg.autoFix.of)}
            </span>
          ) : msg.steered?.length ? (
            <span className="queued-tag steered-tag" title={t.message.steeredTitle}>
              {t.message.steeredTag(steeredNames(msg, agents))}
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
  fallbackStatus,
  scheduleText,
  onSavePlan,
  onAdjustTeam,
  onApproval,
  onRetry,
  waitingAnswer,
  othersWaiting,
  answerLater,
  onSkipQuestion,
  onShare,
  onBranch,
  onPreview,
  marks,
  onUseStep,
  leadReview,
  readNext,
  onLeadReview,
  latestChecks,
  onRecheckChecks,
  onSkipChecks,
  onFixChecks,
  onApplyAnyway,
  onEditProposal,
  hasSchedule,
}: Props) {
  const t = useT();

  if (msg.author.kind === 'system') {
    if (msg.review) return <ReviewCard msg={msg} onUseStep={onUseStep} leadReview={leadReview} readNext={readNext} />;
    if (msg.checks) {
      const none = async () => undefined;
      return (
        <ChecksCard
          msg={msg}
          latest={Boolean(latestChecks)}
          agents={agents}
          running={running}
          onRecheck={onRecheckChecks ?? none}
          onSkip={onSkipChecks ?? none}
          onFix={onFixChecks ?? none}
          onApplyAnyway={onApplyAnyway ?? none}
        />
      );
    }
    if (msg.plan) {
      return (
        <PlanCard
          msg={msg}
          cwd={cwd}
          agents={agents}
          latestPlan={latestPlan}
          fallbackStatus={fallbackStatus}
          scheduleText={scheduleText}
          onConfirmPlan={onConfirmPlan}
          onDeclinePlan={onDeclinePlan}
          onSavePlan={onSavePlan}
          onAdjustTeam={onAdjustTeam}
          running={running}
          leadReview={leadReview}
          onLeadReview={onLeadReview}
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
    return <UserMessage msg={msg} convId={convId} mentionNames={mentionNames} agents={agents} canEdit={!running} onResend={onResend} />;
  }
  return (
    <AgentMessage
      msg={msg}
      convId={convId}
      agents={agents}
      mentionNames={mentionNames}
      showRound={showRound}
      applyState={applyState}
      running={running}
      onDiff={onDiff}
      onApply={onApply}
      onApproval={onApproval}
      onRetry={onRetry}
      waitingAnswer={waitingAnswer}
      othersWaiting={othersWaiting}
      answerLater={answerLater}
      onSkipQuestion={onSkipQuestion}
      onShare={onShare}
      onBranch={onBranch}
      onPreview={onPreview}
      marks={marks}
      onEditProposal={onEditProposal}
      hasSchedule={hasSchedule}
    />
  );
});

/** An agent's reply, with what the lead agent's review marked in it. */
function AgentMessage({
  msg,
  convId,
  agents,
  mentionNames,
  showRound,
  applyState,
  running,
  onDiff,
  onApply,
  onApproval,
  onRetry,
  waitingAnswer,
  othersWaiting,
  answerLater,
  onSkipQuestion,
  onShare,
  onBranch,
  onPreview,
  marks,
  onEditProposal,
  hasSchedule,
}: Pick<
  Props,
  | 'msg'
  | 'convId'
  | 'agents'
  | 'mentionNames'
  | 'showRound'
  | 'applyState'
  | 'running'
  | 'onDiff'
  | 'onApply'
  | 'onApproval'
  | 'onRetry'
  | 'waitingAnswer'
  | 'othersWaiting'
  | 'answerLater'
  | 'onSkipQuestion'
  | 'onShare'
  | 'onBranch'
  | 'onPreview'
  | 'marks'
  | 'onEditProposal'
  | 'hasSchedule'
>) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const live = msg.status === 'streaming';
  // The words the lead agent quotes, marked where the reply has them (again when the reply re-renders).
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || live || !marks?.highlights.length) return;
    return markQuotes(el, marks.highlights);
    // The reply's text re-renders when the team's names change (mentions): mark it again then too.
  }, [marks, live, msg.parts, mentionNames]);

  const agentId = msg.author.kind === 'agent' ? msg.author.agentId : '';
  const who = speaker(msg, agents);
  const name = who.name;
  const previewFile = useMemo(() => onPreview && ((path: string) => onPreview(msg.id, name, path)), [onPreview, msg.id, name]);
  const provider = who.provider ?? 'claude';
  const segs = segments(msg.parts);
  const passed = Boolean(msg.passed && msg.status === 'done');
  const { shown, typing } = shownSegments(segs, passed, live);
  const marked = marks?.highlights.length ?? 0;
  const m = msg.meta;
  const copyable = !msg.passed && messageText(msg).length > 0;

  return (
    <div
      className={`msg-agent ${msg.passed ? 'passed' : ''}`}
      id={replyElementId(msg.id)}
      style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}
    >
      <span className="avatar">{initials(name)}</span>
      <div className="msg-body" ref={body}>
        <div className="msg-head">
          <strong>@{name}</strong>
          <span className="provider-tag">{PROVIDER_LABEL[provider]}</span>
          {m?.round && showRound && <span className="round-tag">{t.message.round(m.round)}</span>}
          {live && <span className="live-tag">{t.message.live}</span>}
          {msg.asked && !waitingAnswer && <span className="round-tag">{t.message.askedTag}</span>}
          {marked > 0 && marks && (
            <button
              type="button"
              className={`review-mark-tag ${mostSerious(marks.highlights)}`}
              title={t.review.marksTitle(marked)}
              onClick={() => revealMessage(reviewElementId(marks.reviewId))}
            >
              <span aria-hidden>⚑</span> {t.review.marks(marked)}
            </button>
          )}
        </div>

        {shown.map((s) => {
          switch (s.kind) {
            case 'text':
              // A question's closing marker is taken out when the reply ends; hide it while it streams.
              return (
                <Markdown
                  key={s.key}
                  text={
                    live
                      ? withoutScheduleBlocks(
                          withoutHandoffBlocks(withoutMemoryBlocks(withoutProgressTail(withoutStepsTail(splitAsk(s.text).text)))),
                        )
                      : s.text
                  }
                  mentions={mentionNames}
                  mediaBase={api.mediaBase(convId, msg.id)}
                  downloadBase={api.downloadBase(convId, msg.id)}
                  onPreview={previewFile}
                />
              );
            case 'activity':
              return <ActivityGroup key={s.key} items={s.items} live={live} last={s.last} />;
            case 'todo':
              return <TodoList key={s.key} entries={s.entries} />;
            case 'approval':
              return <ApprovalCard key={s.key} part={s.part} agentName={name} live={live} onAnswer={onApproval} />;
            case 'progress':
              return <ProgressCard key={s.key} status={s.status} text={s.text} />;
            case 'outbox':
              return <OutboxCard key={s.key} part={s.part} convId={convId} agentName={name} />;
            case 'handover':
              return (
                <HandoverCard
                  key={s.key}
                  part={s.part}
                  convId={convId}
                  agentName={name}
                  live={live}
                  asks={msg.parts.filter((p): p is ApprovalPart => p.type === 'approval' && p.status === 'pending')}
                  onApproval={onApproval}
                />
              );
            case 'memory':
              return <MemoryCard key={s.key} part={s.part} />;
            case 'secrets':
              return <SecretsCard key={s.key} part={s.part} convId={convId} messageId={msg.id} agentName={name} />;
            case 'command':
              return <CommandCard key={s.key} part={s.part} convId={convId} messageId={msg.id} agentName={name} />;
            case 'steps':
              return (
                <StepsCard
                  key={s.key}
                  part={s.part}
                  convId={convId}
                  messageId={msg.id}
                  agentName={name}
                  waiting={Boolean(waitingAnswer)}
                  othersWaiting={othersWaiting}
                  later={answerLater}
                  mentions={mentionNames}
                  mediaBase={api.mediaBase(convId, msg.id)}
                  downloadBase={api.downloadBase(convId, msg.id)}
                  onPreview={previewFile}
                />
              );
            case 'interactive':
              return <InteractiveCard key={s.key} part={s.part} convId={convId} messageId={msg.id} agentName={name} />;
            case 'schedule':
              return (
                <ScheduleCard
                  key={s.key}
                  part={s.part}
                  convId={convId}
                  messageId={msg.id}
                  agentName={name}
                  hasSchedule={Boolean(hasSchedule)}
                  onEdit={onEditProposal}
                />
              );
            case 'notice':
              return (
                <p key={s.key} className="warn-line small msg-notice" role="note">
                  {s.text}
                </p>
              );
          }
        })}
        {passed && <p className="muted small">{t.message.passed}</p>}

        {typing && (
          <div className="typing" aria-label={t.message.thinking}>
            <LogoSpinner size={16} />
          </div>
        )}
        {msg.changes?.some((c) => c.files.length > 0) && (
          <ChangesCard
            changes={msg.changes}
            agentName={name}
            team={isTeamResult(msg.changes)}
            applyState={applyState}
            onDiff={(scope) => onDiff(msg, scope)}
            onApply={() => onApply(resultOwner(msg) ?? agentId)}
          />
        )}
        {/* A steps card says it already, and has its own answer. */}
        {waitingAnswer && !segs.some((x) => x.kind === 'steps') && (
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
}
