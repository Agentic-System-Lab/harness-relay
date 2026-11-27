import type { ChildProcess } from 'node:child_process';
import { JsonRpcConnection, RpcError } from '../agents/acp';
import { runProcess, tail } from '../process';

/*
 * A client of an MCP server Harness Relay starts itself over stdio (`cua mcp`, the computer tools'
 * server, `session.ts`): JSON-RPC 2.0 over newline-delimited JSON, as the MCP spec's stdio transport has
 * it. It initializes, then calls tools, one answer per call, each within its own time limit.
 */

/** What a tool call returned: its text and its images, and whether the server called it an error. */
export interface McpToolResult {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

/** The MCP protocol revision asked for (Cua's server speaks 2025-06-18). */
export const MCP_PROTOCOL = '2025-06-18';

/** A tool result's content, as text and images (other kinds of content are left out). */
export function toolResult(result: unknown): McpToolResult {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const content = Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : [];
  const text = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  const images = content
    .filter((c) => c && c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string')
    .map((c) => ({ data: c.data as string, mimeType: c.mimeType as string }));
  return { text, images, isError: r.isError === true };
}

export interface StdioMcpOptions {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** How long it may take to start and answer `initialize`. */
  startMs?: number;
  /** Told once the server has exited (or could not start), with the end of what it wrote to stderr. */
  onExit?: (why: string) => void;
}

export class StdioMcp {
  private rpc: JsonRpcConnection;
  private child?: ChildProcess;
  private stop = new AbortController();
  private exited = false;
  /** The names of the tools it offers, once listed. */
  tools = new Set<string>();

  private constructor(private o: StdioMcpOptions) {
    this.rpc = new JsonRpcConnection((line) => {
      if (this.child?.stdin?.writable) this.child.stdin.write(line + '\n');
    });
  }

  /** Starts the server and initializes it; rejects when it exits first or does not answer in time. */
  static async start(o: StdioMcpOptions): Promise<StdioMcp> {
    const mcp = new StdioMcp(o);
    await mcp.open();
    return mcp;
  }

  private async open(): Promise<void> {
    let stderr = '';
    const ended = runProcess({
      bin: this.o.bin,
      args: this.o.args,
      env: this.o.env,
      cwd: this.o.cwd,
      keepStdinOpen: true,
      signal: this.stop.signal,
      maxCapture: 1024,
      maxStderrCapture: 16 * 1024,
      onSpawn: (child) => {
        this.child = child;
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-8192);
        });
      },
      onLine: (line) => this.rpc.handleLine(line),
    }).then(
      (r) => tail(r.stderr || stderr, 600).trim() || `exited with code ${r.code ?? 'none'}`,
      (err: Error) => err.message,
    );
    void ended.then((why) => {
      this.exited = true;
      this.rpc.close(new Error(why));
      this.o.onExit?.(why);
    });
    const timer = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('the MCP server did not start in time')), this.o.startMs ?? 60_000);
      t.unref?.();
      void ended.finally(() => clearTimeout(t));
    });
    try {
      await Promise.race([
        (async () => {
          await this.rpc.request('initialize', {
            protocolVersion: MCP_PROTOCOL,
            capabilities: {},
            clientInfo: { name: 'harness-relay', version: '1' },
          });
          this.rpc.notify('notifications/initialized');
          const listed = await this.rpc.request<{ tools?: { name?: unknown }[] }>('tools/list', {});
          for (const tool of listed?.tools ?? []) if (typeof tool.name === 'string') this.tools.add(tool.name);
        })(),
        timer,
      ]);
    } catch (err) {
      this.close();
      throw err;
    }
  }

  get alive(): boolean {
    return !this.exited && !this.stop.signal.aborted;
  }

  /** Calls tool `name`; rejects when the server ends, the time runs out or `signal` aborts. */
  async call(name: string, args: Record<string, unknown>, o: { timeoutMs: number; signal?: AbortSignal }): Promise<McpToolResult> {
    o.signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.rpc.request('tools/call', { name, arguments: args }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name} did not answer within ${Math.round(o.timeoutMs / 1000)} seconds`)),
            o.timeoutMs,
          );
          onAbort = () => reject(o.signal?.reason instanceof Error ? o.signal.reason : new Error('stopped'));
          o.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return toolResult(result);
    } catch (err) {
      if (err instanceof RpcError) return { text: err.message, images: [], isError: true };
      throw err;
    } finally {
      clearTimeout(timer);
      if (onAbort) o.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Stops the server (its process and what it started are killed). */
  close(): void {
    this.rpc.close(new Error('closed'));
    this.stop.abort();
  }
}
