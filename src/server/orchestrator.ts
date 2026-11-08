import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import type {
  AgentConfig,
  AgentSessionState,
  ApprovalAnswer,
  AgentWorktree,
  ChatMessage,
  Conversation,
  FileChange,
  MessageChanges,
  MessagePart,
  Provider,
  RunPause,
  TeamPreset,
} from '../shared/types';
import { splitAsk } from '../shared/ask';
import { pendingPlan, planSavable } from '../shared/types';
import { AgentRunError, runners, type AgentEvent, type RunResult } from './agents';
import type { ApprovalRequest } from './agents/types';
import type { TraceSink } from './agentsview';
import { approvalKeys, isAllowed } from './approvals';
import { HttpError } from './errors';
import { AutoGrouper } from './grouping';
import type { Hub } from './hub';
import {
  PLANNER_BRIEFING,
  buildPlannerPrompt,
  decidePlan,
  fallbackPlan,
  parsePlanReply,
  type PlanDecision,
  type PlannerContext,
} from './planner';
import {
  attachmentsDir,
  imageInputs,
  removeAttachments,
  saveAttachments,
  type AttachmentPart,
  type AttachmentUpload,
} from './attachments';
import {
  buildBriefing,
  buildTurnPrompt,
  isForwardable,
  isPass,
  parseMentions,
  type BriefingWorkspace,
  type TurnInfo,
} from './prompt';
import { DATA_DIR, type SettingsStore } from './settings';
import type { Store } from './store';
import {
  applyToWorkingTree,
  commitWorktree,
  createWorktree,
  diffFiles,
  diffText,
  dropKeptCommits,
  ensureRepo,
  forgetCommits,
  keepCommits,
  repoRoot,
  removeWorktree,
  snapshot,
  worktreeCwd,
  worktreeHead,
} from './workspace';
import { isDefaultTitle, t } from './i18n';

export { HttpError };

/** A conversation as sent to the browser: without the agents' CLI session bookkeeping (it grows with the chat). */
export function forClient(conv: Conversation): Conversation {
  return { ...conv, agentState: {} };
}

/** Where agents of one run write. */
interface RunWorkspace {
  /** Repository root of the working directory; set when agents may write (edit / full). */
  root?: string;
  /** Parallel mode with write access: every agent works in its own git worktree. */
  isolated: boolean;
}

interface Run {
  abort: AbortController;
  active: Set<string>;
  ws: RunWorkspace;
  /** Repository root this run holds the directory lock on. */
  lockRoot?: string;
  /** Settles once the run has finished, including its clean-up. */
  done: Promise<void>;
}

interface StartOptions {
  /** Runs once the workspace is ready and locked, just before the message is posted. */
  beforePost?: () => void;
  /** Run just these agents, for one round (retrying replies). */
  only?: AgentConfig[];
  /** `beforePost` turns auto team on, so the lead agent designs the team first. */
  willPlan?: boolean;
  /** Attached files of the new user message (already saved). */
  files?: AttachmentPart[];
  /** Post the messages waiting in the queue first: they were sent before this one, and start the run too. */
  queue?: boolean;
}

/** Longest name of a template saved from a plan. */
const MAX_PRESET_NAME = 100;

/** The team the lead agent designed, compared with the conversation's current team. */
function sameTeam(plan: NonNullable<ChatMessage['plan']>, conv: Conversation): boolean {
  const key = (agents: AgentConfig[]) =>
    JSON.stringify(agents.map((a) => [a.id, a.name, a.provider, a.role, a.model ?? '', a.effort ?? '']));
  const s = plan.settings;
  return (
    Boolean(plan.agents && s) &&
    key(plan.agents!) === key(conv.agents) &&
    s!.mode === conv.settings.mode &&
    s!.rounds === conv.settings.rounds &&
    s!.maxHops === conv.settings.maxHops
  );
}

/** Where the lead agent's choices come from (signed-in CLIs, their models, the templates). */
export interface PlannerSource {
  context(): Promise<PlannerContext>;
}

function textOf(m: ChatMessage): string {
  return m.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}

/** Most messages that may wait in a conversation's queue. */
const MAX_QUEUE = 20;

/**
 * Who answers a run the user's `messages` start: the agents they @mention, or the whole team when
 * none does or one of them mentions nobody (it is for everyone).
 */
function mentionsOf(messages: ChatMessage[], agents: AgentConfig[]): AgentConfig[] {
  const named: AgentConfig[] = [];
  for (const m of messages) {
    const found = parseMentions(textOf(m), agents);
    if (!found.length) return [];
    for (const a of found) if (!named.includes(a)) named.push(a);
  }
  return named;
}

/** A waiting message is for these agents: it @mentions one of them, or nobody. */
function isFor(m: ChatMessage, recipients: AgentConfig[], agents: AgentConfig[]): boolean {
  const named = parseMentions(textOf(m), agents);
  return !named.length || named.some((a) => recipients.some((r) => r.id === a.id));
}

const attachmentsOf = (m: ChatMessage) => m.parts.filter((p): p is AttachmentPart => p.type === 'attachment');

/** What a user message asks: its text, and the names of the files attached to it. */
function questionOf(m: ChatMessage): string {
  const files = attachmentsOf(m).map((p) => p.name);
  return textOf(m) + (files.length ? `\n\n(Attached files: ${files.join(', ')})` : '');
}

/**
 * A finished reply that ends with the ask marker asks the user something: the marker is taken out of
 * the message. Returns whether it asks.
 */
function takeAsk(msg: ChatMessage): boolean {
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const part = msg.parts[i]!;
    if (part.type !== 'text') continue;
    const { text, asks } = splitAsk(part.text);
    if (text === part.text) return false;
    if (text) part.text = text;
    else msg.parts.splice(i, 1);
    return asks;
  }
  return false;
}

/** Where a run begins: round 1 with everyone taking part, or — after the user answered a question — where the team stopped. */
interface Schedule {
  participants: AgentConfig[];
  round: number;
  rounds: number;
  /** Who speaks in the first round, in order (relay: the first queue). */
  first: { agent: AgentConfig; handedBy?: string }[];
  /** Relay: handoffs left. */
  hopsLeft: number;
  /** Agents whose question the user just answered: told so on their next turn. */
  answering: Set<string>;
}

/**
 * Drives a conversation: decides which agent speaks next, builds each agent's prompt from the
 * messages it hasn't seen yet, runs the CLI, and streams the result to connected browsers.
 */
export class Orchestrator {
  private runs = new Map<string, Run>();
  /**
   * Conversations between a request's check and its effect: a run being set up, a result being
   * applied, settings being changed. Nothing else may start on them meanwhile.
   */
  private reserved = new Map<string, Promise<void>>();
  /** Conversations whose run is being set up: a message sent meanwhile waits in the queue. */
  private starting = new Set<string>();
  /** Conversations being deleted. */
  private deleting = new Set<string>();
  /** The server is shutting down: nothing new starts. */
  private closing = false;
  /** Repository root → conversation currently writing to its working tree. */
  private dirLocks = new Map<string, string>();
  /** Approval requests waiting for the user, by approval part id. */
  private approvals = new Map<string, { convId: string; resolve: (a: ApprovalAnswer & { expired?: boolean }) => void }>();
  /** Sorts new conversations into the user's sidebar groups. */
  private grouper: AutoGrouper;

