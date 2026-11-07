import { describe, expect, it } from 'vitest';
import { buildGroupPrompt, parseGroupReply } from '../src/server/grouping';

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
});
