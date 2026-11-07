import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Permission } from '../../shared/types';
import { runProcess, tail } from '../process';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  parseJsonLine,
  summarizeInput,
  type AgentEvent,
  type AgentRunner,
  type RunResult,
} from './types';

const PERMISSION_MODE: Record<Permission, string> = {
  'read-only': 'dontAsk',
  edit: 'acceptEdits',
  full: 'bypassPermissions',
};

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** Parses `grok --output-format streaming-json` (type-tagged ACP session updates). */
export function createGrokParser(emit: (e: AgentEvent) => void) {
  const open = new Set<string>();
  let inText = false;
  let end: Record<string, any> | null = null;
  let error: string | undefined;

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  function handle(line: string): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    switch (ev.type) {
      case 'text': {
        const text = typeof ev.data === 'string' ? ev.data : ev.content?.text;
        if (text) {
          inText = true;
          emit({ type: 'text', text });
        }
        break;
      }
      case 'tool_call': {
        closeText();
        const id = String(ev.toolCallId ?? randomUUID());
        if (!open.has(id)) {
          open.add(id);
          emit({ type: 'tool_start', id, name: ev.title || ev.toolName || ev.kind || 'tool', detail: summarizeInput(ev.rawInput) });
        }
        if (DONE.has(ev.status)) {
          open.delete(id);
          emit({ type: 'tool_end', id, ok: ev.status === 'completed' });
        }
        break;
      }
      case 'tool_call_update': {
        const id = String(ev.toolCallId ?? '');
        if (open.has(id) && DONE.has(ev.status)) {
          open.delete(id);
          emit({ type: 'tool_end', id, ok: ev.status === 'completed' });
        }
        break;
      }
      case 'usage': // one per model response
        closeText();
        break;
      case 'end':
        closeText();
        end = ev;
        if (ev.sessionId) emit({ type: 'session', sessionId: String(ev.sessionId) });
        break;
      case 'error':
        error = String(ev.message ?? 'Grok error');
        break;
    }
  }

  return {
    handle,
    get end() {
      return end;
    },
    get error() {
      return error;
    },
  };
}

export const grokRunner: AgentRunner = {
  provider: 'grok',
  async run(o): Promise<RunResult> {
    const newSessionId = o.sessionId ? undefined : randomUUID();
    // Long prompts go through a file to stay clear of argv limits and flag parsing.
    const dir = mkdtempSync(join(tmpdir(), 'harness-relay-'));
    const promptFile = join(dir, 'prompt.md');
    writeFileSync(promptFile, o.prompt);
    const args = [
      '--prompt-file',
      promptFile,
      '--verbatim',
      '--output-format',
      'streaming-json',
      '--cwd',
      o.cwd,
      '--permission-mode',
      PERMISSION_MODE[o.permission],
      '--rules',
      o.systemPrompt,
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--reasoning-effort', o.effort] : []),
      ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', newSessionId!]),
    ];
    const parser = createGrokParser(o.onEvent);
    try {
      const res = await runProcess({
        bin: o.bin,
        args,
        cwd: o.cwd,
        env: o.env,
        signal: o.signal,
        timeoutMs: TURN_TIMEOUT_MS,
        onLine: parser.handle,
      });
      if (res.aborted) throw new AgentRunError('已停止', true);
      if (res.timedOut) throw new AgentRunError('執行逾時');
      if (parser.error) throw new AgentRunError(parser.error);
      const end = parser.end;
      if (!end) throw new AgentRunError(tail(res.stderr || res.stdout) || `grok 結束（exit ${res.code}）但沒有回應`);
      const u = end.usage ?? {};
      return {
        sessionId: (end.sessionId as string | undefined) ?? newSessionId ?? o.sessionId,
        costUsd: typeof end.total_cost_usd === 'number' ? end.total_cost_usd : undefined,
        inputTokens:
          u.input_tokens !== undefined
            ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
            : undefined,
        outputTokens: u.output_tokens,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
