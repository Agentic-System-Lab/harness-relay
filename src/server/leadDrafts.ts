import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validTimeZone } from '../shared/schedule';
import {
  PROVIDERS,
  REVISE_REQUEST_MAX,
  cwdsOf,
  type ChecksDraftRequest,
  type ChecksRevision,
  type GroupSuggestion,
  type GroupSuggestionRequest,
  type MessageMeta,
  type Provider,
  type ScheduleDraftRequest,
  type ScheduleRevision,
  type ScheduleUpdate,
  type TemplateDraftRequest,
  type TemplateRevision,
} from '../shared/types';
import { runners } from './agents';
import { stateKeys, type OutputSchema } from './agents/types';
import { CHECKS_BRIEFING, CHECKS_SCHEMA, buildChecksPrompt, decideChecks, type ChecksPlace, type ChecksVariant } from './checksDraft';
import { questionDir } from './cliSubModel';
import { CONFIG } from './config';
import { HttpError } from './errors';
import { ORGANIZER_BRIEFING, ORGANIZE_LIMITS, ORGANIZE_SCHEMA, buildOrganizePrompt, decideOrganize } from './grouping';
import { t } from './i18n';
import {
  TEMPLATE_BRIEFING,
  TEMPLATE_SCHEMA,
  TEMPLATE_TEXT_MAX,
  buildTemplatePrompt,
  decideTemplate,
  leadReply,
  teamSettings,
  type PlannerContext,
} from './planner';
import { RUN_TMP_PREFIXES } from './protect';
import { SCHEDULE_BRIEFING, SCHEDULE_SCHEMA, buildSchedulePrompt, decideSchedule } from './scheduleDraft';
import { DATA_DIR, type SettingsStore } from './settings';
import type { Store } from './store';
import { serverTimeZone, validDirectories, validateAgents, validateChecks } from './validate';

/*
 * The lead agent's drafts for the editors that are not a conversation's team: a template, team checks,
 * a schedule, and suggestions for the sidebar's groups (`TemplateRevision`, `ChecksRevision`,
 * `ScheduleRevision`, `GroupSuggestion` in `src/shared/types.ts`). Each is one read-only run of the lead
 * agent (Settings), asked for a JSON object, whose answer the editor shows until the user saves it or
 * takes it: nothing is saved here. A run works in the folder it is given (the project whose team checks
 * it writes), else in an empty folder of its own in the data folder's `drafts/` (`questionDir()`): not
 * in Harness Relay's temporary folder, which the agents' sandboxes may not read (`protectedReads()`,
 * the relay sandbox's `denyRead`), so that a sandboxed lead agent can start in it; and it keeps no
 * session (`freshState`). A new request of the same kind, for the same editor, stops the
 * one still running and waits for it to end; closing the request (`signal`: the editor closed, or Stop)
 * stops it too.
 */

export type DraftKind = 'template' | 'checks' | 'schedule' | 'groups';

/** What the drafts need of the planner: what the lead may staff a team with (`PlannerSource.context`). */
export interface DraftPlanner {
  context(cwd?: string, addDirs?: readonly string[]): Promise<PlannerContext>;
}

interface DraftRun {
  /** Its kind, and whose editor it is within it (a conversation's id): another one runs beside it. */
  key: string;
  prompt: string;
  systemPrompt: string;
  outputSchema: OutputSchema;
  /** The folders it reads (team checks' project; the first is where it runs); none: an empty one of its own. */
  cwds?: string[];
  signal?: AbortSignal;
}

interface DraftAnswer {
  raw: Record<string, any>;
  meta: MessageMeta;
}

