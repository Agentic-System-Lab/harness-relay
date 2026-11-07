import {
  PROVIDER_LABEL,
  type AgentConfig,
  type ChatMessage,
  type Conversation,
  type Mode,
  type Permission,
} from '../shared/types';

export const PASS_TOKEN = '[PASS]';

const MODE_RULES: Record<Mode, (order: string) => string> = {
  roundtable: (order) =>
    `This chat runs as a ROUNDTABLE. After the user speaks, agents reply one at a time in this order: ${order}. ` +
    'You see what earlier speakers said before your turn, so build on it, challenge it, or split up the work — never repeat it. ' +
    'There may be several rounds; later rounds are for reacting to each other and converging.',
  parallel: () =>
    'This chat runs in PARALLEL. In each round every agent answers at the same time without seeing the others’ answers for that round. ' +
    'In later rounds you will see the previous round’s answers and can critique, compare, or refine.',
  relay: () =>
    'This chat runs as a RELAY: only one agent speaks at a time. To hand the floor to a teammate, @mention them ' +
    '(for example "@Name please implement step 2"); every teammate you mention speaks next, in order. ' +
    'If you mention no teammate, the floor returns to the user. Only mention a teammate when you want them to act now; ' +
    'refer to teammates without the @ sign otherwise.',
};

const PERMISSION_TEXT: Record<Permission, string> = {
  'read-only': 'READ-ONLY. You may read files and inspect the project but must not modify anything; describe proposed changes instead.',
  edit: 'You may read and edit files inside the working directory.',
  full: 'Full access: you may edit files and run commands without approval. Be careful with destructive operations.',
};

function roleSummary(role: string): string {
  const first = role.trim().split('\n')[0] ?? '';
  return first.length > 160 ? first.slice(0, 159) + '…' : first || '(no specific role)';
}

/** Where an agent works this turn. */
export type BriefingWorkspace =
  | { kind: 'shared' }
  | {
      kind: 'isolated';
      /** Directory the agent runs in (inside its worktree). */
      cwd: string;
      branch: string;
      /** Snapshot commit all parallel worktrees started from. */
      base: string;
      teammates: { name: string; branch: string }[];
    };

function workspaceRules(conv: Conversation, ws: BriefingWorkspace): string {
  const access = `- File access: ${PERMISSION_TEXT[conv.settings.permission]}`;
  if (ws.kind === 'shared') {
    return `- All agents share the working directory: ${conv.settings.cwd}
${access}
- Teammates may be changing the same files. Name the files you changed in your reply so others can review them.`;
  }
  const base = ws.base.slice(0, 12);
  const mates = ws.teammates.length
    ? ws.teammates.map((t) => `@${t.name} → ${t.branch}`).join(', ')
    : '(none yet)';
  return `- You work in your OWN isolated git worktree: ${ws.cwd} (branch ${ws.branch}). It started from a snapshot (${base}) of the user's working directory ${conv.settings.cwd}, which you must not modify.
- Teammates work in parallel in their own worktrees. Their branches: ${mates}. To read a teammate's work: \`git diff ${base} <branch>\` or \`git show <branch>:<path>\`.
${access}
- Your changes are committed to your branch automatically after each turn; the user reviews the diffs and decides whose result to apply. Do not commit, merge, rebase or switch branches yourself.`;
}

/** The system-level briefing for one agent. Rebuilt on every turn so role edits take effect immediately. */
export function buildBriefing(conv: Conversation, agent: AgentConfig, ws: BriefingWorkspace = { kind: 'shared' }): string {
  const { settings, agents } = conv;
  const order = agents.map((a) => `@${a.name}`).join(' → ');
  const team = agents
    .map((a) => `- @${a.name} (${PROVIDER_LABEL[a.provider]})${a.id === agent.id ? ' — this is you' : ''}: ${roleSummary(a.role)}`)
    .join('\n');

  return `You are @${agent.name}, one of several AI agents in "Harness Relay", a group chat where a human user works together with multiple AI agents (Claude Code, Codex and Grok). Each agent is a separate program with its own tools and memory; you only learn what others did through the chat. Topics are not limited to programming — answer whatever the user brings, within your role.

# Your role
${agent.role.trim() || 'General-purpose assistant.'}

# Team
- @user — the human who leads the conversation
${team}

# How the chat works
- ${MODE_RULES[settings.mode](order)}
- Each turn you receive the chat messages that are new to you, wrapped in <message> tags. Your entire reply is posted to the group verbatim.
- Address teammates by @Name. Stay within your role; don't do a teammate's job unless asked.
- Be concise and don't restate what others already said. If you have nothing useful to add, reply with exactly ${PASS_TOKEN}.
- Reply in the same language the user writes in.

# Workspace
${workspaceRules(conv, ws)}`;
}

