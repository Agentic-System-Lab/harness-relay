import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentConfig,
  AgentSessionState,
  ApprovalAnswer,
  AgentWorktree,
  BranchPart,
  ChatMessage,
  Conversation,
  ConversationBranch,
  ConversationSchedule,
  FileChange,
  LeadReview,
  MessageChanges,
  MessagePart,
  Provider,
  RunPause,
  TeamPreset,
  TeamRevision,
} from '../shared/types';
import { splitAsk } from '../shared/ask';
import { OPEN_PROVIDERS, PROVIDER_LABEL, REVISE_REQUEST_MAX, cwdsOf, isEndpointCli, isOpenProvider, pendingPlan, permissionAbove, planSavable } from '../shared/types';
import { AgentRunError, runners, type AgentEvent, type RunResult } from './agents';
import { emptyStateFolder, removeConversationState } from './agents/open';
import { stateKeys, type ApprovalRequest } from './agents/types';
import type { TraceSink } from './agentsview';
import { approvalKeys, isAllowed } from './approvals';
import { CONFIG } from './config';
import { HttpError } from './errors';
import { AutoGrouper } from './grouping';
import type { Hub } from './hub';
import {
  PLANNER_BRIEFING,
  REVISER_BRIEFING,
  buildPlannerPrompt,
  buildRevisePrompt,
  decidePlan,
  decideRevision,
  draftPlace,
  fallbackPlan,
  historyForLead,
  keepMemberIds,
  parsePlanReply,
  teamSettings,
  type PlanConversation,
  type PlanDecision,
  type PlannerContext,
  type TeamDraft,
} from './planner';
import {
  attachmentsDir,
  copyAttachments,
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
import { endpointModel } from './backends';
import { REVIEWER_BRIEFING, buildReviewPrompt, hasNewReplies, parseReviewReply, reviewMaterial } from './reviewer';
import { DATA_DIR, OPEN_HOMES_DIR, type SettingsStore } from './settings';
import type { Store } from './store';
import {
  applyPatch,
  checkPatch,
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
import { isBranchTitle, isDefaultTitle, t } from './i18n';
import { sameFolder, validateAgents } from './validate';
import { agentFolderOptions, relayFolderRefusal } from './protect';
import { scheduleTime } from './scheduler';

export { HttpError };

/** A conversation as sent to the browser: without the agents' CLI session bookkeeping (it grows with the chat). */
export function forClient(conv: Conversation): Conversation {
  return { ...conv, agentState: {} };
}

/** Where agents of one run write. */
interface RunWorkspace {
  /**
   * The working directories, in order, each with the root of the repository it is in; set when
   * agents may write (edit / full). Two may be in the same repository.
   */
  folders?: { cwd: string; root: string }[];
  /** Parallel mode with write access: every agent works in its own git worktrees. */
  isolated: boolean;
}

/** How deep a folder is, links resolved (as written when it cannot be): for making outer repositories first. */
function realDepth(dir: string): number {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* not there: as written */
  }
  return real.split(/[\\/]+/).filter(Boolean).length;
}

/** The repositories of a run's working directories, each once, in the order of the directories. */
function rootsOf(ws: RunWorkspace): string[] {
  return [...new Set((ws.folders ?? []).map((f) => f.root))];
}

/**
 * Names for repositories in one diff (their folders' names, then ` (2)`… for a name already taken),
 * so that the diffs of several can be read one after another.
 */
function folderLabels(roots: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  for (const root of roots) {
    const name = basename(root) || 'root';
    let label = name;
    for (let n = 2; taken.has(label); n++) label = `${name} (${n})`;
    taken.add(label);
    labels.set(root, label);
  }
  return labels;
}

interface Run {
  abort: AbortController;
  active: Set<string>;
  /** Turns not over yet, by message id: a reply is marked done before its turn records the files it changed. */
  turns: Set<string>;
  ws: RunWorkspace;
  /** Repository roots (or folders) this run holds the directory lock on. */
  lockRoots?: string[];
  /**
   * A schedule started it and nobody may be watching: actions the permission does not cover are
   * refused automatically instead of asked (the schedule's `approvals`), unless the conversation
   * always allows them. Cleared once one of the user's own messages reaches the run: they are here.
   */
  refuseApprovals?: boolean;
  /** Auto team: the lead agent designs the team for the question, and that is all this run does. */
  designs?: boolean;
  /** The design is for the conversation's schedule: this is its message, which nobody posted (`designForSchedule`). */
  designFor?: string;
  /** The design needed no confirmation (`autoConfirm`): once this run ends, the team answers. */
  answerNext?: boolean;
  /** The team's turns are over and the lead agent reviews its replies (lead review). */
  reviewing?: boolean;
  /** Settles once the run has finished, including its clean-up. */
  done: Promise<void>;
}

interface StartOptions {
  /** Runs once the workspace is ready and locked, just before the message is posted. */
  beforePost?: () => void;
  /** Run just these agents, for one round (retrying replies). */
  only?: AgentConfig[];
  /**
   * The user's message is a question of their own (sent, or edited): in an auto-team conversation the
   * lead agent designs the team for it first, unless it answers an agent's question (`new` only) or
   * @mentions members of the current team, who answer it.
   */
  question?: 'new' | 'edited';
  /** The current team answers: no team design (the team was just confirmed, or a schedule or a waiting message starts the run). */
  keepTeam?: boolean;
  /** Attached files of the new user message (already saved). */
  files?: AttachmentPart[];
  /** Post the messages waiting in the queue first: they were sent before this one, and start the run too. */
  queue?: boolean;
  /** The conversation's schedule sends the message (it is marked `scheduled`). */
  scheduled?: boolean;
  /** The lead agent designs the team for the conversation's schedule, and nobody answers (`designForSchedule`). */
  designSchedule?: boolean;
  /**
   * Refuse approval requests automatically in this run (see `Run.refuseApprovals`) — if every message
   * it starts with came from the schedule.
   */
  refuseApprovals?: boolean;
}

/**
 * How a scheduled message went. `busy`: not now — a settings change or an apply holds the
 * conversation, another conversation is writing in the same folder, or the server is stopping — so
 * try again shortly (`reason` says why). `chatId`: the conversation it opened (`newChat`).
 */
export type ScheduledSend =
  | { result: 'sent'; chatId?: string }
  | { result: 'queued' }
  | { result: 'busy'; reason?: string }
  | { result: 'skipped' | 'failed'; reason: string };

/** A run that could not start: another conversation is writing in the same folder (409) or the server is stopping (503), or else it failed. */
function sendFailure(err: unknown): ScheduledSend {
  if (err instanceof HttpError && (err.status === 409 || err.status === 503)) return { result: 'busy', reason: err.message };
  return { result: 'failed', reason: (err as Error).message };
}

/** A conversation's name taken from a message: its first line, shortened to 40 characters. */
export function titleFrom(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 40 ? line.slice(0, 39) + '…' : line;
}

/**
 * Copies of messages with new ids (a branch's): what a lead review says of a copied message (a reply
 * it read or points out, where it started reading) points at its copy, and of one not copied, at nothing.
 */
export function copyMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const copies = messages.map((m) => ({ ...structuredClone(m), id: randomUUID() }));
  const ids = new Map(messages.map((m, i) => [m.id, copies[i]!.id]));
  for (const m of copies) {
    if (!m.review) continue;
    if (m.review.replyIds) m.review.replyIds = m.review.replyIds.flatMap((id) => ids.get(id) ?? []);
    // Where a review that failed or was stopped started: the branch's next review reads from there too.
    if (m.review.fromId) {
      const from = ids.get(m.review.fromId);
      if (from) m.review.fromId = from;
      else delete m.review.fromId;
    }
    m.review.highlights = m.review.highlights?.map(({ messageId, ...h }) => {
      const id = messageId && ids.get(messageId);
      return id ? { ...h, messageId: id } : h;
    });
    if (!m.review.highlights) delete m.review.highlights;
  }
  return copies;
}

/** `HttpError.code` of a run that cannot start because another conversation is changing its folder. */
const FOLDER_LOCKED = 'folder-locked';

/** Longest name of a template saved from a plan. */
const MAX_PRESET_NAME = 100;

/**
 * A team design was stopped (or cut short) since the team last spoke: the question it was for still
 * waits for its team, so Continue designs it again.
 */
function designOwed(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.author.kind === 'agent') return false;
    if (m.plan) return m.plan.status !== 'ready';
  }
  return false;
}

/**
 * Where the lead agent's question starts: after the team last spoke or a team was designed, so what
 * the user said meanwhile counts (a stopped design's question too).
 */
function questionStart(messages: ChatMessage[]): number {
  return messages.findLastIndex((m) => m.author.kind === 'agent' || m.plan?.status === 'ready') + 1;
}