export class LeadDrafts {
  /** The latest run of each key; `all`: every run not ended yet, the ones it replaced too. */
  private latest = new Map<string, { abort: AbortController; done: Promise<unknown> }>();
  private all = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    private store: Store,
    private settings: SettingsStore,
    private planner: DraftPlanner,
    /** The model the lead agent runs on (`Orchestrator.modelFor`). */
    private modelFor: (p: Provider, chosen?: string, account?: string) => Promise<string | undefined>,
    /** Where its empty folders go: readable by the agents' sandboxes (tests give their own). */
    private tmp = draftsDir(),
  ) {
    // Left by drafts a server stopped during: none runs yet.
    clearDraftDirs(this.tmp);
  }

  /** The drafts under way, as `Orchestrator.busy()` counts them. */
  keys(): string[] {
    return [...this.latest.keys()].map((k) => `draft:${k}`);
  }

  get busy(): boolean {
    return this.all.size > 0;
  }

  /** Shutting down: stop every draft, and start no new one. */
  stopAll(): void {
    this.closing = true;
    for (const r of this.latest.values()) r.abort.abort();
  }

  /** Every draft under way has ended. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.all]);
  }

  /** The template editor's draft: its team, name and description. */
  async template(input: Partial<Record<keyof TemplateDraftRequest, unknown>>, signal?: AbortSignal): Promise<TemplateRevision> {
    const request = requestOf(input.request);
    const draft = {
      name: textOf(input.name, TEMPLATE_TEXT_MAX.name),
      description: textOf(input.description, TEMPLATE_TEXT_MAX.description),
      // A new template may start with no members (no CLI ready here yet), or with one on each CLI ready here,
      // more than a team may have (`blankAgents()`): the lead agent designs the team, within the limit.
      agents:
        Array.isArray(input.agents) && input.agents.length === 0
          ? []
          : validateAgents(input.agents, Math.max(CONFIG.maxTeamAgents, PROVIDERS.length)),
      settings: teamSettings(input.settings, { mode: 'roundtable', rounds: 1, maxHops: 8 }),
    };
    const ctx = await this.planner.context();
    const fresh = draft.agents.every((a) => !a.role.trim());
    const answer = await this.run({
      key: 'template',
      prompt: buildTemplatePrompt(request, draft, ctx, fresh),
      systemPrompt: TEMPLATE_BRIEFING,
      outputSchema: TEMPLATE_SCHEMA,
      signal,
    });
    return this.decide(() => ({ ...decideTemplate(answer.raw, draft, ctx, this.settings.lead), meta: answer.meta }));
  }

  /**
   * The team checks editor's draft. Where the team works: the working directories the request names
   * (the team drawer's or the new chat's, which must exist), else the conversation's; none for a template
   * or Settings' default, or when the folders named do not exist.
   */
  async checks(input: Partial<Record<keyof ChecksDraftRequest, unknown>>, signal?: AbortSignal): Promise<ChecksRevision> {
    const request = requestOf(input.request);
    const before = input.checks === undefined || input.checks === null ? undefined : validateChecks(input.checks);
    const variant: ChecksVariant = input.variant === 'template' || input.variant === 'defaults' ? input.variant : 'team';
    const conv = typeof input.convId === 'string' && input.convId ? this.store.get(input.convId) : undefined;
    if (typeof input.convId === 'string' && input.convId && !conv) throw new HttpError(404, t().conversationNotFound);
    let place: ChecksPlace | undefined;
    if (variant === 'team') {
      if (typeof input.cwd === 'string' && input.cwd.trim()) {
        try {
          place = { cwds: cwdsOf(validDirectories(input.cwd, input.extraCwds)) };
        } catch {
          // Not there (yet): the lead writes rules without reading a project, and the editor says so.
          place = undefined;
        }
      } else if (conv) place = { cwds: cwdsOf(conv.settings) };
    }
    const answer = await this.run({
      key: `checks.${conv?.id ?? variant}`,
      prompt: buildChecksPrompt(request, before, place, variant),
      systemPrompt: CHECKS_BRIEFING,
      outputSchema: CHECKS_SCHEMA,
      cwds: place?.cwds,
      signal,
    });
    return this.decide(() => {
      const { checks, reason, dropped } = decideChecks(answer.raw, before, variant === 'defaults');
      return {
        checks,
        reason: dropped ? `${reason}${reason ? ' ' : ''}${t().draftRulesDropped(dropped)}`.trim() : reason,
        ...(place ? { readIn: place.cwds[0] } : {}),
        meta: answer.meta,
      };
    });
  }

  /** The schedule form's draft, in the browser's time zone: for a conversation's schedule (`convId`), or a new automation's. */
  async schedule(
    input: Partial<Record<keyof ScheduleDraftRequest, unknown>>,
    signal?: AbortSignal,
    now = Date.now(),
  ): Promise<ScheduleRevision> {
    const request = requestOf(input.request);
    const timeZone = typeof input.timeZone === 'string' && validTimeZone(input.timeZone.trim()) ? input.timeZone.trim() : serverTimeZone();
    const form = (input.schedule && typeof input.schedule === 'object' ? input.schedule : undefined) as Partial<ScheduleUpdate> | undefined;
    const conv = typeof input.convId === 'string' && input.convId ? this.store.get(input.convId) : undefined;
    if (typeof input.convId === 'string' && input.convId && !conv) throw new HttpError(404, t().conversationNotFound);
    const ctx = {
      ...(conv?.agents.length ? { team: conv.agents.map((a) => a.name) } : {}),
      cwd: conv?.settings.cwd ?? this.settings.defaultCwd,
      mail: this.settings.connectors.mailAccounts().map((a) => ({ id: a.id, name: a.name, address: a.address })),
      calendars: this.settings.connectors.calendarAccounts().map((a) => ({ id: a.id, name: a.name })),
    };
    const answer = await this.run({
      key: `schedule.${conv?.id ?? 'new'}`,
      prompt: buildSchedulePrompt(request, form, timeZone, now, ctx),
      systemPrompt: SCHEDULE_BRIEFING,
      outputSchema: SCHEDULE_SCHEMA,
      signal,
    });
    return this.decide(() => ({ ...decideSchedule(answer.raw, form, timeZone, now, ctx), meta: answer.meta }));
  }

  /** Suggestions for the sidebar's groups: groups to make and rename, conversations to move. */
  async groups(input: Partial<Record<keyof GroupSuggestionRequest, unknown>>, signal?: AbortSignal): Promise<GroupSuggestion> {
    const request = input.request === undefined || input.request === null || input.request === '' ? '' : requestOf(input.request);
    const groups = this.store.listGroups();
    const heads = this.store.familyHeads(ORGANIZE_LIMITS.conversations);
    if (!heads.length) throw new HttpError(400, t().groupsNothingToOrganize);
    const conversations = heads.map((h) => ({ id: h.id, title: h.title, group: groups.findIndex((g) => g.id === h.groupId) }));
    const answer = await this.run({
      key: 'groups',
      prompt: buildOrganizePrompt(groups, conversations, request),
      systemPrompt: ORGANIZER_BRIEFING,
      outputSchema: ORGANIZE_SCHEMA,
      signal,
    });
    return this.decide(() => ({ ...decideOrganize(answer.raw, groups, conversations), meta: answer.meta }));
  }

  /** The editor's answer from the lead's, or the reason it could not be made, for the user. */
  private decide<T>(make: () => T): T {
    try {
      return make();
    } catch (err) {
      throw new HttpError(503, t().draftFailed(err instanceof HttpError ? err.message : (err as Error).message));
    }
  }

  private async run(d: DraftRun): Promise<DraftAnswer> {
    if (this.closing) throw new HttpError(503, t().shuttingDown);
    const before = this.latest.get(d.key);
    const abort = new AbortController();
    const stop = () => abort.abort();
    if (d.signal?.aborted) abort.abort();
    d.signal?.addEventListener('abort', stop, { once: true });
    const done = (async () => {
      // The one it replaces ends first: both would keep their state under the same key.
      if (before) {
        before.abort.abort();
        await before.done.catch(() => undefined);
      }
      return this.runLead(d, abort.signal);
    })();
    const entry = { abort, done };
    this.latest.set(d.key, entry);
    this.all.add(done);
    try {
      return await done;
    } finally {
      d.signal?.removeEventListener('abort', stop);
      this.all.delete(done);
      if (this.latest.get(d.key) === entry) this.latest.delete(d.key);
    }
  }

  private async runLead(d: DraftRun, signal: AbortSignal): Promise<DraftAnswer> {
    const stopped = () => new HttpError(409, t().draftStopped);
    if (signal.aborted) throw stopped();
    const lead = this.settings.lead;
    const own = d.cwds?.length ? undefined : questionDir(this.tmp);
    const started = Date.now();
    let reply = '';
    try {
      const result = await runners[lead.provider].run({
        bin: this.settings.bin(lead.provider),
        env: this.settings.env(lead.provider, lead.account),
        backends: this.settings.backendsFor(lead.provider),
        ...this.settings.runNative(lead.provider, lead.account, 'read-only'),
        sandboxTerminal: this.settings.sandboxTerminal(lead.provider),
        prompt: d.prompt,
        systemPrompt: d.systemPrompt,
        outputSchema: d.outputSchema,
        cwd: d.cwds?.[0] ?? own!.cwd,
        ...(d.cwds && d.cwds.length > 1 ? { addDirs: d.cwds.slice(1) } : {}),
        stateKey: stateKeys.draft(d.key),
        // Nothing of an earlier draft is read again: each one starts from the editor as it is.
        freshState: true,
        permission: 'read-only',
        model: await this.modelFor(lead.provider, lead.model, lead.account),
        effort: lead.effort || this.settings.defaultEffort(lead.provider, lead.account) || undefined,
        signal,
        onEvent: (e) => {
          if (e.type === 'text') reply += e.text;
          else if (e.type === 'text_end') reply += '\n';
        },
      });
      if (signal.aborted) throw stopped();
      let raw: Record<string, any>;
      try {
        raw = leadReply(reply, result.structured);
      } catch (err) {
        throw new HttpError(503, t().draftFailed((err as Error).message));
      }
      return {
        raw,
        meta: {
          durationMs: Date.now() - started,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      };
    } catch (err) {
      if (signal.aborted) throw stopped();
      if (err instanceof HttpError) throw err;
      console.warn(`[drafts] the lead agent's ${d.key} draft failed:`, (err as Error).message);
      throw new HttpError(503, t().draftFailed((err as Error).message));
    } finally {
      own?.remove();
    }
  }
}

/** Where the drafts' empty folders are made: the data folder's `drafts/`. */
export function draftsDir(dataDir = DATA_DIR): string {
  return join(dataDir, 'drafts');
}

/** Removes the empty folders drafts a server stopped during left in `dir` (`questionDir()`'s). */
function clearDraftDirs(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  for (const name of names) {
    if (!name.startsWith(RUN_TMP_PREFIXES.ask)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[drafts] could not remove ${name}:`, (err as Error).message);
    }
  }
}

/** The user's request: said, and not too long. */
function requestOf(v: unknown): string {
  const request = typeof v === 'string' ? v.trim() : '';
  if (!request) throw new HttpError(400, t().draftEmpty);
  if (request.length > REVISE_REQUEST_MAX) throw new HttpError(400, t().reviseTooLong(REVISE_REQUEST_MAX));
  return request;
}

const textOf = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
