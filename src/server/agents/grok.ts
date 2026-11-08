import type { ChildProcess } from 'node:child_process';
import type { Permission } from '../../shared/types';
import { isPublishCommand } from '../commands';
import { runProcess, tail } from '../process';
import { JsonRpcConnection, RpcError } from './acp';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  imageData,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunOptions,
  type RunResult,
} from './types';
import { t } from '../i18n';

/** ACP prompt blocks: the text, plus attached images (Grok advertises promptCapabilities.image). */
export function grokPrompt(prompt: string, images: RunOptions['images']): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: prompt }];
  for (const img of images ?? []) {
    const data = imageData(img.path);
    if (data) blocks.push({ type: 'image', data, mimeType: img.mimeType });
  }
  return blocks;
}

/*
 * Grok runs as an ACP agent (`grok agent stdio`: JSON-RPC over stdin/stdout), not headless `grok -p`.
 *
 * Headless grok cannot ask for approval: a tool call that would prompt is reported as "User
 * cancelled" and the whole turn ends (`stopReason: "cancelled"`), so one refused command cut a
 * reply off mid-way. Over ACP the permission request comes to us instead, and rejecting it with a
 * `followup_message` hands our reason to the model, which then carries on with the turn.
 *
 * - read-only: grok asks; web fetch runs, anything else goes to the user (or is refused when the
 *   conversation does not ask). Grok still runs its built-in read-only tools and commands without
 *   asking (and bare `mkdir` / `touch`).
 * - edit: grok asks, inside the `workspace` sandbox (the kernel confines writes to the working
 *   directory and temp dirs); everything runs except publishing (git push, npm publish…), which
 *   goes to the user.
 * - full: always-approve.
 *
 * The session's mode is set explicitly (`_meta.yoloMode`) so a user-level
 * `[ui] permission_mode = "always-approve"` in ~/.grok/config.toml cannot widen read-only or edit.
 */

/** Sandbox profile per permission (`GROK_SANDBOX`). Read-only relies on refusing requests instead:
 *  the `read-only` profile refuses to start on some machines (e.g. a symlinked /var/run/docker.sock). */
const SANDBOX: Partial<Record<Permission, string>> = { edit: 'workspace' };


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
      label: t().grokRefusedReadOnly,
    };
  }
  const command = typeof call.rawInput?.command === 'string' ? call.rawInput.command : '';
  if (isPublishCommand(command)) {
    return {
      allow: false,
      reason:
        `Not run: "${what}" publishes outside this machine, which this conversation's edit permission does not allow. ` +
        'Leave pushing/publishing to the user and continue with the rest of the task.',
      label: t().grokRefusedPublish,
    };
  }
  return { allow: true };
}

/** What to show the user when grok asks about a call the permission does not cover. */
export function grokApprovalRequest(call: GrokToolCall): ApprovalRequest {
  const tool = String(call._meta?.['x.ai/tool']?.name ?? '');
  const input = call.rawInput ?? {};
  const reason = typeof input.description === 'string' && input.description ? input.description : call.title;
  if (call.kind === 'execute' || typeof input.command === 'string') {
    return { kind: 'command', detail: String(input.command ?? ''), reason };
  }
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' || /write|replace|edit/i.test(tool)) {
    return { kind: 'edit', detail: input.file_path ?? input.path ?? input.target_file, reason: call.title };
  }
  if (call.kind === 'fetch') return { kind: 'fetch', detail: input.url, reason: call.title };
  return { kind: 'other', tool: tool || call.title, detail: summarizeInput(input), reason: call.title };
}

/** The decision after the user declined (their note, if any, goes to the model). */
function declined(call: GrokToolCall, note?: string): GrokDecision {
  const what = call.title || String(call._meta?.['x.ai/tool']?.name ?? 'this tool call');
  return {
    allow: false,
    reason:
      `Not run: the user declined "${what}".${note ? ` Their message: ${note}` : ''} ` +
      'Do not retry it; continue without it, or explain in your reply why it is needed.',
    label: note ? `${t().approvalDeclined} ${note}` : t().approvalDeclined,
  };
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
  /** To-do updates arrive as `plan` updates too, so their tool calls are not shown as rows. */
  const hidden = new Set<string>();
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
    const text = contentText(u.content);
    let error: string | undefined;
    if (!ok) {
      lastFailure = { tool: names.get(id) ?? 'tool', reason: text };
      error = refused.get(id) ?? text;
    }
    const output = ok && text ? tailText(text) : undefined;
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}), ...(output ? { output } : {}) });
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
      case 'agent_thought_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string' && text) {
          closeText();
          emit({ type: 'thinking', text });
        }
        break;
      }
      case 'plan': {
        const entries = Array.isArray(u.entries) ? u.entries : [];
        emit({
          type: 'plan',
          entries: entries.map((e: any) => ({
            text: String(e?.content ?? ''),
            status: e?.status === 'completed' || e?.status === 'in_progress' ? e.status : 'pending',
          })),
        });
        break;
      }
      case 'tool_call': {
        closeText();
        const id = String(u.toolCallId ?? '');
        if (!id || hidden.has(id)) break;
        if (u._meta?.['x.ai/tool']?.name === 'todo_write' || u.title === 'todo_write') {
          hidden.add(id);
          break;
        }
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
  const m = t();
  if (!failure) return m.grokCancelledNoReason;
  const hint = permission === 'full' ? '' : m.grokCancelHint(m.permission[permission]);
  return m.grokCancelled(failure.tool, failure.reason) + hint;
}

