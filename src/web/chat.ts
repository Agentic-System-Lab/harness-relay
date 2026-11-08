import type { AgentWorktree, ChatMessage } from '../shared/types';
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
export function draftStatus(base: Team, draft: Team, current: Team): 'same' | 'refresh' | 'conflict' {
  if (sameTeam(base, current)) return 'same';
  return sameTeam(base, draft) || sameTeam(draft, current) ? 'refresh' : 'conflict';
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