/** Where the lead agent's choices come from (signed-in CLIs, their models, the templates). */
export interface PlannerSource {
  /**
   * What the lead may choose from; with `cwd`, also what each CLI loads by itself there (with the
   * other working directories, `addDirs`, as runs have them).
   */
  context(cwd?: string, addDirs?: readonly string[]): Promise<PlannerContext>;
  /**
   * The model an open agent with none of its own runs on: the one its model picker shows as the
   * default (Settings' default, else its CLI catalog's default on a configured backend). The other
   * CLIs choose their own default, as their picker says.
   */
  defaultModel?(p: Provider): Promise<string | undefined>;
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

/** Why an action was refused in a run a schedule started, as the agent is told (prompts stay in English). */
const UNATTENDED_REFUSAL =
  'This run was started by a schedule and nobody may be watching, so actions outside your permission are refused automatically.';

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

/**
 * A branch's copied messages in parts, oldest first (`ConversationBranch.earlier`, then the part of the
 * conversation it was branched from), each with the index of its last message here. One whose last
 * message was just `dropped` from the end ends with the last message left; one whose last message is
 * not here otherwise cannot be placed, and is left out. So is a part left with nothing (ending where
 * the one before it ends, or before the first message).
 */
function branchParts(
  conv: Pick<Conversation, 'branch' | 'messages'>,
  dropped: ReadonlySet<string> = new Set(),
): { part: BranchPart; end: number }[] {
  if (!conv.branch) return [];
  const { earlier = [], ...main } = conv.branch;
  const out: { part: BranchPart; end: number }[] = [];
  for (const part of [...earlier].reverse().concat(main)) {
    const at = conv.messages.findIndex((m) => m.id === part.afterId);
    const end = at >= 0 ? at : dropped.has(part.afterId) ? conv.messages.length - 1 : -1;
    if (end > (out.at(-1)?.end ?? -1)) out.push({ part: { ...part, afterId: conv.messages[end]!.id }, end });
  }
  return out;
}

/** A branch made of `parts`, oldest first: the last is the one it was branched from (undefined: none). */
function branchOfParts(parts: readonly BranchPart[]): ConversationBranch | undefined {
  const main = parts.at(-1);
  if (!main) return undefined;
  const earlier = parts.slice(0, -1).reverse();
  return { ...main, ...(earlier.length ? { earlier } : {}) };
}

/**
 * Where a branch from the reply at `index` comes from (`copies`: the copied messages, with their new
 * ids): the conversation that reply was written in. Up to its branch point, a branch's messages were
 * copied: a reply there was written in the conversation it was copied from, or further up for a branch
 * of a branch, so the new branch is a branch of that one, as if it had been branched there, and only
 * the parts before the reply come along as `earlier`. `titleOf`: a conversation's title now (for a
 * deleted one, the title the sidebar shows for it; undefined: the one it had when copied is kept).
 */
export function branchOrigin(
  conv: Conversation,
  index: number,
  copies: readonly Pick<ChatMessage, 'id'>[],
  titleOf: (id: string) => string | undefined = () => undefined,
): ConversationBranch {
  const titled = (p: BranchPart): BranchPart => ({ ...p, fromTitle: titleOf(p.fromId) ?? p.fromTitle });
  const parts = branchParts(conv);
  const at = parts.findIndex((p) => p.end >= index);
  const from: BranchPart = at < 0 ? { fromId: conv.id, fromTitle: conv.title, afterId: '' } : titled(parts[at]!.part);
  const before = (at < 0 ? parts : parts.slice(0, at)).map(({ part, end }) => ({ ...titled(part), afterId: copies[end]!.id }));
  return branchOfParts([...before, { ...from, afterId: copies[index]!.id }])!;
}

/**
 * Where a branch's copied messages end once the messages `dropped` were cut from its end (a retry or an
 * edit): each part that lost its last message ends with the last one left, and one left with nothing
 * goes, so with none of the conversation it was branched from left, it is a branch of the one further
 * up. Undefined once nothing copied is left: it is no longer a branch.
 */
export function branchAfterCut(
  conv: Pick<Conversation, 'branch' | 'messages'>,
  dropped: ReadonlySet<string>,
): ConversationBranch | undefined {
  return branchOfParts(branchParts(conv, dropped).map((p) => p.part));
}

/**
 * Where a branch from the reply at `index` waits for the user: a reply that asked the user something
 * keeps its question open there, whatever the user answered here since, so they can answer it another
 * way. Branched where this conversation waits now, the branch waits the same way. Otherwise the agent
 * that asked (in parallel mode, with the others whose questions in its round came before) answers
 * first once the user replies, followed in roundtable mode by the members after it in that round, and
 * in later rounds by the members the question was for, as the run would have gone on.
 */
export function branchPause(conv: Conversation, index: number): RunPause | undefined {
  const reply = conv.messages[index];
  if (reply?.author.kind !== 'agent' || !reply.asked) return undefined;
  if (conv.pause && conv.messages.slice(index + 1).every((m) => m.author.kind === 'system')) return structuredClone(conv.pause);
  const { mode, rounds, maxHops } = conv.settings;
  const askerId = reply.author.agentId;
  if (mode === 'relay') return { mode, askers: [askerId], rest: [], participants: [], round: 1, rounds: 1, hopsLeft: maxHops };
  const asked = conv.messages.slice(0, index).findLastIndex((m) => m.author.kind === 'user');
  const question = conv.messages[asked];
  const mentioned = question ? mentionsOf([question], conv.agents) : [];
  const participants = mentioned.length ? mentioned : conv.agents;
  const round = reply.meta?.round ?? 1;
  const askers =
    mode === 'parallel'
      ? [
          ...new Set(
            conv.messages
              .slice(asked + 1, index + 1)
              .flatMap((m) => (m.author.kind === 'agent' && m.asked && (m.meta?.round ?? 1) === round ? [m.author.agentId] : [])),
          ),
        ]
      : [askerId];
  const at = participants.findIndex((a) => a.id === askerId);
  const rest = mode === 'roundtable' && at >= 0 ? participants.slice(at + 1).map((a) => ({ agentId: a.id })) : [];
  return { mode, askers, rest, participants: participants.map((a) => a.id), round, rounds };
}

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
  /** Conversations whose run (running or being set up) only designs the team: nobody is replying yet. */
  private designing = new Set<string>();
  /** Conversations whose run has the lead agent review the team's replies: the team has answered. */
  private reviewing = new Set<string>();
  /**
   * Conversations whose run could not start because another conversation was changing the same folder,
   * with what starts it (the messages waiting, or the team just confirmed): tried again when a folder
   * lock is released and theirs looks free.
   */
  private folderWaiters = new Map<string, () => boolean>();
  /** How many times the user switched lead review, by conversation: a design leaves alone what the user set meanwhile. */
  private reviewSwitches = new Map<string, number>();
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
  /**
   * The lead agent changing a team at the user's request (team drawer), by conversation: the latest
   * request, and any it replaced whose lead process has not ended yet. Only the latest one answers.
   */
  private revisions = new Map<string, Set<{ abort: AbortController; done: Promise<unknown> }>>();
  /** Branches being made, by the conversation they come from: deleting it, and shutdown, wait for them. */
  private branching = new Map<string, Set<Promise<Conversation>>>();

  constructor(
    private store: Store,
    private hub: Hub,
    private settings: SettingsStore,
    private planner: PlannerSource = { context: async () => ({ available: [], catalog: [], presets: store.listPresets() }) },
    /** Told after each turn and run, to send the conversation to AgentsView. */
    private traces?: TraceSink,
  ) {
    this.grouper = new AutoGrouper(
      store,
      settings,
      (conv, provider, sessionId) => this.linkSession(conv, provider, sessionId),
      (p, chosen, account) => this.modelFor(p, chosen, account),
    );
  }

  /**
   * The model a run of `p` (as `account`) gets: the one chosen, else that account's default in Settings; for an open agent with
   * neither, the default its model picker shows (`PlannerSource.defaultModel`), so that what runs is
   * what the picker said. Undefined: the CLI decides (an open agent then says to pick one).
   */
  async modelFor(p: Provider, chosen?: string, account?: string): Promise<string | undefined> {
    const model = chosen?.trim() || this.settings.defaultModel(p, account);
    if (model || !isOpenProvider(p) || !this.planner.defaultModel) return model || undefined;
    try {
      return (await this.planner.defaultModel(p)) || undefined;
    } catch (err) {
      console.warn(`[orchestrator] could not ask for ${p}'s default model:`, (err as Error).message);
      return undefined;
    }
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /**
   * How many conversations have agents at work: a run (replying, designing a team, waiting for an
   * approval) or one being set up, the lead agent changing a team or sorting the conversation into a
   * group, a branch being made, or a change being made to the conversation (`reserved`: a parallel
   * reply applied to the working directory, a settings change). A team waiting for the user's answer
   * or for its team to be confirmed has none. The desktop app waits until there are none before it
   * switches to a new version.
   */
  busy(): number {
    return new Set([
      ...this.runs.keys(),
      ...this.starting,
      ...this.reserved.keys(),
      ...this.revisions.keys(),
      ...this.branching.keys(),
      ...this.grouper.sorting(),
    ]).size;
  }

  /** The lead agent is sorting this new conversation into one of the user's groups. */
  isSorting(id: string): boolean {
    return this.grouper.isSorting(id);
  }

  /** Have the lead agent sort a new conversation into one of the user's sidebar groups, by what it is about. */
  sortIntoGroup(conv: Conversation, about: string): void {
    this.grouper.start(conv, about);
  }

  /** Some conversation is replying, being set up, or being sorted into a group. */
  anyRunning(): boolean {
    return this.runs.size > 0 || this.starting.size > 0 || this.grouper.busy || this.revisions.size > 0;
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
      // Waiting for its folder, it was passed over while this held it: it tries now, once whatever
      // follows the change (a confirmed team starting, say) has had its go.
      if (this.folderWaiters.has(convId)) setImmediate(() => this.retryFolderWaiters([convId]));
    }
  }

  /**
   * Delete a conversation: let a request that is changing it finish, stop its run and wait until the
   * run has wound down (it still writes its final state), then remove its worktrees, kept snapshot
   * refs and rows.
   */
  async deleteConversation(convId: string): Promise<void> {
    this.deleting.add(convId);
    this.folderWaiters.delete(convId);
    this.reviewSwitches.delete(convId);
    try {
      // A branch being made from it is still copying its attached files.
      await Promise.allSettled([...(this.branching.get(convId) ?? [])]);
      // A run being set up gives up when it sees the delete; a settings change or an apply finishes.
      for (let pending = this.reserved.get(convId); pending; pending = this.reserved.get(convId)) await pending;
      const run = this.runs.get(convId);
      if (run) {
        run.abort.abort();
        await run.done;
      }
      await this.grouper.cancel(convId);
      // Stop every one first, then wait: one slow to end must not keep the others going.
      const revisions = [...(this.revisions.get(convId) ?? [])];
      for (const r of revisions) r.abort.abort();
      await Promise.all(revisions.map((r) => r.done.catch(() => undefined)));
      const conv = this.store.get(convId);
      if (conv) {
        await this.cleanupWorktrees(conv);
        // What each open agent kept for its members, its lead agent and its group sorter.
        const members = new Set([...conv.agents.map((a) => a.id), ...Object.keys(conv.agentState)]);
        removeConversationState(OPEN_PROVIDERS.flatMap((p) => this.settings.openAgentHomes(p)), convId, [...members]);
      }
      // A schedule that opened it no longer links to it.
      for (const id of this.store.delete(convId)) {
        const linked = this.store.get(id);
        if (linked) this.emitConversation(linked);
      }
      this.traces?.forget?.(convId);
    } finally {
      this.deleting.delete(convId);
    }
  }

  /** Every run finished (or `ms` passed): used on shutdown before the database closes. */
  async settled(ms: number): Promise<void> {
    const all = Promise.allSettled([
      ...[...this.runs.values()].map((r) => r.done),
      ...[...this.revisions.values()].flatMap((set) => [...set].map((r) => r.done)),
      ...[...this.branching.values()].flatMap((set) => [...set]),
      this.grouper.settled(),
    ]);
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
      // What waits may be a new question, written while the lead agent reviewed (also when it is sent now).
      const asks = content || this.waitingQuestion(conv);
      await this.start(conv, text, { files, queue: true, ...(asks ? { question: 'new' as const } : {}) });
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
    delete msg!.duringReview;
    this.saveQueue(conv);
    removeAttachments(conv.id, attachmentsOf(msg!));
    return msg!;
  }

