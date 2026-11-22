import {
  GROUP_LIMITS,
  type Conversation,
  type ConversationGroup,
  type GroupReorganize,
  type GroupSuggestion,
  type Provider,
} from '../shared/types';
import { runners } from './agents';
import { stateKeys, type OutputSchema } from './agents/types';
import { HttpError } from './errors';
import { t } from './i18n';
import { leadReply, strictObject } from './planner';
import type { SettingsStore } from './settings';
import type { Store } from './store';
import { validGroupName } from './validate';

/*
 * Sidebar groups and titles: when a conversation gets its first message, the lead agent (Settings) reads
 * the message and, when the user has made groups, picks the group it belongs in, or none (it stays in the
 * default group, "Other"); and, unless the user turned it off (`SettingsStore.chatTitles`), names the
 * conversation in a few words, in place of its first line. One run in the background, next to the
 * team's, and only once per conversation; a conversation the user moved first is left where they put it,
 * and one the user renamed meanwhile keeps their title.
 *
 * Asked from the sidebar, the lead agent also suggests how to organize the conversations there into
 * groups (`buildOrganizePrompt()`, `LeadDrafts.groups()`), each suggestion for the user to take or leave.
 */

export const GROUPER_BRIEFING =
  "You sort and name the conversations of Harness Relay, a task assistant in which coding-agent CLIs work on the user's questions in group chats: " +
  'you sort them into the groups the user made in its sidebar, and give them titles. Do not answer or work on the conversation, and do not use tools. ' +
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

/** The longest title the lead agent gives a conversation. */
export const TITLE_MAX = 60;

/**
 * The prompt for a new conversation: its group among `groups` (none: not asked), and its title (`name`).
 * At least one of them is asked.
 */
export function buildGroupPrompt(question: string, groups: GroupForPrompt[], name = false): string {
  const text = question.length > MAX_QUESTION ? question.slice(0, MAX_QUESTION) + '…' : question;
  const list = groups
    .map((g, i) => {
      const examples = g.examples.length ? `; it has conversations such as ${g.examples.map((e) => JSON.stringify(e)).join(', ')}` : '';
      return `${i + 1}. ${JSON.stringify(g.name)}${examples}`;
    })
    .join('\n');
  const sort = groups.length > 0;
  const fields = [...(sort ? ['"group": <number>'] : []), ...(name ? ['"title": "<title>"'] : [])].join(', ');
  return `The user just started a new conversation with this first message:

<message>
${text}
</message>
${
  sort
    ? `
The user sorts conversations into these groups:
${list}

Pick the group this conversation belongs in, judging by the group names (and the conversations already in them). Pick a group only when the conversation is clearly about its topic; when none fits, pick 0 and it stays in the default group, "Other".
`
    : ''
}${
    name
      ? `
${sort ? 'Also give' : 'Give'} the conversation a title for the sidebar: a few words (at most ${TITLE_MAX} characters) that say what it is about, in the language of the message, with no quotes and no full stop at the end. Give "" when the message says too little to tell.
`
      : ''
  }
Reply with only this JSON object: {${fields}}`;
}

/** The answer as JSON Schema (`buildGroupPrompt()`'s object), for a lead whose CLI can be asked for one. */
export const GROUP_SCHEMA: OutputSchema = strictObject({
  group: { type: 'integer', description: "The group's number in the list, or 0 for none" },
});

/** `buildGroupPrompt()`'s object with what it asks for: its group, its title, or both. */
export function groupSchema(sort: boolean, name: boolean): OutputSchema {
  return strictObject({
    ...(sort ? { group: { type: 'integer', description: "The group's number in the list, or 0 for none" } } : {}),
    ...(name ? { title: { type: 'string', description: `At most ${TITLE_MAX} characters; "" when the message says too little` } } : {}),
  });
}

/**
 * The title the lead agent gave (undefined: none, or "" for none): one line, without the quotes or the
 * full stop it may have put around it, at most `TITLE_MAX` characters (a word cut at the end).
 */
export function parseTitleReply(text: string, structured?: unknown): string | undefined {
  let raw: unknown;
  try {
    raw = leadReply(text, structured).title;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  // Quotes around it and a full stop at its end, whichever way round the lead put them.
  const bare = (s: string) =>
    s
      .trim()
      .replace(/[.。]+$/, '')
      .replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/g, '')
      .trim();
  const title = bare(bare(raw.replace(/\s+/g, ' ')));
  if (!title) return undefined;
  const chars = [...title];
  return chars.length <= TITLE_MAX
    ? title
    : chars
        .slice(0, TITLE_MAX - 1)
        .join('')
        .trimEnd() + '…';
}

