import { describe, expect, it } from 'vitest';
import {
  localMoment,
  proposalGaps,
  proposalUpdate,
  readProposal,
  splitSchedule,
  withoutScheduleBlocks,
} from '../src/shared/scheduleProposal';
import { validateSchedule } from '../src/server/validate';

const block = (v: unknown) => `<schedule>${JSON.stringify(v)}</schedule>`;
const weekdays = { text: 'Sum up the merged pull requests', repeat: { kind: 'weekly', time: '09:00', days: [5, 1, 3, 1] } };

describe('a schedule an agent proposes in its reply', () => {
  it('takes the block out of the text, wherever it is, and reads what it proposes', () => {
    const { text, proposal } = splitSchedule(`I can do that.\n\n${block(weekdays)}\n\nSay if you want another time.`);
    expect(text).toBe('I can do that.\n\nSay if you want another time.');
    expect(proposal).toEqual({ text: 'Sum up the merged pull requests', repeat: { kind: 'weekly', time: '09:00', days: [1, 3, 5] } });
  });

  it('takes a block alone in a code fence with its fence, and the last usable one of several', () => {
    const fenced =
      'Here:\n```json\n' +
      block({ text: 'first', repeat: { kind: 'manual' } }) +
      '\n```\nand\n' +
      block({ text: 'second', repeat: { kind: 'interval', hours: 6 } });
    expect(splitSchedule(fenced)).toEqual({ text: 'Here:\n\nand', proposal: { text: 'second', repeat: { kind: 'interval', hours: 6 } } });
    // A fence with more in it than the block is left as it is, but the block in it still goes.
    const mixed = '```\nexample\n' + block({ text: 'x', repeat: { kind: 'manual' } }) + '\n```';
    expect(splitSchedule(mixed).text).toBe('```\nexample\n\n```');
  });

  it("keeps the rest of the reply as it was written, a code block's empty lines included", () => {
    const code = '```\na\n\n\n\nb\n```';
    expect(splitSchedule(`${code}\n\n\n${block(weekdays)}\n\n\nAfter.`).text).toBe(`${code}\n\nAfter.`);
    expect(splitSchedule(`${block(weekdays)}\n\nOnly after.`).text).toBe('Only after.');
  });

  it('leaves the text as it is when no block is usable, so the mistake shows', () => {
    for (const bad of [
      '<schedule>not json</schedule>',
      block({ text: '', repeat: { kind: 'daily', time: '09:00' } }),
      block({ text: 'x', repeat: { kind: 'hourly' } }),
      block({ text: 'x', repeat: { kind: 'daily', time: '9am' } }),
      block({ text: 'x', repeat: { kind: 'weekly', time: '09:00', days: [] } }),
      block({ text: 'x', repeat: { kind: 'once', at: 'tomorrow' } }),
      block({ text: 'x', repeat: { kind: 'event', triggers: [] } }),
      block({ text: 'x', repeat: { kind: 'event', triggers: [{ source: 'github', repo: 'not a repo' }] } }),
      block({ text: 'x'.repeat(4001), repeat: { kind: 'manual' } }),
      '<schedule>{"text": "never closed"',
    ]) {
      expect(splitSchedule(`Sure. ${bad}`)).toEqual({ text: `Sure. ${bad}` });
    }
  });

  it('reads day names, a once time with a space, its options, and triggers whose account is for the user to pick', () => {
    expect(readProposal({ text: 't', repeat: { kind: 'weekly', time: '18:30', days: ['Monday', 'fri', 'sun'] } })?.repeat).toEqual({
      kind: 'weekly',
      time: '18:30',
      days: [0, 1, 5],
    });
    expect(
      readProposal({ text: 't', repeat: { kind: 'once', at: '2026-12-01 09:00' }, goal: '  ship it ', newChat: true, missed: 'run' }),
    ).toEqual({
      text: 't',
      repeat: { kind: 'once', at: '2026-12-01T09:00' },
      goal: 'ship it',
      newChat: true,
      missed: 'run',
    });
    expect(
      readProposal({
        text: 't',
        repeat: {
          kind: 'event',
          triggers: [
            { source: 'mail', from: 'boss', subject: 'urgent' },
            { source: 'calendar', minutes: 15, account: 'work-cal' },
            { source: 'github', repo: 'https://github.com/acme/app', on: 'ci', branch: 'main' },
            { source: 'file', pattern: './inbox/*.csv' },
          ],
        },
      })?.repeat,
    ).toEqual({
      kind: 'event',
      triggers: [
        { source: 'mail', account: '', folder: 'INBOX', from: 'boss', subject: 'urgent' },
        { source: 'calendar', account: 'work-cal', minutes: 15 },
        { source: 'github', repo: 'acme/app', on: 'ci', branch: 'main' },
        { source: 'file', pattern: 'inbox/*.csv' },
      ],
    });
  });

  it('hides blocks while the reply streams, also one still being written and the start of its tag', () => {
    expect(withoutScheduleBlocks(`Done. ${block(weekdays)} More.`)).toBe('Done.  More.');
    expect(withoutScheduleBlocks('Done.\n<schedule>{"text": "half')).toBe('Done.\n');
    expect(withoutScheduleBlocks('Done.\n<sched')).toBe('Done.\n');
    expect(withoutScheduleBlocks('a < b')).toBe('a < b');
  });

  it('reads a reply full of opening tags in time proportional to its size', () => {
    const many = '<schedule>'.repeat(50_000);
    const started = Date.now();
    expect(splitSchedule(many)).toEqual({ text: many });
    expect(withoutScheduleBlocks(many)).toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('making a proposed schedule', () => {
  it('saves it on, refusing approvals, in the user’s time zone, as a saved schedule is checked', () => {
    const p = readProposal({ text: 'Remind me', repeat: { kind: 'once', at: '2026-12-01T09:00' }, goal: 'done', newChat: true })!;
    const update = proposalUpdate(p, 'Asia/Taipei');
    expect(update).toEqual({
      text: 'Remind me',
      repeat: { kind: 'once', at: Date.UTC(2026, 11, 1, 1, 0) },
      timeZone: 'Asia/Taipei',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: true,
      goal: 'done',
    });
    expect(validateSchedule(update, Date.UTC(2026, 10, 23))).toEqual(update);
  });

  it('reads a once time only as a real one, through a change of the clocks', () => {
    expect(localMoment('2026-13-01T09:00', 'UTC')).toBeUndefined();
    expect(localMoment('2026-02-30T09:00', 'UTC')).toBeUndefined();
    expect(localMoment('2028-02-29T09:00', 'UTC')).toBe(Date.UTC(2028, 1, 29, 9, 0));
    // A block with a date that is not one proposes nothing.
    expect(readProposal({ text: 't', repeat: { kind: 'once', at: '2026-02-30T09:00' } })).toBeUndefined();
    expect(localMoment('yesterday', 'UTC')).toBeUndefined();
    // New York goes from EST to EDT on 8 March 2026.
    expect(localMoment('2026-03-08T12:00', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 16, 0));
    expect(localMoment('2026-03-07T12:00', 'America/New_York')).toBe(Date.UTC(2026, 2, 7, 17, 0));
  });

  it('says what the form has to settle first: a time that passed, a trigger without an account', () => {
    const now = Date.UTC(2026, 10, 23);
    expect(proposalGaps(readProposal({ text: 't', repeat: { kind: 'once', at: '2026-11-22T09:00' } })!, 'UTC', now)).toEqual(['past']);
    expect(proposalGaps(readProposal({ text: 't', repeat: { kind: 'event', triggers: [{ source: 'mail' }] } })!, 'UTC', now)).toEqual([
      'account',
    ]);
    expect(
      proposalGaps(readProposal({ text: 't', repeat: { kind: 'event', triggers: [{ source: 'github', repo: 'a/b' }] } })!, 'UTC', now),
    ).toEqual([]);
    expect(proposalGaps(readProposal(weekdays)!, 'UTC', now)).toEqual([]);
    // The fixed command it names is not saved (when the saved ones are known).
    const posting = readProposal({ ...weekdays, command: 'post' })!;
    expect(proposalGaps(posting, 'UTC', now, ['check'])).toEqual(['command']);
    expect(proposalGaps(posting, 'UTC', now, ['post'])).toEqual([]);
    expect(proposalGaps(posting, 'UTC', now)).toEqual([]);
  });

  it('names a fixed command that runs first, or alone, on its own times; then no goal and no new chat', () => {
    const p = readProposal({ ...weekdays, command: ' Post ', commandOnly: true, goal: 'all posted', newChat: true })!;
    expect(p).toMatchObject({ command: 'post', commandOnly: true });
    expect(p).not.toHaveProperty('goal');
    expect(p).not.toHaveProperty('newChat');
    expect(readProposal({ ...weekdays, command: 'post' })).not.toHaveProperty('commandOnly');
    expect(readProposal({ ...weekdays, commandOnly: true })).not.toHaveProperty('commandOnly');
    // A name that is not one: the block proposes nothing, so the agent's mistake shows.
    expect(readProposal({ ...weekdays, command: 'Bad Name!' })).toBeUndefined();
    // An automation that waits for something never runs one: the block proposes nothing, as the agent's mistake.
    expect(
      readProposal({ text: 't', repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.csv' }] }, command: 'post' }),
    ).toBeUndefined();
    // Made with the saved command's id; without it (not saved), with none.
    expect(proposalUpdate(p, 'UTC', 'cmd-9')).toMatchObject({ command: 'cmd-9', commandOnly: true });
    expect(proposalUpdate(p, 'UTC')).not.toHaveProperty('command');
    expect(validateSchedule(proposalUpdate(p, 'UTC', 'cmd-9'), Date.UTC(2026, 10, 23))).toMatchObject({
      command: 'cmd-9',
      commandOnly: true,
    });
  });
});