  /**
   * The conversation's schedule came due (or the user ran it now): send its message to the team as if
   * the user had, marked `scheduled`. While the team replies it waits in the queue like any message.
   * It is held back (`skipped`) when the team cannot take it: no confirmed team, an agent's question
   * waiting for the user's answer (the message would count as the answer), an earlier scheduled
   * message still waiting for the team, or a full queue. An earlier one left waiting while nothing
   * runs (the team was stopped, or the server restarted) is sent now instead, once. The run it starts
   * refuses approval requests unless the schedule asks. A schedule that opens a new conversation each
   * time sends it there (`sendInNewChat`); `at` is the time it came due, which names that conversation.
   */
  async sendScheduled(convId: string, at = Date.now()): Promise<ScheduledSend> {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    const s = conv.schedule;
    if (!s) throw new HttpError(404, t().scheduleNotFound);
    // Not lost: sent (or counted as missed) when the server is back.
    if (this.closing) return { result: 'busy', reason: t().shuttingDown };
    // The current team takes it (a schedule never has the lead agent design a team: nobody may be
    // there to confirm it), so there must be one.
    if (conv.agents.length === 0 || pendingPlan(conv.messages)) {
      // Its first team is being designed, or waits for the user: tried again for a while, not lost.
      const coming = conv.agents.length === 0 && (this.designing.has(convId) || Boolean(pendingPlan(conv.messages)));
      return { result: coming ? 'busy' : 'skipped', reason: t().scheduleNoTeam };
    }
    if (s.newChat) return this.sendInNewChat(conv, s, at);
    const replying = this.runs.has(convId) || this.starting.has(convId);
    // A run being set up may be the user's answer: the message then waits for its next turn instead.
    if (conv.pause && !replying) return { result: 'skipped', reason: t().scheduleWaitsForAnswer };
    const waiting = Boolean(conv.queue?.some((m) => m.scheduled));
    if (waiting && replying) return { result: 'skipped', reason: t().scheduleStillQueued };
    if (replying && (conv.queue?.length ?? 0) >= MAX_QUEUE) return { result: 'skipped', reason: t().scheduleQueueFull };
    try {
      if (replying) {
        this.enqueue(conv, s.text, undefined, true);
        return { result: 'queued' };
      }
      // A settings change or an apply holds the conversation for a moment.
      if (this.isBusy(convId)) return { result: 'busy', reason: t().scheduleConvBusy };
      // Another conversation is writing in its folder: known before the run is set up, so a message the
      // user sends meanwhile is not left in the queue of a run that then cannot start.
      const locked = this.folderLockedBy(conv);
      if (locked) return { result: 'busy', reason: locked };
      await this.start(conv, waiting ? '' : s.text, {
        queue: true,
        keepTeam: true,
        scheduled: !waiting,
        refuseApprovals: s.approvals !== 'ask',
      });
      return { result: 'sent' };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw err;
      return sendFailure(err);
    }
  }

  /**
   * Send the schedule's message in a new conversation: a copy of this one's team, settings, "always
   * allow" answers and sidebar group (the lead agent does not sort it), named after it and the time it
   * came due, which says where it comes from. Whatever this conversation is doing — replying, waiting
   * for the user's answer, holding messages in its queue — does not matter; only another conversation
   * writing in the same folder (this one included) makes it wait. A conversation whose run could not
   * start is removed again: nothing was sent in it.
   */
  private async sendInNewChat(conv: Conversation, s: ConversationSchedule, at: number): Promise<ScheduledSend> {
    const id = randomUUID();
    const locked = this.folderLockedBy({ ...conv, id });
    if (locked) return { result: 'busy', reason: locked };
    const now = Date.now();
    // Named after the schedule's conversation, or after its message while that one has no name of
    // its own yet (a branch still called "Branch · …").
    const unnamed = isDefaultTitle(conv.title) || (conv.branch && isBranchTitle(conv.title, conv.branch.fromTitle));
    const name = unnamed ? titleFrom(s.text) : conv.title.slice(0, 160);
    const chat: Conversation = {
      id,
      title: `${name} · ${scheduleTime(at, s)}`,
      createdAt: now,
      updatedAt: now,
      agents: structuredClone(conv.agents),
      settings: structuredClone(conv.settings),
      messages: [],
      agentState: {},
      worktrees: {},
      ...(conv.allowRules?.length ? { allowRules: structuredClone(conv.allowRules) } : {}),
    };
    try {
      this.store.create(chat);
      // Where the schedule's conversation shows: its family's group.
      this.store.moveToGroup(id, this.store.familyGroupOf(conv.id));
      this.systemNote(chat, t().scheduleChatNote(name));
      await this.start(chat, s.text, { keepTeam: true, scheduled: true, refuseApprovals: s.approvals !== 'ask' });
      return { result: 'sent', chatId: id };
    } catch (err) {
      if (!this.runs.has(id)) this.store.delete(id);
      return sendFailure(err);
    }
  }

  /**
   * Have the lead agent design the team for the conversation's schedule (auto team), for its message,
   * which nobody posts now. Once the team is confirmed (or at once, with `autoConfirm`), it answers
   * nothing now: it gets the message each time the schedule sends it.
   */
  async designForSchedule(convId: string): Promise<void> {
    const conv = this.getIdle(convId);
    if (!conv.schedule) throw new HttpError(404, t().scheduleNotFound);
    if (!conv.settings.autoTeam) throw new HttpError(400, t().scheduleNoLead);
    if (pendingPlan(conv.messages)) throw new HttpError(409, t().planAwaitingConfirm);
    // Only for a conversation without a team: one that has a team keeps it (and an agent's question
    // waiting for the user stays as it is).
    if (conv.agents.length > 0) throw new HttpError(409, t().scheduleHasTeam);
    await this.start(conv, '', { designSchedule: true });
  }

  /** Stop the conversation's run, if there is one, and wait until it has wound down. */
  private async interrupt(convId: string): Promise<void> {
    const run = this.runs.get(convId);
    if (!run) return;
    run.abort.abort();
    await run.done;
  }

  /**
   * A message sent now waits in the queue (anything else that keeps the conversation busy refuses it):
   * while the team replies, its design waits, or it waits for its folder (the message then starts with
   * the rest once the folder is free).
   */
  private queues(conv: Conversation): boolean {
    if (this.deleting.has(conv.id) || this.closing) return false;
    return (
      this.runs.has(conv.id) || this.starting.has(conv.id) || Boolean(pendingPlan(conv.messages)) || this.folderWaiters.has(conv.id)
    );
  }

