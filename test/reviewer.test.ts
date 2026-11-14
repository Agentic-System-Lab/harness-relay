import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/types';
import { findQuote, hasQuote, highlightsByReply, quoteKey, reviewStart } from '../src/shared/review';
import { buildReviewPrompt, decideReview, hasNewReplies, parseReviewReply, reviewMaterial } from '../src/server/reviewer';

const user = (id: string, text: string): ChatMessage => ({ id, author: { kind: 'user' }, createdAt: 0, status: 'done', parts: [{ type: 'text', text }] });
const reply = (id: string, name: string, text: string, more: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: { kind: 'agent', agentId: name.toLowerCase() },
  agentName: name,
  provider: 'claude',
  createdAt: 0,
  status: 'done',
  parts: [{ type: 'text', text }],
  ...more,
});
const review = (id: string, status: 'ready' | 'failed' = 'ready', more: Partial<NonNullable<ChatMessage['review']>> = {}): ChatMessage => ({
  id,
  author: { kind: 'system' },
  createdAt: 0,
  status: 'done',
  parts: [],
  review: { status, lead: { provider: 'claude' }, ...more },
});

describe('finding the words a review quotes', () => {
  it('ignores case, runs of whitespace and Markdown marks, and quotation marks around the quote', () => {
    expect(hasQuote('This **deletes** the `cache` folder.', 'deletes the cache')).toBe(true);
    expect(hasQuote('Line one\n\n   line   two', 'one line two')).toBe(true);
    expect(hasQuote('It Works', '“it works”')).toBe(true);
    expect(hasQuote('A [link](https://example.com) here', 'A link here')).toBe(false); // the link's target stays in Markdown
    expect(hasQuote('nothing like it', 'something else')).toBe(false);
    expect(hasQuote('anything', '  ')).toBe(false);
    expect(quoteKey('…the rest...')).toBe('the rest');
  });

  it('finds them across text nodes, giving where they start and end in each', () => {
    // As a reply renders: "Run " + <code>rm -rf</code> + " now, then " + <strong>check</strong>.
    const parts = ['Run ', 'rm -rf', ' now, then ', 'check', '.'];
    expect(findQuote(parts, 'rm -rf now')).toEqual({ start: { part: 1, offset: 0 }, end: { part: 2, offset: 4 } });
    expect(findQuote(parts, 'then check')).toEqual({ start: { part: 2, offset: 6 }, end: { part: 3, offset: 5 } });
    expect(findQuote(parts, 'missing')).toBeUndefined();
    // Characters outside the BMP keep their place.
    expect(findQuote(['ok 🎉 done'], '🎉 done')).toEqual({ start: { part: 0, offset: 3 }, end: { part: 0, offset: 10 } });
  });
});

describe("what a review reads", () => {
  it('starts after the last review that was ready, and has something new only when a member answered since', () => {
    const msgs = [user('u1', 'q'), reply('r1', 'Alice', 'a'), review('v1'), user('u2', 'q2'), reply('r2', 'Bob', 'b'), review('v2', 'failed')];
    expect(reviewStart(msgs)).toBe(3);
    expect(hasNewReplies(msgs)).toBe(true);
    expect(hasNewReplies(msgs.slice(0, 3))).toBe(false);
    expect(hasNewReplies([...msgs.slice(0, 3), reply('p', 'Bob', '[PASS]', { passed: true })])).toBe(false);
    expect(hasNewReplies([...msgs.slice(0, 3), reply('e', 'Bob', '', { status: 'error', error: 'boom' })])).toBe(false);
  });

  it('numbers the replies since the last review, says how a failed one ended and what each turn changed, and keeps the rest as context', () => {
    const msgs = [
      user('u1', 'first'),
      reply('r1', 'Alice', 'old answer'),
      review('v1'),
      user('u2', 'second'),
      reply('r2', 'Alice', 'Which one? ', { asked: true }),
      reply('p', 'Bob', '[PASS]', { passed: true }),
      reply('r3', 'Bob', 'partial', { status: 'error', error: 'rate "limited"\nretry' }),
      reply('r4', 'Carol', '', {
        changes: [{ root: '/r', base: 'a', head: 'b', isolated: false, files: [{ path: 'src/x.ts', status: 'M', added: 1, deleted: 0 }] }],
      }),
    ];
    const m = reviewMaterial(msgs);
    expect(m.replies.map((r) => r.id)).toEqual(['r2', 'r3', 'r4']);
    expect(m.history).toBe('[User]: first\n\n[@Alice (Claude Code)]: old answer');
    expect(m.recent).toBe(
      [
        '<message from="user">\nsecond\n</message>',
        '<reply n="1" from="@Alice (Claude Code)" asked_the_user="yes">\nWhich one?\n</reply>',
        '<reply n="2" from="@Bob (Claude Code)" status="failed: rate  limited  retry">\npartial\n</reply>',
        '<reply n="3" from="@Carol (Claude Code)">\n(Files this turn changed: src/x.ts (M))\n</reply>',
      ].join('\n\n'),
    );
  });

  it('keeps the latest when there is too much, numbering only the replies it keeps', () => {
    const long = 'x'.repeat(5000);
    const msgs = [user('u', 'go'), ...Array.from({ length: 12 }, (_, i) => reply(`r${i}`, 'Alice', `${i} ${long}`))];
    const m = reviewMaterial(msgs);
    expect(m.recent.startsWith('(earlier messages left out)')).toBe(true);
    expect(m.replies.at(-1)!.id).toBe('r11');
    expect(m.replies.length).toBeLessThan(12);
    expect(m.recent).toContain(`<reply n="${m.replies.length}" from="@Alice (Claude Code)">\n11 `);
  });

  it('gives the lead the team, the folders and how to answer', () => {
    const m = reviewMaterial([user('u', 'go'), reply('r', 'Alice', 'done')]);
    const prompt = buildReviewPrompt(m, [{ id: 'a', name: 'Alice', provider: 'codex', role: 'Write   the\ncode' }], {
      permission: 'edit',
      cwd: '/work',
      extraCwds: ['/docs'],
    });
    expect(prompt).not.toContain('<conversation>');
    expect(prompt).toContain('- @Alice (Codex): Write the code');
    expect(prompt).toContain('The file permission is "edit" and the working directories are /work, /docs.');
    expect(prompt).toContain('<recent>\n<message from="user">\ngo\n</message>');
    expect(prompt).toContain('Reply with only this JSON object, in a ```json code block, with your review:');
  });
});