  constructor(
    private store: Store,
    private hub: Hub,
    private settings: SettingsStore,
    private planner: PlannerSource = { context: async () => ({ available: [], catalog: [], presets: store.listPresets() }) },
    /** Told after each turn and run, to send the conversation to AgentsView. */
    private traces?: TraceSink,
  ) {
    this.grouper = new AutoGrouper(store, settings, (conv, provider, sessionId) => this.linkSession(conv, provider, sessionId));
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /** The lead agent is sorting this new conversation into one of the user's groups. */
  isSorting(id: string): boolean {
    return this.grouper.isSorting(id);
  }

  /** Some conversation is replying, being set up, or being sorted into a group. */
  anyRunning(): boolean {
    return this.runs.size > 0 || this.starting.size > 0 || this.grouper.busy;
  }

  /** Running, or reserved by a request that will change it. */
  private isBusy(id: string): boolean {
    return this.runs.has(id) || this.reserved.has(id) || this.deleting.has(id);
  }

  /** Reserve a conversation; the returned function releases it (once). */
  private reserve(convId: string): () => void {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    this.reserved.set(convId, released);
    return () => {
      if (this.reserved.get(convId) === released) this.reserved.delete(convId);
      release();
    };
  }

  /** Why nothing new may start on this conversation now, if anything. */
  private checkAvailable(convId: string, busyMessage: string): void {
    if (this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    if (this.closing) throw new HttpError(503, t().shuttingDown);
    if (this.isBusy(convId)) throw new HttpError(409, busyMessage);
  }

  /**
   * Run `fn` with the conversation reserved: no run, apply or settings change can start on it until
   * `fn` settles (requests in between get 409 `busyMessage`), and a delete waits for it.
   */
  async exclusive<T>(convId: string, busyMessage: string, fn: () => Promise<T>): Promise<T> {
    this.checkAvailable(convId, busyMessage);
    const release = this.reserve(convId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Delete a conversation: let a request that is changing it finish, stop its run and wait until the
   * run has wound down (it still writes its final state), then remove its worktrees, kept snapshot
   * refs and rows.
   */
  async deleteConversation(convId: string): Promise<void> {
    this.deleting.add(convId);
    try {
      // A run being set up gives up when it sees the delete; a settings change or an apply finishes.
      for (let pending = this.reserved.get(convId); pending; pending = this.reserved.get(convId)) await pending;
      const run = this.runs.get(convId);
      if (run) {
        run.abort.abort();
        await run.done;
      }
      await this.grouper.cancel(convId);
      const conv = this.store.get(convId);
      if (conv) await this.cleanupWorktrees(conv);
      this.store.delete(convId);
      this.traces?.forget?.(convId);
    } finally {
      this.deleting.delete(convId);
    }
  }

  /** Every run finished (or `ms` passed): used on shutdown before the database closes. */
  async settled(ms: number): Promise<void> {
    const all = Promise.allSettled([...this.runs.values()].map((r) => r.done).concat(this.grouper.settled()));
    await Promise.race([all, new Promise((r) => setTimeout(r, ms).unref())]);
  }

  activeAgentIds(id: string): string[] {
    return [...(this.runs.get(id)?.active ?? [])];
  }

  /** An agent in this conversation is waiting for the user to approve something. */
  isWaiting(id: string): boolean {
    for (const a of this.approvals.values()) if (a.convId === id) return true;
    return false;
  }

  /** The user's answer to an approval request shown in the chat. */
  answerApproval(convId: string, approvalId: string, answer: ApprovalAnswer): void {
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.convId !== convId) throw new HttpError(404, t().approvalNotFound);
    pending.resolve({ allow: Boolean(answer.allow), always: Boolean(answer.always), note: answer.note ? String(answer.note).slice(0, 2000) : undefined });
  }

  /**
   * Post a user message (or, with empty text, let the team continue) and start the team's turn.
   *
   * While the team replies (or its run is being set up, or the lead agent's team design waits for
   * confirmation) the message waits in the conversation's queue instead: it is posted before the
   * next turn of an agent it is for, and what no turn took starts another run when this one ends
   * (see `deliverQueued`, `startQueued`). `interrupt` stops the team first and sends it, after the
   * messages waiting, now.
   */
  async send(convId: string, rawText: string, uploads?: AttachmentUpload[], interrupt = false): Promise<{ queued: boolean }> {
    const text = rawText.trim();
    const content = Boolean(text || uploads?.length);
    const found = this.store.get(convId);
    if (!found) throw new HttpError(404, t().conversationNotFound);
    if (interrupt && (content || found.queue?.length)) await this.interrupt(convId);
    if (content && this.queues(found)) {
      this.enqueue(found, text, uploads);
      return { queued: true };
    }
    const conv = this.getIdle(convId);
    if (pendingPlan(conv.messages)) throw new HttpError(409, t().planAwaitingConfirm);
    if (!content && !conv.queue?.length && !conv.messages.some((m) => m.author.kind === 'user')) {
      throw new HttpError(400, t().typeFirst);
    }
    const files = saveAttachments(conv.id, uploads);
    try {
      await this.start(conv, text, { files, queue: true });
    } catch (err) {
      removeAttachments(conv.id, files);
      throw err;
    }
    return { queued: false };
  }

  /** Take back a message that is still waiting in the queue (it is returned, e.g. to edit it). */
  withdraw(convId: string, messageId: string): ChatMessage {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const index = conv.queue?.findIndex((m) => m.id === messageId) ?? -1;
    if (index < 0) throw new HttpError(404, t().queuedNotFound);
    const [msg] = conv.queue!.splice(index, 1);
    this.saveQueue(conv);
    removeAttachments(conv.id, attachmentsOf(msg!));
    return msg!;
  }

  /** Stop the conversation's run, if there is one, and wait until it has wound down. */
  private async interrupt(convId: string): Promise<void> {
    const run = this.runs.get(convId);
    if (!run) return;
    run.abort.abort();
    await run.done;
  }

  /** A message sent now waits in the queue (anything else that keeps the conversation busy refuses it). */
  private queues(conv: Conversation): boolean {
    if (this.deleting.has(conv.id) || this.closing) return false;
    return this.runs.has(conv.id) || this.starting.has(conv.id) || Boolean(pendingPlan(conv.messages));
  }

  private enqueue(conv: Conversation, text: string, uploads?: AttachmentUpload[]): void {
    const queue = (conv.queue ??= []);
    if (queue.length >= MAX_QUEUE) throw new HttpError(409, t().queueFull(MAX_QUEUE));
    const files = saveAttachments(conv.id, uploads);
    // Marked only when it joins a team's discussion: not a first question written while the lead
    // agent designs the team or waits for confirmation.
    const midReply = (this.runs.has(conv.id) || this.starting.has(conv.id)) && !conv.settings.autoTeam;
    queue.push({
      id: randomUUID(),
      author: { kind: 'user' },
      createdAt: Date.now(),
      parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
      status: 'done',
      ...(midReply ? { queued: true } : {}),
    });
    try {
      this.saveQueue(conv);
    } catch (err) {
      queue.pop();
      removeAttachments(conv.id, files);
      throw err;
    }
  }

  private saveQueue(conv: Conversation): void {
    this.store.saveQueue(conv);
    this.hub.emit(conv.id, { type: 'queue', queue: conv.queue ?? [] });
  }

  /**
   * Post waiting messages, oldest first, and return them: before a turn, those for `recipients` —
   * one that @mentions only other agents waits for them, and the ones behind it wait too, so the
   * chat keeps the order they were sent in; when a run starts, those in `ids` (sent before it).
   */
  private deliverQueued(conv: Conversation, which: { recipients: AgentConfig[] } | { ids: Set<string> }): ChatMessage[] {
    const queue = conv.queue ?? [];
    const posted: ChatMessage[] = [];
    while (queue.length) {
      const next = queue[0]!;
      if ('ids' in which ? !which.ids.has(next.id) : !isFor(next, which.recipients, conv.agents)) break;
      // Posted before it leaves the saved queue: a crash in between keeps it once, as delivered.
      conv.messages.push(next);
      queue.shift();
      this.store.saveMessage(conv.id, next, true);
      this.hub.emit(conv.id, { type: 'message', message: next });
      this.nameAfter(conv, next);
      posted.push(next);
    }
    if (posted.length) this.saveQueue(conv);
    return posted;
  }

  /**
   * Start a run for the messages still waiting, when nothing else is going on and the team may
   * answer (the lead agent's team design is not waiting for confirmation). Returns whether it starts;
   * a run that fails to start says why in the chat, and its messages keep waiting.
   */
  startQueued(conv: Conversation): boolean {
    if (!conv.queue?.length || this.isBusy(conv.id) || this.closing || this.store.get(conv.id) !== conv) return false;
    if (pendingPlan(conv.messages) || (conv.agents.length === 0 && !conv.settings.autoTeam)) return false;
    // An agent asked the user something: what was written before the question waits for the answer.
    if (conv.pause) return false;
    this.start(conv, '', { queue: true }).catch((err) => {
      if (!(err instanceof HttpError && err.status === 404)) this.systemNote(conv, t().runFailed((err as Error).message));
      this.emitStatus(conv.id);
    });
    return true;
  }

  /**
   * Replace one of the user's messages and run the team again from there: the message and
   * everything after it are deleted. CLI sessions cannot be rewound, so every agent starts a
   * fresh session and is given the remaining history. Files the dropped turns changed stay as they are.
   */
  async resend(convId: string, messageId: string, rawText: string): Promise<void> {
    const conv = this.getIdle(convId);
    const text = rawText.trim();
    const target = conv.messages.find((m) => m.id === messageId);
    if (target?.author.kind !== 'user') throw new HttpError(404, t().messageNotFound);
    // The edited message keeps its attached files.
    const files = target.parts.filter((p): p is AttachmentPart => p.type === 'attachment');
    if (!text && !files.length) throw new HttpError(400, t().emptyMessage);
    await this.start(conv, text, {
      beforePost: () => this.truncateFrom(conv, messageId, files),
      willPlan: this.replans(conv, messageId),
      files,
    });
  }

  /**
   * Let an agent answer again: its reply and everything after it are deleted (like editing a
   * message), then that agent speaks again — followed, outside relay mode, by the agents of the
   * same round whose replies were dropped with it.
   */
  async retry(convId: string, messageId: string): Promise<void> {
    const conv = this.getIdle(convId);
    const index = conv.messages.findIndex((m) => m.id === messageId);
    const target = conv.messages[index];
    if (target?.author.kind !== 'agent') throw new HttpError(404, t().messageNotFound);
    const agentOf = (m: ChatMessage) => {
      const author = m.author;
      return author.kind === 'agent' ? conv.agents.find((a) => a.id === author.agentId) : undefined;
    };
    const first = agentOf(target);
    if (!first) throw new HttpError(400, t().retryAgentGone(target.agentName ?? 'agent'));
    const again = [first];
    if (conv.settings.mode !== 'relay') {
      for (const m of conv.messages.slice(index + 1)) {
        if (m.author.kind === 'user') break; // a later message started another run
        const a = agentOf(m);
        if (a && m.meta?.round === target.meta?.round && !again.includes(a)) again.push(a);
      }
    }
    await this.start(conv, '', { beforePost: () => this.truncateFrom(conv, messageId), only: again });
  }

  private getIdle(convId: string): Conversation {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    this.checkAvailable(convId, t().busy);
    if (conv.agents.length === 0 && !conv.settings.autoTeam) throw new HttpError(400, t().noAgents);
    return conv;
  }

  /**
   * Whether dropping `messageId` and what follows makes the lead agent design the team again: the
   * lead's plan goes with it, and the team is still the one it designed (a team adjusted by hand
   * afterwards is kept).
   */
  private replans(conv: Conversation, messageId: string): boolean {
    const index = conv.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    const plans = conv.messages.slice(index).filter((m) => m.plan?.status === 'ready');
    const latest = plans[plans.length - 1]?.plan;
    return Boolean(latest && sameTeam(latest, conv));
  }

  /**
   * Drop a message and everything after it, and make every agent start over. `keep`: attached files
   * that live on in the edited message.
   */
  private truncateFrom(conv: Conversation, messageId: string, keep: AttachmentPart[] = []): void {
    const index = conv.messages.findIndex((m) => m.id === messageId);
    if (index < 0) throw new HttpError(404, t().messageNotFound);
    const replan = this.replans(conv, messageId);
    const dropped = conv.messages.splice(index);
    this.store.deleteMessages(conv.id, dropped.map((m) => m.id));
    const kept = new Set(keep.map((p) => p.id));
    removeAttachments(
      conv.id,
      dropped.flatMap((m) => m.parts.filter((p): p is AttachmentPart => p.type === 'attachment' && !kept.has(p.id))),
    );
    void this.forgetChanges(conv, dropped).catch((err) =>
      console.warn('[orchestrator] snapshot ref cleanup failed:', (err as Error).message),
    );
    for (const agentId of new Set([...Object.keys(conv.agentState), ...conv.agents.map((a) => a.id)])) {
      const state: AgentSessionState = { provider: conv.agentState[agentId]?.provider, seen: [] };
      conv.agentState[agentId] = state;
      this.store.saveAgentState(conv.id, agentId, state);
    }
    // Parallel worktrees hold the dropped turns' work: start them again from the working directory.
    for (const [agentId, w] of Object.entries(conv.worktrees)) {
      w.needsReset = true;
      this.store.saveWorktree(conv.id, agentId, w);
    }
    // The lead agent's team design went too: design the team again for the edited request.
    if (replan) conv.settings = { ...conv.settings, autoTeam: true };
    // Whatever question the team waited on is answered by starting over from here.
    conv.pause = undefined;
    this.hub.emit(conv.id, { type: 'snapshot', conversation: forClient(conv), running: false, activeAgentIds: [] });
  }

  /** Start a run that posts `text` (if any) as the user's message; see `StartOptions`. */
  private async start(conv: Conversation, text: string, opts: StartOptions = {}): Promise<void> {
    const { beforePost, only, willPlan = false, files = [] } = opts;
    const convId = conv.id;
    // Reserved until the run is registered, so a settings change or an apply cannot slip in while the
    // workspace is prepared, and a delete waits for it; a message sent meanwhile waits in the queue.
    const release = this.reserve(convId);
    this.starting.add(convId);
    // Messages queued from now on were sent after this one: they wait for the first turn.
    const ahead = opts.queue ? new Set((conv.queue ?? []).map((m) => m.id)) : undefined;
    let lockRoot: string | undefined;
    let run: Run;
    let posted: ChatMessage[] = [];
    let resume: Schedule | undefined;
    try {
      const ws = await this.prepareWorkspace(conv);
      // Deleted meanwhile (the delete may even have finished already), or the server is stopping.
      if (this.deleting.has(convId) || this.store.get(convId) !== conv) {
        throw new HttpError(404, t().conversationNotFound);
      }
      if (this.closing) throw new HttpError(503, t().shuttingDown);
      // A run that designs the team writes nothing (the lead agent is read-only and nobody else
      // speaks), so it locks nothing.
      const planning = (conv.settings.autoTeam || willPlan) && !only;
      lockRoot = ws.root && !ws.isolated && !planning ? ws.root : undefined;
      if (lockRoot) this.lockDir(lockRoot, conv);
      beforePost?.();
      if (ahead) posted = this.deliverQueued(conv, { ids: ahead });
      const own = this.postUserMessage(conv, text, files);
      if (own) posted.push(own);
      resume = this.takePause(conv, posted, only);
      run = { abort: new AbortController(), active: new Set(), ws, lockRoot, done: Promise.resolve() };
      this.runs.set(convId, run);
    } catch (err) {
      if (lockRoot && !this.runs.has(convId)) this.unlockDir(lockRoot, convId);
      throw err;
    } finally {
      this.starting.delete(convId);
      release();
    }
    this.emitStatus(conv.id);

    run.done = this.execute(conv, posted, run, only, resume)
      .catch((err) => {
        console.error('[orchestrator] run failed:', err);
        this.systemNote(conv, t().runFailed((err as Error).message));
      })
      .finally(() => {
        try {
          if (run.abort.signal.aborted) this.systemNote(conv, t().stoppedNote);
          conv.updatedAt = Date.now();
          this.store.flush(conv.id);
          this.store.saveMeta(conv);
        } catch (err) {
          console.error('[orchestrator] could not save the end of a run:', err);
        } finally {
          if (run.lockRoot) this.unlockDir(run.lockRoot, conv.id);
          this.runs.delete(convId);
          // Messages sent while the team replied that no turn took: the team answers them now. After
          // Stop they keep waiting, for the user to send or withdraw.
          if (run.abort.signal.aborted || !this.startQueued(conv)) this.emitStatus(conv.id);
          this.trace(conv);
        }
      });
  }

  /**
   * A session the conversation started besides its members' (the lead agent's, the group sorter's):
   * filed under it in AgentsView now, also when it ends after the run (the sorter often does).
   */
  private linkSession(conv: Conversation, provider: Provider, sessionId: string): void {
    if (this.deleting.has(conv.id) || this.store.get(conv.id) !== conv) return;
    try {
      this.traces?.link?.(conv, provider, sessionId);
    } catch (err) {
      console.warn('[orchestrator] could not tell AgentsView:', (err as Error).message);
    }
    this.trace(conv);
  }

  /** Folders snapshots never take in: the CLIs' own homes, with their sign-ins and transcripts. */
  private snapshotExcludes(): string[] {
    return this.settings.agentHome ? [this.settings.agentHome] : [];
  }

  /** Send the conversation to AgentsView, unless it is being deleted (a run winding down after the delete). */
  trace(conv: Conversation): void {
    if (this.deleting.has(conv.id) || this.store.get(conv.id) !== conv) return;
    try {
      this.traces?.schedule(conv);
    } catch (err) {
      console.warn('[orchestrator] could not tell AgentsView:', (err as Error).message);
    }
  }

  /** Post the user's message (none for Continue / retry) and name the conversation after it. */
  private postUserMessage(conv: Conversation, text: string, files: AttachmentPart[]): ChatMessage | undefined {
    let msg: ChatMessage | undefined;
    if (text || files.length) {
      msg = {
        id: randomUUID(),
        author: { kind: 'user' },
        createdAt: Date.now(),
        parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
        status: 'done',
      };
      conv.messages.push(msg);
      this.store.saveMessage(conv.id, msg, true);
      this.hub.emit(conv.id, { type: 'message', message: msg });
      this.nameAfter(conv, msg);
      // The first message says what the conversation is about: sort it into one of the user's groups.
      if (conv.messages.filter((m) => m.author.kind === 'user').length === 1) this.grouper.start(conv, questionOf(msg));
    }
    conv.updatedAt = Date.now();
    this.store.saveMeta(conv);
    return msg;
  }

  /** A conversation still called "New chat" is named after the first line of the user's message. */
  private nameAfter(conv: Conversation, msg: ChatMessage): void {
    if (!isDefaultTitle(conv.title)) return;
    const line = (textOf(msg).split('\n')[0] ?? '').trim() || attachmentsOf(msg)[0]?.name;
    if (!line) return;
    conv.title = line.length > 40 ? line.slice(0, 39) + '…' : line;
    this.emitConversation(conv);
  }

  stop(convId: string): void {
    this.runs.get(convId)?.abort.abort();
  }

  /** Shutting down: stop every run, and refuse new runs, applies and settings changes. */
  stopAll(): void {
    this.closing = true;
    for (const r of this.runs.values()) r.abort.abort();
    this.grouper.stopAll();
  }

  emitConversation(conv: Conversation): void {
    this.hub.emit(conv.id, {
      type: 'conversation',
      title: conv.title,
      agents: conv.agents,
      settings: conv.settings,
      worktrees: conv.worktrees,
      pause: conv.pause,
    });
  }

  // Workspace ---------------------------------------------------------------

  /** Agents that may write need a git repository (created automatically) to track and isolate changes. */
  async prepareWorkspace(conv: Conversation): Promise<RunWorkspace> {
    if (conv.settings.permission === 'read-only') return { isolated: false };
    const { root, created } = await ensureRepo(conv.settings.cwd);
    if (created) this.systemNote(conv, t().gitInitNote(root));
    return { root, isolated: conv.settings.mode === 'parallel' };
  }

  /**
   * Lock a directory for this conversation's writes. Another conversation's lock on the same
   * directory, or on one inside or around it (nested repositories), conflicts.
   */
  private lockDir(root: string, conv: Conversation): void {
    const within = (a: string, b: string) => a.startsWith(b.endsWith(sep) ? b : b + sep);
    for (const [held, holder] of this.dirLocks) {
      if (holder !== conv.id && (held === root || within(held, root) || within(root, held))) {
        const title = this.store.get(holder)?.title ?? holder;
        throw new HttpError(409, t().dirLocked(title, held));
      }
    }
    this.dirLocks.set(root, conv.id);
  }

  private unlockDir(root: string, convId: string): void {
    if (this.dirLocks.get(root) === convId) this.dirLocks.delete(root);
  }

  /**
   * An approved action in a run that holds no directory lock (read-only, which never locks) writes
   * the shared directory too: take the lock first. Returns why it cannot, when another conversation
   * is writing there (the action is then declined).
   */
  private lockForApproval(conv: Conversation, run: Run, cwd: string): string | undefined {
    if (run.ws.isolated || run.lockRoot) return undefined;
    let dir: string;
    try {
      dir = realpathSync(cwd);
    } catch {
      return undefined;
    }
    try {
      this.lockDir(dir, conv);
      run.lockRoot = dir;
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** Give every participant its own worktree, starting from a snapshot of the working directory. */
  private async prepareWorktrees(conv: Conversation, agents: AgentConfig[], root: string): Promise<void> {
    let base: string | undefined;
    for (const a of agents) {
      const cur = conv.worktrees[a.id];
      if (cur && cur.root === root && !cur.needsReset && existsSync(cur.path)) continue;
      if (cur && cur.root !== root) await removeWorktree(cur.root, cur.path, cur.branch).catch(() => {});
      base ??= (await snapshot(root, this.snapshotExcludes())).commit;
      const reuse = cur && cur.root === root;
      const wt: AgentWorktree = {
        root,
        path: reuse ? cur.path : join(DATA_DIR, 'worktrees', conv.id, a.id),
        branch: reuse ? cur.branch : `relay/${conv.id.slice(0, 8)}/${a.name}`,
        base,
        needsReset: false,
      };
      await createWorktree(root, wt.path, wt.branch, base);
      conv.worktrees[a.id] = wt;
      this.store.saveWorktree(conv.id, a.id, wt);
    }
    this.emitConversation(conv);
  }

  /** Apply everything an agent did in its worktree to the real working directory (uncommitted). */
  async applyAgentWork(convId: string, agentId: string): Promise<FileChange[]> {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    const wt = conv.worktrees[agentId];
    if (!wt) throw new HttpError(404, t().noWorktree);
    if (wt.needsReset) throw new HttpError(409, t().resultStale);
    // Reserved, so the team cannot start writing (and take over this lock) while the patch is applied.
    return this.exclusive(convId, t().busyApply, async () => {
      this.lockDir(wt.root, conv);
      try {
        const files = await applyToWorkingTree(wt.root, wt.base, await worktreeHead(wt.path));
        for (const [id, w] of Object.entries(conv.worktrees)) {
          w.needsReset = true;
          this.store.saveWorktree(conv.id, id, w);
        }
        const name = conv.agents.find((a) => a.id === agentId)?.name ?? agentId;
        this.systemNote(conv, t().appliedNote(name, files.length));
        this.emitConversation(conv);
        return files;
      } finally {
        this.unlockDir(wt.root, conv.id);
      }
    });
  }

  async messageDiff(convId: string, messageId: string): Promise<string> {
    const msg = this.store.get(convId)?.messages.find((m) => m.id === messageId);
    if (!msg?.changes) throw new HttpError(404, t().noChanges);
    return diffText(msg.changes.root, msg.changes.base, msg.changes.head);
  }

  async agentDiff(convId: string, agentId: string): Promise<string> {
    const wt = this.store.get(convId)?.worktrees[agentId];
    if (!wt) throw new HttpError(404, t().noWorktree);
    return diffText(wt.root, wt.base, await worktreeHead(wt.path));
  }

  /**
   * Auto team: the lead agent (Settings) picks a template or designs a team for the user's request, shown
   * as a plan card. When planning fails the general-question template is used; when it is stopped
   * the conversation stays in auto-team mode and plans again on the next message.
   */
  private async designTeam(conv: Conversation, run: Run): Promise<void> {
    const lead = this.settings.lead;
    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'system' },
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
      plan: { status: 'planning', lead },
    };
    conv.messages.push(msg);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);

    // Everything the user said since the last team design: a stopped design leaves its request
    // standing, and messages sent while the lead worked add to it.
    const since = conv.messages.findLastIndex((m) => m.plan?.status === 'ready') + 1;
    const asked = conv.messages.slice(since).filter((m) => m.author.kind === 'user');
    const fileNames = asked.flatMap((m) => attachmentsOf(m).map((p) => p.name));
    const question =
      asked.map(textOf).filter(Boolean).join('\n\n') + (fileNames.length ? `\n\n(Attached files: ${fileNames.join(', ')})` : '');
    const started = Date.now();
    let ctx: PlannerContext = { available: [], catalog: [], presets: this.store.listPresets() };
    let decision: PlanDecision | undefined;
    let result: RunResult | undefined;
    try {
      ctx = await this.planner.context();
      let reply = '';
      result = await runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider),
        nativeOff: this.settings.nativeOff(lead.provider),
        nativeItems: this.settings.nativeItems(lead.provider),
        prompt: buildPlannerPrompt(question, conv.settings, ctx),
        systemPrompt: PLANNER_BRIEFING,
        cwd: conv.settings.cwd,
        permission: 'read-only',
        model: lead.model || this.settings.defaultModel(lead.provider) || undefined,
        effort: lead.effort || this.settings.defaultEffort(lead.provider) || undefined,
        signal: run.abort.signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
      // The lead agent's session belongs to this conversation too.
      if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
      decision = decidePlan(parsePlanReply(reply), ctx, lead);
    } catch (err) {
      if (!run.abort.signal.aborted) {
        console.warn('[orchestrator] team design failed:', (err as Error).message);
        decision = fallbackPlan(ctx, lead, (err as Error).message);
      }
    }

    msg.meta = {
      durationMs: Date.now() - started,
      costUsd: result?.costUsd,
      inputTokens: result?.inputTokens,
      outputTokens: result?.outputTokens,
    };
    if (run.abort.signal.aborted || !decision) {
      msg.status = 'aborted';
    } else {
      conv.agents = decision.agents;
      conv.settings = { ...conv.settings, ...decision.settings, autoTeam: false };
      msg.plan = { status: 'ready', lead, ...decision, awaitingConfirmation: true };
      msg.status = 'done';
      this.store.saveMeta(conv);
      this.emitConversation(conv);
    }
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /** The user accepts the lead agent's team design; from now on the team answers. */
  confirmPlan(convId: string, messageId: string): void {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const msg = conv.messages.find((m) => m.id === messageId);
    if (msg?.plan?.status !== 'ready') throw new HttpError(404, t().planNotFound);
    // A question written while the team waited for confirmation goes to the team now.
    if (this.markConfirmed(conv, msg)) this.startQueued(conv);
  }

  /**
   * A team set by hand is the user's decision too: it confirms a design that was waiting. Returns
   * whether it did (the caller then starts the questions waiting, `startQueued`).
   */
  confirmPendingPlan(conv: Conversation): boolean {
    const msg = pendingPlan(conv.messages);
    return msg ? this.markConfirmed(conv, msg) : false;
  }

  private markConfirmed(conv: Conversation, msg: ChatMessage): boolean {
    if (!msg.plan?.awaitingConfirmation) return false;
    delete msg.plan.awaitingConfirmation;
    msg.plan.confirmedAt = Date.now();
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    return true;
  }

  /** Save a team the lead agent designed or adapted as a user template. */
  savePlanAsPreset(convId: string, messageId: string, name?: string): TeamPreset {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const msg = conv.messages.find((m) => m.id === messageId);
    const plan = msg?.plan;
    if (!msg || plan?.status !== 'ready') throw new HttpError(404, t().planNotFound);
    if (!planSavable(plan) || !plan.agents?.length || !plan.settings) throw new HttpError(400, t().planNotSavable);
    // Saving again returns the template already saved from this plan.
    const saved = plan.savedPresetId && this.store.listPresets().find((p) => p.id === plan.savedPresetId);
    if (saved) return saved;
    const preset: TeamPreset = {
      id: `user-${randomUUID()}`,
      name: (name?.trim() || plan.name || plan.agents.map((a) => a.name).join(' · ')).slice(0, MAX_PRESET_NAME),
      description: plan.description,
      agents: plan.agents.map((a) => ({ ...a, id: randomUUID() })),
      settings: { ...plan.settings, permission: conv.settings.permission },
    };
    this.store.savePreset(preset);
    plan.savedPresetId = preset.id;
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    return preset;
  }

  /** Stop keeping the commits of dropped messages that no remaining message links to. */
  private async forgetChanges(conv: Conversation, dropped: ChatMessage[]): Promise<void> {
    const inUse = new Set(conv.messages.flatMap((m) => (m.changes ? [m.changes.base, m.changes.head] : [])));
    const byRoot = new Map<string, string[]>();
    for (const m of dropped) {
      if (!m.changes) continue;
      const commits = [m.changes.base, m.changes.head].filter((c) => !inUse.has(c));
      byRoot.set(m.changes.root, [...(byRoot.get(m.changes.root) ?? []), ...commits]);
    }
    for (const [root, commits] of byRoot) await forgetCommits(root, conv.id, commits);
  }

  /** Remove a conversation's worktrees and branches, and the snapshot refs it kept (before deleting it). */
  async cleanupWorktrees(conv: Conversation): Promise<void> {
    for (const wt of Object.values(conv.worktrees)) {
      await removeWorktree(wt.root, wt.path, wt.branch).catch((err) =>
        console.warn('[orchestrator] worktree cleanup failed:', (err as Error).message),
      );
    }
    rmSync(join(DATA_DIR, 'worktrees', conv.id), { recursive: true, force: true });
    removeAttachments(conv.id);
    const cwdRoot = await repoRoot(conv.settings.cwd).catch(() => null);
    const roots = new Set([
      ...Object.values(conv.worktrees).map((w) => w.root),
      ...conv.messages.flatMap((m) => (m.changes ? [m.changes.root] : [])),
      ...(cwdRoot ? [cwdRoot] : []),
    ]);
    for (const root of roots) {
      await dropKeptCommits(root, conv.id).catch((err) =>
        console.warn('[orchestrator] snapshot ref cleanup failed:', (err as Error).message),
      );
    }
  }

  // -------------------------------------------------------------------------

  /**
   * The team's turns for the user's `posted` messages (none for Continue / retry). Messages sent while
   * it runs are delivered before the next turn of an agent they are for (`deliverQueued`). A reply that
   * asks the user something stops the run there (`pauseFor`); `resume` picks it up once they replied.
   */
  private async execute(
    conv: Conversation,
    posted: ChatMessage[],
    run: Run,
    only?: AgentConfig[],
    resume?: Schedule,
  ): Promise<void> {
    if (conv.settings.autoTeam && !only) {
      // The user described what they need: the lead agent designs the team, and that is all this
      // run does. The user confirms the team, then asks their first question.
      await this.designTeam(conv, run);
      return;
    }
    const { mode, maxHops } = conv.settings;
    const s = resume ?? this.schedule(conv, posted, only);
    const aborted = () => run.abort.signal.aborted;
    const spoke = (m: ChatMessage) => m.status === 'done' && !m.passed;
    const ids = (agents: AgentConfig[]) => agents.map((a) => a.id);
    /** The user's reply answers this agent's question (it is told on this turn only). */
    const answered = (a: AgentConfig) => s.answering.delete(a.id);

    if (mode === 'relay') {
      const queue = [...s.first];
      let hopsLeft = s.hopsLeft;
      while (queue.length && !aborted()) {
        if (hopsLeft <= 0) {
          this.systemNote(conv, t().relayLimit(maxHops));
          break;
        }
        const { agent, handedBy } = queue.shift()!;
        hopsLeft--;
        this.deliverQueued(conv, { recipients: [agent] });
        const msg = await this.turn(conv, agent, run, { mode, round: 1, rounds: 1, handedBy, hopsLeft, answered: answered(agent) });
        if (msg.asked) {
          const rest = queue.map((q) => ({ agentId: q.agent.id, handedBy: q.handedBy }));
          this.pauseFor(conv, { mode, askers: [agent.id], rest, participants: [], round: 1, rounds: 1, hopsLeft });
          return;
        }
        if (!spoke(msg)) continue;
        for (const next of parseMentions(textOf(msg), conv.agents, agent.id)) {
          if (!queue.some((q) => q.agent.id === next.id)) queue.push({ agent: next, handedBy: agent.name });
        }
      }
      return;
    }

    if (mode === 'parallel' && run.ws.isolated) await this.prepareWorktrees(conv, s.participants, run.ws.root!);

    for (let round = s.round; round <= s.rounds && !aborted(); round++) {
      const speakers = round === s.round ? s.first.map((f) => f.agent) : s.participants;
      const info = (a: AgentConfig): TurnInfo => ({ mode, round, rounds: s.rounds, answered: answered(a) });
      const pause = (askers: AgentConfig[], rest: AgentConfig[]) =>
        this.pauseFor(conv, {
          mode,
          askers: ids(askers),
          rest: rest.map((a) => ({ agentId: a.id })),
          participants: ids(s.participants),
          round,
          rounds: s.rounds,
        });
      const msgs: ChatMessage[] = [];
      if (mode === 'parallel') {
        if (!speakers.length) continue; // the user let the team go on without answering
        // The round's turns run side by side: they all see what was sent before it starts.
        this.deliverQueued(conv, { recipients: speakers });
        // Every turn settles before the run can end, even when one of them fails.
        const settled = await Promise.allSettled(speakers.map((a) => this.turn(conv, a, run, info(a))));
        const failed = settled.find((r) => r.status === 'rejected');
        if (failed) throw failed.reason;
        msgs.push(...settled.map((r) => (r as PromiseFulfilledResult<ChatMessage>).value));
        // The others answered already; the ones that asked answer again once the user replied.
        const askers = speakers.filter((_, i) => msgs[i]!.asked);
        if (askers.length) return pause(askers, []);
      } else {
        for (const [i, a] of speakers.entries()) {
          if (aborted()) break;
          this.deliverQueued(conv, { recipients: [a] });
          const msg = await this.turn(conv, a, run, info(a));
          msgs.push(msg);
          if (msg.asked) return pause([a], speakers.slice(i + 1));
        }
      }
      if (msgs.length && !msgs.some(spoke)) break; // everyone passed: the discussion has converged
    }
  }

  /** Who speaks in a run the user's `posted` messages (or Continue, or a retry of `only`) start. */
  private schedule(conv: Conversation, posted: ChatMessage[], only?: AgentConfig[]): Schedule {
    const mentioned = only ?? mentionsOf(posted, conv.agents);
    const participants = mentioned.length ? mentioned : conv.agents;
    // Relay: the mentioned agents start (a retry: just the one), or the leader.
    const first =
      conv.settings.mode === 'relay'
        ? mentioned.length
          ? mentioned.slice(0, only ? 1 : undefined)
          : [conv.agents[0]!]
        : participants;
    return {
      participants,
      round: 1,
      rounds: only ? 1 : conv.settings.rounds,
      first: first.map((agent) => ({ agent })),
      hopsLeft: conv.settings.maxHops,
      answering: new Set(),
    };
  }

  /** An agent asked the user something: the run stops here, and the team waits for the answer. */
  private pauseFor(conv: Conversation, pause: RunPause): void {
    conv.pause = pause;
    this.store.saveMeta(conv);
    this.emitConversation(conv);
  }

  /**
   * The user replied while the team waited for an answer: the team picks up where it stopped, and
   * the agents that asked answer first — unless the reply is Continue (nothing posted), which lets
   * the others go on without them. A reply that @mentions anyone else, a retry, a team design or a
   * changed mode starts afresh, as does Continue with nobody left to speak. Either way the team no
   * longer waits.
   */
  private takePause(conv: Conversation, posted: ChatMessage[], only?: AgentConfig[]): Schedule | undefined {
    const pause = conv.pause;
    if (!pause) return undefined;
    conv.pause = undefined;
    this.store.saveMeta(conv);
    this.emitConversation(conv);
    if (only || conv.settings.autoTeam || pause.mode !== conv.settings.mode) return undefined;
    if (posted.some((m) => parseMentions(textOf(m), conv.agents).some((a) => !pause.askers.includes(a.id)))) return undefined;
    const byId = (id: string) => conv.agents.find((a) => a.id === id);
    const askers = pause.askers.flatMap((id) => byId(id) ?? []);
    const skip = posted.length === 0;
    const rest = pause.rest.flatMap((r) => {
      const agent = byId(r.agentId);
      return agent ? [{ agent, handedBy: r.handedBy }] : [];
    });
    const first = [...(skip ? [] : askers.map((agent) => ({ agent }))), ...rest];
    if (!first.length && (pause.mode === 'relay' || pause.round >= pause.rounds)) return undefined;
    const participants = pause.participants.flatMap((id) => byId(id) ?? []);
    return {
      participants: participants.length ? participants : conv.agents,
      round: pause.round,
      rounds: pause.rounds,
      first,
      hopsLeft: pause.hopsLeft ?? conv.settings.maxHops,
      answering: new Set(skip ? [] : askers.map((a) => a.id)),
    };
  }

  /** One agent turn: build its prompt, run the CLI, stream into a new chat message. */
  private async turn(conv: Conversation, agent: AgentConfig, run: Run, info: TurnInfo): Promise<ChatMessage> {
    const state: AgentSessionState = (conv.agentState[agent.id] ??= { seen: [] });
    if (state.provider && state.provider !== agent.provider) {
      state.sessionId = undefined;
      state.seen = [];
    }
    state.provider = agent.provider;

    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'agent', agentId: agent.id },
      agentName: agent.name,
      provider: agent.provider,
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
      meta: info.mode === 'relay' ? {} : { round: info.round },
    };
    conv.messages.push(msg);
    this.store.saveMessage(conv.id, msg, true);
    run.active.add(agent.id);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.emitStatus(conv.id);

    // Where this agent works, and the state before its turn (to record what it changed).
    const wt = run.ws.isolated ? conv.worktrees[agent.id] : undefined;
    let cwd = conv.settings.cwd;
    let workspace: BriefingWorkspace = { kind: 'shared' };
    let before: { commit: string; tree?: string } | undefined;
    let setupError: unknown;
    try {
      if (wt) {
        cwd = worktreeCwd(wt.root, conv.settings.cwd, wt.path);
        workspace = {
          kind: 'isolated',
          cwd,
          branch: wt.branch,
          base: wt.base,
          teammates: conv.agents
            .filter((a) => a.id !== agent.id && conv.worktrees[a.id] && !conv.worktrees[a.id]!.needsReset)
            .map((a) => ({ name: a.name, branch: conv.worktrees[a.id]!.branch, base: conv.worktrees[a.id]!.base })),
        };
      }
    } catch (err) {
      setupError = err; // reported as this turn's error below
    }
    try {
      if (wt && !setupError) before = { commit: await worktreeHead(wt.path) };
      else if (run.ws.root && !wt) before = await snapshot(run.ws.root, this.snapshotExcludes());
    } catch (err) {
      console.warn('[orchestrator] could not snapshot before turn:', (err as Error).message);
    }

    let textOpen = false;
    /** What this agent had seen before the current attempt (what a crash mid-turn should keep). */
    let committedSeen = state.seen;
    /** Approval requests of this turn still waiting for the user (expired when the turn ends). */
    const waiting = new Set<string>();
    /** The session was rolled back to the one before this turn (a fresh retry failed too). */
    let keptOldSession = false;
    const onEvent = (e: AgentEvent) => {
      switch (e.type) {
        case 'session':
          if (state.sessionId !== e.sessionId) {
            state.sessionId = e.sessionId;
            // Keep it even if the server dies mid-turn, but without this turn's messages: they count
            // as delivered only once the turn ends, so a crash offers them again.
            this.store.saveAgentState(conv.id, agent.id, { ...state, seen: committedSeen });
          }
          return;
        case 'text': {
          const last = msg.parts[msg.parts.length - 1];
          if (textOpen && last?.type === 'text') last.text += e.text;
          else msg.parts.push({ type: 'text', text: e.text });
          textOpen = true;
          this.hub.emit(conv.id, { type: 'delta', messageId: msg.id, partIndex: msg.parts.length - 1, text: e.text });
          break;
        }
        case 'text_end':
          textOpen = false;
          return;
        case 'thinking': {
          textOpen = false;
          const last = msg.parts[msg.parts.length - 1];
          if (last?.type === 'thinking') {
            last.text += e.text;
            this.hub.emit(conv.id, { type: 'delta', messageId: msg.id, partIndex: msg.parts.length - 1, text: e.text });
          } else {
            msg.parts.push({ type: 'thinking', text: e.text });
            this.hub.emit(conv.id, { type: 'message', message: msg });
          }
          break;
        }
        case 'plan': {
          const current = msg.parts.find((p) => p.type === 'plan');
          if (current?.type === 'plan') current.entries = e.entries;
          else {
            textOpen = false;
            msg.parts.push({ type: 'plan', entries: e.entries });
          }
          this.hub.emit(conv.id, { type: 'message', message: msg });
          break;
        }
        case 'tool_start':
          textOpen = false;
          msg.parts.push({ type: 'tool', id: e.id, name: e.name, detail: e.detail, status: 'running' });
          this.hub.emit(conv.id, { type: 'message', message: msg });
          break;
        case 'tool_end': {
          const part = msg.parts.find((p) => p.type === 'tool' && p.id === e.id);
          if (part?.type === 'tool') {
            part.status = e.ok ? 'done' : 'error';
            if (e.error) part.error = e.error;
            if (e.output) part.output = e.output;
            this.hub.emit(conv.id, { type: 'message', message: msg });
          }
          break;
        }
      }
      this.store.saveMessage(conv.id, msg);
    };

    // Ask the user in the chat; the CLI waits until they answer (or the run is stopped).
    const requestApproval =
      conv.settings.approvals === 'deny'
        ? undefined
        : async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
            // Keys come from the command as it will run; `detail` may be tidied up for display.
            const keys = approvalKeys(req.kind, req.command ?? req.detail, req.tool);
            const part: Extract<MessagePart, { type: 'approval' }> = {
              type: 'approval',
              id: randomUUID(),
              kind: req.kind,
              tool: req.tool,
              detail: req.detail,
              reason: req.reason,
              ruleLabel: keys.join(', ') || undefined,
              status: 'pending',
            };
            textOpen = false;
            msg.parts.push(part);
            if (isAllowed(conv.allowRules, req.kind, keys)) {
              const busy = this.lockForApproval(conv, run, cwd);
              Object.assign(part, busy ? { status: 'denied', note: busy } : { status: 'allowed', always: true, auto: true });
              this.hub.emit(conv.id, { type: 'message', message: msg });
              this.store.saveMessage(conv.id, msg, true);
              return busy ? { allow: false, note: busy } : { allow: true };
            }
            this.hub.emit(conv.id, { type: 'message', message: msg });
            this.store.saveMessage(conv.id, msg, true);

            waiting.add(part.id);
            let answer = await new Promise<ApprovalAnswer & { expired?: boolean }>((resolve) => {
              const onAbort = () => resolve({ allow: false, expired: true });
              run.abort.signal.addEventListener('abort', onAbort, { once: true });
              this.approvals.set(part.id, {
                convId: conv.id,
                resolve: (a) => {
                  run.abort.signal.removeEventListener('abort', onAbort);
                  resolve(a);
                },
              });
              this.emitStatus(conv.id);
              if (run.abort.signal.aborted) onAbort();
            });
            waiting.delete(part.id);
            this.approvals.delete(part.id);
            const busy = answer.allow ? this.lockForApproval(conv, run, cwd) : undefined;
            if (busy) answer = { allow: false, note: busy };
            part.status = answer.expired ? 'expired' : answer.allow ? 'allowed' : 'denied';
            if (answer.allow && answer.always) {
              part.always = true;
              const rules = conv.allowRules ?? [];
              for (const key of keys) if (!isAllowed(rules, req.kind, [key])) rules.push({ kind: req.kind, key });
              conv.allowRules = rules;
              this.store.saveMeta(conv);
            }
            if (!answer.allow && answer.note?.trim()) part.note = answer.note.trim();
            this.hub.emit(conv.id, { type: 'message', message: msg });
            this.store.saveMessage(conv.id, msg, true);
            this.emitStatus(conv.id);
            return { allow: answer.allow, note: part.note };
          };

