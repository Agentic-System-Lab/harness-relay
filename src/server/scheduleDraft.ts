import { readProposal, proposalUpdate } from '../shared/scheduleProposal';
import { zonedParts } from '../shared/schedule';
import { SCHEDULE_LIMITS, WATCH_LIMITS, type ScheduleTrigger, type ScheduleUpdate } from '../shared/types';
import type { OutputSchema } from './agents/types';
import { orNull, strictObject } from './planner';
import { validateSchedule } from './validate';

/*
 * A schedule drafted by the lead agent at the user's request (the schedule form's "Ask the lead agent",
 * `LeadDrafts.schedule()`): the user says what should happen and when, in their own words, and the lead
 * returns the whole schedule: the message the team gets each time, when it is sent, and its options. The
 * form shows it until the user saves it. Its times are the user's wall-clock ones, in the browser's time
 * zone; it is checked as a saved schedule is (`validateSchedule()`).
 */

export const SCHEDULE_BRIEFING =
  "You are the lead agent of Harness Relay, a task assistant in which coding-agent CLIs work together on the user's questions in a group chat. " +
  'Right now your only job is to write a schedule the way the user asks: a message the team is sent automatically, at set times or when something happens. ' +
  'Do not do the scheduled work yourself, and do not use tools. Reply with the JSON object you are asked for and nothing else.';

