import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, Conversation, TeamPreset } from '../src/shared/types';
import { openDatabase, type Database } from '../src/server/db';
import type { SecretStore } from '../src/server/secrets';
import { SettingsStore } from '../src/server/settings';
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
      { id: 'a1', name: 'Architect', provider: 'claude', role: '規劃', model: 'opus', effort: 'high' },
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

describe('SettingsStore (SQLite)', () => {
  it('persists provider settings and keeps the database private', () => {
    const s = new SettingsStore(db);
    s.update('grok', { apiKey: 'xai-1234567890', defaultModel: 'grok-4.7', defaultEffort: 'high', bin: '/opt/grok' });
    s.setDefaultCwd('/work');

    const again = new SettingsStore(reopen());
    expect(again.bin('grok')).toBe('/opt/grok');
    expect(again.defaultModel('grok')).toBe('grok-4.7');
    expect(again.defaultEffort('grok')).toBe('high');
    expect(again.env('grok').XAI_API_KEY).toBe('xai-1234567890');
    expect(again.view().providers.find((p) => p.provider === 'grok')!.apiKeyMasked).toBe('xai-…7890');
    expect(again.defaultCwd).toBe('/work');
    expect(statSync(file).mode & 0o777).toBe(0o600);
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
    expect(view(s)).toEqual({ claude: 'keychain', codex: undefined, grok: 'keychain' });

    const again = new SettingsStore(reopen(), keyring);
    expect(again.env('claude').ANTHROPIC_API_KEY).toBe('sk-ant-secret-1234');
    expect(again.view().providers[0]!.apiKeyMasked).toBe('sk-a…1234');

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
