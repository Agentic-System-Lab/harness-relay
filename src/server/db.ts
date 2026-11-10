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
  // 6: messages sent while the team replies wait in a queue, and are marked once delivered.
  `
  ALTER TABLE conversations ADD COLUMN queue TEXT;
  ALTER TABLE messages ADD COLUMN queued INTEGER;
  `,
  // 7: an agent asked the user something: where the team stopped, and the question.
  `
  ALTER TABLE conversations ADD COLUMN pause TEXT;
  ALTER TABLE messages ADD COLUMN asked INTEGER;
  `,
  // 8: sidebar groups. A conversation in no group is in the default group, "Other"; deleting a group
  // moves its conversations there. group_source: who put it in its group ('user', or 'auto' when the
  // lead agent sorted it by its first message); a conversation is sorted automatically only once.
  `
  CREATE TABLE conversation_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE conversations ADD COLUMN group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL;
  ALTER TABLE conversations ADD COLUMN group_source TEXT;
  `,
  // 9: each agent's exceptions to the tool library's defaults (JSON: tool key -> on / off).
  `
  ALTER TABLE conversation_agents ADD COLUMN tools TEXT;
  ALTER TABLE preset_agents ADD COLUMN tools TEXT;
  `,
  // 10: what each CLI loads by itself that Harness Relay's runs leave out (comma-separated parts:
  // skills, mcp, instructions, memory).
  `
  ALTER TABLE provider_settings ADD COLUMN native_off TEXT NOT NULL DEFAULT '';
  `,
  // 11: single items of what each CLI loads by itself that Harness Relay's runs leave out (JSON:
  // kind -> ids, see NativeItemsOff).
  `
  ALTER TABLE provider_settings ADD COLUMN native_items TEXT NOT NULL DEFAULT '{}';
  `,
  // 12: schedules — a message a conversation's team is sent at set times (one per conversation;
  // repeat: JSON ScheduleRepeat) — and the user messages they sent.
  `
  CREATE TABLE schedules (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    repeat      TEXT NOT NULL,
    time_zone   TEXT NOT NULL,
    lang        TEXT NOT NULL,
    enabled     INTEGER NOT NULL,
    approvals   TEXT NOT NULL,
    missed      TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_result TEXT,
    last_error  TEXT
  );
  CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
  ALTER TABLE messages ADD COLUMN scheduled INTEGER;
  `,
  // 13: auto team for every question. auto_team no longer means "the team is still to be designed"
  // but "the lead agent designs the team for each new question", so every conversation gets it;
  // auto_confirm: the lead agent's team answers without waiting for the user to confirm it.
  `
  ALTER TABLE conversations ADD COLUMN auto_confirm INTEGER NOT NULL DEFAULT 0;
  UPDATE conversations SET auto_team = 1;
  `,
  // 14: a schedule may open a new conversation each time (new_chat), and remembers the last one it
  // opened (last_chat_id).
  `
  ALTER TABLE schedules ADD COLUMN new_chat INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE schedules ADD COLUMN last_chat_id TEXT;
  `,
  // 15: conversations shared as secret gists (id: the gist's), listed in Settings to remove. A share
  // outlives its conversation (the gist is still on GitHub), so it has no foreign key.
  `
  CREATE TABLE shares (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL,
    title            TEXT NOT NULL,
    up_to_message_id TEXT,
    up_to_agent      TEXT,
    url              TEXT NOT NULL,
    gist_url         TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  );
  `,
  // 16: a share may take along files its replies link to (files: how many), in a second secret gist
  // (files_gist: its id); a files gist left without its page, when neither the page nor deleting the
  // files went through (unfinished), is listed to be removed.
  `
  ALTER TABLE shares ADD COLUMN files INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE shares ADD COLUMN files_gist TEXT;
  ALTER TABLE shares ADD COLUMN unfinished INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE conversations ADD COLUMN branch TEXT;
  `,
  // 18: signed-in browsers and one-time sign-in codes (src/server/auth.ts). Only hashes: of each
  // session's cookie secret and header key, and of each code.
  `
  CREATE TABLE auth_sessions (
    id           TEXT PRIMARY KEY,
    cookie_hash  TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE TABLE auth_codes (
    hash       TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
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
  // secure_delete: overwrite deleted content (removed API keys, deleted chats) instead of leaving it in free pages.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
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
