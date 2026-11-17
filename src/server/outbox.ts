import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { OutboxItem, OutboxPreview, OutboxStatus } from '../shared/types';
import { nul, type Database } from './db';
import { HttpError } from './errors';
import type { GatewayTool } from './gateway';
import { t } from './i18n';

/*
 * The outbox: what agents asked Harness Relay's tools to send to other people (a `send` call: a mail,
 * an invitation). Nothing in it goes out until the user clicks Send on its card; the server then sends
 * it with the credentials it holds (`GatewayTool.send`). Items are kept in the database (`outbox`), so
 * one put there by a run nobody watched waits for the user, also across a restart, and each is sent
 * at most once: an equal call while one waits returns that one, and only a waiting item can be sent.
 */

interface OutboxRow {
  id: string;
  conversation_id: string;
  message_id: string;
  agent_id: string;
  agent_name: string;
  tool: string;
  args: string;
  title: string;
  preview: string;
  status: OutboxStatus;
  result: string | null;
  created_at: number;
  decided_at: number | null;
}

function toItem(r: OutboxRow): OutboxItem {
  let preview: OutboxPreview = { fields: [] };
  try {
    const p = JSON.parse(r.preview) as OutboxPreview;
    if (p && Array.isArray(p.fields)) preview = p;
  } catch {
    /* shown without its fields */
  }
  return {
    id: r.id,
    convId: r.conversation_id,
    messageId: r.message_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    tool: r.tool,
    title: r.title,
    preview,
    status: r.status,
    ...(r.result !== null ? { result: r.result } : {}),
    createdAt: r.created_at,
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
  };
}

export class Outbox {
  /** Waiting items by conversation, for the sidebar's "needs you" without a query per conversation. */
  private readonly pending = new Map<string, number>();
  /** Items a stop of the server cut off while they were being sent: their cards are brought up to date at startup. */
  readonly interrupted: OutboxItem[];

  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {
    // Sent while the server stopped: whether it went out is not known, so it is not sent again.
    const cut = (this.db.prepare("SELECT id FROM outbox WHERE status = 'sending'").all() as { id: string }[]).map((r) => r.id);
    this.db
      .prepare("UPDATE outbox SET status = 'failed', result = ?, decided_at = ? WHERE status = 'sending'")
      .run(t().outboxInterrupted, this.now());
    this.interrupted = cut.map((id) => this.get(id)!).filter(Boolean);
    for (const r of this.db.prepare("SELECT conversation_id, COUNT(*) AS n FROM outbox WHERE status = 'pending' GROUP BY conversation_id").all() as {
      conversation_id: string;
      n: number;
    }[]) {
      this.pending.set(r.conversation_id, r.n);
    }
  }

  /** How many items wait for the user in a conversation. */
  waiting(convId: string): number {
    return this.pending.get(convId) ?? 0;
  }

  get(id: string): OutboxItem | undefined {
    const r = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined;
    return r && toItem(r);
  }

  list(convId: string): OutboxItem[] {
    return (this.db.prepare('SELECT * FROM outbox WHERE conversation_id = ? ORDER BY created_at').all(convId) as unknown as OutboxRow[]).map(toItem);
  }

  /**
   * Put a call in the outbox, unless an equal one (the same tool and arguments, from the same
   * conversation) is still waiting: that one is returned (`existing`), so a run tried again does not
   * ask twice.
   */
  add(item: Pick<OutboxItem, 'convId' | 'messageId' | 'agentId' | 'agentName' | 'tool' | 'title' | 'preview'>, args: Record<string, unknown>): { item: OutboxItem; existing: boolean } {
    const same = (this.db.prepare("SELECT * FROM outbox WHERE conversation_id = ? AND tool = ? AND status = 'pending'").all(item.convId, item.tool) as unknown as OutboxRow[]).find(
      (r) => {
        try {
          return isDeepStrictEqual(JSON.parse(r.args), args);
        } catch {
          return false;
        }
      },
    );
    if (same) return { item: toItem(same), existing: true };
    const full: OutboxItem = { ...item, id: randomUUID(), status: 'pending', createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO outbox (id, conversation_id, message_id, agent_id, agent_name, tool, args, title, preview, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(full.id, full.convId, full.messageId, full.agentId, full.agentName, full.tool, JSON.stringify(args), full.title, JSON.stringify(full.preview), full.createdAt);
    this.pending.set(item.convId, this.waiting(item.convId) + 1);
    return { item: full, existing: false };
  }

  /**
   * The user's answer to a waiting item: `discard` drops it; `send` runs the tool's `send` with the
   * arguments the agent gave, once (the item is `sending` meanwhile, so a second click is refused),
   * and keeps what happened. Returns the item as it ends.
   */
  async answer(convId: string, id: string, action: 'send' | 'discard', tool: (name: string) => GatewayTool | undefined): Promise<OutboxItem> {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ? AND conversation_id = ?').get(id, convId) as OutboxRow | undefined;
    if (!row) throw new HttpError(404, t().outboxNotFound);
    if (row.status !== 'pending') throw new HttpError(409, t().outboxDecided);
    this.pending.set(convId, Math.max(0, this.waiting(convId) - 1));
    if (action === 'discard') return this.finish(id, 'discarded');
    const sender = tool(row.tool)?.send;
    if (!sender) return this.finish(id, 'failed', t().outboxNoTool(row.tool));
    this.db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(id);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(row.args) as Record<string, unknown>;
    } catch {
      return this.finish(id, 'failed', t().outboxNoTool(row.tool));
    }
    try {
      return this.finish(id, 'sent', await sender(args, { ...toItem(row), status: 'sending' }));
    } catch (err) {
      return this.finish(id, 'failed', (err as Error).message);
    }
  }

  private finish(id: string, status: OutboxStatus, result?: string): OutboxItem {
    this.db.prepare('UPDATE outbox SET status = ?, result = ?, decided_at = ? WHERE id = ?').run(status, nul(result), this.now(), id);
    return this.get(id)!;
  }

  /**
   * The replies that asked for these items were taken back (Retry, an edited message): what still
   * waits is discarded, so no item waits without a card, and the reply that comes again asks anew.
   */
  discardFor(convId: string, messageIds: readonly string[]): void {
    if (!messageIds.length) return;
    const ids = new Set(messageIds);
    for (const item of this.list(convId)) {
      if (item.status !== 'pending' || !ids.has(item.messageId)) continue;
      this.finish(item.id, 'discarded', t().outboxTakenBack);
      this.pending.set(convId, Math.max(0, this.waiting(convId) - 1));
    }
  }

  /** A conversation was deleted: its items went with it (`ON DELETE CASCADE`). */
  forget(convId: string): void {
    this.pending.delete(convId);
  }
}
