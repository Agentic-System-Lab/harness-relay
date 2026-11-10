import type {
  AgentConfig,
  AgentWorktree,
  ChatMessage,
  Conversation,
  ConversationBranch,
  ConversationSummary,
  MessagePart,
  Mode,
  PlanEntry,
  Provider,
  ReviseTeamRequest,
  TeamPlan,
  TeamRevision,
} from '../shared/types';
import { ApiError } from './api';
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

/**
 * Which results can be applied: each agent's latest worktree result, but only while it belongs to the
 * agent's current worktree. After a result is applied or the chat is rewound, the worktree is recreated
 * from a new snapshot (`base`) under the same branch name; the first result made in it starts from that
 * base, so an agent with no result starting there has nothing in its current worktree yet.
 */
export function applyStates(messages: ChatMessage[], worktrees: Record<string, AgentWorktree>): Map<string, ApplyState> {
  const latest = new Map<string, string>(); // agent id → message id
  const current = new Set<string>(); // agents with a result made in their current worktree
  for (const m of messages) {
    if (m.author.kind !== 'agent' || !m.changes?.isolated || m.status === 'streaming') continue;
    const agentId = m.author.agentId;
    const wt = worktrees[agentId];
    if (!wt) continue;
    latest.set(agentId, m.id);
    if (m.changes.base === wt.base) current.add(agentId);
  }
  const out = new Map<string, ApplyState>();
  for (const [agentId, messageId] of latest) {
    if (current.has(agentId)) out.set(messageId, worktrees[agentId]!.needsReset ? 'stale' : 'available');
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

/** What the drawer sends the lead agent: the request, the members, how they take turns, and (for the lead to read) the permission and folder the drawer has, saved or not. */
export function reviseRequest(request: string, team: Team): ReviseTeamRequest {
  const { agents, settings } = teamTurns(team);
  return { request, agents, settings: { ...settings, permission: team.settings.permission, cwd: team.settings.cwd } };
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
  const order = (team: Team, keep: (id: string) => boolean) => team.agents.map((a) => a.id).filter(keep).join('\n');
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
    return b && JSON.stringify(working(a)) === JSON.stringify(working(b)) && canonical(a.tools ?? {}) === canonical(b.tools ?? {}) ? b : a;
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

/** One step of an agent's work between its words: a tool call, or a stretch of its reasoning. */
export type ActivityItem = { kind: 'tool'; part: ToolPart; key: number } | { kind: 'thinking'; text: string; key: number };

/**
 * How an agent's message is drawn, in order. Tool calls and thinking that follow each other, with no reply
 * text between them, make one `activity` block: a single row that opens to show every step.
 */
export type Segment =
  | { kind: 'text'; text: string; key: number }
  | { kind: 'activity'; items: ActivityItem[]; key: number; last: boolean }
  | { kind: 'todo'; entries: PlanEntry[]; key: number }
  | { kind: 'approval'; part: ApprovalPart; key: number };

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
  parts.forEach((p, i) => {
    switch (p.type) {
      case 'text':
        if (p.text.trim()) out.push({ kind: 'text', text: p.text, key: i });
        break;
      case 'thinking':
        if (p.text.trim()) step({ kind: 'thinking', text: p.text, key: i });
        break;
      case 'tool':
        step({ kind: 'tool', part: p, key: i });
        break;
      case 'plan':
        if (p.entries.length) out.push({ kind: 'todo', entries: p.entries, key: i });
        break;
      case 'approval':
        out.push({ kind: 'approval', part: p, key: i });
        break;
    }
  });
  const end = out[out.length - 1];
  if (end?.kind === 'activity') end.last = true;
  return out;
}

/** How many tool calls, stretches of thinking and failed calls an activity block holds. */
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
  const line = text.split('\n').filter((l) => l.trim()).pop() ?? '';
  return plainLine(line);
}
