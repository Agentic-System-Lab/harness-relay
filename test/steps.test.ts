import { describe, expect, it } from 'vitest';
import { askingReplies } from '../src/shared/ask';
import { alertDetail } from '../src/shared/notify';
import { splitSteps, stepsAnswerText, stepsBlock, stepsOfMessage, unmention, withoutStepsTail, type StepsWords } from '../src/shared/steps';
import { STEPS_LIMITS, type ChatMessage } from '../src/shared/types';

const steps = (text: string) => splitSteps(text).steps;

describe('splitSteps', () => {
  it('takes a block at the end of a reply, one step a line, numbering and bullets taken off', () => {
    const reply = 'Set up the app first.\n\n<steps>\n1. Open the [console](https://example.com/apps).\n2. Create an app.\n</steps>';
    expect(splitSteps(reply)).toEqual({
      text: 'Set up the app first.',
      steps: ['Open the [console](https://example.com/apps).', 'Create an app.'],
    });
    expect(steps('<steps>\n- one\n* two\n+ three\n• four\n</steps>')).toEqual(['one', 'two', 'three', 'four']);
    expect(steps('<steps>\n1) one\n(2) two\n- [ ] three\n- [x] four\n</steps>')).toEqual(['one', 'two', 'three', 'four']);
    expect(steps('<steps>\n1、打開主控台\n2．建立 app\n步驟 3：複製 ID\n第4步 開啟 API\n</steps>')).toEqual([
      '打開主控台',
      '建立 app',
      '複製 ID',
      '開啟 API',
    ]);
  });

  it('takes each line as a step when none is numbered, and leaves out blank lines', () => {
    expect(steps('<steps>\nSign in\n\n  Open Settings  \nTurn it on\n</steps>')).toEqual(['Sign in', 'Open Settings', 'Turn it on']);
  });

  it('puts an unmarked line, or a deeper bullet, on the step before it', () => {
    expect(
      steps('<steps>\n1. Create the app:\n   - Name: Relay\n   - Type: Business\n2. Copy its ID.\n   It is under Settings.\n</steps>'),
    ).toEqual(['Create the app:\n- Name: Relay\n- Type: Business', 'Copy its ID.\nIt is under Settings.']);
  });

  it('reads the tags with Markdown marks around them, a step on their lines, or no closing tag', () => {
    expect(steps('**<steps>**\n1. one\n**</steps>**')).toEqual(['one']);
    expect(steps('`<steps>`\n1. one\n`</steps>`')).toEqual(['one']);
    expect(steps('<steps>1. one\n2. two</steps>')).toEqual(['one', 'two']);
    expect(splitSteps('Do this:\n<steps>\n1. one\n2. two')).toEqual({ text: 'Do this:', steps: ['one', 'two'] });
    expect(steps('<STEPS title="Setup">\n1. one\n</Steps >')).toEqual(['one']);
  });

  it('takes a block a code fence holds alone, fence and all', () => {
    expect(splitSteps('Here:\n\n```text\n<steps>\n1. one\n2. two\n</steps>\n```')).toEqual({ text: 'Here:', steps: ['one', 'two'] });
    expect(splitSteps('Here:\n~~~\n\n<steps>\n1. one\n</steps>\n\n~~~\nThanks.')).toEqual({ text: 'Here:\n\nThanks.', steps: ['one'] });
  });

  it('leaves a block among other code, or one running across a fence, as text', () => {
    const code = 'The syntax:\n```\nx = 1\n<steps>\n1. one\n</steps>\n```';
    expect(splitSteps(code)).toEqual({ text: code });
    const across = 'Look:\n<steps>\n1. one\n```\ncode\n```\n</steps>';
    expect(splitSteps(across)).toEqual({ text: across });
    // Indented as code.
    expect(splitSteps('Code:\n\n    <steps>\n    1. one\n    </steps>').steps).toBeUndefined();
  });

  it('leaves a block with no step, or too many or too long, as text', () => {
    expect(splitSteps('Done.\n<steps>\n\n</steps>')).toEqual({ text: 'Done.\n<steps>\n\n</steps>' });
    expect(splitSteps('<steps/>').steps).toBeUndefined();
    const many = `<steps>\n${Array.from({ length: STEPS_LIMITS.steps + 1 }, (_, i) => `${i + 1}. step`).join('\n')}\n</steps>`;
    expect(splitSteps(many)).toEqual({ text: many });
    const long = `<steps>\n1. ${'x'.repeat(STEPS_LIMITS.blockChars)}\n</steps>`;
    expect(splitSteps(long)).toEqual({ text: long });
  });

  it('keeps the text after the block, and takes the last block when there are several', () => {
    expect(splitSteps('Intro\n<steps>\n1. one\n</steps>\nTell me when you are done.')).toEqual({
      text: 'Intro\n\nTell me when you are done.',
      steps: ['one'],
    });
    expect(splitSteps('<steps>\n1. first\n</steps>\nThen:\n<steps>\n1. second\n</steps>')).toEqual({
      text: '<steps>\n1. first\n</steps>\nThen:',
      steps: ['second'],
    });
  });

  it('only takes a tag that starts a line', () => {
    const inline = 'I could write <steps> here, but no.';
    expect(splitSteps(inline)).toEqual({ text: inline });
    expect(splitSteps('No steps at all.')).toEqual({ text: 'No steps at all.' });
    expect(splitSteps('<stepsfoo>\n1. one\n</stepsfoo>').steps).toBeUndefined();
  });

  it('drops an ask marker among the steps', () => {
    expect(steps('<steps>\n1. one\n2. Tell me when done [ASK_USER]\n</steps>')).toEqual(['one', 'Tell me when done']);
    expect(steps('<steps>\n1. one\n**[ASK_USER]**\n</steps>')).toEqual(['one']);
  });

  it('reads Windows line ends', () => {
    expect(splitSteps('Hi\r\n<steps>\r\n1. one\r\n</steps>\r\n')).toEqual({ text: 'Hi', steps: ['one'] });
  });
});

