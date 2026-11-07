import { randomUUID } from 'node:crypto';
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

const PERMISSION_MODE: Record<Permission, string> = {
  // dontAsk: anything that would need approval is denied; read-only tools still work.
  'read-only': 'dontAsk',
  edit: 'acceptEdits',
  full: 'bypassPermissions',
};

/**
 * Shell commands pre-approved in edit mode: building, testing, linting and formatting the project.
 * Any other command that needs approval is denied (the model is told and carries on). Installs,
 * git writes and deletes still need full access.
 */
export const CLAUDE_EDIT_COMMANDS = [
  'mkdir',
  'make',
  // Node
  'npm test',
  'npm run',
  'pnpm test',
  'pnpm run',
  'yarn test',
  'yarn run',
  'bun test',
  'bun run',
  'npx tsc',
  'npx vitest',
  'npx jest',
  'npx eslint',
  'npx prettier',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  // Python
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'uv run pytest',
  'ruff',
  'mypy',
  'black',
  // Rust / Go
  'cargo build',
  'cargo check',
  'cargo test',
  'cargo clippy',
  'cargo fmt',
  'cargo run',
  'go build',
  'go test',
  'go vet',
  'go run',
  'gofmt',
];

/** Tools approved up front. Web access is not about the file system, so every level gets it. */
export function claudeAllowedTools(permission: Permission): string[] {
  if (permission === 'full') return [];
  return ['WebFetch', 'WebSearch', ...(permission === 'edit' ? CLAUDE_EDIT_COMMANDS.map((c) => `Bash(${c}:*)`) : [])];
}

/** Text of a `tool_result` block's content (a string or text blocks). */
function resultText(content: unknown): string | undefined {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
        : '';
  return text.trim() ? clip(text, 240) : undefined;
}

/** Parses `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export function createClaudeParser(emit: (e: AgentEvent) => void) {
  const openTextBlocks = new Set<number>();
  const streamedMessages = new Set<string>();
  let result: Record<string, any> | null = null;
  let sessionId: string | undefined;

  function handle(line: string): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    if (ev.session_id && ev.session_id !== sessionId) {
      sessionId = ev.session_id as string;
      emit({ type: 'session', sessionId });
    }
    // Ignore events produced inside sub-agents; only the main agent's turn goes to the chat.
    if (ev.parent_tool_use_id) return;

    switch (ev.type) {
      case 'stream_event': {
        const e = ev.event ?? {};
        if (e.type === 'message_start' && e.message?.id) streamedMessages.add(e.message.id);
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') openTextBlocks.add(e.index);
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          emit({ type: 'text', text: e.delta.text });
        }
        if (e.type === 'content_block_stop' && openTextBlocks.delete(e.index)) emit({ type: 'text_end' });
        break;
      }
      case 'assistant': {
        const msg = ev.message ?? {};
        const streamed = msg.id && streamedMessages.has(msg.id);
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'tool_use') {
            emit({ type: 'tool_start', id: block.id, name: block.name, detail: summarizeInput(block.input) });
          } else if (block.type === 'text' && !streamed && block.text) {
            // Fallback when partial messages were not streamed.
            emit({ type: 'text', text: block.text });
            emit({ type: 'text_end' });
          }
        }
        break;
      }
      case 'user': {
        const content = ev.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== 'tool_result') continue;
          const error = block.is_error ? resultText(block.content) : undefined;
          emit({ type: 'tool_end', id: block.tool_use_id, ok: !block.is_error, ...(error ? { error } : {}) });
        }
        break;
      }
      case 'result':
        result = ev;
        break;
    }
  }

  return {
    handle,
    get result() {
      return result;
    },
    get sessionId() {
      return sessionId;
    },
  };
}

export const claudeRunner: AgentRunner = {
  provider: 'claude',
  async run(o): Promise<RunResult> {
    const newSessionId = o.sessionId ? undefined : randomUUID();
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--append-system-prompt',
      o.systemPrompt,
      // Variadic; the next `--flag` ends the list.
      ...withAllowedTools(claudeAllowedTools(o.permission)),
      '--permission-mode',
      PERMISSION_MODE[o.permission],
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--effort', o.effort] : []),
      ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', newSessionId!]),
    ];
    const parser = createClaudeParser(o.onEvent);
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

    const r = parser.result;
    if (!r) throw new AgentRunError(tail(res.stderr || res.stdout) || `claude 結束（exit ${res.code}）但沒有回應`);
    if (r.is_error) {
      const detail = typeof r.result === 'string' && r.result ? r.result : (r.errors ?? []).join('\n') || r.subtype;
      throw new AgentRunError(String(detail || 'Claude Code 回報錯誤'));
    }
    return {
      sessionId: parser.sessionId ?? newSessionId ?? o.sessionId,
      costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
      inputTokens: sumInput(r.usage),
      outputTokens: r.usage?.output_tokens,
    };
  },
};

function withAllowedTools(tools: string[]): string[] {
  return tools.length ? ['--allowedTools', ...tools] : [];
}

function sumInput(u: any): number | undefined {
  if (!u) return undefined;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
