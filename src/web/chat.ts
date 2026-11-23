import type {
  AgentConfig,
  AgentWorktree,
  ChatMessage,
  Conversation,
  ConversationBranch,
  ConversationSummary,
  MessagePart,
  HandoverPart,
  Mode,
  PlanEntry,
  ProgressStatus,
  Provider,
  ReviseTeamRequest,
  TeamPlan,
  TeamRevision,
  MessageChanges,
  StepsPart,
} from '../shared/types';
import { STEER_PROVIDERS, TEAM_WORKTREE } from '../shared/types';

import { ApiError } from './api';
import { limitsKey } from './memberLimits';
import type { ApplyState } from './components/ChangesCard';
import type { Team } from './components/TeamEditor';

/**
 * What to do after the conversation's event stream fails, given how fetching the conversation went
 * (`err` undefined: it is still there). Only a 404 means the conversation is gone. Anything else (the
 * server restarting, a proxy error page, no network) is retried: by the browser itself, unless it gave
 * up on the stream (it does when the response is an HTTP error), then by us.
 */
export function afterStreamError(err: unknown, browserGaveUp: boolean): 'stop' | 'reconnect' | 'wait' {
  if (err instanceof ApiError && err.status === 404) return 'stop';
  return browserGaveUp ? 'reconnect' : 'wait';
}

/** How far from the bottom of the messages still counts as at the bottom: fractions of a pixel from zoom. */
export const BOTTOM_SLACK = 4;

/**
 * How near the bottom scrolling down starts following again. While a reply streams, the browser stops a
 * scroll at the bottom as it was, and a line or two more has come in below by the time its event comes.
 */
export const FOLLOW_AGAIN = 80;

/** How a scrolled list stands: how far it is scrolled, and how far that is from its bottom. */
export interface ScrollSpot {
  top: number;
  distance: number;
}

type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Where `scroll` stands now. */
export function scrollSpot(scroll: ScrollBox): ScrollSpot {
  return { top: scroll.scrollTop, distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight };
}

/**
 * Whether the messages keep following new output after they moved to `scroll` from `previous`.
 * Reaching the bottom starts following, and so does scrolling down to near it (`FOLLOW_AGAIN`). Scrolling
 * up stops it, however near the bottom it stops, so a reader a few lines up is never pulled down. Anything
 * else leaves it as it was: more came in below while the list stayed (it still follows when it did), the
 * reader scrolled down but not near the bottom, or the browser moved the list down as much as content
 * above it grew to keep the reader's place (scroll anchoring: as far from the bottom as before).
 */
export function followsAfterScroll(following: boolean, previous: ScrollSpot, scroll: ScrollBox): boolean {
  const { top, distance } = scrollSpot(scroll);
  if (distance <= BOTTOM_SLACK) return true;
  if (top < previous.top) return false;
  // Nearer the bottom than before, beyond a pixel of rounding: the reader scrolled down.
  if (previous.distance - distance > BOTTOM_SLACK && distance <= FOLLOW_AGAIN) return true;
  return following;
}

/**
 * Whether the button that takes the messages to their end shows (above the message box): while they do
 * not follow new output and there is more below than a fraction of a pixel, because the reader scrolled
 * up, or opened part of a message and more came in under it. While they follow, they are at the end, or
 * within `FOLLOW_AGAIN` of it after a scroll down, where new output takes them the rest of the way.
 */
export function showsToEnd(following: boolean, spot: ScrollSpot): boolean {
  return !following && spot.distance > BOTTOM_SLACK;
}

/**
 * Whether a turn's changes were made in the team's own worktrees (`TEAM_WORKTREE`), which every member
 * works in while another conversation changes the folder: their branch is the team's, which no
 * agent's can be (an agent's name has no `@`).
 */
export function isTeamResult(changes: readonly MessageChanges[] | undefined): boolean {
  return Boolean(changes?.some((c) => c.isolated && c.branch?.endsWith(`/${TEAM_WORKTREE}`)));
}

