import { describe, expect, it } from 'vitest';
import { SCHEDULE_SCHEMA, buildSchedulePrompt, decideSchedule } from '../src/server/scheduleDraft';

const now = Date.UTC(2026, 10, 23, 1, 0); // Monday 09:00 in Taipei
const ctx = { cwd: '/work', mail: [], calendars: [] };

describe('a schedule the lead agent writes', () => {
  it('tells the lead the time in the user’s zone, the form as it is, the accounts and who gets the message', () => {
    const prompt = buildSchedulePrompt(
      'move it to 10',
      { text: 'Morning summary', repeat: { kind: 'once', at: Date.UTC(2026, 10, 24, 1, 0) }, approvals: 'ask' },
      'Asia/Taipei',
      now,
      {
        ...ctx,
        team: ['Alice'],
        mail: [{ id: 'work', name: 'Work', address: 'me@work.example' }],
        calendars: [{ id: 'cal', name: 'Cal' }],
      },
    );
    expect(prompt).toContain("It is now Monday, 2026-11-23 09:00 in the user's time zone (Asia/Taipei)");
    expect(prompt).toContain('"at": "2026-11-24T09:00"');
    expect(prompt).toContain('"approvals": "ask"');
    expect(prompt).toContain('- "work": Work (me@work.example)');
    expect(prompt).toContain('- "cal": Cal');
    expect(prompt).toContain("the conversation's team (@Alice)");
    expect(prompt).toContain('A file trigger looks in the working directory /work.');
    expect(buildSchedulePrompt('x', undefined, 'UTC', now, ctx)).toContain('a new automation: once the user saves it');
  });

  it('asks for the whole schedule in the strict shape', () => {
    expect(SCHEDULE_SCHEMA).toMatchObject({ required: ['text', 'repeat', 'goal', 'newChat', 'missed', 'approvals', 'reason'] });
  });

  it('turns the lead’s schedule into the form’s, checked as a saved one is, keeping the form on or off', () => {
    const r = decideSchedule(
      {
        text: ' Summary ',
        repeat: { kind: 'weekly', time: '10:00', days: [1, 3] },
        goal: '',
        newChat: false,
        missed: 'skip',
        approvals: 'ask',
        reason: 'Twice a week.',
      },
      { enabled: false },
      'Asia/Taipei',
      now,
      ctx,
    );
    expect(r).toEqual({
      schedule: {
        text: 'Summary',
        repeat: { kind: 'weekly', time: '10:00', days: [1, 3] },
        timeZone: 'Asia/Taipei',
        enabled: false,
        approvals: 'ask',
        missed: 'skip',
        newChat: false,
      },
      reason: 'Twice a week.',
    });
  });

  it('keeps an account only when it is set up, and leaves it for the user to pick when there are several', () => {
    const accounts = {
      mail: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      calendars: [{ id: 'c', name: 'C' }],
    };
    const r = decideSchedule(
      {
        text: 't',
        repeat: {
          kind: 'event',
          triggers: [
            { source: 'mail', account: 'b' },
            { source: 'mail', account: 'z', folder: 'Work' },
            { source: 'calendar', minutes: 5 },
          ],
        },
      },
      undefined,
      'UTC',
      now,
      accounts,
    );
    expect(r.schedule.repeat).toEqual({
      kind: 'event',
      triggers: [
        { source: 'mail', account: 'b', folder: 'INBOX' },
        { source: 'mail', account: '', folder: 'Work' },
        { source: 'calendar', account: 'c', minutes: 5 },
      ],
    });
  });

  it('refuses what cannot be a schedule', () => {
    expect(() => decideSchedule({ reason: 'cannot' }, undefined, 'UTC', now, ctx)).toThrow();
    expect(() => decideSchedule({ text: 't', repeat: { kind: 'once', at: '2026-11-22T09:00' } }, undefined, 'UTC', now, ctx)).toThrow();
  });
});
