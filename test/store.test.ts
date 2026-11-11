import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, TeamPreset } from '../src/shared/types';
import { dataLockFile, lockDataDir, openDatabase, type Database } from '../src/server/db';
import type { SecretStore } from '../src/server/secrets';
import { OPEN_AGENT_ROOTS_ENV, OPEN_HOMES_DIR, SettingsStore } from '../src/server/settings';
import { Store } from '../src/server/store';

let dir: string;
let file: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
  file = join(dir, 'relay.db');
  db = openDatabase(file);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function reopen(): Database {
  db.close();
  db = openDatabase(file);
  return db;
}

function sampleConversation(): Conversation {
  return {
    id: 'conv-1',
    title: '測試對話',
    createdAt: 1000,
    updatedAt: 2000,
    agents: [
      { id: 'a1', name: 'Architect', provider: 'claude', role: '規劃', model: 'opus', effort: 'high', tools: { 'mcp:github': false, memory: true } },
      { id: 'a2', name: 'Builder', provider: 'codex', role: '實作' },
    ],
    settings: { mode: 'relay', rounds: 1, maxHops: 6, permission: 'edit', cwd: '/tmp' },
    messages: [],
    agentState: {},
    worktrees: {},
  };
}

const userMsg: ChatMessage = {
  id: 'm1',
  author: { kind: 'user' },
  createdAt: 2100,
  parts: [{ type: 'text', text: '請 @Architect 規劃' }],
  status: 'done',
};

const agentMsg: ChatMessage = {
  id: 'm2',
  author: { kind: 'agent', agentId: 'a1' },
  agentName: 'Architect',
  provider: 'claude',
  createdAt: 2200,
  parts: [
    { type: 'text', text: '先看檔案' },
    { type: 'tool', id: 't1', name: 'Read', detail: 'src/a.ts', status: 'done' },
    { type: 'tool', id: 't2', name: 'Bash', status: 'error', error: 'Permission to use Bash has been denied' },
    { type: 'text', text: '計畫如下… @Builder' },
  ],
  status: 'done',
  passed: true,
  meta: { durationMs: 1234, costUsd: 0.05, inputTokens: 100, outputTokens: 20 },
};