/**
 * Whose worktrees a reply's changes are in, as `Conversation.worktrees` keys them: the team's own for
 * a turn made there, else the agent's.
 */
export function resultOwner(m: ChatMessage): string | undefined {
  if (m.author.kind !== 'agent') return undefined;
  return isTeamResult(m.changes) ? TEAM_WORKTREE : m.author.agentId;
}

/**
 * Which results can be applied: each agent's latest worktree result (or the team's, in its own
 * worktrees: its latest reply made there, whoever wrote it), but only while it belongs to the owner's
 * current worktrees. After a result is applied or the chat is rewound, the worktrees are
 * recreated from new snapshots (`base`) under the same branch name; the first result made in one starts
 * from its base, so an agent with no result starting there has nothing in its current worktrees yet.
 * A result changes one or more repositories (one worktree of the agent's each): each must be current.
 * Applying applies all of the agent's worktrees; it is stale once any of them needs a reset.
 */
export function applyStates(messages: ChatMessage[], worktrees: Record<string, AgentWorktree[]>): Map<string, ApplyState> {
  const latest = new Map<string, string>(); // owner (agent id, or the team's) → message id
  const current = new Set<string>(); // owners with a result made in their current worktrees
  for (const m of messages) {
    const sets = (m.changes ?? []).filter((c) => c.isolated);
    const owner = resultOwner(m);
    if (!owner || !sets.length || m.status === 'streaming') continue;
    const wts = worktrees[owner] ?? [];
    if (!wts.length) continue;
    latest.set(owner, m.id);
    if (sets.every((c) => wts.some((w) => w.root === c.root && w.base === c.base))) current.add(owner);
  }
  const out = new Map<string, ApplyState>();
  for (const [owner, messageId] of latest) {
    if (current.has(owner)) out.set(messageId, worktrees[owner]!.some((w) => w.needsReset) ? 'stale' : 'available');
  }
  return out;
}

/**
 * The conversation a branch comes from, as the line after its copied messages names it: by its title
 * now, or once it has been deleted (`gone`) by the title it had when it was branched. Until the
 * conversation list has loaded (`list` undefined) it is taken to be there.
 */
export function branchSource(
  branch: ConversationBranch,
  list?: Pick<ConversationSummary, 'id' | 'title'>[],
): { title: string; gone: boolean } {
  const found = list?.find((c) => c.id === branch.fromId);
  if (found) return { title: found.title, gone: false };
  return { title: branch.fromTitle, gone: list !== undefined };
}

/** JSON with sorted keys: equal content gives equal text whatever the key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_key, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

export function sameTeam(a: Team, b: Team): boolean {
  return canonical(a) === canonical(b);
}

/** The members whose CLI cannot take a message into a running turn (steering, `STEER_PROVIDERS`). */
export function cannotSteer(agents: readonly AgentConfig[]): AgentConfig[] {
  return agents.filter((a) => !STEER_PROVIDERS.includes(a.provider));
}

/**
 * The names of the members a user message went into the running turn of (`ChatMessage.steered`), as the
 * team has them now ("@Alice, @Bob"); a member who left since is left out.
 */
export function steeredNames(msg: Pick<ChatMessage, 'steered'>, agents: readonly AgentConfig[]): string {
  return (msg.steered ?? [])
    .flatMap((id) => agents.find((a) => a.id === id) ?? [])
    .map((a) => `@${a.name}`)
    .join(', ');
}

/**
 * The switches the team drawer saves through requests of their own, at any time: lead review (read once
 * the team has answered) and steering (read as each message is sent).
 */
export const RUN_SWITCHES = ['leadReview', 'steer'] as const;
export type RunSwitch = (typeof RUN_SWITCHES)[number];

/**
 * The team drawer saves only its switches (`RUN_SWITCHES`), each through its own request: while the team
 * replies (when nothing else may be saved), and only when they are all the draft changes. Not while a
 * design waits for confirmation (`proposed`): saving there confirms the design, which the drawer's usual
 * save does. The switches to save, or none.
 */
