import { describe, expect, it } from 'vitest';
import {
  ORGANIZE_SCHEMA,
  TITLE_MAX,
  buildGroupPrompt,
  buildOrganizePrompt,
  checkReorganize,
  decideOrganize,
  groupSchema,
  parseGroupReply,
  parseTitleReply,
} from '../src/server/grouping';

const groups = [
  { id: 'g1', name: 'Frontend' },
  { id: 'g2', name: '資料庫' },
];

describe('sorting conversations into groups', () => {
  it('shows the lead agent the first message, the groups and what is in them', () => {
    const prompt = buildGroupPrompt('Fix the sidebar', [
      { name: 'Frontend', examples: ['Dark mode colors'] },
      { name: '資料庫', examples: [] },
    ]);
    expect(prompt).toContain('<message>\nFix the sidebar\n</message>');
    expect(prompt).toContain('1. "Frontend"; it has conversations such as "Dark mode colors"');
    expect(prompt).toContain('2. "資料庫"\n');
    expect(prompt).toContain('pick 0');
    expect(buildGroupPrompt('x'.repeat(5000), [])).toContain(`${'x'.repeat(4000)}…`);
  });

  it('reads the group it picked, by number or by name; 0 or null is none', () => {
    expect(parseGroupReply('```json\n{"group": 2}\n```', groups)).toEqual(groups[1]);
    expect(parseGroupReply('{"group": "1"}', groups)).toEqual(groups[0]);
    expect(parseGroupReply('{"group": "資料庫"}', groups)).toEqual(groups[1]);
    expect(parseGroupReply('{"group": 0}', groups)).toBeNull();
    expect(parseGroupReply('{"group": null}', groups)).toBeNull();
  });

  it('refuses a reply that names no group of the list', () => {
    expect(() => parseGroupReply('{"group": 3}', groups)).toThrow();
    expect(() => parseGroupReply('{"group": "Backend"}', groups)).toThrow();
    expect(() => parseGroupReply('{}', groups)).toThrow();
    expect(() => parseGroupReply('Frontend, I think.', groups)).toThrow();
  });

  it('reads the structured answer its CLI gave, and the text without one', () => {
    expect(parseGroupReply('Frontend, I think.', groups, { group: 2 })).toEqual(groups[1]);
    expect(parseGroupReply('{"group": 1}', groups, { group: 0 })).toBeNull();
    expect(parseGroupReply('{"group": 1}', groups, undefined)).toEqual(groups[0]);
    expect(() => parseGroupReply('{"group": 1}', groups, { group: 7 })).toThrow();
  });
});

