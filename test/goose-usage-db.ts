import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteFile } from '../src/server/db';

/*
 * Goose's sessions database as Goose 1.58.1 keeps its usage (schema version 17,
 * `crates/goose/src/session/session_manager.rs`): a session's running totals in its `sessions` row
 * (`accumulated_*`), one `usage_ledger` row per model call, and a subagent's session started from its
 * parent's (`parent_session_id`). For the tests of the Goose adapter's per-turn usage.
 */

/** The two tables, as Goose creates them (the `messages` table and the indexes left out). */
export const GOOSE_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    user_set_name BOOLEAN DEFAULT FALSE,
    session_type TEXT NOT NULL DEFAULT 'user',
    working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    extension_data TEXT DEFAULT '{}',
    total_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    accumulated_total_tokens INTEGER,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER,
    accumulated_cache_read_tokens INTEGER,
    accumulated_cache_write_tokens INTEGER,
    accumulated_cost REAL,
    schedule_id TEXT,
    recipe_json TEXT,
    user_recipe_values_json TEXT,
    provider_name TEXT,
    model_config_json TEXT,
    goose_mode TEXT NOT NULL DEFAULT 'auto',
    archived_at TIMESTAMP,
    project_id TEXT,
    parent_session_id TEXT,
    system_prompt_override TEXT,
    system_prompt_extras_json TEXT,
    container_id TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_timestamp INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost REAL,
    cost_source TEXT,
    is_compaction INTEGER DEFAULT 0
  );`;

/** One model call's usage; `cost` left out for a model without a price. */
export interface GooseCall {
  input: number;
  output: number;
  total?: number;
  cost?: number;
  compaction?: boolean;
}

/**
 * Records model calls in a session as Goose does (`record_usage_metrics`): the session's row is made
 * when it is not there (a subagent's with its parent), its running totals grow, a ledger row is added.
 * `ledgerOnly` adds the ledger row alone (a running total that lost the update).
 */
export function gooseCalls(file: string, sessionId: string, calls: GooseCall[], opts: { parent?: string; ledgerOnly?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = openSqliteFile(file);
  try {
    db.exec(GOOSE_USAGE_SCHEMA);
    db.prepare('INSERT OR IGNORE INTO sessions (id, working_dir, parent_session_id) VALUES (?, ?, ?)').run(sessionId, '/p', opts.parent ?? null);
    for (const c of calls) {
      const total = c.total ?? c.input + c.output;
      const cost = c.cost ?? null;
      if (!opts.ledgerOnly) {
        db.prepare(
          `UPDATE sessions SET
             accumulated_total_tokens = COALESCE(accumulated_total_tokens, 0) + ?,
             accumulated_input_tokens = COALESCE(accumulated_input_tokens, 0) + ?,
             accumulated_output_tokens = COALESCE(accumulated_output_tokens, 0) + ?,
             accumulated_cost = CASE WHEN ? IS NULL THEN accumulated_cost ELSE COALESCE(accumulated_cost, 0) + ? END
           WHERE id = ?`,
        ).run(total, c.input, c.output, cost, cost, sessionId);
      }
      db.prepare('INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cost, is_compaction) VALUES (?, 0, ?, ?, ?, ?, ?, ?)').run(
        sessionId,
        'm',
        c.input,
        c.output,
        total,
        cost,
        c.compaction ? 1 : 0,
      );
    }
  } finally {
    db.close();
  }
}
