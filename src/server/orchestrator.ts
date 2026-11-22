import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CheckCommand,
  CheckOutcome,
  Permission,
  ChecksResult,
  ConversationSettings,
  TeamPlan,
  AgentConfig,
  AgentSessionState,
  ApprovalAnswer,
  ApprovalReview,
  AgentWorktree,
  BranchPart,
  ChatMessage,
  Conversation,
  ConversationBranch,
  ConversationSchedule,
  EventSource,
  FileChange,
  LeadReview,
  MessageChanges,
  MessagePart,
  MemoryPartNote,
  HandoverPart,
  OutboxItem,
  ProgressStatus,
  Provider,
  LeadAgentSettings,
  RunPause,
  TrackedRun,
  TeamPreset,
  TeamRevision,
  CheckFinding,
  CommandProposal,
  FixedCommand,
  FixedCommandRun,
  InteractiveSession,
  SecretAsk,
} from '../shared/types';
import { FIXED_COMMAND_NEWS, HANDOFF_LIMITS, INTERACTIVE_LIMITS } from '../shared/types';
import { checkProposal, interactiveLine, maskValues, splitHandoffs, type HandoffBlock } from '../shared/handoffs';
import { USER_BROWSERS_MAX, UserBrowserError, type UserBrowsers } from './browser/handover';
import { askingReplies, splitAsk } from '../shared/ask';
import { splitSteps, stepsAnswerText, stepsOfMessage, type StepsPart } from '../shared/steps';
import { nextRun } from '../shared/schedule';
import { freshTracking, retryDelayMs, splitProgress, withNote } from '../shared/tracking';
import {
  CHECK_LIMITS,
  CHECK_RESULT_LIMITS,
  GIT_MISSING,
  HOOK_PROVIDERS,
  MEMORY_LIMITS,
  OPEN_PROVIDERS,
  PROVIDER_LABEL,
  REVISE_REQUEST_MAX,
  STEPS_LIMITS,
  TEAM_WORKTREE,
  agentLimitsFor,
  STEER_PROVIDERS,
  currentPlan,
  cwdsOf,
  isEndpointCli,
  isOpenProvider,
  pendingPlan,
  permissionAbove,
  planSavable,
} from '../shared/types';
import { AgentRunError, runners, type AgentEvent, type RunResult } from './agents';
import { appProblems } from './previewTarget';
import { withSubModelTokens, type SubModelTokens } from './runCode';
import { emptyStateFolder, removeConversationState } from './agents/open';
import { stateKeys, type ApprovalRequest, type RunOptions, type SteerTurn } from './agents/types';
import {
  GATEWAY_FULL_ACCESS_ONLY,
  GATEWAY_OVER_HTTP,
  GATEWAY_SANDBOXED_MCP,
  gatewayToolNamed,
  reservedMcpName,
  type GatewayTool,
  type ToolGateway,
} from './gateway';
import { outboxAnswerText, type Outbox } from './outbox';
import type { TraceSink } from './agentsview';
import { approvalKeys, isAllowed } from './approvals';
import { CONFIG } from './config';
import { HttpError } from './errors';
import { AutoGrouper } from './grouping';
import { LongTermMemory, memorySeenKey, type MemoryCardRef } from './memory';
import { splitMemory, type MemoryOp } from '../shared/memory';
import {
  defaultFixedCommandDeps,
  dropPin,
  manifestChanges,
  manifestDigest,
  pinChanges,
  pinDiff,
  pinManifest,
  runFixedCommand,
  takePin,
  type FixedCommandDeps,
} from './fixedCommands';
import type { CommandPin } from './handoffs';
import { defaultInteractiveDeps, InteractiveRun, workdirConfigFiles, type InteractiveDeps } from './interactive';
import type { Hub } from './hub';
import {
  PLANNER_BRIEFING,
  PlanUnavailableError,
  REVISER_BRIEFING,
  assignmentKey,
  assignmentModel,
  buildPlannerPrompt,
  buildRevisePrompt,
  decidePlan,
  decideRevision,
  draftPlace,
  fallbackPlan,
  fitAgents,
  historyForLead,
  keepMemberIds,
  memberAvailable,
  planFollowsTeam,
  leadReply,
  PLAN_SCHEMA,
  REVISION_SCHEMA,
  teamSettings,
  type PlanConversation,
  type PlanDecision,
  type PlannerContext,
  type TeamDraft,
} from './planner';
import {
  attachmentsDir,
  copyAttachments,
  copyShownFiles,
  imageInputs,
  removeAttachments,
  saveAttachments,
  writeAttachments,
  type AttachmentPart,
  type AttachmentUpload,
} from './attachments';
import {
  buildBriefing,
  buildSteerPrompt,
  buildTurnPrompt,
  isForwardable,
  isPass,
  parseMentions,
  type BriefingWorkspace,
  type TurnInfo,
} from './prompt';
import { endpointModel } from './backends';
import { checkModel } from './modelCheck';
import { REVIEWER_BRIEFING, REVIEW_SCHEMA, buildReviewPrompt, hasNewReplies, parseReviewReply, reviewMaterial } from './reviewer';
import {
  APPROVAL_REVIEWER_BRIEFING,
  APPROVAL_REVIEW_LIMITS,
  APPROVAL_SCHEMA,
  NoDecision,
  buildApprovalPrompt,
  neverReviewed,
  nothingToReview,
  parseApprovalReply,
  reviewKey,
  type ApprovalVerdict,
} from './approvalReview';
import {
  RunCheck,
  baselineIn,
  checksResult,
  listPatterns,
  mergeDefaultChecks,
  recheck as recheckFrom,
  type CheckFolders,
  type StoredBaseline,
  type WorktreeChange,
} from './checks';
import {
  blocking,
  checksFailed,
  checksHold,
  hasApplyChecks,
  hasChecks,
  hasRules,
  isProtected,
  latestChecks,
  needsFix,
  overallStatus,
  protectedPatterns,
} from '../shared/checks';
import {
  PACKAGE_JSON_KEYS,
  checkConfigFiles,
  commandCwd,
  checkTreesDir,
  defaultCheckCommandDeps,
  linkDependencies,
  namedFiles,
  relativeInside,
  runCheckCommand,
  type CheckCommandDeps,
  type CheckCommandPlace,
} from './checkCommands';
import { privateRoots } from './agents/open';
import { protectedReads } from './protect';
import { DATA_DIR, OPEN_HOMES_DIR, type SettingsStore } from './settings';
import type { Store, TaskRequest } from './store';
import {
  applyPatch,
  addCheckTree,
  applyPatchIn,
  type CheckedPatch,
  checkPatch,
  commitWorktree,
  fileAt,
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
  worktreeChanged,
  worktreeCwd,
  worktreeHead,
} from './workspace';
import { currentLang, isBranchTitle, isDefaultTitle, t } from './i18n';
import { sameFolder, validateAgents } from './validate';
import { agentFolderOptions, relayFolderRefusal } from './protect';
import { scheduleTime } from './scheduler';
import { realPath, writeGuard, type WriteGuard } from './writeGuard';
import { turnHooks, type TurnHooks } from './hooks';

/** A member's turn's `guard` (the team's protected paths, for its CLI to refuse writing), none when there is none. */
function guardOf(list: ConversationSettings['checks'], dirs: string[]): { guard?: WriteGuard } {
  // Never a reason for a turn to fail: without it, the checks after the team has answered still find them.
  try {
    const guard = writeGuard(list, dirs);
    return guard ? { guard } : {};
  } catch (err) {
    console.warn(`[checks] could not give the team's protected paths to the turn: ${(err as Error).message}`);
    return {};
  }
}

/** Translate a rule's absolute folder to the copy of its most specific working directory. */
function mapCheckFolder<T extends { cwd?: string }>(rule: T, copies: readonly { userCwd: string; cwd: string }[]): T {
  if (!rule.cwd || !isAbsolute(rule.cwd)) return rule;
  const dir = realPath(rule.cwd);
  let best: { originalLength: number; cwd: string } | undefined;
  for (const copy of copies) {
    const original = realPath(copy.userCwd);
    const within = dir === original ? '' : relativeInside(original, dir);
    if (within !== undefined && (!best || original.length > best.originalLength)) {
      best = { originalLength: original.length, cwd: join(copy.cwd, within) };
    }
  }
  return best ? { ...rule, cwd: best.cwd } : rule;
}

export { HttpError };

/** A conversation as sent to the browser: without the agents' CLI session bookkeeping (it grows with the chat). */
export function forClient(conv: Conversation): Conversation {
  const { schedule, ...rest } = conv;
  return { ...rest, agentState: {}, ...(schedule ? { schedule: scheduleForClient(schedule) } : {}) };
}

/**
 * A schedule as browsers get it (in a conversation, its `conversation` event, the schedule routes'
 * answers): what an automation's checks keep of every event and file they saw (each trigger's
 * `seen`, `files`) stays in the server, where only the checks read it.
 */
export function scheduleForClient(s: ConversationSchedule): ConversationSchedule {
  if (!s.watches) return s;
  return { ...s, watches: s.watches.map(({ seen: _seen, files: _files, heldFiles: _held, ...watch }) => watch) };
}