export function savesSwitchesAlone(base: Team, draft: Team, running: boolean, proposed: boolean): RunSwitch[] {
  return running && !proposed ? onlySwitches(base, draft) : [];
}

/** The switches the draft changes (`RUN_SWITCHES`), when they are all it changes; else none. */
export function onlySwitches(base: Team, draft: Team): RunSwitch[] {
  const changed = RUN_SWITCHES.filter((k) => Boolean(base.settings[k]) !== Boolean(draft.settings[k]));
  if (!changed.length) return [];
  const without = (t: Team): Team => {
    const settings = { ...t.settings };
    for (const k of RUN_SWITCHES) delete settings[k];
    return { ...t, settings };
  };
  return sameTeam(without(base), without(draft)) ? changed : [];
}

/**
 * The team drawer edits a copy (`draft`) of the conversation's team as it was when the copy was made
 * (`base`). When the team changes underneath (the lead agent designed it, another tab saved it), an
 * untouched draft follows it ('refresh'); an edited one must not be saved over it ('conflict'), unless
 * the team now is what the draft says (e.g. the draft was just saved).
 */
/**
 * The team the team drawer edits: the lead agent's design while it waits for confirmation (`pending`,
 * see `pendingPlan`; saving settles the design with the team as edited), otherwise the conversation's team.
 */
export function teamToEdit(conv: Pick<Conversation, 'agents' | 'settings'>, pending?: TeamPlan): { team: Team; proposed: boolean } {
  if (pending?.agents?.length && pending.settings) {
    return { team: { agents: pending.agents, settings: { ...conv.settings, ...pending.settings } }, proposed: true };
  }
  return { team: { agents: conv.agents, settings: conv.settings }, proposed: false };
}

export function draftStatus(base: Team, draft: Team, current: Team): 'same' | 'refresh' | 'conflict' {
  if (sameTeam(base, current)) return 'same';
  return sameTeam(base, draft) || sameTeam(draft, current) ? 'refresh' : 'conflict';
}

/** What the lead agent changes in a team (team drawer): its members and how they take turns. */
export function teamTurns(team: Team): Pick<TeamRevision, 'agents' | 'settings'> {
  const { mode, rounds, maxHops } = team.settings;
  return { agents: team.agents, settings: { mode, rounds, maxHops } };
}

/** What the drawer sends the lead agent: the request, the members, how they take turns, and (for the lead to read) the permission and folders the drawer has, saved or not. */
export function reviseRequest(request: string, team: Team): ReviseTeamRequest {
  const { agents, settings } = teamTurns(team);
  const { permission, cwd, extraCwds } = team.settings;
  return { request, agents, settings: { ...settings, permission, cwd, ...(extraCwds?.length ? { extraCwds } : {}) } };
}

/**
 * The drawer's one button is Ask, then Stop while the lead agent works, then Ask again. Right after it
 * changes it is held (shown dimmed, clicks do nothing) for a moment, so a double-click does not ask and
 * then stop, and a click meant for Stop that lands just after the answer does not ask again.
 */
export const BUTTON_HOLD_MS = 600;

export function buttonHeld(changedAt: number | undefined, now: number): boolean {
  return changedAt !== undefined && now - changedAt < BUTTON_HOLD_MS;
}

/**
 * Where the focus goes once the lead agent answers: to the request box when it would otherwise be lost
 * (on the page, or on the button now disabled because the box was emptied); otherwise it stays.
 */
export function focusBoxAfterAnswer(focus: { onPage: boolean; onButton: boolean; buttonDisabled: boolean }): boolean {
  return focus.onPage || (focus.onButton && focus.buttonDisabled);
}

/** A member as it works: an empty model or effort is the default, and space around a role means nothing. */
function working(a: AgentConfig) {
  return { name: a.name, provider: a.provider, role: a.role.trim(), model: a.model || undefined, effort: a.effort || undefined };
}

