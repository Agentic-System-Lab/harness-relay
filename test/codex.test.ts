import { describe, expect, it } from 'vitest';
import {
  codexApprovalRequest,
  codexApprovalResponse,
  codexConfig,
  createCodexUpdateHandler,
  describeCodexItem,
} from '../src/server/agents/codex';
import type { AgentEvent } from '../src/server/agents/types';

// Shapes trimmed from real `codex app-server` traffic (codex-cli 0.167.0).
const command = (extra: Record<string, unknown>) => ({
  type: 'commandExecution',
  id: 'exec-1',
  command: "/bin/zsh -lc 'npm test'",
  cwd: '/repo',
  status: 'inProgress',
  aggregatedOutput: null,
  exitCode: null,
  ...extra,
});

describe('codex app-server events', () => {
  it('streams text, reasoning, plans and command output', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.handle('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Checking the tests.' });
    h.handle('turn/plan/updated', { plan: [{ step: 'Run tests', status: 'inProgress' }, { step: 'Report', status: 'pending' }] });
    h.handle('item/started', { item: command({}) });
    h.handle('item/completed', { item: command({ status: 'completed', exitCode: 0, aggregatedOutput: '> test\nALL-TESTS-PASSED\n' }) });
    h.handle('item/agentMessage/delta', { itemId: 'm1', delta: 'Tests pass.' });
    h.handle('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Tests pass.' } });
    h.handle('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Checking the tests.'], content: [] } });
    h.handle('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, outputTokens: 10, reasoningOutputTokens: 5 } } });
    h.handle('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 50, outputTokens: 2, reasoningOutputTokens: 0 } } });

    expect(events).toEqual([
      { type: 'thinking', text: 'Checking the tests.' },
      { type: 'plan', entries: [{ text: 'Run tests', status: 'in_progress' }, { text: 'Report', status: 'pending' }] },
      { type: 'tool_start', id: 'exec-1', name: 'Shell', detail: 'npm test' },
      { type: 'tool_end', id: 'exec-1', ok: true, output: '> test\nALL-TESTS-PASSED' },
      { type: 'text', text: 'Tests pass.' },
      { type: 'text_end' },
    ]);
    expect(h.usage).toEqual({ inputTokens: 150, outputTokens: 17 });
  });

  it('reports failed and declined commands', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.handle('item/completed', { item: command({ id: 'a', status: 'failed', exitCode: 128, aggregatedOutput: 'fatal: not a git repository' }) });
    h.handle('item/completed', { item: command({ id: 'b', status: 'declined' }) });
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      { type: 'tool_end', id: 'a', ok: false, output: 'fatal: not a git repository', error: 'exit 128' },
      { type: 'tool_end', id: 'b', ok: false, error: '使用者拒絕了這個操作。' },
    ]);
  });

  it('describes tool items', () => {
    expect(describeCodexItem({ type: 'fileChange', changes: [{ path: 'a.ts', kind: { type: 'update' } }] })).toEqual({ name: 'Edit', detail: 'update a.ts' });
    expect(describeCodexItem({ type: 'webSearch', query: 'vitest' })).toEqual({ name: 'WebSearch', detail: 'vitest' });
    expect(describeCodexItem({ type: 'agentMessage' })).toBeNull();
  });
});

describe('codex approvals', () => {
  it('turns approval requests into what the user sees, and answers in the shape Codex expects', () => {
    const paths = (id: string) => (id === 'patch-1' ? 'src/a.ts' : undefined);
    expect(
      codexApprovalRequest('item/commandExecution/requestApproval', { command: "/bin/zsh -lc 'touch ../x'", reason: 'Outside the sandbox' }, paths),
    ).toEqual({ kind: 'command', detail: 'touch ../x', command: "/bin/zsh -lc 'touch ../x'", reason: 'Outside the sandbox' });
    expect(codexApprovalRequest('item/fileChange/requestApproval', { itemId: 'patch-1' }, paths)).toMatchObject({ kind: 'edit', detail: 'src/a.ts' });
    expect(codexApprovalRequest('item/tool/call', {}, paths)).toBeNull();

    expect(codexApprovalResponse('item/commandExecution/requestApproval', {}, true)).toEqual({ decision: 'accept' });
    expect(codexApprovalResponse('item/fileChange/requestApproval', {}, false)).toEqual({ decision: 'decline' });
    expect(codexApprovalResponse('execCommandApproval', {}, false, 'no')).toEqual({ decision: { denied: { rejection: 'no' } } });
    expect(codexApprovalResponse('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, true)).toEqual({
      permissions: { network: { enabled: true }, fileSystem: undefined },
      scope: 'turn',
    });
  });
});

describe('codex thread config', () => {
  it('keeps the edit-mode sandbox off the network whatever the user config says', () => {
    expect(codexConfig('edit', 'high')).toEqual({
      model_reasoning_effort: 'high',
      sandbox_workspace_write: { network_access: false },
    });
    expect(codexConfig('read-only')).toEqual({});
    expect(codexConfig('full')).toEqual({});
  });
});
