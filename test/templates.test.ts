import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/shared/types';
import { templateKey, type TemplateDraft } from '../src/web/templates';

const member: AgentConfig = { id: 'a', name: 'Architect', provider: 'claude', role: 'Plan it.', model: 'opus', tools: { memory: true, 'mcp:x': false } };
const draft: TemplateDraft = {
  name: 'My team',
  description: 'For plans',
  agents: [member],
  settings: { mode: 'relay', rounds: 1, maxHops: 6 },
};
const key = (d: Partial<TemplateDraft>) => templateKey({ ...draft, ...d });

describe('telling whether a template was changed', () => {
  it('ignores member ids, spaces around the text and empty optional fields', () => {
    const same = templateKey(draft);
    expect(key({ agents: [{ ...member, id: 'fresh' }] })).toBe(same);
    expect(key({ name: ' My team ', description: 'For plans\n' })).toBe(same);
    expect(key({ agents: [{ ...member, role: 'Plan it.  ', tools: { 'mcp:x': false, memory: true } }] })).toBe(same);
    const bare = { ...member, model: undefined, effort: undefined, tools: undefined };
    expect(key({ agents: [{ ...bare, model: '', effort: '', tools: {} }] })).toBe(key({ agents: [bare] }));
  });

  it('sees any change to the name, description, members or how they take turns', () => {
    const same = templateKey(draft);
    for (const changed of [
      key({ name: 'My team 2' }),
      key({ description: '' }),
      key({ settings: { ...draft.settings, maxHops: 7 } }),
      key({ settings: { ...draft.settings, mode: 'roundtable' } }),
      key({ agents: [{ ...member, role: 'Build it.' }] }),
      key({ agents: [{ ...member, provider: 'codex' }] }),
      key({ agents: [{ ...member, effort: 'high' }] }),
      key({ agents: [{ ...member, tools: { memory: false } }] }),
      key({ agents: [member, { ...member, id: 'b', name: 'Builder' }] }),
    ]) {
      expect(changed).not.toBe(same);
    }
  });
});
