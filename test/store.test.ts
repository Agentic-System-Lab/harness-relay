import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    again.deleteGroup('g1');
    expect(again.listGroups().map((g) => g.id)).toEqual(['g2']);
    expect(groupOf(again)).toEqual({ c1: undefined, c2: 'g2' });
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
    s.update('grok', { nativeOff: ['instructions', 'mcp', 'skills', 'mcp'] });
    s.update('claude', { nativeOff: ['memory', 'instructions'] });

    const again = new SettingsStore(reopen());
    expect(again.nativeOff('grok')).toEqual(['skills', 'mcp']); // Grok cannot leave out instruction files
    expect(again.nativeOff('claude')).toEqual(['instructions', 'memory']);
    expect(again.nativeOff('codex')).toEqual([]);
    expect(again.view().providers.find((p) => p.provider === 'grok')!.nativeOff).toEqual(['skills', 'mcp']);
    again.update('claude', { nativeOff: [] });
    const cleared = new SettingsStore(reopen());
    expect(cleared.nativeOff('claude')).toEqual([]);

    // Hooks, subagents and plugins: Claude Code all three, Codex no subagents, Grok only hooks.
    cleared.update('claude', { nativeOff: ['plugins', 'agents', 'hooks'] });
    cleared.update('codex', { nativeOff: ['plugins', 'agents', 'hooks'] });
    cleared.update('grok', { nativeOff: ['plugins', 'agents', 'hooks', 'skills'] });
    const later = new SettingsStore(reopen());
    expect(later.nativeOff('claude')).toEqual(['hooks', 'agents', 'plugins']);
    expect(later.nativeOff('codex')).toEqual(['hooks', 'plugins']);
    expect(later.nativeOff('grok')).toEqual(['skills', 'hooks']);
  });

  it("keeps the single items each CLI's runs leave out, only kinds that CLI can leave out alone", () => {
    const s = new SettingsStore(db);
    expect(s.nativeItems('claude')).toEqual({});
    s.update('claude', { nativeItems: { skills: ['commit', 'commit'], tools: ['WebSearch'], hooks: ['h1'], instructions: [] } });
    s.update('codex', { nativeItems: { hooks: ['h1'], tools: ['Bash'], mcpTools: ['["node","js"]'] } });
    s.update('grok', { nativeItems: { skills: ['x'] } });

    const again = new SettingsStore(reopen());
    // Claude Code cannot leave out one hook, Codex lists no built-in tools, Grok can leave out no single item.
    expect(again.nativeItems('claude')).toEqual({ skills: ['commit'], tools: ['WebSearch'] });
    expect(again.nativeItems('codex')).toEqual({ mcpTools: ['["node","js"]'], hooks: ['h1'] });
    expect(again.nativeItems('grok')).toEqual({});
    expect(again.view().providers.find((p) => p.provider === 'claude')!.nativeItems).toEqual({ skills: ['commit'], tools: ['WebSearch'] });
    // A copy: changing it changes nothing stored.
    again.nativeItems('claude').skills!.push('other');
    expect(again.nativeItems('claude').skills).toEqual(['commit']);
    // Other updates keep them; an empty object clears them.
    again.update('claude', { defaultModel: 'opus' });
    const kept = new SettingsStore(reopen());
    expect(kept.nativeItems('claude')).toEqual({ skills: ['commit'], tools: ['WebSearch'] });
    kept.update('claude', { nativeItems: {} });
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

describe('Store schedules', () => {
  const schedule: NonNullable<Conversation['schedule']> = {
    text: '每日檢查 @Builder',
    repeat: { kind: 'weekly', time: '09:00', days: [1, 3] },
    timeZone: 'Asia/Taipei',
    lang: 'zh-TW',
    enabled: true,
    approvals: 'ask',
    missed: 'run',
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
    expect(new Store(db).list(() => false)[0]!.schedule).toEqual({ enabled: true, nextRunAt: 100, lastResult: 'failed' });
    expect(reloaded.list(() => false)[0]!.schedule).toEqual({ enabled: true, nextRunAt: 100, lastResult: 'failed' }); // from memory
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
});
