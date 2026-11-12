import {
  PROVIDER_LABEL,
  isInlineImage,
  type AgentConfig,
  type ChatMessage,
  type Conversation,
  type Mode,
  type NativeItemsOff,
  type NativePart,
  type Permission,
  type Provider,
  cwdsOf,
} from '../shared/types';
import { ASK_TOKEN } from '../shared/ask';
import { mentionsInMarkdown } from '../shared/mentions';
import { attachmentPath } from './attachments';
import type { AgentTools } from './tools';

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
      /**
       * Each working directory as the agent has it: inside its worktree of the directory's repository
       * (`cwd`; the first is where it runs), with the user's own folder (`userCwd`), the branch and the
       * snapshot commit the worktree started from. In the order of the working directories.
       */
      folders: { cwd: string; userCwd: string; branch: string; base: string }[];
      /**
       * Teammates' branches and the snapshot each one started from (they can differ), in each
       * repository (named by its first working directory).
       */
      teammates: { name: string; branch: string; bases: { folder: string; base: string }[] }[];
    };

function workspaceRules(conv: Conversation, ws: BriefingWorkspace): string {
  const cwds = cwdsOf(conv.settings);
  // Edit mode covers every working directory, not only the one the agent starts in.
  const text = PERMISSION_TEXT[conv.settings.permission];
  const access = `- File access: ${cwds.length > 1 && conv.settings.permission === 'edit' ? text.replace('the working directory', 'the working directories') : text}`;
  if (ws.kind === 'shared') {
    const where =
      cwds.length === 1
        ? `- All agents share the working directory: ${cwds[0]}`
        : `- All agents share these working directories, each with the same access: ${cwds.join(', ')}. You start in ${cwds[0]}; use full paths for the others.`;
    return `${where}
${access}
- Teammates may be changing the same files. Name the files you changed in your reply so others can review them.`;
  }
  const short = (c: string) => c.slice(0, 12);
  const one = ws.folders.length === 1;
  const mates = ws.teammates.length
    ? ws.teammates
        .map((t) =>
          one
            ? `@${t.name} → ${t.branch} (started from ${short(t.bases[0]!.base)})`
            : `@${t.name} → ${t.branch} (started from ${t.bases.map((b) => `${short(b.base)} in ${b.folder}`).join(', ')})`,
        )
        .join(', ')
    : '(none yet)';
  const own = one
    ? `- You work in your OWN isolated git worktree: ${ws.folders[0]!.cwd} (branch ${ws.folders[0]!.branch}). It started from a snapshot (${short(ws.folders[0]!.base)}) of the user's working directory ${ws.folders[0]!.userCwd}, which you must not modify.`
    : `- You work in your OWN isolated git worktrees, one for each of the user's working directories, which you must not modify:
${ws.folders.map((f) => `  - ${f.cwd} (branch ${f.branch}), from a snapshot (${short(f.base)}) of ${f.userCwd}`).join('\n')}
  You start in ${ws.folders[0]!.cwd}; use full paths for the others.`;
  return `${own}
- Teammates work in parallel in their own worktrees. Their branches: ${mates}. To read a teammate's work: \`git diff <the snapshot it started from> <branch>\` or \`git show <branch>:<path>\`${one ? '' : ', in that repository'}.
${access}
- Your changes are committed to your branch${one ? '' : 'es'} automatically after each turn; the user reviews the diffs and decides whose result to apply. Do not commit, merge, rebase or switch branches yourself.`;
}

/**
 * Whether an agent can read a file in its runs: not a Claude Code left with no tool that reads one
 * (all its built-in tools left out, or both `Read` and `Bash`).
 */
export function canReadFiles(provider: Provider, off: readonly NativePart[] = [], items: NativeItemsOff = {}): boolean {
  if (provider !== 'claude') return true;
  return !off.includes('tools') && !['Read', 'Bash'].every((tool) => items.tools?.includes(tool));
}

/**
 * The tool library's memory and skills for this agent, as briefing sections ('' when it gets neither).
 * `ownSkills`: the agent's CLI still loads its own skills (the user did not leave them out). `reads`:
 * it can read files; skills are read from their SKILL.md, so without that they are not listed.
 */
function toolSections(tools: Pick<AgentTools, 'memory' | 'skills'>, ownSkills: boolean, reads = true): string {
  const out: string[] = [];
  if (tools.memory) {
    out.push(`# Memory
Notes the user keeps for every agent in Harness Relay, shared by all conversations. Use them as background; what the user says in this chat takes precedence.
<memory>
${tools.memory}
</memory>`);
  }
  if (tools.skills.length && reads) {
    const list = tools.skills
      .map((s) => `- ${s.name}${s.description ? `: ${s.description.replace(/\s+/g, ' ')}` : ''} (${s.file})`)
      .join('\n');
    out.push(`# Skills
Skills are instructions for particular tasks, each in a SKILL.md file. When a task matches a skill's description, read its SKILL.md with your file-reading tool before you start, and follow it; paths in it are relative to the skill's folder.${ownSkills ? ' Skills your own CLI provides work as usual.' : ''}
${list}`);
  }
  return out.length ? `\n\n${out.join('\n\n')}` : '';
}

