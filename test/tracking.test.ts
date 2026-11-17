import { describe, expect, it } from 'vitest';
import { freshTracking, retryDelayMs, splitProgress, withNote, withoutProgressTail } from '../src/shared/tracking';
import { TRACKING_LIMITS, type ProgressNote } from '../src/shared/types';

describe("a reply's <progress> block", () => {
  it('is taken off the end of the reply, with its status and text', () => {
    expect(splitProgress('Checked CI.\n\n<progress status="working">2 of 5 jobs pass; the rest still fail</progress>')).toEqual({
      text: 'Checked CI.',
      progress: { status: 'working', text: '2 of 5 jobs pass; the rest still fail' },
    });
    expect(splitProgress("All green.\n<progress status='done'>\nCI passes and #42 is closed.\n</progress>\n")).toEqual({
      text: 'All green.',
      progress: { status: 'done', text: 'CI passes and #42 is closed.' },
    });
    expect(splitProgress('<PROGRESS status=BLOCKED>needs a token</PROGRESS>')).toEqual({
      text: '',
      progress: { status: 'blocked', text: 'needs a token' },
    });
  });

  it('reads a block without a status, or with one it does not know, as working', () => {
    expect(splitProgress('x\n<progress>still going</progress>').progress).toEqual({ status: 'working', text: 'still going' });
    expect(splitProgress('x\n<progress status="finished">?</progress>').progress).toEqual({ status: 'working', text: '?' });
  });

  it('is found inside a code fence the agent wrapped it in', () => {
    expect(splitProgress('Report.\n```\n<progress status="done">ok</progress>\n```')).toEqual({
      text: 'Report.',
      progress: { status: 'done', text: 'ok' },
    });
  });

  it('is only the last block, at the end and at the start of a line', () => {
    expect(splitProgress('Said <progress status="done">x</progress> in passing, then more text.')).toEqual({
      text: 'Said <progress status="done">x</progress> in passing, then more text.',
    });
    expect(splitProgress('<progress status="done">x</progress>\nThen more text.').progress).toBeUndefined();
    const two = splitProgress('<progress status="done">old</progress>\nMore.\n<progress status="working">new</progress>');
    expect(two).toEqual({ text: '<progress status="done">old</progress>\nMore.', progress: { status: 'working', text: 'new' } });
  });

  it('reads the status among other attributes, and leaves a block inside a code fence with more in it as code', () => {
    expect(splitProgress('ok\n<progress percent="50" status="done">half</progress>').progress).toEqual({ status: 'done', text: 'half' });
    const fenced = 'Log:\n```\nline\n<progress status="done">x</progress>\n```';
    expect(splitProgress(fenced)).toEqual({ text: fenced });
  });

  it('cuts a long note to its limit', () => {
    const long = 'a'.repeat(TRACKING_LIMITS.noteChars + 50);
    expect(splitProgress(`<progress>${long}</progress>`).progress!.text).toHaveLength(TRACKING_LIMITS.noteChars);
  });

  it('hides a block that has begun while the reply streams, finished or not', () => {
    expect(withoutProgressTail('Working on it.\n<progress status="work')).toBe('Working on it.');
    expect(withoutProgressTail('Done.\n<progress status="done">ok</progress>')).toBe('Done.');
    expect(withoutProgressTail('No block here, <progress> mid-line.')).toBe('No block here, <progress> mid-line.');
    expect(withoutProgressTail('a\n```\n<progress>')).toBe('a');
    // HTML's own progress element in a code block is not a block of ours.
    const html = 'A bar:\n```html\n<progress value="50" max="100"></progress>\n```\nMore text.';
    expect(withoutProgressTail(html)).toBe(html);
    expect(withoutProgressTail('x\n<progress status="done">')).toBe('x');
  });
});

describe('the tracking state', () => {
  const note = (i: number, status: ProgressNote['status'] = 'working'): ProgressNote => ({ at: i, status, text: `note ${i}` });

  it("takes the latest note's status and keeps only the latest notes", () => {
    let t = freshTracking();
    expect(t).toEqual({ status: 'working', notes: [] });
    t = withNote(t, note(1, 'blocked'));
    expect(t.status).toBe('blocked');
    for (let i = 2; i <= TRACKING_LIMITS.notes + 5; i++) t = withNote(t, note(i));
    expect(t.notes).toHaveLength(TRACKING_LIMITS.notes);
    expect(t.notes[0]!.at).toBe(6);
    expect(t.status).toBe('working');
    // What else it holds stays.
    expect(withNote({ ...t, inFlight: { due: 1, attempt: 0, chatId: 'c' } }, note(99, 'done')).inFlight).toEqual({
      due: 1,
      attempt: 0,
      chatId: 'c',
    });
  });

  it('waits 5, 30 and 120 minutes before the retries of a failed time, and has no fourth', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([5 * 60_000, 30 * 60_000, 120 * 60_000, undefined]);
  });
});
