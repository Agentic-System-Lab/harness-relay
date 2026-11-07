import type { ChildProcess } from 'node:child_process';
import type { Permission } from '../../shared/types';
import { runProcess, tail } from '../process';
import { JsonRpcConnection, RpcError } from './acp';
import { AgentRunError, TURN_TIMEOUT_MS, summarizeInput, type AgentEvent, type AgentRunner, type RunResult } from './types';

/*
 * Grok runs as an ACP agent (`grok agent stdio`: JSON-RPC over stdin/stdout), not headless `grok -p`.
 *
 * Headless grok cannot ask for approval: a tool call that would prompt is reported as "User
 * cancelled" and the whole turn ends (`stopReason: "cancelled"`), so one refused command cut a
 * reply off mid-way. Over ACP the permission request comes to us instead, and rejecting it with a
 * `followup_message` hands our reason to the model, which then carries on with the turn.
 *
 * - read-only: grok asks; we approve web fetch and refuse everything else. Grok still runs its
 *   built-in read-only tools and commands without asking (and bare `mkdir` / `touch`).
 * - edit: grok asks, inside the `workspace` sandbox (the kernel confines writes to the working
 *   directory and temp dirs); we approve everything except publishing (git push, npm publish…).
 * - full: always-approve.
 *
 * The session's mode is set explicitly (`_meta.yoloMode`) so a user-level
 * `[ui] permission_mode = "always-approve"` in ~/.grok/config.toml cannot widen read-only or edit.
 */

const PERMISSION_LABEL: Record<Permission, string> = {
  'read-only': '唯讀',
  edit: '可編輯',
  full: '完全存取',
};

/** Sandbox profile per permission (`GROK_SANDBOX`). Read-only relies on refusing requests instead:
 *  the `read-only` profile refuses to start on some machines (e.g. a symlinked /var/run/docker.sock). */
const SANDBOX: Partial<Record<Permission, string>> = { edit: 'workspace' };

const PUBLISH = /(^|[;&|(]\s*)(git\s+push|(npm|pnpm|yarn|bun|cargo|poetry|gem)\s+publish|twine\s+upload)\b/;

/** The `toolCall` of an ACP `session/request_permission`. */
export interface GrokToolCall {
  toolCallId?: string;
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  _meta?: Record<string, any>;
}

export type GrokDecision =
  | { allow: true }
  /** `reason` goes back to the model; `label` is shown under the tool in the chat. */
  | { allow: false; reason: string; label: string };

/** Whether to approve a tool call grok asks about under this conversation's permission. */
export function grokPermissionDecision(permission: Permission, call: GrokToolCall): GrokDecision {
  if (permission === 'full') return { allow: true };
  const tool = String(call._meta?.['x.ai/tool']?.name ?? '');
  const what = call.title || tool || 'this tool call';
  if (permission === 'read-only') {
    if (call.kind === 'fetch' || tool === 'web_fetch' || tool === 'web_search') return { allow: true };
    return {
      allow: false,
      reason:
        `Not run: this conversation is read-only (the user's Harness Relay setting), so "${what}" is not allowed. ` +
        'Do not retry it or try to work around it. Continue with read-only tools (read_file, list_dir, grep, ' +
        'read-only shell commands, web fetch/search) and describe any change you would make instead of making it.',
      label: '唯讀模式不允許，已告知 Grok 改用唯讀工具',
    };
  }
  const command = typeof call.rawInput?.command === 'string' ? call.rawInput.command : '';
  if (PUBLISH.test(command)) {
    return {
      allow: false,
      reason:
        `Not run: "${what}" publishes outside this machine, which this conversation's edit permission does not allow. ` +
        'Leave pushing/publishing to the user and continue with the rest of the task.',
      label: '可編輯模式不允許推送或發佈',
    };
  }
  return { allow: true };
}

/** Builds the reply to `session/request_permission`. */
function answerPermission(decision: GrokDecision, options: { optionId: string; kind: string }[]) {
  const pick = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
  if (decision.allow) {
    const optionId = pick('allow_once') ?? pick('allow_always');
    if (optionId) return { outcome: { outcome: 'selected', optionId } };
  } else {
    const optionId = pick('reject_once') ?? pick('reject_always');
    // grok treats a rejection carrying a follow-up message as feedback for the model, not a cancel.
    if (optionId) return { outcome: { outcome: 'selected', optionId }, _meta: { followup_message: decision.reason } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

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

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** Turns ACP `session/update` payloads into AgentEvents. */
export function createGrokUpdateHandler(emit: (e: AgentEvent) => void) {
  const open = new Set<string>();
  const names = new Map<string, string>();
  const refused = new Map<string, string>();
  let inText = false;
  let lastFailure: { tool: string; reason?: string } | undefined;

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  const finishTool = (id: string, u: Record<string, any>) => {
    open.delete(id);
    const ok = u.status === 'completed';
    let error: string | undefined;
    if (!ok) {
      const reason = contentText(u.content);
      lastFailure = { tool: names.get(id) ?? 'tool', reason };
      error = refused.get(id) ?? reason;
    }
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}) });
  };

  function handle(u: Record<string, any> | undefined): void {
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string' && text) {
          inText = true;
          emit({ type: 'text', text });
        }
        break;
      }
      case 'tool_call': {
        closeText();
        const id = String(u.toolCallId ?? '');
        if (!id) break;
        if (!open.has(id)) {
          open.add(id);
          const name = String(u.title || u._meta?.['x.ai/tool']?.name || u.kind || 'tool');
          names.set(id, String(u._meta?.['x.ai/tool']?.name || name));
          emit({ type: 'tool_start', id, name, detail: summarizeInput(u.rawInput) });
        }
        if (DONE.has(u.status)) finishTool(id, u);
        break;
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        if (open.has(id) && DONE.has(u.status)) finishTool(id, u);
        break;
      }
      case 'response_completed': // one per model response
        closeText();
        break;
    }
  }

  return {
    handle,
    /** Remember why we refused a call, to show that instead of grok's generic "not executed". */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    finish: closeText,
    /** The most recent tool call that did not complete, with grok's stated reason. */
    get lastFailure() {
      return lastFailure;
    },
  };
}

