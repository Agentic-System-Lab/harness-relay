import { PROVIDER_LABEL, type ChatMessage, type Conversation, type TeamPlan } from '../shared/types';
import type { Messages } from './i18n';

/** A message's text as Markdown. Tool activity is left out. */
export function messageText(m: ChatMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
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
    const text = messageText(m);
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
    const agentId = m.author.agentId;
    const agent = conv.agents.find((a) => a.id === agentId);
    const name = agent?.name ?? m.agentName ?? 'agent';
    const provider = m.provider ?? agent?.provider;
    const body = [
      text,
      m.status === 'error' && m.error ? `> ⚠ ${m.error}` : '',
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
