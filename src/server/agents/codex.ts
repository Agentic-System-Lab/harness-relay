import type { Permission } from '../../shared/types';
import { runProcess, tail } from '../process';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  parseJsonLine,
  summarizeInput,
  type AgentEvent,
  type AgentRunner,
  type RunResult,
} from './types';

/** `codex exec resume` has no `-s`, so the sandbox is always set through config overrides. */
const PERMISSION_ARGS: Record<Permission, string[]> = {
  'read-only': ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'],
  edit: ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
};

/** JSON strings are valid TOML basic strings, which is what `-c key=value` parses. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function describeItem(item: Record<string, any>): { name: string; detail?: string } | null {
  switch (item.type) {
    case 'command_execution':
      return { name: 'Shell', detail: clip(String(item.command ?? '')) };
    case 'file_change': {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      const detail = changes.map((c) => `${c.kind ?? 'edit'} ${c.path}`).join(', ');
      return { name: 'Edit', detail: clip(detail) || undefined };
    }
    case 'mcp_tool_call':
      return { name: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`, detail: summarizeInput(item.arguments) };
    case 'web_search':
      return { name: 'WebSearch', detail: item.query ? clip(String(item.query)) : undefined };
    default:
      return null;
  }
}

/** Parses `codex exec --json` JSONL events. */
export function createCodexParser(emit: (e: AgentEvent) => void) {
  const started = new Set<string>();
  let threadId: string | undefined;
  let completed = false;
  let failure: string | undefined;
  let lastError: string | undefined;
  let usage: Record<string, number> | undefined;

  function handle(line: string): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    switch (ev.type) {
      case 'thread.started':
        threadId = ev.thread_id;
        if (threadId) emit({ type: 'session', sessionId: threadId });
        break;
      case 'item.started':
      case 'item.updated': {
        const item = ev.item ?? {};
        const d = describeItem(item);
        if (d && item.id && !started.has(item.id)) {
          started.add(item.id);
          emit({ type: 'tool_start', id: item.id, ...d });
        }
        break;
      }
      case 'item.completed': {
        const item = ev.item ?? {};
        if (item.type === 'agent_message') {
          if (item.text) {
            emit({ type: 'text', text: String(item.text) });
            emit({ type: 'text_end' });
          }
          break;
        }
        // `error` items are non-fatal warnings (e.g. hook config notices); fatal errors use turn.failed.
        const d = describeItem(item);
        if (!d || !item.id) break;
        if (!started.has(item.id)) {
          started.add(item.id);
          emit({ type: 'tool_start', id: item.id, ...d });
        }
        const ok =
          item.status !== 'failed' &&
          item.status !== 'declined' &&
          (item.exit_code === undefined || item.exit_code === null || item.exit_code === 0);
        emit({ type: 'tool_end', id: item.id, ok });
        break;
      }
      case 'turn.completed':
        completed = true;
        usage = ev.usage;
        break;
      case 'turn.failed':
        failure = ev.error?.message ?? 'Codex turn failed';
        break;
      case 'error':
        lastError = ev.message;
        break;
    }
  }

  return {
    handle,
    get threadId() {
      return threadId;
    },
    get completed() {
      return completed;
    },
    get failure() {
      return failure ?? (completed ? undefined : lastError);
    },
    get usage() {
      return usage;
    },
  };
}

export const codexRunner: AgentRunner = {
  provider: 'codex',
  async run(o): Promise<RunResult> {
    const common = [
      '--json',
      '--skip-git-repo-check',
      ...PERMISSION_ARGS[o.permission],
      ...(o.model ? ['-m', o.model] : []),
      ...(o.effort ? ['-c', `model_reasoning_effort=${tomlString(o.effort)}`] : []),
      '-c',
      `developer_instructions=${tomlString(o.systemPrompt)}`,
    ];
    const args = o.sessionId
      ? ['exec', 'resume', ...common, o.sessionId, '-']
      : ['exec', ...common, '-C', o.cwd, '-'];
    const parser = createCodexParser(o.onEvent);
    const res = await runProcess({
      bin: o.bin,
      args,
      cwd: o.cwd,
      env: o.env,
      stdin: o.prompt,
      signal: o.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      onLine: parser.handle,
    });
    if (res.aborted) throw new AgentRunError('已停止', true);
    if (res.timedOut) throw new AgentRunError('執行逾時');
    if (parser.failure || !parser.completed) {
      throw new AgentRunError(parser.failure ?? (tail(res.stderr) || `codex 結束（exit ${res.code}）但沒有完成回合`));
    }
    const u = parser.usage;
    return {
      sessionId: parser.threadId ?? o.sessionId,
      inputTokens: u?.input_tokens,
      outputTokens: u ? (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) : undefined,
    };
  },
};