/**
 * The conversation's schedule, when it sends its message here: one that opens a new conversation each
 * time never does.
 */
function ownSchedule(conv: Conversation): Conversation['schedule'] {
  return conv.schedule && !conv.schedule.newChat ? conv.schedule : undefined;
}

/**
 * How to treat messages a schedule sends ('' when no schedule sends any here and there is no scheduled
 * message — a conversation a schedule opened has the message but no schedule of its own): the user
 * may be away, so a question can wait for hours. `unattended`: this run refuses approval requests.
 */
function scheduleRules(conv: Conversation, unattended: boolean): string {
  const s = ownSchedule(conv);
  if (!s && !conv.messages.some((m) => m.scheduled)) return '';
  // Full access asks nothing, so nothing is refused.
  const refused =
    (unattended || s?.approvals === 'deny') && conv.settings.permission !== 'full'
      ? ' In the runs a schedule starts, anything your file access does not cover is refused automatically (unless the user always allows it in this chat), so work within it.'
      : '';
  return `\n- A user message marked via="schedule" was sent automatically by a schedule the user set up, at a time they chose; they may not be watching. Do the task with reasonable assumptions and say what you assumed; ask the user (${ASK_TOKEN}) only when no reasonable answer is possible without them.${refused}`;
}

/**
 * A branch's copied messages speak of files as they were then: the conversation it was branched from
 * may have gone on and changed them since ('' for a conversation that is not a branch).
 */
function branchRules(conv: Conversation): string {
  if (!conv.branch) return '';
  return '\n- This chat was branched from an earlier one: the messages up to the branch point were copied from it, and that chat may have gone on and changed files in the working directory since. Check the files themselves rather than relying on what earlier messages say about them.';
}

/** The system-level briefing for one agent. Rebuilt on every turn so role edits take effect immediately. */
export function buildBriefing(
  conv: Conversation,
  agent: AgentConfig,
  ws: BriefingWorkspace = { kind: 'shared' },
  tools: Pick<AgentTools, 'memory' | 'skills'> = { skills: [] },
  /** What the user left out of this agent's CLI in Harness Relay's runs, all of a kind and single items. */
  nativeOff: readonly NativePart[] = [],
  nativeItems: NativeItemsOff = {},
  /** This run refuses approval requests: a schedule started it and nobody may be watching. */
  unattended = false,
): string {
  const { settings, agents } = conv;
  const order = agents.map((a) => `@${a.name}`).join(' → ');
  const team = agents
    .map((a) => `- @${a.name} (${PROVIDER_LABEL[a.provider]})${a.id === agent.id ? ' — this is you' : ''}: ${roleSummary(a.role)}`)
    .join('\n');

  return `You are @${agent.name}, one of several AI agents in "Harness Relay", a group chat where a human user works together with multiple AI agents (Claude Code, Codex, Grok, Cursor, Antigravity, and open-source coding agents such as OpenCode, Goose, Cline, OpenHands and Pi). Each agent is a separate program with its own tools and memory; you only learn what others did through the chat. Topics are not limited to programming — answer whatever the user brings, within your role.

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
- If a good answer depends on something only the user knows (their situation, goal, constraints or preference) and a guess would likely send your answer the wrong way, ask before answering: ask briefly (at most three questions, with options when that helps), don't answer yet, and end your reply with ${ASK_TOKEN} on its own line. The team then waits for the user; once they reply, you answer first, with their answer in hand. Don't ask about details you can reasonably assume — state the assumption and answer — and don't ask what the user or a teammate has already settled.
- Reply in the same language the user writes in.${scheduleRules(conv, unattended)}${branchRules(conv)}
- The chat renders Markdown, and \`\`\`mermaid code blocks are drawn as diagrams. To show an image or video (PNG, JPEG, GIF, WebP, AVIF, SVG, MP4, WebM, MOV), save it inside your working directory and embed it with a path relative to that directory, e.g. \`![Sales by month](charts/sales.png)\` or \`![Demo](out/demo.mp4)\`. Images from websites are shown only as links.
- To hand the user a file you made (a PDF, slides, a document, a spreadsheet, an archive…), save it inside your working directory and link it with a path relative to that directory, e.g. \`[Q3 report](out/report.pdf)\`, or \`[Deck](<out/Q3 deck.pptx>)\` when the path has spaces. The user downloads it from that link, on this computer or another device; only files inside your working directory can be downloaded.

# Workspace
${workspaceRules(conv, ws)}${toolSections(tools, !nativeOff.includes('skills'), canReadFiles(agent.provider, nativeOff, nativeItems))}`;
}

