import {
  PROVIDER_LABEL,
  type AgentConfig,
  type ChatMessage,
  type Conversation,
  type Provider,
  type TeamPlan,
} from '../shared/types';
import type { Messages } from './i18n';

/** An opening or closing code fence: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Close a fenced code block left open at the end (a reply stopped mid-block), so that what follows it
 * in a transcript is not swallowed into the code block.
 */
export function closeFences(text: string): string {
  let open: { indent: string; fence: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE.exec(line);
    if (!m) continue;
    const [, indent, fence, rest] = m;
    if (open === null) {
      // A backtick fence's info string cannot contain backticks (that is inline code instead).
      if (!(fence![0] === '`' && rest!.includes('`'))) open = { indent: indent!, fence: fence! };
    } else if (fence![0] === open.fence[0] && fence!.length >= open.fence.length && !rest!.trim()) {
      open = null;
    }
  }
  // Closed with the opener's indentation, so a block inside a list item is closed inside that item.
  return open === null ? text : `${text}${text.endsWith('\n') ? '' : '\n'}${open.indent}${open.fence}`;
}

/** Drop blank lines around a text block, keeping the first line's indentation (an indented code block). */
function tidy(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/** A message's text as Markdown. Tool activity is left out. */
export function messageText(m: ChatMessage): string {
  const texts = m.parts.flatMap((p) => (p.type === 'text' ? [tidy(p.text)] : [])).filter(Boolean);
  // Each part is shown as a block of its own: a code block one leaves open must not run into the next.
  return texts.map((text, i) => (i < texts.length - 1 ? closeFences(text) : text)).join('\n\n');
}

/**
 * Who wrote an agent message, as it was then: the name and coding agent recorded on the message
 * (agents can be renamed or switched later), else the agent's current ones.
 */
export function speaker(m: ChatMessage, agents: AgentConfig[]): { name: string; provider?: Provider } {
  const author = m.author;
  const agent = author.kind === 'agent' ? agents.find((a) => a.id === author.agentId) : undefined;
  return { name: m.agentName ?? agent?.name ?? 'agent', provider: m.provider ?? agent?.provider };
}

/** A Markdown quote of every line, so a multi-line text stays inside it. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** The files attached to a message, one "📎 name" line each. */
export function attachmentLines(m: ChatMessage): string {
  return m.parts
    .flatMap((p) => (p.type === 'attachment' ? [`📎 ${p.name}`] : []))
    .join('\n');
}

/** One line naming the team the lead agent chose ("Using the template …"). */
export function planHeadline(plan: TeamPlan, t: Messages): string {
  const name = plan.name ?? '';
  return plan.source === 'custom' ? t.plan.custom(name) : plan.source === 'fallback' ? t.plan.fallback(name) : t.plan.template(name);
}

/** The whole conversation as Markdown: one block per message, labelled with who said it. */
export function conversationMarkdown(conv: Conversation, t: Messages): string {
  const blocks: string[] = [];
  for (const m of conv.messages) {
    const text = closeFences(messageText(m));
    if (m.author.kind === 'system') {
      if (m.plan?.status === 'ready') blocks.push(`*${t.plan.title}: ${planHeadline(m.plan, t)}*`);
      else if (text) blocks.push(`*${text}*`);
      continue;
    }
    if (m.author.kind === 'user') {
      const body = [text, attachmentLines(m)].filter(Boolean).join('\n\n');
      if (body) blocks.push(`**${t.transcript.user}**\n\n${body}`);
      continue;
    }
    if (m.passed) continue; // "[PASS]" adds nothing to a transcript
    const { name, provider } = speaker(m, conv.agents);
    const body = [
      text,
      m.status === 'error' && m.error ? quote(`⚠ ${m.error.trim()}`) : '',
      m.status === 'aborted' ? `*${t.transcript.aborted}*` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (body) blocks.push(`**@${name}**${provider ? ` · ${PROVIDER_LABEL[provider]}` : ''}\n\n${body}`);
  }
  return `# ${conv.title}\n\n${blocks.join('\n\n---\n\n')}\n`;
}

/** Copy text to the clipboard; falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* not a secure context, or permission denied: try the legacy way */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
