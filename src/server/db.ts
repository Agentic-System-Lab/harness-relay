import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
  // 19: more than one account per CLI. provider_accounts: the accounts besides each CLI's default one
  // (each with a folder of its own for the CLI, and maybe an API key of its own; the key moves to the
  // system keyring like the default account's); account_label: the default account's name. Agents,
  // templates and agent sessions name their account (NULL = the default account); the lead agent's is
  // in its JSON setting.
  `
  CREATE TABLE provider_accounts (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    label      TEXT NOT NULL,
    api_key    TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE provider_settings ADD COLUMN account_label TEXT NOT NULL DEFAULT '';
  ALTER TABLE conversation_agents ADD COLUMN account TEXT;
  ALTER TABLE preset_agents ADD COLUMN account TEXT;
  ALTER TABLE agent_sessions ADD COLUMN account TEXT;
  `,
  // 20: each account has its own default model and effort, and its own choice of what Harness Relay's
  // runs leave out of what the CLI loads by itself (its home has its own skills, MCP servers, hooks and
  // memory). The default account's stay in provider_settings; the accounts there were get the CLI's
  // values, so they run as before.
  `
  ALTER TABLE provider_accounts ADD COLUMN default_model TEXT NOT NULL DEFAULT '';
  ALTER TABLE provider_accounts ADD COLUMN default_effort TEXT NOT NULL DEFAULT '';
  ALTER TABLE provider_accounts ADD COLUMN native_off TEXT NOT NULL DEFAULT '';
  ALTER TABLE provider_accounts ADD COLUMN native_items TEXT NOT NULL DEFAULT '{}';
  UPDATE provider_accounts SET
    default_model = COALESCE((SELECT s.default_model FROM provider_settings s WHERE s.provider = provider_accounts.provider), ''),
    default_effort = COALESCE((SELECT s.default_effort FROM provider_settings s WHERE s.provider = provider_accounts.provider), ''),
    native_off = COALESCE((SELECT s.native_off FROM provider_settings s WHERE s.provider = provider_accounts.provider), ''),
    native_items = COALESCE((SELECT s.native_items FROM provider_settings s WHERE s.provider = provider_accounts.provider), '{}');
  `,
  // 21: model backends for the open agents (src/server/backends.ts): the user's OpenAI-compatible
  // endpoints (id: the slug their models' ids start with), and an API backend's key (id: openai,
  // anthropic or xai) only while there is no credential store to keep it in. Endpoints' keys likewise.
  `
  CREATE TABLE model_backends (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    base_url   TEXT NOT NULL DEFAULT '',
    models     TEXT NOT NULL DEFAULT '[]',
    api_key    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
  // 22: the permission of each member's latest run (agent_sessions.permission): a turn with a higher
  // one does not resume the session. Kept here, never in a file an agent can write. NULL: not recorded
  // (sessions from before), taken as read-only.
  `
  ALTER TABLE agent_sessions ADD COLUMN permission TEXT;
  `,
  // 23: the same per CLI the member ran on (agent_sessions.by_cli, JSON: provider → { permission,
  // mustEmpty }), since each open agent keeps a state folder of its own for the member: one written at
  // a lower permission is emptied before that CLI runs with a higher one, and the flag that says it
  // must be stays until it has been.
  `
  ALTER TABLE agent_sessions ADD COLUMN by_cli TEXT;
  `,
  // 24: whether the user lets a CLI's commands use a terminal in the relay sandbox
  // (provider_settings.sandbox_terminal, 0/1; OpenHands only, see SANDBOX_TERMINAL_SUPPORT).
  `
  ALTER TABLE provider_settings ADD COLUMN sandbox_terminal INTEGER NOT NULL DEFAULT 0;
  `,
  // 25: the endpoints deleted in Settings (deleted_endpoints, until one of the same id is added
  // again), so that a Claude Code, Codex or Grok member still naming a model of one fails its turn
  // instead of sending it to the CLI's own service; and the backend each member's session was made on
  // (agent_sessions.backend: an endpoint's id; NULL: the CLI's own service, or not recorded, taken as
  // the same), so that a session is not resumed on another one.
  `
  CREATE TABLE deleted_endpoints (
    id         TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );
  ALTER TABLE agent_sessions ADD COLUMN backend TEXT;
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

