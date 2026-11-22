/*
 * A steps card in the page (src/web/steps.ts, components/StepsCard.tsx): where it stands, the boxes as
 * shown while ticks are on their way, the answer it sends, and the steps in a reply's copy, the
 * transcript and a shared page.
 */
import { describe, expect, it } from 'vitest';
import type { StepsPart } from '../src/shared/steps';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { segments } from '../src/web/chat';
import { conversationMarkdown, messageText } from '../src/web/copy';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { SHARE_DROP } from '../src/web/share';
import { answerBody, firstOpen, shownDone, stepMark, stepWords, stepsCardState, stepsMarkdown, unsettled } from '../src/web/steps';

const part = (over: Partial<StepsPart> = {}): StepsPart => ({
  type: 'steps',
  items: [
    { text: 'Open [the console](https://example.com)', done: true },
    { text: 'Create a key' },
    { text: '**Copy** it\nto a safe place' },
  ],
  ...over,
});

describe('a steps card', () => {
  it('waits for the user while the team does, then shows the answer or that it is no longer waited for', () => {
    expect(stepsCardState(part(), true)).toBe('waiting');
    expect(stepsCardState(part(), false)).toBe('closed');
    expect(stepsCardState(part({ answer: { at: 1 } }), false)).toBe('answered');
    expect(stepsCardState(part({ answer: { at: 1 } }), true)).toBe('answered');
    // Still waited for while the team replies to another card's answer.
    expect(stepsCardState(part(), false, true)).toBe('later');
    expect(stepsCardState(part({ answer: { at: 1 } }), false, true)).toBe('answered');
  });

  it('shows a tick at once, until the server shows it back', () => {
    const pending = new Map([
      [1, true],
      [0, false],
    ]);
    expect(shownDone(part(), pending)).toEqual([false, true, false]);
    // The server shows step 2 ticked: only the untick of step 1 is still on its way.
    const later = part({ items: [{ text: 'a', done: true }, { text: 'b', done: true }, { text: 'c' }] });
    expect([...unsettled(later, pending)]).toEqual([[0, false]]);
    expect(unsettled(later, new Map()).size).toBe(0);
  });

  it('marks each step, the one stuck at above its box', () => {
    const answered = part({ answer: { at: 1, stuckAt: 1 } });
    const done = [true, false, false];
    expect([0, 1, 2].map((i) => stepMark(answered, done, i))).toEqual(['done', 'stuck', 'open']);
    expect(stepMark(part(), done, 1)).toBe('open');
  });

  it('offers the first step not ticked as the one stuck at, else the last', () => {
    expect(firstOpen([true, false, false])).toBe(1);
    expect(firstOpen([true, true])).toBe(1);
    expect(firstOpen([])).toBe(0);
  });

  it('sends the steps ticked, the one stuck at never among them, and a note only when there is one', () => {
    expect(answerBody([true, false, true], undefined, '  ')).toEqual({ done: [0, 2] });
    expect(answerBody([true, true, false], 1, ' The page said no. ')).toEqual({ done: [0], stuckAt: 1, note: 'The page said no.' });
  });

  it('names a step in the list to be stuck at in a few plain words', () => {
    expect(stepWords('Open [the console](https://example.com) and **sign in**.')).toBe('Open the console and sign in.');
    expect(stepWords('Set `REDIRECT_URI` to *your* address')).toBe('Set REDIRECT_URI to your address');
    expect(stepWords('x'.repeat(100))).toHaveLength(60);
  });
});

describe('a reply with steps elsewhere in the page', () => {
  const reply: ChatMessage = {
    id: 'r',
    author: { kind: 'agent', agentId: 'a' },
    agentName: 'Alice',
    createdAt: 0,
    status: 'done',
    asked: true,
    parts: [{ type: 'text', text: 'Set it up first.' }, part({ answer: { at: 1, stuckAt: 0 } })],
  };

  it('is a segment of its own in the chat (none for an empty card)', () => {
    expect(segments(reply.parts).map((s) => s.kind)).toEqual(['text', 'steps']);
    expect(segments([{ type: 'steps', items: [] }])).toEqual([]);
  });

  it('copies and goes into the transcript as a task list, ticked as the user left it', () => {
    expect(stepsMarkdown(part())).toBe(
      '- [x] Open [the console](https://example.com)\n- [ ] Create a key\n- [ ] **Copy** it\n  to a safe place',
    );
    expect(messageText(reply)).toBe(
      'Set it up first.\n\n- [ ] Open [the console](https://example.com)\n- [ ] Create a key\n- [ ] **Copy** it\n  to a safe place',
    );
    const conv = {
      id: 'c',
      title: 'Setup',
      agents: [{ id: 'a', name: 'Alice', provider: 'claude' }],
      messages: [reply],
    } as unknown as Conversation;
    expect(conversationMarkdown(conv, en)).toContain('**@Alice** · Claude Code\n\nSet it up first.\n\n- [ ] Open');
  });

  it('keeps its steps on a shared page, without what it asks of the user in the chat', () => {
    for (const cls of ['.steps-wait', '.steps-actions', '.steps-closed', '.steps-later']) expect(SHARE_DROP).toContain(cls);
    expect(SHARE_DROP).not.toContain('.steps-card');
    expect(SHARE_DROP).not.toContain('.steps-list');
  });

  it('says the same in both languages', () => {
    expect(Object.keys(en.stepCard).sort()).toEqual(Object.keys(zhTW.stepCard).sort());
    expect(en.stepCard.doneSome(2, 3)).toBe('Send (2 of 3 done)');
    expect(zhTW.stepCard.banner('@Alice')).toBe('@Alice 給了你要做的步驟');
  });
});
