import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Permission, PlanEntry } from '../../shared/types';
import { runProcess, tail } from '../process';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  imageData,
  parseJsonLine,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type RunOptions,
  type RunResult,
} from './types';
import { t } from '../i18n';

/*
 * Claude Code runs as `claude -p` with stream-json in both directions. The prompt goes in as a
 * user message; when the conversation asks the user about actions the permission does not cover,
 * `--permission-prompt-tool stdio` makes Claude Code send each one as a `can_use_tool` control
 * request on stdout and wait for our control response on stdin. Without it, such actions are
 * denied automatically and the model is told.
 */

/** Permission mode when the user is asked / when such actions are refused automatically. */
const PERMISSION_MODE: Record<Permission, { ask: string; deny: string }> = {
  // manual: anything beyond reading asks; dontAsk: anything that would ask is denied.
  'read-only': { ask: 'manual', deny: 'dontAsk' },
  edit: { ask: 'acceptEdits', deny: 'acceptEdits' },
  full: { ask: 'bypassPermissions', deny: 'bypassPermissions' },
};

/**
 * Shell commands pre-approved in edit mode: building, testing, linting and formatting the project.
 * Any other command that needs approval goes to the user (or is denied when the conversation does
 * not ask). Installs, git writes and deletes are never pre-approved.
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
function resultText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      : '';
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** Claude Code's to-do list (the TodoWrite tool) as plan entries. */
function todoEntries(input: any): PlanEntry[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  return input.todos.map((todo: any) => ({
    text: String(todo?.content ?? todo?.activeForm ?? ''),
    status: PLAN_STATUS.has(todo?.status) ? todo.status : 'pending',
  }));
}

/** What to show the user for a `can_use_tool` request. */
export function claudeApprovalRequest(tool: string, input: Record<string, any> = {}, description?: string): ApprovalRequest {
  const reason = (typeof input.description === 'string' && input.description) || description || undefined;
  if (tool === 'Bash') return { kind: 'command', detail: String(input.command ?? ''), reason };
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    return { kind: 'edit', detail: String(input.file_path ?? input.notebook_path ?? ''), reason };
  }
  if (tool === 'WebFetch') return { kind: 'fetch', detail: String(input.url ?? ''), reason };
  return { kind: 'other', tool, detail: summarizeInput(input), reason };
}

const DECLINED = 'The user declined this.';

/** The message Claude gets when the user declines (shown to the user localized instead). */
function declinedMessage(note?: string): string {
  return `${DECLINED}${note ? ` Their message: ${note}` : ''} Do not retry it; continue without it, or explain in your reply why it is needed.`;
}

/** The user's note when a tool result is our decline message ('' without a note), else undefined. */
function declinedNote(text: string): string | undefined {
  if (!text.startsWith(DECLINED)) return undefined;
  return text.match(/Their message: ([\s\S]*?) Do not retry it;/)?.[1] ?? '';
}

/** A `control_request` Claude Code sends on stdout (e.g. `can_use_tool`). */
export interface ClaudeControlRequest {
  requestId: string;
  subtype: string;
  request: Record<string, any>;
}