/** What changed in a team, member by member (by id), then in how they take turns. */
export type TeamChange =
  | { kind: 'added'; name: string; provider: Provider }
  | { kind: 'removed'; name: string }
  | { kind: 'renamed'; from: string; name: string }
  | { kind: 'cli'; name: string; provider: Provider }
  | { kind: 'role'; name: string }
  | { kind: 'model'; name: string }
  | { kind: 'order' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'rounds'; rounds: number }
  | { kind: 'hops'; maxHops: number };

/**
 * What changed from `before` to `after`, as the user should check it: members added, removed,
 * renamed, moved to another CLI, with another role, model or effort; the speaking order; and the mode
 * and its rounds or hand-offs. Empty when the team works the same (an empty model and none are the
 * same, and so are roles that differ only in surrounding space).
 */
export function teamChanges(before: Team, after: Team): TeamChange[] {
  const out: TeamChange[] = [];
  const was = new Map(before.agents.map((a) => [a.id, a]));
  const now = new Set(after.agents.map((a) => a.id));
  for (const a of after.agents) {
    const b = was.get(a.id);
    if (!b) {
      out.push({ kind: 'added', name: a.name, provider: a.provider });
      continue;
    }
    const x = working(b);
    const y = working(a);
    if (x.name !== y.name) out.push({ kind: 'renamed', from: x.name, name: y.name });
    if (x.provider !== y.provider) out.push({ kind: 'cli', name: y.name, provider: y.provider });
    if (x.role !== y.role) out.push({ kind: 'role', name: y.name });
    if (x.model !== y.model || x.effort !== y.effort) out.push({ kind: 'model', name: y.name });
  }
  for (const b of before.agents) if (!now.has(b.id)) out.push({ kind: 'removed', name: b.name });
  const order = (team: Team, keep: (id: string) => boolean) =>
    team.agents
      .map((a) => a.id)
      .filter(keep)
      .join('\n');
  if (order(before, (id) => now.has(id)) !== order(after, (id) => was.has(id))) out.push({ kind: 'order' });
  const s = before.settings;
  const t = after.settings;
  if (s.mode !== t.mode) out.push({ kind: 'mode', mode: t.mode });
  if (t.mode === 'relay' ? s.maxHops !== t.maxHops : s.rounds !== t.rounds) {
    out.push(t.mode === 'relay' ? { kind: 'hops', maxHops: t.maxHops } : { kind: 'rounds', rounds: t.rounds });
  }
  return out;
}

/**
 * The drawer's team as the lead agent changed it: its members and how they take turns; everything else
 * (working directory, permission, approvals, auto team) stays as it was in the drawer, and so does each
 * member the lead left as it works (as the drawer had it, not as the server spells it).
 */
export function revisedTeam(draft: Team, revision: Pick<TeamRevision, 'agents' | 'settings'>): Team {
  const was = new Map(draft.agents.map((a) => [a.id, a]));
  const agents = revision.agents.map((a) => {
    const b = was.get(a.id);
    return b &&
      JSON.stringify(working(a)) === JSON.stringify(working(b)) &&
      canonical(a.tools ?? {}) === canonical(b.tools ?? {}) &&
      canonical(limitsKey(a)) === canonical(limitsKey(b))
      ? b
      : a;
  });
  return { agents, settings: { ...draft.settings, ...revision.settings } };
}

/**
 * What the drawer does with the lead agent's answer. `sent`: the drawer's team when it asked; `now`:
 * its team now; `blocked`: the drawer cannot save its team (the team changed underneath, see
 * `draftStatus`). Stale when the drawer's team is no longer the one the lead changed, or could not be
 * saved anyway; unchanged when the lead's team works the same; otherwise the team to show, and what
 * changed in it.
 */
export type RevisionOutcome = { kind: 'stale' } | { kind: 'unchanged' } | { kind: 'changed'; team: Team; changes: TeamChange[] };

