import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { slow } from './timeouts';
import type { ChatMessage } from '../src/shared/types';
import { findQuote, hasQuote, highlightsByReply, markdownText, mostSerious, quoteChecker, quoteKey, reviewStart } from '../src/shared/review';
import { buildReviewPrompt, decideReview, hasNewReplies, parseReviewReply, reviewMaterial } from '../src/server/reviewer';
import { Markdown } from '../src/web/components/Markdown';
import { I18nProvider, currentLang, loadMessages } from '../src/web/i18n';

// As the page does before it draws anything: its language's messages.
beforeAll(() => loadMessages(currentLang()));

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
    expect(hasQuote('A [link](https://example.com) here', 'A link here')).toBe(true); // a link by its text, as the chat shows it
    expect(hasQuote('A [link](https://example.com) here', 'example.com')).toBe(false);
    expect(hasQuote('nothing like it', 'something else')).toBe(false);
    expect(hasQuote('anything', '  ')).toBe(false);
    expect(quoteKey('…the rest...')).toBe('the rest');
    // A list's marker is not text in the chat.
    expect(quoteKey('1. Run the migration first')).toBe('run the migration first');
    expect(quoteKey('- first point')).toBe('first point');
  });

  it("reads a reply's Markdown as the chat shows its text", () => {
    expect(markdownText('See [the docs](https://x.io/a_(b)) and ![logo](l.png) <https://y.io>')).toBe('See the docs and   https://y.io');
    expect(markdownText('1. one\n2) two\n- three\n> * four')).toBe('one\ntwo\nthree\n> four');
    expect(markdownText('| a | b |\n| --- | :-: |\n| c | d |')).toBe('| a | b |\n \n| c | d |');
    expect(markdownText('```ts\ncode()\n```')).toBe(' \ncode()\n ');
    expect(markdownText('Tom &amp; Jerry &lt;3 &#233;&#x1F389; \\*not bold\\*')).toBe('Tom & Jerry <3 é🎉 *not bold*');
    expect(markdownText('&#0; &#x110000;')).toBe('&#0; &#x110000;');
  });

  it('starts a new block with a space between text nodes', () => {
    expect(findQuote(['first', 'second'], 'first second')).toBeUndefined();
    expect(findQuote(['first', 'second'], 'first second', [false, true])).toEqual({ start: { part: 0, offset: 0 }, end: { part: 1, offset: 6 } });
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

/**
 * The text nodes of a reply as the chat renders it (the app's Markdown, as static HTML), and which of
 * them start a block, as `markQuotes` in src/web/review.ts reads them from the page.
 */
function renderedParts(md: string): { parts: string[]; breaks: boolean[] } {
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(Markdown, { text: md, mentions: [] })));
  const BLOCKS = new Set(['p', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'dt', 'dd', 'div']);
  const VOID = new Set(['br', 'hr', 'img', 'input']);
  const decode = (t: string) =>
    t.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]!);
  const stack: { tag: string; id: number }[] = [];
  const parts: string[] = [];
  const breaks: boolean[] = [];
  let ids = 0;
  let block: number | undefined;
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>|([^<]+)/gi)) {
    const [, close, tag, selfClose, text] = m;
    if (text !== undefined) {
      const own = [...stack].reverse().find((e) => BLOCKS.has(e.tag))?.id;
      breaks.push(parts.length > 0 && own !== block);
      block = own;
      parts.push(decode(text));
    } else if (close) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag!.toLowerCase());
      if (at >= 0) stack.length = at;
    } else if (!selfClose && !VOID.has(tag!.toLowerCase())) {
      stack.push({ tag: tag!.toLowerCase(), id: ++ids });
    }
  }
  return { parts, breaks };
}