/**
 * The group the lead agent picked (null: none), from its structured answer (`GROUP_SCHEMA`) when its CLI
 * gave one, else its reply's text. Throws when it names no group of the list.
 */
export function parseGroupReply(text: string, groups: ConversationGroup[], structured?: unknown): ConversationGroup | null {
  const value: unknown = leadReply(text, structured).group;
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
    /** The model the lead agent runs on (`Orchestrator.modelFor`): an open agent's picker default too. */
    private modelFor?: (p: Provider, chosen?: string, account?: string) => Promise<string | undefined>,
    /** Told once the lead agent named the conversation (saved already), to show its new title. */
    private onTitle?: (conv: Conversation) => void,
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

  /**
   * Sort `conv` by its first message, unless it is sorted already or there are no groups to choose from,
   * and (`name`: its title is the one its first message gave it) name it, unless the user turned that off.
   */
  start(conv: Conversation, question: string, name = false): void {
    if (this.closing || this.runs.has(conv.id) || !question.trim()) return;
    const groups = this.store.isSorted(conv.id) ? [] : this.store.listGroups();
    const titled = name && this.settings.chatTitles ? conv.title : undefined;
    if (!groups.length && titled === undefined) return;
    const abort = new AbortController();
    const done = this.sort(conv, question, groups, titled, abort.signal)
      .catch((err) => {
        if (!abort.signal.aborted) console.warn('[grouping] could not sort or name the conversation:', (err as Error).message);
      })
      .finally(() => this.runs.delete(conv.id));
    this.runs.set(conv.id, { abort, done });
  }

  /** `titled`: the title to replace, when it is still the conversation's once the lead agent answers. */
  private async sort(
    conv: Conversation,
    question: string,
    groups: ConversationGroup[],
    titled: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const lead = this.settings.lead;
    const name = titled !== undefined;
    const prompt = buildGroupPrompt(
      question,
      groups.map((g) => ({ name: g.name, examples: this.store.groupTitles(g.id, EXAMPLE_TITLES) })),
      name,
    );
    let reply = '';
    const result = await runners[lead.provider].run({
      bin: this.settings.bin(lead.provider),
      env: this.settings.env(lead.provider, lead.account),
      backends: this.settings.backendsFor(lead.provider),
      ...this.settings.runNative(lead.provider, lead.account, 'read-only'),
      sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
      prompt,
      systemPrompt: GROUPER_BRIEFING,
      outputSchema: name ? groupSchema(groups.length > 0, true) : GROUP_SCHEMA,
      cwd: conv.settings.cwd,
      permission: 'read-only',
      stateKey: stateKeys.sort(conv.id),
      model: this.modelFor
        ? await this.modelFor(lead.provider, lead.model, lead.account)
        : lead.model || this.settings.defaultModel(lead.provider, lead.account) || undefined,
      effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
      signal,
      onEvent: (e) => {
        if (e.type === 'text') reply += e.text;
        else if (e.type === 'text_end') reply += '\n';
      },
    });
    if (result.sessionId && !signal.aborted) this.onSession?.(conv, lead.provider, result.sessionId);
    if (signal.aborted) return;
    if (name) {
      const title = parseTitleReply(reply, result.structured);
      // Only over the title the first message gave it: one the user typed meanwhile stays.
      const live = this.store.get(conv.id);
      if (title && live && live.title === titled && title !== titled) {
        live.title = title;
        this.store.saveMeta(live);
        this.onTitle?.(live);
      }
    }
    // Groups deleted meanwhile are skipped by the store.
    if (groups.length) this.store.sortIntoGroup(conv.id, parseGroupReply(reply, groups, result.structured)?.id ?? null);
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

/*
 * Organizing the sidebar's groups, asked from the sidebar ("Ask the lead agent"): the lead agent reads
 * the groups and the conversations (one for each family of branches, which moves as one, the most
 * recently used first) and suggests groups to make, groups to rename and conversations to move. Nothing
 * changes until the user takes the suggestions they want (`checkReorganize()`, `Store.reorganize()`).
 */

export const ORGANIZER_BRIEFING =
  "You organize the conversations of Harness Relay, a task assistant in which coding-agent CLIs work on the user's questions in group chats, " +
  'into the groups of its sidebar, as the user asks. Do not answer or work on the conversations, and do not use tools. ' +
  'Reply with the JSON object you are asked for and nothing else.';

/** The most conversations the lead agent reads to suggest groups, and the longest title it reads of each. */
export const ORGANIZE_LIMITS = { conversations: 300, title: 100 };

/** A conversation as the organizer reads it: its title and its group's number (0: "Other"). */
export interface OrganizeConversation {
  id: string;
  title: string;
  /** The index of its group in the list, or -1 for "Other". */
  group: number;
}

export function buildOrganizePrompt(groups: ConversationGroup[], conversations: OrganizeConversation[], request = ''): string {
  const counts = groups.map((_, i) => conversations.filter((c) => c.group === i).length);
  const list = groups.length
    ? groups.map((g, i) => `${i + 1}. ${JSON.stringify(g.name)} (${counts[i]} of the conversations below)`).join('\n')
    : '(none yet)';
  const convs = conversations
    .map((c, i) => {
      const title = [...c.title].length > ORGANIZE_LIMITS.title ? [...c.title].slice(0, ORGANIZE_LIMITS.title).join('') + '…' : c.title;
      return `${i + 1}. ${JSON.stringify(title)}: ${c.group >= 0 ? `group ${c.group + 1}` : 'Other'}`;
    })
    .join('\n');
  const room = Math.max(0, GROUP_LIMITS.maxGroups - groups.length);
  const asked = request.trim();
  return `The user asks you to organize the conversations in Harness Relay's sidebar into groups.

The groups (besides the default group, "Other", for conversations in none):
${list}

The conversations, the most recently used first, with the group each one is in now:
<conversations>
${convs}
</conversations>
${
  asked
    ? `
What the user asks for:
<request>
${asked}
</request>
`
    : ''
}
How to organize them:
- Suggest groups to make, groups to rename, and conversations to move into the group they belong in. The user takes the suggestions they want; nothing changes until then.
- Make a group only for a topic several conversations share, with a short name (at most ${GROUP_LIMITS.maxName} characters) in the language most of the titles are in; never one like a group there is already, nor "Other". At most ${room} new groups.
- Rename a group only when the user asks, or when its name no longer says what is in it.
- Move a conversation only when it clearly belongs in another group (or in "Other"); leave it where it is when it is well placed, or when you cannot tell from its title. List only the conversations you move.
- Write the reason in the language of the user's request, or of the titles when there is none.

Number the groups you make after the ones there are, in the order you list them (${groups.length + 1}, ${groups.length + 2}…), and use those numbers in "move". Group 0 is "Other".

Reply with only this JSON object, in a \`\`\`json code block:
{"create": [{"name": "<a new group's name>"}], "rename": [{"group": <its number>, "name": "<its new name>"}], "move": [{"conversation": <its number>, "group": <a group's number, or 0 for Other>}], "reason": "<what you suggest and why: one or two sentences for the user>"}`;
}

/** The suggestions (`buildOrganizePrompt()`, `decideOrganize()`). */
export const ORGANIZE_SCHEMA: OutputSchema = strictObject({
  create: { type: 'array', items: strictObject({ name: { type: 'string' } }) },
  rename: { type: 'array', items: strictObject({ group: { type: 'integer' }, name: { type: 'string' } }) },
  move: {
    type: 'array',
    items: strictObject({ conversation: { type: 'integer' }, group: { type: 'integer', description: '0 for Other' } }),
  },
  reason: { type: 'string' },
});

/**
 * The lead agent's suggestions as the user sees them: each one that can be taken. A group named like
 * another (or "Other"), a number that names nothing and a move that changes nothing are left out, and
 * so is a new group that no move is left to fill.
 */
export function decideOrganize(
  raw: Record<string, any>,
  groups: ConversationGroup[],
  conversations: OrganizeConversation[],
): Omit<GroupSuggestion, 'meta'> {
  const reason = String(raw.reason ?? '')
    .trim()
    .slice(0, 800);
  const index = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);
  // Names taken so far, as `validGroupName()` reads them: the groups as they will be.
  const taken: ConversationGroup[] = groups.map((g) => ({ ...g }));
  const tryName = (name: unknown, except?: string): string | undefined => {
    try {
      return validGroupName(name, taken, except);
    } catch {
      return undefined;
    }
  };
  const rename: GroupSuggestion['rename'] = [];
  for (const r of Array.isArray(raw.rename) ? raw.rename : []) {
    const g = groups[index(r?.group) - 1];
    if (!g || rename.some((x) => x.id === g.id)) continue;
    const name = tryName(r?.name, g.id);
    if (!name || name === g.name) continue;
    rename.push({ id: g.id, from: g.name, name });
    taken.find((x) => x.id === g.id)!.name = name;
  }
  const created: { key: string; name: string; n: number }[] = [];
  const room = Math.max(0, GROUP_LIMITS.maxGroups - groups.length);
  (Array.isArray(raw.create) ? raw.create : []).forEach((c: any, i: number) => {
    if (created.length >= room) return;
    const name = tryName(c?.name);
    if (!name) return;
    const key = `new-${created.length + 1}`;
    created.push({ key, name, n: groups.length + i + 1 });
    taken.push({ id: key, name });
  });
  const move: GroupSuggestion['move'] = [];
  for (const m of Array.isArray(raw.move) ? raw.move : []) {
    const c = conversations[index(m?.conversation) - 1];
    if (!c || move.some((x) => x.convId === c.id)) continue;
    const n = index(m?.group);
    const to = n === 0 ? null : n >= 1 && n <= groups.length ? groups[n - 1]!.id : (created.find((x) => x.n === n)?.key ?? undefined);
    if (to === undefined) continue;
    const from = c.group >= 0 ? groups[c.group]!.id : null;
    if (to === from) continue;
    move.push({ convId: c.id, title: c.title, from, to });
  }
  const create = created.filter((c) => move.some((m) => m.to === c.key)).map(({ key, name }) => ({ key, name }));
  return { create, rename, move, reason };
}

/**
 * The suggestions the user took, checked against the groups and conversations as they are now: each
 * new group's name and each new name is a group name no other group has; a move goes to a group there
 * is, a new group's key, or "Other". Returns them with each new group's id (`newId()`), for
 * `Store.reorganize()`. Throws (400 or 404) on what cannot be done.
 */
export function checkReorganize(
  input: unknown,
  groups: ConversationGroup[],
  exists: (convId: string) => boolean,
  newId: () => string,
): { create: ConversationGroup[]; rename: ConversationGroup[]; move: { convId: string; to: string | null }[] } {
  const b = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof GroupReorganize, unknown>>;
  const list = (v: unknown, field: string): Record<string, unknown>[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => !x || typeof x !== 'object')) throw new HttpError(400, t().invalidField(field));
    return v as Record<string, unknown>[];
  };
  const taken: ConversationGroup[] = groups.map((g) => ({ ...g }));
  const rename: ConversationGroup[] = [];
  for (const r of list(b.rename, 'rename')) {
    const id = String(r.id ?? '');
    const g = taken.find((x) => x.id === id && groups.some((o) => o.id === id));
    if (!g) throw new HttpError(404, t().groupNotFound);
    const name = validGroupName(r.name, taken, id);
    g.name = name;
    rename.push({ id, name });
  }
  const created = list(b.create, 'create');
  if (groups.length + created.length > GROUP_LIMITS.maxGroups) throw new HttpError(400, t().tooManyGroups(GROUP_LIMITS.maxGroups));
  const keys = new Map<string, string>();
  const create: ConversationGroup[] = [];
  for (const c of created) {
    const key = String(c.key ?? '');
    if (!/^new-\d{1,3}$/.test(key) || keys.has(key)) throw new HttpError(400, t().invalidField('create'));
    const name = validGroupName(c.name, taken);
    const id = newId();
    keys.set(key, id);
    taken.push({ id, name });
    create.push({ id, name });
  }
  const seen = new Set<string>();
  const move = list(b.move, 'move').map((m) => {
    const convId = String(m.convId ?? '');
    if (!exists(convId)) throw new HttpError(404, t().conversationNotFound);
    if (seen.has(convId)) throw new HttpError(400, t().invalidField('move'));
    seen.add(convId);
    const to = m.to === null ? null : String(m.to ?? '');
    if (to === null) return { convId, to };
    const id = keys.get(to) ?? (groups.some((g) => g.id === to) ? to : undefined);
    if (!id) throw new HttpError(404, t().groupNotFound);
    return { convId, to: id };
  });
  return { create, rename, move };
}