    const attempt = async (fresh: boolean): Promise<RunResult> => {
      if (fresh) {
        state.sessionId = undefined;
        state.seen = [];
        msg.parts = [];
        textOpen = false;
        this.hub.emit(conv.id, { type: 'message', message: msg });
      }
      const seen = new Set(state.seen);
      // Everything this agent hasn't been shown yet, including its own earlier replies when starting fresh.
      // Messages still streaming (parallel peers) stay unseen and are delivered next turn.
      const delta = conv.messages.filter((m) => m.id !== msg.id && isForwardable(m) && !seen.has(m.id));
      const prompt = buildTurnPrompt(conv, agent, delta, !state.sessionId, info);
      const files = delta.flatMap((m) =>
        m.author.kind === 'user' ? m.parts.filter((p): p is AttachmentPart => p.type === 'attachment') : [],
      );
      const seenBefore = state.seen;
      committedSeen = seenBefore;
      state.seen = [...state.seen, ...delta.map((m) => m.id)];
      // Read on every turn, so library changes reach agents at their next turn.
      const tools = this.settings.tools.forAgent(agent);
      const nativeOff = this.settings.nativeOff(agent.provider);
      const nativeItems = this.settings.nativeItems(agent.provider);
      try {
        const result = await runners[agent.provider].run({
          bin: this.settings.bin(agent.provider),
          env: this.settings.env(agent.provider),
          nativeOff,
          nativeItems,
          prompt,
          systemPrompt: buildBriefing(conv, agent, workspace, tools, nativeOff, nativeItems),
          sessionId: state.sessionId,
          cwd,
          permission: conv.settings.permission,
          model: agent.model?.trim() || this.settings.defaultModel(agent.provider) || undefined,
          effort: agent.effort?.trim() || this.settings.defaultEffort(agent.provider) || undefined,
          signal: run.abort.signal,
          onEvent,
          requestApproval,
          images: imageInputs(conv.id, files),
          attachmentsDir: files.length ? attachmentsDir(conv.id) : undefined,
          mcpServers: tools.mcpServers,
          readDirs: tools.skills.map((s) => s.dir),
        });
        if (result.sessionId) state.sessionId = result.sessionId;
        return result;
      } catch (err) {
        state.seen = seenBefore; // not delivered; offer it again next turn
        throw err;
      }
    };