describe("turning the lead's answer into a review", () => {
  const replies = [reply('r1', 'Alice', 'We **must** migrate the DB first.'), reply('r2', 'Bob', 'I disagree.')];

  it('keeps highlights with a note, about a reply it was shown (by number or @name) or about all of them', () => {
    const r = decideReview(
      {
        summary: '  Mostly done.  ',
        highlights: [
          { kind: 'risk', reply: 1, quote: 'must migrate the DB', note: 'Data loss.' },
          { kind: 'conflict', reply: '@bob', quote: 'I agree', note: 'They disagree.' },
          { kind: 'verify', reply: '2', note: 'Check.' },
          { kind: 'decision', reply: 9, quote: 'anything', note: 'Unknown reply.' },
          { kind: 'odd', note: 'Overall.' },
          { kind: 'risk', reply: 1, quote: 'x' },
          'not an object',
        ],
      },
      replies,
    );
    expect(r.summary).toBe('Mostly done.');
    expect(r.highlights).toEqual([
      { kind: 'risk', note: 'Data loss.', messageId: 'r1', agentName: 'Alice', quote: 'must migrate the DB' },
      { kind: 'conflict', note: 'They disagree.', messageId: 'r2', agentName: 'Bob' },
      { kind: 'verify', note: 'Check.', messageId: 'r2', agentName: 'Bob' },
      { kind: 'decision', note: 'Unknown reply.' },
      { kind: 'note', note: 'Overall.' },
    ]);
    expect(r.nextSteps).toEqual([]);
  });

  it("keeps next steps with text, the team's with the message to send it, and at most the limits", () => {
    const r = decideReview(
      {
        nextSteps: [
          { text: 'Write tests', by: 'team', message: '@Bob write tests' },
          { text: 'Deploy', by: 'user', message: 'ignored for the user' },
          { message: '@Alice go on' },
          { text: 'Same', by: 'team', message: 'Same' },
          { text: '' },
          ...Array.from({ length: 10 }, (_, i) => ({ text: `step ${i}` })),
        ],
        highlights: Array.from({ length: 20 }, () => ({ note: 'n' })),
      },
      replies,
    );
    expect(r.nextSteps!.slice(0, 4)).toEqual([
      { text: 'Write tests', by: 'team', message: '@Bob write tests' },
      { text: 'Deploy', by: 'user' },
      { text: '@Alice go on', by: 'team' },
      { text: 'Same', by: 'team' },
    ]);
    expect(r.nextSteps).toHaveLength(6);
    expect(r.highlights).toHaveLength(8);
  });

  it('reads it from a ```json block, accepts an empty review, and refuses an answer that is none', () => {
    expect(parseReviewReply('Here:\n```json\n{"summary": "ok", "highlights": [], "nextSteps": []}\n```', replies)).toEqual({
      summary: 'ok',
      highlights: [],
      nextSteps: [],
    });
    expect(parseReviewReply('{"highlights": []}', replies)).toEqual({ highlights: [], nextSteps: [] });
    expect(() => parseReviewReply('All good.', replies)).toThrow();
    expect(() => parseReviewReply('{"foo": 1}', replies)).toThrow();
  });
});

describe('the marks in the chat', () => {
  it("are the ready reviews' highlights, by reply, with the review that has the latest", () => {
    const msgs = [
      reply('r1', 'Alice', 'a'),
      review('v1', 'ready', { highlights: [{ kind: 'risk', note: 'x', messageId: 'r1' }, { kind: 'note', note: 'all' }] }),
      review('v2', 'failed', { highlights: [{ kind: 'risk', note: 'y', messageId: 'r1' }] }),
      review('v3', 'ready', { highlights: [{ kind: 'verify', note: 'z', messageId: 'r1' }] }),
    ];
    const marks = highlightsByReply(msgs);
    expect([...marks.keys()]).toEqual(['r1']);
    expect(marks.get('r1')).toEqual({
      reviewId: 'v3',
      highlights: [
        { kind: 'risk', note: 'x', messageId: 'r1' },
        { kind: 'verify', note: 'z', messageId: 'r1' },
      ],
    });
  });
});