/** What the lead knows of where the schedule's message goes. */
export interface ScheduleContext {
  /** The conversation's team, by name (none: a new automation, whose team the lead designs once it is saved). */
  team?: string[];
  /** The working directory a file trigger looks in. */
  cwd: string;
  /** The mail accounts and calendars set up in Settings: their ids, which triggers name, and what they are called. */
  mail: { id: string; name: string; address?: string }[];
  calendars: { id: string; name: string }[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** The form's schedule as the lead reads it: only what a schedule has, a once time as the user's wall clock. */
function formForLead(form: Partial<ScheduleUpdate> | undefined, timeZone: string): Record<string, unknown> {
  const f = form ?? {};
  const r = f.repeat;
  const repeat =
    r && r.kind === 'once'
      ? (() => {
          const p = Number.isFinite(r.at) && r.at > 0 ? zonedParts(r.at, timeZone) : undefined;
          return { kind: 'once', at: p ? `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}` : '' };
        })()
      : r;
  return {
    text: typeof f.text === 'string' ? f.text.slice(0, SCHEDULE_LIMITS.maxText) : '',
    ...(repeat ? { repeat } : {}),
    goal: typeof f.goal === 'string' ? f.goal.slice(0, SCHEDULE_LIMITS.maxGoal) : '',
    newChat: f.newChat === true,
    missed: f.missed === 'run' ? 'run' : 'skip',
    approvals: f.approvals === 'ask' ? 'ask' : 'deny',
  };
}

export function buildSchedulePrompt(
  request: string,
  form: Partial<ScheduleUpdate> | undefined,
  timeZone: string,
  now: number,
  ctx: ScheduleContext,
): string {
  const p = zonedParts(now, timeZone);
  const who = ctx.team?.length
    ? `the conversation's team (${ctx.team.map((n) => `@${n}`).join(', ')}); a message that @mentions members is answered by those members only, so mention one only when the user asks for it`
    : 'a new automation: once the user saves it, you design the team for its message, as you do for a new question';
  const accounts = (kind: string, list: { id: string; name: string; address?: string }[]) =>
    list.length
      ? list.map((a) => `- ${JSON.stringify(a.id)}: ${a.name}${a.address && a.address !== a.name ? ` (${a.address})` : ''}`).join('\n')
      : `(none: a ${kind} trigger's account is "", for the user to set one up and pick)`;
  return `The user is setting up a schedule in Harness Relay: a message the team is sent automatically, at set times or when something happens, as if the user had sent it; they may not be watching then. Write the schedule the way the user asks. The user reviews it before saving it.

It is now ${WEEKDAYS[p.weekday]}, ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} in the user's time zone (${timeZone}). Every time below is the user's local time.

The schedule now (as the form has it; anything may be empty or unfinished):
<schedule>
${JSON.stringify(formForLead(form, timeZone), null, 2)}
</schedule>

What the user asks for:
<request>
${request}
</request>

The message goes to ${who}. A file trigger looks in the working directory ${ctx.cwd}.

Mail accounts set up in Settings (id: name):
${accounts('mail', ctx.mail)}

Calendars set up in Settings (id: name):
${accounts('calendar', ctx.calendars)}

When it is sent ("repeat"):
- {"kind": "daily", "time": "HH:MM"}; {"kind": "weekly", "time": "HH:MM", "days": [1, 3]} (0 = Sunday … 6 = Saturday); {"kind": "interval", "hours": <1-${SCHEDULE_LIMITS.maxHours}>}; {"kind": "once", "at": "YYYY-MM-DDTHH:MM"} (a time still to come); {"kind": "manual"} (only when the user clicks Run once now, or a program calls its webhook).
- {"kind": "event", "triggers": [...]}: when any of 1 to ${WATCH_LIMITS.triggers} things happens (no two the same): {"source": "mail", "account": "<id>", "folder": "INBOX", "from": "<words its sender has, or empty>", "subject": "<words its subject has, or empty>"} for a new mail; {"source": "calendar", "account": "<id>", "minutes": <1-${WATCH_LIMITS.maxMinutes}>, "title": "<words its title has, or empty>"} for an event about to begin; {"source": "github", "repo": "owner/name", "on": "pr" | "ci", "branch": "<a CI run's branch, or empty>"} for a pull request opened or a CI run that failed; {"source": "file", "pattern": "<a path pattern in the working directory, such as inbox/*.csv>"} for a file that appears or changes.

Its options:
- "goal": what done means, in the user's words ("" for none): the schedule then tracks it, its runs report on it, a run that fails is tried again, and it switches off once the goal is met. Only when the user's request has an end.
- "newChat": true opens a new chat for each run (a clean start each time); false sends it in this chat.
- "missed": "run" runs a time missed while Harness Relay was not running as soon as it can; "skip" skips it.
- "approvals": "deny" refuses what the team's file permission does not cover in its runs (nobody may be watching); "ask" asks in the chat and waits for the user.

How to write it:
- "text" is the message the team gets each time: a task complete in itself, in the user's words and language, that says what to do and what to report; at most ${SCHEDULE_LIMITS.maxText} characters.
- When the schedule has a message already, change only what the user asks for, and keep everything else as it is.
- Use only the accounts listed above. When a trigger needs one the list does not have, or the user did not say which of several, give "" and say in the reason that the user picks it.
- When the request cannot be done with a schedule (for example, a time that has passed), return the schedule as it is and say why in the reason.

Write the reason in the language of the user's request.

Reply with only this JSON object, in a \`\`\`json code block, with the whole schedule:
{"text": "<the message>", "repeat": {"kind": "daily" | "weekly" | "interval" | "once" | "manual" | "event", "time": "<HH:MM, or null>", "days": [<0-6>] or null, "hours": <hours, or null>, "at": "<YYYY-MM-DDTHH:MM, or null>", "triggers": [...] or null}, "goal": "<what done means, or empty>", "newChat": <true|false>, "missed": "skip" | "run", "approvals": "deny" | "ask", "reason": "<what you wrote or changed and why: one or two sentences for the user>"}`;
}

const TRIGGER_SCHEMA = strictObject({
  source: { type: 'string', enum: ['mail', 'calendar', 'github', 'file'] },
  account: orNull('string', 'mail and calendar: the account id, "" for none'),
  folder: orNull('string', 'mail'),
  from: orNull('string', 'mail'),
  subject: orNull('string', 'mail'),
  minutes: orNull('integer', 'calendar'),
  title: orNull('string', 'calendar'),
  repo: orNull('string', 'github: owner/name'),
  on: { anyOf: [{ type: 'string', enum: ['pr', 'ci'] }, { type: 'null' }] },
  branch: orNull('string', 'github CI runs'),
  pattern: orNull('string', 'file'),
});

/** The drafted schedule (`buildSchedulePrompt()`, `decideSchedule()`): null for what its kind does not have. */
export const SCHEDULE_SCHEMA: OutputSchema = strictObject({
  text: { type: 'string' },
  repeat: strictObject({
    kind: { type: 'string', enum: ['daily', 'weekly', 'interval', 'once', 'manual', 'event'] },
    time: orNull('string', 'HH:MM'),
    days: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }], description: '0 = Sunday' },
    hours: orNull('integer'),
    at: orNull('string', 'YYYY-MM-DDTHH:MM'),
    triggers: { anyOf: [{ type: 'array', items: TRIGGER_SCHEMA }, { type: 'null' }] },
  }),
  goal: { type: 'string', description: '"" for none' },
  newChat: { type: 'boolean' },
  missed: { type: 'string', enum: ['skip', 'run'] },
  approvals: { type: 'string', enum: ['deny', 'ask'] },
  reason: { type: 'string' },
});