/**
 * The tool library's MCP servers in ACP's form. Grok adds the ones from its own config files. HTTP
 * servers only go to an agent that says it takes them (`mcpCapabilities.http`); ACP forbids them otherwise.
 */
export function grokMcpServers(servers: McpServerSpec[], http = true): Record<string, unknown>[] {
  const list = (vars: Record<string, string>) => Object.entries(vars).map(([name, value]) => ({ name, value }));
  const skipped = http ? [] : servers.filter((s) => s.transport === 'http');
  if (skipped.length) console.warn(`[grok] this grok does not take HTTP MCP servers; left out: ${skipped.map((s) => s.name).join(', ')}`);
  return servers.filter((s) => http || s.transport !== 'http').map((s) =>
    s.transport === 'http'
      ? { type: 'http', name: s.name, url: s.url, headers: list(s.headers) }
      : { name: s.name, command: s.command, args: s.args, env: list(s.env) },
  );
}

/** `costUsdTicks` are 1e-10 USD. */
const TICKS_PER_USD = 1e10;

export const grokRunner: AgentRunner = {
  provider: 'grok',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
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
    conn.onRequest = async (method, params) => {
      if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
      const call: GrokToolCall = params?.toolCall ?? {};
      let decision = grokPermissionDecision(o.permission, call);
      // Not covered by the permission: the user decides, when the conversation asks.
      if (!decision.allow && o.requestApproval) {
        const answer = await o.requestApproval(grokApprovalRequest(call));
        decision = answer.allow ? { allow: true } : declined(call, answer.note);
      }
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
          ? t().timedOut
          : tail(res.stderr) || t().exitedWithoutTurn('grok', res.code);
        conn.close(new AgentRunError(sandbox && /sandbox/i.test(res.stderr) ? t().grokSandbox(why) : why));
        return res;
      },
      (err: Error) => {
        conn.close(err);
        throw err;
      },
    );
    exited.catch(() => undefined); // surfaced through the pending requests instead

    try {
      const init = await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const mcpServers = grokMcpServers(o.mcpServers ?? [], Boolean(init?.agentCapabilities?.mcpCapabilities?.http));
      const sessionMeta = { rules: o.systemPrompt, yoloMode: o.permission === 'full' };
      let configOptions: any[] | undefined;
      if (o.sessionId) {
        const r = await conn.request('session/resume', { sessionId: o.sessionId, cwd: o.cwd, mcpServers, _meta: sessionMeta });
        sessionId = o.sessionId;
        configOptions = r?.configOptions;
      } else {
        const r = await conn.request('session/new', { cwd: o.cwd, mcpServers, _meta: sessionMeta });
        sessionId = String(r?.sessionId ?? '');
        if (!sessionId) throw new AgentRunError(t().grokNoSession);
        configOptions = r?.configOptions;
      }
      o.onEvent({ type: 'session', sessionId });
      if (userAborted) throw new AgentRunError(t().stopped, true);

      for (const [configId, value, rejected] of [
        ['model', o.model, t().grokRejectedModel],
        ['reasoning_effort', o.effort, t().grokRejectedEffort],
      ] as const) {
        const current = configOptions?.find((c: any) => c?.id === configId)?.currentValue;
        if (!value || value === current) continue;
        await conn
          .request('session/set_config_option', { sessionId, configId, value })
          .catch((err: Error) => {
            throw new AgentRunError(rejected(value, err.message));
          });
      }

      const result = await conn.request('session/prompt', { sessionId, prompt: grokPrompt(o.prompt, o.images) });
      updates.finish();
      if (userAborted) throw new AgentRunError(t().stopped, true);
      if (result?.stopReason === 'cancelled') throw new AgentRunError(describeGrokCancel(updates.lastFailure, o.permission));

      const u = result?._meta?.usage ?? {};
      return {
        sessionId,
        costUsd: typeof u.costUsdTicks === 'number' ? u.costUsdTicks / TICKS_PER_USD : undefined,
        inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : undefined,
        outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : undefined,
      };
    } catch (err) {
      if (userAborted) throw new AgentRunError(t().stopped, true);
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
