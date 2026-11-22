// A steps card's logic (components/StepsCard.tsx): what an agent asked the user to do outside
// Harness Relay, each step ticked as they go, then their answer. Pure, so it can be tested.

import type { StepsPart } from '../shared/steps';

/** Where a card stands: waiting for the user (they tick and answer), answered, or no longer waited for. */
export type StepsCardState = 'waiting' | 'answered' | 'closed';

/** `waiting`: the team waits for this reply's answer now (the conversation paused, its run idle). */
export function stepsCardState(part: StepsPart, waiting: boolean): StepsCardState {
  if (part.answer) return 'answered';
  return waiting ? 'waiting' : 'closed';
}

/** Ticks the user made that the server has not shown back yet: the step's index and its new state. */
export type PendingTicks = ReadonlyMap<number, boolean>;

/** Each step's box as the card shows it: the server's, with the ticks still on their way over it. */
export function shownDone(part: StepsPart, pending: PendingTicks): boolean[] {
  return part.items.map((s, i) => pending.get(i) ?? Boolean(s.done));
}

/** The ticks still on their way once the server's card is `part`: those it does not show yet. */
export function unsettled(part: StepsPart, pending: PendingTicks): Map<number, boolean> {
  return new Map([...pending].filter(([i, done]) => Boolean(part.items[i]?.done) !== done));
}

/** How a step is marked: done, not done, or (in an answer) the one the user is stuck at. */
export type StepMark = 'done' | 'open' | 'stuck';

export function stepMark(part: StepsPart, done: readonly boolean[], i: number): StepMark {
  if (part.answer?.stuckAt === i) return 'stuck';
  return done[i] ? 'done' : 'open';
}

/** The step to offer as the one the user is stuck at: the first one not ticked, else the last. */
export function firstOpen(done: readonly boolean[]): number {
  const i = done.indexOf(false);
  return i >= 0 ? i : Math.max(0, done.length - 1);
}

/** What the card sends as the answer (`api.answerSteps`): the steps ticked, the one stuck at (never counted done), the note. */
export function answerBody(
  done: readonly boolean[],
  stuckAt: number | undefined,
  note: string,
): { done: number[]; stuckAt?: number; note?: string } {
  const text = note.trim();
  return {
    done: done.flatMap((d, i) => (d && i !== stuckAt ? [i] : [])),
    ...(stuckAt !== undefined ? { stuckAt } : {}),
    ...(text ? { note: text } : {}),
  };
}

/** A step in a few plain words, for the list of steps to be stuck at: links' words, no Markdown marks, cut short. */
export function stepWords(text: string, max = 60): string {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+|\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_]+(?=\S)|(?<=\S)[*_]+(?=\s|$|[.,;:!?。，、！？])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** The steps as a Markdown task list (a reply's copy, the transcript): ticked ones checked. */
export function stepsMarkdown(part: StepsPart): string {
  return part.items.map((s, i) => `- [${s.done && part.answer?.stuckAt !== i ? 'x' : ' '}] ${s.text.replace(/\n/g, '\n  ')}`).join('\n');
}
