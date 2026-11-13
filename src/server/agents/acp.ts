import { imageData, parseJsonLine, type McpServerSpec, type RunOptions } from './types';

/** A JSON-RPC error, either received from the peer or thrown by one of our request handlers. */
export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(data === undefined || data === null ? message : `${message}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
}

/**
 * Minimal JSON-RPC 2.0 peer over newline-delimited JSON, as spoken by ACP agents on stdio.
 * Both sides send requests: we call `initialize` / `session/*`, the agent calls us back
 * (e.g. `session/request_permission`) and streams `session/update` notifications.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closedWith: Error | undefined;

  onNotification?: (method: string, params: any) => void;
  /** Answers a request from the peer; throw an RpcError to reply with an error. */
  onRequest?: (method: string, params: any) => unknown | Promise<unknown>;

  /** `versionField: false` leaves out `"jsonrpc": "2.0"` (Codex's app-server protocol omits it). */
  constructor(
    private write: (line: string) => void,
    private opts: { versionField?: boolean } = {},
  ) {}

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Feed one line of the peer's output. */
  readonly handleLine = (line: string): void => {
    const msg = parseJsonLine(line);
    if (!msg) return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') {
      if (!hasId) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code ?? -32603, msg.error.message ?? 'JSON-RPC error', msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (!hasId) {
      this.onNotification?.(msg.method, msg.params);
      return;
    }
    const { id, method, params } = msg;
    Promise.resolve()
      .then(() => {
        if (!this.onRequest) throw new RpcError(-32601, `${method} is not supported`);
        return this.onRequest(method, params);
      })
      .then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
        (err: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) },
          }),
      );
  };

  /** The peer is gone: fail every outstanding and future request with `err`. */
  close(err: Error): void {
    if (this.closedWith) return;
    this.closedWith = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.closedWith) return;
    if (this.opts.versionField === false) delete msg.jsonrpc;
    this.write(JSON.stringify(msg));
  }
}

/** ACP prompt blocks: the text, plus attached images (for an agent that advertises `promptCapabilities.image`). */
export function acpPrompt(prompt: string, images: RunOptions['images']): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: prompt }];
  for (const img of images ?? []) {
    const data = imageData(img.path);
    if (data) blocks.push({ type: 'image', data, mimeType: img.mimeType });
  }
  return blocks;
}

/**
 * The tool library's MCP servers in ACP's form (`env` and `headers` as name/value lists). HTTP servers
 * only go to an agent that says it takes them (`mcpCapabilities.http`); ACP forbids them otherwise.
 */
export function acpMcpServers(servers: McpServerSpec[], http = true, cli = 'acp'): Record<string, unknown>[] {
  const list = (vars: Record<string, string>) => Object.entries(vars).map(([name, value]) => ({ name, value }));
  const skipped = http ? [] : servers.filter((s) => s.transport === 'http');
  if (skipped.length) console.warn(`[${cli}] this ${cli} does not take HTTP MCP servers; left out: ${skipped.map((s) => s.name).join(', ')}`);
  return servers.filter((s) => http || s.transport !== 'http').map((s) =>
    s.transport === 'http'
      ? { type: 'http', name: s.name, url: s.url, headers: list(s.headers) }
      : { name: s.name, command: s.command, args: s.args, env: list(s.env) },
  );
}

/** A decision on a `session/request_permission`: `reason` goes back to the model when it is refused. */
export type AcpDecision = { allow: true } | { allow: false; reason: string };

/**
 * Builds the reply to `session/request_permission`: the agent's allow-once (or allow-always) option, or
 * its reject-once (or reject-always) one with the reason as `_meta.followup_message` (which Grok passes
 * to the model as feedback instead of ending the turn); cancelled when it offers no such option.
 */
export function answerPermission(decision: AcpDecision, options: { optionId: string; kind: string }[]) {
  const pick = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
  if (decision.allow) {
    const optionId = pick('allow_once') ?? pick('allow_always');
    if (optionId) return { outcome: { outcome: 'selected', optionId } };
  } else {
    const optionId = pick('reject_once') ?? pick('reject_always');
    if (optionId) return { outcome: { outcome: 'selected', optionId }, _meta: { followup_message: decision.reason } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/** Text of an ACP tool-call `content` array (e.g. the reason a call failed). */
export function acpContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (typeof c?.content?.text === 'string' ? c.content.text : typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || undefined;
}

/**
 * The tokens of an ACP prompt answer's `usage` (`inputTokens`, `outputTokens`, and maybe
 * `totalTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`), counted as Harness
 * Relay shows them: the input with the cached tokens read and written, the output with the reasoning.
 * ACP does not say whether a CLI counts those in its input and output or beside them; its total says
 * it: what the total has beyond input and output is what was counted beside them, and is added back
 * when it is exactly the cached tokens, the reasoning, or both. Otherwise the numbers are taken as
 * they are.
 */
export function acpTokens(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  const total = num(u.totalTokens);
  if (input === undefined || output === undefined || total === undefined) return { inputTokens: input, outputTokens: output };
  const cached = (num(u.cachedReadTokens) ?? 0) + (num(u.cachedWriteTokens) ?? 0);
  const thought = num(u.thoughtTokens) ?? 0;
  const beside = total - input - output;
  if (beside > 0 && beside === cached + thought) return { inputTokens: input + cached, outputTokens: output + thought };
  if (beside > 0 && beside === cached) return { inputTokens: input + cached, outputTokens: output };
  if (beside > 0 && beside === thought) return { inputTokens: input, outputTokens: output + thought };
  return { inputTokens: input, outputTokens: output };
}