/** A plain connection to another program's SQLite database (no migrations, no pragmas of ours). */
export function openSqliteFile(file: string): Database {
  return new DatabaseSync(file);
}

/**
 * A connection to an open agent's own SQLite database in its state folder, which the run's commands
 * may have written, for the server to take out of it what would widen a later run. Every trigger and
 * view in it is dropped first: a command could otherwise plant a trigger that writes back what the
 * server takes out, on the server's own write or on the CLI's next one (`AFTER UPDATE ON session BEGIN
 * UPDATE session SET permission = … END`), or put a view with `INSTEAD OF` triggers where a table was.
 * Neither OpenCode nor Goose makes any (checked with OpenCode 1.19.5 and Goose 1.58.1). A column a
 * command redefined (generated, or with a check) can still refuse or ignore a write, so the caller
 * reads back what it changed.
 */
export function openRunDatabase(file: string): Database {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA trusted_schema = OFF;');
    const planted = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')").all() as { type: string; name: string }[];
    for (const { type, name } of planted) db.exec(`DROP ${type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${name.replaceAll('"', '""')}"`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * The files this process holds SQLite locks on while it runs: its database with its journal files
 * (`openDatabase`), and its data folder's lock (`lockDataDir`).
 */
const lockedFiles = new Set<string>();

/**
 * The files this process holds SQLite locks on, as `dev:ino` (`fileKey`), for the server never to
 * open them itself: the system drops every lock a process holds on a file as soon as that process
 * closes any other handle to it (POSIX advisory locks). Reading `server.lock` in the Files panel
 * would free the data folder for a second server, and reading `relay.db` would drop SQLite's own
 * locks while the database is in use. By file, not path: a link or another letter case names it too.
 */
export function lockedFileKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of lockedFiles) {
    try {
      keys.add(fileKey(statSync(file)));
    } catch {
      /* not there (yet): a journal file */
    }
  }
  return keys;
}

/** A file's identity on this computer, whatever path names it. */
export function fileKey(st: { dev: number; ino: number }): string {
  return `${st.dev}:${st.ino}`;
}

/** Open (or create) the database. The file holds API keys, so it is readable by the owner only. */
export function openDatabase(file: string): Database {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600); // SQLite gives the -wal / -shm files the same mode
    for (const suffix of ['', '-wal', '-shm', '-journal']) lockedFiles.add(`${file}${suffix}`);
  }
  const db = new DatabaseSync(file);
  // secure_delete: overwrite deleted content (removed API keys, deleted chats) instead of leaving it in free pages.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  migrate(db);
  return db;
}

/**
 * The data folders this process holds (`lockDataDir`), kept here for as long as it runs: a handle
 * nothing refers to any more would be collected, and its connection, with the lock, closed with it.
 */
const heldDataDirs: Database[] = [];

/** The file a running server holds its data folder with (a SQLite database that stays empty). */
export function dataLockFile(dataDir: string): string {
  return join(dataDir, 'server.lock');
}

/**
 * Takes the data folder for this server while it runs, or returns undefined when another server
 * holds it. Two servers on one data folder would undo each other: at its start each one kills the
 * processes of the other's sandboxed runs and removes their folders, marks the other's streaming
 * replies aborted and expires their approvals, and removes the temporary folders of the other's
 * shares in progress, and both would send every schedule. So a second server on the same data folder
 * (`npm run dev` beside an `npm start` of the same checkout, say) refuses to start.
 *
 * The lock is SQLite's own on that file (an exclusive transaction kept open, with the journal in
 * memory so no other file is made): the system releases it when the process ends, however it ends,
 * so a server that was killed leaves no stale lock, and a process that later gets its pid holds
 * nothing. The folder stays held until the process ends (the handle is kept here, `heldDataDirs`,
 * whether the caller keeps it or not); closing the returned handle releases it sooner.
 */
export function lockDataDir(dataDir: string): Database | undefined {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataLockFile(dataDir));
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;');
    heldDataDirs.push(db);
    lockedFiles.add(dataLockFile(dataDir));
    return db;
  } catch (err) {
    db.close();
    if ((err as { errcode?: number }).errcode === 5) return undefined; // SQLITE_BUSY: another server holds it
    throw err;
  }
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
