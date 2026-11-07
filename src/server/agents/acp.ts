import { parseJsonLine } from './types';

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
