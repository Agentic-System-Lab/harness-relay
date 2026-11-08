import type { ChildProcess } from 'node:child_process';
import type { Permission, PlanEntry } from '../../shared/types';
import { unwrapShell } from '../commands';
import { t } from '../i18n';
import { runProcess, tail } from '../process';
import { JsonRpcConnection, RpcError } from './acp';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunResult,
} from './types';

/*
 * Codex runs as `codex app-server` (JSON-RPC over stdio, the protocol of Codex's IDE extensions)
 * rather than `codex exec`, so that it can ask the user for approvals and stream its reasoning,
 * plan and command output.
 *
 * Commands always run in Codex's OS sandbox for the permission (read-only / workspace-write).
 * When the conversation asks the user, the approval policy is "on-request": Codex asks before
 * anything the sandbox does not allow (writing outside the working directory, network…), and
 * the request goes to the user. Otherwise the policy is "never" and such actions just fail.
 */

const SANDBOX: Record<Permission, string> = {
  'read-only': 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access',
};

/**
 * Config overrides for a thread. Edit mode keeps the sandbox off the network even when the user's
 * ~/.codex/config.toml turns `sandbox_workspace_write.network_access` on: pushing and publishing
 * (anything that leaves the machine) must go through an approval.
 */
export function codexConfig(permission: Permission, effort?: string, mcpServers: McpServerSpec[] = []): Record<string, unknown> {
  return {
    ...(effort ? { model_reasoning_effort: effort } : {}),
    ...(permission === 'edit' ? { sandbox_workspace_write: { network_access: false } } : {}),
    ...codexMcpConfig(mcpServers, permission === 'full'),
  };
}

/**
 * The tool library's MCP servers as config overrides. One dotted key per server
 * (`mcp_servers.<name>`), so the servers in the user's config.toml stay.
 *
 * Codex asks before every MCP tool call, and with the approval policy "never" (full access, or a
 * conversation that refuses automatically) it refuses the call instead. In full access the
 * library's servers therefore approve their own tools (`default_tools_approval_mode`), as full
 * access promises: everything, without asking.
 */
export function codexMcpConfig(servers: McpServerSpec[], approveTools = false): Record<string, unknown> {
  const has = (vars: Record<string, string>) => Object.keys(vars).length > 0;
  return Object.fromEntries(
    servers.map((s) => [
      `mcp_servers.${s.name}`,
      {
        ...(s.transport === 'http'
          ? { url: s.url, ...(has(s.headers) ? { http_headers: s.headers } : {}) }
          : { command: s.command, args: s.args, ...(has(s.env) ? { env: s.env } : {}) }),
        ...(approveTools ? { default_tools_approval_mode: 'approve' } : {}),
      },
    ]),
  );
}

