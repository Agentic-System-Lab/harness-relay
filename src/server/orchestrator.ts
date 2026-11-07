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
  TeamPreset,
} from '../shared/types';
import { AgentRunError, runners, type AgentEvent, type RunResult } from './agents';
import type { ApprovalRequest } from './agents/types';
import { approvalKeys, isAllowed } from './approvals';
import { HttpError } from './errors';
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
  /** Conversations being deleted. */
  private deleting = new Set<string>();
  /** The server is shutting down: nothing new starts. */
  private closing = false;
  /** Repository root → conversation currently writing to its working tree. */
  private dirLocks = new Map<string, string>();
  /** Approval requests waiting for the user, by approval part id. */
  private approvals = new Map<string, { convId: string; resolve: (a: ApprovalAnswer & { expired?: boolean }) => void }>();

  constructor(
    private store: Store,
    private hub: Hub,
    private settings: SettingsStore,
    private planner: PlannerSource = { context: async () => ({ available: [], catalog: [], presets: store.listPresets() }) },
  ) {}

  isRunning(id: string): boolean {
    return this.runs.has(id);
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
      const conv = this.store.get(convId);
      if (conv) await this.cleanupWorktrees(conv);
      this.store.delete(convId);
    } finally {
      this.deleting.delete(convId);
    }
  }

  /** Every run finished (or `ms` passed): used on shutdown before the database closes. */
  async settled(ms: number): Promise<void> {
    const all = Promise.allSettled([...this.runs.values()].map((r) => r.done));
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

  /** Post a user message (or, with empty text, let the team continue) and start the team's turn. */
  async send(convId: string, rawText: string, uploads?: AttachmentUpload[]): Promise<void> {
    const conv = this.getIdle(convId);
    const text = rawText.trim();
    if (!text && !uploads?.length && !conv.messages.some((m) => m.author.kind === 'user')) throw new HttpError(400, t().typeFirst);
    const files = saveAttachments(conv.id, uploads);
    try {
      await this.start(conv, text, undefined, undefined, false, files);
    } catch (err) {
      removeAttachments(conv.id, files);
      throw err;
    }
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
    await this.start(conv, text, () => this.truncateFrom(conv, messageId, files), undefined, this.replans(conv, messageId), files);
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
    await this.start(conv, '', () => this.truncateFrom(conv, messageId), again);
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
    // The lead agent's team design went too: design the team again for the edited question.
    if (replan) conv.settings = { ...conv.settings, autoTeam: true };
    this.hub.emit(conv.id, { type: 'snapshot', conversation: forClient(conv), running: false, activeAgentIds: [] });
  }

  /**
   * Start a run; `beforePost` runs once the workspace is ready and locked, just before the message is
   * posted. `only`: run just these agents, for one round (retrying replies). `willPlan`: `beforePost`
   * turns auto team on, so the lead agent designs the team first. `files`: attached files of the new
   * user message (already saved).
   */
  private async start(
    conv: Conversation,
    text: string,
    beforePost?: () => void,
    only?: AgentConfig[],
    willPlan = false,
    files: AttachmentPart[] = [],
  ): Promise<void> {
    const convId = conv.id;
    // Reserved until the run is registered, so a second send, a settings change or an apply cannot
    // slip in while the workspace is prepared, and a delete waits for it.
    const release = this.reserve(convId);
    let lockRoot: string | undefined;
    let run: Run;
    try {
      const ws = await this.prepareWorkspace(conv);
      // Deleted meanwhile (the delete may even have finished already), or the server is stopping.
      if (this.deleting.has(convId) || this.store.get(convId) !== conv) {
        throw new HttpError(404, t().conversationNotFound);
      }
      if (this.closing) throw new HttpError(503, t().shuttingDown);
      // An auto-team run does not know its mode yet, so it locks the directory to be safe; it lets
      // go once the lead agent chose parallel mode.
      lockRoot = ws.root && (!ws.isolated || conv.settings.autoTeam || willPlan) ? ws.root : undefined;
      if (lockRoot) this.lockDir(lockRoot, conv);
      beforePost?.();
      this.postUserMessage(conv, text, files);
      run = { abort: new AbortController(), active: new Set(), ws, lockRoot, done: Promise.resolve() };
      this.runs.set(convId, run);
    } catch (err) {
      if (lockRoot && !this.runs.has(convId)) this.unlockDir(lockRoot, convId);
      throw err;
    } finally {
      release();
    }
    this.emitStatus(conv.id);

    run.done = this.execute(conv, text, run, only)
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
          this.emitStatus(conv.id);
        }
      });
  }

  /** Post the user's message (none for Continue / retry) and name the conversation after it. */
  private postUserMessage(conv: Conversation, text: string, files: AttachmentPart[]): void {
    if (text || files.length) {
      const msg: ChatMessage = {
        id: randomUUID(),
        author: { kind: 'user' },
        createdAt: Date.now(),
        parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
        status: 'done',
      };
      conv.messages.push(msg);
      this.store.saveMessage(conv.id, msg, true);
      this.hub.emit(conv.id, { type: 'message', message: msg });
      if (isDefaultTitle(conv.title)) {
        const line = (text.split('\n')[0] ?? '').trim() || files[0]!.name;
        conv.title = line.length > 40 ? line.slice(0, 39) + '…' : line;
        this.emitConversation(conv);
      }
    }
    conv.updatedAt = Date.now();
    this.store.saveMeta(conv);
  }

  stop(convId: string): void {
    this.runs.get(convId)?.abort.abort();
  }

  /** Shutting down: stop every run, and refuse new runs, applies and settings changes. */
  stopAll(): void {
    this.closing = true;
    for (const r of this.runs.values()) r.abort.abort();
  }

  emitConversation(conv: Conversation): void {
    this.hub.emit(conv.id, {
      type: 'conversation',
      title: conv.title,
      agents: conv.agents,
      settings: conv.settings,
      worktrees: conv.worktrees,
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
      base ??= (await snapshot(root)).commit;
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
   * Auto team: the lead agent (Settings) picks a template or designs a team for the question, shown
   * as a plan card. When planning fails the general-question template is used; when it is stopped
   * the conversation stays in auto-team mode and plans again on the next message.
   */
  private async designTeam(conv: Conversation, text: string, run: Run): Promise<void> {
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

    const asked = [...conv.messages].reverse().find((m) => m.author.kind === 'user');
    const fileNames = asked?.parts.flatMap((p) => (p.type === 'attachment' ? [p.name] : [])) ?? [];
    const question =
      (text || textOf(asked ?? msg)) + (fileNames.length ? `\n\n(Attached files: ${fileNames.join(', ')})` : '');
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
      msg.plan = { status: 'ready', lead, ...decision };
      msg.status = 'done';
      this.store.saveMeta(conv);
      this.emitConversation(conv);
    }
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /** Save a team the lead agent designed itself as a user template. */
  savePlanAsPreset(convId: string, messageId: string, name?: string): TeamPreset {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const msg = conv.messages.find((m) => m.id === messageId);
    const plan = msg?.plan;
    if (!msg || plan?.status !== 'ready') throw new HttpError(404, t().planNotFound);
    if (plan.source !== 'custom' || !plan.agents?.length || !plan.settings) throw new HttpError(400, t().planNotSavable);
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

  private async execute(conv: Conversation, text: string, run: Run, only?: AgentConfig[]): Promise<void> {
    if (conv.settings.autoTeam && !only) {
      await this.designTeam(conv, text, run);
      if (run.abort.signal.aborted || conv.settings.autoTeam) return;
      run.ws = { root: run.ws.root, isolated: Boolean(run.ws.root) && conv.settings.mode === 'parallel' };
      // Parallel agents write only to their worktrees: other conversations may use the directory.
      if (run.ws.isolated && run.lockRoot) {
        this.unlockDir(run.lockRoot, conv.id);
        run.lockRoot = undefined;
      }
    }
    const { mode, maxHops } = conv.settings;
    const rounds = only ? 1 : conv.settings.rounds;
    const mentioned = only ?? (text ? parseMentions(text, conv.agents) : []);
    const participants = mentioned.length ? mentioned : conv.agents;
    const aborted = () => run.abort.signal.aborted;
    const spoke = (m: ChatMessage) => m.status === 'done' && !m.passed;

    if (mode === 'relay') {
      const queue: { agent: AgentConfig; handedBy?: string }[] = (mentioned.length ? mentioned.slice(0, only ? 1 : undefined) : [conv.agents[0]!]).map(
        (agent) => ({ agent }),
      );
      let hops = 0;
      while (queue.length && !aborted()) {
        if (hops >= maxHops) {
          this.systemNote(conv, t().relayLimit(maxHops));
          break;
        }
        const { agent, handedBy } = queue.shift()!;
        hops++;
        const msg = await this.turn(conv, agent, run, { mode, round: 1, rounds: 1, handedBy, hopsLeft: maxHops - hops });
        if (!spoke(msg)) continue;
        for (const next of parseMentions(textOf(msg), conv.agents, agent.id)) {
          if (!queue.some((q) => q.agent.id === next.id)) queue.push({ agent: next, handedBy: agent.name });
        }
      }
      return;
    }

    if (mode === 'parallel' && run.ws.isolated) await this.prepareWorktrees(conv, participants, run.ws.root!);

    for (let round = 1; round <= rounds && !aborted(); round++) {
      const info: TurnInfo = { mode, round, rounds };
      let msgs: ChatMessage[];
      if (mode === 'parallel') {
        // Every turn settles before the run can end, even when one of them fails.
        const settled = await Promise.allSettled(participants.map((a) => this.turn(conv, a, run, info)));
        const failed = settled.find((r) => r.status === 'rejected');
        if (failed) throw failed.reason;
        msgs = settled.map((r) => (r as PromiseFulfilledResult<ChatMessage>).value);
      } else {
        msgs = [];
        for (const a of participants) {
          if (aborted()) break;
          msgs.push(await this.turn(conv, a, run, info));
        }
      }
      if (!msgs.some(spoke)) break; // everyone passed: the discussion has converged
    }
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
      else if (run.ws.root && !wt) before = await snapshot(run.ws.root);
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
      try {
        const result = await runners[agent.provider].run({
          bin: this.settings.bin(agent.provider),
          env: this.settings.env(agent.provider),
          prompt,
          systemPrompt: buildBriefing(conv, agent, workspace),
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
    const after = await snapshot(root);
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