export function revisionOutcome(o: {
  sent: Team;
  now: Team;
  blocked: boolean;
  revision: Pick<TeamRevision, 'agents' | 'settings'>;
}): RevisionOutcome {
  if (o.blocked || !sameTeam(o.now, o.sent)) return { kind: 'stale' };
  const team = revisedTeam(o.sent, o.revision);
  const changes = teamChanges(o.sent, team);
  return changes.length ? { kind: 'changed', team, changes } : { kind: 'unchanged' };
}

/** A phone or tablet: touch is the main input and nothing hovers (like `@media (hover: none)` in styles.css). */
export function isTouchScreen(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * Whether a key press in a message box sends what was typed. Enter sends; Shift+Enter starts a new line.
 * On a touch screen Enter starts a new line, since an on-screen keyboard has no Shift+Enter, and the send
 * button sends; ⌘/Ctrl+Enter from a hardware keyboard still sends.
 */
export function enterSends(key: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, touch: boolean): boolean {
  if (key.key !== 'Enter' || key.shiftKey) return false;
  return !touch || key.metaKey || key.ctrlKey;
}

export type ToolPart = Extract<MessagePart, { type: 'tool' }>;
export type ApprovalPart = Extract<MessagePart, { type: 'approval' }>;

/**
 * One step of an agent's work between its words: a tool call, or a stretch of its reasoning. A call
 * that started a subagent holds the subagent's own calls (`steps`: those whose `parentId` is its id),
 * which are never steps of the block themselves.
 */
export type ActivityItem = ToolItem | { kind: 'thinking'; text: string; key: number };
export type ToolItem = { kind: 'tool'; part: ToolPart; key: number; steps?: ActivityItem[] };

/**
 * How an agent's message is drawn, in order. Tool calls and thinking that follow each other, with no reply
 * text between them, make one `activity` block: a single row that opens to show every step.
 */
export type Segment =
  | { kind: 'text'; text: string; key: number }
  | { kind: 'activity'; items: ActivityItem[]; key: number; last: boolean }
  | { kind: 'todo'; entries: PlanEntry[]; key: number }
  | { kind: 'approval'; part: ApprovalPart; key: number }
  | { kind: 'progress'; status: ProgressStatus; text: string; key: number }
  | { kind: 'outbox'; part: OutboxPart; key: number }
  /** The agent handed the chat's browser to the user (`browser_hand_over`). */
  | { kind: 'handover'; part: HandoverPart; key: number }
  /** What the reply saved to long-term memory. */
  | { kind: 'memory'; part: MemoryPart; key: number }
  /** A schedule the reply proposed, for the user to create or dismiss. */
  | { kind: 'schedule'; part: SchedulePart; key: number }
  /** What Harness Relay noted about the turn (an MCP server left out of it), not the agent's words. */
  | { kind: 'notice'; text: string; key: number }
  /** The secrets the reply asks the user for. */
  | { kind: 'secrets'; part: Extract<MessagePart, { type: 'secrets' }>; key: number }
  /** A fixed command the reply proposes. */
  | { kind: 'command'; part: Extract<MessagePart, { type: 'command' }>; key: number }
  | { kind: 'command-changed'; part: Extract<MessagePart, { type: 'command-changed' }>; key: number }
  /** Steps the reply asks the user to take outside Harness Relay. */
  | { kind: 'steps'; part: StepsPart; key: number }
  /** A command the reply asks the user to run themselves. */
  | { kind: 'interactive'; part: Extract<MessagePart, { type: 'interactive' }>; key: number };

export type OutboxPart = Extract<MessagePart, { type: 'outbox' }>;
export type MemoryPart = Extract<MessagePart, { type: 'memory' }>;
export type SchedulePart = Extract<MessagePart, { type: 'schedule' }>;

/**
 * Text that comes into the message box (`Composer`'s `restore`): ahead of what is typed there. A
 * withdrawn message always comes back; a lead review's next step (`once`) not when the box has it
 * already, so asking twice does not send it twice.
 */
export function restoredText(current: string, restore: { text: string; once?: boolean }): string {
  if (restore.once && current.includes(restore.text)) return current;
  return current.trim() ? `${restore.text}\n${current}` : restore.text;
}

/**
 * A message's parts as segments. Blank text and thinking are left out, so they don't split a run of
 * activity. Keys are the index of the segment's first part, so a block keeps its key (and stays open or
 * closed) while more steps stream into it. `last` marks an activity block that ends the message.
 */
export function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  const step = (item: ActivityItem) => {
    const prev = out[out.length - 1];
    if (prev?.kind === 'activity') prev.items.push(item);
    else out.push({ kind: 'activity', items: [item], key: item.key, last: false });
  };
  /** Every call so far, by id: a subagent's call goes into the one that started it, wherever that is. */
  const calls = new Map<string, ToolItem>();
  parts.forEach((p, i) => {
    switch (p.type) {
      case 'text':
        if (p.text.trim()) out.push({ kind: 'text', text: p.text, key: i });
        break;
      case 'thinking':
        if (p.text.trim()) step({ kind: 'thinking', text: p.text, key: i });
        break;
      case 'tool': {
        const item: ToolItem = { kind: 'tool', part: p, key: i };
        // A call whose parent is not (or not yet) in the message stands on its own.
        const parent = p.parentId ? calls.get(p.parentId) : undefined;
        if (parent) (parent.steps ??= []).push(item);
        else step(item);
        if (!calls.has(p.id)) calls.set(p.id, item);
        break;
      }
      case 'plan':
        if (p.entries.length) out.push({ kind: 'todo', entries: p.entries, key: i });
        break;
      case 'approval':
        out.push({ kind: 'approval', part: p, key: i });
        break;
      case 'progress':
        out.push({ kind: 'progress', status: p.status, text: p.text, key: i });
        break;
      case 'outbox':
        out.push({ kind: 'outbox', part: p, key: i });
        break;
      case 'handover':
        out.push({ kind: 'handover', part: p, key: i });
        break;
      case 'memory':
        if (p.notes.length) out.push({ kind: 'memory', part: p, key: i });
        break;
      case 'schedule':
        // A part a server kept that this one could not read again has no message: nothing to create.
        if (p.proposal.text) out.push({ kind: 'schedule', part: p, key: i });
        break;
      case 'notice':
        out.push({ kind: 'notice', text: p.text, key: i });
        break;
      case 'secrets':
        if (p.asks.length) out.push({ kind: 'secrets', part: p, key: i });
        break;
      case 'command':
        out.push({ kind: 'command', part: p, key: i });
        break;
      case 'command-changed':
        if (p.commandId) out.push({ kind: 'command-changed', part: p, key: i });
        break;
      case 'steps':
        if (p.items.length) out.push({ kind: 'steps', part: p, key: i });
        break;
      case 'interactive':
        out.push({ kind: 'interactive', part: p, key: i });
        break;
    }
  });
  const end = out[out.length - 1];
  if (end?.kind === 'activity') end.last = true;
  return out;
}