const PLAN_STATUS: Record<string, PlanEntry['status']> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/** A tool row for a Codex thread item, or null for items that are not tool calls. */
export function describeCodexItem(item: Record<string, any>): { name: string; detail?: string } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Shell', detail: clip(unwrapShell(String(item.command ?? ''))) };
    case 'fileChange': {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      return { name: 'Edit', detail: clip(changes.map((c) => `${c.kind?.type ?? 'update'} ${c.path}`).join(', ')) || undefined };
    }
    case 'mcpToolCall':
      return { name: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`, detail: summarizeInput(item.arguments) };
    case 'dynamicToolCall':
      return { name: String(item.tool ?? 'tool'), detail: summarizeInput(item.arguments) };
    case 'webSearch':
      return { name: 'WebSearch', detail: item.query ? clip(String(item.query)) : undefined };
    default:
      return null;
  }
}

/** How a finished tool item went: ok, plus output or a failure reason. */
function itemOutcome(item: Record<string, any>): { ok: boolean; output?: string; error?: string } {
  switch (item.type) {
    case 'commandExecution': {
      const output = item.aggregatedOutput ? tailText(String(item.aggregatedOutput)) : undefined;
      if (item.status === 'declined') return { ok: false, error: t().approvalDeclined };
      const ok = item.status === 'completed' && (item.exitCode === null || item.exitCode === undefined || item.exitCode === 0);
      return ok ? { ok, output } : { ok, output, error: item.exitCode != null ? `exit ${item.exitCode}` : undefined };
    }
    case 'fileChange':
      return item.status === 'declined'
        ? { ok: false, error: t().approvalDeclined }
        : { ok: item.status === 'completed' || item.status === undefined };
    case 'mcpToolCall': {
      if (item.error) return { ok: false, error: clip(String(item.error.message ?? item.error), 240) };
      const content = Array.isArray(item.result?.content) ? item.result.content : [];
      const text = content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim();
      return { ok: item.status !== 'failed', output: text ? tailText(text) : undefined };
    }
    default:
      return { ok: item.status !== 'failed' };
  }
}

/** Turns app-server notifications for one thread into AgentEvents. */
export function createCodexUpdateHandler(emit: (e: AgentEvent) => void) {
  const started = new Set<string>();
  const streamedText = new Set<string>();
  const streamedThinking = new Set<string>();
  /** File paths of file-change items, to show what an approval request is about. */
  const filePaths = new Map<string, string>();
  let usage = { input: 0, output: 0, seen: false };

  const startTool = (item: Record<string, any>) => {
    const d = describeCodexItem(item);
    if (!d || !item.id || started.has(item.id)) return;
    started.add(item.id);
    if (item.type === 'fileChange') filePaths.set(item.id, (item.changes ?? []).map((c: any) => c.path).join(', '));
    emit({ type: 'tool_start', id: item.id, ...d });
  };

  function handle(method: string, p: Record<string, any>): void {
    switch (method) {
      case 'item/agentMessage/delta':
        if (p.delta) {
          streamedText.add(p.itemId);
          emit({ type: 'text', text: String(p.delta) });
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (p.delta) {
          streamedThinking.add(p.itemId);
          emit({ type: 'thinking', text: String(p.delta) });
        }
        break;
      case 'item/reasoning/summaryPartAdded':
        if (streamedThinking.has(p.itemId)) emit({ type: 'thinking', text: '\n\n' });
        break;
      case 'item/started':
        startTool(p.item ?? {});
        break;
      case 'item/completed': {
        const item = p.item ?? {};
        if (item.type === 'agentMessage') {
          if (!streamedText.has(item.id) && item.text) emit({ type: 'text', text: String(item.text) });
          emit({ type: 'text_end' });
          break;
        }
        if (item.type === 'reasoning') {
          const summary = (Array.isArray(item.summary) ? item.summary : []).join('\n\n').trim();
          if (!streamedThinking.has(item.id) && summary) emit({ type: 'thinking', text: summary });
          break;
        }
        if (!describeCodexItem(item)) break;
        startTool(item);
        const { ok, output, error } = itemOutcome(item);
        emit({ type: 'tool_end', id: item.id, ok, ...(output ? { output } : {}), ...(error ? { error } : {}) });
        break;
      }
      case 'turn/plan/updated': {
        const plan: any[] = Array.isArray(p.plan) ? p.plan : [];
        emit({ type: 'plan', entries: plan.map((s) => ({ text: String(s.step ?? ''), status: PLAN_STATUS[s.status] ?? 'pending' })) });
        break;
      }
      case 'thread/tokenUsage/updated': {
        // One update per model call; `last` is that call's usage.
        const last = p.tokenUsage?.last;
        if (last) {
          usage = {
            input: usage.input + (last.inputTokens ?? 0),
            output: usage.output + (last.outputTokens ?? 0) + (last.reasoningOutputTokens ?? 0),
            seen: true,
          };
        }
        break;
      }
    }
  }

  return {
    handle,
    filePaths(itemId: string): string | undefined {
      return filePaths.get(itemId);
    },
    get usage() {
      return usage.seen ? { inputTokens: usage.input, outputTokens: usage.output } : {};
    },
  };
}

/** What to show the user for an app-server approval request. */
export function codexApprovalRequest(
  method: string,
  p: Record<string, any>,
  filePaths: (itemId: string) => string | undefined,
): ApprovalRequest | null {
  const reason = p.reason ? String(p.reason) : undefined;
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { kind: 'command', detail: unwrapShell(String(p.command ?? '')), command: String(p.command ?? ''), reason };
    case 'item/fileChange/requestApproval':
      return { kind: 'edit', detail: p.grantRoot ? String(p.grantRoot) : filePaths(String(p.itemId)), reason };
    case 'item/permissions/requestApproval':
      return { kind: 'other', tool: 'permissions', detail: clip(JSON.stringify(p.permissions ?? {})), reason };
    case 'execCommandApproval':
      const command = Array.isArray(p.command) ? p.command.join(' ') : String(p.command ?? '');
      return { kind: 'command', detail: unwrapShell(command), command, reason };
    case 'applyPatchApproval':
      return { kind: 'edit', detail: Object.keys(p.fileChanges ?? {}).join(', ') || undefined, reason };
    default:
      return null;
  }
}

/**
 * Codex asks before an MCP tool runs with an MCP elicitation marked as a tool-call approval
 * (`_meta.codex_approval_kind: "mcp_tool_call"`, Codex 0.167): what to show the user for it. Null
 * for any other elicitation (a form an MCP server wants filled in), which is declined.
 */
export function codexMcpToolApproval(p: Record<string, any>): ApprovalRequest | null {
  const meta = p?._meta;
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || typeof meta.tool_name !== 'string') return null;
  const params = meta.tool_params && typeof meta.tool_params === 'object' && Object.keys(meta.tool_params).length ? meta.tool_params : undefined;
  return {
    kind: 'other',
    tool: p.serverName ? `${p.serverName}:${meta.tool_name}` : meta.tool_name,
    ...(params ? { detail: clip(JSON.stringify(params)) } : {}),
  };
}

/** The reply to an MCP elicitation: an accepted tool-call approval has no form, so no content. */
export function codexElicitationResponse(accept: boolean): unknown {
  return accept ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null };
}

/** The reply Codex expects for an approval request, allowed or not. */
export function codexApprovalResponse(method: string, p: Record<string, any>, allow: boolean, note?: string): unknown {
  switch (method) {
    case 'item/permissions/requestApproval':
      return allow
        ? { permissions: { network: p.permissions?.network ?? undefined, fileSystem: p.permissions?.fileSystem ?? undefined }, scope: 'turn' }
        : { permissions: {}, scope: 'turn' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? 'approved' : { denied: { rejection: note || 'The user declined this.' } } };
    default:
      return { decision: allow ? 'accept' : 'decline' };
  }
}

export const codexRunner: AgentRunner = {
  provider: 'codex',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    const ask = Boolean(o.requestApproval) && o.permission !== 'full';
    const args = ['app-server', '-c', 'model_reasoning_summary="auto"'];

    let child: ChildProcess | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let userAborted = false;
    let failure: string | undefined;
    const stop = new AbortController();
    const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

    const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'), { versionField: false });
    const updates = createCodexUpdateHandler(o.onEvent);
    let resolveTurn: (turn: Record<string, any>) => void = () => {};
    const turnDone = new Promise<Record<string, any>>((r) => (resolveTurn = r));

    conn.onNotification = (method, params) => {
      if (method === 'error' && params?.error?.message) failure = String(params.error.message);
      if (!threadId || params?.threadId !== threadId) return; // other threads (sub-agents) and startup noise
      if (method === 'turn/completed') resolveTurn(params.turn ?? {});
      else updates.handle(method, params);
    };
    conn.onRequest = async (method, params) => {
      if (method === 'item/tool/requestUserInput') return { answers: {} };
      if (method === 'mcpServer/elicitation/request') {
        const tool = codexMcpToolApproval(params ?? {});
        if (!tool || !o.requestApproval) return codexElicitationResponse(false);
        return codexElicitationResponse((await o.requestApproval(tool)).allow);
      }
      const req = codexApprovalRequest(method, params ?? {}, (id) => updates.filePaths(id));
      if (!req) throw new RpcError(-32601, `${method} is not supported`);
      const answer = o.requestApproval ? await o.requestApproval(req) : { allow: false };
      return codexApprovalResponse(method, params ?? {}, answer.allow, answer.note);
    };

    const onAbort = () => {
      userAborted = true;
      if (threadId && turnId) void conn.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      stopSoon(2000);
    };
    o.signal.addEventListener('abort', onAbort, { once: true });

    const exited = runProcess({
      bin: o.bin,
      args,
      cwd: o.cwd,
      env: o.env,
      signal: stop.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      keepStdinOpen: true,
      onSpawn: (c) => (child = c),
      onLine: conn.handleLine,
    }).then(
      (res) => {
        const why = res.timedOut ? t().timedOut : tail(res.stderr) || t().exitedWithoutTurn('codex', res.code);
        conn.close(new AgentRunError(why));
        resolveTurn({ status: 'failed', error: { message: why } });
        return res;
      },
      (err: Error) => {
        conn.close(err);
        resolveTurn({ status: 'failed', error: { message: err.message } });
        throw err;
      },
    );
    exited.catch(() => undefined); // surfaced through the requests and the turn instead

    try {
      await conn.request('initialize', {
        clientInfo: { name: 'harness_relay', title: 'Harness Relay', version: '0.1.0' },
        capabilities: null,
      });
      conn.notify('initialized');
      const threadParams = {
        cwd: o.cwd,
        approvalPolicy: ask ? 'on-request' : 'never',
        sandbox: SANDBOX[o.permission],
        developerInstructions: o.systemPrompt,
        ...(o.model ? { model: o.model } : {}),
        config: codexConfig(o.permission, o.effort, o.mcpServers),
      };
      const thread = o.sessionId
        ? await conn.request('thread/resume', { threadId: o.sessionId, ...threadParams })
        : await conn.request('thread/start', threadParams);
      threadId = String(thread?.thread?.id ?? o.sessionId ?? '');
      if (!threadId) throw new AgentRunError(t().exitedWithoutTurn('codex', null));
      o.onEvent({ type: 'session', sessionId: threadId });
      if (userAborted) throw new AgentRunError(t().stopped, true);

      const started = await conn.request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: o.prompt, text_elements: [] },
          ...(o.images ?? []).map((img) => ({ type: 'localImage', path: img.path })),
        ],
      });
      turnId = started?.turn?.id;
      const turn = await turnDone;

      if (userAborted) throw new AgentRunError(t().stopped, true);
      if (turn.status === 'failed' || turn.status === 'interrupted') {
        const err = turn.error ?? {};
        const message = [err.message, err.additionalDetails].filter(Boolean).join('\n') || failure;
        throw new AgentRunError(message || t().exitedWithoutTurn('codex', null));
      }
      return { sessionId: threadId, ...updates.usage };
    } catch (err) {
      if (userAborted) throw new AgentRunError(t().stopped, true);
      if (err instanceof AgentRunError) throw err;
      throw new AgentRunError(err instanceof Error ? err.message : String(err));
    } finally {
      o.signal.removeEventListener('abort', onAbort);
      child?.stdin?.end();
      stopSoon(3000);
      await exited.catch(() => undefined);
    }
  },
};
