import type { ChatMessage, PlanUsage, ReportedUsage } from '../shared/types';

/** Finished stages grouped by their initiating message. Old chats only have the message order. */
export function questionUsage(messages: readonly ChatMessage[]): Map<string, ChatMessage[]> {
  const groups = new Map<string, ChatMessage[]>();
  let lastQuestion: string | undefined;
  for (const m of messages) {
    if (m.author.kind === 'user' && (!m.queued || !lastQuestion)) lastQuestion = m.id;
    if (m.status === 'streaming' || !(m.plan || m.review || m.author.kind === 'agent')) continue;
    if (m.plan?.usage?.length === 0) continue;
    const id = m.plan?.forSchedule ? m.id : (m.usageQuestionId ?? lastQuestion ?? m.id);
    const group = groups.get(id);
    if (group) group.push(m);
    else groups.set(id, [m]);
  }
  return groups;
}

export type UsageRow = PlanUsage | (ReportedUsage & ({ kind: 'member'; name: string; round?: number } | { kind: 'review' }));

export function usageRows(messages: readonly ChatMessage[]): UsageRow[] {
  return messages.flatMap((m): UsageRow[] => {
    if (m.plan) return m.plan.usage ?? [{ kind: 'combined', ...m.meta }];
    if (m.review) return [{ kind: 'review', ...m.meta }];
    return [{ kind: 'member', name: m.agentName ?? (m.author.kind === 'agent' ? m.author.agentId : ''), ...m.meta }];
  });
}

/** A subtotal includes only reported figures. An entirely unreported column stays unknown. */
export function reportedSubtotal(rows: readonly ReportedUsage[], key: keyof ReportedUsage): number | undefined {
  return rows.reduce<number | undefined>((sum, row) => (row[key] === undefined ? sum : (sum ?? 0) + row[key]), undefined);
}