describe('Store (SQLite)', () => {
  it('round-trips a conversation, its messages and agent sessions', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    conv.messages.push(userMsg, agentMsg);
    store.saveMessage(conv.id, userMsg);
    store.saveMessage(conv.id, agentMsg, true);
    conv.agentState.a1 = { provider: 'claude', sessionId: 'sess-1', seen: ['m1', 'm2'] };
    store.saveAgentState(conv.id, 'a1', conv.agentState.a1);
    conv.title = '改過的標題';
    store.saveMeta(conv);

    const loaded = new Store(reopen()).get(conv.id);
    expect(loaded).toEqual({ ...conv, agentState: { a1: { provider: 'claude', sessionId: 'sess-1', seen: ['m1', 'm2'] } } });

    // The endpoint a session was made on (schema version 26); none: the CLI's own service.
    new Store(db).saveAgentState(conv.id, 'a1', { provider: 'claude', sessionId: 'sess-2', backend: 'homelab', seen: [] });
    expect(new Store(reopen()).get(conv.id)!.agentState.a1).toEqual({ provider: 'claude', sessionId: 'sess-2', backend: 'homelab', seen: [] });
    new Store(db).saveAgentState(conv.id, 'a1', { provider: 'claude', sessionId: 'sess-3', seen: [] });
    expect(new Store(reopen()).get(conv.id)!.agentState.a1).toEqual({ provider: 'claude', sessionId: 'sess-3', seen: [] });
  });

  it('saves a branch with the messages it starts with, and where its copied messages end', () => {
    const store = new Store(db);
    const conv: Conversation = {
      ...sampleConversation(),
      messages: [userMsg, agentMsg],
      branch: { fromId: 'conv-0', fromTitle: '原本的對話', afterId: 'm2' },
    };
    store.create(conv);
    const reloaded = new Store(reopen());
    const loaded = reloaded.get(conv.id)!;
    expect(loaded.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loaded.messages[1]!.parts).toEqual(agentMsg.parts);
    expect(loaded.branch).toEqual(conv.branch);

    loaded.branch = { ...loaded.branch!, afterId: 'm1' };
    reloaded.saveMeta(loaded);
    expect(new Store(reopen()).get(conv.id)!.branch?.afterId).toBe('m1');
    const again = new Store(db);
    const last = again.get(conv.id)!;
    last.branch = undefined;
    again.saveMeta(last);
    expect(new Store(reopen()).get(conv.id)!.branch).toBeUndefined();

    // One that cannot be read is left out.
    db.prepare('UPDATE conversations SET branch = ? WHERE id = ?').run('{"fromId": 7}', conv.id);
    expect(new Store(reopen()).get(conv.id)!.branch).toBeUndefined();
  });

  it('saves a new conversation with its messages in one step: nothing when a message cannot be written', () => {
    const store = new Store(db);
    const broken = { ...agentMsg, id: 'm9', status: undefined } as unknown as ChatMessage;
    expect(() => store.create({ ...sampleConversation(), messages: [userMsg, broken] })).toThrow();
    expect(new Store(reopen()).get('conv-1')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('keeps auto team and whether to ask, and turns auto team on for conversations from before it was per question', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    conv.settings = { ...conv.settings, autoTeam: true, autoConfirm: true };
    store.create(conv);
    const fixed = { ...sampleConversation(), id: 'conv-2' };
    store.create(fixed);
    expect(new Store(reopen()).get(conv.id)!.settings).toMatchObject({ autoTeam: true, autoConfirm: true });
    expect(new Store(db).get(fixed.id)!.settings.autoTeam).toBeUndefined();

    // A database from before schema version 13: every conversation gets auto team, none skips asking.
    db.exec(`ALTER TABLE conversations DROP COLUMN auto_confirm;
             ALTER TABLE schedules DROP COLUMN new_chat; ALTER TABLE schedules DROP COLUMN last_chat_id;
             DROP TABLE shares; ALTER TABLE conversations DROP COLUMN branch;
             DROP TABLE auth_sessions; DROP TABLE auth_codes;
             DROP TABLE provider_accounts; ALTER TABLE provider_settings DROP COLUMN account_label;
             ALTER TABLE conversation_agents DROP COLUMN account; ALTER TABLE preset_agents DROP COLUMN account;
             ALTER TABLE agent_sessions DROP COLUMN account;
             ALTER TABLE conversations DROP COLUMN extra_cwds; ALTER TABLE messages DROP COLUMN more_changes;
             DROP TABLE model_backends; ALTER TABLE agent_sessions DROP COLUMN permission; ALTER TABLE agent_sessions DROP COLUMN by_cli; ALTER TABLE provider_settings DROP COLUMN sandbox_terminal;
             DROP TABLE deleted_endpoints; ALTER TABLE agent_sessions DROP COLUMN backend;
             PRAGMA user_version = 12;`);
    const migrated = new Store(reopen());
    expect(migrated.get(fixed.id)!.settings).toMatchObject({ autoTeam: true });
    expect(migrated.get(fixed.id)!.settings.autoConfirm).toBeUndefined();
    expect(migrated.get(conv.id)!.settings.autoConfirm).toBeUndefined();
  });

  it('keeps message order and updates a streaming message in place', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const live: ChatMessage = { ...agentMsg, id: 'm3', parts: [{ type: 'text', text: 'Hel' }], status: 'streaming', passed: undefined };
    conv.messages.push(userMsg, live);
    store.saveMessage(conv.id, userMsg, true);
    store.saveMessage(conv.id, live, true);
    (live.parts[0] as { text: string }).text += 'lo';
    live.status = 'done';
    store.saveMessage(conv.id, live, true);

    const loaded = new Store(reopen()).get(conv.id)!;
    expect(loaded.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(loaded.messages[1]!.parts).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(loaded.messages[1]!.status).toBe('done');
  });

  it('keeps the files attached to a user message', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const msg: ChatMessage = {
      id: 'm9',
      author: { kind: 'user' },
      createdAt: 9,
      status: 'done',
      parts: [
        { type: 'text', text: 'see attached' },
        { type: 'attachment', id: 'f1', name: 'shot.png', mimeType: 'image/png', size: 1234 },
      ],
    };
    conv.messages.push(msg);
    store.saveMessage(conv.id, msg, true);
    expect(new Store(reopen()).get(conv.id)!.messages.at(-1)!.parts).toEqual(msg.parts);
  });

  it('marks messages left streaming by a crashed server as aborted', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const live: ChatMessage = { ...agentMsg, id: 'm4', status: 'streaming' };
    conv.messages.push(live);
    store.saveMessage(conv.id, live, true);

    expect(new Store(reopen()).get(conv.id)!.messages[0]!.status).toBe('aborted');
  });

  it('expires the approvals a crashed server left waiting, so no card offers to answer them', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const approval = (id: string, status: 'pending' | 'allowed') => ({ type: 'approval' as const, id, kind: 'command' as const, detail: 'npm test', status });
    const live: ChatMessage = { ...agentMsg, id: 'm5', status: 'streaming', parts: [{ type: 'text', text: 'working' }, approval('p1', 'pending'), approval('p2', 'allowed')] };
    const done: ChatMessage = { ...agentMsg, id: 'm6', status: 'done', parts: [approval('p3', 'pending')] };
    conv.messages.push(live, done);
    store.saveMessage(conv.id, live, true);
    store.saveMessage(conv.id, done, true);

    const after = new Store(reopen()).get(conv.id)!.messages;
    const parts = after.find((m) => m.id === 'm5')!.parts;
    expect(after.find((m) => m.id === 'm5')!.status).toBe('aborted');
    expect(parts.map((p) => (p.type === 'approval' ? p.status : p.type))).toEqual(['text', 'expired', 'allowed']);
    expect(parts[1]).toMatchObject({ detail: 'npm test', kind: 'command' });
    // Only in replies the crash cut off.
    expect(after.find((m) => m.id === 'm6')!.parts[0]).toMatchObject({ status: 'pending' });
  });

  it('ends the tool calls a crashed server left running, so no row shows them running forever', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const tool = (id: string, status: 'running' | 'done') => ({ type: 'tool' as const, id, name: 'Shell', detail: 'npm test', status });
    const live: ChatMessage = { ...agentMsg, id: 'm7', status: 'streaming', parts: [tool('t1', 'running'), tool('t2', 'done')] };
    // Left by an older server, which marked the reply aborted but not its rows.
    const old: ChatMessage = { ...agentMsg, id: 'm8', status: 'aborted', parts: [tool('t3', 'running')] };
    const done: ChatMessage = { ...agentMsg, id: 'm9', status: 'done', parts: [tool('t4', 'running')] };
    conv.messages.push(live, old, done);
    for (const m of [live, old, done]) store.saveMessage(conv.id, m, true);

    const after = new Store(reopen()).get(conv.id)!.messages;
    const statuses = (id: string) => after.find((m) => m.id === id)!.parts.map((p) => (p.type === 'tool' ? p.status : p.type));
    expect(after.find((m) => m.id === 'm7')!.status).toBe('aborted');
    expect(statuses('m7')).toEqual(['error', 'done']);
    expect(after.find((m) => m.id === 'm7')!.parts[0]).toMatchObject({ name: 'Shell', detail: 'npm test' });
    expect(statuses('m8')).toEqual(['error']);
    // Only in replies the crash cut off.
    expect(statuses('m9')).toEqual(['running']);
  });

  it('deletes a conversation with all its rows', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    conv.messages.push(agentMsg);
    store.saveMessage(conv.id, agentMsg, true);
    store.saveAgentState(conv.id, 'a1', { provider: 'claude', sessionId: 's', seen: ['m2'] });
    store.delete(conv.id);

    for (const table of ['conversations', 'conversation_agents', 'messages', 'message_parts', 'agent_sessions', 'agent_seen']) {
      const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      expect(n, table).toBe(0);
    }
    expect(store.get(conv.id)).toBeUndefined();
  });

  it('lists conversations newest first with their team', () => {
    const store = new Store(db);
    store.create({ ...sampleConversation(), id: 'old', updatedAt: 1 });
    store.create({ ...sampleConversation(), id: 'new', updatedAt: 5 });
    const list = store.list(() => false);
    expect(list.map((c) => c.id)).toEqual(['new', 'old']);
    expect(list[0]!.agents).toEqual([
      { name: 'Architect', provider: 'claude' },
      { name: 'Builder', provider: 'codex' },
    ]);
  });

  it('lists the working directories in use once each, the most recently used first', () => {
    const store = new Store(db);
    const at = (id: string, cwd: string, updatedAt: number) =>
      store.create({ ...sampleConversation(), id, updatedAt, settings: { ...sampleConversation().settings, cwd } });
    expect(store.listCwds()).toEqual([]);
    at('a', '/work/a', 1);
    at('b', '/work/b', 2);
    at('c', '/work/a', 3);
    at('d', '/work/c', 0);
    expect(store.listCwds()).toEqual(['/work/a', '/work/b', '/work/c']);
  });

  it('lists every working directory of each conversation, once each, the most recently used first', () => {
    const store = new Store(db);
    const at = (id: string, cwd: string, extraCwds: string[] | undefined, updatedAt: number) =>
      store.create({ ...sampleConversation(), id, updatedAt, settings: { ...sampleConversation().settings, cwd, ...(extraCwds ? { extraCwds } : {}) } });
    at('a', '/work/a', ['/work/docs', '/work/b'], 1);
    at('b', '/work/b', undefined, 2);
    at('c', '/work/c', ['/work/docs'], 0);
    expect(store.listCwds()).toEqual(['/work/b', '/work/a', '/work/docs', '/work/c']);
  });

  it("keeps a conversation's other working directories, a turn's changes in each repository and each repository's worktree", () => {
    const store = new Store(db);
    const conv = sampleConversation();
    conv.settings = { ...conv.settings, extraCwds: ['/docs', '/infra'] };
    store.create(conv);
    const files = (path: string) => [{ path, status: 'M' as const, added: 1, deleted: 0 }];
    const turn: ChatMessage = {
      ...agentMsg,
      changes: [
        { root: '/tmp', base: 'a', head: 'b', files: files('x.ts'), isolated: true, branch: 'relay/c/A' },
        { root: '/docs', base: 'c', head: 'd', files: files('guide.md'), isolated: true, branch: 'relay/c/A' },
      ],
    };
    conv.messages.push(turn);
    store.saveMessage(conv.id, turn, true);
    const wt = (root: string, path: string) => ({ root, path, branch: 'relay/c/A', base: 'b0', needsReset: false });
    store.saveWorktree(conv.id, 'a1', wt('/tmp', '/wt/a1'));
    store.saveWorktree(conv.id, 'a1', wt('/docs', '/wt/a1-docs'));
    store.saveWorktree(conv.id, 'a1', { ...wt('/docs', '/wt/a1-docs'), needsReset: true });
    store.saveWorktree(conv.id, 'a1', wt('/old', '/wt/a1-old'));
    store.deleteWorktree(conv.id, 'a1', '/old');

    const loaded = new Store(reopen()).get(conv.id)!;
    expect(loaded.settings.extraCwds).toEqual(['/docs', '/infra']);
    expect(loaded.messages[0]!.changes).toEqual(turn.changes);
    expect(loaded.worktrees.a1).toEqual([wt('/tmp', '/wt/a1'), { ...wt('/docs', '/wt/a1-docs'), needsReset: true }]);

    // One folder again: none after it.
    loaded.settings = { ...loaded.settings, extraCwds: undefined };
    new Store(db).saveMeta(loaded);
    expect(new Store(reopen()).get(conv.id)!.settings).not.toHaveProperty('extraCwds');
  });

  it('keeps the worktrees made before version 21, and reads a turn of one repository as before', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const turn: ChatMessage = { ...agentMsg, changes: [{ root: '/tmp', base: 'a', head: 'b', files: [], isolated: false }] };
    conv.messages.push(turn);
    store.saveMessage(conv.id, turn, true);
    // A database from before version 21: one worktree per agent, and no extra_cwds or more_changes.
    db.exec(`DROP TABLE agent_worktrees;
             CREATE TABLE agent_worktrees (
               conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               agent_id TEXT NOT NULL, repo_root TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
               base_commit TEXT NOT NULL, needs_reset INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (conversation_id, agent_id));
             INSERT INTO agent_worktrees VALUES ('conv-1', 'a1', '/tmp', '/wt/a1', 'relay/c/Architect', 'b0', 1);
             ALTER TABLE conversations DROP COLUMN extra_cwds; ALTER TABLE messages DROP COLUMN more_changes;
             DROP TABLE model_backends; ALTER TABLE agent_sessions DROP COLUMN permission; ALTER TABLE agent_sessions DROP COLUMN by_cli; ALTER TABLE provider_settings DROP COLUMN sandbox_terminal;
             DROP TABLE deleted_endpoints; ALTER TABLE agent_sessions DROP COLUMN backend;
             PRAGMA user_version = 20;`);
    const migrated = new Store(reopen()).get(conv.id)!;
    expect(migrated.worktrees).toEqual({ a1: [{ root: '/tmp', path: '/wt/a1', branch: 'relay/c/Architect', base: 'b0', needsReset: true }] });
    expect(migrated.settings).not.toHaveProperty('extraCwds');
    expect(migrated.messages[0]!.changes).toEqual(turn.changes);
  });

  it('leaves out what cannot be read of the other working directories and repositories', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    const turn: ChatMessage = { ...agentMsg, changes: [{ root: '/tmp', base: 'a', head: 'b', files: [], isolated: false }] };
    conv.messages.push(turn);
    store.saveMessage(conv.id, turn, true);
    db.exec(`UPDATE conversations SET extra_cwds = '["/docs", 3, "", null]';
             UPDATE messages SET more_changes = '[{"root":"/docs"}, {"root":"/b","base":"c","head":"d","files":[],"isolated":false}]';`);
    const loaded = new Store(reopen()).get(conv.id)!;
    expect(loaded.settings.extraCwds).toEqual(['/docs']);
    expect(loaded.messages[0]!.changes!.map((c) => c.root)).toEqual(['/tmp', '/b']);
    db.exec(`UPDATE conversations SET extra_cwds = 'not json'; UPDATE messages SET more_changes = '{}';`);
    const broken = new Store(reopen()).get(conv.id)!;
    expect(broken.settings).not.toHaveProperty('extraCwds');
    expect(broken.messages[0]!.changes!.map((c) => c.root)).toEqual(['/tmp']);
  });

  it('marks conversations whose team design waits for confirmation, also after a restart', () => {
    const store = new Store(db);
    const conv: Conversation = { ...sampleConversation(), id: 'auto', messages: [] };
    store.create(conv);
    const plan: ChatMessage = {
      id: 'plan',
      author: { kind: 'system' },
      createdAt: 1,
      parts: [],
      status: 'done',
      plan: { status: 'ready', lead: { provider: 'claude' }, source: 'template', name: 'x', agents: [], awaitingConfirmation: true },
    };
    conv.messages.push(plan);
    store.saveMessage(conv.id, plan, true);
    expect(store.list(() => false).find((c) => c.id === 'auto')?.confirmTeam).toBe(true);
    expect(new Store(db).list(() => false).find((c) => c.id === 'auto')?.confirmTeam).toBe(true); // from the database

    delete plan.plan!.awaitingConfirmation;
    plan.plan!.confirmedAt = 2;
    store.saveMessage(conv.id, plan, true);
    expect(store.list(() => false).find((c) => c.id === 'auto')?.confirmTeam).toBeUndefined();
    expect(new Store(db).list(() => false).find((c) => c.id === 'auto')?.confirmTeam).toBeUndefined();
  });

  it('saves user presets after the built-in ones', () => {
    const store = new Store(db);
    const preset: TeamPreset = {
      id: 'user-1',
      name: '我的團隊',
      agents: sampleConversation().agents,
      settings: { mode: 'roundtable', rounds: 2, maxHops: 6, permission: 'read-only' },
    };
    store.savePreset(preset);
    const loaded = new Store(reopen()).listPresets();
    expect(loaded.at(-1)).toEqual(preset);
    expect(loaded.slice(0, -1).every((p) => p.builtin)).toBe(true);
    new Store(db).deletePreset('user-1');
    expect(new Store(db).listPresets().some((p) => p.id === 'user-1')).toBe(false);
  });
});