/** Text of a message as shown to other agents: reply text plus a compact log of actions taken. */
export function forwardText(m: ChatMessage): string {
  const text = m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text.trim())
    .filter(Boolean)
    .join('\n\n');
  const actions = m.parts
    .filter((p) => p.type === 'tool' && /edit|write|patch|shell|bash|command|exec|create|delete|move/i.test(p.name))
    .map((p) => (p.type === 'tool' ? `${p.name}${p.detail ? ` ${p.detail}` : ''}${p.status === 'error' ? ' (failed)' : ''}` : ''));
  const actionLog =
    actions.length > 0
      ? `\n\n<actions>\n${actions.slice(0, 12).join('\n')}${actions.length > 12 ? `\n… and ${actions.length - 12} more` : ''}\n</actions>`
      : '';
  const files = m.changes?.files ?? [];
  const changeLog = files.length
    ? `\n\n<changed_files${m.changes!.branch ? ` branch="${m.changes!.branch}"` : ''}>\n${files
        .slice(0, 30)
        .map((f) => `${f.status} ${f.path}${f.added !== null ? ` (+${f.added} -${f.deleted})` : ''}`)
        .join('\n')}${files.length > 30 ? `\n… and ${files.length - 30} more` : ''}\n</changed_files>`
    : '';
  return text + actionLog + changeLog;
}

export function senderName(conv: Conversation, m: ChatMessage): string {
  if (m.author.kind === 'user') return 'user';
  if (m.author.kind === 'system') return 'system';
  const { agentId } = m.author;
  return conv.agents.find((a) => a.id === agentId)?.name ?? m.agentName ?? 'agent';
}

export function renderMessage(conv: Conversation, m: ChatMessage): string {
  const from = senderName(conv, m);
  if (m.author.kind === 'user') return `<message from="user">\n${forwardText(m)}\n</message>`;
  const via = m.provider ? ` via="${PROVIDER_LABEL[m.provider]}"` : '';
  const body = m.passed ? PASS_TOKEN : forwardText(m);
  return `<message from="@${from}"${via}>\n${body}\n</message>`;
}

export interface TurnInfo {
  mode: Mode;
  round: number;
  rounds: number;
  /** Relay: who handed the floor over (undefined = the user). */
  handedBy?: string;
  hopsLeft?: number;
}

export function buildTurnPrompt(
  conv: Conversation,
  agent: AgentConfig,
  delta: ChatMessage[],
  fresh: boolean,
  turn: TurnInfo,
): string {
  const header =
    delta.length === 0
      ? 'There are no new chat messages since your last turn.'
      : fresh
        ? 'Here is the group chat so far:'
        : 'New chat messages since your last turn:';
  const chat = delta.length ? `\n<chat>\n${delta.map((m) => renderMessage(conv, m)).join('\n')}\n</chat>` : '';

  let cue: string;
  if (turn.mode === 'relay') {
    const by = turn.handedBy ? `@${turn.handedBy} handed the floor to you.` : 'The user is addressing you.';
    cue = `${by} It's your turn, @${agent.name}. Mention a teammate to hand off; otherwise the floor returns to the user.`;
    if (turn.hopsLeft !== undefined && turn.hopsLeft <= 2) cue += ` (Only ${turn.hopsLeft} handoff(s) left — wrap up soon.)`;
  } else {
    const label = turn.mode === 'roundtable' ? 'Roundtable' : 'Parallel';
    const roundText = turn.rounds > 1 ? ` round ${turn.round}/${turn.rounds}` : '';
    cue = `${label}${roundText}: it's your turn, @${agent.name}.`;
    if (turn.round > 1) cue += ` Reply with ${PASS_TOKEN} if you have nothing new to add.`;
  }
  return `${header}${chat}\n\n${cue}`;
}

/** Remove code (fenced and inline) so @mentions inside code samples are ignored. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** Agents @mentioned in `text`, in order of first appearance. */
export function parseMentions(text: string, agents: AgentConfig[], exclude?: string): AgentConfig[] {
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const out: AgentConfig[] = [];
  for (const m of stripCode(text).matchAll(/(^|[^\w@.])@([\p{L}\p{N}_-]+)/gu)) {
    const a = byName.get(m[2].toLowerCase());
    if (a && a.id !== exclude && !out.includes(a)) out.push(a);
  }
  return out;
}

export function isPass(text: string): boolean {
  return text.trim().replace(/[.。!！]$/, '').toUpperCase() === PASS_TOKEN;
}