/**
 * What a reply shows of its segments: all of them, or for a reply whose agent passed only Harness
 * Relay's own notes (an MCP server left out of the turn), what it saved to long-term memory and a
 * schedule it proposed, which stay shown with the pass. `typing`: the
 * agent has shown nothing yet while it streams (a note is not its words).
 */
export function shownSegments(segs: Segment[], passed: boolean, live: boolean): { shown: Segment[]; typing: boolean } {
  return {
    shown: passed ? segs.filter((s) => s.kind === 'notice' || s.kind === 'memory' || s.kind === 'schedule') : segs,
    typing: live && segs.every((s) => s.kind === 'notice'),
  };
}

/**
 * How many tool calls, stretches of thinking and failed calls an activity block (or a subagent) holds:
 * its own steps, a subagent counting as one, its own calls counted in its row.
 */
export function activityCounts(items: ActivityItem[]): { actions: number; thoughts: number; failed: number } {
  let actions = 0;
  let failed = 0;
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    actions++;
    if (item.part.status === 'error') failed++;
  }
  return { actions, thoughts: items.length - actions, failed };
}

/** Whether a step is a call that started a subagent: the CLI named the subagent, or it made calls of its own. */
export function isSubagent(item: ActivityItem): boolean {
  return item.kind === 'tool' && (Boolean(item.part.agent) || Boolean(item.steps?.length));
}

