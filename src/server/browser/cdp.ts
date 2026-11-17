import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/*
 * The Chrome DevTools Protocol over Chromium's debugging pipe (`--remote-debugging-pipe`): JSON
 * messages, each ended by a NUL byte, commands written to its fd 3 and answers and events read from
 * its fd 4. No port is opened, so no other program on this computer can drive the browser. Commands
 * for a page go with its `sessionId` (`Target.attachToTarget` with `flatten`).
 */

/** Splits what the pipe gives into messages: each ends with a NUL byte, and one may come in pieces. */
export class NulDecoder {
  private pending: Buffer[] = [];

  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = chunk.indexOf(0); i >= 0; i = chunk.indexOf(0, start)) {
      this.pending.push(chunk.subarray(start, i));
      out.push(Buffer.concat(this.pending).toString('utf8'));
      this.pending = [];
      start = i + 1;
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
    return out;
  }
}

/** A command's answer was an error, or the browser went away first. */
export class CdpError extends Error {}

interface Waiting {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  method: string;
}

/**
 * One connection to a browser. `send()` resolves with a command's result; events are emitted by their
 * method, with their params and session (`on('Page.loadEventFired', (params, sessionId) => …)`).
 */
export class CdpConnection extends EventEmitter {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private closed = false;

  constructor(
    private write: Writable,
    read: Readable,
    /** How long a command may take before it fails. */
    private timeoutMs = 30_000,
  ) {
    super();
    const decoder = new NulDecoder();
    read.on('data', (chunk: Buffer) => {
      for (const text of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) this.receive(text);
    });
    const gone = () => this.close(new CdpError('The browser closed'));
    read.on('close', gone);
    read.on('end', gone);
    read.on('error', gone);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private receive(text: string): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new CdpError(`${w.method}: ${msg.error.message ?? 'failed'}`));
      else w.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('The browser closed'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CdpError(`${method}: no answer in ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  /** Resolves with the next event of `method` (for `sessionId`, when given) that `match` accepts, or undefined after `timeoutMs`. */
  waitFor(method: string, timeoutMs: number, sessionId?: string, match: (params: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off(method, on);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      const on = (params: Record<string, unknown>, sid?: string) => {
        if (sessionId && sid !== sessionId) return;
        if (!match(params)) return;
        clearTimeout(timer);
        this.off(method, on);
        resolve(params);
      };
      this.on(method, on);
    });
  }

  close(err = new CdpError('The browser closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    this.emit('closed');
  }
}