describe('a quote the server keeps is one the chat marks', () => {
  const reply = [
    '## Plan',
    '',
    'See the [migration notes](docs/migrate.md) before you run **anything**: Tom &amp; Jerry agree.',
    '',
    '1. Run the migration first',
    '2. Then `npm test`',
    '',
    '- first point',
    '- second point',
    '',
    '| CLI | Ready |',
    '| --- | --- |',
    '| Codex | no |',
    '',
    '> Back up the `users` table.',
    '',
    '```sql',
    'DROP TABLE users;',
    '```',
  ].join('\n');
  // Rendered once the page's messages have loaded (beforeAll), not while the tests are collected.
  let rendered: ReturnType<typeof renderedParts> | undefined;
  const page = () => (rendered ??= renderedParts(reply));

  for (const quote of [
    'See the migration notes before you run anything',
    'Tom & Jerry agree',
    '1. Run the migration first',
    'Then npm test',
    'first point second point',
    'CLI Ready',
    'Codex no',
    'Back up the users table',
    'DROP TABLE users;',
    'Plan',
  ]) {
    it(`finds “${quote}” in the Markdown and in the rendered reply`, () => {
      expect(hasQuote(reply, quote)).toBe(true);
      expect(findQuote(page().parts, quote, page().breaks)).toBeDefined();
    });
  }

  for (const quote of ['docs/migrate.md', 'Ready Codex no maybe', 'sql DROP']) {
    it(`finds “${quote}” in neither`, () => {
      expect(hasQuote(reply, quote)).toBe(false);
      expect(findQuote(page().parts, quote, page().breaks)).toBeUndefined();
    });
  }
});

describe("a quote across Markdown's other forms is found as the chat shows it", () => {
  for (const [md, quote] of [
    ['Title\n===\n\nbody', 'Title body'],
    ['one\\\ntwo', 'one two'],
    ['```x``` and y', 'x and y'],
    ['Text[^n] more.\n\n[^n]: The note.', 'Text1 more.'],
    ['Text[^n] more.\n\n[^n]: The note.', 'The note.'],
    ['Use `&amp;` and `\\*`', 'Use &amp; and \\*'],
    ['İzmir is far', 'izmir is far'],
    ['Izmir is far', 'İzmir is far'],
    ['end \\', 'end \\'],
    // Code, fenced or indented, is shown as written: a diff's lines, a command's continuations, YAML's
    // list items, a rule, a link, an entity and an escape in it are its text.
    ['```diff\n- const limit = 10;\n+ const limit = 0;\n```', '- const limit = 10; + const limit = 0;'],
    ['```sh\nnpm run build \\\n  --prod\n```', 'npm run build \\ --prod'],
    ['```yaml\nsteps:\n  - run: rm -rf build\n```', 'steps: - run: rm -rf build'],
    ['```\na &amp; b\n---\nsee [x](y) \\*\n```', 'a &amp; b --- see [x](y) \\*'],
    ['~~~~\n```\ninner\n```\n~~~~', '``` inner ```'],
    ['Text:\n\n    - indented code\n    a &amp; b', '- indented code a &amp; b'],
    // An indented line in a list is the item's text, read as such.
    ['- item\n\n    more &amp; more', 'item more & more'],
    // Every named entity, and an escape of any punctuation.
    ['&copy; 2026 &mdash; &hellip; \\$5 \\@me', '© 2026 — … $5 @me'],
  ] as const) {
    it(`finds “${quote}” in ${JSON.stringify(md)} and in the rendered reply`, () => {
      const page = renderedParts(md);
      expect(hasQuote(md, quote)).toBe(true);
      expect(findQuote(page.parts, quote, page.breaks)).toBeDefined();
    });
  }

  it('reads them as the chat does', () => {
    expect(markdownText('Title\n===\n\nbody')).toBe('Title\n \n\nbody');
    // A hard line break; two backslashes are one, as text; at a paragraph's end it is text.
    expect(markdownText('one\\\ntwo')).toBe('one\ntwo');
    expect(markdownText('one\\\\\ntwo')).toBe('one\\\ntwo');
    expect(markdownText('end \\\n\nnext')).toBe('end \\\n\nnext');
    expect(markdownText('```x``` and y\n```ts\ncode\n```')).toBe('```x``` and y\n \ncode\n ');
    // Footnotes by their numbers, in the order they are referred to; one with no definition is text.
    expect(markdownText('a[^b] c[^a] d[^b] e[^x]\n\n[^a]: A.\n[^B]: B.')).toBe('a1 c2 d1 e[^x]\n\nA.\nB.');
    expect(markdownText('Use `&amp;` and `\\*`, not &amp; \\*')).toBe('Use `&amp;` and `\\*`, not & *');
    expect(findQuote(['İzmir'], 'izmir')).toEqual({ start: { part: 0, offset: 0 }, end: { part: 0, offset: 5 } });
  });
});

