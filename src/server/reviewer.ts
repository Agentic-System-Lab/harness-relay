import {
  PROVIDER_LABEL,
  REVIEW_KINDS,
  REVIEW_LIMITS,
  cwdsOf,
  type AgentConfig,
  type ChatMessage,
  type ConversationSettings,
  type LeadReview,
  type ReviewHighlight,
  type ReviewKind,
  type ReviewStep,
} from '../shared/types';
import { quoteChecker, reviewStart } from '../shared/review';
import { t } from './i18n';
import { historyForLead, parsePlanReply } from './planner';

/*
 * Lead review (`ConversationSettings.leadReview`): once the team has answered, the lead agent (Settings)
 * reads what the team said since its last review, and tells the user what to look at closely in it
 * (highlights, each quoting the words of a reply it is about, which the chat marks in that reply) and
 * what to do next (steps for the user, and steps to ask the team for, with the message to send it).
 * Its reply is a JSON object, checked here: a highlight names a reply the lead was shown, and keeps its
 * quote only when that reply has those words.
 */

export const REVIEWER_BRIEFING =
  'You are the lead agent of Harness Relay, a group chat in which coding-agent CLIs (Claude Code, Codex, Grok, Cursor, Antigravity, GitHub Copilot, Muse Code, and open-source ones such as OpenCode, Goose, Cline, OpenHands and Pi) ' +
  "work together on the user's questions. Right now your only job is to review the team's latest replies for the user: point out what the user should look at closely, and suggest the next steps. " +
  'Do not answer the question, continue the work or change anything yourself. Reply with the JSON object you are asked for and nothing else.';

/** How much of what was said since the last review the lead reads: each message, and all of them (the latest are kept). */
const REVIEW_MESSAGE_CHARS = 6000;
const REVIEW_CHARS = 40000;
/** How much of each member's role it reads. */
const ROLE_CHARS = 300;

const KIND_HELP: Record<ReviewKind, string> = {
  risk: 'a bug, a security problem, data loss, a destructive or irreversible step, or a change beyond what was asked',
  decision: 'something the user has to decide or choose before the work can go on',
  conflict: 'members disagree, or a reply contradicts an earlier one',
  verify: 'a claim, assumption or result to check before relying on it (untested code, guessed facts, a step that failed or was skipped)',
  note: 'anything else the user would regret missing',
};