/**
 * The files a message's turn changed, as a block for teammates (empty when none): one for each
 * repository, which names it (`repository`) when the turn changed more than one.
 */
function changeLog(m: ChatMessage): string {
  const sets = (m.changes ?? []).filter((c) => c.files.length);
  return sets
    .map((c) => {
      const attrs = `${c.branch ? ` branch="${c.branch}"` : ''}${sets.length > 1 ? ` repository="${c.root}"` : ''}`;
      return `\n\n<changed_files${attrs}>\n${c.files
        .slice(0, 30)
        .map((f) => `${f.status} ${f.path}${f.added !== null ? ` (+${f.added} -${f.deleted})` : ''}`)
        .join('\n')}${c.files.length > 30 ? `\n… and ${c.files.length - 30} more` : ''}\n</changed_files>`;
    })
    .join('');
}

/**
 * Messages that are final and can be shown to teammates: finished ones, and agent replies that failed
 * or were stopped but said something or changed files (the files changed anyway).
 */
export function isForwardable(m: ChatMessage): boolean {
  if (m.author.kind === 'system') return false;
  if (m.status === 'done') return true;
  if (m.status !== 'error' && m.status !== 'aborted') return false;
  return Boolean(m.changes?.some((c) => c.files.length)) || m.parts.some((p) => p.type === 'text' && p.text.trim());
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
  return text + actionLog + changeLog(m);
}

export function senderName(conv: Conversation, m: ChatMessage): string {
  if (m.author.kind === 'user') return 'user';
  if (m.author.kind === 'system') return 'system';
  const { agentId } = m.author;
  return conv.agents.find((a) => a.id === agentId)?.name ?? m.agentName ?? 'agent';
}

/** The files attached to a user message, with the paths an agent can read them from. */
function attachmentList(conv: Conversation, m: ChatMessage): string {
  const files = m.parts.flatMap((p) => (p.type === 'attachment' ? [p] : []));
  if (!files.length) return '';
  const lines = files.map((f) => {
    const shown = isInlineImage(f.mimeType) ? ', also shown to you as an image' : '';
    return `- ${f.name} (${f.mimeType}, ${formatSize(f.size)}${shown}): ${attachmentPath(conv.id, f)}`;
  });
  return `<attachments>\nThe user attached these files; read them from these paths with your file tools:\n${lines.join('\n')}\n</attachments>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function renderMessage(conv: Conversation, m: ChatMessage): string {
  const from = senderName(conv, m);
  if (m.author.kind === 'user') {
    const via = m.scheduled ? ' via="schedule"' : '';
    return `<message from="user"${via}>\n${[forwardText(m), attachmentList(conv, m)].filter(Boolean).join('\n\n')}\n</message>`;
  }
  const via = m.provider ? ` via="${PROVIDER_LABEL[m.provider]}"` : '';
  const status = m.status === 'error' ? ' status="failed"' : m.status === 'aborted' ? ' status="stopped"' : '';
  // A [PASS] still reports the files its turn changed.
  const body = m.passed ? PASS_TOKEN + changeLog(m) : forwardText(m);
  return `<message from="@${from}"${via}${status}>\n${body}\n</message>`;
}

export interface TurnInfo {
  mode: Mode;
  round: number;
  rounds: number;
  /** Relay: who handed the floor over (undefined = the user). */
  handedBy?: string;
  hopsLeft?: number;
  /** This agent asked the user something, and the user has replied. */
  answered?: boolean;
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
  const answered = `You asked the user a question and their reply is among the messages above${
    ownSchedule(conv) || delta.some((m) => m.scheduled) ? ' (one marked via="schedule" is not their reply)' : ''
  }: now give your full answer, adjusted to it.`;
  if (turn.answered) {
    cue = `It's your turn, @${agent.name}. ${answered}`;
    if (turn.mode === 'relay') cue += ' Mention a teammate to hand off; otherwise the floor returns to the user.';
  } else if (turn.mode === 'relay') {
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

/**
 * Agents @mentioned in `text`, in order of first mention. The rule is shared with the UI's mention
 * highlighting (`src/shared/mentions.ts`): prose only — not code or link text — and text may follow a
 * name directly (`@Builder請實作`), while `@Bobby` is not `@Bob`.
 */
export function parseMentions(text: string, agents: AgentConfig[], exclude?: string): AgentConfig[] {
  return mentionsInMarkdown(
    text,
    agents.map((a) => a.name),
  )
    .map((name) => agents.find((a) => a.name === name)!)
    .filter((a) => a.id !== exclude);
}

export function isPass(text: string): boolean {
  return text.trim().replace(/[.。!！]$/, '').toUpperCase() === PASS_TOKEN;
}