/** An account id `validateSchedule()` takes in place of one the user is to pick (it names no account). */
const NO_ACCOUNT = 'relay-picks-none';

/**
 * Turn the lead's schedule into one the form can show, checked as a saved one is (throws, saying why,
 * when it cannot be one). A mail or calendar trigger keeps its account only when it is one of those
 * listed (the only one there is, when the lead named none); else it has none (`''`), for the user to
 * pick. `enabled` stays as the form had it.
 */
export function decideSchedule(
  raw: Record<string, any>,
  form: Partial<ScheduleUpdate> | undefined,
  timeZone: string,
  now: number,
  ctx: Pick<ScheduleContext, 'mail' | 'calendars'>,
): { schedule: ScheduleUpdate; reason: string } {
  const reason = String(raw.reason ?? '')
    .trim()
    .slice(0, 800);
  const proposal = readProposal(raw);
  if (!proposal) throw new Error('the lead agent gave no schedule that could be made');
  const known = (t: ScheduleTrigger): string => {
    if (t.source !== 'mail' && t.source !== 'calendar') return '';
    const list = t.source === 'mail' ? ctx.mail : ctx.calendars;
    if (list.some((a) => a.id === t.account)) return t.account;
    return list.length === 1 ? list[0]!.id : '';
  };
  const update = proposalUpdate(proposal, timeZone);
  if (update.repeat.kind === 'event') {
    update.repeat = {
      kind: 'event',
      triggers: update.repeat.triggers.map((t) => (t.source === 'mail' || t.source === 'calendar' ? { ...t, account: known(t) } : t)),
    };
  }
  // Checked with a stand-in for an account the user is to pick, which is then taken out again.
  const checked = validateSchedule(
    {
      ...update,
      repeat:
        update.repeat.kind === 'event'
          ? {
              ...update.repeat,
              triggers: update.repeat.triggers.map((t) =>
                (t.source === 'mail' || t.source === 'calendar') && !t.account ? { ...t, account: NO_ACCOUNT } : t,
              ),
            }
          : update.repeat,
      enabled: form?.enabled !== false,
      approvals: raw.approvals === 'ask' ? 'ask' : 'deny',
    },
    now,
  );
  if (checked.repeat.kind === 'event') {
    checked.repeat = {
      kind: 'event',
      triggers: checked.repeat.triggers.map((t) =>
        (t.source === 'mail' || t.source === 'calendar') && t.account === NO_ACCOUNT ? { ...t, account: '' } : t,
      ),
    };
  }
  return { schedule: checked, reason };
}
