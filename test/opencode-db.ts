import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/*
 * A small OpenCode database for the usage tests: the two tables `usage` reads, with the columns it
 * uses of OpenCode 1.19.5's (`session.id`, `session.parent_id`; `part.id`, `part.session_id`,
 * `part.data`, the part as JSON without its ids), and the `permission` column the scrub empties.
 */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** A model call: its tokens as OpenCode keeps them (input without the cache, output without the reasoning) and its cost. */
export interface StepRow {
  id: string;
  session: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface OpencodeDbRows {
  /** Sessions besides the steps' own (a subagent's under its parent). */
  sessions?: { id: string; parent?: string }[];
  steps?: StepRow[];
  /** Other parts, as they are (`data` given as it is, JSON or not). */
  parts?: { id: string; session: string; data: string }[];
}

/** The `data` of a step's `step-finish` part, as OpenCode 1.19.5 writes it. */
export function stepData(s: StepRow): string {
  const input = s.input ?? 0;
  const output = s.output ?? 0;
  const reasoning = s.reasoning ?? 0;
  const read = s.cacheRead ?? 0;
  const write = s.cacheWrite ?? 0;
  return JSON.stringify({
    reason: 'stop',
    snapshot: 'abc123',
    type: 'step-finish',
    tokens: { total: input + output + reasoning + read + write, input, output, reasoning, cache: { write, read } },
    cost: s.cost ?? 0,
  });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, parent_id TEXT, permission TEXT);
  CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
`;

/** Adds the rows to the database at `file` (made with the tables when it is not there). */
export function addOpencodeRows(file: string, rows: OpencodeDbRows): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    const session = db.prepare('INSERT OR IGNORE INTO session (id, parent_id) VALUES (?, ?)');
    const part = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, 0, ?)');
    for (const s of rows.sessions ?? []) session.run(s.id, s.parent ?? null);
    for (const s of rows.steps ?? []) {
      session.run(s.session, null);
      part.run(s.id, `msg_${s.id}`, s.session, stepData(s));
    }
    for (const p of rows.parts ?? []) {
      session.run(p.session, null);
      part.run(p.id, `msg_${p.id}`, p.session, p.data);
    }
  } finally {
    db.close();
  }
}

/**
 * Writes, at `path`, a stand-in that adds `FAKE_OC_ROWS` (JSON `OpencodeDbRows`) to the run's
 * database (`XDG_DATA_HOME/opencode/opencode.db`) as `opencode acp` starts, after the run read what
 * was there before it, then is the fake at `fake`: the model calls the turn makes.
 */
export function writeOpencodeWithRows(path: string, fake: string): string {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'acp' && process.env.FAKE_OC_ROWS) {
  const emit = process.emitWarning;
  process.emitWarning = () => {}; // node:sqlite's experimental warning
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = emit;
  const path = require('node:path');
  const rows = JSON.parse(process.env.FAKE_OC_ROWS);
  const file = path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db');
  require('node:fs').mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(${JSON.stringify(SCHEMA)});
  const session = db.prepare('INSERT OR IGNORE INTO session (id, parent_id) VALUES (?, ?)');
  const part = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, 0, ?)');
  for (const s of rows.sessions || []) session.run(s.id, s.parent || null);
  for (const s of rows.steps || []) {
    session.run(s.session, null);
    part.run(s.id, 'msg_' + s.id, s.session, s.data);
  }
  db.close();
}
require(${JSON.stringify(fake)});
`,
    { mode: 0o755 },
  );
  return path;
}

/** `FAKE_OC_ROWS` for `writeOpencodeWithRows`: the steps with their `data` made here. */
export function rowsEnv(rows: { sessions?: { id: string; parent?: string }[]; steps: StepRow[] }): string {
  return JSON.stringify({ sessions: rows.sessions ?? [], steps: rows.steps.map((s) => ({ id: s.id, session: s.session, data: stepData(s) })) });
}