/** Parses `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export function createClaudeParser(emit: (e: AgentEvent) => void, onControl?: (req: ClaudeControlRequest) => void) {
  const openTextBlocks = new Set<number>();
  const thinkingBlocks = new Set<number>();
  const streamedMessages = new Set<string>();
  /** Tool calls shown as something else (the to-do list), so their results are not tool rows. */
  const hiddenTools = new Set<string>();
  let result: Record<string, any> | null = null;
  let sessionId: string | undefined;

  function handle(line: string): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    if (ev.type === 'control_request') {
      onControl?.({ requestId: String(ev.request_id), subtype: String(ev.request?.subtype ?? ''), request: ev.request ?? {} });
      return;
    }
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
        if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') thinkingBlocks.add(e.index);
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          emit({ type: 'text', text: e.delta.text });
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          emit({ type: 'thinking', text: e.delta.thinking });
        }
        if (e.type === 'content_block_stop') {
          if (openTextBlocks.delete(e.index)) emit({ type: 'text_end' });
          thinkingBlocks.delete(e.index);
        }
        break;
      }
      case 'assistant': {
        const msg = ev.message ?? {};
        const streamed = msg.id && streamedMessages.has(msg.id);
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'tool_use') {
            const todos = block.name === 'TodoWrite' ? todoEntries(block.input) : undefined;
            if (todos) {
              hiddenTools.add(block.id);
              emit({ type: 'plan', entries: todos });
            } else {
              emit({ type: 'tool_start', id: block.id, name: block.name, detail: summarizeInput(block.input) });
            }
          } else if (!streamed && block.type === 'thinking' && block.thinking) {
            emit({ type: 'thinking', text: block.thinking });
          } else if (!streamed && block.type === 'text' && block.text) {
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
          if (block.type !== 'tool_result' || hiddenTools.has(block.tool_use_id)) continue;
          const text = resultText(block.content).trim();
          const declined = block.is_error ? declinedNote(text) : undefined;
          const extra = !text
            ? {}
            : declined !== undefined
              ? { error: declined ? `${t().approvalDeclined} ${declined}` : t().approvalDeclined }
              : block.is_error
                ? { error: clip(text, 240) }
                : { output: tailText(text) };
          emit({ type: 'tool_end', id: block.tool_use_id, ok: !block.is_error, ...extra });
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

/**
 * `--thinking-display summarized` makes Claude Code stream readable thinking summaries (by default
 * the thinking text is left empty). The flag is not in `--help`, so an older version that rejects
 * it is remembered and the run is retried without it.
 */
let thinkingDisplay = true;

export const claudeRunner: AgentRunner = {
  provider: 'claude',
  async run(o): Promise<RunResult> {
    try {
      return await runClaude(o, thinkingDisplay);
    } catch (err) {
      if (!(err instanceof UnsupportedFlag)) throw err;
      thinkingDisplay = false;
      return runClaude(o, false);
    }
  },
};

class UnsupportedFlag extends Error {}

async function runClaude(o: Parameters<AgentRunner['run']>[0], withThinking: boolean): Promise<RunResult> {
  const newSessionId = o.sessionId ? undefined : randomUUID();
  const ask = Boolean(o.requestApproval) && o.permission !== 'full';
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    o.systemPrompt,
    // Variadic; the next `--flag` ends the list.
    ...withAllowedTools(claudeAllowedTools(o.permission)),
    // Lets Claude read the attached files outside the working directory (variadic too).
    ...(o.attachmentsDir ? ['--add-dir', o.attachmentsDir] : []),
    '--permission-mode',
    PERMISSION_MODE[o.permission][ask ? 'ask' : 'deny'],
    ...(ask ? ['--permission-prompt-tool', 'stdio'] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(withThinking ? ['--thinking-display', 'summarized'] : []),
    ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', newSessionId!]),
  ];

  let child: ChildProcess | undefined;
  const send = (msg: unknown) => {
    if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  };
  const respond = (requestId: string, response: unknown) =>
    send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

  const onControl = (req: ClaudeControlRequest) => {
    if (req.subtype !== 'can_use_tool') {
      send({ type: 'control_response', response: { subtype: 'error', request_id: req.requestId, error: 'not supported' } });
      return;
    }
    const tool = String(req.request.tool_name ?? '');
    const input = (req.request.input ?? {}) as Record<string, any>;
    const ask = o.requestApproval;
    if (!ask) {
      respond(req.requestId, { behavior: 'deny', message: 'Not allowed in this conversation.' });
      return;
    }
    void ask(claudeApprovalRequest(tool, input, req.request.description)).then(
      (answer) =>
        respond(
          req.requestId,
          answer.allow
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: declinedMessage(answer.note) },
        ),
      () => respond(req.requestId, { behavior: 'deny', message: 'Not allowed.' }),
    );
  };

  const parser = createClaudeParser(o.onEvent, onControl);
  const res = await runProcess({
    bin: o.bin,
    args,
    cwd: o.cwd,
    env: o.env,
    keepStdinOpen: true,
    onSpawn: (c) => {
      child = c;
      send({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize', hooks: null } });
      send({ type: 'user', message: { role: 'user', content: claudeContent(o.prompt, o.images) } });
    },
    signal: o.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    onLine: (line) => {
      parser.handle(line);
      // One prompt per run: once the turn has its result, let Claude Code exit.
      if (parser.result) child?.stdin?.end();
    },
  });
  if (res.aborted) throw new AgentRunError(t().stopped, true);
  if (res.timedOut) throw new AgentRunError(t().timedOut);

  const r = parser.result;
  if (!r && withThinking && /unknown option.*thinking-display/i.test(res.stderr)) throw new UnsupportedFlag();
  if (!r) throw new AgentRunError(tail(res.stderr || res.stdout) || t().exitedWithoutReply('claude', res.code));
  if (r.is_error) {
    const detail = typeof r.result === 'string' && r.result ? r.result : (r.errors ?? []).join('\n') || r.subtype;
    throw new AgentRunError(String(detail || t().claudeError));
  }
  return {
    sessionId: parser.sessionId ?? newSessionId ?? o.sessionId,
    costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
    inputTokens: sumInput(r.usage),
    outputTokens: r.usage?.output_tokens,
  };
}

/** The prompt, plus attached images as image blocks. */
export function claudeContent(prompt: string, images: RunOptions['images']): string | unknown[] {
  const blocks: unknown[] = [];
  for (const img of images ?? []) {
    const data = imageData(img.path);
    if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data } });
  }
  return blocks.length ? [{ type: 'text', text: prompt }, ...blocks] : prompt;
}

function withAllowedTools(tools: string[]): string[] {
  return tools.length ? ['--allowedTools', ...tools] : [];
}

function sumInput(u: any): number | undefined {
  if (!u) return undefined;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