/** What a subagent's row calls it: its name (`Explore`) when the CLI gave one, else the call's. */
export function subagentName(part: ToolPart): string {
  return part.agent ?? part.name;
}

/** Whether a call is still at work: running itself, or a subagent with a call of its own still running. */
function atWork(item: ActivityItem): item is ToolItem {
  return item.kind === 'tool' && (item.part.status === 'running' || Boolean(item.steps?.some(atWork)));
}

/**
 * The step a live activity block is on, for its folded row: the first call still at work and, inside a
 * subagent, the latest of its own calls still at work, one subagent within another (`agents`: their
 * names, outermost first). `part` is that call; for a subagent between calls (thinking), the subagent's
 * own call, with `agents` naming the subagents around it only.
 */
export function runningStep(items: ActivityItem[]): { agents: string[]; part: ToolPart } | undefined {
  let item = items.find(atWork);
  if (!item) return undefined;
  const agents: string[] = [];
  for (;;) {
    const inner: ToolItem | undefined = item.steps?.filter(atWork).pop();
    if (!inner) return { agents, part: item.part };
    agents.push(subagentName(item.part));
    item = inner;
  }
}

/**
 * Whether a tool row's detail is a file or folder path, which loses its start rather than its file
 * name when it does not fit. The server cuts a long path at its start ("…/dir/file.ts"), and any
 * other detail at its end ("npm run …"), so either says which it is. Otherwise a path is one word with a slash in it (a
 * backslash only where a Windows path has one, so a regex's `\(` is not a path), with none of the
 * characters commands, globs and patterns use, and not a URL (those keep their site). A path with
 * a space in it, unless the server cut it, is cut at the end like any other detail.
 */
export function isPathDetail(detail: string): boolean {
  // Only clipPath() puts an ellipsis first ("…/dir/file.ts", or "…name.ts" for a huge file name).
  if (detail.startsWith('…')) return !detail.endsWith('…');
  if (detail.endsWith('…') || /\s/.test(detail) || detail.includes('://') || /[|*;$"'<>=]/.test(detail)) return false;
  return detail.includes('/') || /^(?:[A-Za-z]:\\|\\\\|\.{1,2}\\|~\\)/.test(detail);
}

/** Past this many characters, an answered request's command is folded. */
export const FOLD_DETAIL_CHARS = 160;

/**
 * What an answered request shows of a long command until it is opened: its first line, and how many
 * lines come after it. None for a command short enough to show as it is (at most `FOLD_DETAIL_CHARS`
 * characters, on one line or a few short ones).
 */
export function foldedDetail(detail: string): { head: string; more: number } | undefined {
  const text = detail.trim();
  if (text.length <= FOLD_DETAIL_CHARS) return undefined;
  const lines = text.split('\n');
  return { head: lines[0].trim(), more: lines.length - 1 };
}

/** A line of thinking as a one-line preview: bold and heading marks taken out. */
function plainLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*/g, '')
    .trim();
}

/** The first line of a stretch of thinking (usually its heading), to name it in the open list. */
export function thoughtTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return plainLine(line);
}

/** The latest line of thinking, shown while it streams so you can follow along without opening it. */
export function thoughtTail(text: string): string {
  const line =
    text
      .split('\n')
      .filter((l) => l.trim())
      .pop() ?? '';
  return plainLine(line);
}