    const started = Date.now();
    try {
      if (setupError) throw setupError;
      const hadSession = Boolean(state.sessionId);
      let result: RunResult;
      try {
        result = await attempt(false);
      } catch (err) {
        // A stale or missing CLI session (e.g. the working directory changed): start over with full history.
        const aborted = err instanceof AgentRunError && err.aborted;
        if (!hadSession || aborted || msg.parts.length > 0) throw err;
        console.warn(`[orchestrator] resume failed for @${agent.name}, retrying fresh:`, (err as Error).message);
        const kept = { sessionId: state.sessionId, seen: state.seen };
        try {
          result = await attempt(true);
        } catch (freshErr) {
          // The fresh session failed too before saying anything (rate limit, sign-in, network…): the
          // problem was not the session, so keep it for the next turn.
          if (msg.parts.length === 0) {
            Object.assign(state, kept);
            keptOldSession = true;
          }
          throw freshErr;
        }
      }
      if (takeAsk(msg)) msg.asked = true;
      const text = textOf(msg);
      msg.passed = isPass(text) || (!text && !msg.parts.some((p) => p.type === 'tool'));
      msg.status = 'done';
      msg.meta = {
        ...msg.meta,
        durationMs: Date.now() - started,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
      state.seen.push(msg.id);
    } catch (err) {
      const aborted = err instanceof AgentRunError && err.aborted;
      // The session this agent resumes next holds its own reply, even a failed one, so the reply is
      // not news to it; without such a session (it starts fresh) it is shown the reply.
      if (state.sessionId && !keptOldSession) state.seen.push(msg.id);
      msg.status = aborted ? 'aborted' : 'error';
      msg.error = aborted ? undefined : (err as Error).message;
      msg.meta = { ...msg.meta, durationMs: Date.now() - started };
      for (const p of msg.parts) if (p.type === 'tool' && p.status === 'running') p.status = 'error';
    } finally {
      // The CLI is gone: requests it was still waiting on can no longer be answered.
      for (const id of waiting) this.approvals.get(id)?.resolve({ allow: false, expired: true });
      // Record file changes even when the turn failed or was stopped: the files changed anyway.
      if (before) {
        try {
          msg.changes = await this.captureChanges(conv.id, run.ws.root!, before, wt, agent);
        } catch (err) {
          console.warn('[orchestrator] could not record changes:', (err as Error).message);
        }
      }
      run.active.delete(agent.id);
      conv.updatedAt = Date.now();
      this.hub.emit(conv.id, { type: 'message', message: msg });
      this.emitStatus(conv.id);
      // A failed write must not end the turn early: in parallel mode the run would end while
      // teammates still work.
      try {
        this.store.saveMessage(conv.id, msg, true);
        this.store.saveAgentState(conv.id, agent.id, state);
        this.store.saveMeta(conv);
      } catch (err) {
        console.error('[orchestrator] could not save the end of a turn:', err);
      }
      this.trace(conv);
    }
    return msg;
  }