/** Explains a turn grok ended itself (`stopReason: "cancelled"`) without us cancelling it. */
export function describeGrokCancel(failure: { tool: string; reason?: string } | undefined, permission: Permission): string {
  if (!failure) return 'Grok 自行中止了這一輪（stopReason: cancelled），沒有給出原因。';
  const reason = failure.reason ? `（${failure.reason}）` : '';
  const hint =
    permission === 'full' ? '' : `目前的權限是「${PERMISSION_LABEL[permission]}」；若這個操作是必要的，可以把權限改成「完全存取」再試。`;
  return `Grok 在執行工具「${failure.tool}」時中止了這一輪${reason}。${hint}`;
}

/** `costUsdTicks` are 1e-10 USD. */
const TICKS_PER_USD = 1e10;

export const grokRunner: AgentRunner = {
  provider: 'grok',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError('已停止', true);
    // Model and effort are set per session below: `grok agent --reasoning-effort` does not reach ACP sessions.
    const args = ['agent', '--no-leader', 'stdio'];
    const sandbox = SANDBOX[o.permission];
    const env = sandbox ? { ...o.env, GROK_SANDBOX: sandbox } : o.env;

    let child: ChildProcess | undefined;
    let sessionId: string | undefined;
    let userAborted = false;
    // Ends the grok process: once the turn is over, or when a cancel is not honoured in time.
    const stop = new AbortController();
    const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

    const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
    const updates = createGrokUpdateHandler(o.onEvent);
    conn.onNotification = (method, params) => {
      if (method !== 'session/update' && method !== '_x.ai/session_notification') return;
      if (!sessionId || params?.sessionId !== sessionId) return; // sub-agents and pre-session noise
      updates.handle(params.update);
    };
    conn.onRequest = (method, params) => {
      if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
      const call: GrokToolCall = params?.toolCall ?? {};
      const decision = grokPermissionDecision(o.permission, call);
      if (!decision.allow && call.toolCallId) updates.refused(call.toolCallId, decision.label);
      return answerPermission(decision, Array.isArray(params?.options) ? params.options : []);
    };

    const onAbort = () => {
      userAborted = true;
      if (sessionId) conn.notify('session/cancel', { sessionId });
      stopSoon(2000);
    };
    o.signal.addEventListener('abort', onAbort, { once: true });

    const exited = runProcess({
      bin: o.bin,
      args,
      cwd: o.cwd,
      env,
      signal: stop.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      keepStdinOpen: true,
      onSpawn: (c) => (child = c),
      onLine: conn.handleLine,
    }).then(
      (res) => {
        const why = res.timedOut
          ? '執行逾時'
          : tail(res.stderr) || `grok 結束（exit ${res.code}）但沒有完成回合`;
        conn.close(new AgentRunError(sandbox && /sandbox/i.test(res.stderr) ? `Grok 無法啟動沙箱（可編輯模式需要）：${why}` : why));
        return res;
      },
      (err: Error) => {
        conn.close(err);
        throw err;
      },
    );
    exited.catch(() => undefined); // surfaced through the pending requests instead

    try {
      await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const sessionMeta = { rules: o.systemPrompt, yoloMode: o.permission === 'full' };
      let configOptions: any[] | undefined;
      if (o.sessionId) {
        const r = await conn.request('session/resume', { sessionId: o.sessionId, cwd: o.cwd, mcpServers: [], _meta: sessionMeta });
        sessionId = o.sessionId;
        configOptions = r?.configOptions;
      } else {
        const r = await conn.request('session/new', { cwd: o.cwd, mcpServers: [], _meta: sessionMeta });
        sessionId = String(r?.sessionId ?? '');
        if (!sessionId) throw new AgentRunError('grok 沒有回傳 session id');
        configOptions = r?.configOptions;
      }
      o.onEvent({ type: 'session', sessionId });
      if (userAborted) throw new AgentRunError('已停止', true);

      for (const [configId, value, label] of [
        ['model', o.model, '模型'],
        ['reasoning_effort', o.effort, '推理強度'],
      ] as const) {
        const current = configOptions?.find((c: any) => c?.id === configId)?.currentValue;
        if (!value || value === current) continue;
        await conn
          .request('session/set_config_option', { sessionId, configId, value })
          .catch((err: Error) => {
            throw new AgentRunError(`Grok 不接受${label}「${value}」：${err.message}`);
          });
      }

      const result = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: o.prompt }] });
      updates.finish();
      if (userAborted) throw new AgentRunError('已停止', true);
      if (result?.stopReason === 'cancelled') throw new AgentRunError(describeGrokCancel(updates.lastFailure, o.permission));

      const u = result?._meta?.usage ?? {};
      return {
        sessionId,
        costUsd: typeof u.costUsdTicks === 'number' ? u.costUsdTicks / TICKS_PER_USD : undefined,
        inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : undefined,
        outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : undefined,
      };
    } catch (err) {
      if (userAborted) throw new AgentRunError('已停止', true);
      if (err instanceof AgentRunError) throw err;
      throw new AgentRunError(err instanceof Error ? err.message : String(err));
    } finally {
      o.signal.removeEventListener('abort', onAbort);
      child?.stdin?.end(); // grok exits when its stdin closes
      stopSoon(3000);
      await exited.catch(() => undefined);
    }
  },
};
