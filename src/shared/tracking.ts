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

/** The block itself: its attributes (a `status` among them) and its text, with no other block inside it. */
const BLOCK = '<progress\\b([^>]*)>((?:(?!<progress\\b)[\\s\\S])*?)<\\/progress>';
/** The block at the end of a reply, on lines of its own. */
const PLAIN = new RegExp(`(?:^|\\n)[ \\t]*${BLOCK}\\s*$`, 'i');
/** The block alone in a code fence the agent wrapped it in, at the end of a reply. */
const FENCED = new RegExp(`(?:^|\\n)[ \\t]*\`\`\`[^\\n]*\\n[ \\t]*${BLOCK}[ \\t]*\\n[ \\t]*\`\`\`\\s*$`, 'i');

/**
 * What a reply's text says about the goal, and its text without the block. A block inside a code
 * fence with more than the block in it is code, and stays.
 */
export function splitProgress(text: string): { text: string; progress?: { status: ProgressStatus; text: string } } {
  const m = FENCED.exec(text) ?? PLAIN.exec(text);
  if (!m) return { text };
  const said = (/\bstatus\s*=\s*["']?([a-z]+)/i.exec(m[1] ?? '')?.[1] ?? 'working').toLowerCase();
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
  // A progress block as agents write it (`<progress>`, `<progress status=…>`, or still being typed),
  // not HTML's own <progress value=…> in a code block.
  const start = /(?:^|\n)[ \t]*(?:```[^\n]*\n[ \t]*)?<progress(?=\s*$|\s*>|\s+status\b|\s+[a-z-]*$)/gi;
  let last = -1;
  for (let m = start.exec(text); m; m = start.exec(text)) last = m.index;
  return last < 0 ? text : text.slice(0, last).trimEnd();
}