describe('naming a new conversation', () => {
  it('asks for its title alone without groups, and with its group when there are', () => {
    const alone = buildGroupPrompt('Fix the sidebar', [], true);
    expect(alone).toContain('Give the conversation a title for the sidebar');
    expect(alone).not.toContain('The user sorts conversations into these groups');
    expect(alone).toContain('Reply with only this JSON object: {"title": "<title>"}');
    const both = buildGroupPrompt('Fix the sidebar', [{ name: 'Frontend', examples: [] }], true);
    expect(both).toContain('Also give the conversation a title');
    expect(both).toContain('Reply with only this JSON object: {"group": <number>, "title": "<title>"}');
    expect(buildGroupPrompt('Fix it', [{ name: 'Frontend', examples: [] }])).toContain(
      'Reply with only this JSON object: {"group": <number>}',
    );
    expect(groupSchema(false, true)).toMatchObject({ required: ['title'] });
    expect(groupSchema(true, true)).toMatchObject({ required: ['group', 'title'] });
  });

  it('reads the title: one line, without quotes or a full stop, cut at the end when too long', () => {
    expect(parseTitleReply('{"title": "  「深色模式\\n配色」。 "}')).toBe('深色模式 配色');
    expect(parseTitleReply('ignored', { title: '"Dark mode colors."' })).toBe('Dark mode colors');
    expect(parseTitleReply('{"title": ""}')).toBeUndefined();
    expect(parseTitleReply('{"group": 1}')).toBeUndefined();
    expect(parseTitleReply('not json')).toBeUndefined();
    const long = parseTitleReply(JSON.stringify({ title: 'word '.repeat(30) }))!;
    expect([...long]).toHaveLength(TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('suggesting groups', () => {
  const convs = [
    { id: 'c1', title: 'Invoice for ACME', group: -1 },
    { id: 'c2', title: 'Fix the build', group: 0 },
    { id: 'c3', title: 'x'.repeat(150), group: 1 },
  ];

  it('shows the groups with how full they are, the conversations by number, and the request', () => {
    const prompt = buildOrganizePrompt(groups, convs, ' by client ');
    expect(prompt).toContain('1. "Frontend" (1 of the conversations below)');
    expect(prompt).toContain('2. "資料庫" (1 of the conversations below)');
    expect(prompt).toContain('1. "Invoice for ACME": Other\n2. "Fix the build": group 1');
    expect(prompt).toContain(`3. "${'x'.repeat(100)}…": group 2`);
    expect(prompt).toContain('<request>\nby client\n</request>');
    expect(prompt).toContain('(3, 4…)');
    expect(buildOrganizePrompt([], convs)).toContain('(none yet)');
    expect(buildOrganizePrompt([], convs)).not.toContain('<request>');
    expect(ORGANIZE_SCHEMA).toMatchObject({ required: ['create', 'rename', 'move', 'reason'] });
  });

  it('keeps only what can be taken, and a new group only when something moves into it', () => {
    const r = decideOrganize(
      {
        create: [{ name: 'Clients' }, { name: 'Empty' }, { name: 'other' }, { name: '  ' }],
        rename: [
          { group: 2, name: 'Data' },
          { group: 1, name: 'Frontend' },
          { group: 2, name: 'Again' },
        ],
        move: [
          { conversation: 1, group: 3 },
          { conversation: 1, group: 0 },
          { conversation: 2, group: 1 },
          { conversation: 3, group: 0 },
          { conversation: 2, group: 6 },
          { conversation: '3', group: '2' },
        ],
        reason: 'By topic.',
      },
      groups,
      convs,
    );
    expect(r).toEqual({
      create: [{ key: 'new-1', name: 'Clients' }],
      rename: [{ id: 'g2', from: '資料庫', name: 'Data' }],
      move: [
        { convId: 'c1', title: 'Invoice for ACME', from: null, to: 'new-1' },
        { convId: 'c3', title: 'x'.repeat(150), from: 'g2', to: null },
      ],
      reason: 'By topic.',
    });
  });

  it('checks the suggestions the user took against the groups as they are, with each new group’s id', () => {
    let next = 0;
    const id = () => `new-id-${++next}`;
    const exists = (c: string) => c === 'c1' || c === 'c2';
    expect(
      checkReorganize(
        {
          create: [{ key: 'new-1', name: 'Clients' }],
          rename: [{ id: 'g1', name: 'Web' }],
          move: [
            { convId: 'c1', to: 'new-1' },
            { convId: 'c2', to: null },
          ],
        },
        groups,
        exists,
        id,
      ),
    ).toEqual({
      create: [{ id: 'new-id-1', name: 'Clients' }],
      rename: [{ id: 'g1', name: 'Web' }],
      move: [
        { convId: 'c1', to: 'new-id-1' },
        { convId: 'c2', to: null },
      ],
    });
    // A rename frees its old name for a new group.
    expect(
      checkReorganize({ rename: [{ id: 'g1', name: 'Web' }], create: [{ key: 'new-1', name: 'Frontend' }] }, groups, exists, id).create,
    ).toEqual([{ id: 'new-id-2', name: 'Frontend' }]);
    const refused = (input: unknown) => {
      try {
        checkReorganize(input, groups, exists, id);
      } catch (e) {
        return (e as { status: number }).status;
      }
      return 200;
    };
    expect(refused({ create: [{ key: 'new-1', name: '資料庫' }] })).toBe(400);
    expect(
      refused({
        create: [
          { key: 'new-1', name: 'A' },
          { key: 'new-1', name: 'B' },
        ],
      }),
    ).toBe(400);
    expect(refused({ rename: [{ id: 'gone', name: 'X' }] })).toBe(404);
    expect(refused({ move: [{ convId: 'c9', to: null }] })).toBe(404);
    expect(refused({ move: [{ convId: 'c1', to: 'g9' }] })).toBe(404);
    expect(
      refused({
        move: [
          { convId: 'c1', to: null },
          { convId: 'c1', to: 'g1' },
        ],
      }),
    ).toBe(400);
    expect(refused({ move: 'all' })).toBe(400);
    expect(refused({ create: Array.from({ length: 49 }, (_, i) => ({ key: `new-${i + 1}`, name: `G${i}` })) })).toBe(400);
  });
});