describe('the data folder lock', () => {
  it('lets one server at a time hold a data folder, and frees it when that server ends, also when it is killed', async () => {
    const data = join(dir, 'data');
    const first = lockDataDir(data);
    expect(first).toBeDefined();
    // Another server (the same process stands in) is refused while the first holds it.
    expect(lockDataDir(data)).toBeUndefined();
    first!.close();
    const again = lockDataDir(data);
    expect(again).toBeDefined();
    again!.close();
    // No journal or other file beside it.
    expect(existsSync(`${dataLockFile(data)}-journal`)).toBe(false);

    // Another process holds it, then is killed: nothing stale is left.
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;');
      process.stdout.write('held\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--no-warnings', '-e', script, dataLockFile(data)], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => d.toString().includes('held') && resolve());
      child.on('exit', () => reject(new Error('the holder exited')));
    });
    expect(lockDataDir(data)).toBeUndefined();
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    const after = lockDataDir(data);
    expect(after).toBeDefined();
    after!.close();
  });

  it('keeps the data folder held when nothing refers to the handle any more, after garbage collection', async () => {
    const data = join(dir, 'data-gc');
    // As index.ts does: the handle is not kept. Then everything collectable is collected.
    const script = `
      const { lockDataDir } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/server/db.ts')).href)});
      if (!lockDataDir(process.argv[1])) process.exit(3);
      for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); }
      process.stdout.write('collected\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--expose-gc', '--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script, data], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (d: Buffer) => d.toString().includes('collected') && resolve());
        child.on('exit', (code) => reject(new Error(`the holder exited (${code})`)));
      });
      expect(lockDataDir(data)).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('Store groups', () => {
  it('keeps groups in the order they were made, and moves the conversations of a deleted group to Other', () => {
    const store = new Store(db);
    store.createGroup({ id: 'g1', name: '前端' });
    store.createGroup({ id: 'g2', name: 'Docs' });
    store.create({ ...sampleConversation(), id: 'c1' });
    store.create({ ...sampleConversation(), id: 'c2' });
    store.moveToGroup('c1', 'g1');
    store.moveToGroup('c2', 'g2');
    store.renameGroup('g2', 'Writing');

    const again = new Store(reopen());
    expect(again.listGroups()).toEqual([
      { id: 'g1', name: '前端' },
      { id: 'g2', name: 'Writing' },
    ]);
    const groupOf = (s: Store) => Object.fromEntries(s.list(() => false).map((c) => [c.id, c.groupId]));
    expect(groupOf(again)).toEqual({ c1: 'g1', c2: 'g2' });
    expect(again.groupOf('c1')).toBe('g1');

    again.deleteGroup('g1');
    expect(again.listGroups().map((g) => g.id)).toEqual(['g2']);
    expect(groupOf(again)).toEqual({ c1: undefined, c2: 'g2' });
    expect(again.groupOf('c1')).toBeNull(); // Other
    expect(again.groupOf('missing')).toBeNull();
    expect(again.isSorted('c1')).toBe(true); // the user sorted it: it is not sorted automatically again
  });

  it('sorts a conversation automatically only once, never over the user, and never into a deleted group', () => {
    const store = new Store(db);
    store.createGroup({ id: 'g1', name: 'Backend' });
    store.createGroup({ id: 'g2', name: 'Ops' });
    for (const id of ['auto', 'user', 'none', 'gone']) store.create({ ...sampleConversation(), id });
    expect(store.isSorted('auto')).toBe(false);

    expect(store.sortIntoGroup('auto', 'g1')).toBe(true);
    expect(store.sortIntoGroup('auto', 'g2')).toBe(false); // once
    store.moveToGroup('user', 'g2');
    expect(store.sortIntoGroup('user', 'g1')).toBe(false); // the user moved it first
    expect(store.sortIntoGroup('none', null)).toBe(true); // stays in Other, but it is sorted
    expect(store.isSorted('none')).toBe(true);
    store.deleteGroup('g2');
    expect(store.sortIntoGroup('gone', 'g2')).toBe(false);
    expect(store.isSorted('gone')).toBe(false);

    const list = Object.fromEntries(store.list(() => false).map((c) => [c.id, c.groupId]));
    expect(list).toEqual({ auto: 'g1', user: undefined, none: undefined, gone: undefined });
    expect(store.groupTitles('g1', 5)).toEqual(['測試對話']);
  });

  /** A conversation made at `createdAt`, branched from `fromId`. */
  const member = (id: string, createdAt: number, fromId?: string): Conversation => ({
    ...sampleConversation(),
    id,
    title: id,
    createdAt,
    updatedAt: createdAt,
    ...(fromId ? { branch: { fromId, fromTitle: `${fromId} then`, afterId: 'm1' } } : {}),
  });
  const groupsOf = (s: Store) => Object.fromEntries(s.list(() => false).map((c) => [c.id, c.groupId]));

  it('lists where each conversation was branched from, and when it was made', () => {
    const store = new Store(db);
    store.create(member('root', 1));
    store.create(member('b1', 2, 'root'));
    // No longer a branch (a retry took back every copied message): what is in memory counts.
    store.get('b1')!.branch = undefined;
    expect(store.list(() => false).find((c) => c.id === 'b1')!.branchFrom).toBeUndefined();
    const list = Object.fromEntries(new Store(reopen()).list(() => false).map((c) => [c.id, c]));
    expect(list.b1).toMatchObject({ createdAt: 2, branchFrom: { id: 'root', title: 'root then' } });
    expect(list.root!.createdAt).toBe(1);
    expect(list.root!.branchFrom).toBeUndefined();
  });

  it('moves a family of branched conversations between groups as one, also once the one at its top is deleted', () => {
    const store = new Store(db);
    store.createGroup({ id: 'g1', name: 'Research' });
    store.createGroup({ id: 'g2', name: 'Writing' });
    store.create(member('root', 1));
    store.create(member('b1', 2, 'root'));
    store.create(member('b2', 3, 'b1'));
    store.create(member('alone', 4));
    expect(store.family('b1')).toEqual(['root', 'b1', 'b2']);
    expect(store.family('alone')).toEqual(['alone']);

    // Any of them moves all of them.
    store.moveToGroup('b2', 'g1');
    expect(groupsOf(store)).toEqual({ root: 'g1', b1: 'g1', b2: 'g1', alone: undefined });
    expect(store.isSorted('root')).toBe(true);

    // A new branch goes into its family's group: the oldest conversation's.
    db.prepare("UPDATE conversations SET group_id = 'g2' WHERE id = 'b1'").run(); // made apart before families moved as one
    store.create(member('b3', 5, 'b1'));
    store.placeBranch('b3');
    expect(store.groupOf('b3')).toBe('g1');
    expect(store.familyGroupOf('b1')).toBe('g1');
    expect(store.isSorted('b3')).toBe(true);

    // The top is deleted: what was branched from it stays one family.
    store.create(member('b4', 6, 'root'));
    store.delete('root');
    expect(store.family('b4')).toEqual(['b1', 'b2', 'b3', 'b4']);
    store.moveToGroup('b4', 'g2');
    expect(groupsOf(store)).toEqual({ b1: 'g2', b2: 'g2', b3: 'g2', b4: 'g2', alone: undefined });
    store.moveToGroup('b2', null);
    expect(groupsOf(new Store(reopen()))).toEqual({ b1: undefined, b2: undefined, b3: undefined, b4: undefined, alone: undefined });
  });

  it('keeps a family together when a conversation in the middle of it is deleted', () => {
    const store = new Store(db);
    store.createGroup({ id: 'g1', name: 'Research' });
    store.create(member('A', 1));
    store.create(member('B', 2, 'A'));
    store.create(member('C', 3, 'B'));
    store.create(member('D', 4, 'B'));
    store.create(member('E', 5, 'C'));
    store.get('C'); // one in memory, one only in the database
    store.delete('B');
    // Where B came from is kept below it (with the title B was branched from A with).
    expect(store.get('C')!.branch).toEqual({ fromId: 'B', fromTitle: 'B then', afterId: 'm1', via: [{ id: 'A', title: 'A then' }] });
    expect(new Store(reopen()).get('D')!.branch?.via).toEqual([{ id: 'A', title: 'A then' }]);
    const again = new Store(db);
    expect(again.get('E')!.branch?.via).toBeUndefined(); // C, which it came from, is still there
    expect(again.family('E')).toEqual(['A', 'C', 'D', 'E']);
    again.moveToGroup('A', 'g1');
    expect(groupsOf(again)).toEqual({ A: 'g1', C: 'g1', D: 'g1', E: 'g1' });
    expect(again.list(() => false).find((c) => c.id === 'C')!.branchFrom).toEqual({
      id: 'B',
      title: 'B then',
      via: [{ id: 'A', title: 'A then' }],
    });

    // The top goes too: its title then is kept, and the rest stays one family.
    again.delete('A');
    expect(again.get('C')!.branch?.via).toEqual([{ id: 'A', title: 'A' }]);
    expect(again.family('D')).toEqual(['C', 'D', 'E']);
    // A leaf goes: nothing else changes.
    again.delete('E');
    expect(again.get('C')!.branch?.via).toEqual([{ id: 'A', title: 'A' }]);
    // An unreadable chain is left out.
    db.prepare('UPDATE conversations SET branch = ? WHERE id = ?').run('{"fromId":"B","afterId":"m1","via":[7,{"id":"A"}]}', 'D');
    expect(new Store(reopen()).get('D')!.branch).toEqual({ fromId: 'B', fromTitle: '', afterId: 'm1' });
  });

  it("keeps where a branch's earlier copied messages were written, also once that conversation is deleted", () => {
    const store = new Store(db);
    store.create(member('Z', 1));
    store.create(member('A', 2, 'Z'));
    store.create(member('B', 3, 'A'));
    const earlier = [{ fromId: 'A', fromTitle: 'A then', afterId: 'm1' }, { fromId: 'Z', fromTitle: 'Z then', afterId: 'm0' }];
    store.create({ ...member('C', 4, 'B'), branch: { fromId: 'B', fromTitle: 'B then', afterId: 'm2', earlier } });
    store.get('B'); // one in memory, one only in the database
    store.get('B')!.title = 'B now';
    expect([store.titleOf('B'), store.titleOf('A'), store.titleOf('nope')]).toEqual(['B now', 'A', undefined]);
    // Only where the last copied messages were written places it in the sidebar.
    expect(store.list(() => false).find((c) => c.id === 'C')!.branchFrom).toEqual({ id: 'B', title: 'B then' });

    // A is deleted: the part it wrote learns where A came from; the others stay.
    store.delete('A');
    const after = { fromId: 'B', fromTitle: 'B then', afterId: 'm2', earlier: [{ ...earlier[0], via: [{ id: 'Z', title: 'Z then' }] }, earlier[1]] };
    expect(store.get('C')!.branch).toEqual(after);
    expect(store.get('B')!.branch?.via).toEqual([{ id: 'Z', title: 'Z then' }]);
    // A deleted conversation's title is the one the sidebar shows for it: its title when the newest
    // conversation branched from it was made, or once one further up is deleted too, its title then.
    expect(store.titleOf('A')).toBe('A then');
    store.get('Z')!.title = 'Z at the end';
    store.delete('Z');
    expect(store.titleOf('Z')).toBe('Z at the end');
    expect(new Store(reopen()).get('C')!.branch).toEqual({
      ...after,
      earlier: [{ ...earlier[0], via: [{ id: 'Z', title: 'Z at the end' }] }, earlier[1]],
    });

    // Unreadable parts are left out.
    db.prepare('UPDATE conversations SET branch = ? WHERE id = ?').run(
      '{"fromId":"B","afterId":"m2","earlier":[{"fromId":"Z"},7,{"fromId":"Z","fromTitle":"Z","afterId":"m0"}]}',
      'C',
    );
    expect(new Store(reopen()).get('C')!.branch).toEqual({
      fromId: 'B',
      fromTitle: '',
      afterId: 'm2',
      earlier: [{ fromId: 'Z', fromTitle: 'Z', afterId: 'm0' }],
    });
  });

  it('takes a branch made while its conversation was being sorted along into the group it is sorted into', () => {
    const store = new Store(db);
    store.createGroup({ id: 'g1', name: 'Backend' });
    store.create(member('root', 1));
    store.create(member('b1', 2, 'root'));
    store.placeBranch('b1');
    expect(store.sortIntoGroup('root', 'g1')).toBe(true);
    expect(groupsOf(store)).toEqual({ root: 'g1', b1: 'g1' });
    // The lead agent sorted the one it was asked about; the branch stays the user's choice.
    expect(store.isSorted('b1')).toBe(true);
    expect(store.sortIntoGroup('b1', null)).toBe(false);
  });
});

describe('Store shares', () => {
  const share = (id: string, createdAt: number) => ({
    id,
    conversationId: 'c1',
    title: 'Plan',
    url: `https://gistpreview.github.io/?${id}`,
    gistUrl: `https://gist.github.com/me/${id}`,
    createdAt,
  });

  it('keeps shares, the newest first, with the reply they end with', () => {
    const store = new Store(db);
    store.create({ ...sampleConversation(), id: 'c1' });
    store.addShare(share('aaaa', 1));
    store.addShare({ ...share('bbbb', 2), upTo: { messageId: 'm9', agentName: 'builder' } });
    const again = new Store(reopen());
    expect(again.listShares()).toEqual([{ ...share('bbbb', 2), upTo: { messageId: 'm9', agentName: 'builder' } }, share('aaaa', 1)]);
    expect(again.getShare('aaaa')).toEqual(share('aaaa', 1));
  });

  it('keeps how many files went along and their gist, and a files gist left without its page', () => {
    const store = new Store(db);
    store.create({ ...sampleConversation(), id: 'c1' });
    store.addShare({ ...share('aaaa', 1), files: 3, filesGist: 'ffff' });
    store.addShare({ ...share('bbbb', 2), url: '', files: 1, unfinished: true });
    const again = new Store(reopen());
    expect(again.getShare('aaaa')).toEqual({ ...share('aaaa', 1), files: 3, filesGist: 'ffff' });
    expect(again.getShare('bbbb')).toEqual({ ...share('bbbb', 2), url: '', files: 1, unfinished: true });

    // Shares from before schema version 16 took no files along.
    db.exec(`ALTER TABLE shares DROP COLUMN files; ALTER TABLE shares DROP COLUMN files_gist; ALTER TABLE shares DROP COLUMN unfinished;
             ALTER TABLE conversations DROP COLUMN branch;
             DROP TABLE auth_sessions; DROP TABLE auth_codes;
             DROP TABLE provider_accounts; ALTER TABLE provider_settings DROP COLUMN account_label;
             ALTER TABLE conversation_agents DROP COLUMN account; ALTER TABLE preset_agents DROP COLUMN account;
             ALTER TABLE agent_sessions DROP COLUMN account;
             ALTER TABLE conversations DROP COLUMN extra_cwds; ALTER TABLE messages DROP COLUMN more_changes;
             DROP TABLE model_backends; ALTER TABLE agent_sessions DROP COLUMN permission; ALTER TABLE agent_sessions DROP COLUMN by_cli; ALTER TABLE provider_settings DROP COLUMN sandbox_terminal;
             DROP TABLE deleted_endpoints; ALTER TABLE agent_sessions DROP COLUMN backend;
             PRAGMA user_version = 15;`);
    const migrated = new Store(reopen());
    expect(migrated.getShare('aaaa')).toEqual(share('aaaa', 1));
    expect(migrated.getShare('bbbb')).toEqual({ ...share('bbbb', 2), url: '' });
  });

  it('puts a share in the place of its files gist, recorded while it was made, in one step', () => {
    const store = new Store(db);
    store.create({ ...sampleConversation(), id: 'c1' });
    store.addShare({ ...share('ffff', 1), url: '', files: 2, unfinished: true });
    store.addShare(share('aaaa', 2));
    store.replaceShare('ffff', { ...share('bbbb', 3), files: 2, filesGist: 'ffff' });
    expect(store.listShares()).toEqual([{ ...share('bbbb', 3), files: 2, filesGist: 'ffff' }, share('aaaa', 2)]);
    expect(store.getShare('ffff')).toBeUndefined();
  });

  it('says when its conversation was deleted, and forgets a share', () => {
    const store = new Store(db);
    store.addShare(share('aaaa', 1));
    expect(store.listShares()).toEqual([{ ...share('aaaa', 1), conversationGone: true }]);
    store.deleteShare('aaaa');
    expect(store.listShares()).toEqual([]);
    expect(store.getShare('aaaa')).toBeUndefined();
  });
});

