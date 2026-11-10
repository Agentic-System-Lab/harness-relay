import type { Conversation, ConversationGroup, Provider } from '../shared/types';
import { runners } from './agents';
import { parsePlanReply } from './planner';
import type { SettingsStore } from './settings';
import type { Store } from './store';

/*
 * Sidebar groups: when a conversation gets its first message and the user has made groups, the lead
 * agent (Settings) reads the message and picks the group it belongs in, or none (it stays in the
 * default group, "Other"). This runs in the background, next to the team's run, and only once per
 * conversation; a conversation the user moved first is left where they put it.
 */

export const GROUPER_BRIEFING =
  'You sort the conversations of Harness Relay, a group chat in which coding-agent CLIs work on the user\'s questions, ' +
  'into the groups the user made in its sidebar. Do not answer or work on the conversation, and do not use tools. ' +
  'Reply with the JSON object you are asked for and nothing else.';

/** Recent conversation titles shown per group, as examples of what is in it. */
const EXAMPLE_TITLES = 5;
/** How much of the first message the lead agent reads. */
const MAX_QUESTION = 4000;

export interface GroupForPrompt {
  name: string;
  /** Titles of conversations already in the group. */
  examples: string[];
}

export function buildGroupPrompt(question: string, groups: GroupForPrompt[]): string {
  const text = question.length > MAX_QUESTION ? question.slice(0, MAX_QUESTION) + '…' : question;
  const list = groups
    .map((g, i) => {
      const examples = g.examples.length ? `; it has conversations such as ${g.examples.map((e) => JSON.stringify(e)).join(', ')}` : '';
      return `${i + 1}. ${JSON.stringify(g.name)}${examples}`;
    })
    .join('\n');
  return `The user just started a new conversation with this first message:

<message>
${text}
</message>

The user sorts conversations into these groups:
${list}

Pick the group this conversation belongs in, judging by the group names (and the conversations already in them). Pick a group only when the conversation is clearly about its topic; when none fits, pick 0 and it stays in the default group, "Other".

Reply with only this JSON object: {"group": <number>}`;
}

/** The group the lead agent picked (null: none). Throws when its reply names no group of the list. */
export function parseGroupReply(text: string, groups: ConversationGroup[]): ConversationGroup | null {
  const value: unknown = parsePlanReply(text).group;
  if (value === null || value === 0 || value === '0') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= groups.length) return groups[n - 1]!;
  // A name instead of a number.
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const named = name ? groups.find((g) => g.name.toLowerCase() === name) : undefined;
  if (named) return named;
  throw new Error(`the lead agent picked no group of the list: ${JSON.stringify(value)}`);
}

/** Sorts new conversations into the user's groups, in the background. */
export class AutoGrouper {
  private runs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closing = false;

  constructor(
    private store: Store,
    private settings: SettingsStore,
    /** Told about the sorter's session, so AgentsView files it under the conversation. */
    private onSession?: (conv: Conversation, provider: Provider, sessionId: string) => void,
  ) {}

  /** The lead agent is sorting this conversation right now. */
  isSorting(convId: string): boolean {
    return this.runs.has(convId);
  }

  /** The lead agent is sorting some conversation. */
  get busy(): boolean {
    return this.runs.size > 0;
  }

  /** The conversations the lead agent is sorting right now. */
  sorting(): string[] {
    return [...this.runs.keys()];
  }

  /** Sort `conv` by its first message, unless it is sorted already or there are no groups to choose from. */
  start(conv: Conversation, question: string): void {
    if (this.closing || this.runs.has(conv.id) || !question.trim() || this.store.isSorted(conv.id)) return;
    const groups = this.store.listGroups();
    if (!groups.length) return;
    const abort = new AbortController();
    const done = this.sort(conv, question, groups, abort.signal)
      .catch((err) => {
        if (!abort.signal.aborted) console.warn('[grouping] could not sort the conversation:', (err as Error).message);
      })
      .finally(() => this.runs.delete(conv.id));
    this.runs.set(conv.id, { abort, done });
  }

  private async sort(conv: Conversation, question: string, groups: ConversationGroup[], signal: AbortSignal): Promise<void> {
    const lead = this.settings.lead;
    const prompt = buildGroupPrompt(
      question,
      groups.map((g) => ({ name: g.name, examples: this.store.groupTitles(g.id, EXAMPLE_TITLES) })),
    );
    let reply = '';
    const result = await runners[lead.provider].run({
      bin: this.settings.bin(lead.provider),
      env: this.settings.env(lead.provider),
      nativeOff: this.settings.nativeOff(lead.provider),
      nativeItems: this.settings.nativeItems(lead.provider),
      prompt,
      systemPrompt: GROUPER_BRIEFING,
      cwd: conv.settings.cwd,
      permission: 'read-only',
      model: lead.model || this.settings.defaultModel(lead.provider) || undefined,
      effort: lead.effort || this.settings.defaultEffort(lead.provider) || undefined,
      signal,
      onEvent: (e) => {
        if (e.type === 'text') reply += e.text;
        else if (e.type === 'text_end') reply += '\n';
      },
    });
    if (result.sessionId && !signal.aborted) this.onSession?.(conv, lead.provider, result.sessionId);
    if (signal.aborted) return;
    // Groups deleted meanwhile are skipped by the store.
    this.store.sortIntoGroup(conv.id, parseGroupReply(reply, groups)?.id ?? null);
  }

  /** The conversation is being deleted: stop sorting it, and wait until that has wound down. */
  async cancel(convId: string): Promise<void> {
    const run = this.runs.get(convId);
    if (!run) return;
    run.abort.abort();
    await run.done;
  }

  /** Shutting down: stop sorting, and start nothing new. */
  stopAll(): void {
    this.closing = true;
    for (const r of this.runs.values()) r.abort.abort();
  }

  /** Every sort in progress has finished. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.runs.values()].map((r) => r.done));
  }
}