/** Where agents of one run write. */
interface RunWorkspace {
  /**
   * The working directories, in order, each with the root of the repository it is in; set when
   * agents may write (edit / full). Two may be in the same repository.
   */
  folders?: { cwd: string; root: string }[];
  /**
   * The agents work in git worktrees: in parallel mode with write access each in its own, or with
   * `team` all of them in the conversation's.
   */
  isolated: boolean;
  /**
   * The members share the conversation's own worktrees (`TEAM_WORKTREE`), one for each repository,
   * taking turns as in the shared working directories: another conversation was writing in one of
   * them when the run started, or the team's work there is not applied yet. Made (or made again from
   * new snapshots) before the first turn (`prepareTeamWorktrees`).
   */
  team?: boolean;
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

/**
 * Whether a reply was the first to change files in one of these worktrees as they are now: its
 * changes start from the snapshot the worktree was made from (each later turn's start from the turn
 * before). A rewind drops the replies after a point, so this one left means some reply made there is.
 */
function madeIn(m: ChatMessage, worktrees: AgentWorktree[]): boolean {
  return Boolean(
    m.changes?.some(
      (c) => c.isolated && c.files.length && worktrees.some((w) => w.root === c.root && w.branch === c.branch && w.base === c.base),
    ),
  );
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
  /**
   * "Approve for me": the requests the lead agent approved in this run, by what they would do exactly
   * (`reviewKey()`), with its reason: the same request again is allowed without another review.
   */
  reviewed?: Map<string, string>;
  /** Turns not over yet, by message id: a reply is marked done before its turn records the files it changed. */
  turns: Set<string>;
  ws: RunWorkspace;
  /** Repository roots (or folders) this run holds the directory lock on. */
  lockRoots?: string[];
  /**
   * The team writes in the working directories again (none is another conversation's now, and its own
   * worktrees hold nothing that is not applied): they are removed before the first turn.
   */
  dropTeamWorktrees?: boolean;
  /**
   * A schedule started it and nobody may be watching: actions the permission does not cover are
   * refused automatically instead of asked (the schedule's `approvals`), unless the conversation
   * always allows them. Cleared once one of the user's own messages reaches the run: they are here.
   */
  refuseApprovals?: boolean;
  /** Auto team: the lead agent designs the team for the question, and that is all this run does. */
  designs?: boolean;
  /** Verify an approved full-access design before applying its team. */
  checkPlan?: ChatMessage;
  /** The design is for the conversation's schedule: this is its message, which nobody posted (`designForSchedule`). */
  designFor?: string;
  /** The design needed no confirmation (`autoConfirm`): once this run ends, the team answers. */
  answerNext?: boolean;
  /** The team's turns are over and the lead agent reviews its replies (lead review). */
  reviewing?: boolean;
  /** Stops the review alone (lead review switched off while it runs): the run then ends as usual. */
  reviewAbort?: AbortController;
  /** Settles once the run has finished, including its clean-up. */
  done: Promise<void>;
  /** A schedule that tracks a goal started this run (`StartOptions.tracking`): `from` is where its replies begin in the chat. */
  tracking?: TrackedRun & { from: number };
  /** Where this run's replies begin in the chat (the team checks' card reads them from there). */
  from: number;
  /** The result posted before an answer resumed this run, if it still needs its checks completed. */
  pausedChecks?: ChatMessage;
  /** The team checks of this run (`ConversationSettings.checks`): where its folders started, who changed what since. */
  checks?: RunCheck;
  /** The team checks could not start (why): the run's card says so; never a pass. */
  checksError?: string;
  /**
   * A schedule started it and none of the user's own messages has reached it: team checks that do not
   * pass are a failure of the schedule of this conversation (its id).
   */
  unattended?: string;
  /** Only scheduled messages may leave the queue during this run. */
  scheduledQueueOnly?: boolean;
  /** The user asked a member to fix this team checks result (its message id): the member is shown it, seen or not. */
  fixChecks?: string;
  /** Relay itself asked for that fix (`CheckList.autoFix`): which automatic fix in a row this run is. */
  autoFix?: number;
  /** The team checks did not pass and fix themselves: the fix to start once this run ends (`startAutoFix`). */
  autoFixNext?: { messageId: string; agentId: string; attempt: number };
  /** Steering: the members whose running turn can take a message now (`RunOptions.onSteer`), by agent id. */
  steers?: Map<string, TurnSteer>;
  /** The members of the parallel round under way: a message is steered into all of them, or none. */
  round?: string[];
}

/** A member's running turn that can take a message now (steering). */
interface TurnSteer {
  steer: SteerTurn;
  /** The turn took this message: it counts as seen by the member once the turn ends well. */
  took: (messageId: string) => void;
}

interface StartOptions {
  request?: TaskRequest;
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
  /**
   * The user's message answers this agent alone (its steps card): while others wait for the user too,
   * only it goes on, and the team keeps waiting for theirs (`takePause`).
   */
  answers?: string;
  /** Attached files of the new user message (already saved). */
  files?: AttachmentPart[];
  /** Post the messages waiting in the queue first: they were sent before this one, and start the run too. */
  queue?: boolean;
  /** Leave the user's messages waiting for a failed check to be resolved. */
  scheduledQueueOnly?: boolean;
  /** The conversation's schedule sends the message (it is marked `scheduled`). */
  scheduled?: boolean;
  /** The body a program sent through the schedule's webhook, kept with the scheduled message (`ChatMessage.event`). */
  event?: string;
  /** Where `event` came from when it was not the webhook: what an automation's trigger found (`ChatMessage.eventSource`). */
  eventSource?: EventSource;
  /** A schedule that tracks a goal starts the run. */
  tracking?: TrackedRun;
  /** The conversation whose schedule sends the message, when it is not this one (a new chat each time). */
  scheduleSource?: string;
  /** The user asked a member (`only`) to fix this team checks result (its message id). */
  fixChecks?: string;
  /** Relay itself asked (`CheckList.autoFix`): which automatic fix in a row this is. */
  autoFix?: number;
  /** The lead agent designs the team for the conversation's schedule, and nobody answers (`designForSchedule`). */
  designSchedule?: boolean;
  checkPlan?: ChatMessage;
  /**
   * Refuse approval requests automatically in this run (see `Run.refuseApprovals`) — if every message
   * it starts with came from the schedule.
   */
  refuseApprovals?: boolean;
}

/**
 * How a scheduled message went. `busy`: not now — a settings change or an apply holds the
 * conversation, or the server is stopping — so
 * try again shortly (`reason` says why). `chatId`: the conversation it opened (`newChat`).
 */
export type ScheduledSend =
  | { result: 'sent'; chatId?: string }
  | { result: 'queued' }
  /** Its fixed command ran and found nothing for the team: no message. */
  | { result: 'ran' }
  | { result: 'busy'; reason?: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; reason: string; code?: string };

/** What a scheduled message carries of the event that sent it: its body, and where it came from when not the webhook. */
type ScheduledEvent = Pick<ChatMessage, 'event' | 'eventSource'>;

/** A run that could not start: the conversation is busy for a moment (409) or the server is stopping (503), or else it failed. */
function sendFailure(err: unknown): ScheduledSend {
  if (err instanceof HttpError && (err.status === 409 || err.status === 503)) return { result: 'busy', reason: err.message };
  return { result: 'failed', reason: (err as Error).message, ...(err instanceof HttpError && err.code ? { code: err.code } : {}) };
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
function copyMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  // An outbox card still waiting belongs to its own conversation, which alone can send it: a copy keeps only answered ones.
  const copies = messages.map((m) => {
    const copy = { ...structuredClone(m), id: randomUUID() };
    copy.parts = copy.parts.filter((p) => p.type !== 'outbox' || p.status !== 'pending');
    // A command the user runs from a card runs for its own conversation: the copy's card says it stopped.
    for (const p of copy.parts) {
      if (p.type !== 'interactive' || p.session?.state !== 'running') continue;
      const { asking: _asking, ...session } = p.session;
      p.session = { ...session, state: 'stopped' };
    }
    // A branch is no run of the schedule: its replies carry no goal on.
    delete copy.tracked;
    return copy;
  });
  const ids = new Map(messages.map((m, i) => [m.id, copies[i]!.id]));
  for (const m of copies) {
    if (m.checks) {
      m.checks.historical = true;
      if (m.checks.replyIds) m.checks.replyIds = m.checks.replyIds.flatMap((id) => ids.get(id) ?? []);
      if (m.checks.appReplies) m.checks.appReplies = m.checks.appReplies.flatMap((id) => ids.get(id) ?? []);
    }
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

/** A tracked run as a message or a pause keeps it: without the run's own place in the chat. */
function runOf(r: TrackedRun & { from?: number }): TrackedRun {
  return { sourceId: r.sourceId, due: r.due, attempt: r.attempt, retries: r.retries };
}

/** Longest name of a template saved from a plan. */
const MAX_PRESET_NAME = 100;

/**
 * A team design was stopped (or cut short) since the team last spoke: the question it was for still
 * waits for its team, so Continue designs it again.
 */
function designOwed(messages: ChatMessage[]): boolean {
  const plan = latestDesignSinceReply(messages);
  return Boolean(plan && plan.status !== 'ready');
}

function latestDesignSinceReply(messages: ChatMessage[]): ChatMessage['plan'] {
  return messages.findLast((m) => m.author.kind === 'agent' || m.plan)?.plan;
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
  context(cwd?: string, addDirs?: readonly string[], checkUsage?: boolean): Promise<PlannerContext>;
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
  if (conv.pause && conv.messages.slice(index + 1).every((m) => m.author.kind === 'system')) {
    // The same wait, but no run of the schedule: the branch's answer carries no goal on.
    const { tracked: _schedules, ...pause } = structuredClone(conv.pause);
    return pause;
  }
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

/** Whether the agent said or did anything in its reply yet: Harness Relay's own notes (`notice`) are not its words. */
function agentSaid(msg: ChatMessage): boolean {
  return msg.parts.some((p) => p.type !== 'notice');
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

/**
 * Takes a finished reply's hand-off blocks (`<secret>`, `<command>`, `<command-run>`: see
 * `src/shared/handoffs.ts`) out of its text, anywhere in it; returns them in order.
 */
function takeHandoffBlocks(msg: ChatMessage): HandoffBlock[] {
  const blocks: HandoffBlock[] = [];
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const part = msg.parts[i]!;
    if (part.type !== 'text') continue;
    const split = splitHandoffs(part.text);
    if (!split.blocks.length) continue;
    blocks.unshift(...split.blocks);
    if (split.text) part.text = split.text;
    else msg.parts.splice(i, 1);
  }
  return blocks;
}

/** An interactive command's run from its card, by its conversation and card (a branch copies a card's id). */
const interactiveKey = (convId: string, partId: string) => `${convId}\u0000${partId}`;

/** A secrets card's browser for the user alone, by conversation and card (a branch copies the card's id). */
const secretBrowserKey = (convId: string, partId: string) => `${convId}\n${partId}`;

/** The name outbox items of fixed command runs are kept under (no gateway tool has it). */
export const FIXED_COMMAND_TOOL = 'relay_fixed_command';

/**
 * Take the steps block off a finished reply (see `src/shared/steps.ts`): the reply keeps its steps as a
 * `steps` part, at its end. Returns whether it had one: such a reply asks the user.
 */
function takeSteps(msg: ChatMessage): boolean {
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const part = msg.parts[i]!;
    if (part.type !== 'text') continue;
    const { text, steps } = splitSteps(part.text);
    if (!steps) return false;
    if (text) part.text = text;
    else msg.parts.splice(i, 1);
    msg.parts.push({ type: 'steps', items: steps.map((step) => ({ text: step })) });
    return true;
  }
  return false;
}

/**
 * Take the `<progress>` block off the end of a reply (see `src/shared/tracking.ts`): what it says, or
 * undefined when the reply's last text has none. The reply keeps it as a `progress` part.
 */
function takeProgress(msg: ChatMessage): { status: ProgressStatus; text: string } | undefined {
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const part = msg.parts[i]!;
    if (part.type !== 'text') continue;
    const { text, progress } = splitProgress(part.text);
    if (!progress) return undefined;
    if (text) part.text = text;
    else msg.parts.splice(i, 1);
    msg.parts.push({ type: 'progress', status: progress.status, text: progress.text });
    return progress;
  }
  return undefined;
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
  /**
   * The user answered one of several agents that wait for them (a steps card): only it speaks, then
   * the team waits again, for these agents and any that ask now.
   */
  waiting?: RunPause;
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
  /** Conversations being deleted. */
  private deleting = new Set<string>();
  /** The server is shutting down: nothing new starts. */
  private closing = false;
  /** Repository root → conversation currently writing to its working tree. */
  private dirLocks = new Map<string, string>();
  /**
   * How many times each folder was locked for writing since the server started (a run that writes, an
   * action allowed in a read-only run, an apply): an automation that waits for files compares it
   * between checks (`folderWrites()`), so a run that began and ended between two checks is the team's too.
   */
  private writeCounts = new Map<string, number>();
  /** This server's own: counts from another start are not compared. */
  private readonly writesEpoch = randomUUID();
  /** Approval requests waiting for the user, by approval part id. */
  /**
   * The approval requests shown in the chat, by id, until they are answered. `reviewing`: the lead agent
   * reviews it first ("Approve for me"); the user may answer meanwhile, but is not waited for yet.
   */
  private approvals = new Map<
    string,
    { convId: string; reviewing?: boolean; resolve: (a: ApprovalAnswer & { expired?: boolean; unattended?: boolean }) => void }
  >();
  /** Hand-overs of the chat's browser waiting for the user or in their hands (`browser_hand_over`), by card id: their conversation. */
  private handovers = new Map<string, string>();
  /** The browsers for the user alone (`browser/session.ts`), when the server runs the browser tools. */
  userBrowsers?: UserBrowsers;
  /** A secrets card's browser for the user alone while it is open, by the card's id: its id. */
  private secretBrowsers = new Map<string, Promise<string>>();
  /** The ask each of those was last opened for: another ask's Open takes it to that ask's page. */
  private secretBrowserAsks = new Map<string, string | undefined>();
  /** The secrets cards whose answer was posted (by `secretBrowserKey()`): posted once, however the last ask was decided. */
  private secretsAnswered = new Set<string>();
  /** Sorts new conversations into the user's sidebar groups. */
  private grouper: AutoGrouper;
  /** Long-term memory: the notes agents keep across conversations, and the lead agent's tidying of them. */
  readonly memory: LongTermMemory;
  /**
   * The lead agent changing a team at the user's request (team drawer), by conversation: the latest
   * request, and any it replaced whose lead process has not ended yet. Only the latest one answers.
   */
  private revisions = new Map<string, Set<{ abort: AbortController; done: Promise<unknown> }>>();
  /** Branches being made, by the conversation they come from: deleting it, and shutdown, wait for them. */
  private branching = new Map<string, Set<Promise<Conversation>>>();
  /**
   * Each conversation's latest note of its schedule's skipped times (`noteSkipped()`): the note; the
   * schedule as the scheduler left it, which any save of the user's (and switching it off or on, and
   * deleting it) replaces with another object, whatever it changed; the first and the latest time it
   * counts, how many and why. The scheduler's own writes replace the schedule too: `record()`'s after
   * each time, whose object this keeps, and an automation's watches, whose schedule (it starts when
   * something happens) leaves no such note. A time the schedule did not skip ends the note
   * (`sendScheduled()`: from the scheduler, Run now, the webhook or a trigger), and so does deleting the
   * conversation. Kept in memory only: after a restart the next skipped time starts a note.
   */
  private skipNotes = new Map<
    string,
    { messageId: string; schedule: ConversationSchedule | undefined; first: number; last: number; count: number; why: string }
  >();

  /** The clock tracking schedules' notes and retries go by (the scheduler's, in tests). */
  clock: () => number = Date.now;
  /** How team checks' commands are run (swapped in tests). */
  checkCommandDeps: CheckCommandDeps = defaultCheckCommandDeps;
  /** How fixed commands run (swapped in tests). */
  fixedCommandDeps: FixedCommandDeps = defaultFixedCommandDeps;
  /** Conversations whose team checks' commands run by themselves (Check again, Try it): Stop stops them. */
  private checking = new Map<string, AbortController>();
  /** That work, until it has finished its clean-up (`settled()` waits for it). */
  private checkWork = new Set<Promise<unknown>>();
  /** Fixed commands' runs under way, by command id (one at a time each), and the work of those Try it started. */
  private commandRuns = new Map<string, AbortController>();
  private commandWork = new Set<Promise<unknown>>();
  /** What a schedule's fixed command found while the team could not take its message: sent at the time's retry. */
  private heldCommandEvents = new Map<string, { event: string; eventSource: EventSource }>();
  /** How interactive commands run (swapped in tests); `askpass` is the gateway's, once there is one. */
  interactiveDeps: InteractiveDeps = defaultInteractiveDeps;
  /** Interactive commands running from their cards, by conversation and card (`interactiveKey()`), and their cards' pending updates. */
  private interactive = new Map<string, { convId: string; messageId: string; partId: string; run: InteractiveRun }>();
  private interactiveUpdates = new Map<string, NodeJS.Timeout>();
  /**
   * Steering: per conversation, the messages being sent while the team replies, one after another in the
   * order they were sent (each waits for the one before it to go into running turns or into the queue).
   */
  private steering = new Map<string, Promise<void>>();
  /** Harness Relay's own tools (`gateway.ts`), when the server runs them, and their outbox. */
  gateway?: ToolGateway;
  outbox?: Outbox;
  /** Told when a conversation is deleted (its browser closes, and its profile goes). */
  onDelete?: (convId: string) => void;

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
    this.memory = new LongTermMemory(store, settings, {
      cardChanged: (note, status) => this.updateMemoryCard(note, status),
      modelFor: (p, chosen, account) => this.modelFor(p, chosen, account),
    });
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

  /**
   * A run is under way: registered, or being set up (`starting`, from the moment `start()` is called,
   * before its workspace is prepared). A run that follows another (a message sent during a review or
   * with "stop and send this instead", what waited for a run of its own, the team the lead agent just
   * designed) is set up after the one before has ended, with git awaited meanwhile: counted from its
   * start, the conversations' list never shows the conversation done in between, so the sidebar shows
   * no gap and no "agents finished" notification goes out before the run that answers is over. (The
   * open chat's status event still says the run before ended, after Stop or "stop and send this
   * instead", until the next one is registered: `emitStatus()`.)
   */
  isRunning(id: string): boolean {
    return this.runs.has(id) || this.starting.has(id) || this.checking.has(id);
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
      // The lead agent tidying the long-term memory, which no conversation owns.
      ...(this.memory.tidying ? ['memory'] : []),
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
    return this.runs.size > 0 || this.starting.size > 0 || this.grouper.busy || this.revisions.size > 0 || this.memory.tidying;
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
      // A branch being made from it is still copying its attached files.
      await Promise.allSettled([...(this.branching.get(convId) ?? [])]);
      // A command the user runs from one of its cards stops with it.
      this.stopInteractive(convId);
      // A team checks' command running by itself is stopped: its reservation then ends at once.
      this.checking.get(convId)?.abort();
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
        removeConversationState(
          OPEN_PROVIDERS.flatMap((p) => this.settings.openAgentHomes(p)),
          convId,
          [...members],
        );
      }
      // A schedule that opened it no longer links to it.
      for (const id of this.store.delete(convId)) {
        const linked = this.store.get(id);
        if (linked) this.emitConversation(linked);
      }
      this.traces?.forget?.(convId);
      this.outbox?.forget(convId);
      this.skipNotes.delete(convId);
      this.heldCommandEvents.delete(convId);
      this.onDelete?.(convId);
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
      ...this.checkWork,
      ...this.commandWork,
      this.grouper.settled(),
      this.memory.settled(),
    ]);
    await Promise.race([all, new Promise((r) => setTimeout(r, ms).unref())]);
  }

  activeAgentIds(id: string): string[] {
    return [...(this.runs.get(id)?.active ?? [])];
  }

  /** An agent in this conversation is waiting for the user to approve something. */
  isWaiting(id: string): boolean {
    for (const a of this.approvals.values()) if (a.convId === id && !a.reviewing) return true;
    // An agent handed the browser to the user (a sign-in), and waits for it back.
    for (const c of this.handovers.values()) if (c === id) return true;
    // Something an agent asked to send waits in the outbox for the user.
    return (this.outbox?.waiting(id) ?? 0) > 0;
  }

  /** At startup: the cards of items a stop of the server cut off while sending say so (`Outbox.interrupted`). */
  reconcileOutbox(): void {
    for (const item of this.outbox?.interrupted ?? []) this.updateOutboxCard(item);
  }

  /** The card of an outbox item in its reply, as the item now is. */
  private updateOutboxCard(item: OutboxItem): void {
    const conv = this.store.get(item.convId);
    const msg = conv?.messages.find((m) => m.id === item.messageId);
    const part = msg?.parts.find((p): p is Extract<MessagePart, { type: 'outbox' }> => p.type === 'outbox' && p.id === item.id);
    if (!conv || !msg || !part) return;
    part.status = item.status;
    if (item.result !== undefined) part.result = item.result;
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /** What a conversation's working directory has, for its agents' briefing: its secrets' names and its fixed commands. */
  private handoffsForBriefing(conv: Conversation): { secrets: string[]; commands: FixedCommand[] } {
    const folder = this.handoffFolder(conv);
    return {
      secrets: this.settings.handoffs.secretNames(folder).map((s) => s.name),
      commands: this.settings.handoffs.commands(folder),
    };
  }

  /** The working directory a conversation's secrets and fixed commands are kept for: its first one, as a real path. */
  handoffFolder(conv: Conversation): string {
    return realPath(conv.settings.cwd);
  }

  /**
   * Takes a finished reply's hand-off blocks out of its text and records them: the secrets it asks for
   * and the fixed commands it proposes become cards that wait for the user (returns whether there is
   * one); a run of a saved fixed command goes to the outbox, for the user to send.
   */
  private takeHandoffs(conv: Conversation, msg: ChatMessage, agent: AgentConfig, o: { automation?: boolean } = {}): boolean {
    const blocks = takeHandoffBlocks(msg);
    if (!blocks.length) return false;
    const folder = this.handoffFolder(conv);
    const store = this.settings.handoffs;
    const asks: SecretAsk[] = [];
    for (const b of blocks) {
      if (b.kind !== 'secret' || asks.some((a) => a.name === b.name) || asks.length >= HANDOFF_LIMITS.secretsPerReply) continue;
      asks.push({
        name: b.name,
        ...(b.label ? { label: b.label } : {}),
        ...(b.reason ? { reason: b.reason } : {}),
        ...(b.url ? { url: b.url } : {}),
        status: 'waiting',
        ...(store.has(folder, b.name) ? { had: true } : {}),
      });
    }
    if (asks.length) msg.parts.push({ type: 'secrets', id: randomUUID(), folder, asks });
    let proposed = 0;
    for (const b of blocks) {
      if (b.kind !== 'command' || proposed >= HANDOFF_LIMITS.commandsPerReply) continue;
      const { kind: _kind, ...proposal } = b;
      // A saved command of the same name would be replaced (its schedules and outbox runs then run this one).
      msg.parts.push({
        type: 'command',
        id: randomUUID(),
        folder,
        proposal,
        status: 'proposed',
        ...(store.commandByName(folder, proposal.name) ? { replaces: true } : {}),
      });
      proposed++;
    }
    // Commands for the user to run themselves: never started from an automation's run, nor on native Windows.
    let interactive = 0;
    const blocked = this.interactiveDeps.platform === 'win32' ? 'windows' : o.automation ? 'automation' : undefined;
    for (const b of blocks) {
      if (b.kind !== 'interactive' || interactive >= INTERACTIVE_LIMITS.perReply) continue;
      msg.parts.push({
        type: 'interactive',
        id: randomUUID(),
        folder,
        run: b.run,
        ...(b.reason ? { reason: b.reason } : {}),
        ...(b.workdir ? { workdir: true } : {}),
        configFiles: workdirConfigFiles(folder),
        ...(blocked ? { blocked } : {}),
        status: 'proposed',
      });
      interactive++;
    }
    for (const b of blocks) {
      if (b.kind !== 'command-run') continue;
      const cmd = store.commandByName(folder, b.name);
      if (!cmd || !this.outbox) {
        msg.parts.push({ type: 'notice', text: t().handoffs.noCommand(b.name) });
        continue;
      }
      const { item, existing } = this.outbox.add(
        {
          convId: conv.id,
          messageId: msg.id,
          agentId: agent.id,
          agentName: agent.name,
          tool: FIXED_COMMAND_TOOL,
          title: t().handoffs.outboxTitle(cmd.name),
          preview: {
            fields: [
              { label: t().handoffs.fieldCommand, value: cmd.run },
              { label: t().handoffs.fieldFolder, value: cmd.cwd ? join(folder, cmd.cwd) : folder },
              ...(cmd.hosts.length ? [{ label: t().handoffs.fieldHosts, value: cmd.hosts.join(', ') }] : []),
            ],
            ...(b.input ? { body: b.input } : {}),
          },
        },
        // What the card showed, pinned: a command saved again with another command line is not run for it.
        { commandId: cmd.id, run: cmd.run, hosts: cmd.hosts, secrets: cmd.secrets, cwd: cmd.cwd ?? '', input: b.input },
      );
      if (!existing)
        msg.parts.push({ type: 'outbox', id: item.id, tool: item.tool, title: item.title, preview: item.preview, status: 'pending' });
    }
    return asks.length > 0 || proposed > 0 || interactive > 0;
  }

  /** A secrets or command card of a reply. */
  private handoffCard<K extends 'secrets' | 'command' | 'interactive'>(
    convId: string,
    messageId: string,
    partId: string,
    type: K,
  ): { conv: Conversation; msg: ChatMessage; part: Extract<MessagePart, { type: K }> } {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const msg = conv.messages.find((m) => m.id === messageId);
    const part = msg?.parts.find((p): p is Extract<MessagePart, { type: K }> => p.type === type && 'id' in p && p.id === partId);
    if (!msg || !part) throw new HttpError(404, t().handoffs.cardNotFound);
    return { conv, msg, part };
  }

  private saveCard(conv: Conversation, msg: ChatMessage): void {
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /** Posts the user's answer to a card as their message, which the team takes as the answer to its question. */
  private async answerCard(convId: string, text: string): Promise<void> {
    try {
      await this.send(convId, text);
    } catch (err) {
      // The card's answer is kept; the message waits for the user to send it when it cannot go now.
      if (!(err instanceof HttpError)) throw err;
    }
  }

  /**
   * The user's answer to a secrets card: the values given (kept for the card's folder, in the credential
   * store, never in the chat), or none (`decline`). Asks left without a value are declined. The answer
   * the team gets names them, never a value.
   */
  async answerSecrets(
    convId: string,
    messageId: string,
    partId: string,
    answer: { values?: Record<string, string>; decline?: boolean },
  ): Promise<void> {
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'secrets');
    const waiting = part.asks.filter((a) => a.status === 'waiting');
    if (!waiting.length) throw new HttpError(409, t().handoffs.cardDecided);
    let saved: string[] = [];
    if (!answer.decline) {
      const values = Object.fromEntries(
        Object.entries(answer.values ?? {}).filter(
          (e): e is [string, string] => waiting.some((a) => a.name === e[0]) && typeof e[1] === 'string' && Boolean(e[1].trim()),
        ),
      );
      if (!Object.keys(values).length) throw new HttpError(400, t().handoffs.noValues);
      this.settings.handoffs.setSecrets(part.folder, values);
      saved = Object.keys(values);
    }
    for (const a of waiting) a.status = saved.includes(a.name) ? 'saved' : 'declined';
    this.saveCard(conv, msg);
    await this.secretsDecided(conv, part);
  }

  /**
   * A secrets card with no ask waiting any more: its browser for the user alone closes, and the team gets
   * the user's answer, which names every secret given (typed or saved from the page) and those not, never a value.
   */
  private async secretsDecided(conv: Conversation, part: Extract<MessagePart, { type: 'secrets' }>): Promise<void> {
    const key = secretBrowserKey(conv.id, part.id);
    if (this.secretsAnswered.has(key)) return;
    this.secretsAnswered.add(key);
    const browser = this.secretBrowsers.get(key);
    if (browser) {
      this.secretBrowsers.delete(key);
      const id = await browser.catch(() => undefined);
      if (id) await this.userBrowsers?.closeForUser(conv.id, id);
    }
    const names = (status: SecretAsk['status']) => part.asks.filter((a) => a.status === status).map((a) => a.name);
    await this.answerCard(conv.id, t().handoffs.secretsAnswer(names('saved'), names('declined')));
  }

  /** What the browsers for the user alone's errors are, for the user. */
  private userBrowserError(err: unknown): HttpError {
    if (err instanceof HttpError) return err;
    if (err instanceof UserBrowserError) {
      if (err.why === 'busy') return new HttpError(409, t().handoffs.browsersBusy(USER_BROWSERS_MAX));
      if (err.why === 'gone') return new HttpError(404, t().handoffs.browserGone);
      if (err.why === 'refused') return new HttpError(409, t().handoffs.browserRefused);
      if (err.why === 'nearby') return new HttpError(409, t().handoffs.browserNearby(err.message), 'nearby');
      return new HttpError(409, t().handoffs.noBrowser);
    }
    return new HttpError(409, (err as Error).message);
  }

  /**
   * Opens a browser for the user alone for a secrets card that waits (B2 of the proposal), at the address
   * an ask named (`name`'s `url`), else a blank page; one per card, so the same one comes back while it is
   * open. Returns its id, for the screencast's panel and routes.
   */
  async openSecretsBrowser(
    convId: string,
    messageId: string,
    partId: string,
    name?: string,
    /** The user confirmed an address that leads to this computer or the local network, having seen it whole. */
    nearbyConfirmed = false,
  ): Promise<{ handoverId: string }> {
    const { conv, part } = this.handoffCard(convId, messageId, partId, 'secrets');
    if (!part.asks.some((a) => a.status === 'waiting')) throw new HttpError(409, t().handoffs.cardDecided);
    const ask = name === undefined ? undefined : part.asks.find((a) => a.name === name && a.status === 'waiting');
    if (name !== undefined && !ask) throw new HttpError(409, t().handoffs.notAsked(name));
    const browsers = this.userBrowsers;
    if (!browsers) throw new HttpError(409, t().handoffs.noBrowser);
    // By conversation and card: a branch copies the card, not its browser.
    const key = secretBrowserKey(conv.id, part.id);
    const pending = this.secretBrowsers.get(key);
    if (pending) {
      const open = await pending.catch(() => undefined);
      if (open && browsers.userBrowserOpen(conv.id, open)) {
        // Open already: another ask's page comes to it (the same ask's leaves it where the user took it).
        if (ask?.url && this.secretBrowserAsks.get(key) !== ask.name) {
          await browsers.navigateForUser(conv.id, open, ask.url, { nearbyConfirmed }).catch((err: unknown) => {
            throw this.userBrowserError(err);
          });
          this.secretBrowserAsks.set(key, ask.name);
        }
        return { handoverId: open };
      }
      if (this.secretBrowsers.get(key) === pending) this.secretBrowsers.delete(key);
      // Another call opened one meanwhile: that one.
      const again = this.secretBrowsers.get(key);
      if (again)
        return {
          handoverId: await again.catch((err: unknown) => {
            throw this.userBrowserError(err);
          }),
        };
    }
    // One at a time for a card: a second open while this one starts gets the same one.
    const opening: Promise<string> = browsers.openForUser(conv.id, {
      ...(ask?.url ? { url: ask.url } : {}),
      nearbyConfirmed,
      onEnd: () => {
        if (this.secretBrowsers.get(key) === opening) this.secretBrowsers.delete(key);
      },
    });
    this.secretBrowsers.set(key, opening);
    this.secretBrowserAsks.set(key, ask?.name);
    try {
      return { handoverId: await opening };
    } catch (err) {
      if (this.secretBrowsers.get(key) === opening) this.secretBrowsers.delete(key);
      throw this.userBrowserError(err);
    }
  }

  /**
   * Save selection as a secret: the text the user selected on the page of the card's browser for the user
   * alone (`handoverId`), read by the server over the browser's debugging pipe, is kept for the card's
   * folder under `name` (`HandoffStore.setSecrets()`, checked as a typed value is), and that ask is marked
   * saved from the page. The value goes nowhere else: not to the page that asked, a message, an agent or a
   * log (a problem names the secret, never the value). Once no ask waits, the browser closes and the team
   * gets the user's answer, as `answerSecrets()` gives it.
   */
  async saveSecretFromPage(convId: string, messageId: string, partId: string, handoverId: string, name: string): Promise<void> {
    const first = this.handoffCard(convId, messageId, partId, 'secrets');
    const waits = (part: typeof first.part) => part.asks.find((a) => a.name === name && a.status === 'waiting');
    if (!waits(first.part)) throw new HttpError(409, t().handoffs.notAsked(name));
    const browsers = this.userBrowsers;
    const opened = await this.secretBrowsers.get(secretBrowserKey(first.conv.id, partId))?.catch(() => undefined);
    if (!browsers || opened !== handoverId || !browsers.userBrowserOpen(first.conv.id, handoverId))
      throw new HttpError(404, t().handoffs.browserGone);
    let value: string;
    try {
      value = await browsers.selectionOf(first.conv.id, handoverId);
    } catch (err) {
      throw this.userBrowserError(err);
    }
    if (!value.trim()) throw new HttpError(400, t().handoffs.noSelection);
    // Looked at again: the card may have been answered meanwhile (here, on the card, or in another browser).
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'secrets');
    const ask = waits(part);
    if (!ask) throw new HttpError(409, t().handoffs.notAsked(name));
    this.settings.handoffs.setSecrets(part.folder, { [name]: value });
    ask.status = 'saved';
    ask.from = 'page';
    this.saveCard(conv, msg);
    if (!part.asks.some((a) => a.status === 'waiting')) await this.secretsDecided(conv, part);
  }

  /** The user saves a proposed fixed command (as it is, or with their edits), pinned to its folder's code as it is now. */
  async saveCommand(convId: string, messageId: string, partId: string, edits: Partial<CommandProposal> = {}): Promise<FixedCommand> {
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'command');
    if (part.status !== 'proposed') throw new HttpError(409, t().handoffs.cardDecided);
    const proposal = checkProposal({ ...part.proposal, ...edits });
    if (!proposal) throw new HttpError(400, t().handoffs.badCommand);
    const store = this.settings.handoffs;
    const id = store.commandId(part.folder, proposal.name);
    if (this.commandRuns.has(id)) throw new HttpError(409, t().handoffs.commandRunning);
    const old = store.pin(id);
    let pin: CommandPin;
    try {
      pin = await takePin(part.folder, id);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    const command = store.saveCommand(part.folder, id, proposal, pin);
    await dropPin(id, old, pin);
    part.proposal = proposal;
    part.status = 'saved';
    part.commandId = id;
    delete part.run;
    this.saveCard(conv, msg);
    return command;
  }

  /** The user does not save a proposed fixed command: the team is told. */
  async dismissCommand(convId: string, messageId: string, partId: string): Promise<void> {
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'command');
    if (part.status !== 'proposed') throw new HttpError(409, t().handoffs.cardDecided);
    part.status = 'dismissed';
    this.saveCard(conv, msg);
    await this.answerCard(convId, t().handoffs.commandDismissed(part.proposal.name));
  }

  /**
   * The user tells the team about a saved command's card: that it is saved, and, with `share`, how its
   * last run from the card went (its output, its secrets masked).
   */
  async answerCommand(convId: string, messageId: string, partId: string, share: boolean): Promise<void> {
    const { part } = this.handoffCard(convId, messageId, partId, 'command');
    if (part.status !== 'saved') throw new HttpError(409, t().handoffs.cardDecided);
    const run = share && part.run && part.run.status !== 'running' ? part.run : undefined;
    await this.answerCard(convId, t().handoffs.commandAnswer(part.proposal.name, run));
  }

  /** A saved command of this conversation's working directory. */
  private ownCommand(convId: string, commandId: string): { conv: Conversation; cmd: FixedCommand } {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const cmd = this.settings.handoffs.command(commandId);
    if (!cmd || cmd.folder !== this.handoffFolder(conv)) throw new HttpError(404, t().handoffs.commandNotFound);
    return { conv, cmd };
  }

  /**
   * Try it, on a fixed command's card: one run, in the background (its card follows it). `approve`: the
   * user saw what changed in its code and approves it, which pins it again first. `extra`: words added
   * to its command line for this run only.
   */
  async tryCommand(convId: string, commandId: string, o: { extra?: string; approve?: string } = {}): Promise<void> {
    const { conv, cmd } = this.ownCommand(convId, commandId);
    if (this.commandRuns.has(cmd.id)) throw new HttpError(409, t().handoffs.commandRunning);
    if (o.approve) {
      // Pinned again only as the user saw it: the digest of the code whose diff they read.
      const old = this.settings.handoffs.pin(cmd.id);
      let pin: CommandPin;
      try {
        pin = await takePin(cmd.folder, cmd.id);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      if (manifestDigest(pin.manifest) !== o.approve) {
        await dropPin(cmd.id, pin, old);
        throw new HttpError(409, t().handoffs.changedAgain);
      }
      this.settings.handoffs.repin(cmd.id, pin);
      await dropPin(cmd.id, old, pin);
    }
    this.trackCommand(this.executeCommand(conv, cmd, 'try', { ...(o.extra?.trim() ? { extra: o.extra } : {}) }));
  }

  /** A fixed command's run, waited for at shutdown before the database closes. */
  private trackCommand<T>(work: Promise<T>): Promise<T> {
    this.commandWork.add(work);
    void work.finally(() => this.commandWork.delete(work));
    return work;
  }

  /** What changed in a fixed command's code since it was pinned: the files, and git's diff of them (its secrets masked). */
  async commandDiff(convId: string, commandId: string): Promise<{ changed: string[]; diff: string; digest: string }> {
    const { cmd } = this.ownCommand(convId, commandId);
    const pin = this.settings.handoffs.pin(cmd.id);
    if (!pin) return { changed: [], diff: '', digest: '' };
    const now = await pinManifest(cmd.folder);
    const changed = manifestChanges(pin.manifest, now);
    const diff = await pinDiff(cmd.folder, pin, changed).catch(() => '');
    // What Approve sends back: this code, the one this diff shows, and no later one.
    return { changed, diff: maskValues(diff, Object.values(this.settings.handoffs.values(cmd.folder))), digest: manifestDigest(now) };
  }

  /**
   * One run of a fixed command (Try it, an outbox item, a schedule), which never throws: refused while
   * another run of it is under way, and not run when its pinned code changed (`changed`). Its secrets
   * renewed in the run are kept; its card in `conv` follows it.
   */
  private async executeCommand(
    conv: Conversation | undefined,
    cmd: FixedCommand,
    source: FixedCommandRun['source'],
    o: { extra?: string; stdin?: string },
  ): Promise<FixedCommandRun> {
    const store = this.settings.handoffs;
    const record = (run: FixedCommandRun) => {
      store.setLastRun(cmd.id, run);
      if (conv) this.updateCommandCards(conv.id, cmd.id, run);
    };
    if (this.commandRuns.has(cmd.id)) return { at: Date.now(), source, status: 'error', reason: t().handoffs.commandRunning };
    const abort = new AbortController();
    this.commandRuns.set(cmd.id, abort);
    try {
      // Not while a run may be writing in its folder: what it would run could change under it.
      if (conv && this.writingIn(conv.id, cmd.folder)) {
        const run: FixedCommandRun = { at: Date.now(), source, status: 'error', reason: t().handoffs.folderBusy };
        record(run);
        return run;
      }
      const pin = store.pin(cmd.id);
      const changed = pin ? await pinChanges(cmd.folder, pin) : [];
      if (!pin || changed.length) {
        const run: FixedCommandRun = { at: Date.now(), source, status: 'changed', changed: changed.slice(0, 50) };
        record(run);
        return run;
      }
      record({ at: Date.now(), source, status: 'running' });
      const { run, written } = await runFixedCommand(
        cmd,
        source,
        {
          values: store.values(cmd.folder),
          ...(o.extra !== undefined ? { extra: o.extra } : {}),
          ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
          protectedPaths: protectedReads(),
          privateRoots: privateRoots(this.settings.openAgentHome('opencode'), undefined, this.settings.openAgentRoots()),
          signal: abort.signal,
        },
        this.fixedCommandDeps,
      );
      if (Object.keys(written).length) {
        try {
          store.setSecrets(cmd.folder, written);
        } catch (err) {
          run.reason = t().handoffs.notKept((err as Error).message);
        }
      }
      record(run);
      return run;
    } catch (err) {
      const reason = maskValues((err as Error).message, Object.values(store.values(cmd.folder)));
      const run: FixedCommandRun = { at: Date.now(), source, status: 'error', reason };
      record(run);
      return run;
    } finally {
      this.commandRuns.delete(cmd.id);
    }
  }

  /** The command cards of a conversation for this fixed command show its run. */
  private updateCommandCards(convId: string, commandId: string, run: FixedCommandRun): void {
    const conv = this.store.get(convId);
    if (!conv) return;
    for (const msg of conv.messages) {
      let changed = false;
      for (const p of msg.parts) {
        if (p.type === 'command' && p.commandId === commandId) {
          p.run = run;
          changed = true;
        }
      }
      if (changed) this.saveCard(conv, msg);
    }
  }

  /**
   * Start, on an interactive command's card (docs/architecture.md, "Interactive commands"): the user
   * runs the command themselves, with their rights, outside the agents' sandboxes; its card follows it.
   * Never for a card an automation's run proposed, nor on native Windows. In an empty folder of its own,
   * or in the working directory (`workdir`), whose configuration files the card listed (`seen`): refused
   * when others appeared since, the card then listing them. Again once a run of it ended.
   */
  async startInteractive(
    convId: string,
    messageId: string,
    partId: string,
    o: { workdir?: boolean; seen?: readonly string[] } = {},
  ): Promise<InteractiveSession> {
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'interactive');
    if (part.status === 'dismissed') throw new HttpError(409, t().handoffs.cardDecided);
    // What the card shows is what runs: a line kept before its characters were checked is checked again.
    if (interactiveLine(part.run) !== part.run) throw new HttpError(409, t().handoffs.interactiveHidden);
    const key = interactiveKey(convId, part.id);
    if (this.interactive.has(key)) throw new HttpError(409, t().handoffs.interactiveRunning);
    if (part.blocked === 'automation') throw new HttpError(409, t().handoffs.interactiveAutomation);
    if (part.blocked === 'windows' || this.interactiveDeps.platform === 'win32') throw new HttpError(409, t().handoffs.interactiveWindows);
    if (this.interactive.size >= INTERACTIVE_LIMITS.running)
      throw new HttpError(429, t().handoffs.interactiveTooMany(INTERACTIVE_LIMITS.running));
    let workdir: string | undefined;
    if (o.workdir) {
      if (!existsSync(part.folder)) throw new HttpError(409, t().checksCommandNoFolder(part.folder));
      const now = workdirConfigFiles(part.folder);
      if (now.some((f) => !(o.seen ?? []).includes(f))) {
        part.configFiles = now;
        this.saveCard(conv, msg);
        throw new HttpError(409, t().handoffs.interactiveConfigChanged);
      }
      workdir = part.folder;
    }
    const masks = Object.values(this.settings.handoffs.values(part.folder));
    const run: InteractiveRun = new InteractiveRun(
      {
        run: part.run,
        ...(workdir ? { workdir } : {}),
        masks,
        onChange: (urgent) => this.interactiveChanged(key, urgent),
        onEnd: () => {
          // Values saved for the folder meanwhile are masked in what is kept, too.
          try {
            run.addMasks(Object.values(this.settings.handoffs.values(part.folder)));
          } catch {
            /* the credential store cannot be read now: the values it had at the start stay masked */
          }
          this.interactiveChanged(key, true);
          this.interactive.delete(key);
        },
      },
      { windows: t().handoffs.interactiveWindows, notStarted: (why) => t().handoffs.interactiveNotStarted(why) },
      this.interactiveDeps,
    );
    this.interactive.set(key, { convId, messageId, partId: part.id, run });
    part.status = 'started';
    part.session = run.view();
    this.saveCard(conv, msg);
    run.start();
    return run.view();
  }

  /** An interactive command's card changed: its output (sent a moment later, with what follows), or its state at once. */
  private interactiveChanged(key: string, urgent: boolean): void {
    const entry = this.interactive.get(key);
    if (!entry) return;
    const pending = this.interactiveUpdates.get(key);
    if (pending && !urgent) return;
    clearTimeout(pending);
    this.interactiveUpdates.delete(key);
    const update = () => {
      this.interactiveUpdates.delete(key);
      const conv = this.store.get(entry.convId);
      const msg = conv?.messages.find((m) => m.id === entry.messageId);
      const part = msg?.parts.find(
        (p): p is Extract<MessagePart, { type: 'interactive' }> => p.type === 'interactive' && p.id === entry.partId,
      );
      if (!conv || !msg || !part) return;
      part.session = { ...entry.run.view(), ...(part.session?.sent ? { sent: true } : {}) };
      try {
        this.store.saveMessage(conv.id, msg, !entry.run.running);
      } catch (err) {
        // The database closing as the server stops: the next start says it stopped (`Store`).
        console.warn('[orchestrator] could not save an interactive command card:', (err as Error).message);
      }
      this.hub.emit(conv.id, { type: 'message', message: msg });
    };
    if (urgent) update();
    else this.interactiveUpdates.set(key, setTimeout(update, 200));
  }

  /** The running session of an interactive command's card in this conversation, or 409 when it does not run. */
  private interactiveRun(convId: string, messageId: string, partId: string): InteractiveRun {
    this.handoffCard(convId, messageId, partId, 'interactive');
    const entry = this.interactive.get(interactiveKey(convId, partId));
    if (!entry || !entry.run.running) throw new HttpError(409, t().handoffs.interactiveNotRunning);
    return entry.run;
  }

  /** A line the user typed into a running interactive command: sent as it is; masked wherever it shows when `hidden`. */
  interactiveInput(convId: string, messageId: string, partId: string, text: string, hidden: boolean): void {
    if (Buffer.byteLength(text) > INTERACTIVE_LIMITS.input || /[\u0000\r\n]/.test(text)) throw new HttpError(400, t().invalidField('text'));
    if (!this.interactiveRun(convId, messageId, partId).write(text, hidden)) throw new HttpError(409, t().handoffs.interactiveNotRunning);
  }

  /** The user's answer to a running interactive command's password helper (`line`), or their refusal (none). */
  interactiveAnswer(convId: string, messageId: string, partId: string, askId: string, line: string | undefined): void {
    if (line !== undefined && (Buffer.byteLength(line) > INTERACTIVE_LIMITS.input || /[\u0000\r\n]/.test(line))) {
      throw new HttpError(400, t().invalidField('text'));
    }
    if (!this.interactiveRun(convId, messageId, partId).answer(askId, line)) throw new HttpError(409, t().handoffs.interactiveNoQuestion);
  }

  /** Cancel, on a running interactive command's card. */
  cancelInteractive(convId: string, messageId: string, partId: string): void {
    this.interactiveRun(convId, messageId, partId).stop('cancelled');
  }

  /** Stops the interactive commands running from a conversation's cards (it is being deleted), or all of them (the server stops). */
  stopInteractive(convId?: string): void {
    for (const entry of [...this.interactive.values()]) if (!convId || entry.convId === convId) entry.run.stop('stopped');
  }

  /**
   * Send to the team, on an interactive command's card once its run ended: how it ended and its output,
   * masked (the folder's values again, for those saved since), posted as the user's answer. Once a run.
   */
  async sendInteractive(convId: string, messageId: string, partId: string): Promise<void> {
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'interactive');
    const session = part.session;
    if (!session || this.interactive.has(interactiveKey(convId, part.id)) || session.state === 'running')
      throw new HttpError(409, t().handoffs.interactiveNotEnded);
    if (session.sent) throw new HttpError(409, t().handoffs.cardDecided);
    const values = Object.values(this.settings.handoffs.values(part.folder));
    const output = maskValues(session.output, values);
    part.session = { ...session, output, sent: true };
    this.saveCard(conv, msg);
    await this.answerCard(convId, t().handoffs.interactiveAnswer(maskValues(part.run, values), { ...session, output }));
  }

  /** Don't run, on a proposed interactive command's card: the team is told. */
  async dismissInteractive(convId: string, messageId: string, partId: string): Promise<void> {
    const { conv, msg, part } = this.handoffCard(convId, messageId, partId, 'interactive');
    if (part.status !== 'proposed') throw new HttpError(409, t().handoffs.cardDecided);
    part.status = 'dismissed';
    this.saveCard(conv, msg);
    await this.answerCard(convId, t().handoffs.interactiveDismissed(part.run));
  }

  /** What Send does for an outbox item of a fixed command's run: that run, once, with the item's input on its standard input. */
  private fixedCommandSender(convId: string): { send: NonNullable<GatewayTool['send']> } {
    return {
      send: async (args) => {
        const conv = this.store.get(convId);
        const cmd = typeof args.commandId === 'string' ? this.settings.handoffs.command(args.commandId) : undefined;
        if (!conv || !cmd || cmd.folder !== this.handoffFolder(conv)) throw new Error(t().handoffs.commandNotFound);
        const same =
          args.run === cmd.run &&
          isDeepStrictEqual(args.hosts, cmd.hosts) &&
          isDeepStrictEqual(args.secrets, cmd.secrets) &&
          args.cwd === (cmd.cwd ?? '');
        if (!same) throw new Error(t().handoffs.commandChangedSince(cmd.name));
        const run = await this.trackCommand(
          this.executeCommand(conv, cmd, 'outbox', { stdin: typeof args.input === 'string' ? args.input : '' }),
        );
        const text = t().handoffs.runLine(run);
        if (run.status === 'passed' || run.status === 'news') return text;
        throw new Error(text);
      },
    };
  }

  /**
   * Takes a finished reply's long-term memory blocks out of its text (see `src/shared/memory.ts`) and
   * records them, while long-term memory is on: the reply keeps what they did as a `memory` part.
   */
  private takeMemory(conv: Conversation, msg: ChatMessage, agent: AgentConfig): void {
    if (!this.memory.config.enabled) return;
    const ops: MemoryOp[] = [];
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const part = msg.parts[i]!;
      if (part.type !== 'text') continue;
      const split = splitMemory(part.text);
      if (!split.ops.length) continue;
      ops.unshift(...split.ops);
      if (split.text) part.text = split.text;
      else msg.parts.splice(i, 1);
    }
    if (!ops.length) return;
    const notes = this.memory.apply(conv, msg, agent, ops.slice(0, MEMORY_LIMITS.perReply));
    if (notes.length) msg.parts.push({ type: 'memory', notes });
  }

  /** The card of a long-term memory note in the reply that saved it, as the note now is. */
  private updateMemoryCard(ref: MemoryCardRef, status: MemoryPartNote['status']): void {
    const conv = ref.conversationId ? this.store.get(ref.conversationId) : undefined;
    const msg = conv?.messages.find((m) => m.id === ref.messageId);
    if (!conv || !msg) return;
    let changed = false;
    for (const p of msg.parts) {
      if (p.type !== 'memory') continue;
      for (const n of p.notes) {
        if (n.id === ref.id && n.status !== 'skipped' && n.status !== status) {
          n.status = status;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /**
   * A reply's steps card while its team waits for the user (`askingReplies`: an agent the pause waits
   * for, the run idle): the message and its steps. 404 for none; 409 once answered or no longer waited for.
   */
  private waitingSteps(convId: string, messageId: string): { conv: Conversation; msg: ChatMessage; part: StepsPart } {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const msg = conv.messages.find((m) => m.id === messageId);
    const part = msg && stepsOfMessage(msg);
    if (!msg || !part) throw new HttpError(404, t().steps.notFound);
    if (part.answer) throw new HttpError(409, t().steps.answered);
    if (this.isRunning(convId) || !askingReplies(conv.messages, conv.pause).includes(msg)) {
      throw new HttpError(409, t().steps.notWaiting);
    }
    return { conv, msg, part };
  }

  /** Save a steps card's change and show it in every browser. */
  private saveSteps(conv: Conversation, msg: ChatMessage): void {
    this.store.saveMessage(conv.id, msg, true);
    this.hub.emit(conv.id, { type: 'message', message: msg });
  }

  /** The user ticks a step of a steps card as they go (or unticks it), while the team waits for them. */
  tickStep(convId: string, messageId: string, index: number, done: boolean): void {
    const { conv, msg, part } = this.waitingSteps(convId, messageId);
    const item = part.items[index];
    if (!item) throw new HttpError(400, t().steps.noStep(index + 1));
    if (Boolean(item.done) === done) return;
    if (done) item.done = true;
    else delete item.done;
    this.saveSteps(conv, msg);
  }

  /**
   * The user's answer to a steps card: the steps they did (`done`, by index; the others are not done),
   * the one they are stuck at, their note. It is posted as their message (`stepsAnswerText`), which the
   * team takes as an answer to the agent that gave the steps: it goes on first, and when other agents
   * wait for the user too, it alone, and the team keeps waiting for theirs. The card keeps the answer
   * and no longer changes; one that could not be posted is as it was.
   */
  async answerSteps(
    convId: string,
    messageId: string,
    answer: { done: number[]; stuckAt?: number; note?: string },
  ): Promise<{ queued: boolean }> {
    const { conv, msg, part } = this.waitingSteps(convId, messageId);
    const { done, stuckAt } = answer;
    const note = answer.note?.trim() ?? '';
    for (const i of [...done, ...(stuckAt !== undefined ? [stuckAt] : [])]) {
      if (!Number.isInteger(i) || !part.items[i]) throw new HttpError(400, t().steps.noStep(i + 1));
    }
    if (note.length > STEPS_LIMITS.noteChars) throw new HttpError(400, t().steps.noteTooLong(STEPS_LIMITS.noteChars));
    const before = part.items.map((item) => ({ ...item }));
    part.items.forEach((item, i) => {
      // The step they are stuck at is not done, whatever its box said.
      if (done.includes(i) && i !== stuckAt) item.done = true;
      else delete item.done;
    });
    part.answer = { at: Date.now(), ...(stuckAt !== undefined ? { stuckAt } : {}), ...(note ? { note } : {}) };
    const agentId = msg.author.kind === 'agent' ? msg.author.agentId : '';
    const name = conv.agents.find((a) => a.id === agentId)?.name ?? msg.agentName ?? 'agent';
    const text = stepsAnswerText({ agent: `@${name}`, items: part.items, stuckAt, note, names: conv.agents.map((a) => a.name) }, t().steps);
    // Answered on the card at once, so that a second click (here or in another browser) finds it so.
    this.saveSteps(conv, msg);
    try {
      return await this.send(convId, text, undefined, false, undefined, agentId);
    } catch (err) {
      part.items = before;
      delete part.answer;
      this.saveSteps(conv, msg);
      throw err;
    }
  }

  /**
   * The user's Send or Discard on an outbox item: sent by its tool, in this server, with the
   * credentials it holds; its card then says what happened, and so does a note in the chat.
   */
  async answerOutbox(convId: string, itemId: string, action: 'send' | 'discard'): Promise<OutboxItem> {
    const conv = this.store.get(convId);
    if (!conv || !this.outbox) throw new HttpError(404, t().conversationNotFound);
    const item = await this.outbox.answer(convId, itemId, action, (name) =>
      name === FIXED_COMMAND_TOOL ? this.fixedCommandSender(convId) : this.gateway?.tool(name),
    );
    this.updateOutboxCard(item);
    this.systemNote(conv, outboxAnswerText(item));
    this.emitStatus(conv.id);
    return item;
  }

  /** The user's answer to an approval request shown in the chat. */
  answerApproval(convId: string, approvalId: string, answer: ApprovalAnswer): void {
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.convId !== convId) throw new HttpError(404, t().approvalNotFound);
    pending.resolve({
      allow: Boolean(answer.allow),
      always: Boolean(answer.always),
      note: answer.note ? String(answer.note).slice(0, 2000) : undefined,
    });
  }

  /**
   * "Approve for me": how the lead agent's review of one request starts (`approvalReview.ts`). Undefined
   * when there is nothing to review (the user is asked as without it); `skipped` at once for what is never
   * reviewed (pushing and publishing, more access for the turn), which always waits for the user; approved
   * at once for a request the review already approved in this run; else under way, with its verdict to
   * come (approved, flagged, or failed: the user is asked) and a way to stop it once the user answered
   * first. `dirs`: the turn's own working directories (its worktrees, in parallel mode).
   */
  private startReview(
    conv: Conversation,
    run: Run,
    agent: AgentConfig,
    req: ApprovalRequest,
    dirs: string[],
  ): { first: ApprovalReview; verdict: Promise<ApprovalReview>; stop: () => void } | undefined {
    if (nothingToReview(req)) return undefined;
    const settled = (first: ApprovalReview) => ({ first, verdict: Promise.resolve(first), stop: () => {} });
    const never = neverReviewed(req);
    if (never) return settled({ status: 'skipped', reason: never === 'grant' ? t().approvalReviewGrant : t().approvalReviewPublish });
    const key = reviewKey(req);
    const known = key === undefined ? undefined : run.reviewed?.get(key);
    if (known !== undefined) return settled({ status: 'approved', ...(known ? { reason: known } : {}) });
    const stop = new AbortController();
    const signal = AbortSignal.any([run.abort.signal, stop.signal]);
    const verdict = this.reviewApproval(conv, agent, req, dirs, signal).then((v): ApprovalReview => {
      if ('failed' in v) return { status: 'failed', reason: v.failed };
      if (v.approve && key !== undefined) (run.reviewed ??= new Map()).set(key, v.reason);
      return { status: v.approve ? 'approved' : 'flagged', ...(v.reason ? { reason: v.reason } : {}) };
    });
    return { first: { status: 'reviewing' }, verdict, stop: () => stop.abort() };
  }

  /** Reviews running now ("Approve for me"), and those waiting for one to end (`APPROVAL_REVIEW_LIMITS.atOnce`). */
  private reviewsRunning = 0;
  private reviewsWaiting: (() => void)[] = [];

  /** Waits for a review's turn to run; resolves with a way to let the next one go, or rejects once stopped. */
  private reviewSlot(signal: AbortSignal): Promise<() => void> {
    const release = () => {
      this.reviewsRunning--;
      this.reviewsWaiting.shift()?.();
    };
    if (this.reviewsRunning < APPROVAL_REVIEW_LIMITS.atOnce) {
      this.reviewsRunning++;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', gone);
        this.reviewsRunning++;
        resolve(release);
      };
      const gone = () => {
        this.reviewsWaiting = this.reviewsWaiting.filter((w) => w !== go);
        reject(new Error('stopped'));
      };
      if (signal.aborted) return gone();
      signal.addEventListener('abort', gone, { once: true });
      this.reviewsWaiting.push(go);
    });
  }

  /**
   * The lead agent's review of one request: read-only, told to use no tools, in a session of its own,
   * within `APPROVAL_REVIEW_LIMITS.timeoutMs` once it starts (a few at once: `reviewSlot()`). A review that
   * could not be done says why (`failed`). Its session is linked in AgentsView, as lead review's is.
   */
  private async reviewApproval(
    conv: Conversation,
    agent: AgentConfig,
    req: ApprovalRequest,
    dirs: string[],
    signal: AbortSignal,
  ): Promise<ApprovalVerdict | { failed: string }> {
    let release: () => void;
    try {
      release = await this.reviewSlot(signal);
    } catch {
      return { failed: t().approvalReviewFailed('stopped') };
    }
    const lead = this.settings.lead;
    const timeout = AbortSignal.timeout(APPROVAL_REVIEW_LIMITS.timeoutMs);
    const both = AbortSignal.any([signal, timeout]);
    try {
      let reply = '';
      const result = await runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider, lead.account),
        backends: this.settings.backendsFor(lead.provider),
        ...this.settings.runNative(lead.provider, lead.account, 'read-only'),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: buildApprovalPrompt({
          request: req,
          messages: conv.messages,
          agent: { name: agent.name, provider: agent.provider },
          permission: conv.settings.permission,
          cwds: dirs,
        }),
        systemPrompt: APPROVAL_REVIEWER_BRIEFING,
        outputSchema: APPROVAL_SCHEMA,
        cwd: dirs[0] ?? conv.settings.cwd,
        permission: 'read-only',
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal: both,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
      if (both.aborted) throw new Error('stopped');
      // The lead agent's session belongs to this conversation too.
      if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
      return parseApprovalReply(reply, result.structured);
    } catch (err) {
      if (!signal.aborted) console.warn('[orchestrator] approval review failed:', (err as Error).message);
      if (timeout.aborted && !signal.aborted) return { failed: t().approvalReviewTimeout };
      if (err instanceof NoDecision) return { failed: t().approvalReviewNoDecision };
      return { failed: t().approvalReviewFailed((err as Error).message.trim().slice(0, 300)) };
    } finally {
      release();
    }
  }

  /**
   * Post a user message (or, with empty text, let the team continue) and start the team's turn.
   *
   * While the team replies (or its run is being set up, or the lead agent's team design waits for
   * confirmation) the message waits in the conversation's queue instead: it is posted before the
   * next turn of an agent it is for, and what no turn took starts another run when this one ends
   * (see `deliverQueued`, `startQueued`). `interrupt` stops the team first and sends it, after the
   * messages waiting, now. While the lead agent reviews the team's replies (lead review), a message
   * always does: the review stops, so it never holds the user up, and the next review reads those
   * replies too.
   */
  async send(
    convId: string,
    rawText: string,
    uploads?: AttachmentUpload[],
    interrupt = false,
    request?: TaskRequest,
    /** The message answers this agent alone (`StartOptions.answers`). */
    answers?: string,
  ): Promise<{ queued: boolean }> {
    const text = rawText.trim();
    const content = Boolean(text || uploads?.length);
    const found = this.store.get(convId);
    if (!found) throw new HttpError(404, t().conversationNotFound);
    // While the lead agent reviews, a message stops the review and goes now, and so does what waits when
    // the tray's "Skip the review and send now" sends it.
    const stopsReview = this.reviewing.has(convId) && (content || (interrupt && Boolean(found.queue?.length)));
    // Held from before the review is stopped until the run that follows takes the folder itself (or
    // needs none), so that none can take it while the review is being stopped. Taken by another
    // conversation meanwhile, the run that follows works in the team's own worktrees.
    const held = stopsReview ? this.holdFolders(found) : undefined;
    try {
      if ((interrupt || stopsReview) && (content || found.queue?.length)) await this.interrupt(convId);
      if (content && this.queues(found)) {
        // Steering: into the running turns when they can take it (`steerOrQueue`); else, as before, the queue.
        if (found.settings.steer || this.steering.has(convId)) {
          const sent = await this.steerOrQueue(found, text, uploads, request);
          if (sent) return sent;
        } else {
          this.enqueue(found, text, uploads, { request });
          return { queued: true };
        }
      }
      const conv = this.getIdle(convId);
      if (pendingPlan(conv.messages)) throw new HttpError(409, t().planAwaitingConfirm);
      if (!content && !conv.queue?.length && !conv.messages.some((m) => m.author.kind === 'user')) {
        throw new HttpError(400, t().typeFirst);
      }
      const files = saveAttachments(conv.id, uploads);
      try {
        await this.start(conv, text, {
          files,
          queue: true,
          request,
          ...(content ? { question: 'new' as const } : {}),
          ...(answers ? { answers } : {}),
        });
      } catch (err) {
        removeAttachments(conv.id, files);
        throw err;
      }
      return { queued: false };
    } finally {
      if (held && !this.runs.get(convId)?.lockRoots) this.unlockDirs(held, convId);
    }
  }

  /**
   * A message sent while the team replies, with steering on: it goes into the running turns the mode
   * allows (`steerInto`), or else waits in the queue as before. One at a time per conversation, in the
   * order they were sent, so that one steered cannot overtake one before it that waits. Undefined when
   * the team stopped meanwhile and nothing holds the conversation: the message starts a run instead.
   */
  private async steerOrQueue(
    conv: Conversation,
    text: string,
    uploads: AttachmentUpload[] | undefined,
    request?: TaskRequest,
  ): Promise<{ queued: boolean } | undefined> {
    // The run it was sent into: one the user stops while the message is being sent keeps it in the queue.
    const into = this.runs.get(conv.id);
    const prior = this.steering.get(conv.id);
    let done!: () => void;
    const mine = new Promise<void>((resolve) => (done = resolve));
    const chain = (prior ?? Promise.resolve()).then(() => mine);
    this.steering.set(conv.id, chain);
    try {
      await prior;
      // A message with files waits for a turn: a running turn takes text only.
      if (!uploads?.length && (await this.steerInto(conv, text, request))) return { queued: false };
      // Stopped meanwhile (a steer can wait seconds for its CLI's answer): it waits in the queue, as a
      // message sent with steering off would, rather than starting a run of its own.
      const stopped = Boolean(into?.abort.signal.aborted) && !this.deleting.has(conv.id) && !this.closing;
      if (!this.queues(conv) && !stopped) return undefined;
      this.enqueue(conv, text, uploads, { request });
      return { queued: true };
    } finally {
      done();
      if (this.steering.get(conv.id) === chain) this.steering.delete(conv.id);
    }
  }

  /**
   * The running turns a message goes into now (steering), by member: in roundtable and relay mode the
   * turn of the member speaking; in parallel mode every turn of the round, when all of them can take it.
   * None (it waits in the queue) when the conversation does not steer, the run is not the team's turns
   * (the lead agent designs or reviews, a fix or a failed check holds the queue), a message waits in the
   * queue already (the chat keeps the order they were sent in), or the message is for other members (in
   * parallel mode, any message that names members).
   */
  private steerTargets(conv: Conversation, run: Run, msg: ChatMessage): [string, TurnSteer][] {
    if (!conv.settings.steer || run.abort.signal.aborted || this.closing || this.deleting.has(conv.id)) return [];
    if (run.designs || run.reviewing || run.fixChecks || run.scheduledQueueOnly) return [];
    if (this.starting.has(conv.id) || this.checking.has(conv.id) || pendingPlan(conv.messages) || conv.pause) return [];
    if (conv.queue?.length || !run.steers?.size) return [];
    const parallel = conv.settings.mode === 'parallel';
    const ids = parallel ? (run.round ?? []) : [...run.active];
    if (!ids.length || (!parallel && ids.length !== 1)) return [];
    const targets: [string, TurnSteer][] = [];
    for (const id of ids) {
      const steer = run.steers.get(id);
      if (!steer) return []; // in parallel mode, all of the round or none
      targets.push([id, steer]);
    }
    const recipients = ids.flatMap((id) => conv.agents.find((a) => a.id === id) ?? []);
    // In parallel mode the round sees the same message: one that names some of its members only is for
    // them, so it waits for the next round rather than going into every turn.
    if (parallel && parseMentions(textOf(msg), conv.agents).length) return [];
    return isFor(msg, recipients, conv.agents) ? targets : [];
  }

  /**
   * Send the user's message into the running turns `steerTargets` names, all at once, and post it in the
   * chat once one of them took it, marked with those members (`steered`), who count it as seen. A turn
   * that ended in between or refused it does not have it: in parallel mode, a member of the round whose
   * turn did not take it gets it with its next turn's messages (it is in the chat, unseen), and when none
   * took it, it waits in the queue (false). Never both, never twice.
   */
  private async steerInto(conv: Conversation, text: string, request?: TaskRequest): Promise<boolean> {
    const run = this.runs.get(conv.id);
    if (!run) return false;
    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'user' },
      createdAt: Date.now(),
      parts: [{ type: 'text', text }],
      status: 'done',
      queued: true,
    };
    const targets = this.steerTargets(conv, run, msg);
    if (!targets.length) return false;
    const prompt = buildSteerPrompt(conv, msg);
    const took = await Promise.all(targets.map(([, s]) => s.steer(prompt).catch(() => false)));
    const into = targets.filter((_, i) => took[i]);
    if (!into.length) return false;
    msg.steered = into.map(([id]) => id);
    for (const [, s] of into) s.took(msg.id);
    // Deleted meanwhile: nothing to post, and nothing to queue either.
    if (this.deleting.has(conv.id) || this.store.get(conv.id) !== conv) return true;
    conv.messages.push(msg);
    this.store.saveMessage(conv.id, msg, true, request);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.nameAfter(conv, msg);
    // One of the user's own messages reached the run: they are here (as `deliverBefore` says), and what
    // the lead agent approved before it is reviewed again in its light.
    run.refuseApprovals = false;
    run.unattended = undefined;
    run.reviewed = undefined;
    return true;
  }

  /**
   * Take a reviewing conversation's directory locks again, on the folders its run wrote in (none in
   * parallel mode, read-only or in the team's own worktrees). None when another conversation took one
   * of them while the lead agent reviewed: the run that follows then works in the team's own worktrees.
   */
  private holdFolders(conv: Conversation): string[] | undefined {
    const ws = this.runs.get(conv.id)?.ws;
    if (!ws?.folders || ws.isolated) return undefined;
    const roots = rootsOf(ws);
    if (this.lockHolder(roots, conv)) return undefined;
    this.lockDirs(roots, conv);
    return roots;
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

  /**
   * Why the team could not take a scheduled message now (`sendScheduled` would answer busy or
   * skipped), or undefined when it could: asked before an automation that starts when something
   * happens reads again what it holds for the team, so that a team waiting for the user is not the
   * cause of the same mail being downloaded at every check. Nothing is started or changed.
   */
  scheduledHold(convId: string): string | undefined {
    const conv = this.store.get(convId);
    const s = conv?.schedule;
    if (!conv || !s) return undefined;
    if (this.closing) return t().shuttingDown;
    if (conv.agents.length === 0 || pendingPlan(conv.messages)) return t().scheduleNoTeam;
    // Another conversation writing in its folders holds nothing up: the team works in a worktree of its own.
    if (s.newChat) return undefined;
    const replying = this.runs.has(convId) || this.starting.has(convId);
    if (conv.pause && !replying) return t().scheduleWaitsForAnswer;
    if (replying && conv.queue?.some((m) => m.scheduled)) return t().scheduleStillQueued;
    if (this.designing.has(convId) && !conv.settings.autoConfirm) return t().scheduleDesigning;
    if (replying && (conv.queue?.length ?? 0) >= MAX_QUEUE) return t().scheduleQueueFull;
    if (replying) return undefined;
    if (this.isBusy(convId)) return t().scheduleConvBusy;
    return undefined;
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
   * A time not skipped (sent, queued, failed) ends the note of the times skipped before it, also when it
   * wrote nothing in this chat (a new chat each time).
   */
  async sendScheduled(
    convId: string,
    at = Date.now(),
    opts: { event?: string; eventSource?: EventSource; attempt?: number; retries?: boolean } = {},
  ): Promise<ScheduledSend> {
    const sent = await this.trySendScheduled(convId, at, opts);
    if (sent.result !== 'skipped' && sent.result !== 'busy') this.skipNotes.delete(convId);
    return sent;
  }

  private async trySendScheduled(
    convId: string,
    at: number,
    opts: { event?: string; eventSource?: EventSource; attempt?: number; retries?: boolean },
  ): Promise<ScheduledSend> {
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
    // A schedule that tracks a goal: its runs are followed (`TrackedRun`). Only a time the scheduler sends
    // (`retries`) is tried again: not Run now, nor a webhook's call, whose body a retry would not have.
    const tracking = s.goal
      ? { sourceId: convId, due: at, attempt: opts.attempt ?? 0, retries: Boolean(opts.retries) && opts.event === undefined }
      : undefined;
    // A schedule with a fixed command runs it first: the team hears of it only when it found something
    // new or failed, with its output as the message's event; when it found nothing, no model runs. It
    // runs only once its message could go now, and what a run found while the team could not take it
    // (busy) is kept for the time's retry, never run again for it.
    let found: { event: string; eventSource: EventSource } | undefined;
    if (s.command && opts.event === undefined) {
      found = this.heldCommandEvents.get(convId);
      if (!found) {
        const blocked = s.newChat ? undefined : this.scheduleBlocked(conv);
        if (blocked) return blocked;
        const ran = await this.runScheduledCommand(conv, s.command);
        if ('result' in ran) return ran;
        found = { event: ran.event, eventSource: 'command' };
      }
      this.heldCommandEvents.delete(convId);
    }
    const sent = await this.deliverScheduled(conv, s, at, opts, tracking, found);
    if (found && sent.result === 'busy') this.heldCommandEvents.set(convId, found);
    return sent;
  }

  /**
   * Why a schedule's message could not go to this conversation's team now (its own chat's: a new chat
   * each time always can), or undefined when it could: the checks `deliverScheduled()` makes, asked
   * before a fixed command runs for it.
   */
  private scheduleBlocked(conv: Conversation): ScheduledSend | undefined {
    const replying = this.runs.has(conv.id) || this.starting.has(conv.id);
    if (conv.pause && !replying) return { result: 'skipped', reason: t().scheduleWaitsForAnswer };
    if (Boolean(conv.queue?.some((m) => m.scheduled)) && replying) return { result: 'skipped', reason: t().scheduleStillQueued };
    if (this.designing.has(conv.id) && !conv.settings.autoConfirm) return { result: 'busy', reason: t().scheduleDesigning };
    if (replying && (conv.queue?.length ?? 0) >= MAX_QUEUE) return { result: 'skipped', reason: t().scheduleQueueFull };
    if (!replying && this.isBusy(conv.id)) return { result: 'busy', reason: t().scheduleConvBusy };
    return undefined;
  }

  /** A schedule's message sent (or queued), with what its fixed command found when it has one. */
  private async deliverScheduled(
    conv: Conversation,
    s: ConversationSchedule,
    at: number,
    opts: { event?: string; eventSource?: EventSource; attempt?: number; retries?: boolean },
    tracking: TrackedRun | undefined,
    found: { event: string; eventSource: EventSource } | undefined,
  ): Promise<ScheduledSend> {
    const convId = conv.id;
    const event = found
      ? found
      : opts.event !== undefined
        ? { event: opts.event, ...(opts.eventSource ? { eventSource: opts.eventSource } : {}) }
        : {};
    if (s.newChat) return this.sendInNewChat(conv, s, at, event, tracking);
    const replying = this.runs.has(convId) || this.starting.has(convId);
    // A run being set up may be the user's answer: the message then waits for its next turn instead.
    if (conv.pause && !replying) return { result: 'skipped', reason: t().scheduleWaitsForAnswer };
    const waiting = Boolean(conv.queue?.some((m) => m.scheduled));
    if (waiting && replying) return { result: 'skipped', reason: t().scheduleStillQueued };
    // The lead agent designs a team that will wait for the user's confirmation: queued now, the
    // message would go into that question and wait with it. Tried again a little later instead, as
    // for any busy moment.
    if (this.designing.has(convId) && !conv.settings.autoConfirm) return { result: 'busy', reason: t().scheduleDesigning };
    if (replying && (conv.queue?.length ?? 0) >= MAX_QUEUE) return { result: 'skipped', reason: t().scheduleQueueFull };
    try {
      if (replying) {
        this.enqueue(conv, s.text, undefined, { scheduled: true, event, tracked: tracking });
        return { result: 'queued' };
      }
      // A settings change or an apply holds the conversation for a moment.
      if (this.isBusy(convId)) return { result: 'busy', reason: t().scheduleConvBusy };
      // Another conversation writing in its folder holds nothing up: the team then works in its own worktree.
      // An earlier scheduled message left waiting goes out now instead; a webhook's body still goes, in a message of its own.
      const own = !waiting || opts.event !== undefined;
      await this.startScheduledMessage(conv, conv.id, own ? s.text : '', {
        queue: true,
        scheduledQueueOnly: Boolean(checksHold(conv.messages)),
        keepTeam: true,
        scheduled: own,
        ...(own ? event : {}),
        refuseApprovals: s.approvals !== 'ask',
        ...(tracking ? { tracking } : {}),
      });
      this.markInFlight(conv, tracking, conv.id);
      return { result: 'sent' };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw err;
      return sendFailure(err);
    }
  }

  /**
   * A schedule's fixed command, run as its time came: nothing for the team (`ran`), a reason it could
   * not (`failed`: gone, or its code changed and waits for the user's approval; `busy`: a run of it is
   * under way), or the event its message takes: what it found, or how it failed, with its output masked.
   */
  private async runScheduledCommand(conv: Conversation, id: string): Promise<ScheduledSend | { event: string }> {
    const cmd = this.settings.handoffs.command(id);
    if (!cmd || cmd.folder !== this.handoffFolder(conv)) return { result: 'failed', reason: t().handoffs.commandNotFound };
    if (this.commandRuns.has(cmd.id)) return { result: 'busy', reason: t().handoffs.commandRunning };
    const run = await this.executeCommand(conv, cmd, 'schedule', {});
    if (run.status === 'passed') return { result: 'ran' };
    if (run.status === 'changed') return { result: 'failed', reason: t().handoffs.runLine(run) };
    const what =
      run.status === 'news'
        ? `found something new (exit code ${FIXED_COMMAND_NEWS})`
        : run.status === 'failed'
          ? `failed (exit code ${run.exitCode ?? '?'})${run.reason ? `: ${run.reason}` : ''}`
          : `could not run${run.reason ? `: ${run.reason}` : ''}`;
    return {
      event: `The fixed command "${cmd.name}" (${cmd.run}) ${what}.${run.output ? `\n\nIts output, secrets masked:\n${run.output}` : ''}`,
    };
  }

  private async startScheduledMessage(conv: Conversation, sourceId: string, text: string, options: StartOptions): Promise<void> {
    // An older queued message already owns its files; only a newly posted one needs copies.
    const files = options.scheduled ? writeAttachments(conv.id, this.store.scheduleFileData(sourceId)) : [];
    try {
      await this.start(conv, text, { ...options, files });
    } catch (err) {
      removeAttachments(conv.id, files);
      throw err;
    }
  }

  /**
   * Send the schedule's message in a new conversation: a copy of this one's team, settings (lead review
   * included, as the schedule has it), "always allow" answers and sidebar group (the lead agent does
   * not sort it), named after it and the time it came due, which says where it comes from. Whatever this conversation is doing — replying, waiting
   * for the user's answer, holding messages in its queue — does not matter; while another conversation
   * (this one included) writes in the same folder, the new one's team works in a worktree of its own.
   * A conversation whose run could not start is removed again: nothing was sent in it.
   */
  private async sendInNewChat(
    conv: Conversation,
    s: ConversationSchedule,
    at: number,
    event: ScheduledEvent,
    tracking?: TrackedRun,
  ): Promise<ScheduledSend> {
    const id = randomUUID();
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
      await this.startScheduledMessage(chat, conv.id, s.text, {
        keepTeam: true,
        scheduled: true,
        scheduleSource: conv.id,
        ...event,
        refuseApprovals: s.approvals !== 'ask',
        ...(tracking ? { tracking } : {}),
      });
      this.markInFlight(conv, tracking, id);
      return { result: 'sent', chatId: id };
    } catch (err) {
      if (!this.runs.has(id)) this.store.delete(id);
      return sendFailure(err);
    }
  }

  /**
   * The conversation whose schedule tracks the goal a run works on: the one whose schedule started it
   * (`Run.tracking`, here or in a new chat), and none for a run the user's own message started, also
   * in a chat whose schedule tracks a goal: only the schedule's runs are told the goal, and only their
   * replies report on it (a reply to "how is CI?" switches nothing off).
   */
  private trackingSource(run: Pick<Run, 'tracking'>): Conversation | undefined {
    const source = run.tracking ? this.store.get(run.tracking.sourceId) : undefined;
    return source?.schedule?.goal ? source : undefined;
  }

  /**
   * The tracking schedule's run a run carries on, when it was not started as one: the schedule's message
   * that waited in the queue (its own time's run, `ChatMessage.tracked`); the user's answer to a question
   * such a run asked (`RunPause.tracked`); Continue after its replies (nothing posted, nobody picked). The
   * user is there for the last two, so they are not tried again; a team design carries nothing on.
   */
  private carriedTracking(
    conv: Conversation,
    posted: ChatMessage[],
    opts: StartOptions,
    paused: TrackedRun | undefined,
    planning: boolean,
  ): TrackedRun | undefined {
    if (planning) return undefined;
    const queued = posted.find((m) => m.scheduled && m.tracked)?.tracked;
    if (queued) return queued;
    const again = (r: TrackedRun | undefined) => r && { ...r, due: this.clock(), attempt: 0, retries: false };
    if (paused) return again(paused);
    if (!posted.length && !opts.only) return again(conv.messages.findLast((m) => m.author.kind === 'agent')?.tracked);
    return undefined;
  }

  /** Remember that the run a tracking schedule just started has not ended yet: a restart tries it again. */
  private markInFlight(conv: Conversation, tracking: TrackedRun | undefined, chatId: string): void {
    const s = conv.schedule;
    if (!tracking?.retries || !s?.goal) return;
    s.tracking = { ...(s.tracking ?? freshTracking()), inFlight: { due: tracking.due, attempt: tracking.attempt, chatId } };
    this.store.saveSchedule(conv);
  }

  /**
   * A reply said where the tracked goal stands: keep the note with the schedule. Once an agent says it
   * is done, the schedule switches off; one that is held up tells the user in the chat (an agent that
   * needs their answer also asks, which notifies them).
   */
  private recordProgress(
    source: Conversation,
    conv: Conversation,
    msg: ChatMessage,
    progress: { status: ProgressStatus; text: string },
  ): void {
    const s = source.schedule;
    if (!s?.goal) return;
    const agent = msg.agentName ?? 'agent';
    s.tracking = withNote(s.tracking, {
      at: this.clock(),
      status: progress.status,
      text: progress.text,
      agent,
      ...(source.id !== conv.id ? { chatId: conv.id } : {}),
    });
    const note =
      progress.status === 'done'
        ? t().trackingDoneNote(agent, progress.text)
        : progress.status === 'blocked'
          ? t().trackingBlockedNote(agent, progress.text)
          : undefined;
    if (progress.status === 'done') {
      s.enabled = false;
      delete s.nextRunAt;
      delete s.tracking.retry;
    }
    this.store.saveSchedule(source);
    this.emitConversation(source);
    if (note) {
      this.systemNote(source, note);
      if (source.id !== conv.id) this.systemNote(conv, note);
    }
  }

  /**
   * A run a tracking schedule started has ended. It is no longer in flight; when every reply in it
   * failed (not when it was stopped), the time it came due is tried again (`retryTracked`).
   */
  private trackedRunEnded(conv: Conversation, run: Run): void {
    const tracked = run.tracking!;
    const source = this.store.get(tracked.sourceId);
    const s = source?.schedule;
    if (!source || !s?.goal || this.deleting.has(source.id)) return;
    // Stopped by the server shutting down: it stays in flight, so the next start tries it again.
    if (this.closing) return;
    const flight = s.tracking?.inFlight;
    const ours = Boolean(flight && flight.due === tracked.due && flight.chatId === conv.id);
    if (ours) {
      const { inFlight: _done, ...rest } = s.tracking!;
      s.tracking = rest;
      this.store.saveSchedule(source);
    }
    // Only the schedule's own run in flight is tried again: switching the schedule off (or giving it
    // another goal) meanwhile takes it out of flight (`PUT …/schedule`), and so does the user's Stop.
    if (!ours || !tracked.retries || run.abort.signal.aborted || s.tracking?.status === 'done') return;
    const replies = conv.messages.slice(tracked.from).filter((m) => m.author.kind === 'agent');
    if (replies.length && replies.every((m) => m.status === 'error')) this.retryTracked(source, tracked.due, tracked.attempt + 1);
  }

  /**
   * Try a tracking schedule's time again (its run failed, or could not start, or a restart cut it off):
   * the `attempt`th retry, after the wait `retryDelayMs` gives it, unless the schedule's next time comes
   * first; with no retry left, a note says so and the schedule waits for its next time. `restarted`:
   * the server stopped during the run, so it is tried at once.
   */
  retryTracked(conv: Conversation, due: number, attempt: number, now = this.clock(), restarted = false): void {
    const s = conv.schedule;
    // Reached, or switched off by the user meanwhile (a one-time schedule is off once it has sent).
    if (!s?.goal || s.tracking?.status === 'done' || (!s.enabled && s.repeat.kind !== 'once')) return;
    const when = scheduleTime(due, s);
    const wait = retryDelayMs(attempt);
    const delay = wait === undefined ? undefined : restarted ? 0 : wait;
    const at = delay === undefined ? undefined : now + delay;
    const { retry: _old, ...rest } = s.tracking ?? freshTracking();
    s.tracking = rest;
    if (at === undefined) {
      this.store.saveSchedule(conv);
      this.emitConversation(conv);
      this.systemNote(conv, t().trackingGaveUpNote(when, attempt - 1));
      return;
    }
    // The schedule's own next time comes first: that one is the next try.
    if (s.enabled && s.nextRunAt !== undefined && s.nextRunAt <= at) {
      this.store.saveSchedule(conv);
      return;
    }
    s.tracking = { ...rest, retry: { due, attempt, at } };
    s.enabled = true;
    s.nextRunAt = at;
    this.store.saveSchedule(conv);
    this.emitConversation(conv);
    this.systemNote(conv, restarted ? t().trackingRestartNote(when) : t().trackingRetryNote(when, attempt, Math.round(delay! / 60_000)));
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

  /** A message sent now waits in the queue (anything else that keeps the conversation busy refuses it). */
  private queues(conv: Conversation): boolean {
    if (this.deleting.has(conv.id) || this.closing) return false;
    // A team checks' command run by itself (Check again, Try it) too: what is sent waits for its result.
    return this.runs.has(conv.id) || this.starting.has(conv.id) || this.checking.has(conv.id) || Boolean(pendingPlan(conv.messages));
  }

  private enqueue(
    conv: Conversation,
    text: string,
    uploads: AttachmentUpload[] | undefined,
    { scheduled, event, tracked, request }: { scheduled?: boolean; event?: ScheduledEvent; tracked?: TrackedRun; request?: TaskRequest },
  ): void {
    const queue = (conv.queue ??= []);
    if (queue.length >= MAX_QUEUE) throw new HttpError(409, t().queueFull(MAX_QUEUE));
    const files = scheduled ? writeAttachments(conv.id, this.store.scheduleFileData(conv.id)) : saveAttachments(conv.id, uploads);
    // Marked only when it joins a team's discussion: not a question written while the lead agent
    // designs the team, its design waits for confirmation, or the lead reviews the team's replies.
    const midReply = (this.runs.has(conv.id) || this.starting.has(conv.id)) && !this.designing.has(conv.id) && !this.reviewing.has(conv.id);
    queue.push({
      id: randomUUID(),
      author: { kind: 'user' },
      createdAt: Date.now(),
      parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
      status: 'done',
      ...(midReply ? { queued: true } : {}),
      ...(scheduled ? { scheduled: true } : {}),
      ...(scheduled ? event : {}),
      // A tracking schedule's message: the run that sends it is that time's run (`carriedTracking`).
      ...(scheduled && tracked ? { tracked } : {}),
    });
    try {
      this.saveQueue(conv, request);
    } catch (err) {
      queue.pop();
      removeAttachments(conv.id, files);
      throw err;
    }
  }

  private saveQueue(conv: Conversation, request?: TaskRequest): void {
    this.store.saveQueue(conv, request);
    this.hub.emit(conv.id, { type: 'queue', queue: conv.queue ?? [] });
  }

  /**
   * Post waiting messages, oldest first, and return them: before a turn, those for `recipients` —
   * one that @mentions only other agents waits for them, and the ones behind it wait too, so the
   * chat keeps the order they were sent in; when a run starts, those in `ids` (sent before it),
   * wherever they are — a scheduled message kept back while the user answers stays where it is, and
   * what the user wrote behind it still goes now.
   */
  private deliverQueued(
    conv: Conversation,
    which: { recipients: AgentConfig[]; scheduledOnly?: boolean } | { ids: Set<string> },
  ): ChatMessage[] {
    const queue = conv.queue ?? [];
    const posted: ChatMessage[] = [];
    for (let i = 0; i < queue.length;) {
      const next = queue[i]!;
      if ('ids' in which) {
        if (!which.ids.has(next.id)) {
          i++;
          continue;
        }
      } else {
        if (which.scheduledOnly && !next.scheduled) {
          i++;
          continue;
        }
        if (!isFor(next, which.recipients, conv.agents)) break;
      }
      // Posted before it leaves the saved queue: a crash in between keeps it once, as delivered.
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
   * answer (the lead agent's team design is not waiting for confirmation): messages written while the
   * team worked, or a schedule's message that came due while the lead agent reviewed, which the current
   * team answers. Returns whether it starts; a run that fails to start says why in the chat, and its
   * messages keep waiting.
   */
  startQueued(conv: Conversation): boolean {
    if (!conv.queue?.length || !this.mayStart(conv)) return false;
    if (latestDesignSinceReply(conv.messages)?.status === 'failed') return false;
    // An agent asked the user something: what was written before the question waits for the answer.
    if (conv.pause) return false;
    // Team checks that did not pass hold what the user wrote meanwhile: they decide (Send, Skip, Fix).
    const scheduledQueueOnly = Boolean(checksHold(conv.messages));
    const eligible = scheduledQueueOnly ? conv.queue.filter((m) => m.scheduled) : conv.queue;
    if (!eligible.length) return false;
    // Only the schedule's message waits: nobody may be watching this run either.
    const unattended = eligible.every((m) => m.scheduled) && conv.schedule?.approvals !== 'ask';
    this.startInBackground(conv, { queue: true, scheduledQueueOnly, keepTeam: true, refuseApprovals: unattended });
    return true;
  }

  /**
   * The team the lead agent designed was confirmed (by the user, or at once): it answers the question
   * the design was for, with the messages waiting. A team designed for the schedule answers its message
   * when the schedule sends it: now only what the user wrote meanwhile. Returns whether a run starts.
   */
  startConfirmed(conv: Conversation, refuseApprovals = false): boolean {
    if (conv.messages.findLast((m) => m.plan?.status === 'ready')?.plan?.forSchedule) return this.startQueued(conv);
    if (!this.mayStart(conv)) return false;
    this.startInBackground(conv, { queue: true, keepTeam: true, refuseApprovals });
    return true;
  }

  /** Nothing else is going on, and a team may answer (none is waiting for confirmation). */
  private mayStart(conv: Conversation): boolean {
    if (this.isBusy(conv.id) || this.closing || this.store.get(conv.id) !== conv) return false;
    return !pendingPlan(conv.messages) && (conv.agents.length > 0 || Boolean(conv.settings.autoTeam));
  }

  /** Start a run nobody waits for; one that fails to start says why in the chat. */
  private startInBackground(conv: Conversation, opts: StartOptions): void {
    this.start(conv, '', opts).catch((err) => {
      if (!(err instanceof HttpError && err.status === 404)) this.systemNote(conv, t().runFailed((err as Error).message));
      this.emitStatus(conv.id);
    });
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
    // A reply of a tracking schedule's run: answered again, it reports on the goal too.
    const tracking = target.tracked && { ...target.tracked, due: this.clock(), attempt: 0, retries: false };
    await this.start(conv, '', { beforePost: () => this.truncateFrom(conv, messageId), only: again, ...(tracking ? { tracking } : {}) });
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
    // The branch waits for its own answer: a steps card answered here is to be answered again there.
    for (const m of askingReplies(messages, pause)) if (stepsOfMessage(m)) delete stepsOfMessage(m)!.answer;
    // A branch of the conversation the reply was written in (this one, or one it was copied from).
    const titleOf = (from: string) => this.store.titleOf(from);
    let branch = branchOrigin(conv, index, messages, titleOf);
    const id = randomUUID();
    let chat: Conversation;
    try {
      await copyAttachments(conv.id, id, copied.flatMap(attachmentsOf));
      await copyShownFiles(conv.id, id, messages);
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
    this.store.deleteMessages(
      conv.id,
      dropped.map((m) => m.id),
    );
    // What those replies asked to send goes with them, and the notes they saved are set aside.
    this.outbox?.discardFor(
      conv.id,
      dropped.map((m) => m.id),
    );
    this.memory.dropReplies(
      conv.id,
      dropped.map((m) => m.id),
    );
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
      const state: AgentSessionState = {
        provider: was?.provider,
        permission: was?.permission,
        ...(was?.byCli ? { byCli: was.byCli } : {}),
        seen: [],
      };
      conv.agentState[agentId] = state;
      this.store.saveAgentState(conv.id, agentId, state);
    }
    // Parallel worktrees hold the dropped turns' work: start them again from the working directory.
    for (const [agentId, list] of Object.entries(conv.worktrees)) {
      // The team's own stand in for the working directories, whose files a rewind leaves as they are:
      // kept while a reply that changed them is left; rewound past every one, what they hold goes.
      if (agentId === TEAM_WORKTREE && conv.messages.some((m) => madeIn(m, list))) continue;
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
    this.hub.emit(conv.id, { type: 'snapshot', conversation: forClient(conv), running: false, activeAgentIds: [] });
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
    const planning = Boolean(opts.checkPlan) || this.designs(conv, text, opts);
    // Reserved until the run is registered, so a settings change or an apply cannot slip in while the
    // workspace is prepared, and a delete waits for it; a message sent meanwhile waits in the queue.
    const release = this.reserve(convId);
    this.starting.add(convId);
    if (planning) this.designing.add(convId);
    // Messages queued from now on were sent after this one: they wait for the first turn. When the
    // user answers an agent's question, scheduled messages stay queued too: the run picks up where
    // the team stopped, so they wait for a turn of an agent they are for, or for a run of their own.
    const ahead = opts.queue
      ? new Set((conv.queue ?? []).filter((m) => (m.scheduled ? !conv.pause : !opts.scheduledQueueOnly)).map((m) => m.id))
      : undefined;
    let lockRoots: string[] | undefined;
    let run: Run;
    let posted: ChatMessage[] = [];
    let resume: Schedule | undefined;
    let tracking: TrackedRun | undefined;
    try {
      const ws = await this.prepareWorkspace(conv);
      // The repositories the team would write in, taking turns there (not in parallel mode's worktrees).
      const writes = ws.folders && !ws.isolated && !planning ? rootsOf(ws) : undefined;
      // Its own worktrees still hold work that is not applied: it goes on there, whoever writes in the folders.
      const pending = writes ? await this.teamWorkPending(conv, writes) : false;
      // Deleted meanwhile (the delete may even have finished already), or the server is stopping.
      if (this.deleting.has(convId) || this.store.get(convId) !== conv) {
        throw new HttpError(404, t().conversationNotFound);
      }
      if (this.closing) throw new HttpError(503, t().shuttingDown);
      /** Why the team moves into its own worktrees now: another conversation is writing in its folders. */
      let teamNote: string | undefined;
      let dropTeamWorktrees = false;
      // Checked and taken at once, with nothing awaited between: no other run can take them meanwhile.
      const decide = (roots: string[], own: boolean) => {
        const taken = own ? undefined : this.lockHolder(roots, conv);
        ws.isolated = own || Boolean(taken);
        ws.team = ws.isolated;
        if (taken) {
          teamNote = t().teamWorktreeNote(taken.title, taken.root);
          // Its worktrees hold nothing of the team's: made again from the folders as they are now, not
          // kept from snapshots the other conversation has written past since.
          for (const w of conv.worktrees[TEAM_WORKTREE] ?? []) {
            if (w.needsReset) continue;
            w.needsReset = true;
            this.store.saveWorktree(conv.id, TEAM_WORKTREE, w);
          }
        }
        if (ws.isolated) return;
        lockRoots = roots;
        this.lockDirs(lockRoots, conv);
        dropTeamWorktrees = Boolean(conv.worktrees[TEAM_WORKTREE]?.length);
      };
      if (writes) decide(writes, pending);
      beforePost?.();
      // A rewind (a resend or a retry) dropped what the team's worktrees held, marking them for a reset:
      // it writes in the folders again, unless another conversation does.
      if (writes && pending && !conv.worktrees[TEAM_WORKTREE]?.some((w) => !w.needsReset && writes.includes(w.root))) {
        decide(writes, false);
      }
      if (ahead) posted = this.deliverQueued(conv, { ids: ahead });
      const own = this.postUserMessage(
        conv,
        text,
        files,
        opts.scheduled,
        {
          ...(opts.event !== undefined ? { event: opts.event } : {}),
          ...(opts.event !== undefined && opts.eventSource ? { eventSource: opts.eventSource } : {}),
        },
        opts.request,
        opts.autoFix ? { attempt: opts.autoFix, of: CHECK_LIMITS.autoFixes } : undefined,
      );
      if (own) posted.push(own);
      else if (opts.request) this.store.recordTask(opts.request, convId, false);
      if (teamNote) this.systemNote(conv, teamNote);
      const pausedTracked = conv.pause?.tracked;
      const resumed = this.takePause(conv, posted, only, planning, opts.answers);
      resume = resumed?.schedule;
      const pausedChecks = resumed ? this.pendingPauseChecks(conv) : undefined;
      tracking = opts.tracking ?? this.carriedTracking(conv, posted, opts, pausedTracked, planning);
      run = {
        abort: new AbortController(),
        active: new Set(),
        turns: new Set(),
        ws,
        lockRoots,
        ...(dropTeamWorktrees ? { dropTeamWorktrees } : {}),
        // Only while nothing the user wrote starts it: when they write, they are here.
        ...(opts.refuseApprovals && posted.every((m) => m.scheduled) ? { refuseApprovals: true } : {}),
        ...(planning ? { designs: true } : {}),
        ...(opts.checkPlan ? { checkPlan: opts.checkPlan } : {}),
        ...(planning && opts.designSchedule && conv.schedule ? { designFor: conv.schedule.text } : {}),
        ...(tracking ? { tracking: { ...tracking, from: conv.messages.length } } : {}),
        from: conv.messages.length,
        ...(pausedChecks ? { pausedChecks } : {}),
        ...(posted.length && posted.every((m) => m.scheduled) ? { unattended: opts.scheduleSource ?? convId } : {}),
        ...(opts.scheduledQueueOnly ? { scheduledQueueOnly: true } : {}),
        ...(opts.fixChecks ? { fixChecks: opts.fixChecks } : {}),
        ...(opts.autoFix ? { autoFix: opts.autoFix } : {}),
        done: Promise.resolve(),
      };
      this.runs.set(convId, run);
      // A tracking schedule's message that waited in the queue goes out now: its time is in flight.
      if (tracking && !opts.tracking) this.markInFlight(this.store.get(tracking.sourceId) ?? conv, tracking, convId);
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
          if (run.tracking) this.trackedRunEnded(conv, run);
          // The lead agent tidies the long-term memory now and then, once runs have saved enough notes.
          if (!this.closing) this.memory.maybeTidy();
          // The team the lead agent just designed answers at once, when it needs no confirmation.
          // Otherwise, messages sent while the team replied that no turn took: the team answers them
          // now. After Stop they keep waiting, for the user to send or withdraw.
          const next =
            !run.abort.signal.aborted &&
            (run.answerNext
              ? this.startConfirmed(conv, run.refuseApprovals)
              : run.autoFixNext
                ? this.startAutoFix(conv, run.autoFixNext)
                : this.startQueued(conv));
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
  private postUserMessage(
    conv: Conversation,
    text: string,
    files: AttachmentPart[],
    scheduled = false,
    event: ScheduledEvent = {},
    request?: TaskRequest,
    autoFix?: ChatMessage['autoFix'],
  ): ChatMessage | undefined {
    let msg: ChatMessage | undefined;
    if (text || files.length) {
      msg = {
        id: randomUUID(),
        author: { kind: 'user' },
        createdAt: Date.now(),
        parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
        status: 'done',
        ...(scheduled ? { scheduled: true } : {}),
        ...(scheduled ? event : {}),
        ...(autoFix ? { autoFix } : {}),
      };
      conv.messages.push(msg);
      try {
        this.store.saveMessage(conv.id, msg, true, request);
      } catch (err) {
        conv.messages.pop();
        throw err;
      }
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
    this.checking.get(convId)?.abort();
  }

  /** Shutting down: stop every run, and refuse new runs, applies and settings changes. */
  stopAll(): void {
    this.closing = true;
    for (const r of this.runs.values()) r.abort.abort();
    for (const c of this.checking.values()) c.abort();
    for (const set of this.revisions.values()) for (const r of set) r.abort.abort();
    this.grouper.stopAll();
    this.memory.stopAll();
    this.stopInteractive();
    for (const abort of this.commandRuns.values()) abort.abort();
  }

  emitConversation(conv: Conversation): void {
    this.hub.emit(conv.id, {
      type: 'conversation',
      title: conv.title,
      agents: conv.agents,
      settings: conv.settings,
      worktrees: conv.worktrees,
      pause: conv.pause,
      schedule: conv.schedule && scheduleForClient(conv.schedule),
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
  private lockDirs(roots: string[], conv: Conversation, why: (title: string, root: string) => string = t().dirLocked): void {
    const taken = this.lockHolder(roots, conv);
    if (taken) throw new HttpError(409, why(taken.title, taken.root));
    for (const root of roots) {
      this.dirLocks.set(root, conv.id);
      this.writeCounts.set(root, (this.writeCounts.get(root) ?? 0) + 1);
    }
  }

  /**
   * Another conversation's lock on one of these directories, or on one inside or around it (nested
   * repositories): its title and the folder it holds, or undefined when there is none. Nothing is changed.
   */
  private lockHolder(roots: string[], conv: Conversation): { title: string; root: string } | undefined {
    const within = (a: string, b: string) => a.startsWith(b.endsWith(sep) ? b : b + sep);
    for (const root of roots) {
      for (const [held, holder] of this.dirLocks) {
        if (holder !== conv.id && (held === root || within(held, root) || within(root, held))) {
          return { title: this.store.get(holder)?.title ?? holder, root: held };
        }
      }
    }
    return undefined;
  }

  /**
   * How often the conversation's working directories (or a folder around or inside one) were locked
   * for writing, as `<this server's id>:<count>`: changed since the last check, someone wrote there.
   * Nothing is started or changed.
   */
  folderWrites(convId: string): string {
    const conv = this.store.get(convId);
    let n = 0;
    if (conv) {
      const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
      // The working directory a file source watches: another one of the conversation's is not it.
      const dirs = [conv.settings.cwd].flatMap((d) => {
        try {
          return [realpathSync(d)];
        } catch {
          return [];
        }
      });
      for (const [root, count] of this.writeCounts) if (dirs.some((d) => within(d, root) || within(root, d))) n += count;
    }
    return `${this.writesEpoch}:${n}`;
  }

  /**
   * Whether a run may be writing in the conversation's working directories now: one of its own
   * (replying there, being set up, or a change being made to it, such as a reply applied; not a team
   * working in its own worktrees), or another conversation's that holds a lock on a folder around or
   * inside one of them, whatever this one's mode.
   * Nothing is started or changed: an automation that waits for files there asks, so that what the team
   * writes never starts it again (`Scheduler.check()`).
   */
  folderInUse(convId: string): boolean {
    const conv = this.store.get(convId);
    if (!conv) return false;
    // Its own run writes in the folder in edit mode outside parallel (whose members work in worktrees),
    // unless the team works in its own worktrees, or once it holds the folder's lock (an action allowed in
    // a read-only run); a change being applied does. A run being set up may yet write there.
    const writes = conv.settings.permission !== 'read-only' && conv.settings.mode !== 'parallel';
    const run = this.runs.get(convId);
    if (run?.lockRoots || this.reserved.has(convId)) return true;
    if (writes && (run ? !run.ws.isolated : this.starting.has(convId))) return true;
    // Only the working directory a file source watches: another chat writing in one of the others is not in it.
    return this.lockedFolder(conv, [conv.settings.cwd]);
  }

  /**
   * Whether a run may be writing in `folder` (a real path) now: the conversation's own, as for
   * `folderInUse()`, or any conversation's (its own included) holding a lock on a folder around or
   * inside it (a run writing there, a result being applied, a team check's commands, an action allowed
   * in a read-only run). The Files panel changes a file only when none is, so that each turn's changes
   * stay its own. Nothing is started or changed.
   */
  writingIn(convId: string, folder: string): boolean {
    const conv = this.store.get(convId);
    if (conv) {
      const writes = conv.settings.permission !== 'read-only' && conv.settings.mode !== 'parallel';
      const run = this.runs.get(convId);
      if (run?.lockRoots || this.reserved.has(convId)) return true;
      if (writes && (run ? !run.ws.isolated : this.starting.has(convId))) return true;
    }
    const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
    for (const held of this.dirLocks.keys()) if (within(folder, held) || within(held, folder)) return true;
    return false;
  }

  /** Whether another conversation's lock covers one of these working directories of this one (around it or inside it). */
  private lockedFolder(conv: Conversation, folders: string[]): boolean {
    const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
    for (const dir of folders) {
      let cwd: string;
      try {
        cwd = realpathSync(dir);
      } catch {
        continue;
      }
      for (const [held, holder] of this.dirLocks) {
        if (holder !== conv.id && (within(cwd, held) || within(held, cwd))) return true;
      }
    }
    return false;
  }

  private unlockDirs(roots: string[], convId: string): void {
    for (const root of roots) if (this.dirLocks.get(root) === convId) this.dirLocks.delete(root);
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
      // A folder of its own for each repository (an earlier one, of the agent's id alone, is kept).
      await this.ownWorktrees(conv, a.id, roots, bases, (hash) => ({
        path: join(DATA_DIR, 'worktrees', conv.id, `${a.id}-${hash}`),
        branch: `relay/${conv.id.slice(0, 8)}/${a.name}`,
      }));
    }
    this.emitConversation(conv);
  }

  /**
   * The team's own worktrees (`TEAM_WORKTREE`), one of each repository (`roots`), which every member
   * works in: kept while they hold work not applied, else made from new snapshots of the working
   * directories. Each is named as its repository is (inside a folder of its own), so the team's folder
   * goes by the name the user's has.
   */
  private async prepareTeamWorktrees(conv: Conversation, roots: string[]): Promise<void> {
    await this.ownWorktrees(conv, TEAM_WORKTREE, roots, new Map(), (hash, root) => ({
      path: join(DATA_DIR, 'worktrees', conv.id, `${TEAM_WORKTREE}-${hash}`, basename(root) || 'root'),
      branch: `relay/${conv.id.slice(0, 8)}/${TEAM_WORKTREE}`,
    }));
    this.emitConversation(conv);
  }

  /**
   * The worktrees `conv.worktrees[id]` should have: one of each repository (`roots`), those of the
   * others removed. One that is there and not marked for a reset is kept; else it is made (again, at
   * the same place and on the same branch) from a snapshot of its repository, the same one for every
   * owner (`bases`), at the place and on the branch `where` names (from the root's short hash).
   */
  private async ownWorktrees(
    conv: Conversation,
    id: string,
    roots: string[],
    bases: Map<string, string>,
    where: (hash: string, root: string) => { path: string; branch: string },
  ): Promise<void> {
    const had = conv.worktrees[id] ?? [];
    for (const gone of had.filter((w) => !roots.includes(w.root))) {
      await removeWorktree(gone.root, gone.path, gone.branch).catch(() => {});
      this.store.deleteWorktree(conv.id, id, gone.root);
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
      const place = cur ?? where(createHash('sha256').update(root).digest('hex').slice(0, 8), root);
      const wt: AgentWorktree = { root, path: place.path, branch: place.branch, base, needsReset: false };
      await createWorktree(root, wt.path, wt.branch, base);
      next.push(wt);
      this.store.saveWorktree(conv.id, id, wt);
    }
    conv.worktrees[id] = next;
  }

  /**
   * Whether the team's own worktrees of these repositories hold work that is not applied yet: made
   * since their snapshots, and not marked for a reset (applied, or the chat rewound past it). One that
   * cannot be read counts as holding some, so that nothing in it is removed.
   */
  private async teamWorkPending(conv: Conversation, roots: string[]): Promise<boolean> {
    for (const w of conv.worktrees[TEAM_WORKTREE] ?? []) {
      if (w.needsReset || !roots.includes(w.root) || !existsSync(w.path)) continue;
      try {
        if (await worktreeChanged(w.path, w.base)) return true;
      } catch (err) {
        console.warn(`[orchestrator] could not read the team's worktree ${w.path}:`, (err as Error).message);
        return true;
      }
    }
    return false;
  }

  /** Remove the team's own worktrees, with their branches and folders: the team writes in the working directories again. */
  private async dropTeamWorktrees(conv: Conversation): Promise<void> {
    const list = conv.worktrees[TEAM_WORKTREE];
    if (!list) return;
    for (const w of list) {
      await removeWorktree(w.root, w.path, w.branch).catch(() => {});
      // The folder it was named in, its own (`prepareTeamWorktrees`).
      if (basename(dirname(w.path)).startsWith(`${TEAM_WORKTREE}-`)) rmSync(dirname(w.path), { recursive: true, force: true });
      this.store.deleteWorktree(conv.id, TEAM_WORKTREE, w.root);
    }
    delete conv.worktrees[TEAM_WORKTREE];
    this.emitConversation(conv);
  }

  /**
   * Apply everything an agent did in its worktrees to the real working directories (uncommitted), or
   * the team in its own (`agentId` is `TEAM_WORKTREE`, whose next run then writes in the working
   * directories again, unless another conversation does): refused while another conversation writes in
   * one of them (409). Every patch is checked before any is applied, so a conflict in one changes nothing anywhere. With
   * team checks, the result is checked first, on the working directories as they are with it in them
   * (`checkBeforeApply()`): what does not pass is not applied (`held`, the card's id), until the user
   * applies it anyway (`force`: only the result that card checked; another one is checked again) or,
   * when the result changed what the commands read, confirms that and has them run (`confirm`). Stop
   * stops the checks, and nothing is applied then. What was sent meanwhile goes once they are done.
   */
  async applyAgentWork(
    convId: string,
    agentId: string,
    o: { force?: boolean; confirm?: boolean } = {},
  ): Promise<{ files: FileChange[]; held?: string }> {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    const team = agentId === TEAM_WORKTREE;
    if (!conv.worktrees[agentId]?.length) throw new HttpError(404, team ? t().noTeamWorktree : t().noWorktree);
    if (conv.worktrees[agentId]!.some((w) => w.needsReset)) throw new HttpError(409, t().resultStale);
    const abort = new AbortController();
    let checkedFirst = false;
    // Reserved at once (before anything is awaited), so the team cannot start writing (and take over
    // these locks) while the patches are checked and applied.
    const work = this.exclusive(convId, t().busyApply, async () => {
      const wts = await this.currentWorktrees(conv, agentId);
      if (!wts.length) throw new HttpError(400, t().nothingToApply);
      const roots = wts.map((w) => w.root);
      this.lockDirs(roots, conv, t().applyLocked);
      try {
        const checked: CheckedPatch[] = [];
        const span = new Map<string, { base: string; head: string; files: Set<string> }>();
        const heads: string[] = [];
        for (const wt of wts) {
          const head = await worktreeHead(wt.path);
          heads.push(head);
          const patch = await checkPatch(wt.root, wt.base, head);
          if (!patch) continue;
          checked.push(patch);
          span.set(wt.root, { base: wt.base, head, files: new Set(patch.files.map((f) => f.path)) });
        }
        if (!checked.length) throw new HttpError(400, t().nothingToApply);
        const name = team ? t().teamName : (conv.agents.find((a) => a.id === agentId)?.name ?? agentId);
        const of = { agentId, name, heads: heads.join(' ') };
        let card: ChatMessage | undefined;
        // Applied anyway, or its commands confirmed: only for the result the latest card held back (this
        // member's, as it was then), whose card then says it was applied (it still did not pass). Any other
        // (a result changed since, another member's card latest) is checked again, from the start.
        const latest = latestChecks(conv.messages);
        const mine =
          latest?.checks?.when === 'apply' && latest.checks.applyOf?.agentId === agentId && latest.checks.applyOf.heads === of.heads
            ? latest
            : undefined;
        const force = Boolean(o.force && mine);
        const confirm = Boolean(o.confirm && mine);
        if (force && !mine!.checks!.applied) card = mine;
        if (!force && hasApplyChecks(conv.settings.checks)) {
          const folders = await this.foldersNow(conv);
          if (conv.settings.checks.commands?.length && this.checkCommandDeps.platform !== 'win32') {
            const extra = [...new Set(folders.map((f) => f.root))].filter((root) => !roots.includes(root));
            this.lockDirs(extra, conv, t().applyLocked);
            roots.push(...extra);
          }
          checkedFirst = true;
          this.checking.set(convId, abort);
          this.emitStatus(convId);
          try {
            card = await this.checkBeforeApply(conv, folders, of, checked, span, abort.signal, confirm);
          } finally {
            this.checking.delete(convId);
            this.emitStatus(convId);
          }
          if (abort.signal.aborted || card.checks!.outcomes.some(blocking)) return { files: [], held: card.id };
        }
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
        // The result that checked what was just applied still says how the folders are.
        this.markChecksStale(conv, card);
        if (card?.checks) {
          card.checks = { ...card.checks, applied: true };
          this.hub.emit(conv.id, { type: 'message', message: card });
          this.store.saveMessage(conv.id, card, true);
        }
        this.systemNote(conv, team ? t().appliedTeamNote(files.length) : t().appliedNote(name, files.length));
        this.emitConversation(conv);
        return { files };
      } finally {
        this.unlockDirs(roots, conv.id);
      }
    });
    this.checkWork.add(work);
    try {
      return await work;
    } finally {
      this.checkWork.delete(work);
      // Only after checks, during which what was sent waited: an apply alone holds nothing back.
      if (checkedFirst && !abort.signal.aborted) this.startQueued(conv);
    }
  }

  /**
   * Team checks of a member's parallel-mode result before it is applied, posted as a card: the
   * protected paths among the files it changes, and the commands, run in check trees (each repository's
   * working tree as it is now, its result applied on top, the installed dependencies linked in:
   * `linkDependencies()`), never in the working directories, which still hold the code before it. In
   * Harness Relay's sandbox whenever it can start, with full access too: a result not applied yet must not
   * change the user's own dependencies, which the trees link to. Commands held back when the result changed
   * what they read, unless the user confirmed it (`confirm`); none on native Windows (no tree is made).
   * The trees are removed afterwards.
   */
  private async checkBeforeApply(
    conv: Conversation,
    folders: { cwd: string; root: string }[],
    of: { agentId: string; name: string; heads: string },
    checked: CheckedPatch[],
    span: Map<string, { base: string; head: string; files: Set<string> }>,
    signal: AbortSignal,
    confirm: boolean,
  ): Promise<ChatMessage> {
    const list = conv.settings.checks!;
    const started = Date.now();
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const outcomes: CheckOutcome[] = [];
    const patterns = listPatterns(list);
    if (patterns.length) {
      const status = { A: 'added', M: 'changed', D: 'removed' } as const;
      const many = folders.length > 1;
      const findings = checked.flatMap((p) =>
        folders
          .filter((f) => f.root === p.root)
          .flatMap((f) =>
            p.files.flatMap((file: FileChange) => {
              const rel = relativeInside(real(f.cwd), join(p.root, ...file.path.split('/')));
              return rel && isProtected(rel, patterns)
                ? [
                    {
                      path: rel,
                      change: status[file.status],
                      // The team's result is every member's: the card says whose it is.
                      ...(of.agentId === TEAM_WORKTREE ? {} : { by: of.name }),
                      ...(many ? { folder: basename(f.cwd) } : {}),
                    },
                  ]
                : [];
            }),
          ),
      );
      outcomes.push({ rule: 'paths', status: findings.length ? 'failed' : 'passed', ...(findings.length ? { findings } : {}) });
    }
    if (list.commitPattern) {
      const reason = of.agentId === TEAM_WORKTREE ? t().checksCommitsTeam : t().checksCommitsParallel;
      outcomes.push({ rule: 'commits', status: 'na', reason });
    }
    // The apps in this result, as the run's own result checked them (in the worktree, not applied yet):
    // this card becomes the latest, so it says so too.
    if (list.previewApp) {
      const ran = conv.messages.findLast((m) => m.checks && m.checks.when !== 'apply' && !m.checks.historical)?.checks;
      const mine = (ran?.appReplies ?? ran?.replyIds ?? []).filter((id) => {
        const reply = conv.messages.find((m) => m.id === id);
        return of.agentId === TEAM_WORKTREE || (reply?.author.kind === 'agent' && reply.author.agentId === of.agentId);
      });
      outcomes.push(this.previewOutcome(conv, mine));
    }
    const commands = list.commands ?? [];
    const windows = this.checkCommandDeps.platform === 'win32';
    const msg = this.postChecks(
      conv,
      checksResult(
        [
          ...outcomes,
          ...commands.map((c) =>
            windows
              ? { ...this.commandPending(c), status: 'error' as const, reason: t().checksCommandWindows, notRun: 'platform' as const }
              : this.commandPending(c),
          ),
        ],
        { when: 'apply', applyOf: of, checkedAt: started, durationMs: Date.now() - started },
      ),
    );
    if (!commands.length || windows) return msg;
    let why: string | undefined;
    // What the result changes that the commands read: they wait for the user's confirmation.
    const gate = confirm ? [] : await this.configChangesIn(conv, span, commands).catch((err: Error) => ((why = err.message), []));
    if (gate.length) {
      await this.runResultCommands(conv, msg, commands, { signal, startedAt: started, gate: { files: gate, unattended: false } });
      return msg;
    }
    const trees = join(checkTreesDir(), `${conv.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
    const made: { root: string; path: string }[] = [];
    try {
      if (why) throw new Error(why);
      const paths = new Map<string, string>();
      for (const root of [...new Set(folders.map((f) => f.root))]) {
        const path = join(trees, String(paths.size));
        await addCheckTree(root, path, (await snapshot(root, this.snapshotExcludes())).commit);
        made.push({ root, path });
        const patch = checked.find((p) => p.root === root);
        if (patch) await applyPatchIn(path, patch);
        linkDependencies(root, path, this.snapshotExcludes());
        paths.set(root, path);
      }
      const cwds = folders.map((f) => worktreeCwd(f.root, f.cwd, paths.get(f.root)!));
      const copies = folders.map((f, i) => ({ userCwd: f.cwd, cwd: cwds[i]! }));
      // In the sandbox whenever it starts here; with full access and none, as the agents run.
      const sandboxed = conv.settings.permission !== 'full' || (await this.checkCommandDeps.sandboxAvailable()).ok;
      await this.runResultCommands(conv, msg, commands, {
        signal,
        startedAt: started,
        cwds,
        mapCommand: (command) => mapCheckFolder(command, copies),
        as: sandboxed ? 'edit' : 'full',
      });
    } catch (err) {
      why = (err as Error).message;
    } finally {
      this.settleCommands(conv, msg, started, why);
      for (const t of made) await removeWorktree(t.root, t.path).catch(() => undefined);
      rmSync(trees, { recursive: true, force: true });
    }
    return msg;
  }

  /**
   * An agent's worktrees of the repositories the conversation's working directories are in now. One
   * of a folder taken off the list stays until the next parallel run removes it, but is neither
   * applied nor shown.
   */
  private async currentWorktrees(conv: Conversation, agentId: string): Promise<AgentWorktree[]> {
    const worktrees = conv.worktrees[agentId] ?? [];
    if (!worktrees.length) return [];
    const roots = new Set(
      await Promise.all(
        cwdsOf(conv.settings).map((cwd) =>
          repoRoot(cwd).catch((err) => {
            if (err instanceof HttpError && err.code === GIT_MISSING) throw err;
            return null;
          }),
        ),
      ),
    );
    return worktrees.filter((w) => roots.has(w.root));
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
    if (!wts.length) throw new HttpError(404, agentId === TEAM_WORKTREE ? t().noTeamWorktree : t().noWorktree);
    return this.diffs(await Promise.all(wts.map(async (w) => ({ root: w.root, base: w.base, head: await worktreeHead(w.path) }))));
  }

  private activity(convId: string, msg: ChatMessage, e: AgentEvent): void {
    switch (e.type) {
      case 'thinking': {
        const last = msg.parts.at(-1);
        if (last?.type === 'thinking') {
          last.text += e.text;
          this.hub.emit(convId, { type: 'delta', messageId: msg.id, partIndex: msg.parts.length - 1, text: e.text });
          break;
        }
        msg.parts.push({ type: 'thinking', text: e.text });
        this.hub.emit(convId, { type: 'message', message: msg });
        break;
      }
      case 'plan': {
        const part = msg.parts.find((p) => p.type === 'plan');
        if (part) part.entries = e.entries;
        else msg.parts.push({ type: 'plan', entries: e.entries });
        this.hub.emit(convId, { type: 'message', message: msg });
        break;
      }
      case 'tool_start': {
        // A CLI that tells the same call again (a subagent's start, then its name) updates it in place.
        const known = msg.parts.find((p) => p.type === 'tool' && p.id === e.id);
        if (known?.type === 'tool') {
          if (e.detail) known.detail = e.detail;
          if (e.agent) known.agent = e.agent;
          if (e.model) known.model = e.model;
          // A call the CLI says only now was a subagent's (Copilot's runtime events come after its call).
          if (e.parentId && !known.parentId && e.parentId !== known.id) known.parentId = e.parentId;
          this.hub.emit(convId, { type: 'message', message: msg });
          break;
        }
        msg.parts.push({
          type: 'tool',
          id: e.id,
          name: e.name,
          detail: e.detail,
          ...(e.kind ? { kind: e.kind } : {}),
          status: 'running',
          ...(e.parentId ? { parentId: e.parentId } : {}),
          ...(e.agent ? { agent: e.agent } : {}),
          ...(e.model ? { model: e.model } : {}),
        });
        this.hub.emit(convId, { type: 'message', message: msg });
        break;
      }
      case 'notice':
        msg.parts.push({ type: 'notice', text: e.text });
        this.hub.emit(convId, { type: 'message', message: msg });
        break;
      case 'tool_end': {
        const part = msg.parts.find((p) => p.type === 'tool' && p.id === e.id);
        if (part?.type === 'tool') {
          part.status = e.ok ? 'done' : 'error';
          if (e.detail) part.detail = e.detail;
          if (e.error) part.error = e.error;
          if (e.output) part.output = e.output;
          this.hub.emit(convId, { type: 'message', message: msg });
        }
        break;
      }
      default:
        return;
    }
    this.store.saveMessage(convId, msg);
  }

  private pinPlanModels(ctx: PlannerContext, agents: AgentConfig[]): AgentConfig[] {
    return agents.map((a) => {
      const model = assignmentModel(ctx, a);
      return model && !a.model ? { ...a, model } : a;
    });
  }

  /** Check each distinct assignment once per design. Failed choices can only be replaced by checked ones. */
  private async checkTeam(
    conv: Conversation,
    run: Run,
    msg: ChatMessage,
    ctx: PlannerContext,
    lead: LeadAgentSettings,
    decision: PlanDecision,
    usage: RunResult[],
    replace = true,
  ): Promise<PlanDecision> {
    const signal = AbortSignal.any([run.abort.signal, AbortSignal.timeout(60_000)]);
    const failedModels = new Set<string>();
    const checks = new Map<string, Promise<boolean>>();
    let agents = this.pinPlanModels(ctx, decision.agents);
    let replaced = false;
    let failed: AgentConfig[] = [];
    const verify = async (a: AgentConfig): Promise<boolean> => {
      const id = randomUUID();
      const label = `${PROVIDER_LABEL[a.provider]} · ${assignmentModel(ctx, a) || t().planModelDefault}`;
      this.activity(conv.id, msg, { type: 'tool_start', id, name: t().planCheckModel, detail: label });
      let ok = false;
      try {
        const account = this.settings.resolveAccount(a.provider, a.account);
        const result = await checkModel(runners[a.provider], {
          bin: this.settings.bin(a.provider),
          env: this.settings.env(a.provider, account),
          backends: this.settings.backendsFor(a.provider),
          permission: conv.settings.permission === 'full' ? 'full' : 'read-only',
          sandboxTerminal: this.settings.sandboxTerminal(a.provider),
          model: await this.modelFor(a.provider, a.model, account),
          signal,
        });
        ok = result.ok;
        if (result.usage) usage.push(result.usage);
      } catch {
        // A failed setup counts like a failed request. Let the other checks settle before fitting again.
      }
      this.activity(conv.id, msg, { type: 'tool_end', id, ok, ...(ok ? {} : { error: t().planModelNoReply }) });
      return ok;
    };
    // A ceiling on both time and retries keeps a broken backend from running through every model.
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      const results = await Promise.all(
        agents.map((a) => {
          const key = assignmentKey(ctx, a);
          let check = checks.get(key);
          if (!check) {
            check = verify(a);
            checks.set(key, check);
          }
          return check;
        }),
      );
      run.abort.signal.throwIfAborted();
      failed = agents.filter((_, i) => !results[i]);
      if (!failed.length) {
        if (!replaced) return { ...decision, agents };
        const kept = decision.source === 'kept';
        const reason = [kept ? '' : decision.reason, t().planAssignmentsAdjusted].filter(Boolean).join(' ');
        return { ...decision, ...(kept ? { source: 'fallback' as const, fallback: {} } : {}), agents, reason };
      }
      for (const a of failed) failedModels.add(assignmentKey(ctx, a));
      if (!replace || attempt === 2 || signal.aborted) break;
      try {
        agents = this.pinPlanModels(
          ctx,
          fitAgents(agents, { ...ctx, staffing: { ...ctx.staffing!, failedModels } }, lead, undefined, false),
        );
        replaced = true;
      } catch (err) {
        if (!(err instanceof PlanUnavailableError)) throw err;
        break;
      }
    }
    throw new PlanUnavailableError(
      t().planModelChecksFailed(failed.map((a) => `@${a.name} (${assignmentModel(ctx, a) ?? PROVIDER_LABEL[a.provider]})`).join(', ')),
    );
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
    const fileNames =
      run.designFor !== undefined
        ? (conv.schedule?.attachments ?? []).map((p) => p.name)
        : asked.flatMap((m) => attachmentsOf(m).map((p) => p.name));
    // A design for the schedule is for its message, which nobody posted.
    const question =
      (run.designFor ?? asked.map(textOf).filter(Boolean).join('\n\n')) +
      (fileNames.length ? `\n\n(Attached files: ${fileNames.join(', ')})` : '');
    const current: PlanConversation['current'] = conv.agents.length
      ? { agents: conv.agents, settings: { mode: conv.settings.mode, rounds: conv.settings.rounds, maxHops: conv.settings.maxHops } }
      : undefined;
    const history = historyForLead(conv.messages.slice(0, since));
    const started = Date.now();
    let ctx: PlannerContext | undefined;
    let reply = '';
    let failure: string | undefined;
    let decision: PlanDecision | undefined;
    let result: RunResult | undefined;
    const checks: RunResult[] = [];
    const discovery = randomUUID();
    this.activity(conv.id, msg, { type: 'tool_start', id: discovery, name: t().planCheckAccounts });
    try {
      ctx = await this.planner.context(conv.settings.cwd, conv.settings.extraCwds, true);
      this.activity(conv.id, msg, { type: 'tool_end', id: discovery, ok: true });
      run.abort.signal.throwIfAborted();
      if (!memberAvailable(ctx, lead)) msg.plan!.leadUnavailable = true;
      if (ctx.staffing && !ctx.available.length) throw new PlanUnavailableError(t().planNoAvailableModel(run.designFor !== undefined));
      if (msg.plan!.leadUnavailable) throw new Error(t().planLeadUnavailable);
      const leadRun = runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider, lead.account),
        backends: this.settings.backendsFor(lead.provider),
        ...this.settings.runNative(lead.provider, lead.account, 'read-only'),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: buildPlannerPrompt(question, conv.settings, ctx, {
          history,
          current,
          ...(run.designFor !== undefined ? { schedule: { newChat: Boolean(conv.schedule?.newChat) } } : {}),
        }),
        systemPrompt: PLANNER_BRIEFING,
        outputSchema: PLAN_SCHEMA,
        cwd: conv.settings.cwd,
        permission: 'read-only',
        stateKey: stateKeys.lead(conv.id),
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal: run.abort.signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
          else this.activity(conv.id, msg, e);
        },
      });
      result = await leadRun.catch((err: unknown) => {
        if (!run.abort.signal.aborted) msg.plan!.leadUnavailable = true;
        throw err;
      });
      // The lead agent's session belongs to this conversation too.
      if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
      decision = decidePlan(leadReply(reply, result.structured), ctx, lead, current);
    } catch (err) {
      if (!run.abort.signal.aborted) {
        console.warn('[orchestrator] team design failed:', (err as Error).message);
        failure = (err as Error).message;
        if (ctx && !(err instanceof PlanUnavailableError)) {
          try {
            // What the lead answered: its text, or the structured answer its CLI gave.
            const raw = reply.trim() || (result?.structured !== undefined ? JSON.stringify(result.structured) : '');
            const diagnostic = raw && raw !== failure ? `${failure}\n\n${raw}` : failure;
            decision = fallbackPlan(ctx, lead, diagnostic, current);
          } catch (fallbackError) {
            failure = (fallbackError as Error).message;
          }
        }
      }
    }

    const checkOnConfirm = Boolean(ctx?.staffing && conv.settings.permission === 'full' && !conv.settings.autoConfirm);
    if (decision && ctx?.staffing && !checkOnConfirm && !run.abort.signal.aborted) {
      try {
        decision = await this.checkTeam(conv, run, msg, ctx, lead, decision, checks);
      } catch (err) {
        decision = undefined;
        failure = (err as Error).message;
      }
    }
    for (const p of msg.parts) if (p.type === 'tool' && p.status === 'running') p.status = 'error';
    const usage = (key: 'costUsd' | 'inputTokens' | 'outputTokens') =>
      [result, ...checks].reduce<number | undefined>((total, r) => (r?.[key] === undefined ? total : (total ?? 0) + r[key]), undefined);
    msg.meta = {
      durationMs: Date.now() - started,
      costUsd: usage('costUsd'),
      inputTokens: usage('inputTokens'),
      outputTokens: usage('outputTokens'),
    };
    if (run.abort.signal.aborted) {
      msg.status = 'aborted';
    } else if (!decision) {
      msg.plan = { ...msg.plan!, status: 'failed', reason: failure };
      msg.status = 'done';
    } else {
      // Members who stay on keep their ids, and with them their sessions.
      const proposed = checkOnConfirm && ctx ? this.pinPlanModels(ctx, decision.agents) : decision.agents;
      const agents = keepMemberIds(proposed, conv.agents, !ctx?.staffing);
      const now = Boolean(conv.settings.autoConfirm);
      msg.plan = {
        ...msg.plan!,
        status: 'ready',
        ...decision,
        agents,
        ...(now ? { confirmedAt: Date.now(), autoConfirmed: true } : { awaitingConfirmation: true }),
        ...(checkOnConfirm ? { checkOnConfirm: true } : {}),
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
   * read-only, as the last step of the team's run: Stop stops it, and so does a message the user sends
   * meanwhile, which goes at once. A review that fails or is stopped says so on its card; the next one
   * reads these replies again.
   */
  private async reviewReplies(conv: Conversation, run: Run): Promise<void> {
    const material = reviewMaterial(conv.messages);
    if (!material.replies.length) return;
    const lead = this.settings.lead;
    const replyIds = material.replies.map((m) => m.id);
    // In parallel mode with write access, what each member changed is in its own worktrees until it is
    // applied: the lead is told where, and may read them, as it may the other working directories.
    // In the team's own worktrees likewise: what it changed is there.
    const worktrees = run.ws.isolated && !run.ws.team ? this.reviewWorktrees(conv, run, material.replies) : [];
    const team = run.ws.team ? this.teamDirs(conv, run.ws.folders ?? []).map((f) => f.cwd) : [];
    const addDirs = [...(conv.settings.extraCwds ?? []), ...worktrees.flatMap((w) => w.dirs), ...team];
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
    // Stop stops it with the run; switching lead review off stops it alone.
    run.reviewAbort = new AbortController();
    const signal = AbortSignal.any([run.abort.signal, run.reviewAbort.signal]);
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
        ...this.settings.runNative(lead.provider, lead.account, 'read-only'),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: buildReviewPrompt(material, conv.agents, conv.settings, worktrees, team),
        systemPrompt: REVIEWER_BRIEFING,
        outputSchema: REVIEW_SCHEMA,
        cwd: conv.settings.cwd,
        ...(addDirs.length ? { addDirs } : {}),
        permission: 'read-only',
        stateKey: stateKeys.review(conv.id),
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
      // The lead agent's session belongs to this conversation too.
      if (result.sessionId) this.linkSession(conv, lead.provider, result.sessionId);
      review = parseReviewReply(reply, material.replies, result.structured);
    } catch (err) {
      if (!signal.aborted) {
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
    if (signal.aborted) {
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
   * Each working directory (`folders`) as the team has it in its own worktrees, with the worktree's
   * path as its repository root: none when one of them has no worktree there (they are made before the
   * first turn of a run that works in them, `prepareTeamWorktrees`), or it is marked for a reset.
   */
  private teamDirs(conv: Conversation, folders: { cwd: string; root: string }[]): { cwd: string; root: string }[] {
    const own = conv.worktrees[TEAM_WORKTREE] ?? [];
    const out: { cwd: string; root: string }[] = [];
    for (const f of folders) {
      const wt = own.find((w) => w.root === f.root && !w.needsReset);
      if (!wt || !existsSync(wt.path)) return [];
      out.push({ cwd: worktreeCwd(f.root, f.cwd, wt.path), root: wt.path });
    }
    return out;
  }

  // Team checks ---------------------------------------------------------------

  /** Where team checks look: the working directories with their repositories, never in the CLIs' homes. */
  private checkFolders(folders: { cwd: string; root: string }[], isolated: boolean, team = false): CheckFolders {
    return { folders, exclude: this.snapshotExcludes(), commits: !isolated, ...(team ? { team } : {}) };
  }

  /** The conversation's working directories now, each with the root of its repository (itself when it is in none). */
  private async foldersNow(conv: Conversation): Promise<{ cwd: string; root: string }[]> {
    return Promise.all(cwdsOf(conv.settings).map(async (cwd) => ({ cwd, root: (await repoRoot(cwd).catch(() => null)) ?? cwd })));
  }

  /**
   * What the members changed in their worktrees so far (parallel mode), as paths in the working
   * directories: what applying their results would bring. A worktree whose result was applied is left
   * out: what it brought is in the working directory, where the checks look anyway.
   */
  private async worktreeChanges(conv: Conversation, folders: { cwd: string; root: string }[]): Promise<WorktreeChange[]> {
    const out: WorktreeChange[] = [];
    const status = { A: 'added', M: 'changed', D: 'removed' } as const;
    for (const agentId of Object.keys(conv.worktrees)) {
      // The team's own are checked where they are (`teamDirs`), when it works there.
      if (agentId === TEAM_WORKTREE) continue;
      const by = conv.agents.find((a) => a.id === agentId)?.name ?? agentId;
      for (const wt of await this.currentWorktrees(conv, agentId)) {
        if (wt.needsReset) continue;
        const files = await diffFiles(wt.root, wt.base, await worktreeHead(wt.path));
        for (const folder of folders.filter((f) => f.root === wt.root)) {
          for (const f of files) {
            const rel = relative(folder.cwd, join(wt.root, f.path));
            if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
            out.push({ cwd: folder.cwd, path: rel.split(sep).join('/'), change: status[f.status], by });
          }
        }
      }
    }
    return out;
  }

  /**
   * Every rule of the conversation's list, as one that could not be checked (`why`): never a pass. Its
   * commands too, unless the caller posts them itself (`withCommands` false).
   */
  private unchecked(conv: Conversation, why: string, withCommands = true): CheckOutcome[] {
    const list = conv.settings.checks;
    const rules: CheckOutcome['rule'][] = [
      ...(protectedPatterns(list).length ? ['paths' as const] : []),
      ...(list?.commitPattern ? ['commits' as const] : []),
      ...(list?.previewApp ? ['preview' as const] : []),
    ];
    return [
      ...rules.map((rule) => ({ rule, status: 'error' as const, reason: why })),
      ...(withCommands ? (list?.commands ?? []) : []).map((c) => ({
        rule: 'command' as const,
        status: 'error' as const,
        commandId: c.id,
        command: c.run,
        reason: why,
      })),
    ];
  }

  /** A command's outcome before it has run: running, or not run (`status`, why). */
  private commandPending(cmd: CheckCommand, status: 'running' | 'na' = 'running', reason?: string): CheckOutcome {
    return { rule: 'command', status, commandId: cmd.id, command: cmd.run, ...(reason ? { reason } : {}) };
  }

  /** A team checks result's message, changed: shown and saved again. */
  private updateChecks(conv: Conversation, msg: ChatMessage, outcomes: CheckOutcome[], startedAt: number): void {
    msg.checks = { ...msg.checks!, outcomes, status: overallStatus(outcomes), durationMs: Date.now() - startedAt };
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);
  }

  /**
   * The files a run changed that the checks' commands read (`checkConfigFiles()`): test and lint
   * configuration, the files a command line names (from the folder it runs in), and `package.json` when
   * its scripts or the test and lint settings in it changed. Compared as full paths (links resolved),
   * shown relative to the first working directory when they are in it.
   */
  private async changedCheckConfig(conv: Conversation, replies: ChatMessage[], commands: CheckCommand[]): Promise<string[]> {
    const span = new Map<string, { base: string; head: string; files: Set<string> }>();
    for (const m of replies) {
      for (const c of m.changes ?? []) {
        if (c.isolated) continue;
        const s = span.get(c.root) ?? { base: c.base, head: c.head, files: new Set<string>() };
        s.head = c.head;
        for (const f of c.files) s.files.add(f.path);
        span.set(c.root, s);
      }
    }
    return this.configChangesIn(conv, span, commands);
  }

  /** `changedCheckConfig()` for the changes base..head of each repository (`span`, files relative to its root). */
  private async configChangesIn(
    conv: Conversation,
    span: Map<string, { base: string; head: string; files: Set<string> }>,
    commands: CheckCommand[],
  ): Promise<string[]> {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const cwds = cwdsOf(conv.settings);
    const first = real(cwds[0]!);
    const named = new Set(commands.flatMap((c) => namedFiles(c.run, real(commandCwd(c, cwds) ?? cwds[0]!))));
    const shown = (abs: string) => relativeInside(first, abs) ?? abs;
    const out: string[] = [];
    for (const [root, s] of span) {
      const paths = [...s.files].map((p) => ({ p, abs: join(real(root), ...p.split('/')) }));
      out.push(
        ...checkConfigFiles(
          paths.map((x) => x.abs),
          named,
        ).map(shown),
      );
      for (const { p, abs } of paths) {
        if (basename(p) !== 'package.json') continue;
        const read = async (commit: string) => {
          try {
            const json = JSON.parse((await fileAt(root, commit, p)) ?? '{}') as Record<string, unknown>;
            return PACKAGE_JSON_KEYS.map((k) => json[k]);
          } catch {
            return ['unreadable'];
          }
        };
        if (!isDeepStrictEqual(await read(s.base), await read(s.head))) out.push(shown(abs));
      }
    }
    return [...new Set(out)];
  }

  /**
   * Where the team checks' commands run, and what they may not reach (`runCheckCommand()`), with the
   * conversation's permission, or the one Team settings is being changed to (Try it).
   */
  private commandPlace(conv: Conversation, signal: AbortSignal, permission: Permission = conv.settings.permission): CheckCommandPlace {
    const unsandboxed = permission === 'full';
    return {
      cwds: cwdsOf(conv.settings),
      unsandboxed,
      protectedPaths: unsandboxed ? [] : protectedReads(),
      privateRoots: unsandboxed ? [] : privateRoots(this.settings.openAgentHome('opencode'), undefined, this.settings.openAgentRoots()),
      signal,
    };
  }

  /**
   * A member's turn's hooks (`turnHooks()`), in a run that may write, on a system that runs commands:
   * where its CLI can run them (`HOOK_PROVIDERS`); on another CLI none, with a note in the reply. They run
   * in the turn's own working directories (its worktrees in parallel mode, the team's when it has them),
   * as the commands do.
   */
  private turnHooksOf(
    conv: Conversation,
    agent: AgentConfig,
    cwds: string[],
    workspace: BriefingWorkspace,
    signal: AbortSignal,
    notice: (text: string) => void,
  ): TurnHooks | undefined {
    const list = conv.settings.checks?.hooks;
    if (!list?.length || conv.settings.permission === 'read-only' || this.checkCommandDeps.platform === 'win32') return undefined;
    if (!HOOK_PROVIDERS.includes(agent.provider)) {
      notice(t().hooksUnsupported(PROVIDER_LABEL[agent.provider]));
      return undefined;
    }
    const place = { ...this.commandPlace(conv, signal), cwds };
    const gateway = this.gateway;
    const hooks = workspace.kind !== 'shared' ? list.map((hook) => mapCheckFolder(hook, workspace.folders)) : list;
    return turnHooks(hooks, {
      place,
      agent: agent.name,
      provider: agent.provider,
      notice,
      ...(gateway ? { program: gateway.hookProgram.bind(gateway) } : {}),
      deps: this.checkCommandDeps,
    });
  }

  /**
   * A result's commands still running once they can run no more (an error, Stop): could not run, with
   * why. A card never stays "checking" with nothing left to finish it.
   */
  private settleCommands(conv: Conversation, msg: ChatMessage, startedAt: number, why?: string): void {
    if (!msg.checks?.outcomes.some((o) => o.status === 'running')) return;
    // No error: they were stopped, which says nothing of the team's work.
    const settled = why ? { reason: why } : { reason: t().stoppedNote, notRun: 'stopped' as const };
    const outcomes = msg.checks.outcomes.map((o) => (o.status === 'running' ? { ...o, status: 'error' as const, ...settled } : o));
    this.updateChecks(conv, msg, outcomes, startedAt);
  }

  /**
   * What the commands were last kept from running for (a run changed what they read): the latest result
   * whose commands ran or were held back says, unless the user skipped it. A result in between that ran
   * none (the team stopped to ask, Check again in parallel mode or read-only, the commands stopped)
   * carries it on, so only the user's confirmation (Check again with `confirm`, which runs them) or Skip
   * ends it.
   */
  private heldGate(conv: Conversation): string[] {
    // A card that ran none but shows the gate it carries on counts too: skipping it ends the gate.
    const last = conv.messages.findLast(
      (m) =>
        m.checks &&
        !m.checks.historical &&
        m.checks.outcomes.some((o) => o.rule === 'command' && ((o.status !== 'na' && !o.notRun) || Boolean(o.configChanged?.length))),
    );
    if (!last?.checks || last.checks.skippedAt) return [];
    return [...new Set(last.checks.outcomes.flatMap((o) => o.configChanged ?? []))];
  }

  /**
   * Run a result's commands one after another, its card saying how each went as it goes (`gate`: none
   * is run, as the run changed what they read: could not run, or failed in a run nobody watched). What
   * each command changed in the working directories (not ignored by git) is said with it. Stopped, the
   * commands not run yet say so.
   */
  private async runResultCommands(
    conv: Conversation,
    msg: ChatMessage,
    commands: CheckCommand[],
    o: {
      signal: AbortSignal;
      startedAt: number;
      gate?: { files: string[]; unattended: boolean };
      /** Where they run instead of the working directories (a check tree's), and each command as it runs there. */
      cwds?: string[];
      /** The permission they run with, instead of the conversation's (in the sandbox below full access). */
      as?: Permission;
      mapCommand?: (c: CheckCommand) => CheckCommand;
    },
  ): Promise<void> {
    const set = (outcome: CheckOutcome) => {
      const outcomes = msg.checks!.outcomes.map((x) => (x.rule === 'command' && x.commandId === outcome.commandId ? outcome : x));
      this.updateChecks(conv, msg, outcomes, o.startedAt);
    };
    if (o.gate?.files.length) {
      const files = o.gate.files.join(', ');
      for (const c of commands) {
        set({
          ...this.commandPending(c),
          status: o.gate.unattended ? 'failed' : 'error',
          reason: o.gate.unattended ? t().checksConfigChangedUnattended(files) : t().checksConfigChanged(files),
          configChanged: o.gate.files,
        });
      }
      return;
    }
    const place = { ...this.commandPlace(conv, o.signal, o.as), ...(o.cwds ? { cwds: o.cwds } : {}) };
    const roots = [...new Set(await Promise.all(place.cwds.map(async (cwd) => (await repoRoot(cwd).catch(() => null)) ?? cwd)))];
    const snap = async () => {
      const out = new Map<string, string>();
      for (const root of roots) {
        try {
          out.set(root, (await snapshot(root, this.snapshotExcludes())).commit);
        } catch {
          /* not a repository, or git failed: what it wrote is not said */
        }
      }
      return out;
    };
    const labels = folderLabels(roots);
    for (const c of commands) {
      if (o.signal.aborted) break;
      const before = await snap();
      const outcome = { ...(await runCheckCommand(o.mapCommand ? o.mapCommand(c) : c, place, this.checkCommandDeps)), command: c.run };
      const wrote: string[] = [];
      for (const [root, commit] of await snap()) {
        const was = before.get(root);
        if (!was || was === commit) continue;
        try {
          for (const f of await diffFiles(root, was, commit)) wrote.push(roots.length > 1 ? `${labels.get(root)}/${f.path}` : f.path);
        } catch {
          /* as above */
        }
      }
      set({ ...outcome, ...(wrote.length ? { wroteFiles: wrote.slice(0, 20) } : {}) });
    }
    if (o.signal.aborted) {
      for (const c of commands) {
        const now = msg.checks!.outcomes.find((x) => x.rule === 'command' && x.commandId === c.id);
        if (now?.status === 'running') set({ ...now, status: 'error', reason: t().stoppedNote, notRun: 'stopped' });
      }
    }
  }

  /** Post a team checks result after the team's replies. */
  private postChecks(conv: Conversation, checks: ChecksResult): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), author: { kind: 'system' }, createdAt: Date.now(), parts: [], status: 'done', checks };
    conv.messages.push(msg);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);
    return msg;
  }

  /** The current pause's unfinished checks, using the latest baseline after an interrupted recheck. */
  private pendingPauseChecks(conv: Conversation): ChatMessage | undefined {
    const latest = latestChecks(conv.messages);
    const checks = latest?.checks;
    if (!checks || checks.skippedAt) return undefined;
    const question = conv.messages.findLast((m) => m.author.kind === 'agent' && m.asked);
    if (!question || !checks.replyIds?.includes(question.id)) return undefined;
    if (checks.when === 'pause') return latest;
    if (
      checks.when !== 'recheck' ||
      !checks.outcomes.some((o) => o.rule === 'command' && (o.notRun === 'stopped' || o.notRun === 'interrupted'))
    ) {
      return undefined;
    }
    const paused = conv.messages.findLast(
      (m) => m.checks?.when === 'pause' && !m.checks.historical && isDeepStrictEqual(m.checks.replyIds, checks.replyIds),
    );
    return paused && !paused.checks?.skippedAt ? latest : undefined;
  }

  /**
   * Before the first turn of a run that may write (edit or full access), in a conversation with team
   * checks: where its folders stand (`RunCheck.start`). While the latest result has not passed and the
   * user has not gone on without it, the run is checked from where that result's run started, so that
   * what it puts back passes. One that cannot start says so in the run's card.
   */
  private async startChecks(conv: Conversation, run: Run): Promise<void> {
    const list = conv.settings.checks;
    if (!hasChecks(list) || !run.ws.folders?.length) return;
    const previous = run.pausedChecks ?? checksHold(conv.messages);
    let carried = previous ? this.store.checksBaseline<StoredBaseline>(conv.id, previous.id) : undefined;
    // In the team's own worktrees when it works there: what it changes is there, and what another
    // conversation writes in the working directories meanwhile is not the team's.
    const folders = run.ws.team ? this.teamDirs(conv, run.ws.folders) : run.ws.folders;
    // A result that did not pass in the working directories is checked in their copies, from where it began.
    if (carried && run.ws.team && folders.length) {
      carried = baselineIn(
        carried,
        run.ws.folders.map((f, i) => ({ from: f.cwd, to: folders[i]!.cwd })),
      );
    }
    try {
      if (!folders.length) throw new Error(t().noTeamWorktree);
      run.checks = await RunCheck.start(list, this.checkFolders(folders, run.ws.isolated, run.ws.team), this.clock(), carried);
    } catch (err) {
      run.checksError = (err as Error).message;
    }
  }

  /**
   * Once the team has answered, or stopped to ask the user something: check its work and post the
   * result after its replies, when the run changed anything the checks cover (files, protected files,
   * commits); nothing after Stop, nor for a conversation being deleted. One that did not pass in a run
   * nobody watches is the schedule's failure. The run still holds its folders: nothing else writes there
   * while they are checked.
   */
  private async finishChecks(conv: Conversation, run: Run): Promise<void> {
    if ((!run.checks && !run.checksError) || run.abort.signal.aborted || this.closing) return;
    if (this.deleting.has(conv.id) || this.store.get(conv.id) !== conv) return;
    const replies = conv.messages.slice(run.from).filter((m) => m.author.kind === 'agent');
    const started = Date.now();
    let outcomes: CheckOutcome[];
    let touched = true;
    try {
      if (!run.checks) throw new Error(run.checksError);
      // The team's own worktrees are where its checks look already.
      const worktrees = run.ws.isolated && !run.ws.team ? await this.worktreeChanges(conv, run.ws.folders ?? []) : [];
      ({ outcomes, touched } = await run.checks.finish(worktrees));
    } catch (err) {
      // The commands are posted below when they can run; when the checks could not start, as these.
      outcomes = this.unchecked(conv, (err as Error).message, !run.checks);
    }
    // The app the team built opens in a preview: from the files its turns changed, whatever else could be checked.
    let appReplies: string[] | undefined;
    if (conv.settings.checks?.previewApp) {
      appReplies = this.appReplies(conv, [...(run.pausedChecks?.checks?.replyIds ?? []), ...replies.map((m) => m.id)]);
      outcomes = [...outcomes.filter((o) => o.rule !== 'preview'), this.previewOutcome(conv, appReplies)];
    }
    if (!run.pausedChecks && !touched && !replies.some((m) => m.changes?.some((c) => c.files.length))) return;
    // Commands the latest result was kept from running for stay kept from it until the user confirms
    // or skips it: a later run that did not touch the settings again does not run them unconfirmed.
    const carried = this.heldGate(conv);
    // Commands once the team has finished, in the working directories: not when it stopped to ask the
    // user something, nor in parallel mode, whose results are in the members' worktrees, nor in the
    // team's own: they run when the result is applied.
    const commands = run.checks ? (conv.settings.checks?.commands ?? []) : [];
    // Only the app preview to check, and no turn made an app: nothing to say (unless a failure waits, which this passes).
    if (!commands.length && outcomes.every((o) => o.rule === 'preview' && o.status === 'na') && !checksHold(conv.messages)) return;
    const skipped = conv.pause
      ? t().checksCommandsAtEnd
      : run.ws.team
        ? t().checksCommandsTeam
        : run.ws.isolated
          ? t().checksCommandsParallel
          : undefined;
    let why: string | undefined;
    let changed: string[] = [];
    if (commands.length && !run.ws.isolated) {
      try {
        changed = await this.changedCheckConfig(conv, replies, commands);
      } catch (err) {
        why = (err as Error).message;
      }
    }
    const files = [...new Set([...carried, ...changed])];
    const msg = this.postChecks(
      conv,
      checksResult(
        [
          ...outcomes,
          // The command waits until the team is done, but the confirmation requirement is recorded now.
          ...commands.map((c) => ({
            ...this.commandPending(c, skipped ? 'na' : 'running', skipped),
            ...(conv.pause && files.length ? { configChanged: files } : {}),
          })),
        ],
        {
          when: conv.pause ? 'pause' : 'run',
          replyIds: [...(run.pausedChecks?.checks?.replyIds ?? []), ...replies.map((m) => m.id)],
          checkedAt: started,
          durationMs: Date.now() - started,
          ...(appReplies ? { appReplies } : {}),
          ...(run.autoFix ? { autoFixes: run.autoFix } : {}),
        },
      ),
    );
    if (run.checks) this.store.saveChecksBaseline(conv.id, msg.id, run.checks.baseline);
    if (commands.length && !skipped) {
      try {
        if (!why) {
          await this.runResultCommands(conv, msg, commands, {
            signal: run.abort.signal,
            startedAt: started,
            ...(files.length ? { gate: { files, unattended: Boolean(run.unattended) } } : {}),
          });
        }
      } catch (err) {
        why = (err as Error).message;
      } finally {
        this.settleCommands(conv, msg, started, why);
      }
    }
    // Not for commands stopped (the server shutting down, say), which say nothing of the team's work.
    if (run.unattended && msg.checks!.outcomes.some(blocking)) this.scheduleChecksFailed(run.unattended, conv, msg.checks!);
    // It goes back to the team by itself, as the card's button would send it (not to ask the user, not
    // in a run nobody watches, not once stopped), until it has been sent back too many times in a row.
    const result = msg.checks!;
    const before = run.autoFix ?? 0;
    if (
      conv.settings.checks?.autoFix &&
      result.outcomes.some((o) => o.status === 'failed' && needsFix(o)) &&
      !this.userWaits(conv) &&
      !conv.pause &&
      !run.unattended &&
      !run.abort.signal.aborted &&
      before < CHECK_LIMITS.autoFixes
    ) {
      const fixer = this.fixer(conv, result, replies);
      if (fixer) run.autoFixNext = { messageId: msg.id, agentId: fixer.id, attempt: before + 1 };
    }
  }

  /** One of the user's own messages waits in the queue: they are here, and decide what comes next. */
  private userWaits(conv: Conversation): boolean {
    return (conv.queue ?? []).some((m) => !m.scheduled);
  }

  /**
   * The replies whose apps the `preview` rule checks: these, after those of a result whose preview
   * failed and still holds the queue, so that a turn touching none of that app's files does not pass it.
   */
  private appReplies(conv: Conversation, replyIds: readonly string[]): string[] {
    const held = checksHold(conv.messages)?.checks;
    const carried = held?.outcomes.some((o) => o.rule === 'preview' && blocking(o)) ? (held.appReplies ?? held.replyIds ?? []) : [];
    return [...new Set([...carried, ...replyIds])];
  }

  /**
   * The `preview` rule's outcome (`CheckList.previewApp`) for these replies: every app their turns
   * made or changed runs as a preview does, as the files are now; nothing to check when none made one.
   */
  private previewOutcome(conv: Conversation, replyIds: readonly string[]): CheckOutcome {
    const lookup = (id: string) => this.store.get(id);
    const findings = new Map<string, CheckFinding>();
    let apps = 0;
    try {
      for (const id of replyIds) {
        const reply = conv.messages.find((m) => m.id === id);
        if (!reply?.changes?.some((c) => c.files.length)) continue;
        const found = appProblems(conv, id, lookup, this.settings);
        apps += found.apps.length;
        for (const folder of found.apps) findings.delete(folder);
        for (const problem of found.problems)
          findings.set(problem.folder, {
            path: problem.shown,
            problem: problem.reason,
            ...(reply.agentName ? { by: reply.agentName } : {}),
          });
      }
    } catch (err) {
      return { rule: 'preview', status: 'error', reason: (err as Error).message };
    }
    if (!apps) return { rule: 'preview', status: 'na', reason: t().checksPreviewNoApp };
    const all = [...findings.values()];
    const max = CHECK_RESULT_LIMITS.findings;
    return {
      rule: 'preview',
      status: all.length ? 'failed' : 'passed',
      ...(all.length ? { findings: all.slice(0, max) } : {}),
      ...(all.length > max ? { more: all.length - max } : {}),
    };
  }

  /**
   * Who fixes a result Relay sends back by itself: the member a failing finding names, else the last one
   * whose turn changed files, else the last to reply.
   */
  private fixer(conv: Conversation, result: ChecksResult, replies: readonly ChatMessage[]): AgentConfig | undefined {
    const named = result.outcomes
      .filter(needsFix)
      .flatMap((o) => o.findings ?? [])
      .map((f) => f.by)
      .find((by) => by && conv.agents.some((a) => a.name === by));
    const byName = named ? conv.agents.find((a) => a.name === named) : undefined;
    if (byName) return byName;
    const reply =
      [...replies].reverse().find((m) => m.author.kind === 'agent' && m.changes?.some((c) => c.files.length)) ??
      [...replies].reverse().find((m) => m.author.kind === 'agent');
    const id = reply?.author.kind === 'agent' ? reply.author.agentId : undefined;
    return conv.agents.find((a) => a.id === id) ?? conv.agents[0];
  }

  /**
   * The team checks did not pass, and fix themselves (`CheckList.autoFix`): the member is asked as the
   * card's button asks, its message marked as Relay's. Not when the result is no longer the latest, was
   * skipped or passes now, or a design waits: what waits in the queue starts instead.
   */
  private startAutoFix(conv: Conversation, next: NonNullable<Run['autoFixNext']>): boolean {
    const msg = conv.messages.find((m) => m.id === next.messageId);
    const agent = conv.agents.find((a) => a.id === next.agentId);
    if (
      !msg?.checks ||
      !agent ||
      !checksFailed(msg.checks) ||
      msg.checks.skippedAt ||
      latestChecks(conv.messages) !== msg ||
      conv.pause ||
      this.userWaits(conv) ||
      !this.mayStart(conv)
    )
      return this.startQueued(conv);
    void this.start(conv, t().checksAutoFixMessage(agent.name, next.attempt, CHECK_LIMITS.autoFixes), {
      only: [agent],
      keepTeam: true,
      fixChecks: msg.id,
      autoFix: next.attempt,
      beforePost: () => {
        msg.checks = { ...msg.checks!, fixBy: agent.name, fixAuto: true };
        this.hub.emit(conv.id, { type: 'message', message: msg });
        this.store.saveMessage(conv.id, msg, true);
      },
    }).catch((err: unknown) => {
      if (!(err instanceof HttpError && err.status === 404)) this.systemNote(conv, t().runFailed((err as Error).message));
      this.emitStatus(conv.id);
    });
    return true;
  }

  /**
   * Team checks did not pass in a run a schedule started that nobody watched: that is how the schedule's
   * time went (`lastResult`, `lastError`). Only its latest time, the one that started this run, here or
   * in the new chat it opened.
   */
  private scheduleChecksFailed(sourceId: string, conv: Conversation, checks: ChecksResult): void {
    const source = this.store.get(sourceId);
    const s = source?.schedule;
    if (!source || !s || this.deleting.has(source.id)) return;
    if ((s.lastResult !== 'sent' && s.lastResult !== 'queued') || (source !== conv && s.lastChatId !== conv.id)) return;
    source.schedule = {
      ...s,
      lastResult: 'failed',
      lastError: checks.status === 'error' ? t().checksScheduleError : t().checksScheduleFailed,
    };
    this.store.saveSchedule(source);
    this.emitConversation(source);
  }

  /**
   * The working directories changed after the latest team checks result (a turn changed files, a result
   * was applied): it says nothing about them as they are now. Not `except`, the result that checked what
   * was just applied.
   */
  private markChecksStale(conv: Conversation, except?: ChatMessage): void {
    const latest = latestChecks(conv.messages);
    if (!latest?.checks || latest.checks.stale || latest === except) return;
    latest.checks = { ...latest.checks, stale: true };
    this.hub.emit(conv.id, { type: 'message', message: latest });
    this.store.saveMessage(conv.id, latest, true);
  }

  /**
   * The check list of the template the lead agent's team comes from, for a conversation that has none
   * yet: once it has one (an empty one too), a new team or template leaves it as it is. Settings' default
   * as it was copied in (`fromDefault`) takes the template's rules in with its own (`mergeDefaultChecks()`);
   * a template without rules leaves it.
   */
  private templateChecks(conv: Conversation, plan: TeamPlan): Pick<ConversationSettings, 'checks'> {
    const copy = conv.settings.checks?.fromDefault ? conv.settings.checks : undefined;
    if (conv.settings.checks !== undefined && !copy) return {};
    const id = plan.presetId ?? plan.basedOn?.id;
    const checks = id ? this.store.listPresets().find((p) => p.id === id)?.settings.checks : undefined;
    if (!checks) return {};
    const { fromDefault: _copied, ...own } = structuredClone(checks);
    if (!copy) return { checks: own };
    return hasRules(own) ? { checks: mergeDefaultChecks(copy, own) } : {};
  }

  /** The conversation's latest team checks result, by its message id: another one cannot be handled. */
  private latestChecksMessage(conv: Conversation, messageId: string): ChatMessage {
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg?.checks) throw new HttpError(404, t().checksNotFound);
    if (latestChecks(conv.messages) !== msg) throw new HttpError(409, t().checksNotLatest);
    return msg;
  }

  /**
   * Check the latest result again (its card's "Check again"), from where its run started, with the list
   * and the folders as they are now: a new result after it. Its commands run after it is posted, in
   * the background (Stop stops them; what is sent meanwhile waits, as during a run), holding the
   * folders; as after a run, none in a read-only conversation, in parallel mode or while the team works
   * in its own worktrees (where the rest is checked). A command the run's
   * changes kept from running (`configChanged`) runs only once the user has confirmed (`confirm`). What
   * waits in the queue goes once it is done, if it passes.
   */
  async recheckChecks(convId: string, messageId: string, o: { confirm?: boolean } = {}): Promise<ChatMessage> {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    this.checkAvailable(convId, t().busy);
    const old = this.latestChecksMessage(conv, messageId);
    const list = conv.settings.checks;
    const commands = list?.commands ?? [];
    // The team works in its own worktrees (its result is not applied yet): checked there, its commands when it is.
    const team =
      conv.settings.permission !== 'read-only' &&
      conv.settings.mode !== 'parallel' &&
      Boolean(conv.worktrees[TEAM_WORKTREE]?.some((w) => !w.needsReset));
    const skipped =
      conv.settings.permission === 'read-only'
        ? t().checksCommandsReadOnly
        : conv.settings.mode === 'parallel'
          ? t().checksCommandsParallel
          : team
            ? t().checksCommandsTeam
            : undefined;
    const runs = commands.length > 0 && !skipped;
    // The paths and commits are checked here; the commands after the card is posted.
    const builtIn = list ? { ...list, commands: [] } : undefined;
    const release = this.reserve(convId);
    const abort = new AbortController();
    let roots: string[] = [];
    let next: ChatMessage;
    const started = Date.now();
    try {
      if (runs) {
        roots = [...new Set((await this.foldersNow(conv)).map((f) => f.root))];
        this.lockDirs(roots, conv);
        this.checking.set(convId, abort);
        this.emitStatus(convId);
      }
      const baseline = this.store.checksBaseline<StoredBaseline>(conv.id, old.id);
      const unchecked = (why: string) => this.unchecked({ ...conv, settings: { ...conv.settings, checks: builtIn } }, why);
      let outcomes: CheckOutcome[] = [];
      if (hasChecks(builtIn)) {
        if (!baseline) outcomes = unchecked(t().checksNoBaseline);
        else {
          try {
            const folders = await this.foldersNow(conv);
            const parallel = conv.settings.mode === 'parallel' && conv.settings.permission !== 'read-only';
            const worktrees = parallel ? await this.worktreeChanges(conv, folders) : [];
            const own = team ? this.teamDirs(conv, folders) : [];
            const where = own.length ? own : folders;
            outcomes = await recheckFrom(
              builtIn,
              this.checkFolders(where, parallel || own.length > 0, own.length > 0),
              baseline,
              worktrees,
            );
          } catch (err) {
            outcomes = unchecked((err as Error).message);
          }
        }
      }
      const replyIds = old.checks!.replyIds;
      const appReplies = builtIn?.previewApp ? (old.checks!.appReplies ?? replyIds ?? []) : undefined;
      if (appReplies) outcomes = [...outcomes.filter((x) => x.rule !== 'preview'), this.previewOutcome(conv, appReplies)];
      // Still kept from running by the run's changes, until the user confirms.
      // Not only the card's own: a gate an earlier result carries on holds them back as well.
      const gated = o.confirm ? [] : this.heldGate(conv);
      next = this.postChecks(
        conv,
        checksResult([...outcomes, ...commands.map((c) => this.commandPending(c, runs ? 'running' : 'na', skipped))], {
          when: 'recheck',
          ...(replyIds ? { replyIds } : {}),
          ...(appReplies?.length ? { appReplies } : {}),
          checkedAt: started,
          durationMs: Date.now() - started,
        }),
      );
      if (baseline) this.store.saveChecksBaseline(conv.id, next.id, baseline);
      const posted = next;
      const work = (async () => {
        let why: string | undefined;
        try {
          if (runs) {
            await this.runResultCommands(conv, posted, commands, {
              signal: abort.signal,
              startedAt: started,
              ...(gated.length ? { gate: { files: gated, unattended: false } } : {}),
            });
          }
        } catch (err) {
          why = (err as Error).message;
          console.error('[orchestrator] team checks failed:', err);
        } finally {
          this.settleCommands(conv, posted, started, why);
          if (roots.length) this.unlockDirs(roots, conv.id);
          this.checking.delete(convId);
          release();
          this.emitStatus(convId);
          if (!abort.signal.aborted) this.startQueued(conv);
        }
      })();
      this.checkWork.add(work);
      void work.finally(() => this.checkWork.delete(work));
      if (!runs) await work;
    } catch (err) {
      if (roots.length && this.checking.get(convId) === abort) this.unlockDirs(roots, conv.id);
      if (this.checking.get(convId) === abort) this.checking.delete(convId);
      release();
      this.emitStatus(convId);
      throw err;
    }
    return next;
  }

  /**
   * Run one command of a list being edited (Team settings' "Try it"), on the working directories as they
   * are now, as the checks would with `permission` (the one Team settings is being changed to, else the
   * conversation's: in the sandbox below full access), and say how it went: nothing is posted. Not in
   * read-only, which runs no command. Holds the folders while it runs; Stop stops it, and what is sent
   * meanwhile goes once it is done.
   */
  async tryCheckCommand(convId: string, cmd: CheckCommand, permission?: Permission): Promise<CheckOutcome> {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, t().conversationNotFound);
    const as = permission ?? conv.settings.permission;
    if (as === 'read-only') throw new HttpError(409, t().checksTryReadOnly);
    const abort = new AbortController();
    const work = this.exclusive(convId, t().busy, async () => {
      const roots = [...new Set((await this.foldersNow(conv)).map((f) => f.root))];
      this.lockDirs(roots, conv);
      this.checking.set(convId, abort);
      this.emitStatus(convId);
      try {
        // In parallel mode as the checks before applying run: in the sandbox with full access too, when it starts.
        const sandboxFirst = as === 'full' && conv.settings.mode === 'parallel' && (await this.checkCommandDeps.sandboxAvailable()).ok;
        return await runCheckCommand(cmd, this.commandPlace(conv, abort.signal, sandboxFirst ? 'edit' : as), this.checkCommandDeps);
      } finally {
        this.unlockDirs(roots, conv.id);
        this.checking.delete(convId);
        this.emitStatus(convId);
      }
    });
    this.checkWork.add(work);
    try {
      return await work;
    } finally {
      this.checkWork.delete(work);
      if (!abort.signal.aborted) this.startQueued(conv);
    }
  }

  /**
   * Go on without the latest result passing (its card's "Skip"): what waits in the queue goes, and agents
   * are not told of it any more. It stays as it was: not a pass.
   */
  skipChecks(convId: string, messageId: string): ChatMessage {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    const msg = this.latestChecksMessage(conv, messageId);
    if (!checksFailed(msg.checks!)) throw new HttpError(409, t().checksPassedAlready);
    if (!msg.checks!.skippedAt) {
      msg.checks = { ...msg.checks!, skippedAt: Date.now() };
      this.hub.emit(conv.id, { type: 'message', message: msg });
      this.store.saveMessage(conv.id, msg, true);
    }
    this.startQueued(conv);
    return msg;
  }

  /**
   * Ask one member to fix the latest result (its card's "Ask … to fix"): a message from the user to it
   * (in the user's language), and a turn of its own, in which it is shown the result, seen or not. The
   * messages waiting stay in the queue until the result passes or the user decides.
   */
  async fixChecks(convId: string, messageId: string, agentId: string): Promise<void> {
    const conv = this.getIdle(convId);
    const msg = this.latestChecksMessage(conv, messageId);
    if (!checksFailed(msg.checks!)) throw new HttpError(409, t().checksPassedAlready);
    const agent = conv.agents.find((a) => a.id === agentId);
    if (!agent) throw new HttpError(404, t().invalidField('agentId'));
    if (pendingPlan(conv.messages)) throw new HttpError(409, t().planAwaitingConfirm);
    await this.start(conv, t().checksFixMessage(agent.name), {
      only: [agent],
      keepTeam: true,
      fixChecks: msg.id,
      beforePost: () => {
        const { fixAuto: _auto, ...was } = msg.checks!;
        msg.checks = { ...was, fixBy: agent.name };
        this.hub.emit(conv.id, { type: 'message', message: msg });
        this.store.saveMessage(conv.id, msg, true);
      },
    });
  }

  /**
   * Turn lead review on or off (the team design card's box, or Team settings' while the team replies).
   * Any time, also while the team replies: whether the lead agent reviews is decided when the team has
   * answered.
   */
  setLeadReview(convId: string, on: boolean): Conversation {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    if (Boolean(conv.settings.leadReview) !== on) {
      const { leadReview: _was, ...rest } = conv.settings;
      conv.settings = on ? { ...rest, leadReview: true } : rest;
      this.store.saveMeta(conv);
      this.emitConversation(conv);
    }
    // Off while the lead agent reviews: that review stops too (its card says so), and the run ends as
    // usual (what waits for it starts).
    if (!on) this.runs.get(convId)?.reviewAbort?.abort();
    return conv;
  }

  /**
   * Turn steering on or off (Team settings' box), any time, also while the team replies: it is read as
   * each message is sent (`steerOrQueue`).
   */
  setSteer(convId: string, on: boolean): Conversation {
    const conv = this.store.get(convId);
    if (!conv || this.deleting.has(convId)) throw new HttpError(404, t().conversationNotFound);
    if (Boolean(conv.settings.steer) !== on) {
      const { steer: _was, ...rest } = conv.settings;
      conv.settings = on ? { ...rest, steer: true } : rest;
      this.store.saveMeta(conv);
      this.emitConversation(conv);
    }
    return conv;
  }

  /** The lead agent's team becomes the conversation's team (members and how they take turns). */
  private applyPlan(conv: Conversation, plan: NonNullable<ChatMessage['plan']>): void {
    if (!plan.agents?.length || !plan.settings) return;
    conv.agents = plan.agents.map((a) => ({ ...a }));
    conv.settings = { ...conv.settings, ...plan.settings, ...this.templateChecks(conv, plan) };
    this.store.saveMeta(conv);
    this.emitConversation(conv);
  }

  private async checkConfirmedTeam(conv: Conversation, run: Run, msg: ChatMessage): Promise<void> {
    const plan = msg.plan!;
    const started = Date.now();
    const usage: RunResult[] = [];
    msg.status = 'streaming';
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);
    try {
      // Check the approved assignments exactly. A newly unavailable one needs a new design.
      const ctx = await this.planner.context(undefined, undefined, true);
      run.abort.signal.throwIfAborted();
      if (!plan.agents!.every((a) => memberAvailable(ctx, a))) throw new PlanUnavailableError(t().planCurrentUnavailable);
      const checked = await this.checkTeam(
        conv,
        run,
        msg,
        ctx,
        plan.lead,
        {
          agents: plan.agents!,
          settings: plan.settings!,
          source: plan.source!,
          reason: plan.reason ?? '',
          name: plan.name ?? '',
        },
        usage,
        false,
      );
      run.abort.signal.throwIfAborted();
      plan.agents = checked.agents;
      msg.status = 'done';
      delete plan.checkOnConfirm;
      this.applyPlan(conv, plan);
      this.markAnswered(conv, msg, 'confirm');
      run.answerNext = true;
    } catch (err) {
      if (!run.abort.signal.aborted) {
        plan.status = 'failed';
        plan.reason = (err as Error).message;
        delete plan.awaitingConfirmation;
        delete plan.checkOnConfirm;
      }
    } finally {
      msg.status = 'done';
      for (const p of msg.parts) if (p.type === 'tool' && p.status === 'running') p.status = 'error';
      msg.meta ??= {};
      msg.meta.durationMs = (msg.meta.durationMs ?? 0) + Date.now() - started;
      for (const r of usage) {
        for (const key of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
          if (r[key] !== undefined) msg.meta[key] = (msg.meta[key] ?? 0) + r[key];
        }
      }
      this.store.saveMessage(conv.id, msg, true);
      this.hub.emit(conv.id, { type: 'message', message: msg });
    }
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
    if (answer === 'confirm' && msg.plan.checkOnConfirm) {
      this.startInBackground(conv, { checkPlan: msg });
      return;
    }
    if (answer === 'confirm') this.applyPlan(conv, msg.plan);
    this.markAnswered(conv, msg, answer);
    // The team answers the question now, with what the user wrote while it waited for confirmation.
    this.startConfirmed(conv);
  }

  /**
   * The team was set by hand (the team drawer: `members` when its members were sent, not only its
   * settings). A team set by hand is the user's decision too: it settles a design that was waiting
   * (the team set by hand is the one that answers). The design the team comes from now (that one, or
   * the latest one used) shows the team as the user set it, so its card names the members the
   * conversation has (`planFollowsTeam`). Returns whether a waiting design was settled (the caller
   * then lets the team answer, `startConfirmed`).
   */
  teamSetByHand(conv: Conversation, members: boolean): boolean {
    const waiting = members ? pendingPlan(conv.messages) : undefined;
    const msg = waiting ?? currentPlan(conv.messages);
    if (!msg) return false;
    const changed = planFollowsTeam(msg.plan!, conv);
    if (waiting) {
      this.markAnswered(conv, waiting, 'confirm');
      return true;
    }
    if (changed) {
      this.store.saveMessage(conv.id, msg, true);
      this.hub.emit(conv.id, { type: 'message', message: msg });
    }
    return false;
  }

  private markAnswered(conv: Conversation, msg: ChatMessage, answer: 'confirm' | 'decline'): void {
    delete msg.plan!.awaitingConfirmation;
    delete msg.plan!.checkOnConfirm;
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
  async reviseTeam(
    convId: string,
    input: { request?: unknown; agents?: unknown; settings?: unknown },
    signal?: AbortSignal,
  ): Promise<TeamRevision> {
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
        ...this.settings.runNative(lead.provider, lead.account, 'read-only'),
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
        outputSchema: REVISION_SCHEMA,
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
      const revised = decideRevision(leadReply(reply, result.structured), draft, ctx, lead);
      return {
        ...revised,
        meta: {
          durationMs: Date.now() - started,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
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
  private async execute(conv: Conversation, posted: ChatMessage[], run: Run, only?: AgentConfig[], resume?: Schedule): Promise<void> {
    if (run.designs) {
      // The lead agent designs the team for the question, and that is all this run does. Once the
      // team is confirmed (or needs no confirmation), a run of its own answers the question.
      if (run.checkPlan) await this.checkConfirmedTeam(conv, run, run.checkPlan);
      else await this.designTeam(conv, run);
      return;
    }
    // Before the checks, which look in the team's own worktrees when it works there.
    if (run.ws.team) await this.prepareTeamWorktrees(conv, rootsOf(run.ws));
    else if (run.dropTeamWorktrees) {
      await this.dropTeamWorktrees(conv).catch((err) =>
        console.warn("[orchestrator] could not remove the team's worktrees:", (err as Error).message),
      );
    }
    await this.startChecks(conv, run);
    await this.teamTurns(conv, posted, run, only, resume);
    // Before the review, and while the folders are still locked: the review reads the result too.
    await this.finishChecks(conv, run);
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
  private async teamTurns(conv: Conversation, posted: ChatMessage[], run: Run, only?: AgentConfig[], resume?: Schedule): Promise<void> {
    const { mode, maxHops } = conv.settings;
    const s = resume ?? this.schedule(conv, posted, only);
    const aborted = () => run.abort.signal.aborted;
    const spoke = (m: ChatMessage) => m.status === 'done' && !m.passed;
    const ids = (agents: AgentConfig[]) => agents.map((a) => a.id);
    /** The user's reply answers this agent's question (it is told on this turn only). */
    const answered = (a: AgentConfig) => s.answering.delete(a.id);
    /** After an answer to one of several agents that wait: the team waits again, for them and any that asked now. */
    const waitAgain = (waiting: RunPause, asked: AgentConfig[]) =>
      this.pauseFor(conv, { ...waiting, askers: [...new Set([...waiting.askers, ...ids(asked)])] }, run);

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
        await run.checks?.checkpoint(agent.name);
        if (msg.asked) {
          const rest = queue.map((q) => ({ agentId: q.agent.id, handedBy: q.handedBy }));
          this.pauseFor(conv, { mode, askers: [agent.id], rest, participants: [], round: 1, rounds: 1, hopsLeft }, run);
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
        this.pauseFor(
          conv,
          {
            mode,
            askers: ids(askers),
            rest: rest.map((a) => ({ agentId: a.id })),
            participants: ids(s.participants),
            round,
            rounds: s.rounds,
          },
          run,
        );
      const msgs: ChatMessage[] = [];
      if (mode === 'parallel') {
        if (!speakers.length) continue; // the user let the team go on without answering
        // The round's turns run side by side: they all see what was sent before it starts.
        this.deliverBefore(conv, run, speakers);
        // A message steered into the round goes into all of its turns, or into none (`steerTargets`).
        run.round = ids(speakers);
        // Every turn settles before the run can end, even when one of them fails.
        const settled = await Promise.allSettled(speakers.map((a) => this.turn(conv, a, run, info(a))));
        run.round = undefined;
        const failed = settled.find((r) => r.status === 'rejected');
        if (failed) throw failed.reason;
        // Side by side, a change cannot be put down to one of them.
        await run.checks?.checkpoint(undefined);
        msgs.push(...settled.map((r) => (r as PromiseFulfilledResult<ChatMessage>).value));
        // The others answered already; the ones that asked answer again once the user replied.
        const askers = speakers.filter((_, i) => msgs[i]!.asked);
        if (s.waiting) return waitAgain(s.waiting, askers);
        if (askers.length) return pause(askers, []);
      } else {
        for (const [i, a] of speakers.entries()) {
          if (aborted()) break;
          this.deliverBefore(conv, run, [a]);
          const msg = await this.turn(conv, a, run, info(a));
          await run.checks?.checkpoint(a.name);
          msgs.push(msg);
          if (msg.asked && !s.waiting) return pause([a], speakers.slice(i + 1));
        }
        if (s.waiting)
          return waitAgain(
            s.waiting,
            speakers.filter((_, i) => msgs[i]?.asked),
          );
      }
      if (msgs.length && !msgs.some(spoke)) break; // everyone passed: the discussion has converged
    }
  }

  /**
   * Post the waiting messages for these speakers before their turn (`deliverQueued`). One the user
   * wrote means they are here: the run asks for approvals again, even if a schedule started it.
   */
  private deliverBefore(conv: Conversation, run: Run, recipients: AgentConfig[]): void {
    if (run.fixChecks) return;
    if (this.deliverQueued(conv, { recipients, scheduledOnly: run.scheduledQueueOnly }).some((m) => !m.scheduled)) {
      run.refuseApprovals = false;
      run.unattended = undefined;
      // What the lead agent approved before it is reviewed again in its light ("Approve for me").
      run.reviewed = undefined;
    }
  }

  /** Who speaks in a run the user's `posted` messages (or Continue, or a retry of `only`) start. */
  private schedule(conv: Conversation, posted: ChatMessage[], only?: AgentConfig[]): Schedule {
    const mentioned = only ?? mentionsOf(posted, conv.agents);
    const participants = mentioned.length ? mentioned : conv.agents;
    // Relay: the mentioned agents start (a retry: just the one), or the leader.
    const first =
      conv.settings.mode === 'relay' ? (mentioned.length ? mentioned.slice(0, only ? 1 : undefined) : [conv.agents[0]!]) : participants;
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
  private pauseFor(conv: Conversation, pause: RunPause, run: Run): void {
    // A tracking schedule's run asked: the answer's run goes on with the goal (`carriedTracking`).
    conv.pause = run.tracking ? { ...pause, tracked: runOf(run.tracking) } : pause;
    this.store.saveMeta(conv);
    this.emitConversation(conv);
  }

  /**
   * The user replied while the team waited for an answer: the team picks up where it stopped, and
   * the agents that asked answer first — unless the reply is Continue (nothing posted), which lets
   * the others go on without them. A reply that @mentions anyone else, a retry, a team design or a
   * changed mode starts afresh. Continue with nobody left to speak starts a fresh speaking order
   * but still completes the checks for the work before the pause. Only what the user wrote counts:
   * a scheduled message that waited in the queue is no answer, and its @mentions do not start afresh.
   */
  private takePause(
    conv: Conversation,
    posted: ChatMessage[],
    only: AgentConfig[] | undefined,
    planning: boolean,
    /** The user's message answers this agent alone (its steps card). */
    answers?: string,
  ): { schedule?: Schedule } | undefined {
    const pause = conv.pause;
    if (!pause) return undefined;
    conv.pause = undefined;
    this.store.saveMeta(conv);
    this.emitConversation(conv);
    if (only || planning || pause.mode !== conv.settings.mode) return undefined;
    const replies = posted.filter((m) => !m.scheduled);
    if (replies.some((m) => parseMentions(textOf(m), conv.agents).some((a) => !pause.askers.includes(a.id)))) return undefined;
    const byId = (id: string) => conv.agents.find((a) => a.id === id);
    // An answer to one of several agents that wait (a steps card): it alone goes on, in the round it
    // asked in, and the team keeps waiting for the others.
    const alone = answers && replies.length && pause.mode !== 'relay' && pause.askers.length > 1 ? byId(answers) : undefined;
    if (alone && pause.askers.includes(alone.id)) {
      conv.pause = { ...pause, askers: pause.askers.filter((id) => id !== alone.id) };
      this.store.saveMeta(conv);
      this.emitConversation(conv);
      const participants = pause.participants.flatMap((id) => byId(id) ?? []);
      return {
        schedule: {
          participants: participants.length ? participants : conv.agents,
          round: pause.round,
          rounds: pause.rounds,
          first: [{ agent: alone }],
          hopsLeft: pause.hopsLeft ?? conv.settings.maxHops,
          answering: new Set([alone.id]),
          waiting: conv.pause,
        },
      };
    }
    const askers = pause.askers.flatMap((id) => byId(id) ?? []);
    const skip = replies.length === 0;
    const rest = pause.rest.flatMap((r) => {
      const agent = byId(r.agentId);
      return agent ? [{ agent, handedBy: r.handedBy }] : [];
    });
    const first = [...(skip ? [] : askers.map((agent) => ({ agent }))), ...rest];
    if (!first.length && (pause.mode === 'relay' || pause.round >= pause.rounds)) return {};
    const participants = pause.participants.flatMap((id) => byId(id) ?? []);
    return {
      schedule: {
        participants: participants.length ? participants : conv.agents,
        round: pause.round,
        rounds: pause.rounds,
        first,
        hopsLeft: pause.hopsLeft ?? conv.settings.maxHops,
        answering: new Set(skip ? [] : askers.map((a) => a.id)),
      },
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
      // A tracking schedule's run: kept with the reply (also one that fails), so a Retry or Continue of it goes on with the goal.
      ...(run.tracking && this.trackingSource(run) ? { tracked: runOf(run.tracking) } : {}),
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
    /** Its worktree of each repository, in parallel mode (or the team's, which it works in). */
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
        // Its own in parallel mode; the team's, which every member works in, when it has them.
        const own = conv.worktrees[run.ws.team ? TEAM_WORKTREE : agent.id] ?? [];
        for (const root of roots) {
          const wt = own.find((w) => w.root === root);
          if (!wt) throw new AgentRunError(run.ws.team ? t().noTeamWorktree : t().noWorktree);
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
        workspace = run.ws.team
          ? { kind: 'team', folders }
          : {
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
    /** Messages the user sent into this attempt's running turn (steering): seen once the turn ends well. */
    let steered: string[] = [];
    /** How the turn ended, for a message its CLI took as it was ending (`took` comes after it then). */
    let outcome: 'done' | 'failed' | undefined;
    const took = (messageId: string) => {
      if (!outcome) steered.push(messageId);
      else if (outcome === 'done' && !state.seen.includes(messageId)) {
        state.seen.push(messageId);
        this.store.saveAgentState(conv.id, agent.id, state);
      }
      // A failed turn: its messages are offered again, this one too.
    };
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
          // A subagent's calls that came in since the text began do not close it: it goes on in its part.
          let at = msg.parts.length - 1;
          while (textOpen && at > 0 && msg.parts[at].type === 'tool' && (msg.parts[at] as { parentId?: string }).parentId) at--;
          const last = msg.parts[at];
          if (textOpen && last?.type === 'text') last.text += e.text;
          else {
            msg.parts.push({ type: 'text', text: e.text });
            at = msg.parts.length - 1;
          }
          textOpen = true;
          this.hub.emit(conv.id, { type: 'delta', messageId: msg.id, partIndex: at, text: e.text });
          break;
        }
        case 'text_end':
          textOpen = false;
          return;
        case 'plan':
          // Replacing an existing to-do list does not close a streaming text block.
          if (!msg.parts.some((part) => part.type === 'plan')) textOpen = false;
          this.activity(conv.id, msg, e);
          return;
        case 'thinking':
        case 'notice':
          textOpen = false;
          this.activity(conv.id, msg, e);
          return;
        case 'tool_start':
          // A subagent's call goes inside the call that started it, not between the agent's words.
          if (!e.parentId) textOpen = false;
          this.activity(conv.id, msg, e);
          return;
        case 'tool_end':
          this.activity(conv.id, msg, e);
          return;
      }
      this.store.saveMessage(conv.id, msg);
    };

    // Ask the user in the chat; the CLI waits until they answer (or the run is stopped). In a run a
    // schedule started, only what the conversation always allows goes through; the rest is refused.
    // With "Approve for me", the lead agent reviews each request first: what it approves goes through
    // (in a schedule's run too), and the user is asked about the rest as before.
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
              const busy = req.noLock ? undefined : this.lockForApproval(conv, run);
              Object.assign(part, busy ? { status: 'denied', note: busy } : { status: 'allowed', always: true, auto: true });
              this.hub.emit(conv.id, { type: 'message', message: msg });
              this.store.saveMessage(conv.id, msg, true);
              return busy ? { allow: false, note: busy } : { allow: true };
            }
            const review = conv.settings.approvals === 'auto' ? this.startReview(conv, run, agent, req, [cwd, ...addDirs]) : undefined;
            if (review) part.review = review.first;
            const reviewing = part.review?.status === 'reviewing';
            if (run.refuseApprovals && !reviewing && part.review?.status !== 'approved') {
              Object.assign(part, { status: 'denied', note: t().scheduleRefused });
              this.hub.emit(conv.id, { type: 'message', message: msg });
              this.store.saveMessage(conv.id, msg, true);
              return { allow: false, note: UNATTENDED_REFUSAL };
            }
            this.hub.emit(conv.id, { type: 'message', message: msg });
            this.store.saveMessage(conv.id, msg, true);

            waiting.add(part.id);
            let answer = await new Promise<ApprovalAnswer & { expired?: boolean; unattended?: boolean }>((resolve) => {
              const onAbort = () => resolve({ allow: false, expired: true });
              run.abort.signal.addEventListener('abort', onAbort, { once: true });
              const pending = {
                convId: conv.id,
                reviewing,
                /** Answered: a verdict that lands in the same moment changes nothing. */
                done: false,
                resolve: (a: ApprovalAnswer & { expired?: boolean; unattended?: boolean }) => {
                  if (pending.done) return;
                  pending.done = true;
                  run.abort.signal.removeEventListener('abort', onAbort);
                  resolve(a);
                },
              };
              this.approvals.set(part.id, pending);
              this.emitStatus(conv.id);
              if (run.abort.signal.aborted) onAbort();
              // Approved before it was shown (the same request earlier in the run): it goes through at once.
              else if (part.review?.status === 'approved') pending.resolve({ allow: true });
              else if (reviewing)
                void review!.verdict.then((v) => {
                  // Answered meanwhile (by the user, or the run ended): the review is moot.
                  if (pending.done || this.approvals.get(part.id) !== pending) return;
                  part.review = v;
                  if (v.status === 'approved') return pending.resolve({ allow: true });
                  // Nobody may be watching: what the lead agent did not approve is refused.
                  if (run.refuseApprovals) return pending.resolve({ allow: false, unattended: true });
                  // Now it waits for the user.
                  pending.reviewing = false;
                  this.hub.emit(conv.id, { type: 'message', message: msg });
                  this.store.saveMessage(conv.id, msg, true);
                  this.emitStatus(conv.id);
                });
            });
            review?.stop();
            // The user answered before the lead agent did.
            if (part.review?.status === 'reviewing') delete part.review;
            waiting.delete(part.id);
            this.approvals.delete(part.id);
            const busy = answer.allow && !req.noLock ? this.lockForApproval(conv, run) : undefined;
            if (busy) answer = { allow: false, note: busy };
            // What the reviewer would have approved, the lock refused: not approved after all.
            if (busy && part.review?.status === 'approved') delete part.review;
            part.status = answer.expired ? 'expired' : answer.allow ? 'allowed' : 'denied';
            // Refused unattended after the review: the card says why, and the agent hears what it would without one.
            if (answer.unattended) {
              part.note =
                part.review?.status === 'failed'
                  ? t().approvalReviewFailedRefused(part.review.reason ?? '')
                  : t().approvalReviewRefused(part.review?.reason ?? '');
              this.hub.emit(conv.id, { type: 'message', message: msg });
              this.store.saveMessage(conv.id, msg, true);
              this.emitStatus(conv.id);
              return { allow: false, note: UNATTENDED_REFUSAL };
            }
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

    // Harness Relay's own tools, in a turn that has them: a CLI's own question about one (its name exactly
    // the gateway's: `mcp__relay__mail_search`, Codex's `relay:mail_search`) is answered yes, with no card,
    // also in a run nobody may be watching. The gateway decides as the call reaches it, by the tool's tier:
    // a read runs, an act is asked about there (with what it will do, as the page or the account says it),
    // a send waits in the outbox. The CLI's own card would show its arguments only, and a scheduled run
    // would refuse even a read. Every other question goes on as before.
    const gatewayNames = this.gateway?.toolNames() ?? [];
    const cliApproval = (relayOn: boolean): RunOptions['requestApproval'] =>
      relayOn
        ? async (req: ApprovalRequest): Promise<ApprovalAnswer> =>
            gatewayToolNamed(gatewayNames, req, agent.provider)
              ? { allow: true }
              : requestApproval
                ? requestApproval(req)
                : { allow: false }
        : requestApproval;
    const toOutbox = (o: { tool: string; title: string; preview: OutboxItem['preview']; args: Record<string, unknown> }): OutboxItem => {
      const { item, existing } = this.outbox!.add(
        { convId: conv.id, messageId: msg.id, agentId: agent.id, agentName: agent.name, tool: o.tool, title: o.title, preview: o.preview },
        o.args,
      );
      if (!existing) {
        textOpen = false;
        msg.parts.push({ type: 'outbox', id: item.id, tool: item.tool, title: item.title, preview: item.preview, status: 'pending' });
        this.hub.emit(conv.id, { type: 'message', message: msg });
        this.store.saveMessage(conv.id, msg, true);
      }
      return item;
    };

    // A hand-over of the chat's browser (`browser_hand_over`): its card in the reply, which the browser keeps
    // up to date; the conversation waits for the user while it is pending or in their hands. Only where
    // someone may be asked, as approvals are: never in a run nobody watches.
    const turnHandovers = new Map<string, HandoverPart>();
    const handoverCard =
      requestApproval && !run.refuseApprovals
        ? (part: HandoverPart) => {
            textOpen = false;
            msg.parts.push(part);
            this.handovers.set(part.id, conv.id);
            turnHandovers.set(part.id, part);
            this.hub.emit(conv.id, { type: 'message', message: msg });
            this.store.saveMessage(conv.id, msg, true);
            this.emitStatus(conv.id);
            return {
              update: (change: Partial<HandoverPart>) => {
                Object.assign(part, change);
                if (change.deadline === undefined && 'deadline' in change) delete part.deadline;
                if (part.status !== 'pending' && part.status !== 'active') {
                  this.handovers.delete(part.id);
                  turnHandovers.delete(part.id);
                }
                this.hub.emit(conv.id, { type: 'message', message: msg });
                this.store.saveMessage(conv.id, msg, true);
                this.emitStatus(conv.id);
              },
            };
          }
        : undefined;

    // The tokens RLM's sub-model spent on this turn's questions (`llm_query()`), over both attempts.
    const subModel: SubModelTokens = { inputTokens: 0, outputTokens: 0 };
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
      // Of the team checks' results, only the latest: one that later checks replaced is not the team's to fix.
      // The one the user asked this member to fix is shown again, also when it was seen.
      const latest = latestChecks(conv.messages)?.id;
      const delta = conv.messages.filter(
        (m) => m.id !== msg.id && isForwardable(m) && (!m.checks || m.id === latest) && (!seen.has(m.id) || m.id === run.fixChecks),
      );
      // Long-term memory's notes that match what was said, once per session (kept in `seen` with the messages).
      const recalled = this.memory.recall(conv, delta, seen);
      const prompt = buildTurnPrompt(conv, agent, delta, !state.sessionId, info, recalled);
      const files = delta.flatMap((m) =>
        m.author.kind === 'user' ? m.parts.filter((p): p is AttachmentPart => p.type === 'attachment') : [],
      );
      const seenBefore = state.seen;
      committedSeen = seenBefore;
      state.seen = [...state.seen, ...delta.map((m) => m.id).filter((id) => !seen.has(id)), ...recalled.map((n) => memorySeenKey(n.id))];
      // Read on every turn, so library changes reach agents at their next turn. Its MCP servers that
      // signed in themselves get an access token each, good for a while yet; one whose sign-in needs
      // renewing is left out, with a note the agent (its briefing) and the user (the reply) see.
      const tools = await this.settings.mcpOAuth.forTurn(this.settings.tools.forAgent(agent));
      if (tools.leftOut?.length) {
        for (const l of tools.leftOut) msg.parts.push({ type: 'notice', text: l.note });
        this.hub.emit(conv.id, { type: 'message', message: msg });
        this.store.saveMessage(conv.id, msg, true);
      }
      // The team's hooks, for a CLI whose adapter can run them around its calls; a member on another is
      // told about in the reply, as its calls go without them.
      const notice = (text: string) => {
        textOpen = false;
        msg.parts.push({ type: 'notice', text });
        this.hub.emit(conv.id, { type: 'message', message: msg });
        this.store.saveMessage(conv.id, msg, true);
      };
      // The account's own (its home has its own skills, MCP servers and hooks), at this run's permission.
      const { nativeOff, nativeItems, nativeOn } = this.settings.runNative(agent.provider, account, conv.settings.permission);
      const freshState = emptyState;
      emptyState = false;
      const model = await this.modelFor(agent.provider, agent.model, account);
      // The member's own limit, the one its CLI has.
      const limits = agentLimitsFor(agent.provider, agent.limits);
      // Over loopback HTTP for the CLIs that keep its token in memory (`GATEWAY_OVER_HTTP`), else the stdio
      // program; below full access, a CLI whose sandbox holds its MCP servers gets no stdio stand-in
      // (`GATEWAY_SANDBOXED_MCP`), and one with no HTTP way at all none (`GATEWAY_FULL_ACCESS_ONLY`).
      const full = conv.settings.permission === 'full';
      // End gateway calls and hooks when the CLI finishes, fails, times out, or receives Stop.
      const turnEnd = new AbortController();
      // Steering: while the CLI can take a message into this turn, one the user sends may go in
      // (`steerInto`, when the conversation steers: read as each message is sent).
      steered = [];
      const onSteer = STEER_PROVIDERS.includes(agent.provider)
        ? (steer: SteerTurn | undefined) => {
            if (steer && !turnEnd.signal.aborted) (run.steers ??= new Map()).set(agent.id, { steer, took });
            else run.steers?.delete(agent.id);
          }
        : undefined;
      const turnSignal = AbortSignal.any([run.abort.signal, turnEnd.signal]);
      const hooks = this.turnHooksOf(conv, agent, [cwd, ...addDirs], workspace, turnSignal, notice);
      const relay =
        this.gateway && this.outbox && tools.relayGroups.length && (full || !GATEWAY_FULL_ACCESS_ONLY.includes(agent.provider))
          ? this.gateway.grant(
              {
                convId: conv.id,
                agentId: agent.id,
                agentName: agent.name,
                messageId: msg.id,
                cwd,
                permission: conv.settings.permission,
                lang: currentLang(),
                unattended: Boolean(run.refuseApprovals),
                ...(requestApproval ? { ask: requestApproval } : {}),
                ...(handoverCard ? { handoverCard } : {}),
                toOutbox,
                usage: (u) => {
                  subModel.inputTokens += u.inputTokens;
                  subModel.outputTokens += u.outputTokens;
                  if (u.costUsd) subModel.costUsd = (subModel.costUsd ?? 0) + u.costUsd;
                },
                signal: turnSignal,
              },
              tools.relayGroups,
              { http: GATEWAY_OVER_HTTP.includes(agent.provider), fallback: full || !GATEWAY_SANDBOXED_MCP.includes(agent.provider) },
            )
          : undefined;
      try {
        const result = await runners[agent.provider].run({
          bin: this.settings.bin(agent.provider),
          env: this.settings.env(agent.provider, account),
          backends: this.settings.backendsFor(agent.provider),
          nativeOff,
          nativeItems,
          nativeOn,
          sandboxTerminal: this.settings.sandboxTerminal(agent.provider),
          prompt,
          systemPrompt: buildBriefing(
            conv,
            agent,
            workspace,
            {
              ...tools,
              grantedGroups: relay ? tools.relayGroups : undefined,
              longTerm: this.memory.forBriefing(conv),
              handoffs: this.handoffsForBriefing(conv),
            },
            nativeOff,
            nativeItems,
            Boolean(run.refuseApprovals),
            this.trackingSource(run)?.schedule,
          ),
          sessionId: state.sessionId,
          cwd,
          ...(addDirs.length ? { addDirs } : {}),
          ...guardOf(conv.settings.checks, [cwd, ...addDirs]),
          ...(hooks ? { hooks } : {}),
          permission: conv.settings.permission,
          stateKey: stateKeys.member(conv.id, agent.id),
          freshState,
          model,
          effort: agent.effort?.trim() || this.settings.defaultEffort(agent.provider, account) || undefined,
          ...(limits ? { limits } : {}),
          signal: run.abort.signal,
          onEvent,
          requestApproval: cliApproval(Boolean(relay)),
          images: imageInputs(conv.id, files),
          attachmentsDir: files.length ? attachmentsDir(conv.id) : undefined,
          mcpServers: relay ? [...tools.mcpServers.filter((s) => !reservedMcpName(s.name)), relay.spec] : tools.mcpServers,
          readDirs: tools.skills.map((s) => s.dir),
          ...(onSteer ? { onSteer } : {}),
        });
        if (result.sessionId) state.sessionId = result.sessionId;
        return result;
      } catch (err) {
        state.seen = seenBefore; // not delivered; offer it again next turn
        throw err;
      } finally {
        turnEnd.abort();
        run.steers?.delete(agent.id);
        relay?.revoke();
        await hooks?.dispose();
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
        if (!hadSession || aborted || agentSaid(msg)) throw err;
        console.warn(`[orchestrator] resume failed for @${agent.name}, retrying fresh:`, (err as Error).message);
        const kept = { sessionId: state.sessionId, seen: state.seen };
        try {
          result = await attempt(true);
        } catch (freshErr) {
          // The fresh session failed too before saying anything (rate limit, sign-in, network…): the
          // problem was not the session, so keep it for the next turn.
          if (!agentSaid(msg)) {
            Object.assign(state, kept);
            keptOldSession = true;
          }
          throw freshErr;
        }
      }
      // Long-term memory's blocks, anywhere in the reply, come out first: the ask marker, a steps block
      // and a <progress> block end it.
      this.takeMemory(conv, msg, agent);
      // Secrets asked for and fixed commands proposed wait for the user, as a question does.
      const handedOff = this.takeHandoffs(conv, msg, agent, { automation: Boolean(run.unattended) });
      // A reply about a tracked goal ends with its <progress> block, before or after an ask marker.
      const tracked = this.trackingSource(run);
      let progress = tracked ? takeProgress(msg) : undefined;
      let asks = takeAsk(msg) || handedOff;
      // Steps for the user to take ask them too, before or after an ask marker (which adds nothing then).
      if (takeSteps(msg)) asks = takeAsk(msg) || true;
      if (asks) msg.asked = true;
      if (tracked) progress ??= takeProgress(msg);
      if (tracked && progress) this.recordProgress(tracked, conv, msg, progress);
      const text = textOf(msg);
      // A reply that only reported on the goal, only asked to send something or only gave steps said something.
      msg.passed =
        isPass(text) ||
        (!text &&
          !msg.parts.some(
            (p) =>
              p.type === 'tool' ||
              p.type === 'progress' ||
              p.type === 'outbox' ||
              p.type === 'memory' ||
              p.type === 'secrets' ||
              p.type === 'command' ||
              p.type === 'steps' ||
              p.type === 'interactive',
          ));
      msg.status = 'done';
      msg.meta = {
        ...msg.meta,
        durationMs: Date.now() - started,
        costUsd: result.costUsd,
        ...withSubModelTokens(result, subModel),
      };
      // What the user sent into the turn (steering) is in the session now, as the reply is.
      for (const id of steered) if (!state.seen.includes(id)) state.seen.push(id);
      outcome = 'done';
      state.seen.push(msg.id);
    } catch (err) {
      outcome = 'failed';
      const aborted = err instanceof AgentRunError && err.aborted;
      // The session this agent resumes next holds its own reply, even a failed one, so the reply is
      // not news to it; without such a session (it starts fresh) it is shown the reply.
      if (state.sessionId && !keptOldSession) state.seen.push(msg.id);
      msg.status = aborted ? 'aborted' : 'error';
      msg.error = aborted ? undefined : (err as Error).message;
      // Notes the reply finished writing before it stopped are kept too.
      try {
        this.takeMemory(conv, msg, agent);
      } catch (memoryErr) {
        console.warn('[orchestrator] could not record memory notes:', (memoryErr as Error).message);
      }
      // What the turn spent until then, where its CLI said (a stopped Claude Code turn's result, say).
      const spent = err instanceof AgentRunError ? err.usage : undefined;
      msg.meta = {
        ...msg.meta,
        durationMs: Date.now() - started,
        ...(spent ? { costUsd: spent.costUsd, ...withSubModelTokens(spent, subModel) } : {}),
      };
      for (const p of msg.parts) if (p.type === 'tool' && p.status === 'running') p.status = 'error';
    } finally {
      // The CLI is gone: requests it was still waiting on can no longer be answered, nor can new ones.
      turnOver = true;
      for (const id of waiting) this.approvals.get(id)?.resolve({ allow: false, expired: true });
      // A hand-over the browser has not ended yet ends with the turn (the browser hears it from the turn's signal too).
      for (const part of turnHandovers.values()) {
        Object.assign(part, { status: 'expired', ended: 'turn' });
        delete part.deadline;
        this.handovers.delete(part.id);
      }
      turnHandovers.clear();
      // Record file changes even when the turn failed or was stopped: the files changed anyway.
      if (before) {
        try {
          msg.changes = await this.captureChanges(conv.id, before, run.ws.isolated ? wts : undefined, agent);
          if (msg.changes?.some((c) => !c.isolated && c.files.length)) this.markChecksStale(conv);
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
        const changes = await this.changesIn(
          convId,
          root,
          state,
          wts?.find((w) => w.root === root),
          agent,
        );
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

  systemNote(conv: Conversation, text: string): ChatMessage {
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
    return msg;
  }

  /** Gives a system note already in the chat new text (a schedule's later skipped times added to it). */
  private rewriteNote(conv: Conversation, msg: ChatMessage, text: string): void {
    msg.parts = [{ type: 'text', text }];
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);
  }

  /**
   * The note of a time the scheduler skipped (`why`, its reason, ends the sentence). While the team cannot
   * take the schedule's message (a run goes on, which may take many turns; it waits for the user's
   * answer, for as long as the user takes), every time that comes due is skipped. One that follows the
   * conversation's latest note of skipped times (`skipNotes`), of the same schedule (`s`, as the scheduler
   * left it then: not saved since) and for the same reason, with nothing written in the chat since, and
   * the time right after the latest it counts (`nextRun()`: none came between them that was not skipped,
   * nor any dropped as missed, while the computer slept, say), is added to that note instead of
   * leaving one of its own.
   */
  noteSkipped(conv: Conversation, s: ConversationSchedule, due: number, why: string): void {
    const prev = this.skipNotes.get(conv.id);
    const last = conv.messages.at(-1);
    if (prev && last?.id === prev.messageId && prev.schedule === s && prev.why === why && nextRun(s, prev.last) === due) {
      prev.count++;
      prev.last = due;
      prev.schedule = conv.schedule;
      this.rewriteNote(conv, last, t().scheduleSkippedNotes(scheduleTime(prev.first, s), scheduleTime(due, s), prev.count, why));
      return;
    }
    const note = this.systemNote(conv, t().scheduleSkippedNote(scheduleTime(due, s), why));
    this.skipNotes.set(conv.id, { messageId: note.id, schedule: conv.schedule, first: due, last: due, count: 1, why });
  }

  private emitStatus(id: string): void {
    this.hub.emit(id, { type: 'status', running: this.isRunning(id), activeAgentIds: this.activeAgentIds(id) });
  }
}
