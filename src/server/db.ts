import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

export type Database = DatabaseSyncType;

// node:sqlite is stable enough for us but still prints an ExperimentalWarning on load (Node 22).
// Load it with that one warning filtered instead of passing a global --no-warnings flag.
const { DatabaseSync } = (() => {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
})();

/** Each entry upgrades the schema by one version (tracked in PRAGMA user_version). */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE provider_settings (
    provider       TEXT PRIMARY KEY,
    bin            TEXT NOT NULL DEFAULT '',
    api_key        TEXT NOT NULL DEFAULT '',
    default_model  TEXT NOT NULL DEFAULT '',
    default_effort TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    mode       TEXT NOT NULL,
    rounds     INTEGER NOT NULL,
    max_hops   INTEGER NOT NULL,
    permission TEXT NOT NULL,
    cwd        TEXT NOT NULL
  );

  CREATE TABLE conversation_agents (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL,
    position        INTEGER NOT NULL,
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL,
    role            TEXT NOT NULL,
    model           TEXT,
    effort          TEXT,
    PRIMARY KEY (conversation_id, agent_id)
  );

  -- Per-agent CLI session (survives team edits, so not tied to conversation_agents).
  CREATE TABLE agent_sessions (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL,
    provider        TEXT,
    session_id      TEXT,
    PRIMARY KEY (conversation_id, agent_id)
  );

  -- Which chat messages each agent has already been shown.
  CREATE TABLE agent_seen (
    conversation_id TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    PRIMARY KEY (conversation_id, agent_id, message_id),
    FOREIGN KEY (conversation_id, agent_id)
      REFERENCES agent_sessions(conversation_id, agent_id) ON DELETE CASCADE
  );

  CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    author_kind     TEXT NOT NULL,
    agent_id        TEXT,
    agent_name      TEXT,
    provider        TEXT,
    created_at      INTEGER NOT NULL,
    status          TEXT NOT NULL,
    passed          INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    round           INTEGER,
    duration_ms     INTEGER,
    cost_usd        REAL,
    input_tokens    INTEGER,
    output_tokens   INTEGER
  );
  CREATE INDEX messages_by_conversation ON messages(conversation_id, seq);

  CREATE TABLE message_parts (
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    type        TEXT NOT NULL,
    text        TEXT,
    tool_id     TEXT,
    tool_name   TEXT,
    tool_detail TEXT,
    tool_status TEXT,
    PRIMARY KEY (message_id, idx)
  );

  CREATE TABLE presets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    mode        TEXT NOT NULL,
    rounds      INTEGER NOT NULL,
    max_hops    INTEGER NOT NULL,
    permission  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE preset_agents (
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    agent_id  TEXT NOT NULL,
    name      TEXT NOT NULL,
    provider  TEXT NOT NULL,
    role      TEXT NOT NULL,
    model     TEXT,
    effort    TEXT,
    PRIMARY KEY (preset_id, position)
  );
  `,
  // 2: change tracking per turn and per-agent git worktrees for parallel mode.
  `
  ALTER TABLE messages ADD COLUMN change_root TEXT;
  ALTER TABLE messages ADD COLUMN change_base TEXT;
  ALTER TABLE messages ADD COLUMN change_head TEXT;
  ALTER TABLE messages ADD COLUMN change_isolated INTEGER;
  ALTER TABLE messages ADD COLUMN change_branch TEXT;

  CREATE TABLE message_changes (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    path       TEXT NOT NULL,
    status     TEXT NOT NULL,
    added      INTEGER,
    deleted    INTEGER,
    PRIMARY KEY (message_id, idx)
  );

  CREATE TABLE agent_worktrees (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL,
    repo_root       TEXT NOT NULL,
    path            TEXT NOT NULL,
    branch          TEXT NOT NULL,
    base_commit     TEXT NOT NULL,
    needs_reset     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, agent_id)
  );
  `,
  // 3: why a tool call failed or was refused.
  `
  ALTER TABLE message_parts ADD COLUMN tool_error TEXT;
  `,
  // 4: auto-team conversations (the lead agent designs the team) and its team design messages.
  `
  ALTER TABLE conversations ADD COLUMN auto_team INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN plan TEXT;
  `,
  // 5: approvals asked in the chat, agents' thinking / plans, and tool output.
  `
  ALTER TABLE conversations ADD COLUMN approvals TEXT;
  ALTER TABLE conversations ADD COLUMN allow_rules TEXT;
  ALTER TABLE message_parts ADD COLUMN tool_output TEXT;
  ALTER TABLE message_parts ADD COLUMN data TEXT;
  `,
];

function migrate(db: Database): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Open (or create) the database. The file holds API keys, so it is readable by the owner only. */
export function openDatabase(file: string): Database {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600); // SQLite gives the -wal / -shm files the same mode
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** node:sqlite cannot bind `undefined`. */
export function nul<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}
