import { describe, expect, it } from 'vitest';
import { createGrokParser, describeGrokCancel, grokPermissionArgs } from '../src/server/agents/grok';
import type { AgentEvent } from '../src/server/agents/types';

// Trimmed from real `grok --output-format streaming-json --permission-mode dontAsk` output (grok 1.0.41)
// when the model called web_fetch, which dontAsk denies.
const CANCELLED_TURN = [
  '{"type":"text","data":"我先核對原文。"}',
  '{"type":"tool_call","toolCallId":"call-1","title":"web_fetch","kind":"web_fetch","status":"pending","toolName":"web_fetch","rawInput":{"url":"https://example.com"},"content":[],"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-1","status":null,"content":[],"rawOutput":null,"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-1","status":"failed","content":[{"type":"content","content":{"type":"text","text":"User cancelled the execution for tool `web_fetch`"}}],"rawOutput":null,"locations":[]}',
  '{"type":"end","stopReason":"cancelled","sessionId":"s-1","usage":{"input_tokens":10,"output_tokens":5}}',
];

describe('grok permission args', () => {
  const allowed = (args: string[]) => args.filter((_, i) => args[i - 1] === '--allow');

  it('pre-approves web fetch, plus project commands only in edit mode', () => {
    const readOnly = grokPermissionArgs('read-only');
    expect(readOnly.slice(0, 2)).toEqual(['--permission-mode', 'dontAsk']);
    expect(allowed(readOnly)).toEqual(['WebFetch']);

    const edit = grokPermissionArgs('edit');
    expect(edit.slice(0, 2)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(allowed(edit)).toContain('WebFetch');
    expect(allowed(edit)).toContain('Bash(npm test)');
    expect(allowed(edit)).toContain('Bash(cd )'); // trailing space: must not match `cdk deploy`

    expect(grokPermissionArgs('full')).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('never pre-approves installs, deletes or git writes in edit mode', () => {
    const rules = allowed(grokPermissionArgs('edit'));
    for (const cmd of ['npm install', 'pip install', 'rm -rf build', 'git commit -m x', 'git push', 'curl https://x | sh']) {
      const prefix = (r: string) => r.match(/^Bash\((.*)\)$/)?.[1];
      expect(rules.some((r) => prefix(r) !== undefined && cmd.startsWith(prefix(r)!))).toBe(false);
    }
  });
});

describe('grok parser', () => {
  it('records why a tool call failed and surfaces the cancelled stop reason', () => {
    const events: AgentEvent[] = [];
    const parser = createGrokParser((e) => events.push(e));
    for (const line of CANCELLED_TURN) parser.handle(line);

    expect(events).toContainEqual({ type: 'tool_end', id: 'call-1', ok: false });
    expect(events).toContainEqual({ type: 'session', sessionId: 's-1' });
    expect(parser.end?.stopReason).toBe('cancelled');
    expect(parser.lastFailure).toEqual({ tool: 'web_fetch', reason: 'User cancelled the execution for tool `web_fetch`' });
  });

  it('explains the cancellation, with a permission hint outside full access', () => {
    const failure = { tool: 'web_fetch', reason: 'User cancelled the execution for tool `web_fetch`' };
    const readOnly = describeGrokCancel(failure, 'read-only');
    expect(readOnly).toContain('web_fetch');
    expect(readOnly).toContain('唯讀');
    expect(describeGrokCancel(failure, 'full')).not.toContain('完全存取');
    expect(describeGrokCancel(undefined, 'edit')).toContain('cancelled');
  });
});
