import { PROGRESS_STATUSES, TRACKING_LIMITS, type ProgressNote, type ProgressStatus, type ScheduleTracking } from './types';

/*
 * A schedule that tracks a goal (`ConversationSchedule.goal`): what the agents say about it. An agent
 * ends a reply to a scheduled message with one block,
 *
 *   <progress status="working|done|blocked">what changed, what is left</progress>
 *
 * which is taken out of the reply's text (the chat shows it as the schedule's progress instead) and
 * kept with the schedule as a note. Pure, shared by the server and the UI.
 */

/** The block at the end of a reply, also when wrapped in a code fence or followed by space. */
const PROGRESS_AT_END = /(?:^|\n)[ \t]*(?:```[^\n]*\n)?[ \t]*<progress(?:\s+status\s*=\s*["']?([a-z]+)["']?)?\s*>((?:(?!<progress)[\s\S])*?)<\/progress>[ \t]*(?:\n[ \t]*```)?\s*$/i;

/** What a reply's text says about the goal, and its text without the block. */
export function splitProgress(text: string): { text: string; progress?: { status: ProgressStatus; text: string } } {
  const m = PROGRESS_AT_END.exec(text);
  if (!m) return { text };
  const said = (m[1] ?? 'working').toLowerCase();
  const status = (PROGRESS_STATUSES as readonly string[]).includes(said) ? (said as ProgressStatus) : 'working';
  const note = m[2]!.trim().slice(0, TRACKING_LIMITS.noteChars);
  return { text: text.slice(0, m.index).trimEnd(), progress: { status, text: note } };
}

/** A new tracking state: nothing said yet. */
export function freshTracking(): ScheduleTracking {
  return { status: 'working', notes: [] };
}

/**
 * The tracking state once `note` is added: the goal's status is the note's, and only the latest
 * `TRACKING_LIMITS.notes` notes are kept.
 */
export function withNote(tracking: ScheduleTracking | undefined, note: ProgressNote): ScheduleTracking {
  const base = tracking ?? freshTracking();
  return { ...base, status: note.status, notes: [...base.notes, note].slice(-TRACKING_LIMITS.notes) };
}

/** How long to wait before the `attempt`th retry of a failed time (1 = the first), or undefined when there is none left. */
export function retryDelayMs(attempt: number): number | undefined {
  const minutes = TRACKING_LIMITS.retryMinutes[attempt - 1];
  return minutes === undefined ? undefined : minutes * 60_000;
}

/**
 * A reply's text while it streams: without a `<progress>` block that has begun at the start of a line
 * (finished or not), which is taken out once the reply ends.
 */
export function withoutProgressTail(text: string): string {
  const start = /(?:^|\n)[ \t]*(?:```[^\n]*\n[ \t]*)?<progress\b/gi;
  let last = -1;
  for (let m = start.exec(text); m; m = start.exec(text)) last = m.index;
  return last < 0 ? text : text.slice(0, last).trimEnd();
}