  private enqueue(conv: Conversation, text: string, uploads?: AttachmentUpload[], scheduled = false): void {
    const queue = (conv.queue ??= []);
    if (queue.length >= MAX_QUEUE) throw new HttpError(409, t().queueFull(MAX_QUEUE));
    const files = saveAttachments(conv.id, uploads);
    // Marked only when it joins a team's discussion: not a question written while the lead agent
    // designs the team, its design waits for confirmation, or the lead reviews the team's replies.
    const midReply =
      (this.runs.has(conv.id) || this.starting.has(conv.id)) && !this.designing.has(conv.id) && !this.reviewing.has(conv.id);
    queue.push({
      id: randomUUID(),
      author: { kind: 'user' },
      createdAt: Date.now(),
      parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
      status: 'done',
      ...(midReply ? { queued: true } : {}),
      ...(scheduled ? { scheduled: true } : {}),
      // Written once the team had answered: a new question (kept with the queue, also across a restart).
      ...(this.reviewing.has(conv.id) && !scheduled ? { duringReview: true } : {}),
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
   * chat keeps the order they were sent in; when a run starts, those in `ids` (sent before it),
   * wherever they are — a scheduled message kept back while the user answers stays where it is, and
   * what the user wrote behind it still goes now.
   */
  private deliverQueued(conv: Conversation, which: { recipients: AgentConfig[] } | { ids: Set<string> }): ChatMessage[] {
    const queue = conv.queue ?? [];
    const posted: ChatMessage[] = [];
    for (let i = 0; i < queue.length; ) {
      const next = queue[i]!;
      if ('ids' in which) {
        if (!which.ids.has(next.id)) {
          i++;
          continue;
        }
      } else if (!isFor(next, which.recipients, conv.agents)) {
        break;
      }
      // Posted before it leaves the saved queue: a crash in between keeps it once, as delivered.
      // Posted, it is a message like any other: the mark was only for while it waited.
      delete next.duringReview;
      conv.messages.push(next);
      queue.splice(i, 1);
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
   * answer (the lead agent's team design is not waiting for confirmation). They were written while the
   * team worked, so the current team answers them. Returns whether it starts; a run that fails to
   * start says why in the chat, and its messages keep waiting.
   */
  startQueued(conv: Conversation): boolean {
    if (!conv.queue?.length || !this.mayStart(conv)) return false;
    // An agent asked the user something: what was written before the question waits for the answer.
    if (conv.pause) return false;
    // Only the schedule's message waits: nobody may be watching this run either.
    const unattended = conv.queue.every((m) => m.scheduled) && conv.schedule?.approvals !== 'ask';
    // Written while the team worked, the current team answers them; written after it had answered
    // (while the lead agent reviewed), they are a new question, and with auto team its team is designed.
    const asks = this.waitingQuestion(conv);
    this.startInBackground(conv, { queue: true, ...(asks ? { question: 'new' as const } : { keepTeam: true }), refuseApprovals: unattended }, () =>
      this.startQueued(conv),
    );
    return true;
  }

  /**
   * Auto team: the messages waiting include one the user wrote once the team had answered (while the
   * lead agent reviewed its replies, `duringReview`), so they ask a new question, whose team the lead
   * agent designs — unless one of them @mentions members of the team, who then answer.
   */
  private waitingQuestion(conv: Conversation): boolean {
    if (!conv.settings.autoTeam) return false;
    const fresh = (conv.queue ?? []).filter((m) => m.duringReview);
    return fresh.length > 0 && fresh.every((m) => parseMentions(textOf(m), conv.agents).length === 0);
  }

  /**
   * The team the lead agent designed was confirmed (by the user, or at once): it answers the question
   * the design was for, with the messages waiting. A team designed for the schedule answers its message
   * when the schedule sends it: now only what the user wrote meanwhile. Returns whether a run starts.
   */
  startConfirmed(conv: Conversation, refuseApprovals = false): boolean {
    if (conv.messages.findLast((m) => m.plan?.status === 'ready')?.plan?.forSchedule) return this.startQueued(conv);
    if (!this.mayStart(conv)) return false;
    this.startInBackground(conv, { queue: true, keepTeam: true, refuseApprovals }, () => this.startConfirmed(conv, refuseApprovals));
    return true;
  }

  /** Nothing else is going on, and a team may answer (none is waiting for confirmation). */
  private mayStart(conv: Conversation): boolean {
    if (this.isBusy(conv.id) || this.closing || this.store.get(conv.id) !== conv) return false;
    return !pendingPlan(conv.messages) && (conv.agents.length > 0 || Boolean(conv.settings.autoTeam));
  }

  /**
   * Start a run nobody waits for; one that fails to start says why in the chat. One that another
   * conversation's work in the same folder keeps from starting waits for it (`retry` starts it then),
   * and says so once; one whose waiting the user stopped (or that was deleted) while it was being set
   * up does not wait again.
   */
  private startInBackground(conv: Conversation, opts: StartOptions, retry: () => boolean): void {
    const waited = this.folderWaiters.has(conv.id);
    this.start(conv, '', opts).catch((err) => {
      if (err instanceof HttpError && err.code === FOLDER_LOCKED) {
        if (waited && !this.folderWaiters.has(conv.id)) {
          this.emitStatus(conv.id);
          return;
        }
        if (!waited) this.systemNote(conv, t().queueWaitsForFolder(err.paths?.[0] ?? conv.settings.cwd));
        this.folderWaiters.set(conv.id, retry);
      } else {
        this.folderWaiters.delete(conv.id);
        if (!(err instanceof HttpError && err.status === 404)) this.systemNote(conv, t().runFailed((err as Error).message));
      }
      this.emitStatus(conv.id);
    });
  }

  /**
   * A folder lock was released (or a change to a waiting conversation is over): each conversation in
   * `ids` that waits for its folder tries again, when no other conversation holds it now (as far as can
   * be told without git). One that something else has for the moment (a settings change, an apply, a
   * start of its own being set up) waits on: the end of that change tries it again (`exclusive`), and a
   * start of its own takes it out of waiting or leaves it waiting, without another note. One with
   * nothing to start any more (its messages withdrawn or sent, or it waits for the user, whose answer
   * starts it) stops waiting; one that finds its folder taken again waits again, without another note.
   */
  private retryFolderWaiters(ids = [...this.folderWaiters.keys()]): void {
    for (const id of ids) {
      const retry = this.folderWaiters.get(id);
      if (!retry) continue;
      const conv = this.store.get(id);
      if (!conv || this.deleting.has(id) || this.closing) {
        this.folderWaiters.delete(id);
        continue;
      }
      if (this.folderLockedBy(conv) || this.isBusy(id)) continue;
      if (!retry()) {
        this.folderWaiters.delete(id);
        this.emitStatus(id);
      }
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
    await this.start(conv, text, {
      beforePost: () => this.truncateFrom(conv, messageId, files),
      question: 'edited',
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

  /**
   * Branch the conversation from one of its agents' replies: a new conversation with a copy of the
   * messages up to and including that reply (new ids, the files attached to them copied, the commits
   * behind their file changes kept for it), the team, the settings and the "always allow" answers as
   * they are now, and the sidebar group (as the user's choice, so the lead agent does not sort it). It
   * goes on from there on its own: its agents start fresh sessions and are given the copied history on
   * their first turn, and a question the reply asked waits for the user's answer there (`branchPause`).
   * This conversation stays as it is and may go on replying meanwhile; only the turns up to the reply
   * branched from must be over. Files in the working directory are not rewound.
   */
  async branch(convId: string, messageId: string): Promise<Conversation> {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    if (this.closing) throw new HttpError(503, t().shuttingDown);
    const index = conv.messages.findIndex((m) => m.id === messageId);
    if (index < 0) throw new HttpError(404, t().messageNotFound);
    if (conv.messages[index]!.author.kind !== 'agent') throw new HttpError(400, t().branchOnlyReply);
    // A reply still being written (a parallel peer's), or one whose turn still records the files it
    // changed, would be copied unfinished.
    const open = this.runs.get(convId)?.turns;
    if (conv.messages.slice(0, index + 1).some((m) => m.status === 'streaming' || open?.has(m.id))) {
      throw new HttpError(409, t().branchStreaming);
    }
    // Deleting this conversation, and shutdown, wait for it: its attached files are being copied.
    const work = this.makeBranch(conv, index);
    const pending = this.branching.get(convId) ?? new Set<Promise<Conversation>>();
    this.branching.set(convId, pending.add(work));
    try {
      return await work;
    } finally {
      pending.delete(work);
      if (!pending.size) this.branching.delete(convId);
    }
  }

  private async makeBranch(conv: Conversation, index: number): Promise<Conversation> {
    const copied = conv.messages.slice(0, index + 1);
    const messages = copyMessages(copied);
    const pause = branchPause(conv, index);
    // A branch of the conversation the reply was written in (this one, or one it was copied from).
    const titleOf = (from: string) => this.store.titleOf(from);
    let branch = branchOrigin(conv, index, messages, titleOf);
    const id = randomUUID();
    let chat: Conversation;
    try {
      await copyAttachments(conv.id, id, copied.flatMap(attachmentsOf));
      // Worked out again in the same step as it is saved, while the copied messages are still here as
      // they were: a conversation it comes from that was deleted meanwhile, which only this
      // conversation waits for, is then known as deleted, with where it came from (`via`).
      if (copied.every((m, i) => conv.messages[i]?.id === m.id)) branch = branchOrigin(conv, index, messages, titleOf);
      const now = Date.now();
      chat = {
        id,
        title: t().branchTitle(branch.fromTitle).slice(0, 200),
        createdAt: now,
        updatedAt: now,
        agents: structuredClone(conv.agents),
        settings: structuredClone(conv.settings),
        messages,
        agentState: {},
        worktrees: {},
        ...(conv.allowRules?.length ? { allowRules: structuredClone(conv.allowRules) } : {}),
        ...(pause ? { pause } : {}),
        branch,
      };
      this.store.create(chat);
    } catch (err) {
      removeAttachments(id);
      throw err;
    }
    this.store.placeBranch(id);
    // The diffs of the copied replies stay viewable here, also once the original is deleted.
    const byRoot = new Map<string, string[]>();
    for (const m of messages) {
      for (const c of m.changes ?? []) byRoot.set(c.root, [...(byRoot.get(c.root) ?? []), c.base, c.head]);
    }
    for (const [root, commits] of byRoot) {
      await keepCommits(root, id, commits).catch((err) =>
        console.warn("[orchestrator] could not keep a branch's snapshot refs:", (err as Error).message),
      );
    }
    return chat;
  }

  private getIdle(convId: string): Conversation {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    this.checkAvailable(convId, t().busy);
    if (conv.agents.length === 0 && !conv.settings.autoTeam) throw new HttpError(400, t().noAgents);
    return conv;
  }

  /**
   * Drop a message and everything after it, and make every agent start over. `keep`: attached files
   * that live on in the edited message.
   */
  private truncateFrom(conv: Conversation, messageId: string, keep: AttachmentPart[] = []): void {
    const index = conv.messages.findIndex((m) => m.id === messageId);
    if (index < 0) throw new HttpError(404, t().messageNotFound);
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
      const was = conv.agentState[agentId];
      // What each CLI's state folder was written with stays recorded: those folders are not emptied here.
      const state: AgentSessionState = { provider: was?.provider, permission: was?.permission, ...(was?.byCli ? { byCli: was.byCli } : {}), seen: [] };
      conv.agentState[agentId] = state;
      this.store.saveAgentState(conv.id, agentId, state);
    }
    // Parallel worktrees hold the dropped turns' work: start them again from the working directory.
    for (const [agentId, list] of Object.entries(conv.worktrees)) {
      for (const w of list) {
        w.needsReset = true;
        this.store.saveWorktree(conv.id, agentId, w);
      }
    }
    // Whatever question the team waited on is answered by starting over from here.
    conv.pause = undefined;
    // A branch whose copied messages were dropped: they now end with the last one left, if any, and
    // with nothing left of the conversation it was branched from, it is a branch of the one further up.
    if (conv.branch) {
      const cut = branchAfterCut(conv, new Set(dropped.map((m) => m.id)));
      const moved = cut && cut.fromId !== conv.branch.fromId;
      // Under another conversation now: by its title now, as a branch made there would be.
      const next = moved ? { ...cut, fromTitle: this.store.titleOf(cut.fromId) ?? cut.fromTitle } : cut;
      if (!isDeepStrictEqual(next, conv.branch)) {
        // Still called "Branch · …", it is named after where it comes from now, or with nothing copied
        // left it is a new chat; either way the message that comes next names it.
        if (isBranchTitle(conv.title, conv.branch.fromTitle) && (moved || !next)) {
          conv.title = next ? t().branchTitle(next.fromTitle).slice(0, 200) : t().defaultTitle;
        }
        conv.branch = next;
        this.store.saveMeta(conv);
      }
    }
    this.hub.emit(conv.id, {
      type: 'snapshot',
      conversation: forClient(conv),
      running: false,
      activeAgentIds: [],
      ...(this.folderWaiters.has(conv.id) ? { waitsForFolder: true } : {}),
    });
  }

  /**
   * Whether a run first has the lead agent design the team (auto team): when the conversation has no
   * team yet; for a question of the user's own sent while nothing runs (also with "stop and ask this
   * instead", which stops the team first), unless it answers an agent's question or @mentions members
   * of the current team; and on Continue after a design was stopped. A retry, a schedule, a confirmed
   * team and messages written while the team worked (delivered to its next turns, or answered in a
   * run of their own after it) keep the current team.
   */
  private designs(conv: Conversation, text: string, opts: StartOptions): boolean {
    if (!conv.settings.autoTeam || opts.only) return false;
    if (opts.designSchedule || conv.agents.length === 0) return true;
    if (opts.keepTeam) return false;
    if (opts.question === 'new' && conv.pause) return false;
    if (opts.question) return parseMentions(text, conv.agents).length === 0;
    return designOwed(conv.messages);
  }

  /** Start a run that posts `text` (if any) as the user's message; see `StartOptions`. */
  private async start(conv: Conversation, text: string, opts: StartOptions = {}): Promise<void> {
    const { beforePost, only, files = [] } = opts;
    const convId = conv.id;
    // A run that designs the team writes nothing (the lead agent is read-only and nobody else
    // speaks), so it locks nothing.
    const planning = this.designs(conv, text, opts);
    // Reserved until the run is registered, so a settings change or an apply cannot slip in while the
    // workspace is prepared, and a delete waits for it; a message sent meanwhile waits in the queue.
    const release = this.reserve(convId);
    this.starting.add(convId);
    if (planning) this.designing.add(convId);
    // Messages queued from now on were sent after this one: they wait for the first turn. When the
    // user answers an agent's question, scheduled messages stay queued too: the run picks up where
    // the team stopped, so they wait for a turn of an agent they are for, or for a run of their own.
    const ahead = opts.queue
      ? new Set((conv.queue ?? []).filter((m) => !(conv.pause && m.scheduled)).map((m) => m.id))
      : undefined;
    let lockRoots: string[] | undefined;
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
      // Set once the locks are taken: a run that could not take them releases none.
      const roots = ws.folders && !ws.isolated && !planning ? rootsOf(ws) : undefined;
      if (roots) this.lockDirs(roots, conv);
      lockRoots = roots;
      beforePost?.();
      if (ahead) posted = this.deliverQueued(conv, { ids: ahead });
      const own = this.postUserMessage(conv, text, files, opts.scheduled);
      if (own) posted.push(own);
      resume = this.takePause(conv, posted, only, planning);
      run = {
        abort: new AbortController(),
        active: new Set(),
        turns: new Set(),
        ws,
        lockRoots,
        // Only while nothing the user wrote starts it: when they write, they are here.
        ...(opts.refuseApprovals && posted.every((m) => m.scheduled) ? { refuseApprovals: true } : {}),
        ...(planning ? { designs: true } : {}),
        ...(planning && opts.designSchedule && conv.schedule ? { designFor: conv.schedule.text } : {}),
        done: Promise.resolve(),
      };
      this.runs.set(convId, run);
      this.folderWaiters.delete(convId);
    } catch (err) {
      if (lockRoots && !this.runs.has(convId)) this.unlockDirs(lockRoots, convId);
      this.designing.delete(convId);
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
          // A review stopped says so on its card.
          if (run.abort.signal.aborted && !run.reviewing) this.systemNote(conv, t().stoppedNote);
          conv.updatedAt = Date.now();
          this.store.flush(conv.id);
          this.store.saveMeta(conv);
        } catch (err) {
          console.error('[orchestrator] could not save the end of a run:', err);
        } finally {
          if (run.lockRoots) this.unlockDirs(run.lockRoots, conv.id);
          this.runs.delete(convId);
          this.designing.delete(convId);
          // The team the lead agent just designed answers at once, when it needs no confirmation.
          // Otherwise, messages sent while the team replied that no turn took: the team answers them
          // now. After Stop they keep waiting, for the user to send or withdraw.
          const next =
            !run.abort.signal.aborted &&
            (run.answerNext ? this.startConfirmed(conv, run.refuseApprovals) : this.startQueued(conv));
          if (!next) this.emitStatus(conv.id);
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

  /**
   * Folders snapshots never take in: the CLIs' own homes and every account's, with their sign-ins and
   * transcripts (the open agents' are in Harness Relay's data folder when no agent-home folder is set).
   */
  private snapshotExcludes(): string[] {
    return [...new Set([...(this.settings.agentHome ? [this.settings.agentHome] : [OPEN_HOMES_DIR]), ...this.settings.accountHomes()])];
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
  private postUserMessage(conv: Conversation, text: string, files: AttachmentPart[], scheduled = false): ChatMessage | undefined {
    let msg: ChatMessage | undefined;
    if (text || files.length) {
      msg = {
        id: randomUUID(),
        author: { kind: 'user' },
        createdAt: Date.now(),
        parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
        status: 'done',
        ...(scheduled ? { scheduled: true } : {}),
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

  /**
   * A conversation still called "New chat" is named after the first line of the user's message, and
   * so is a branch still called "Branch · <title>": by what the user goes on with there, which tells
   * it from the conversation it came from and from the other branches of it.
   */
  private nameAfter(conv: Conversation, msg: ChatMessage): void {
    if (!isDefaultTitle(conv.title) && !(conv.branch && isBranchTitle(conv.title, conv.branch.fromTitle))) return;
    const line = titleFrom(textOf(msg)) || (attachmentsOf(msg)[0]?.name ?? '');
    if (!line) return;
    conv.title = titleFrom(line);
    this.emitConversation(conv);
  }

  stop(convId: string): void {
    this.runs.get(convId)?.abort.abort();
    // Waiting for its folder: it stops waiting, and starts when the user sends or continues.
    if (this.folderWaiters.delete(convId)) {
      const conv = this.store.get(convId);
      if (conv && !this.deleting.has(convId)) this.systemNote(conv, t().folderWaitStopped);
      this.emitStatus(convId);
    }
  }

  /** It waits for a folder another conversation is changing, and starts by itself once it is free. */
  waitsForFolder(id: string): boolean {
    return this.folderWaiters.has(id);
  }

  /** Shutting down: stop every run, and refuse new runs, applies and settings changes. */
  stopAll(): void {
    this.closing = true;
    for (const r of this.runs.values()) r.abort.abort();
    for (const set of this.revisions.values()) for (const r of set) r.abort.abort();
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
      schedule: conv.schedule,
    });
  }

  // Workspace ---------------------------------------------------------------

  /**
   * Agents that may write need git repositories (created automatically) to track and isolate changes:
   * one for each working directory (two may share one).
   */
  async prepareWorkspace(conv: Conversation): Promise<RunWorkspace> {
    if (conv.settings.permission === 'read-only') return { isolated: false };
    const cwds = cwdsOf(conv.settings);
    // Outermost first: a folder inside another joins the repository made for that one, rather than
    // becoming one of its own, without a commit, inside it (git could not snapshot the outer one).
    const roots = new Map<string, string>();
    for (const cwd of [...cwds].sort((a, b) => realDepth(a) - realDepth(b))) {
      const { root, created } = await ensureRepo(cwd);
      if (created) this.systemNote(conv, t().gitInitNote(root));
      roots.set(cwd, root);
    }
    return { folders: cwds.map((cwd) => ({ cwd, root: roots.get(cwd)! })), isolated: conv.settings.mode === 'parallel' };
  }

  /**
   * Lock directories for this conversation's writes, all of them or none. Another conversation's lock
   * on one of them, or on one inside or around it (nested repositories), conflicts.
   */
  private lockDirs(roots: string[], conv: Conversation): void {
    const within = (a: string, b: string) => a.startsWith(b.endsWith(sep) ? b : b + sep);
    for (const root of roots) {
      for (const [held, holder] of this.dirLocks) {
        if (holder !== conv.id && (held === root || within(held, root) || within(root, held))) {
          const title = this.store.get(holder)?.title ?? holder;
          throw new HttpError(409, t().dirLocked(title, held), FOLDER_LOCKED, [held]);
        }
      }
    }
    for (const root of roots) this.dirLocks.set(root, conv.id);
  }

  /**
   * Why a run of this conversation could not take its directory locks now, as far as can be told
   * without git: another conversation holds a lock on a folder around or inside one of its working
   * directories. (The locks taken when the run starts are the ones that count.)
   */
  private folderLockedBy(conv: Conversation): string | undefined {
    if (conv.settings.permission === 'read-only' || conv.settings.mode === 'parallel') return undefined;
    const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
    for (const dir of cwdsOf(conv.settings)) {
      let cwd: string;
      try {
        cwd = realpathSync(dir);
      } catch {
        continue;
      }
      for (const [held, holder] of this.dirLocks) {
        if (holder !== conv.id && (within(cwd, held) || within(held, cwd))) {
          return t().dirLocked(this.store.get(holder)?.title ?? holder, held);
        }
      }
    }
    return undefined;
  }

  private unlockDirs(roots: string[], convId: string): void {
    let freed = false;
    for (const root of roots) {
      if (this.dirLocks.get(root) !== convId) continue;
      this.dirLocks.delete(root);
      freed = true;
    }
    // A folder is free now: who waited for one tries again, once whatever released it has finished its
    // step (a run's end may start the next run itself).
    if (freed && this.folderWaiters.size) setImmediate(() => this.retryFolderWaiters());
  }

  /**
   * An approved action in a run that holds no directory lock (read-only, which never locks) writes
   * the shared directories too: take their locks first. Returns why it cannot, when another
   * conversation is writing in one of them (the action is then declined).
   */
  private lockForApproval(conv: Conversation, run: Run): string | undefined {
    // A run that has ended let go of its lock already: taking one now would keep it until a restart.
    if (this.runs.get(conv.id) !== run) return undefined;
    if (run.ws.isolated || run.lockRoots) return undefined;
    const dirs: string[] = [];
    for (const cwd of cwdsOf(conv.settings)) {
      try {
        dirs.push(realpathSync(cwd));
      } catch {
        /* not there: nothing to lock */
      }
    }
    if (!dirs.length) return undefined;
    try {
      this.lockDirs(dirs, conv);
      run.lockRoots = dirs;
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /**
   * Give every participant its own worktree of each repository (`roots`), starting from a snapshot of
   * it, and remove the worktrees of repositories no working directory is in any more.
   */
  private async prepareWorktrees(conv: Conversation, agents: AgentConfig[], roots: string[]): Promise<void> {
    const bases = new Map<string, string>();
    for (const a of agents) {
      const had = conv.worktrees[a.id] ?? [];
      for (const gone of had.filter((w) => !roots.includes(w.root))) {
        await removeWorktree(gone.root, gone.path, gone.branch).catch(() => {});
        this.store.deleteWorktree(conv.id, a.id, gone.root);
      }
      const next: AgentWorktree[] = [];
      for (const root of roots) {
        const cur = had.find((w) => w.root === root);
        if (cur && !cur.needsReset && existsSync(cur.path)) {
          next.push(cur);
          continue;
        }
        let base = bases.get(root);
        if (!base) {
          base = (await snapshot(root, this.snapshotExcludes())).commit;
          bases.set(root, base);
        }
        const wt: AgentWorktree = {
          root,
          // A folder of its own for each repository (an earlier one, of the agent's id alone, is kept).
          path: cur ? cur.path : join(DATA_DIR, 'worktrees', conv.id, `${a.id}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`),
          branch: cur ? cur.branch : `relay/${conv.id.slice(0, 8)}/${a.name}`,
          base,
          needsReset: false,
        };
        await createWorktree(root, wt.path, wt.branch, base);
        next.push(wt);
        this.store.saveWorktree(conv.id, a.id, wt);
      }
      conv.worktrees[a.id] = next;
    }
    this.emitConversation(conv);
  }

  /**
   * Apply everything an agent did in its worktrees to the real working directories (uncommitted):
   * every patch is checked before any is applied, so a conflict in one changes nothing anywhere.
   */
  async applyAgentWork(convId: string, agentId: string): Promise<FileChange[]> {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    if (!conv.worktrees[agentId]?.length) throw new HttpError(404, t().noWorktree);
    if (conv.worktrees[agentId]!.some((w) => w.needsReset)) throw new HttpError(409, t().resultStale);
    // Reserved at once (before anything is awaited), so the team cannot start writing (and take over
    // these locks) while the patches are applied.
    return this.exclusive(convId, t().busyApply, async () => {
      const wts = await this.currentWorktrees(conv, agentId);
      if (!wts.length) throw new HttpError(400, t().nothingToApply);
      const roots = wts.map((w) => w.root);
      this.lockDirs(roots, conv);
      try {
        const checked = [];
        for (const wt of wts) {
          const patch = await checkPatch(wt.root, wt.base, await worktreeHead(wt.path));
          if (patch) checked.push(patch);
        }
        if (!checked.length) throw new HttpError(400, t().nothingToApply);
        const resetAll = () => {
          for (const [id, list] of Object.entries(conv.worktrees)) {
            for (const w of list) {
              w.needsReset = true;
              this.store.saveWorktree(conv.id, id, w);
            }
          }
        };
        let applied = 0;
        try {
          for (const patch of checked) {
            await applyPatch(patch);
            applied++;
          }
        } catch (err) {
          // A file changed between the check and the apply: what was applied stays, and the
          // directories have changed, so the worktrees start again from them.
          if (applied) {
            resetAll();
            this.emitConversation(conv);
          }
          throw err;
        }
        const files = checked.flatMap((p) => p.files);
        resetAll();
        const name = conv.agents.find((a) => a.id === agentId)?.name ?? agentId;
        this.systemNote(conv, t().appliedNote(name, files.length));
        this.emitConversation(conv);
        return files;
      } finally {
        this.unlockDirs(roots, conv.id);
      }
    });
  }

  /**
   * An agent's worktrees of the repositories the conversation's working directories are in now. One
   * of a folder taken off the list stays until the next parallel run removes it, but is neither
   * applied nor shown.
   */
  private async currentWorktrees(conv: Conversation, agentId: string): Promise<AgentWorktree[]> {
    const roots = new Set(await Promise.all(cwdsOf(conv.settings).map((cwd) => repoRoot(cwd).catch(() => null))));
    return (conv.worktrees[agentId] ?? []).filter((w) => roots.has(w.root));
  }

  /** The diffs of several repositories, one after another; with more than one, their paths start with their folders' names. */
  private async diffs(parts: { root: string; base: string; head: string }[]): Promise<string> {
    if (parts.length === 1) return diffText(parts[0]!.root, parts[0]!.base, parts[0]!.head);
    const labels = folderLabels(parts.map((p) => p.root));
    const texts = await Promise.all(parts.map((p) => diffText(p.root, p.base, p.head, labels.get(p.root))));
    return texts.join('');
  }

  async messageDiff(convId: string, messageId: string): Promise<string> {
    const msg = this.store.get(convId)?.messages.find((m) => m.id === messageId);
    if (!msg?.changes?.length) throw new HttpError(404, t().noChanges);
    return this.diffs(msg.changes);
  }

  async agentDiff(convId: string, agentId: string): Promise<string> {
    const conv = this.store.get(convId);
    const wts = conv ? await this.currentWorktrees(conv, agentId) : [];
    if (!wts.length) throw new HttpError(404, t().noWorktree);
    return this.diffs(await Promise.all(wts.map(async (w) => ({ root: w.root, base: w.base, head: await worktreeHead(w.path) }))));
  }

  /**
   * Auto team: the lead agent (Settings) chooses the team for the user's question — keeping the
   * current team, using or adapting a template, or designing a new one — shown as a plan card. When
   * planning fails the current team is kept (the general-question template when there is none); when
   * it is stopped, the next question or Continue designs again. The team waits for the user's
   * confirmation, unless the conversation uses it at once (`autoConfirm`: it then answers when this
   * run ends).
   */
  private async designTeam(conv: Conversation, run: Run): Promise<void> {
    const lead = this.settings.lead;
    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'system' },
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
      plan: { status: 'planning', lead, ...(run.designFor !== undefined ? { forSchedule: true } : {}) },
    };
    conv.messages.push(msg);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);

    // The question: everything the user said since the team last spoke or a team was designed (a
    // stopped design leaves its question standing). What was said before is its context.
    const since = questionStart(conv.messages);
    const asked = conv.messages.slice(since).filter((m) => m.author.kind === 'user');
    const fileNames = asked.flatMap((m) => attachmentsOf(m).map((p) => p.name));
    // A design for the schedule is for its message, which nobody posted.
    const question =
      run.designFor ??
      asked.map(textOf).filter(Boolean).join('\n\n') + (fileNames.length ? `\n\n(Attached files: ${fileNames.join(', ')})` : '');
    const current: PlanConversation['current'] = conv.agents.length
      ? { agents: conv.agents, settings: { mode: conv.settings.mode, rounds: conv.settings.rounds, maxHops: conv.settings.maxHops } }
      : undefined;
    const history = historyForLead(conv.messages.slice(0, since));
    // Lead review is offered while it is off; what the user switches meanwhile stands.
    const switches = this.reviewSwitches.get(conv.id) ?? 0;
    const offered = !conv.settings.leadReview;
    const started = Date.now();
    let ctx: PlannerContext = { available: [], catalog: [], presets: this.store.listPresets() };
    let decision: PlanDecision | undefined;
    let result: RunResult | undefined;
    try {
      ctx = await this.planner.context(conv.settings.cwd, conv.settings.extraCwds);
      let reply = '';
      result = await runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider, lead.account),
        backends: this.settings.backendsFor(lead.provider),
        nativeOff: this.settings.nativeOff(lead.provider, lead.account),
        nativeItems: this.settings.nativeItems(lead.provider, lead.account),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: buildPlannerPrompt(question, conv.settings, ctx, {
          history,
          current,
          ...(run.designFor !== undefined ? { schedule: { newChat: Boolean(conv.schedule?.newChat) } } : {}),
        }),
        systemPrompt: PLANNER_BRIEFING,
        cwd: conv.settings.cwd,
        permission: 'read-only',
        stateKey: stateKeys.lead(conv.id),
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal: run.abort.signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
      // The lead agent's session belongs to this conversation too.
      if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
      decision = decidePlan(parsePlanReply(reply), ctx, lead, current);
    } catch (err) {
      if (!run.abort.signal.aborted) {
        console.warn('[orchestrator] team design failed:', (err as Error).message);
        decision = fallbackPlan(ctx, lead, (err as Error).message, current);
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
      // Members who stay on keep their ids, and with them their sessions.
      const agents = keepMemberIds(decision.agents, conv.agents);
      const now = Boolean(conv.settings.autoConfirm);
      // Lead review: the lead may turn it on (at once, whether or not the team is confirmed), never
      // off, and leaves it alone when it is on already.
      const { leadReview: turnsOn, ...team } = decision;
      const reviews =
        Boolean(turnsOn) && offered && !conv.settings.leadReview && (this.reviewSwitches.get(conv.id) ?? 0) === switches;
      if (reviews) {
        conv.settings = { ...conv.settings, leadReview: true };
        this.store.saveMeta(conv);
        this.emitConversation(conv);
      }
      msg.plan = {
        status: 'ready',
        lead,
        ...team,
        ...(reviews ? { leadReview: turnsOn } : {}),
        agents,
        ...(now ? { confirmedAt: Date.now(), autoConfirmed: true } : { awaitingConfirmation: true }),
        ...(run.designFor !== undefined ? { forSchedule: true } : {}),
      };
      msg.status = 'done';
      // Used at once, or kept on the card until the user confirms it: until then the current team
      // stays, so declining it, a retry or an edit of an earlier message still has that team. A team
      // for the schedule answers when the schedule sends its message.
      if (now) {
        this.applyPlan(conv, msg.plan);
        if (run.designFor === undefined) run.answerNext = true;
      }
    }
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /**
   * Lead review: the lead agent (Settings) reads what the team said since its last review and tells
   * the user what to look at closely and what to do next, on a card after the replies. It runs
   * read-only, as the last step of the team's run: Stop stops it, and what the user sends meanwhile
   * waits for it. A review that fails says why on its card; the next one reads these replies again.
   */
  private async reviewReplies(conv: Conversation, run: Run): Promise<void> {
    const material = reviewMaterial(conv.messages);
    if (!material.replies.length) return;
    const lead = this.settings.lead;
    const replyIds = material.replies.map((m) => m.id);
    // In parallel mode with write access, what each member changed is in its own worktrees until it is
    // applied: the lead is told where, and may read them, as it may the other working directories.
    const worktrees = run.ws.isolated ? this.reviewWorktrees(conv, run, material.replies) : [];
    const addDirs = [...(conv.settings.extraCwds ?? []), ...worktrees.flatMap((w) => w.dirs)];
    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'system' },
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
      review: { status: 'reviewing', lead, replyIds, ...(material.fromId ? { fromId: material.fromId } : {}) },
    };
    conv.messages.push(msg);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);

    this.reviewing.add(conv.id);
    const started = Date.now();
    let result: RunResult | undefined;
    let review: Pick<LeadReview, 'summary' | 'highlights' | 'nextSteps'> | undefined;
    let failure = '';
    try {
      let reply = '';
      result = await runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider, lead.account),
        backends: this.settings.backendsFor(lead.provider),
        nativeOff: this.settings.nativeOff(lead.provider, lead.account),
        nativeItems: this.settings.nativeItems(lead.provider, lead.account),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: buildReviewPrompt(material, conv.agents, conv.settings, worktrees),
        systemPrompt: REVIEWER_BRIEFING,
        cwd: conv.settings.cwd,
        ...(addDirs.length ? { addDirs } : {}),
        permission: 'read-only',
        stateKey: stateKeys.review(conv.id),
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal: run.abort.signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
      // The lead agent's session belongs to this conversation too.
      if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
      review = parseReviewReply(reply, material.replies);
    } catch (err) {
      if (!run.abort.signal.aborted) {
        console.warn('[orchestrator] lead review failed:', (err as Error).message);
        failure = (err as Error).message.trim().slice(0, 500);
      }
    } finally {
      this.reviewing.delete(conv.id);
    }

    msg.meta = {
      durationMs: Date.now() - started,
      costUsd: result?.costUsd,
      inputTokens: result?.inputTokens,
      outputTokens: result?.outputTokens,
    };
    if (run.abort.signal.aborted) {
      msg.status = 'aborted';
    } else {
      const read = { replyIds, ...(material.fromId ? { fromId: material.fromId } : {}) };
      msg.review = review
        ? { status: 'ready', lead, ...review, ...read }
        : { status: 'failed', lead, ...read, ...(failure ? { error: failure } : {}) };
      msg.status = 'done';
    }
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /**
   * The worktrees of the members whose replies a review reads, in parallel mode with write access: for
   * each member, its folder of each working directory, in their order.
   */
  private reviewWorktrees(conv: Conversation, run: Run, replies: ChatMessage[]): { name: string; dirs: string[] }[] {
    const out: { name: string; dirs: string[] }[] = [];
    for (const agent of conv.agents) {
      if (!replies.some((m) => m.author.kind === 'agent' && m.author.agentId === agent.id)) continue;
      const own = conv.worktrees[agent.id] ?? [];
      const dirs = (run.ws.folders ?? []).flatMap((f) => {
        const wt = own.find((w) => w.root === f.root);
        return wt ? [worktreeCwd(f.root, f.cwd, wt.path)] : [];
      });
      if (dirs.length) out.push({ name: agent.name, dirs });
    }
    return out;
  }

  /**
   * Turn lead review on or off (the team design card's box). Any time, also while the team replies:
   * whether the lead agent reviews is decided when the team has answered.
   */
  setLeadReview(convId: string, on: boolean): Conversation {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    this.reviewSwitches.set(convId, (this.reviewSwitches.get(convId) ?? 0) + 1);
    if (Boolean(conv.settings.leadReview) !== on) {
      const { leadReview: _was, ...rest } = conv.settings;
      conv.settings = on ? { ...rest, leadReview: true } : rest;
      this.store.saveMeta(conv);
      this.emitConversation(conv);
    }
    return conv;
  }

  /** The lead agent's team becomes the conversation's team (members and how they take turns). */
  private applyPlan(conv: Conversation, plan: NonNullable<ChatMessage['plan']>): void {
    if (!plan.agents?.length || !plan.settings) return;
    conv.agents = plan.agents.map((a) => ({ ...a }));
    conv.settings = { ...conv.settings, ...plan.settings };
    this.store.saveMeta(conv);
    this.emitConversation(conv);
  }

  /** The user accepts the lead agent's team design: it becomes the team, and answers the question. */
  confirmPlan(convId: string, messageId: string): void {
    this.answerPlan(convId, messageId, 'confirm');
  }

  /**
   * The user declines the lead agent's team design: the current team stays, and answers the question.
   * Only when there is a team to keep (not for a conversation's first question).
   */
  declinePlan(convId: string, messageId: string): void {
    this.answerPlan(convId, messageId, 'decline');
  }

  private answerPlan(convId: string, messageId: string, answer: 'confirm' | 'decline'): void {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const msg = conv.messages.find((m) => m.id === messageId);
    if (msg?.plan?.status !== 'ready') throw new HttpError(404, t().planNotFound);
    if (!msg.plan.awaitingConfirmation) return; // answered already
    if (answer === 'decline' && conv.agents.length === 0) throw new HttpError(400, t().planNoCurrentTeam);
    // Not while something else holds the conversation: the team could not answer now.
    this.checkAvailable(convId, t().busy);
    if (answer === 'confirm') this.applyPlan(conv, msg.plan);
    this.markAnswered(conv, msg, answer);
    // The team answers the question now, with what the user wrote while it waited for confirmation.
    this.startConfirmed(conv);
  }

  /**
   * A team set by hand is the user's decision too: it settles a design that was waiting (the team
   * set by hand is the one that answers). Returns whether it did (the caller then lets the team
   * answer, `startConfirmed`).
   */
  confirmPendingPlan(conv: Conversation): boolean {
    const msg = pendingPlan(conv.messages);
    if (!msg) return false;
    this.markAnswered(conv, msg, 'confirm');
    return true;
  }

  private markAnswered(conv: Conversation, msg: ChatMessage, answer: 'confirm' | 'decline'): void {
    delete msg.plan!.awaitingConfirmation;
    if (answer === 'confirm') msg.plan!.confirmedAt = Date.now();
    else msg.plan!.declinedAt = Date.now();
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
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

  /**
   * The user asks the lead agent to change the team they are editing in the team drawer (`input`: the
   * request, and the team as it stands in the drawer: the conversation's team or the lead's design
   * waiting for confirmation, maybe edited by hand already). The lead returns the whole team with that
   * change; nothing changes in the conversation, since the drawer shows the team until the user saves
   * it. A new request for the conversation stops one still running; so does `signal` (the drawer was
   * closed, or the user stopped it). A stopped one is still waited for (on delete and shutdown) until
   * its lead process has ended.
   */
  async reviseTeam(convId: string, input: { request?: unknown; agents?: unknown; settings?: unknown }, signal?: AbortSignal): Promise<TeamRevision> {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    if (this.closing) throw new HttpError(503, t().shuttingDown);
    const request = typeof input.request === 'string' ? input.request.trim() : '';
    if (!request) throw new HttpError(400, t().reviseEmpty);
    if (request.length > REVISE_REQUEST_MAX) throw new HttpError(400, t().reviseTooLong(REVISE_REQUEST_MAX));
    // A team saved before the team limit was lowered may be larger: the lead may be asked to shrink it
    // (its answer is cut to the limit).
    const draftMax = Math.max(CONFIG.maxTeamAgents, conv.agents.length);
    const draft: TeamDraft = { agents: validateAgents(input.agents, draftMax), settings: teamSettings(input.settings, conv.settings) };
    // What the drawer says (maybe not saved yet), for the lead to read; it works in the saved folder.
    const place = draftPlace(input.settings, conv.settings);

    const running = this.revisions.get(convId) ?? new Set();
    for (const r of running) r.abort.abort();
    const abort = new AbortController();
    const stop = () => abort.abort();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const done = this.runRevision(conv, request, draft, place, abort.signal);
    const entry = { abort, done };
    running.add(entry);
    this.revisions.set(convId, running);
    void done
      .catch(() => undefined)
      .finally(() => {
        running.delete(entry);
        if (!running.size && this.revisions.get(convId) === running) this.revisions.delete(convId);
      });
    try {
      return await done;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  private async runRevision(
    conv: Conversation,
    request: string,
    draft: TeamDraft,
    place: Pick<Conversation['settings'], 'permission' | 'cwd' | 'extraCwds'>,
    signal: AbortSignal,
  ): Promise<TeamRevision> {
    const lead = this.settings.lead;
    const started = Date.now();
    const stopped = () => new HttpError(409, t().reviseStopped);
    const waiting = pendingPlan(conv.messages)?.plan;
    let reply = '';
    let result: RunResult;
    let ctx: PlannerContext;
    try {
      // The folder the team will work in: the drawer's, saved or not.
      ctx = await this.planner.context(place.cwd, place.extraCwds);
      if (signal.aborted) throw stopped();
      result = await runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider, lead.account),
        backends: this.settings.backendsFor(lead.provider),
        nativeOff: this.settings.nativeOff(lead.provider, lead.account),
        nativeItems: this.settings.nativeItems(lead.provider, lead.account),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: buildRevisePrompt(request, draft, place, ctx, {
          history: historyForLead(conv.messages),
          pending: waiting ? (waiting.forSchedule ? 'schedule' : 'question') : undefined,
          // Shown while it is on, or when the waiting design is for it.
          schedule:
            conv.schedule && (conv.schedule.enabled || waiting?.forSchedule)
              ? { text: conv.schedule.text, on: conv.schedule.enabled }
              : undefined,
          // Told only when the drawer names another folder (not the same one spelled another way).
          savedCwd: sameFolder(place.cwd, conv.settings.cwd) ? undefined : conv.settings.cwd,
        }),
        systemPrompt: REVISER_BRIEFING,
        cwd: conv.settings.cwd,
        stateKey: stateKeys.revise(conv.id),
        permission: 'read-only',
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
    } catch (err) {
      if (signal.aborted) throw stopped();
      console.warn('[orchestrator] team revision failed:', (err as Error).message);
      throw new HttpError(503, t().reviseFailed((err as Error).message));
    }
    // The lead agent's session belongs to this conversation too.
    if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
    if (signal.aborted) throw stopped();
    try {
      const revised = decideRevision(parsePlanReply(reply), draft, ctx, lead);
      return {
        ...revised,
        meta: { durationMs: Date.now() - started, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      };
    } catch (err) {
      throw new HttpError(503, t().reviseFailed((err as Error).message));
    }
  }

  /** Stop keeping the commits of dropped messages that no remaining message links to. */
  private async forgetChanges(conv: Conversation, dropped: ChatMessage[]): Promise<void> {
    const inUse = new Set(conv.messages.flatMap((m) => (m.changes ?? []).flatMap((c) => [c.base, c.head])));
    const byRoot = new Map<string, string[]>();
    for (const m of dropped) {
      for (const c of m.changes ?? []) {
        const commits = [c.base, c.head].filter((commit) => !inUse.has(commit));
        byRoot.set(c.root, [...(byRoot.get(c.root) ?? []), ...commits]);
      }
    }
    for (const [root, commits] of byRoot) await forgetCommits(root, conv.id, commits);
  }

  /** Remove a conversation's worktrees and branches, and the snapshot refs it kept (before deleting it). */
  async cleanupWorktrees(conv: Conversation): Promise<void> {
    const worktrees = Object.values(conv.worktrees).flat();
    for (const wt of worktrees) {
      await removeWorktree(wt.root, wt.path, wt.branch).catch((err) =>
        console.warn('[orchestrator] worktree cleanup failed:', (err as Error).message),
      );
    }
    rmSync(join(DATA_DIR, 'worktrees', conv.id), { recursive: true, force: true });
    removeAttachments(conv.id);
    const cwdRoots = await Promise.all(cwdsOf(conv.settings).map((cwd) => repoRoot(cwd).catch(() => null)));
    const roots = new Set([
      ...worktrees.map((w) => w.root),
      ...conv.messages.flatMap((m) => (m.changes ?? []).map((c) => c.root)),
      ...cwdRoots.filter((r): r is string => Boolean(r)),
    ]);
    for (const root of roots) {
      await dropKeptCommits(root, conv.id).catch((err) =>
        console.warn('[orchestrator] snapshot ref cleanup failed:', (err as Error).message),
      );
    }
  }

  // -------------------------------------------------------------------------

  /**
   * A run: the lead agent's team design (auto team), or the team's turns followed, with lead review,
   * by the lead agent's review of what the team said (`reviewsNow`).
   */
  private async execute(
    conv: Conversation,
    posted: ChatMessage[],
    run: Run,
    only?: AgentConfig[],
    resume?: Schedule,
  ): Promise<void> {
    if (run.designs) {
      // The lead agent designs the team for the question, and that is all this run does. Once the
      // team is confirmed (or needs no confirmation), a run of its own answers the question.
      await this.designTeam(conv, run);
      return;
    }
    await this.teamTurns(conv, posted, run, only, resume);
    if (!this.reviewsNow(conv, run)) return;
    run.reviewing = true;
    // The review writes nothing: other conversations may write in these folders meanwhile.
    if (run.lockRoots) {
      this.unlockDirs(run.lockRoots, conv.id);
      run.lockRoots = undefined;
    }
    await this.reviewReplies(conv, run);
  }

  /**
   * Whether the lead agent reviews the team's replies at the end of this run (lead review): the team
   * answered something new since the last review, and is done for now — not stopped, not waiting for
   * the user's answer to a question, and no message waiting for a run of its own after this one (the
   * review comes after that run, and reads both).
   */
  private reviewsNow(conv: Conversation, run: Run): boolean {
    if (!conv.settings.leadReview || run.abort.signal.aborted || this.closing) return false;
    if (this.deleting.has(conv.id) || this.store.get(conv.id) !== conv) return false;
    if (conv.pause || conv.queue?.length) return false;
    return hasNewReplies(conv.messages);
  }

  /**
   * The team's turns for the user's `posted` messages (none for Continue / retry). Messages sent while
   * it runs are delivered before the next turn of an agent they are for (`deliverQueued`). A reply that
   * asks the user something stops the run there (`pauseFor`); `resume` picks it up once they replied.
   */
  private async teamTurns(
    conv: Conversation,
    posted: ChatMessage[],
    run: Run,
    only?: AgentConfig[],
    resume?: Schedule,
  ): Promise<void> {
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
        this.deliverBefore(conv, run, [agent]);
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

    if (mode === 'parallel' && run.ws.isolated) await this.prepareWorktrees(conv, s.participants, rootsOf(run.ws));

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
        this.deliverBefore(conv, run, speakers);
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
          this.deliverBefore(conv, run, [a]);
          const msg = await this.turn(conv, a, run, info(a));
          msgs.push(msg);
          if (msg.asked) return pause([a], speakers.slice(i + 1));
        }
      }
      if (msgs.length && !msgs.some(spoke)) break; // everyone passed: the discussion has converged
    }
  }

  /**
   * Post the waiting messages for these speakers before their turn (`deliverQueued`). One the user
   * wrote means they are here: the run asks for approvals again, even if a schedule started it.
   */
  private deliverBefore(conv: Conversation, run: Run, recipients: AgentConfig[]): void {
    if (this.deliverQueued(conv, { recipients }).some((m) => !m.scheduled)) run.refuseApprovals = false;
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
   * longer waits. Only what the user wrote counts: a scheduled message that waited in the queue is no
   * answer, and its @mentions do not start afresh.
   */
  private takePause(conv: Conversation, posted: ChatMessage[], only: AgentConfig[] | undefined, planning: boolean): Schedule | undefined {
    const pause = conv.pause;
    if (!pause) return undefined;
    conv.pause = undefined;
    this.store.saveMeta(conv);
    this.emitConversation(conv);
    if (only || planning || pause.mode !== conv.settings.mode) return undefined;
    const replies = posted.filter((m) => !m.scheduled);
    if (replies.some((m) => parseMentions(textOf(m), conv.agents).some((a) => !pause.askers.includes(a.id)))) return undefined;
    const byId = (id: string) => conv.agents.find((a) => a.id === id);
    const askers = pause.askers.flatMap((id) => byId(id) ?? []);
    const skip = replies.length === 0;
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
    const lastProvider = state.provider;
    // The account it runs as: one that was removed is the default account. A session is kept in its
    // CLI's home, which is the account's, so another CLI or another account starts a new one.
    const account = this.settings.resolveAccount(agent.provider, agent.account);
    if (state.provider && (state.provider !== agent.provider || (state.account ?? '') !== account)) {
      state.sessionId = undefined;
      state.seen = [];
    }
    state.provider = agent.provider;
    if (account) state.account = account;
    else delete state.account;
    // Claude Code, Codex and Grok run on one of the user's endpoints or on their own service. A session
    // made on another one is not resumed: its context (Claude's signed thinking, Grok's session model)
    // belongs to that backend, and Grok would stay on an endpoint's model when the member's model is
    // the CLI's default. The run's model is the one `attempt` gets from `modelFor`, which for these CLIs
    // asks nothing: worked out here without waiting, so that in parallel mode every member's reply is
    // still added in the team's order.
    if (isEndpointCli(agent.provider)) {
      const model = agent.model?.trim() || this.settings.defaultModel(agent.provider, account) || undefined;
      const backend = endpointModel(this.settings.backendsFor(agent.provider), model)?.endpoint.id;
      if (state.sessionId && (state.backend ?? '') !== (backend ?? '')) {
        state.sessionId = undefined;
        state.seen = [];
      }
      if (backend) state.backend = backend;
      else delete state.backend;
    } else {
      delete state.backend;
    }
    // A member whose CLI's latest run had a lower permission (read-only → edit → full; not recorded
    // counts as read-only) does not resume its session: it starts a fresh one with the whole history
    // from Harness Relay's own record, and an open agent's state folder (one per CLI and member) is
    // emptied, so nothing a run with less permission wrote (into its session, or a cache that loads
    // code) is read with more. Kept per CLI: the folder of a CLI the member left keeps what it wrote.
    // The same when an open agent's home moved since that run (Settings → Agent sessions): its session
    // is in the other home, and the folder in this one may hold what an older run, at any permission,
    // left there. All of it is recorded in the database before the run, never in a file the agent can
    // write, and the flag that the folder must be emptied stays there until it has been.
    const permission = conv.settings.permission;
    const home = isOpenProvider(agent.provider) ? this.settings.openAgentHome(agent.provider) : undefined;
    // Saved before the record per CLI: the latest run's permission, when it was on this CLI.
    const lastRun = state.byCli
      ? state.byCli[agent.provider]
      : lastProvider === agent.provider && state.permission
        ? { permission: state.permission }
        : undefined;
    // A latest run recorded without its home (before homes were recorded) counts as in another one.
    const moved = home !== undefined && lastRun !== undefined && lastRun.home !== home;
    const raised = permissionAbove(permission, lastRun?.permission ?? 'read-only') || moved;
    if (raised && state.sessionId) {
      state.sessionId = undefined;
      state.seen = [];
    }
    const mustEmpty = isOpenProvider(agent.provider) && (raised || lastRun?.mustEmpty === true);
    const ran = { permission, ...(home ? { home } : {}) };
    state.permission = permission;
    state.byCli = { ...state.byCli, [agent.provider]: { ...ran, ...(mustEmpty ? { mustEmpty: true } : {}) } };
    this.store.saveAgentState(conv.id, agent.id, state);
    /** Why the turn cannot run: the member's state folder could not be emptied. */
    let notEmptied: AgentRunError | undefined;
    if (mustEmpty) {
      try {
        emptyStateFolder(home!, stateKeys.member(conv.id, agent.id));
        state.byCli[agent.provider] = ran;
        this.store.saveAgentState(conv.id, agent.id, state);
      } catch (err) {
        notEmptied = new AgentRunError(t().openStateNotEmptied(PROVIDER_LABEL[agent.provider], (err as Error).message));
      }
    }
    /** The run is told its state is fresh on the first attempt only (a fresh retry runs at the same permission). */
    let emptyState = mustEmpty;

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
    run.turns.add(msg.id);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.emitStatus(conv.id);

    // Where this agent works (the first working directory, the others beside it), and the state of
    // each repository before its turn (to record what it changed).
    const roots = rootsOf(run.ws);
    /** Its worktree of each repository, in parallel mode. */
    const wts: AgentWorktree[] = [];
    let cwd = conv.settings.cwd;
    let addDirs = conv.settings.extraCwds ?? [];
    let workspace: BriefingWorkspace = { kind: 'shared' };
    let before: Map<string, { commit: string; tree?: string }> | undefined;
    let setupError: unknown = notEmptied;
    try {
      // Settings from before the check (or changed since): edit mode in Harness Relay's own folder.
      const refusal = relayFolderRefusal(conv.settings, agentFolderOptions(this.settings));
      if (refusal) throw new AgentRunError(refusal);
      if (run.ws.isolated) {
        const own = conv.worktrees[agent.id] ?? [];
        for (const root of roots) {
          const wt = own.find((w) => w.root === root);
          if (!wt) throw new AgentRunError(t().noWorktree);
          wts.push(wt);
        }
        const folders = run.ws.folders!.map((f) => {
          const wt = wts.find((w) => w.root === f.root)!;
          return { cwd: worktreeCwd(f.root, f.cwd, wt.path), userCwd: f.cwd, branch: wt.branch, base: wt.base };
        });
        cwd = folders[0]!.cwd;
        addDirs = folders.slice(1).map((f) => f.cwd);
        // The folder each repository is named by: the first working directory in it.
        const named = (root: string) => run.ws.folders!.find((f) => f.root === root)!.cwd;
        workspace = {
          kind: 'isolated',
          folders,
          teammates: conv.agents.flatMap((a) => {
            if (a.id === agent.id) return [];
            const theirs = roots.map((root) => conv.worktrees[a.id]?.find((w) => w.root === root && !w.needsReset));
            if (!theirs.length || theirs.some((w) => !w)) return [];
            return [{ name: a.name, branch: theirs[0]!.branch, bases: theirs.map((w) => ({ folder: named(w!.root), base: w!.base })) }];
          }),
        };
      }
    } catch (err) {
      setupError = err; // reported as this turn's error below
    }
    try {
      if (run.ws.isolated && !setupError) {
        before = new Map();
        for (const wt of wts) before.set(wt.root, { commit: await worktreeHead(wt.path) });
      } else if (!run.ws.isolated && roots.length) {
        before = new Map();
        // Each repository on its own: one that cannot be snapshotted keeps the others' changes recorded.
        for (const root of roots) {
          try {
            before.set(root, await snapshot(root, this.snapshotExcludes()));
          } catch (err) {
            console.warn(`[orchestrator] could not snapshot ${root} before turn:`, (err as Error).message);
          }
        }
      }
    } catch (err) {
      before = undefined;
      console.warn('[orchestrator] could not snapshot before turn:', (err as Error).message);
    }

    let textOpen = false;
    /** What this agent had seen before the current attempt (what a crash mid-turn should keep). */
    let committedSeen = state.seen;
    /** Approval requests of this turn still waiting for the user (expired when the turn ends). */
    const waiting = new Set<string>();
    /** The turn's cleanup has started: a request that comes now is refused without asking. */
    let turnOver = false;
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
          msg.parts.push({ type: 'tool', id: e.id, name: e.name, detail: e.detail, ...(e.kind ? { kind: e.kind } : {}), status: 'running' });
          this.hub.emit(conv.id, { type: 'message', message: msg });
          break;
        case 'tool_end': {
          const part = msg.parts.find((p) => p.type === 'tool' && p.id === e.id);
          if (part?.type === 'tool') {
            part.status = e.ok ? 'done' : 'error';
            if (e.detail) part.detail = e.detail;
            if (e.error) part.error = e.error;
            if (e.output) part.output = e.output;
            this.hub.emit(conv.id, { type: 'message', message: msg });
          }
          break;
        }
      }
      this.store.saveMessage(conv.id, msg);
    };

    // Ask the user in the chat; the CLI waits until they answer (or the run is stopped). In a run a
    // schedule started, only what the conversation always allows goes through; the rest is refused.
    const requestApproval =
      conv.settings.approvals === 'deny'
        ? undefined
        : async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
            // Asked after the turn ended (a request queued behind another one, say): it expired, as
            // the turn's own waiting requests did. No card is shown, and nothing can lock the folder.
            if (turnOver) return { allow: false };
            // Keys come from the command as it will run; `detail` may be tidied up for display.
            // A request nothing tells apart gets no keys: no "always allow" (it would allow every such request).
            const keys = req.noRule ? [] : approvalKeys(req.kind, req.command ?? req.detail, req.tool);
            const part: Extract<MessagePart, { type: 'approval' }> = {
              type: 'approval',
              id: randomUUID(),
              kind: req.kind,
              tool: req.tool,
              detail: req.detail,
              reason: req.reason,
              ruleLabel: keys.join(', ') || undefined,
              ...(req.outsideSandbox ? { outsideSandbox: true } : {}),
              ...(req.readOnlySandbox ? { readOnlySandbox: true } : {}),
              status: 'pending',
            };
            textOpen = false;
            msg.parts.push(part);
            if (isAllowed(conv.allowRules, req.kind, keys)) {
              const busy = this.lockForApproval(conv, run);
              Object.assign(part, busy ? { status: 'denied', note: busy } : { status: 'allowed', always: true, auto: true });
              this.hub.emit(conv.id, { type: 'message', message: msg });
              this.store.saveMessage(conv.id, msg, true);
              return busy ? { allow: false, note: busy } : { allow: true };
            }
            if (run.refuseApprovals) {
              Object.assign(part, { status: 'denied', note: t().scheduleRefused });
              this.hub.emit(conv.id, { type: 'message', message: msg });
              this.store.saveMessage(conv.id, msg, true);
              return { allow: false, note: UNATTENDED_REFUSAL };
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
            const busy = answer.allow ? this.lockForApproval(conv, run) : undefined;
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
      // The account's own: its home has its own skills, MCP servers and hooks.
      const nativeOff = this.settings.nativeOff(agent.provider, account);
      const nativeItems = this.settings.nativeItems(agent.provider, account);
      const freshState = emptyState;
      emptyState = false;
      const model = await this.modelFor(agent.provider, agent.model, account);
      try {
        const result = await runners[agent.provider].run({
          bin: this.settings.bin(agent.provider),
          env: this.settings.env(agent.provider, account),
          backends: this.settings.backendsFor(agent.provider),
          nativeOff,
          nativeItems,
          sandboxTerminal: this.settings.sandboxTerminal(agent.provider),
          prompt,
          systemPrompt: buildBriefing(conv, agent, workspace, tools, nativeOff, nativeItems, Boolean(run.refuseApprovals)),
          sessionId: state.sessionId,
          cwd,
          ...(addDirs.length ? { addDirs } : {}),
          permission: conv.settings.permission,
          stateKey: stateKeys.member(conv.id, agent.id),
          freshState,
          model,
          effort: agent.effort?.trim() || this.settings.defaultEffort(agent.provider, account) || undefined,
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
      // The CLI is gone: requests it was still waiting on can no longer be answered, nor can new ones.
      turnOver = true;
      for (const id of waiting) this.approvals.get(id)?.resolve({ allow: false, expired: true });
      // Record file changes even when the turn failed or was stopped: the files changed anyway.
      if (before) {
        try {
          msg.changes = await this.captureChanges(conv.id, before, run.ws.isolated ? wts : undefined, agent);
        } catch (err) {
          console.warn('[orchestrator] could not record changes:', (err as Error).message);
        }
      }
      run.active.delete(agent.id);
      run.turns.delete(msg.id);
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

  /**
   * What a turn changed in each repository (`before`: the state of each before the turn, in the
   * order of the working directories); `wts`: the agent's worktrees, in parallel mode. A repository
   * whose changes cannot be recorded does not keep the others' from being recorded.
   */
  private async captureChanges(
    convId: string,
    before: Map<string, { commit: string; tree?: string }>,
    wts: AgentWorktree[] | undefined,
    agent: AgentConfig,
  ): Promise<MessageChanges[] | undefined> {
    const out: MessageChanges[] = [];
    for (const [root, state] of before) {
      try {
        const changes = await this.changesIn(convId, root, state, wts?.find((w) => w.root === root), agent);
        if (changes) out.push(changes);
      } catch (err) {
        console.warn('[orchestrator] could not record changes:', (err as Error).message);
      }
    }
    return out.length ? out : undefined;
  }

  /** What a turn changed in one repository: in the agent's worktree of it, or in the working tree. */
  private async changesIn(
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
    this.hub.emit(id, {
      type: 'status',
      running: this.isRunning(id),
      activeAgentIds: this.activeAgentIds(id),
      ...(this.folderWaiters.has(id) ? { waitsForFolder: true } : {}),
    });
  }
}
