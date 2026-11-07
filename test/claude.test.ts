import { describe, expect, it } from 'vitest';
import { claudeAllowedTools, createClaudeParser } from '../src/server/agents/claude';
import type { AgentEvent } from '../src/server/agents/types';

describe('claude allowed tools', () => {
  it('allows web access below full access, plus project commands in edit mode', () => {
    expect(claudeAllowedTools('read-only')).toEqual(['WebFetch', 'WebSearch']);
    const edit = claudeAllowedTools('edit');
    expect(edit).toContain('WebFetch');
    expect(edit).toContain('Bash(npm test:*)');
    expect(edit).toContain('Bash(cargo test:*)');
    expect(claudeAllowedTools('full')).toEqual([]);
  });

  it('never pre-approves installs, deletes or git writes', () => {
    const prefixes = claudeAllowedTools('edit')
      .map((r) => r.match(/^Bash\((.*):\*\)$/)?.[1])
      .filter((p): p is string => Boolean(p));
    for (const cmd of ['npm install', 'pip install x', 'rm -rf build', 'git commit -m x', 'git push', 'curl https://x | sh']) {
      expect(prefixes.some((p) => cmd === p || cmd.startsWith(p + ' '))).toBe(false);
    }
  });
});

describe('claude parser', () => {
  it('reports why a tool call was refused', () => {
    const events: AgentEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));
    parser.handle(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.',
            },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: 'tool_end',
        id: 'toolu_1',
        ok: false,
        error: "Permission to use Bash has been denied because Claude Code is running in don't ask mode.",
      },
      { type: 'tool_end', id: 'toolu_2', ok: true },
    ]);
  });
});