/** A message's text parts (no tool calls, thinking or files). */
function textOf(m: ChatMessage): string {
  return m.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n\n')
    .trim();
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The files a reply changed, as the lead reads them: `path (status)`, each repository's in turn. */
function changedFiles(m: ChatMessage): string[] {
  return (m.changes ?? []).flatMap((c) => c.files.map((f) => `${f.path} (${f.status})`));
}

/** A reply the lead may review: an agent's, finished, that says something or changed files (not a pass). */
function reviewable(m: ChatMessage): boolean {
  return m.author.kind === 'agent' && !m.passed && m.status !== 'streaming' && (textOf(m) !== '' || changedFiles(m).length > 0);
}

/**
 * Whether the team's latest run gives the lead something to review: since its last review, a member
 * replied (finished, not a pass).
 */
export function hasNewReplies(messages: ChatMessage[]): boolean {
  return messages.slice(reviewStart(messages)).some((m) => m.author.kind === 'agent' && m.status === 'done' && !m.passed && reviewable(m));
}

/** What a review reads: what was said since the last review, with the conversation before it as context. */
export interface ReviewMaterial {
  /** The conversation before what it reads, as the lead reads it (`historyForLead`). */
  history: string;
  /** The user's messages and the team's replies since the last review, as the prompt shows them. */
  recent: string;
  /** The replies the lead can name, by their number in `recent` (reply 1 first). */
  replies: ChatMessage[];
  /** The first message it reads (`LeadReview.fromId`). */
  fromId?: string;
  /** What the lead's last review said (its summary, highlights and steps), so it does not say it again. */
  previous?: string;
}

/** What a ready review said, as the lead reads it again: its summary, its notes and its steps. */
function previousReview(review: LeadReview): string {
  const lines = [
    ...(review.summary ? [`Summary: ${review.summary}`] : []),
    ...(review.highlights ?? []).map((h) => `- ${h.kind}${h.agentName ? ` (@${h.agentName})` : ''}: ${h.note}`),
    ...(review.nextSteps ?? []).map((st) => `- next step for the ${st.by}: ${st.text}`),
  ];
  return lines.join('\n');
}

/**
 * The conversation as a review reads it: since the last review that was ready, the user's messages
 * and the team's replies, the replies numbered (each shortened, the oldest left out when it is long),
 * with what each reply's turn changed and how a failed one ended; before that, the conversation as the
 * lead reads it for a team design.
 */
export function reviewMaterial(messages: ChatMessage[]): ReviewMaterial {
  const start = reviewStart(messages);
  const last = messages.slice(0, start).findLast((m) => m.review?.status === 'ready')?.review;
  const items: { text: string; reply?: ChatMessage }[] = [];
  for (const m of messages.slice(start)) {
    if (m.author.kind === 'system') continue;
    if (m.author.kind === 'user') {
      const files = m.parts.flatMap((p) => (p.type === 'attachment' ? [p.name] : []));
      const text = [textOf(m), files.length ? `(Attached files: ${files.join(', ')})` : ''].filter(Boolean).join('\n');
      if (text) items.push({ text: `<message from="user">\n${shorten(text, REVIEW_MESSAGE_CHARS)}\n</message>` });
      continue;
    }
    if (!reviewable(m)) continue;
    const files = changedFiles(m);
    const ending =
      m.status === 'error' ? ` status="failed: ${(m.error ?? '').replace(/["\n]/g, ' ').slice(0, 200)}"` : m.status === 'aborted' ? ' status="stopped"' : '';
    const body = [shorten(textOf(m), REVIEW_MESSAGE_CHARS), files.length ? `(Files this turn changed: ${files.join(', ')})` : '']
      .filter(Boolean)
      .join('\n\n');
    const who = `@${m.agentName ?? 'agent'}${m.provider ? ` (${PROVIDER_LABEL[m.provider]})` : ''}`;
    items.push({ text: `<reply n="{n}" from="${who}"${m.asked ? ' asked_the_user="yes"' : ''}${ending}>\n${body}\n</reply>`, reply: m });
  }
  // The latest are kept; replies are numbered among those kept, oldest first.
  const kept: typeof items = [];
  let size = 0;
  let cut = false;
  for (let i = items.length - 1; i >= 0; i--) {
    size += items[i]!.text.length + 2;
    if (size > REVIEW_CHARS && kept.length) {
      cut = true;
      break;
    }
    kept.unshift(items[i]!);
  }
  const replies: ChatMessage[] = [];
  const lines = kept.map((item) => {
    if (!item.reply) return item.text;
    replies.push(item.reply);
    return item.text.replace('{n}', String(replies.length));
  });
  const previous = last && previousReview(last);
  return {
    history: historyForLead(messages.slice(0, start)),
    recent: [...(cut ? ['(earlier messages left out)'] : []), ...lines].join('\n\n'),
    replies,
    ...(messages[start] ? { fromId: messages[start]!.id } : {}),
    ...(previous ? { previous } : {}),
  };
}

/** A member's worktrees in parallel mode, where what it changed is until the user applies it. */
export interface MemberWorktrees {
  name: string;
  dirs: string[];
}

/** The team as the lead reads it for a review: each member's name, CLI and the start of its role. */
function teamForReview(agents: AgentConfig[]): string {
  return agents
    .map((a) => {
      const role = a.role.trim().replace(/\s+/g, ' ');
      return `- @${a.name} (${PROVIDER_LABEL[a.provider]})${role ? `: ${shorten(role, ROLE_CHARS)}` : ''}`;
    })
    .join('\n');
}

export function buildReviewPrompt(
  material: ReviewMaterial,
  agents: AgentConfig[],
  settings: Pick<ConversationSettings, 'permission' | 'cwd' | 'extraCwds'>,
  worktrees: MemberWorktrees[] = [],
): string {
  const history = material.history.trim();
  const dirs = cwdsOf(settings);
  const isolated = worktrees.length
    ? `
The team worked in parallel, each member in git worktrees of its own: what a member changed is there, not in the working directories, until the user applies it. You may read them:
${worktrees.map((w) => `- @${w.name}: ${w.dirs.join(', ')}`).join('\n')}
`
    : '';
  return `The team has just answered. Review what it said since your last review, for the user, who reads it next: point out the places that need the user's close attention, and suggest what to do next.
${
  history
    ? `
The conversation before that, for context, oldest first (long messages are shortened):
<conversation>
${history}
</conversation>
`
    : ''
}
The team (members in speaking order):
${agents.length ? teamForReview(agents) : '(none now)'}

The file permission is "${settings.permission}" and ${dirs.length === 1 ? `the working directory is ${dirs[0]}` : `the working directories are ${dirs.join(', ')}`}.
${isolated}${
    material.previous
      ? `
What your last review told the user (do not say it again; point it out again only if a new reply makes it more pressing):
<last_review>
${material.previous}
</last_review>
`
      : ''
  }
What was said since your last review, oldest first; the team's replies are numbered:
<recent>
${material.recent}
</recent>

Highlights: point out only what matters, the most important first; fewer is better, and none is fine when nothing needs a closer look. At most ${REVIEW_LIMITS.highlights}. Each has a kind:
${REVIEW_KINDS.map((k) => `- ${k}: ${KIND_HELP[k]}`).join('\n')}
A highlight about one reply gives its number as "reply", and as "quote" the words of that reply it is about: copied exactly from the reply, as plain text without Markdown, a phrase or a sentence (under 200 characters), so that they can be found and marked in the reply. Leave out "reply" and "quote" for a point about the replies as a whole. Do not point out what the replies already make plain.

Next steps: at most ${REVIEW_LIMITS.nextSteps} concrete steps that move the work on, the most important first. "by": "team" for work the team can do, with "message": the message the user can send the team to ask for it, naming the members who should do it with @Name; "by": "user" for what only the user can do (decide, try it on their own machine, deploy, give access). None when the work is done and nothing is left to do.

Do not repeat or summarize each reply: the user reads them. Write the summary, notes and steps in the language the user writes in; quotes stay in the reply's own words. Do not use tools unless a highlight depends on checking a file (in the working directories${worktrees.length ? ", or a member's worktrees above" : ''}), and change nothing.

Reply with only this JSON object, in a \`\`\`json code block, with your review:
{"summary": "<where the team got to: one or two sentences>", "highlights": [{"kind": ${REVIEW_KINDS.map((k) => `"${k}"`).join(' | ')}, "reply": <its number>, "quote": "<exact words of that reply>", "note": "<why the user should look at it: one or two sentences>"}], "nextSteps": [{"text": "<the step: one short sentence>", "by": "team" | "user", "message": "<for the team: the message to send it>"}]}`;
}

/** A string field of the lead's reply, trimmed and cut to `max` characters ('' when it is none). */
function field(v: unknown, max: number): string {
  return typeof v === 'string' ? shorten(v.trim(), max) : typeof v === 'number' ? String(v) : '';
}

/** The reply a highlight names: its number (1 first), as a number or text, or `@Name` for that member's latest reply. */
function replyOf(v: unknown, replies: ChatMessage[]): ChatMessage | undefined {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (/^#?\d+$/.test(text)) return replies[Number(text.replace('#', '')) - 1];
  const name = text.replace(/^@/, '').toLowerCase();
  return name ? replies.findLast((m) => (m.agentName ?? '').toLowerCase() === name) : undefined;
}

/**
 * Turn the lead's JSON into a review: highlights with a known kind and a note, each about a reply it
 * was shown (or the replies as a whole), its quote kept only when that reply has those words; next
 * steps with text, the team's with the message to send it. Throws (with a user-readable message) when
 * the reply has none of it.
 */
export function decideReview(raw: Record<string, any>, replies: ChatMessage[]): Pick<LeadReview, 'summary' | 'highlights' | 'nextSteps'> {
  const summary = field(raw.summary, REVIEW_LIMITS.summary);
  const listed = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : []);
  const highlights: ReviewHighlight[] = [];
  // Each reply's pieces of text, read once for all the quotes about it.
  const checkers = new Map<string, ((quote: string) => boolean)[]>();
  const quoted = (reply: ChatMessage, quote: string) => {
    let pieces = checkers.get(reply.id);
    if (!pieces) checkers.set(reply.id, (pieces = reply.parts.flatMap((p) => (p.type === 'text' ? [quoteChecker(p.text)] : []))));
    return pieces.some((has) => has(quote));
  };
  for (const h of listed(raw.highlights)) {
    const note = field(h.note, REVIEW_LIMITS.note);
    if (!note) continue;
    const kind = REVIEW_KINDS.includes(h.kind as ReviewKind) ? (h.kind as ReviewKind) : 'note';
    const reply = replyOf(h.reply, replies);
    const quote = field(h.quote, REVIEW_LIMITS.quote);
    highlights.push({
      kind,
      note,
      ...(reply ? { messageId: reply.id, ...(reply.agentName ? { agentName: reply.agentName } : {}) } : {}),
      // Only words the reply has, in one of its pieces of text (the chat shows each on its own, between
      // its tool calls): the chat marks them there, and the card shows them as its words.
      ...(reply && quote && quoted(reply, quote) ? { quote } : {}),
    });
    if (highlights.length >= REVIEW_LIMITS.highlights) break;
  }
  const nextSteps: ReviewStep[] = [];
  for (const s of listed(raw.nextSteps ?? raw.next_steps)) {
    const text = field(s.text, REVIEW_LIMITS.step);
    const message = field(s.message, REVIEW_LIMITS.message);
    if (!text && !message) continue;
    const by = s.by === 'user' || s.by === 'team' ? s.by : message ? 'team' : 'user';
    const step = text || shorten(message, REVIEW_LIMITS.step);
    nextSteps.push({ text: step, by, ...(by === 'team' && message && message !== step ? { message } : {}) });
    if (nextSteps.length >= REVIEW_LIMITS.nextSteps) break;
  }
  const hasAny = summary || highlights.length || nextSteps.length;
  if (!hasAny && !('highlights' in raw) && !('nextSteps' in raw) && !('next_steps' in raw)) throw new Error(t().reviewUnparsable);
  return { ...(summary ? { summary } : {}), highlights, nextSteps };
}

/** The review in the lead's reply text (a ```json block, or the outermost braces). */
export function parseReviewReply(text: string, replies: ChatMessage[]): Pick<LeadReview, 'summary' | 'highlights' | 'nextSteps'> {
  let raw: Record<string, any>;
  try {
    raw = parsePlanReply(text);
  } catch {
    throw new Error(t().reviewUnparsable);
  }
  return decideReview(raw, replies);
}