describe('withoutStepsTail', () => {
  it('hides a block that has begun while the reply streams', () => {
    expect(withoutStepsTail('Set it up.\n\n<steps>\n1. Open')).toBe('Set it up.');
    expect(withoutStepsTail('Set it up.\n<ste')).toBe('Set it up.');
    expect(withoutStepsTail('Set it up.\n```\n<steps>\n1. one')).toBe('Set it up.');
    expect(withoutStepsTail('Plain text <steps> inline')).toBe('Plain text <steps> inline');
    expect(withoutStepsTail('a < b')).toBe('a < b');
  });
});

describe('the user’s answer', () => {
  const words: StepsWords = {
    summary: (o) => `${o.agent}: ${o.done}/${o.total}${o.stuckAt ? ` stuck ${o.stuckAt}` : ''}`,
    done: 'done',
    notDone: 'not done',
    stuck: 'stuck here',
    note: 'Note: ',
  };
  const items = [{ text: 'Open the console', done: true }, { text: 'Ask @Bob for the key\nin the team chat' }, { text: 'Paste the ID' }];

  it('marks each step and adds the note, mentions in the steps addressing no one', () => {
    expect(stepsAnswerText({ agent: '@Alice', items, note: '  It asked for 2FA.  ', names: ['Alice', 'Bob'] }, words)).toBe(
      '@Alice: 1/3\n\n1. [done] Open the console\n2. [not done] Ask Bob for the key\n   in the team chat\n3. [not done] Paste the ID\n\nNote: It asked for 2FA.',
    );
  });

  it('marks the step the user is stuck at, never counted done', () => {
    const ticked = items.map((i) => ({ ...i, done: true }));
    expect(stepsAnswerText({ agent: '@Alice', items: ticked, stuckAt: 1, names: [] }, words)).toBe(
      '@Alice: 2/3 stuck 2\n\n1. [done] Open the console\n2. [stuck here] Ask @Bob for the key\n   in the team chat\n3. [done] Paste the ID',
    );
  });

  it('takes the @ off the mentions of a text that mentions anyone', () => {
    expect(unmention('Ask @Bob, not `@Bob` in code', ['Bob'])).toBe('Ask Bob, not `Bob` in code');
    expect(unmention('mail bob@Bob.dev', ['Bob'])).toBe('mail bob@Bob.dev');
    expect(unmention('Only `@Bob` in code', ['Bob'])).toBe('Only `@Bob` in code');
  });
});

const agentReply = (parts: ChatMessage['parts'], asked = true): ChatMessage => ({
  id: 'r',
  author: { kind: 'agent', agentId: 'a' },
  agentName: 'Alice',
  createdAt: 1,
  parts,
  status: 'done',
  asked,
});

describe('steps in the rest of the app', () => {
  it('finds a reply’s steps card, and renders it for agents as the block they write', () => {
    const msg = agentReply([
      { type: 'text', text: 'Hi' },
      { type: 'steps', items: [{ text: 'one' }, { text: 'two\nmore' }] },
    ]);
    expect(stepsOfMessage(msg)?.items).toHaveLength(2);
    expect(stepsBlock(stepsOfMessage(msg)!.items)).toBe('<steps>\n1. one\n2. two\n   more\n</steps>');
    expect(splitSteps(stepsBlock(stepsOfMessage(msg)!.items)).steps).toEqual(['one', 'two\nmore']);
  });

  it('lists the replies the team waits on: those that asked since the user last wrote', () => {
    const user: ChatMessage = { id: 'u', author: { kind: 'user' }, createdAt: 0, parts: [], status: 'done' };
    const old = { ...agentReply([]), id: 'old' };
    const now = { ...agentReply([]), id: 'now' };
    const other = { ...agentReply([], false), id: 'other' };
    expect(askingReplies([old, user, now, other]).map((m) => m.id)).toEqual(['now']);
    expect(askingReplies([now, user])).toEqual([]);
  });

  it('tells a notification what the steps are when the reply said nothing else', () => {
    const conv = {
      agents: [{ id: 'a', name: 'Alice', provider: 'claude' as const, role: '' }],
      messages: [agentReply([{ type: 'steps', items: [{ text: 'Open [the console](https://example.com)' }, { text: 'Copy the ID' }] }])],
    };
    expect(alertDetail(conv, 'answer')).toEqual({ agent: 'Alice', text: 'Open the console · Copy the ID' });
  });
});