describe('where a first review starts', () => {
  const asked = (id: string, name: string) => reply(id, name, 'A or B?', { asked: true });

  it('at the question the latest run answered, before any review was ready', () => {
    const msgs = [user('u1', 'old'), reply('r1', 'Alice', 'a'), user('u2', 'new'), reply('r2', 'Alice', 'b')];
    expect(reviewStart(msgs)).toBe(2);
  });

  it("at the question an answer was for, and a message sent mid-run does not count as one", () => {
    const msgs = [
      user('u1', 'old'),
      reply('r1', 'Alice', 'a'),
      user('u2', 'which?'),
      asked('r2', 'Alice'),
      user('u3', 'A'),
      reply('r3', 'Alice', 'done'),
      { ...user('u4', 'and also'), queued: true },
      reply('r4', 'Bob', 'ok'),
    ];
    expect(reviewStart(msgs)).toBe(2);
  });

  it('where a review that failed or was stopped started, when that is earlier', () => {
    const msgs = [
      user('u1', 'one'),
      reply('r1', 'Alice', 'a'),
      review('v1', 'failed', { fromId: 'u1' }),
      user('u2', 'two'),
      reply('r2', 'Alice', 'b'),
    ];
    expect(reviewStart(msgs)).toBe(0);
    // Once one was ready, after it.
    expect(reviewStart([...msgs, review('v2'), user('u3', 'three')])).toBe(6);
  });

  it('records where it read from, and what the last ready review said', () => {
    const msgs = [
      user('u1', 'one'),
      reply('r1', 'Alice', 'a'),
      review('v1', 'ready', { summary: 'Fine.', highlights: [{ kind: 'verify', note: 'Check it.', agentName: 'Alice' }], nextSteps: [{ text: 'Ship', by: 'user' }] }),
      user('u2', 'two'),
      reply('r2', 'Alice', 'b'),
    ];
    const m = reviewMaterial(msgs);
    expect(m.fromId).toBe('u2');
    expect(m.previous).toBe('Summary: Fine.\n- verify (@Alice): Check it.\n- next step for the user: Ship');
    const prompt = buildReviewPrompt(m, [], { permission: 'read-only', cwd: '/w' });
    expect(prompt).toContain('<last_review>\nSummary: Fine.');
    expect(reviewMaterial(msgs.slice(0, 2)).previous).toBeUndefined();
  });

  it("tells the lead where each member's changes are in parallel mode", () => {
    const m = reviewMaterial([user('u', 'go'), reply('r', 'Alice', 'done')]);
    const prompt = buildReviewPrompt(m, [], { permission: 'edit', cwd: '/w' }, [{ name: 'Alice', dirs: ['/wt/a', '/wt/a2'] }]);
    expect(prompt).toContain('each member in git worktrees of its own');
    expect(prompt).toContain('- @Alice: /wt/a, /wt/a2');
    expect(prompt).toContain("or a member's worktrees above");
    expect(buildReviewPrompt(m, [], { permission: 'edit', cwd: '/w' })).not.toContain('worktrees');
  });
});

describe('small things of the review', () => {
  it('takes next steps written as next_steps', () => {
    expect(decideReview({ next_steps: [{ text: 'Do it', by: 'user' }] }, []).nextSteps).toEqual([{ text: 'Do it', by: 'user' }]);
  });

  it("gives a reply's tag the most serious kind among its highlights", () => {
    expect(mostSerious([{ kind: 'note', note: '' }, { kind: 'verify', note: '' }, { kind: 'decision', note: '' }])).toBe('decision');
    expect(mostSerious([])).toBe('note');
  });
});