describe('Store search', () => {
  const msg = (id: string, kind: 'user' | 'agent' | 'system', text: string): ChatMessage => ({
    id,
    author: kind === 'agent' ? { kind, agentId: 'a1' } : { kind },
    createdAt: 1,
    parts: [{ type: 'text', text }],
    status: 'done',
  });

  function seed(store: Store): void {
    const add = (id: string, title: string, updatedAt: number, messages: ChatMessage[]) => {
      const conv: Conversation = { ...sampleConversation(), id, title, updatedAt, messages: [] };
      store.create(conv);
      for (const m of messages) {
        conv.messages.push(m);
        store.saveMessage(id, m);
      }
    };
    add('react', 'Sidebar layout', 30, [
      msg('r1', 'user', 'How do I make the React sidebar collapsible?'),
      msg('r2', 'agent', 'Use a CSS grid and a toggle. The sidebar keeps its width…'),
    ]);
    add('zh', '資料庫遷移', 20, [msg('z1', 'user', '請幫我把 SQLite 資料庫的 schema 升級，順便加上索引')]);
    add('title', 'React hooks notes', 10, []);
    add('system', 'Quiet', 40, [msg('s1', 'system', 'React stopped')]);
    add('like', 'Odd', 5, [msg('l1', 'user', 'progress is 100% done_now')]);
  }

  it('finds conversations by what was written in them, every word, ignoring case', () => {
    const store = new Store(db);
    seed(store);
    expect(store.search('')).toEqual([]);
    // Title matches first, then the most recent; system notes are not searched.
    expect(store.search('react').map((r) => r.id)).toEqual(['title', 'react']);
    expect(store.search('REACT collapsible').map((r) => r.id)).toEqual(['react']);
    expect(store.search('react nothing-like-this')).toEqual([]);
    // Words may be found in different messages, or in the title.
    expect(store.search('layout toggle').map((r) => r.id)).toEqual(['react']);
    // Chinese: any part of a word.
    expect(store.search('資料庫').map((r) => r.id)).toEqual(['zh']);
    expect(store.search('索引').map((r) => r.id)).toEqual(['zh']);
    // % and _ are plain characters.
    expect(store.search('100%').map((r) => r.id)).toEqual(['like']);
    expect(store.search('e_n').map((r) => r.id)).toEqual(['like']);
    expect(store.search('0_d')).toEqual([]);
  });

  it('says what a branched conversation was branched from: its title now, or as it was once deleted', () => {
    const store = new Store(db);
    seed(store);
    const branch = (id: string, fromId: string) =>
      store.create({ ...sampleConversation(), id, title: `Sidebar ${id}`, branch: { fromId, fromTitle: 'Old name', afterId: 'r2' } });
    branch('kept', 'react');
    branch('orphan', 'gone');
    const hits = Object.fromEntries(store.search('sidebar').map((r) => [r.id, r.branchFrom]));
    expect(hits).toEqual({ react: undefined, kept: 'Sidebar layout', orphan: 'Old name' });
  });

  it('says where it matched and in how many messages', () => {
    const store = new Store(db);
    seed(store);
    const [hit] = store.search('sidebar');
    expect(hit).toMatchObject({ id: 'react', title: 'Sidebar layout', updatedAt: 30, matches: 2 });
    expect(hit!.snippet).toContain('sidebar');
    expect(store.search('hooks')[0]).toEqual({ id: 'title', title: 'React hooks notes', updatedAt: 10, matches: 0 });
  });

  it('searches replies that are still being written', () => {
    const store = new Store(db);
    const conv: Conversation = { ...sampleConversation(), messages: [] };
    store.create(conv);
    const reply = { ...msg('live', 'agent', 'streaming answer about kubernetes'), status: 'streaming' as const };
    conv.messages.push(reply);
    store.saveMessage(conv.id, reply); // debounced, not written yet
    expect(store.search('kubernetes').map((r) => r.id)).toEqual([conv.id]);
  });
});