  private async captureChanges(
    convId: string,
    root: string,
    before: { commit: string; tree?: string },
    wt: AgentWorktree | undefined,
    agent: AgentConfig,
  ): Promise<MessageChanges | undefined> {
    if (wt) {
      // An agent that committed by itself leaves nothing staged: its commits are the turn's result.
      const head = (await commitWorktree(wt.path, `@${agent.name} (Harness Relay)`)) ?? (await worktreeHead(wt.path));
      if (head === before.commit) return undefined;
      const files = await diffFiles(wt.root, before.commit, head);
      // The branch moves on a reset; keep this turn's commits so its diff stays viewable.
      await keepCommits(wt.root, convId, [before.commit, head]);
      return { root: wt.root, base: before.commit, head, files, isolated: true, branch: wt.branch };
    }
    const after = await snapshot(root, this.snapshotExcludes());
    if (after.tree === before.tree) return undefined;
    const files = await diffFiles(root, before.commit, after.commit);
    await keepCommits(root, convId, [before.commit, after.commit]);
    return { root, base: before.commit, head: after.commit, files, isolated: false };
  }

  systemNote(conv: Conversation, text: string): void {
    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'system' },
      createdAt: Date.now(),
      parts: [{ type: 'text', text }],
      status: 'done',
    };
    conv.messages.push(msg);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);
  }

  private emitStatus(id: string): void {
    this.hub.emit(id, { type: 'status', running: this.isRunning(id), activeAgentIds: this.activeAgentIds(id) });
  }
}
