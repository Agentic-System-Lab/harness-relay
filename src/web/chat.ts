import type { AgentWorktree, ChatMessage, Conversation, MessagePart, PlanEntry, TeamPlan, TeamRevision } from '../shared/types';
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

/**
 * The drawer's team as the lead agent changed it: its members and how they take turns; everything else
 * (working directory, permission, approvals, auto team) stays as it was in the drawer.
 */
export function revisedTeam(draft: Team, revision: Pick<TeamRevision, 'agents' | 'settings'>): Team {
  return { agents: revision.agents, settings: { ...draft.settings, ...revision.settings } };
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