describe('quotes and the pieces of a reply', () => {
  it("keeps a quote only when one piece of the reply's text has it: the chat shows each on its own, between its tool calls", () => {
    const split: ChatMessage = {
      ...reply('r1', 'Alice', ''),
      parts: [
        { type: 'text', text: 'I will run the migration' },
        { type: 'tool', id: 't', name: 'Shell', status: 'done' },
        { type: 'text', text: 'and then drop the table.' },
      ],
    };
    const r = decideReview(
      {
        highlights: [
          { kind: 'risk', reply: 1, quote: 'migration and then drop', note: 'Across a tool call.' },
          { kind: 'risk', reply: 1, quote: 'then drop the table', note: 'In one piece.' },
        ],
      },
      [split],
    );
    expect(r.highlights!.map((h) => h.quote)).toEqual([undefined, 'then drop the table']);
  });

  it('takes an answer with only next_steps as a review', () => {
    expect(decideReview({ next_steps: [] }, [])).toEqual({ highlights: [], nextSteps: [] });
  });

  it('drops the lines a rendered reply has no text for', () => {
    expect(markdownText('a\n---\n- \n|:-|\nb')).toBe('a\n \n \n \nb');
    expect(markdownText('x - y')).toBe('x - y');
  });

  it('reads a reply of any size in time proportional to it', () => {
    for (const unit of ['[a](b', '[', '![a](', '<http://x', ' \t', '| - ', ' >', '\n', '`a', '\\', '&abcdefgh', '```\n', '\n    x\n', '- a\n\n    b\n']) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      const started = performance.now();
      hasQuote(text, 'nothing like it');
      expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(slow(1500));
    }
    // One long run of backticks in a line of text (not a fence): tried once, not from each backtick.
    for (const text of ['a' + '`'.repeat(100_000), 'a' + '`'.repeat(50_000) + 'b' + '`'.repeat(50_000)]) {
      const started = performance.now();
      hasQuote(text, 'nothing like it');
      expect(performance.now() - started, text.slice(0, 3)).toBeLessThan(slow(1500));
    }
  });
});

describe('images and where a review starts, again', () => {
  it('reads an image on the web as the chat shows it (its alt text, or its address), and one on this computer as no text', () => {
    expect(markdownText('See ![the chart](https://x.io/c.png) below')).toBe('See the chart below');
    expect(markdownText('See ![](https://x.io/c.png) below')).toBe('See https://x.io/c.png below');
    expect(markdownText('See ![chart](out/c.png "Chart") below')).toBe('See   below');
    expect(hasQuote('See ![the chart](https://x.io/c.png) below', 'see the chart below')).toBe(true);
  });

  it('starts at the latest question, never before the last ready review, nor reading what came long after it', () => {
    const msgs = [
      user('u1', 'one'),
      reply('r1', 'Alice', 'a'),
      review('v1'),
      user('u2', 'two'),
      reply('r2', 'Alice', 'b'),
      user('u3', 'three'),
      reply('r3', 'Alice', 'c'),
    ];
    // Turned off after v1 and on again: the latest question only.
    expect(reviewStart(msgs)).toBe(5);
    // A Continue after a review (no new question): from the review on.
    expect(reviewStart([...msgs, review('v2'), reply('r4', 'Alice', 'd')])).toBe(8);
    // A review that failed after the ready one started earlier: from there.
    expect(reviewStart([...msgs.slice(0, 5), review('v2', 'failed', { fromId: 'u2' }), ...msgs.slice(5)])).toBe(3);
    // A failed review from before the ready one does not reach back past it.
    expect(reviewStart([user('u0', 'zero'), review('f0', 'failed', { fromId: 'u0' }), ...msgs])).toBe(7);
  });
});

describe('a review that failed or was stopped, and reading a reply once', () => {
  it('reaches back to where it started only when it came right before the latest question', () => {
    const stopped = review('s1', 'failed', { fromId: 'u1' });
    // Right before the latest question: from its start.
    expect(reviewStart([user('u1', 'one'), reply('r1', 'Alice', 'a'), stopped, user('u2', 'two'), reply('r2', 'Alice', 'b')])).toBe(0);
    // Other questions came after it (the review was off for them): the latest question only.
    const later = [user('u1', 'one'), reply('r1', 'Alice', 'a'), stopped, user('u2', 'two'), reply('r2', 'Alice', 'b'), user('u3', 'three'), reply('r3', 'Alice', 'c')];
    expect(reviewStart(later)).toBe(5);
    // A message written into the discussion (queued) is no question of its own.
    expect(reviewStart([user('u1', 'one'), reply('r1', 'Alice', 'a'), stopped, { ...user('q', 'also'), queued: true }, user('u2', 'two')])).toBe(0);
  });

  it('reads a piece of a reply once for as many quotes as asked', () => {
    const has = quoteChecker('We **must** migrate [the DB](x.md) first.');
    expect(has('must migrate the DB')).toBe(true);
    expect(has('the db first')).toBe(true);
    expect(has('x.md')).toBe(false);
    expect(has('  ')).toBe(false);
  });
});
