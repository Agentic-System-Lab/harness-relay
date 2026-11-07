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

/**
 * Shell commands pre-approved in edit mode: building, testing, linting and formatting the
 * project. Grok matches each rule as a plain prefix (no word boundary) against every segment
 * of a chained command, so `cd app && npm test` needs `cd ` as well, and a trailing space keeps
 * `cd ` from matching `cdk deploy`. Installs, git writes and deletes still need full access.
 */
export const GROK_EDIT_COMMANDS = [
  'cd ',
  'echo ',
  'diff ',
  'which ',
  'mkdir ',
  'make',
  // Node
  'npm test',
  'npm run ',
  'pnpm test',
  'pnpm run ',
  'yarn test',
  'yarn run ',
  'bun test',
  'bun run ',
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
  'ruff ',
  'mypy',
  'black ',
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
  'go run ',
  'gofmt',
];

/**
 * Headless grok cannot ask for approval: a tool call that would prompt is reported as
 * "User cancelled" and the whole turn ends (`stopReason: "cancelled"`), instead of the
 * denial going back to the model. So pre-approve what each permission level should allow
 * anyway: `web_fetch` (not on grok's built-in read-only list — the permission setting is
 * about the file system, not the network) and, in edit mode, common project commands.
 */
export function grokPermissionArgs(permission: Permission): string[] {
  const allow = (rule: string) => ['--allow', rule];
  const rules =
    permission === 'full'
      ? []
      : [
          ...allow('WebFetch'),
          ...(permission === 'edit' ? GROK_EDIT_COMMANDS.flatMap((c) => allow(`Bash(${c})`)) : []),
        ];
  return ['--permission-mode', PERMISSION_MODE[permission], ...rules];
}

const PERMISSION_LABEL: Record<Permission, string> = {
  'read-only': '唯讀',
  edit: '可編輯',
  full: '完全存取',
};

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** Text of an ACP tool-call `content` array (e.g. the reason a call failed). */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (typeof c?.content?.text === 'string' ? c.content.text : typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || undefined;
}

/** Parses `grok --output-format streaming-json` (type-tagged ACP session updates). */
export function createGrokParser(emit: (e: AgentEvent) => void) {
  const open = new Set<string>();
  const names = new Map<string, string>();
  let inText = false;
  let end: Record<string, any> | null = null;
  let error: string | undefined;
  let lastFailure: { tool: string; reason?: string } | undefined;

  const finishTool = (id: string, ev: Record<string, any>) => {
    open.delete(id);
    const ok = ev.status === 'completed';
    if (!ok) lastFailure = { tool: names.get(id) ?? 'tool', reason: contentText(ev.content) };
    emit({ type: 'tool_end', id, ok });
  };

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
          names.set(id, String(ev.toolName || ev.title || ev.kind || 'tool'));
          emit({ type: 'tool_start', id, name: ev.title || ev.toolName || ev.kind || 'tool', detail: summarizeInput(ev.rawInput) });
        }
        if (DONE.has(ev.status)) finishTool(id, ev);
        break;
      }
      case 'tool_call_update': {
        const id = String(ev.toolCallId ?? '');
        if (open.has(id) && DONE.has(ev.status)) finishTool(id, ev);
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
    /** The most recent tool call that did not complete, with grok's stated reason. */
    get lastFailure() {
      return lastFailure;
    },
  };
}

/** Explains a turn grok ended itself (`stopReason: "cancelled"`) without us aborting it. */
export function describeGrokCancel(failure: { tool: string; reason?: string } | undefined, permission: Permission): string {
  if (!failure) return 'Grok 自行中止了這一輪（stopReason: cancelled），沒有給出原因。';
  const reason = failure.reason ? `（${failure.reason}）` : '';
  const hint =
    permission === 'full'
      ? ''
      : `這通常是該工具或指令需要核准，但目前的權限「${PERMISSION_LABEL[permission]}」沒有預先允許；Grok 在非互動模式下無法詢問，會直接結束整輪而不是繼續回答。若需要它，請把權限改成「完全存取」。`;
  return `Grok 在執行工具「${failure.tool}」時中止了這一輪${reason}。${hint}`;
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
      ...grokPermissionArgs(o.permission),
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
      // We did not abort (checked above), so grok cancelled the turn itself — usually a tool it may not run.
      if (end.stopReason === 'cancelled') throw new AgentRunError(describeGrokCancel(parser.lastFailure, o.permission));
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