describe('Store write errors', () => {
  it('keeps streamed messages pending and retries when a batched write fails, instead of throwing from the timer', () => {
    vi.useFakeTimers();
    try {
      const store = new Store(db);
      const conv = sampleConversation();
      store.create(conv);
      conv.messages.push(userMsg);
      const original = (store as any).writeMessages.bind(store);
      let failures = 1;
      (store as any).writeMessages = (...args: unknown[]) => {
        if (failures-- > 0) throw new Error('database is locked');
        return original(...args);
      };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      store.saveMessage(conv.id, userMsg); // batched: written by a timer
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(errors).toHaveBeenCalled();
      vi.advanceTimersByTime(5000); // the retry
      errors.mockRestore();
      expect(new Store(db).get(conv.id)!.messages.map((m) => m.id)).toEqual(['m1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SettingsStore (SQLite)', () => {
  it('persists provider settings and keeps the database private', () => {
    const s = new SettingsStore(db);
    s.update('grok', { apiKey: 'xai-1234567890', bin: '/opt/grok' });
    s.updateAccount('grok', '', { defaultModel: 'grok-4.7', defaultEffort: 'high' });
    s.setDefaultCwd('/work');

    const again = new SettingsStore(reopen());
    expect(again.bin('grok')).toBe('/opt/grok');
    expect(again.defaultModel('grok')).toBe('grok-4.7');
    expect(again.defaultEffort('grok')).toBe('high');
    expect(again.env('grok').XAI_API_KEY).toBe('xai-1234567890');
    expect(again.view().providers.find((p) => p.provider === 'grok')!.apiKeyMasked).toBe('••••');
    expect(again.defaultCwd).toBe('/work');
    // (Windows has no permission bits: the user's own folder keeps it private there.)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('gives each CLI its own home in the agent home folder, in place of the one the server was started with', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/users/me/.claude-personal');
    vi.stubEnv('CODEX_HOME', '');
    try {
      const s = new SettingsStore(db);
      // Off: each CLI keeps the home it would have anyway.
      expect(s.agentHomeFor('claude')).toBeUndefined();
      expect(s.env('claude').CLAUDE_CONFIG_DIR).toBe('/users/me/.claude-personal');

      const home = join(dir, 'relay-agents');
      s.setAgentHome(home);
      s.setAgentsViewUrl('http://127.0.0.1:9999');
      s.setAgentsViewLink('https://my-computer.tail1234.ts.net:9999/');
      const again = new SettingsStore(reopen());
      expect(again.env('claude').CLAUDE_CONFIG_DIR).toBe(join(home, 'claude'));
      expect(again.env('codex').CODEX_HOME).toBe(join(home, 'codex'));
      expect(again.env('grok').GROK_HOME).toBe(join(home, 'grok'));
      expect(again.env('cursor').CURSOR_CONFIG_DIR).toBe(join(home, 'cursor'));
      // Only its own variable: Claude Code does not get Codex's home.
      expect(again.env('claude').CODEX_HOME).toBe('');
      // Created, since Codex refuses a CODEX_HOME that does not exist.
      expect(statSync(join(home, 'codex')).isDirectory()).toBe(true);
      expect(again.view()).toMatchObject({
        agentHome: home,
        agentsViewUrl: 'http://127.0.0.1:9999',
        agentsViewLink: 'https://my-computer.tail1234.ts.net:9999/',
      });

      again.setAgentHome('');
      again.setAgentsViewUrl('');
      const off = new SettingsStore(reopen());
      expect(off.env('claude').CLAUDE_CONFIG_DIR).toBe('/users/me/.claude-personal');
      expect(off.view()).toMatchObject({ agentHome: '', agentsViewUrl: '' });
      // The open agents' homes are back in the data folder, and the folder they were in is remembered:
      // a run is kept from what runs kept there, and a deleted conversation's state goes from there too.
      expect(off.openAgentHome('opencode')).toBe(join(OPEN_HOMES_DIR, 'opencode'));
      expect(off.openAgentHomes('opencode')).toEqual([join(OPEN_HOMES_DIR, 'opencode'), join(home, 'opencode')]);
      expect(JSON.parse(off.env('opencode')[OPEN_AGENT_ROOTS_ENV]!)).toEqual([home]);
      off.setAgentHome(home);
      expect(new SettingsStore(reopen()).openAgentRoots()).toEqual([home, OPEN_HOMES_DIR]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still points the CLI at its home when the folder cannot be created, and says so", () => {
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, '');
    const s = new SettingsStore(db);
    s.setAgentHome(blocker); // a file: its subfolders cannot be made
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(s.env('codex').CODEX_HOME).toBe(join(blocker, 'codex'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not create'));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps what each CLI's runs leave out, only what that CLI can leave out", () => {
    const s = new SettingsStore(db);
    s.updateAccount('grok', '', { nativeOff: ['instructions', 'mcp', 'skills', 'mcp'] });
    s.updateAccount('claude', '', { nativeOff: ['memory', 'instructions'] });

    const again = new SettingsStore(reopen());
    expect(again.nativeOff('grok')).toEqual(['skills', 'mcp']); // Grok cannot leave out instruction files
    expect(again.nativeOff('claude')).toEqual(['instructions', 'memory']);
    expect(again.nativeOff('codex')).toEqual([]);
    expect(again.view().providers.find((p) => p.provider === 'grok')!.accounts[0]!.nativeOff).toEqual(['skills', 'mcp']);
    again.updateAccount('claude', '', { nativeOff: [] });
    const cleared = new SettingsStore(reopen());
    expect(cleared.nativeOff('claude')).toEqual([]);

    // Hooks, subagents and plugins: Claude Code all three, Codex no subagents, Grok only hooks.
    cleared.updateAccount('claude', '', { nativeOff: ['plugins', 'agents', 'hooks'] });
    cleared.updateAccount('codex', '', { nativeOff: ['plugins', 'agents', 'hooks'] });
    cleared.updateAccount('grok', '', { nativeOff: ['plugins', 'agents', 'hooks', 'skills'] });
    const later = new SettingsStore(reopen());
    expect(later.nativeOff('claude')).toEqual(['hooks', 'agents', 'plugins']);
    expect(later.nativeOff('codex')).toEqual(['hooks', 'plugins']);
    expect(later.nativeOff('grok')).toEqual(['skills', 'hooks']);
  });

  it("keeps whether OpenHands may use a terminal in the sandbox: off until turned on, only for OpenHands", () => {
    const s = new SettingsStore(db);
    expect(s.sandboxTerminal('openhands')).toBe(false);
    expect(s.view().providers.find((p) => p.provider === 'openhands')!.sandboxTerminal).toBe(false);
    s.update('openhands', { sandboxTerminal: true });
    s.update('opencode', { sandboxTerminal: true }); // needs none: stays off
    const again = new SettingsStore(reopen());
    expect(again.sandboxTerminal('openhands')).toBe(true);
    expect(again.sandboxTerminal('opencode')).toBe(false);
    expect(again.view().providers.find((p) => p.provider === 'openhands')!.sandboxTerminal).toBe(true);
    // Other changes keep it; turning it off is kept too.
    again.updateAccount('openhands', '', { defaultModel: 'openai/gpt-5.4-nano' });
    const later = new SettingsStore(reopen());
    expect(later.sandboxTerminal('openhands')).toBe(true);
    later.update('openhands', { sandboxTerminal: false });
    expect(new SettingsStore(reopen()).sandboxTerminal('openhands')).toBe(false);
  });

  it("keeps the single items each CLI's runs leave out, only kinds that CLI can leave out alone", () => {
    const s = new SettingsStore(db);
    expect(s.nativeItems('claude')).toEqual({});
    s.updateAccount('claude', '', { nativeItems: { skills: ['commit', 'commit'], tools: ['WebSearch'], hooks: ['h1'], instructions: [] } });
    s.updateAccount('codex', '', { nativeItems: { hooks: ['h1'], tools: ['Bash'], mcpTools: ['["node","js"]'] } });
    s.updateAccount('grok', '', { nativeItems: { skills: ['x'] } });

    const again = new SettingsStore(reopen());
    // Claude Code cannot leave out one hook, Codex lists no built-in tools, Grok can leave out no single item.
    expect(again.nativeItems('claude')).toEqual({ skills: ['commit'], tools: ['WebSearch'] });
    expect(again.nativeItems('codex')).toEqual({ mcpTools: ['["node","js"]'], hooks: ['h1'] });
    expect(again.nativeItems('grok')).toEqual({});
    expect(again.view().providers.find((p) => p.provider === 'claude')!.accounts[0]!.nativeItems).toEqual({ skills: ['commit'], tools: ['WebSearch'] });
    // A copy: changing it changes nothing stored.
    again.nativeItems('claude').skills!.push('other');
    expect(again.nativeItems('claude').skills).toEqual(['commit']);
    // Other updates keep them; an empty object clears them.
    again.updateAccount('claude', '', { defaultModel: 'opus' });
    again.update('claude', { bin: '/opt/claude' });
    const kept = new SettingsStore(reopen());
    expect(kept.nativeItems('claude')).toEqual({ skills: ['commit'], tools: ['WebSearch'] });
    kept.updateAccount('claude', '', { nativeItems: {} });
    expect(new SettingsStore(reopen()).nativeItems('claude')).toEqual({});
  });

  it('keeps API keys in the system keyring, never in the database', () => {
    const keyring = fakeKeyring();
    const s = new SettingsStore(db, keyring);
    s.update('claude', { apiKey: 'sk-ant-secret-1234' });
    s.update('codex', { bin: '/opt/codex' });

    expect(keyring.data.get('claude-api-key')).toBe('sk-ant-secret-1234');
    expect(storedKeys()).toEqual(['', '']);
    expect(s.env('claude').ANTHROPIC_API_KEY).toBe('sk-ant-secret-1234');
    const view = (v: SettingsStore) => Object.fromEntries(v.view().providers.map((p) => [p.provider, p.apiKeyStorage]));
    expect(view(s)).toEqual({ claude: 'keychain', codex: undefined, grok: 'keychain', cursor: 'keychain' });

    const again = new SettingsStore(reopen(), keyring);
    expect(again.env('claude').ANTHROPIC_API_KEY).toBe('sk-ant-secret-1234');
    expect(again.view().providers[0]!.apiKeyMasked).toBe('••••');

    again.update('claude', { apiKey: null });
    expect(keyring.data.has('claude-api-key')).toBe(false);
    expect(new SettingsStore(reopen(), keyring).env('claude').ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    expect(readFileSync(file).includes('sk-ant-secret')).toBe(false);
  });

  it('moves keys saved in the database into the keyring and scrubs them', () => {
    new SettingsStore(db).update('grok', { apiKey: 'xai-old-plaintext' });
    expect(storedKeys()).toEqual(['xai-old-plaintext']);

    const keyring = fakeKeyring();
    const s = new SettingsStore(reopen(), keyring);
    expect(keyring.data.get('grok-api-key')).toBe('xai-old-plaintext');
    expect(storedKeys()).toEqual(['']);
    expect(s.env('grok').XAI_API_KEY).toBe('xai-old-plaintext');
    // Checked while the database is still open (closing would checkpoint it anyway).
    for (const f of [file, `${file}-wal`]) {
      expect(statSync(f, { throwIfNoEntry: false }) ? readFileSync(f).includes('xai-old-plaintext') : false).toBe(false);
    }
  });

  it('leaves a key in the database when the keyring refuses it, and reports failed saves', () => {
    new SettingsStore(db).update('grok', { apiKey: 'xai-stays-here' });
    const broken: SecretStore = {
      storage: 'secret-service',
      get: () => null,
      set: () => {
        throw new Error('collection is locked');
      },
      delete: () => {},
    };
    const s = new SettingsStore(reopen(), broken);
    expect(s.env('grok').XAI_API_KEY).toBe('xai-stays-here');
    expect(storedKeys()).toEqual(['xai-stays-here']);
    expect(s.view().providers.find((p) => p.provider === 'grok')!.apiKeyStorage).toBe('database');

    expect(() => s.update('claude', { apiKey: 'sk-ant-x' })).toThrow(/collection is locked/);
    expect(s.env('claude').ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    s.update('grok', { apiKey: null }); // removing still works, and clears the database copy
    expect(storedKeys()).toEqual(['']);
  });
});

describe('SettingsStore accounts', () => {
  it("gives each account besides a CLI's default one its own home and its own key, and keeps them", () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-the-shell');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/users/me/.claude');
    try {
      const s = new SettingsStore(db);
      const home = join(dir, 'agents');
      s.setAgentHome(home);
      const work = s.addAccount('claude', '  Work  ');
      const alt = s.addAccount('claude', 'Alt');
      const second = s.addAccount('codex', 'Second');
      expect(work).toMatch(/^[0-9a-f]{8}$/);
      expect(new Set([work, alt, second]).size).toBe(3);
      s.updateAccount('claude', work, { apiKey: 'sk-ant-work-123456' });
      s.updateAccount('claude', '', { label: 'Personal' });

      const again = new SettingsStore(reopen());
      expect(again.accountIds('claude')).toEqual([work, alt]);
      expect(again.accountIds('codex')).toEqual([second]);
      expect(again.accountLabel('claude', work)).toBe('Work');
      expect(again.accountLabel('claude')).toBe('Personal');
      // Each account in a folder of its own; the default account as before.
      expect(again.env('claude').CLAUDE_CONFIG_DIR).toBe(join(home, 'claude'));
      expect(again.env('claude', work).CLAUDE_CONFIG_DIR).toBe(join(home, `claude-${work}`));
      expect(again.env('codex', second).CODEX_HOME).toBe(join(home, `codex-${second}`));
      expect(statSync(join(home, `codex-${second}`)).isDirectory()).toBe(true);
      // Its own key only: the key the server was started with is the default account's.
      expect(again.env('claude', work).ANTHROPIC_API_KEY).toBe('sk-ant-work-123456');
      expect(again.env('claude', alt).ANTHROPIC_API_KEY).toBeUndefined();
      expect(again.env('claude').ANTHROPIC_API_KEY).toBe('sk-ant-from-the-shell');
      expect(again.hasStoredApiKey('claude', work)).toBe(true);
      expect(again.hasStoredApiKey('claude', alt)).toBe(false);
      // An account another CLI has, or none it knows, is the default account.
      expect(again.resolveAccount('codex', work)).toBe('');
      expect(again.env('codex', work).CODEX_HOME).toBe(join(home, 'codex'));
      expect(again.accountHomes()).toEqual([join(home, `claude-${work}`), join(home, `claude-${alt}`), join(home, `codex-${second}`)]);

      const claude = again.view().providers.find((p) => p.provider === 'claude')!;
      const run = { defaultModel: '', defaultEffort: '', nativeOff: [], nativeItems: {} };
      expect(claude.accounts).toEqual([
        { id: '', label: 'Personal', apiKeyMasked: '', apiKeyStorage: 'database', home: join(home, 'claude'), ...run },
        { id: work, label: 'Work', apiKeyMasked: '••••', apiKeyStorage: 'database', home: join(home, `claude-${work}`), ...run },
        { id: alt, label: 'Alt', apiKeyMasked: '', apiKeyStorage: 'database', home: join(home, `claude-${alt}`), ...run },
      ]);
      expect(again.view().providers.find((p) => p.provider === 'codex')!.accounts.map((a) => a.apiKeyStorage)).toEqual([undefined, undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives an account besides the default one none of the credentials in the server's environment", () => {
    const inherited = {
      ANTHROPIC_API_KEY: 'sk-ant-shell',
      ANTHROPIC_AUTH_TOKEN: 'shell-bearer',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-shell',
      CODEX_API_KEY: 'codex-shell',
      OPENAI_API_KEY: 'sk-openai-shell',
      XAI_API_KEY: 'xai-shell',
    };
    for (const [k, v] of Object.entries(inherited)) vi.stubEnv(k, v);
    try {
      const s = new SettingsStore(db);
      s.setAgentHome(join(dir, 'agents'));
      const ids = { claude: s.addAccount('claude', 'Work'), codex: s.addAccount('codex', 'Work'), grok: s.addAccount('grok', 'Work') };
      s.updateAccount('grok', ids.grok, { apiKey: 'xai-own-key' });
      const pick = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.keys(inherited).map((k) => [k, env[k]]).filter(([, v]) => v !== undefined));
      // The default accounts keep what the server was started with.
      expect(pick(s.env('claude'))).toEqual(inherited);
      // The others: nothing that would sign them in as someone else, only their own key.
      const others = (['claude', 'codex', 'grok'] as const).map((p) => [p, pick(s.env(p, ids[p]))]);
      expect(Object.fromEntries(others)).toEqual({
        claude: { CODEX_API_KEY: 'codex-shell', OPENAI_API_KEY: 'sk-openai-shell', XAI_API_KEY: 'xai-shell' },
        codex: { ANTHROPIC_API_KEY: 'sk-ant-shell', ANTHROPIC_AUTH_TOKEN: 'shell-bearer', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-shell', XAI_API_KEY: 'xai-shell' },
        grok: { ANTHROPIC_API_KEY: 'sk-ant-shell', ANTHROPIC_AUTH_TOKEN: 'shell-bearer', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-shell', CODEX_API_KEY: 'codex-shell', OPENAI_API_KEY: 'sk-openai-shell', XAI_API_KEY: 'xai-own-key' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps Cursor's one sign-in to its default account: a key or another account signs in for the run only", () => {
    vi.stubEnv('CURSOR_API_KEY', '');
    vi.stubEnv('CURSOR_AUTH_TOKEN', '');
    vi.stubEnv('AGENT_CLI_CREDENTIAL_STORE', '');
    try {
      const s = new SettingsStore(db);
      const team = s.addAccount('cursor', 'Team');
      const store = (account?: string) => s.env('cursor', account).AGENT_CLI_CREDENTIAL_STORE;
      // The default account uses the sign-in Cursor keeps for this computer user.
      expect(store()).toBe('');
      // Another account never reads or replaces it, key or no key.
      expect(store(team)).toBe('memory');
      s.updateAccount('cursor', team, { apiKey: 'key_team' });
      expect(s.env('cursor', team)).toMatchObject({ CURSOR_API_KEY: 'key_team', AGENT_CLI_CREDENTIAL_STORE: 'memory' });
      // A key of the default account's (or the server's own) is not saved over the sign-in either.
      s.updateAccount('cursor', '', { apiKey: 'key_default' });
      expect(s.env('cursor')).toMatchObject({ CURSOR_API_KEY: 'key_default', AGENT_CLI_CREDENTIAL_STORE: 'memory' });
      s.updateAccount('cursor', '', { apiKey: null });
      vi.stubEnv('CURSOR_AUTH_TOKEN', 'shell-token');
      expect(store()).toBe('memory');
      // The server's own credentials are the default account's only.
      const other = s.addAccount('cursor', 'Other');
      expect([s.env('cursor', other).CURSOR_AUTH_TOKEN, s.env('cursor').CURSOR_AUTH_TOKEN]).toEqual([undefined, 'shell-token']);
      // Other CLIs are left alone.
      expect(s.env('claude', s.addAccount('claude', 'Work')).AGENT_CLI_CREDENTIAL_STORE).toBe('');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives each account its own default model, effort and what its runs leave out, and keeps them', () => {
    const s = new SettingsStore(db);
    s.updateAccount('claude', '', { defaultModel: 'opus', defaultEffort: 'high', nativeOff: ['hooks'], nativeItems: { skills: ['commit'] } });
    const work = s.addAccount('claude', 'Work');
    // A new account's home is empty: it starts with the CLI's own defaults and leaves nothing out.
    expect(s.defaultModel('claude', work)).toBe('');
    expect(s.defaultEffort('claude', work)).toBe('');
    expect(s.nativeOff('claude', work)).toEqual([]);
    expect(s.nativeItems('claude', work)).toEqual({});

    s.updateAccount('claude', work, {
      defaultModel: ' sonnet ',
      defaultEffort: 'low',
      nativeOff: ['mcp', 'skills', 'rules' as never],
      nativeItems: { tools: ['WebSearch'], hooks: ['h1'] },
    });
    const again = new SettingsStore(reopen());
    // Each its own; what the CLI cannot leave out is dropped.
    expect([again.defaultModel('claude'), again.defaultEffort('claude'), again.nativeOff('claude'), again.nativeItems('claude')]).toEqual([
      'opus',
      'high',
      ['hooks'],
      { skills: ['commit'] },
    ]);
    expect([again.defaultModel('claude', work), again.defaultEffort('claude', work), again.nativeOff('claude', work), again.nativeItems('claude', work)]).toEqual([
      'sonnet',
      'low',
      ['skills', 'mcp'],
      { tools: ['WebSearch'] },
    ]);
    expect(again.view().providers.find((p) => p.provider === 'claude')!.accounts).toMatchObject([
      { id: '', defaultModel: 'opus', defaultEffort: 'high', nativeOff: ['hooks'], nativeItems: { skills: ['commit'] } },
      { id: work, defaultModel: 'sonnet', defaultEffort: 'low', nativeOff: ['skills', 'mcp'], nativeItems: { tools: ['WebSearch'] } },
    ]);
    // Copies: changing them changes nothing stored.
    again.nativeOff('claude', work).push('memory');
    again.nativeItems('claude', work).tools!.push('Bash');
    expect(again.nativeOff('claude', work)).toEqual(['skills', 'mcp']);
    expect(again.nativeItems('claude', work)).toEqual({ tools: ['WebSearch'] });
    // Renaming it, or the CLI's executable, keeps them.
    again.updateAccount('claude', work, { label: 'Office' });
    again.update('claude', { bin: '/opt/claude' });
    const later = new SettingsStore(reopen());
    expect(later.defaultModel('claude', work)).toBe('sonnet');

    // An account the CLI does not have (another CLI's, or one removed since) runs as the default account.
    const codex = later.addAccount('codex', 'Second');
    expect(later.defaultModel('codex', work)).toBe('');
    expect(later.defaultModel('claude', codex)).toBe('opus');
    expect(later.nativeOff('claude', 'gone')).toEqual(['hooks']);
    later.removeAccount('claude', work);
    expect(later.defaultModel('claude', work)).toBe('opus');
    expect(later.nativeItems('claude', work)).toEqual({ skills: ['commit'] });
    // Updating an account that is gone changes nothing.
    later.updateAccount('claude', work, { defaultModel: 'haiku' });
    expect(later.defaultModel('claude')).toBe('opus');
  });

  it("gives the accounts there were before schema version 20 their CLI's defaults and what it left out", () => {
    const s = new SettingsStore(db);
    s.updateAccount('claude', '', { defaultModel: 'opus', defaultEffort: 'max', nativeOff: ['plugins'], nativeItems: { tools: ['WebFetch'] } });
    const work = s.addAccount('claude', 'Work');
    const grok = s.addAccount('grok', 'Team');
    db.exec(`ALTER TABLE provider_accounts DROP COLUMN default_model; ALTER TABLE provider_accounts DROP COLUMN default_effort;
             ALTER TABLE provider_accounts DROP COLUMN native_off; ALTER TABLE provider_accounts DROP COLUMN native_items;
             ALTER TABLE conversations DROP COLUMN extra_cwds; ALTER TABLE messages DROP COLUMN more_changes;
             DROP TABLE model_backends; ALTER TABLE agent_sessions DROP COLUMN permission; ALTER TABLE agent_sessions DROP COLUMN by_cli; ALTER TABLE provider_settings DROP COLUMN sandbox_terminal;
             DROP TABLE deleted_endpoints; ALTER TABLE agent_sessions DROP COLUMN backend;
             PRAGMA user_version = 19;`);
    const migrated = new SettingsStore(reopen());
    // They run as before: as the CLI did, for every account.
    expect([migrated.defaultModel('claude', work), migrated.defaultEffort('claude', work)]).toEqual(['opus', 'max']);
    expect(migrated.nativeOff('claude', work)).toEqual(['plugins']);
    expect(migrated.nativeItems('claude', work)).toEqual({ tools: ['WebFetch'] });
    // A CLI with no settings saved: the defaults, nothing left out.
    expect([migrated.defaultModel('grok', grok), migrated.nativeOff('grok', grok), migrated.nativeItems('grok', grok)]).toEqual(['', [], {}]);
  });

  it("keeps the other accounts' homes in the data folder when the CLIs have no folder of their own", async () => {
    const { ACCOUNTS_DIR } = await import('../src/server/settings');
    const s = new SettingsStore(db);
    const id = s.addAccount('grok', 'Team');
    expect(s.accountsDir).toBe(ACCOUNTS_DIR);
    expect(s.accountHome('grok', id)).toBe(join(ACCOUNTS_DIR, `grok-${id}`));
    expect(s.accountHome('grok')).toBeUndefined(); // the CLI's usual home
  });

  it('forgets a removed account with its key, and the lead agent goes back to the default account', () => {
    const keyring = fakeKeyring();
    const s = new SettingsStore(db, keyring);
    s.setAgentHome(join(dir, 'agents'));
    const work = s.addAccount('grok', 'Work');
    const other = s.addAccount('grok', 'Other');
    s.updateAccount('grok', work, { apiKey: 'xai-work-key-1234' });
    expect(keyring.data.get(`grok-api-key-${work}`)).toBe('xai-work-key-1234');
    expect(readFileSync(file).includes('xai-work-key')).toBe(false);
    s.setLead({ provider: 'grok', account: work });
    expect(new SettingsStore(reopen(), keyring).lead).toEqual({ provider: 'grok', account: work });

    const again = new SettingsStore(db, keyring);
    expect(again.env('grok', work).XAI_API_KEY).toBe('xai-work-key-1234');
    expect(again.removeAccount('grok', work)).toBe(join(dir, 'agents', `grok-${work}`));
    expect(keyring.data.has(`grok-api-key-${work}`)).toBe(false);
    expect(again.lead).toEqual({ provider: 'grok' });
    expect(again.removeAccount('grok', work)).toBeUndefined();
    const later = new SettingsStore(reopen(), keyring);
    expect(later.accountIds('grok')).toEqual([other]);
    expect(later.lead.account).toBeUndefined();
    // A lead naming an account the CLI does not have runs as the default one.
    later.setLead({ provider: 'claude', account: other });
    expect(later.lead).toEqual({ provider: 'claude' });
  });

  it('moves an account key saved in the database into the keyring', () => {
    const s = new SettingsStore(db);
    const id = s.addAccount('claude', 'Work');
    s.updateAccount('claude', id, { apiKey: 'sk-ant-old-plaintext' });
    expect((db.prepare('SELECT api_key FROM provider_accounts').get() as { api_key: string }).api_key).toBe('sk-ant-old-plaintext');
    const keyring = fakeKeyring();
    const again = new SettingsStore(reopen(), keyring);
    expect(keyring.data.get(`claude-api-key-${id}`)).toBe('sk-ant-old-plaintext');
    expect((db.prepare('SELECT api_key FROM provider_accounts').get() as { api_key: string }).api_key).toBe('');
    expect(again.view().providers[0]!.accounts[1]).toMatchObject({ apiKeyMasked: '••••text', apiKeyStorage: 'keychain' });
  });
});

describe('Store accounts', () => {
  it('keeps the account of each member, of each template member and of each agent session', () => {
    const store = new Store(db);
    const conv = sampleConversation();
    conv.agents[1]!.account = 'ab12cd34';
    store.create(conv);
    store.saveAgentState(conv.id, 'a2', { provider: 'codex', account: 'ab12cd34', sessionId: 's-2', seen: [] });
    store.saveAgentState(conv.id, 'a1', { provider: 'claude', sessionId: 's-1', seen: [] });
    const preset: TeamPreset = {
      id: 'p-acc',
      name: 'Two accounts',
      agents: [{ id: 'x', name: 'Rev', provider: 'grok', role: '', account: '0011aabb' }, { id: 'y', name: 'Dev', provider: 'grok', role: '' }],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 3, permission: 'read-only' },
    };
    store.savePreset(preset);

    const again = new Store(reopen());
    const loaded = again.get(conv.id)!;
    expect(loaded.agents.map((a) => a.account)).toEqual([undefined, 'ab12cd34']);
    expect('account' in loaded.agents[0]!).toBe(false);
    expect(loaded.agentState).toEqual({
      a1: { provider: 'claude', sessionId: 's-1', seen: [] },
      a2: { provider: 'codex', account: 'ab12cd34', sessionId: 's-2', seen: [] },
    });
    expect(again.listPresets().find((p) => p.id === 'p-acc')!.agents.map((a) => a.account)).toEqual(['0011aabb', undefined]);
  });
});

function fakeKeyring(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    storage: 'keychain',
    data,
    get: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
  };
}

function storedKeys(): string[] {
  return (db.prepare('SELECT api_key FROM provider_settings ORDER BY provider').all() as { api_key: string }[]).map((r) => r.api_key);
}

describe('Store schedules', () => {
  const schedule: NonNullable<Conversation['schedule']> = {
    text: '每日檢查 @Builder',
    repeat: { kind: 'weekly', time: '09:00', days: [1, 3] },
    timeZone: 'Asia/Taipei',
    lang: 'zh-TW',
    enabled: true,
    approvals: 'ask',
    missed: 'run',
    newChat: false,
    updatedAt: 10,
    nextRunAt: 100,
    lastRunAt: 50,
    lastResult: 'failed',
    lastError: '工作目錄不存在',
  };

  it("keeps a conversation's schedule and the messages it sent, and lists it for the sidebar", () => {
    const store = new Store(db);
    const conv = sampleConversation();
    store.create(conv);
    conv.schedule = schedule;
    store.saveSchedule(conv);
    const sent: ChatMessage = { ...userMsg, id: 'sent', scheduled: true };
    conv.messages.push(sent);
    store.saveMessage(conv.id, sent, true);

    const reloaded = new Store(reopen());
    expect(reloaded.get(conv.id)!.schedule).toEqual(schedule);
    expect(reloaded.get(conv.id)!.messages[0]!.scheduled).toBe(true);
    const summary = { enabled: true, nextRunAt: 100, lastResult: 'failed', timeZone: 'Asia/Taipei' };
    expect(new Store(db).list(() => false)[0]!.schedule).toEqual(summary);
    expect(reloaded.list(() => false)[0]!.schedule).toEqual(summary); // from memory
    // An interval does not depend on a time zone: the browser shows it in its own.
    reloaded.get(conv.id)!.schedule = { ...schedule, repeat: { kind: 'interval', hours: 2 } };
    expect(reloaded.list(() => false)[0]!.schedule).toEqual({ enabled: true, nextRunAt: 100, lastResult: 'failed' });
  });

  it('finds the schedules that are on and due, and forgets one that is removed or whose conversation is deleted', () => {
    const store = new Store(db);
    const a = { ...sampleConversation(), id: 'a', schedule: { ...schedule, nextRunAt: 200 } };
    const b = { ...sampleConversation(), id: 'b', schedule: { ...schedule, nextRunAt: 100 } };
    const off = { ...sampleConversation(), id: 'off', schedule: { ...schedule, enabled: false, nextRunAt: 50 } };
    for (const c of [a, b, off]) {
      store.create(c);
      store.saveSchedule(c);
    }
    expect(store.dueSchedules(99)).toEqual([]);
    expect(store.dueSchedules(300)).toEqual(['b', 'a']); // the most overdue first

    b.schedule = undefined as never;
    store.saveSchedule(b);
    expect(new Store(db).get('b')!.schedule).toBeUndefined();
    expect(store.list(() => false).find((c) => c.id === 'b')!.schedule).toBeUndefined();

    store.delete('a');
    expect(store.dueSchedules(300)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schedules').get()).toEqual({ n: 1 }); // only the one switched off
  });

  it('keeps whether a schedule opens a new chat each time, and the chat it last opened', () => {
    const store = new Store(db);
    const conv = { ...sampleConversation(), schedule: { ...schedule, newChat: true, lastResult: 'sent' as const, lastChatId: 'chat-9' } };
    delete (conv.schedule as { lastError?: string }).lastError;
    store.create(conv);
    store.saveSchedule(conv);
    expect(new Store(reopen()).get(conv.id)!.schedule).toEqual(conv.schedule);

    // Schedules from before schema version 14 send in their own conversation.
    db.exec(`ALTER TABLE schedules DROP COLUMN new_chat; ALTER TABLE schedules DROP COLUMN last_chat_id;
             DROP TABLE shares; ALTER TABLE conversations DROP COLUMN branch;
             DROP TABLE auth_sessions; DROP TABLE auth_codes;
             DROP TABLE provider_accounts; ALTER TABLE provider_settings DROP COLUMN account_label;
             ALTER TABLE conversation_agents DROP COLUMN account; ALTER TABLE preset_agents DROP COLUMN account;
             ALTER TABLE agent_sessions DROP COLUMN account;
             ALTER TABLE conversations DROP COLUMN extra_cwds; ALTER TABLE messages DROP COLUMN more_changes;
             DROP TABLE model_backends; ALTER TABLE agent_sessions DROP COLUMN permission; ALTER TABLE agent_sessions DROP COLUMN by_cli; ALTER TABLE provider_settings DROP COLUMN sandbox_terminal;
             DROP TABLE deleted_endpoints; ALTER TABLE agent_sessions DROP COLUMN backend;
             PRAGMA user_version = 13;`);
    const migrated = new Store(reopen()).get(conv.id)!.schedule!;
    expect(migrated.newChat).toBe(false);
    expect(migrated.lastChatId).toBeUndefined();
  });
});
