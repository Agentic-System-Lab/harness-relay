import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  endpointEffort,
  inheritedEffort,
  isEndpointCli,
  parseBackendModel,
  type ModelBackendsView,
  type ProviderModels,
} from '../src/shared/types';
import type { SecretStore } from '../src/server/secrets';
import {
  endpointDraft,
  endpointProblems,
  endpointSlug,
  endpointUpdate,
  limitDraft,
  limitsShown,
  limitsTyped,
  normalizedBaseUrl,
  parseModelList,
  tokenCount,
  tokensTyped,
  validBaseUrl,
  withLimit,
} from '../src/web/backends';
import { effectiveLimits } from '../src/shared/modelLimits';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-backends-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { AuthStore } = await import('../src/server/auth');
const { SYSTEM_NET } = await import('../src/server/oauth/net');
const {
  ModelBackendStore,
  ENDPOINT_KEY_ENV,
  backendEnv,
  backendRun,
  endpointKeyEnv,
  endpointModel,
  endpointRunModel,
  parseModelLimits,
  savedLimits,
  urlHost,
} = await import('../src/server/backends');
const { endpointModelLimits, outputReserve, runLimits, toolOutputChars } = await import('../src/server/contextWindow');
const { reportedLimits } = await import('../src/server/endpointModels');
const { discoverModels, withEndpointModels } = await import('../src/server/models');
const { SettingsStore, OPEN_AGENT_HOME_ENV, OPEN_HOMES_DIR } = await import('../src/server/settings');
const { createApp } = await import('../src/server/app');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { Store } = await import('../src/server/store');
const { openAgents } = await import('../src/server/agents');
const { opencodeAcp } = await import('../src/server/agents/opencode');
const { withLang } = await import('../src/server/i18n');
const { AgentRunError } = await import('../src/server/agents/types');
const { maskSecret, openSecretStore } = await import('../src/server/secrets');
const { validEndpointUrl } = await import('../src/server/validate');

afterAll(() => rmSync(root, { recursive: true, force: true }));

let file: string;
let db: ReturnType<typeof openDatabase>;
let n = 0;

beforeEach(() => {
  file = join(root, `relay-${++n}.db`);
  db = openDatabase(file);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

function reopen() {
  db.close();
  db = openDatabase(file);
  return db;
}

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

const keyColumn = () =>
  (db.prepare('SELECT id, api_key FROM model_backends ORDER BY id').all() as { id: string; api_key: string }[]).map((r) => [
    r.id,
    r.api_key,
  ]);
const endpoint = { name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['muse-glimmer-30b-nvfp4'] };

describe('model ids', () => {
  it('reads <backend>/<model>: the backend up to the first slash, an API backend or an endpoint id', () => {
    expect(parseBackendModel('openai/gpt-5.4-nano')).toEqual({ backend: 'openai', model: 'gpt-5.4-nano' });
    expect(parseBackendModel(' xai/grok-4.3 ')).toEqual({ backend: 'xai', model: 'grok-4.3' });
    expect(parseBackendModel('homelab/Qwen/Qwen3-30B-A3B')).toEqual({ backend: 'homelab', model: 'Qwen/Qwen3-30B-A3B' });
    for (const bad of ['gpt-5.4-nano', '/x', 'openai/', 'Home Lab/x', '-lab/x', '']) expect(parseBackendModel(bad), bad).toBeUndefined();
  });
});

describe('ModelBackendStore', () => {
  it('keeps keys in the database without a credential store, and endpoints with their models', () => {
    const s = new ModelBackendStore(db);
    s.setApiKey('openai', 'sk-test-openai-1234');
    s.putEndpoint('homelab', { ...endpoint, apiKey: 'lab-key-5678' });
    const again = new ModelBackendStore(reopen());
    expect(again.view()).toEqual({
      apis: [
        { id: 'openai', keyMasked: '••••', keyStorage: 'database' },
        { id: 'anthropic', keyMasked: '', keyStorage: 'database' },
        { id: 'xai', keyMasked: '', keyStorage: 'database' },
      ],
      endpoints: [{ id: 'homelab', ...endpoint, keyMasked: '••••', keyStorage: 'database' }],
      deletedEndpoints: [],
    } satisfies ModelBackendsView);
    expect(again.configured()).toEqual(['openai', 'homelab']);
    expect(again.forRun()).toEqual({
      apis: { openai: 'sk-test-openai-1234' },
      endpoints: [{ id: 'homelab', ...endpoint, apiKey: 'lab-key-5678' }],
    });
    // Removing a key drops the API backend's row; the endpoint keeps its own.
    again.setApiKey('openai', null);
    again.putEndpoint('homelab', { ...endpoint, models: ['a', 'b'] });
    expect(keyColumn()).toEqual([['homelab', 'lab-key-5678']]);
    expect(new ModelBackendStore(reopen()).forRun().endpoints[0]).toMatchObject({ models: ['a', 'b'], apiKey: 'lab-key-5678' });
  });

  it("keeps each model's context window and output limit: the user's over the server's, for the models it lists", () => {
    const s = new ModelBackendStore(db);
    const models = ['qwen', 'llama', '__proto__'];
    s.putEndpoint(
      'homelab',
      { ...endpoint, models, limits: { llama: { output: 2048 } } },
      { qwen: { context: 32768 }, llama: { context: 8192 } },
    );
    const again = new ModelBackendStore(reopen());
    expect(again.view().endpoints[0]!.limits).toEqual({
      qwen: { reported: { context: 32768 } },
      llama: { output: 2048, reported: { context: 8192 } },
    });
    expect(again.forRun().endpoints[0]!.limits).toEqual({ qwen: { context: 32768 }, llama: { context: 8192, output: 2048 } });
    // The user's context window wins; a model of any name is a key like another.
    again.putEndpoint('homelab', { ...endpoint, models, limits: { qwen: { context: 16384 }, __proto__: { context: 4096 } } });
    expect(again.forRun().endpoints[0]!.limits).toEqual({
      qwen: { context: 16384 },
      llama: { context: 8192 },
      __proto__: { context: 4096 },
    });
    expect(Object.getPrototypeOf(again.forRun().endpoints[0]!.limits)).toBe(Object.prototype);
    // Without `limits`, the user's are kept; without `reported` (a new name only), the server's too.
    again.putEndpoint('homelab', { ...endpoint, name: 'Renamed', models });
    expect(again.view().endpoints[0]!.limits).toMatchObject({ qwen: { context: 16384, reported: { context: 32768 } } });
    // A model taken out takes its limits along; the server asked again replaces what it reported.
    again.putEndpoint('homelab', { ...endpoint, models: ['qwen'] }, {});
    expect(again.view().endpoints[0]!.limits).toEqual({ qwen: { context: 16384 } });
    // Another address: what the old server reported is of another server.
    again.putEndpoint('homelab', { ...endpoint, models: ['qwen'], limits: {} }, { qwen: { context: 32768 } });
    again.putEndpoint('homelab', { ...endpoint, baseUrl: 'http://10.0.0.6:8000/v1', models: ['qwen'] });
    expect(again.view().endpoints[0]).not.toHaveProperty('limits');
    expect(again.forRun().endpoints[0]).not.toHaveProperty('limits');
  });

  it('refuses an output limit that is not less than the context window the server reports, and changes nothing', () => {
    const s = new ModelBackendStore(db);
    s.putEndpoint('homelab', { ...endpoint, models: ['qwen'], limits: { qwen: { output: 8192 } } });
    const before = s.view();
    const err = withLang('en', () => {
      try {
        s.putEndpoint('homelab', { ...endpoint, name: 'Other', models: ['qwen'] }, { qwen: { context: 8192 } });
      } catch (e) {
        return e as Error & { status?: number };
      }
    });
    expect(err?.status).toBe(400);
    expect(err?.message).toMatch(/output limit of "qwen" \(8192 tokens\) must be less than its context window \(8192 tokens/);
    expect(s.view()).toEqual(before);
    expect(new ModelBackendStore(reopen()).view()).toEqual(before);
  });

  it('reads only figures Settings takes from what the database holds', () => {
    expect(parseModelLimits('not json')).toEqual({});
    expect(parseModelLimits('[1]')).toEqual({});
    expect(
      parseModelLimits(
        JSON.stringify({ a: { context: 32768, output: 0.5, reported: { context: 'x', output: 4096 } }, b: { context: 12 }, c: null }),
      ),
    ).toEqual({ a: { context: 32768, reported: { output: 4096 } } });
    expect(Object.keys(parseModelLimits('{"__proto__": {"context": 4096}}'))).toEqual(['__proto__']);
    // What a run uses: the user's over the server's; an output limit the window cannot hold, none.
    expect(effectiveLimits({ output: 1000, reported: { context: 8192, output: 9000 } })).toEqual({ context: 8192, output: 1000 });
    expect(effectiveLimits({ reported: { context: 8192, output: 8192 } })).toEqual({ context: 8192 });
    expect(effectiveLimits(undefined)).toEqual({});
    expect(savedLimits({ m: { context: 4096, reported: { context: 9000 } } }, { models: ['m'] }, undefined, true)).toEqual({
      m: { context: 4096 },
    });
  });

  it('gives a run its model’s limits, and the share each adapter keeps for an answer and a tool output', () => {
    const backends = {
      apis: {},
      endpoints: [
        { id: 'lab', name: 'Lab', baseUrl: 'http://h/v1', models: ['a', 'b'], limits: { a: { context: 32768 }, b: { output: 512 } } },
      ],
    };
    expect(runLimits(backends.endpoints[0], 'a')).toEqual({ context: 32768 });
    expect(runLimits(backends.endpoints[0], 'c')).toBeUndefined();
    expect(runLimits(backends.endpoints[0], 'toString')).toBeUndefined();
    expect(endpointModelLimits(backends, 'lab/b')).toEqual({ output: 512 });
    expect(endpointModelLimits(backends, 'openai/a')).toBeUndefined();
    expect(endpointModelLimits(backends, 'gone/a')).toBeUndefined();
    expect(outputReserve({ context: 32768 }, 32000)).toBe(8192);
    expect(outputReserve({ context: 1_000_000 }, 32000)).toBe(32000);
    expect(outputReserve({ context: 32768, output: 1000 }, 32000)).toBe(1000);
    expect(toolOutputChars(32768)).toBe(12288);
    // A run's backend carries the limits too.
    expect(backendRun(backends, 'lab/a', 'OpenCode').endpoint?.limits).toEqual({ a: { context: 32768 }, b: { output: 512 } });
  });

  it('keeps keys in the credential store, never in the database, under backend-<id> and endpoint-<id>', () => {
    const keyring = fakeKeyring();
    const s = new ModelBackendStore(db, keyring);
    s.setApiKey('anthropic', 'sk-ant-test-0000');
    s.putEndpoint('homelab', { ...endpoint, apiKey: 'lab-key-5678' });
    expect(Object.fromEntries(keyring.data)).toEqual({
      'backend-anthropic-api-key': 'sk-ant-test-0000',
      'endpoint-homelab-api-key': 'lab-key-5678',
    });
    expect(keyColumn()).toEqual([['homelab', '']]);
    expect(readFileSync(file).includes('sk-ant-test')).toBe(false);
    const again = new ModelBackendStore(reopen(), keyring);
    expect(again.view().apis[1]).toEqual({ id: 'anthropic', keyMasked: '••••', keyStorage: 'keychain' });
    expect(again.forRun().endpoints[0]!.apiKey).toBe('lab-key-5678');
    // An edit that leaves the key out keeps it; null removes it.
    again.putEndpoint('homelab', { ...endpoint, name: 'Lab' });
    expect(keyring.data.get('endpoint-homelab-api-key')).toBe('lab-key-5678');
    again.putEndpoint('homelab', { ...endpoint, apiKey: null });
    expect(keyring.data.has('endpoint-homelab-api-key')).toBe(false);
    // Deleting an endpoint removes its key first.
    again.putEndpoint('homelab', { ...endpoint, apiKey: 'again' });
    again.deleteEndpoint('homelab');
    expect(keyring.data.has('endpoint-homelab-api-key')).toBe(false);
    expect(keyColumn()).toEqual([]);
  });

  it('moves keys saved in the database into the credential store and scrubs them', () => {
    const plain = new ModelBackendStore(db);
    plain.setApiKey('xai', 'xai-old-plaintext');
    plain.putEndpoint('homelab', { ...endpoint, apiKey: 'lab-old-plaintext' });
    const keyring = fakeKeyring();
    const s = new ModelBackendStore(reopen(), keyring);
    expect(keyring.data.get('backend-xai-api-key')).toBe('xai-old-plaintext');
    expect(keyring.data.get('endpoint-homelab-api-key')).toBe('lab-old-plaintext');
    expect(keyColumn()).toEqual([['homelab', '']]);
    expect(s.forRun().apis.xai).toBe('xai-old-plaintext');
    for (const f of [file, `${file}-wal`]) {
      let text = '';
      try {
        text = readFileSync(f, 'latin1');
      } catch {
        /* no WAL file */
      }
      expect(text.includes('xai-old-plaintext') || text.includes('lab-old-plaintext')).toBe(false);
    }
  });

  it('leaves a key in the database when the credential store refuses it, reports failed saves, and keys it could not read', () => {
    new ModelBackendStore(db).setApiKey('openai', 'sk-stays-here');
    const broken: SecretStore = {
      storage: 'secret-service',
      get: (name) => {
        if (name === 'backend-xai-api-key') throw new Error('collection is locked');
        return null;
      },
      set: () => {
        throw new Error('collection is locked');
      },
      delete: () => {},
    };
    const s = new ModelBackendStore(reopen(), broken);
    expect(s.forRun().apis.openai).toBe('sk-stays-here');
    expect(s.view().apis).toEqual([
      { id: 'openai', keyMasked: '••••', keyStorage: 'database' },
      { id: 'anthropic', keyMasked: '', keyStorage: 'secret-service' },
      { id: 'xai', keyMasked: '', keyStorage: 'secret-service', keyUnreadable: true },
    ]);
    expect(() => withLang('en', () => s.setApiKey('anthropic', 'sk-ant-x'))).toThrow(/Could not save the API key .*collection is locked/);
    expect(s.forRun().apis.anthropic).toBeUndefined();
    s.setApiKey('openai', null); // removing still works, and clears the database copy
    expect(keyColumn()).toEqual([]);
  });

  it('allows at most so many endpoints, and refuses to delete one it does not have', () => {
    const s = new ModelBackendStore(db);
    for (let i = 0; i < 20; i++) s.putEndpoint(`lab-${i}`, endpoint);
    expect(() => s.putEndpoint('one-more', endpoint)).toThrow();
    expect(() => s.deleteEndpoint('nowhere')).toThrow();
    // Order of creation is kept.
    expect(
      s
        .view()
        .endpoints.map((e) => e.id)
        .slice(0, 3),
    ).toEqual(['lab-0', 'lab-1', 'lab-2']);
  });

  it('keeps keys tied to their saved URL when moving an endpoint, also if the credential store fails', () => {
    const keyring = fakeKeyring();
    const s = new ModelBackendStore(db, keyring);
    const moved = { ...endpoint, baseUrl: 'http://other.test/v1' };
    s.putEndpoint('lab', { ...endpoint, apiKey: 'first-key' });
    const remove = keyring.delete;
    const set = keyring.set;
    const restarted = () => new ModelBackendStore(db, keyring).forRun().endpoints[0];
    const old = { id: 'lab', ...endpoint };
    const next = { id: 'lab', ...moved };
    keyring.delete = () => {
      throw new Error('locked');
    };
    expect(() => s.putEndpoint('lab', { ...moved, apiKey: 'replacement' })).toThrow(/locked/);
    expect(restarted()).toEqual({ ...old, apiKey: 'first-key' });

    // Read the durable state at each boundary as a process starting after a crash would.
    keyring.delete = (name) => {
      remove(name);
      expect(restarted()).toEqual(old);
    };
    keyring.set = () => {
      expect(restarted()).toEqual(next);
      throw new Error('locked');
    };
    expect(() => s.putEndpoint('lab', { ...moved, apiKey: 'replacement' })).toThrow(/locked/);
    expect(s.forRun().endpoints[0]).toEqual(next);
    expect(restarted()).toEqual(next);
    keyring.delete = remove;
    keyring.set = set;
    s.putEndpoint('lab', { ...endpoint, apiKey: 'first-key' });
    keyring.set = (name, value) => {
      expect(restarted()).toEqual(next);
      set(name, value);
      expect(restarted()).toEqual({ ...next, apiKey: 'replacement' });
    };
    s.putEndpoint('lab', { ...moved, apiKey: 'replacement' });
    expect(s.forRun().endpoints[0]).toEqual({ ...next, apiKey: 'replacement' });
  });

  it('keeps database-backed keys with their URL when the system credential store is unavailable during a move', () => {
    const keyring = fakeKeyring();
    new ModelBackendStore(db, keyring).putEndpoint('lab', { ...endpoint, apiKey: 'old-system-key' });
    const moved = { ...endpoint, baseUrl: 'http://other.test/v1' };
    const options = { dataDir: root, env: {} };
    const offline = new ModelBackendStore(db, openSecretStore(db, undefined, options));
    offline.putEndpoint('lab', moved);
    offline.putEndpoint('lab', { ...moved, apiKey: null });
    expect(keyring.get('endpoint-lab-api-key')).toBe('old-system-key');
    const online = new ModelBackendStore(reopen(), openSecretStore(db, keyring, options));
    expect(keyring.get('endpoint-lab-api-key')).toBeNull();
    expect(online.forRun().endpoints[0]).toEqual({ id: 'lab', ...moved });
    expect(online.endpointCatalogKey('lab', moved.baseUrl)).toBeUndefined();
    const plain = new ModelBackendStore(db);
    plain.putEndpoint('lab', { ...endpoint, apiKey: 'original' });
    plain.putEndpoint('lab', { ...moved, apiKey: 'replacement' });
    expect(new ModelBackendStore(reopen()).forRun().endpoints[0]).toEqual({ id: 'lab', ...moved, apiKey: 'replacement' });
  });

  it('lets Settings retry the same new ID after a key write fails and preserves a previous deletion', () => {
    const ring = fakeKeyring();
    const store = new ModelBackendStore(db, ring);
    store.putEndpoint('lab', endpoint);
    store.deleteEndpoint('lab');
    const putKey = vi.spyOn(ring, 'set').mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const draft = { ...endpoint, apiKey: 'fixture-key', verifyModels: true };
    expect(() => store.putEndpoint('lab', draft)).toThrow(/locked/);
    expect(store.view()).toMatchObject({ endpoints: [], deletedEndpoints: ['lab'] });
    expect(new ModelBackendStore(db, ring).view()).toMatchObject({ endpoints: [], deletedEndpoints: ['lab'] });
    putKey.mockRestore();
    store.putEndpoint('lab', draft);
    expect(store.view().endpoints[0]?.id).toBe('lab');
    expect(store.endpointCatalogKey('lab', endpoint.baseUrl)).toBe('fixture-key');
  });

  it('clears an orphan key before adding an endpoint and writes its replacement only after the URL is durable', () => {
    const ring = fakeKeyring();
    const name = 'endpoint-lab-api-key';
    ring.set(name, 'orphan');
    const s = new ModelBackendStore(db, ring);
    const restarted = () => new ModelBackendStore(db, ring).forRun().endpoints;
    const remove = ring.delete;
    const set = ring.set;
    ring.delete = (account) => {
      remove(account);
      expect(restarted()).toEqual([]);
    };
    ring.set = (account, key) => {
      expect(restarted()).toEqual([{ id: 'lab', ...endpoint }]);
      set(account, key);
      expect(restarted()).toEqual([{ id: 'lab', ...endpoint, apiKey: 'replacement' }]);
    };
    s.putEndpoint('lab', { ...endpoint, apiKey: 'replacement' });
    expect(s.forRun().endpoints).toEqual(restarted());
  });

  it('retries clearing the encrypted copy after a move fails part way through clearing both credential stores', () => {
    const options = { dataDir: root, env: {} };
    const encrypted = openSecretStore(db, undefined, options);
    new ModelBackendStore(db, encrypted).putEndpoint('lab', { ...endpoint, apiKey: 'previous' });
    const native = fakeKeyring();
    const migration = vi.spyOn(native, 'set').mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const s = new ModelBackendStore(db, openSecretStore(db, native, options));
    migration.mockRestore();
    db.exec("CREATE TRIGGER cannot_clear BEFORE DELETE ON secrets BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const move = { ...endpoint, baseUrl: 'http://elsewhere.test/v1' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => s.putEndpoint('lab', move)).toThrow(/disk full/);
      expect(s.forRun().endpoints[0]).toEqual({ id: 'lab', ...endpoint, apiKey: 'previous' });
    }
    db.exec('DROP TRIGGER cannot_clear');
    s.putEndpoint('lab', move);
    const restarted = new ModelBackendStore(reopen(), openSecretStore(db, native, options));
    expect(restarted.forRun().endpoints[0]).toEqual({ id: 'lab', ...move });
  });

  it('remembers a deleted endpoint, also after a restart, until one of its id is added again', () => {
    const tombstones = () => (db.prepare('SELECT id FROM deleted_endpoints ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    const s = new ModelBackendStore(db);
    s.putEndpoint('homelab', endpoint);
    s.putEndpoint('studio', endpoint);
    expect(s.forRun()).not.toHaveProperty('deletedEndpoints');
    s.deleteEndpoint('homelab');
    expect(s.forRun()).toMatchObject({ endpoints: [{ id: 'studio' }], deletedEndpoints: ['homelab'] });
    expect(tombstones()).toEqual(['homelab']);
    expect(new ModelBackendStore(reopen()).forRun().deletedEndpoints).toEqual(['homelab']);
    // Changing another endpoint keeps it; adding one of its id again takes it out.
    const again = new ModelBackendStore(db);
    again.putEndpoint('studio', { ...endpoint, name: 'Studio' });
    expect(again.forRun().deletedEndpoints).toEqual(['homelab']);
    again.putEndpoint('homelab', endpoint);
    expect(again.forRun()).not.toHaveProperty('deletedEndpoints');
    expect(tombstones()).toEqual([]);
    expect(new ModelBackendStore(reopen()).forRun()).not.toHaveProperty('deletedEndpoints');
  });

  it("lists the deleted endpoints' ids, and forgets one when asked, so that its models go to their CLI again", () => {
    const s = new ModelBackendStore(db);
    for (const id of ['qwen', 'homelab']) {
      s.putEndpoint(id, endpoint);
      s.deleteEndpoint(id);
    }
    expect(s.view().deletedEndpoints).toEqual(['homelab', 'qwen']);
    s.forgetDeletedEndpoint('qwen');
    expect(s.view().deletedEndpoints).toEqual(['homelab']);
    expect(s.forRun().deletedEndpoints).toEqual(['homelab']);
    expect(endpointRunModel(s.forRun(), 'qwen/qwen3-coder', 'Codex')).toBeUndefined();
    expect(new ModelBackendStore(reopen()).view().deletedEndpoints).toEqual(['homelab']);
    expect(() => new ModelBackendStore(db).forgetDeletedEndpoint('qwen')).toThrow(/qwen/);
  });

  it('keeps nothing of an add or an edit that could not be saved, its key in the credential store included', () => {
    const keyring = fakeKeyring();
    const s = new ModelBackendStore(db, keyring);
    const fail = () => db.exec("CREATE TRIGGER no_endpoints BEFORE INSERT ON model_backends BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const ok = () => db.exec('DROP TRIGGER no_endpoints');
    // An add with a key: the key does not stay behind, to come back for a later endpoint of this id.
    fail();
    expect(() => s.putEndpoint('homelab', { ...endpoint, apiKey: 'secret-a' })).toThrow(/disk full/);
    expect(keyring.data.has('endpoint-homelab-api-key')).toBe(false);
    ok();
    s.putEndpoint('homelab', { ...endpoint, baseUrl: 'http://10.0.0.9:8000/v1' });
    expect(new ModelBackendStore(reopen(), keyring).forRun().endpoints[0]).not.toHaveProperty('apiKey');
    // An edit (with a new key): the endpoint, and the key it had, as they were.
    const t2 = new ModelBackendStore(db, keyring);
    t2.putEndpoint('homelab', { ...endpoint, apiKey: 'secret-b' });
    fail();
    expect(() =>
      t2.putEndpoint('homelab', { name: 'Moved', baseUrl: 'http://10.0.0.7:8000/v1', models: ['m2'], apiKey: 'secret-c' }),
    ).toThrow(/disk full/);
    expect(t2.forRun().endpoints[0]).toEqual({ id: 'homelab', ...endpoint, apiKey: 'secret-b' });
    expect(keyring.data.get('endpoint-homelab-api-key')).toBe('secret-b');
    // A key given to an endpoint that had none: taken out again.
    ok();
    t2.putEndpoint('homelab', { ...endpoint, apiKey: null });
    fail();
    expect(() => t2.putEndpoint('homelab', { ...endpoint, apiKey: 'secret-d' })).toThrow(/disk full/);
    expect(keyring.data.has('endpoint-homelab-api-key')).toBe(false);
    expect(t2.forRun().endpoints[0]).not.toHaveProperty('apiKey');
    ok();
  });

  it('says there is no key, not an unreadable one, after a failed edit replaced a key the credential store could not give', () => {
    const keyring = fakeKeyring();
    new ModelBackendStore(db, keyring).putEndpoint('homelab', { ...endpoint, apiKey: 'secret-a' });
    const locked: typeof keyring = {
      ...keyring,
      get: (name) => {
        if (name === 'endpoint-homelab-api-key') throw new Error('the keyring is locked');
        return keyring.get(name);
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new ModelBackendStore(reopen(), locked);
      expect(s.view().endpoints[0]).toMatchObject({ keyUnreadable: true });
      db.exec("CREATE TRIGGER no_endpoints BEFORE INSERT ON model_backends BEGIN SELECT RAISE(ABORT, 'disk full'); END");
      // An edit that leaves the key alone keeps it marked unreadable.
      expect(() => s.putEndpoint('homelab', { ...endpoint, name: 'Lab' })).toThrow(/disk full/);
      expect(s.view().endpoints[0]).toMatchObject({ keyUnreadable: true });
      // One that set a key replaced it: there is none now, and Settings says so.
      expect(() => s.putEndpoint('homelab', { ...endpoint, apiKey: 'secret-b' })).toThrow(/disk full/);
      expect(s.view().endpoints[0]).not.toHaveProperty('keyUnreadable');
      expect(s.view().endpoints[0]!.keyMasked).toBe('');
      expect(keyring.data.has('endpoint-homelab-api-key')).toBe(false);
      expect(warn).toHaveBeenCalledWith('[backends] the homelab API key the credential store could not give is gone: set it again');
      db.exec('DROP TRIGGER no_endpoints');
    } finally {
      warn.mockRestore();
    }
  });

  it('says the credential store still holds the new key when it could not be taken out after such an edit failed', () => {
    const keyring = fakeKeyring();
    new ModelBackendStore(db, keyring).putEndpoint('homelab', { ...endpoint, apiKey: 'secret-a' });
    const locked: typeof keyring = {
      ...keyring,
      get: (name) => {
        if (name === 'endpoint-homelab-api-key') throw new Error('the keyring is locked');
        return keyring.get(name);
      },
      delete: () => {
        throw new Error('the keyring is locked');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new ModelBackendStore(reopen(), locked);
      db.exec("CREATE TRIGGER no_endpoints BEFORE INSERT ON model_backends BEGIN SELECT RAISE(ABORT, 'disk full'); END");
      expect(() => s.putEndpoint('homelab', { ...endpoint, apiKey: 'secret-b' })).toThrow(/disk full/);
      expect(keyring.data.get('endpoint-homelab-api-key')).toBe('secret-b');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('the credential store still holds the key of the change that was not saved'),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is gone'));
      db.exec('DROP TRIGGER no_endpoints');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a deleted endpoint remembered when adding it again could not be saved', () => {
    const s = new ModelBackendStore(db);
    s.putEndpoint('homelab', endpoint);
    s.deleteEndpoint('homelab');
    // The endpoint's row cannot be written: nothing of the change is kept.
    db.exec("CREATE TRIGGER no_endpoints BEFORE INSERT ON model_backends BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => s.putEndpoint('homelab', endpoint)).toThrow(/disk full/);
    // Neither saved nor kept in memory: runs do not use it, and it is still remembered as deleted.
    expect(s.forRun()).toEqual({ apis: {}, endpoints: [], deletedEndpoints: ['homelab'] });
    expect(s.view()).toMatchObject({ endpoints: [], deletedEndpoints: ['homelab'] });
    db.exec('DROP TRIGGER no_endpoints');
    // Tried again, it is added and no longer remembered as deleted, in memory and on disk.
    s.putEndpoint('homelab', endpoint);
    expect(s.view()).toMatchObject({ endpoints: [{ id: 'homelab' }], deletedEndpoints: [] });
    expect(new ModelBackendStore(reopen()).view()).toMatchObject({ endpoints: [{ id: 'homelab' }], deletedEndpoints: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM deleted_endpoints').get()).toMatchObject({ n: 0 });
  });
});

describe('a run’s backend', () => {
  const backends = {
    apis: { openai: 'sk-o', anthropic: 'sk-a' },
    endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['muse'], apiKey: 'lab' }],
  };

  it("gives the model, only its own backend's key, the endpoint and the hosts to reach", () => {
    const keyless = [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['muse'] }];
    expect(backendRun(backends, 'anthropic/claude-haiku-5-5', 'Goose')).toEqual({
      id: 'anthropic/claude-haiku-5-5',
      backend: 'anthropic',
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      // The agent's commands inherit the run's environment: no other backend's key is in it.
      env: { ANTHROPIC_API_KEY: 'sk-a' },
      hosts: ['api.anthropic.com'],
      // The other backends still listed (a CLI's config may name them all), without their keys.
      backends: { apis: { anthropic: 'sk-a' }, endpoints: keyless },
    });
    const lab = backendRun(backends, 'homelab/muse', 'Goose');
    expect(lab).toMatchObject({
      kind: 'endpoint',
      model: 'muse',
      hosts: ['10.0.0.5:8000'],
      endpoint: { baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'lab' },
    });
    // On an endpoint, no API backend's key at all; its own key is not one of the usual variables: the adapter places it.
    expect(lab.env).toEqual({});
    expect(lab.backends).toEqual({ apis: {}, endpoints: backends.endpoints });
    // An adapter that asks for every key (allBackendKeys) gets them all.
    expect(backendRun(backends, 'homelab/muse', 'Goose', undefined, true).env).toEqual({
      OPENAI_API_KEY: 'sk-o',
      ANTHROPIC_API_KEY: 'sk-a',
    });
    expect(backendRun(backends, undefined, 'Goose', 'openai/gpt-5.4-nano').model).toBe('gpt-5.4-nano');
  });

  it('says what to do when the model cannot run', () => {
    withLang('en', () => {
      expect(() => backendRun(backends, '', 'Goose')).toThrow(/Goose has no model/);
      expect(() => backendRun(backends, 'gpt-5.4-nano', 'Goose')).toThrow(/is not "backend\/model"/);
      expect(() => backendRun(backends, 'xai/grok-4.3', 'Goose')).toThrow(/no xAI API key is set up/);
      expect(() => backendRun(undefined, 'lab2/x', 'Goose')).toThrow(/no custom endpoint with the id "lab2"/);
    });
  });

  it('reads hosts and keys', () => {
    expect(urlHost('https://api.example.com/v1')).toBe('api.example.com');
    expect(urlHost('http://[::1]:11434')).toBe('[::1]:11434');
    expect(urlHost('not a url')).toBeUndefined();
    expect(backendEnv({ apis: { xai: 'k' }, endpoints: [] })).toEqual({ XAI_API_KEY: 'k' });
  });
});

describe('Claude Code, Codex and Grok on the user’s own endpoints', () => {
  const backends = {
    apis: {},
    endpoints: [
      { id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b'], apiKey: 'lab-key' },
      { id: 'studio', name: 'LM Studio', baseUrl: 'http://10.0.0.6:1234/v1', models: ['qwen/qwen3-coder'] },
    ],
  };

  it('runs a model <endpoint id>/<model> on that endpoint, and any other model as the CLI has it', () => {
    expect(endpointModel(backends, 'homelab/gemma4:e4b')).toEqual({
      id: 'homelab/gemma4:e4b',
      model: 'gemma4:e4b',
      endpoint: backends.endpoints[0],
    });
    // A model name may hold a slash; a model the endpoint does not list still runs there.
    expect(endpointModel(backends, ' studio/qwen/qwen3-coder ')).toMatchObject({
      id: 'studio/qwen/qwen3-coder',
      model: 'qwen/qwen3-coder',
    });
    expect(endpointModel(backends, 'homelab/other')).toMatchObject({ model: 'other', endpoint: { id: 'homelab' } });
    // The CLI's own models, an id of its own with a slash (a provider of the user's Codex config), an
    // API backend's id (the open agents'), or an endpoint that is not set up: not an endpoint run.
    for (const model of ['opus', 'gpt-6.1-sol', 'qwen/qwen3-coder', 'anthropic/claude-haiku-5-5', 'lab2/x', '', undefined]) {
      expect(endpointModel(backends, model), String(model)).toBeUndefined();
    }
    expect(endpointModel(undefined, 'homelab/gemma4:e4b')).toBeUndefined();
  });

  it('fails a run on a model of an endpoint deleted in Settings, instead of sending it to the CLI’s own service', () => {
    const gone = { ...backends, deletedEndpoints: ['lab2'] };
    expect(() => withLang('en', () => endpointRunModel(gone, ' lab2/x ', 'Claude Code'))).toThrow(
      'Claude Code is to use the model "lab2/x", but its custom endpoint "lab2" was deleted under Settings → Model connections.',
    );
    expect(() => endpointRunModel(gone, 'lab2/x', 'Codex')).toThrow(AgentRunError);
    // An endpoint set up runs there; any other model, one with a slash too, goes to the CLI as it is.
    expect(endpointRunModel(gone, 'homelab/gemma4:e4b', 'Grok')).toEqual(endpointModel(backends, 'homelab/gemma4:e4b'));
    for (const model of ['opus', 'qwen/qwen3-coder', 'lab3/x', 'anthropic/claude-haiku-5-5', '', undefined]) {
      expect(endpointRunModel(gone, model, 'Codex'), String(model)).toBeUndefined();
    }
    // Without the record (an endpoint never set up), as before.
    expect(endpointRunModel(backends, 'lab2/x', 'Codex')).toBeUndefined();
    expect(endpointRunModel(undefined, 'lab2/x', 'Codex')).toBeUndefined();
  });

  it('puts the endpoint’s key in a variable of its own, and takes out one inherited without a key', () => {
    const lab = endpointModel(backends, 'homelab/gemma4:e4b')!;
    const studio = endpointModel(backends, 'studio/qwen/qwen3-coder')!;
    expect(endpointKeyEnv({ PATH: '/bin' }, lab)).toEqual({ PATH: '/bin', [ENDPOINT_KEY_ENV]: 'lab-key' });
    expect(endpointKeyEnv({ PATH: '/bin', [ENDPOINT_KEY_ENV]: 'from-the-shell' }, studio)).toEqual({ PATH: '/bin' });
  });

  it('sends only an effort the endpoint takes: Codex the closest one, Claude Code and Grok none', () => {
    expect(endpointEffort('codex', 'high')).toBe('high');
    expect(endpointEffort('codex', 'none')).toBe('none');
    expect(endpointEffort('codex', 'xhigh')).toBe('medium');
    expect(endpointEffort('codex', '')).toBeUndefined();
    expect(endpointEffort('claude', 'low')).toBe('low');
    expect(endpointEffort('claude', 'max')).toBeUndefined();
    expect(endpointEffort('grok', 'high')).toBeUndefined();
  });

  it('lists each endpoint’s models after the CLI’s own, with the efforts it may send there', () => {
    const own = {
      provider: 'codex' as const,
      models: [{ id: 'gpt-6.1-sol' }, { id: 'homelab/gemma4:e4b', label: 'Mine' }],
      efforts: ['low', 'xhigh'],
      source: 'cli' as const,
    };
    const view = backends.endpoints.map(({ apiKey: _, ...e }) => ({ ...e, keyMasked: '', keyStorage: 'keychain' as const }));
    const codex = withEndpointModels('codex', own, view);
    expect(codex.models).toEqual([
      { id: 'gpt-6.1-sol' },
      // An id the CLI lists stays its own.
      { id: 'homelab/gemma4:e4b', label: 'Mine' },
      {
        id: 'studio/qwen/qwen3-coder',
        label: 'qwen/qwen3-coder · LM Studio',
        endpoint: 'studio',
        efforts: ['none', 'low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ]);
    const grok = withEndpointModels('grok', { ...own, provider: 'grok', models: [] }, view);
    expect(grok.models[0]).toEqual({ id: 'homelab/gemma4:e4b', label: 'gemma4:e4b · Homelab', endpoint: 'homelab', efforts: [] });
    expect(withEndpointModels('claude', { ...own, provider: 'claude' }, [])).toEqual({ ...own, provider: 'claude' });

    // The effort a member left on "default" runs as the menu says: one the endpoint does not take is
    // replaced (Codex) or not sent (Claude Code, Grok).
    const pm = (defaultEffort?: string): ProviderModels => ({ ...codex, ...(defaultEffort ? { defaultEffort } : {}) });
    expect(inheritedEffort(pm('xhigh'), 'studio/qwen/qwen3-coder')).toBe('medium');
    expect(inheritedEffort(pm('high'), 'studio/qwen/qwen3-coder')).toBe('high');
    expect(inheritedEffort(pm(), 'studio/qwen/qwen3-coder')).toBeUndefined();
    expect(inheritedEffort({ ...grok, defaultEffort: 'xhigh' }, 'homelab/gemma4:e4b')).toBeUndefined();
    // The CLI's own models as before.
    expect(inheritedEffort(pm('xhigh'), 'gpt-6.1-sol')).toBe('xhigh');
  });

  it('leaves Cursor out: its models run only through Cursor’s own service', async () => {
    expect(['claude', 'codex', 'grok', 'cursor', 'goose'].filter((p) => isEndpointCli(p as never))).toEqual(['claude', 'codex', 'grok']);
    const view = backends.endpoints.map(({ apiKey: _, ...e }) => ({ ...e, keyMasked: '', keyStorage: 'keychain' as const }));
    // Not installed: no CLI runs, and its menu has none of the endpoints' models.
    const cursor = await discoverModels('cursor', join(root, 'no-such-cursor'), { PATH: '' }, { configured: [], endpoints: view });
    expect(cursor.provider).toBe('cursor');
    expect(cursor.models.filter((m) => m.endpoint || m.id.startsWith('homelab/') || m.id.startsWith('studio/'))).toEqual([]);
  });
});

describe('an open agent’s environment', () => {
  it('gets the configured keys instead of any the server inherited, and a home of Harness Relay’s own', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-the-shell');
    vi.stubEnv('OPENAI_BASE_URL', 'https://elsewhere.example');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-the-shell');
    vi.stubEnv('CURSOR_API_KEY', 'key_from-the-shell');
    try {
      const s = new SettingsStore(db);
      s.backends.setApiKey('anthropic', 'sk-ant-settings');
      const env = s.env('goose');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-settings');
      expect(env[OPEN_AGENT_HOME_ENV]).toBe(join(OPEN_HOMES_DIR, 'goose'));
      // Nor Cursor's sign-in by key, which is Cursor's own.
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(s.env('cursor').CURSOR_API_KEY).toBe('key_from-the-shell');
      expect(s.backendsFor('goose')).toEqual({ apis: { anthropic: 'sk-ant-settings' }, endpoints: [] });
      // The other CLIs keep theirs, and get the user's own endpoints only, never the API backends' keys.
      expect(s.env('claude').ANTHROPIC_API_KEY).toBe('sk-ant-from-the-shell');
      expect(s.env('claude')[OPEN_AGENT_HOME_ENV]).toBeUndefined();
      expect(s.backendsFor('claude')).toEqual({ apis: {}, endpoints: [] });
      s.backends.putEndpoint('homelab', {
        name: 'Homelab',
        baseUrl: 'http://10.0.0.5:11434/v1',
        models: ['gemma4:e4b'],
        apiKey: 'lab-key',
      });
      expect(s.backendsFor('codex')).toEqual({
        apis: {},
        endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b'], apiKey: 'lab-key' }],
      });
      // Cursor runs only on Cursor's own models: no endpoint, and no key, reaches its runs.
      expect(s.backendsFor('cursor')).toEqual({ apis: {}, endpoints: [] });
      // The endpoints deleted in Settings reach Claude Code's, Codex's and Grok's runs, to fail a model of one.
      s.backends.putEndpoint('oldlab', { name: 'Old lab', baseUrl: 'http://10.0.0.7:8000/v1', models: ['x'] });
      s.backends.deleteEndpoint('oldlab');
      for (const p of ['claude', 'codex', 'grok'] as const) expect(s.backendsFor(p).deletedEndpoints, p).toEqual(['oldlab']);
      expect(s.backendsFor('cursor')).toEqual({ apis: {}, endpoints: [] });
      // With an agent-home folder, the open agents' homes are in it too.
      s.setAgentHome(join(root, 'homes'));
      expect(s.env('pi')[OPEN_AGENT_HOME_ENV]).toBe(join(root, 'homes', 'pi'));
      // Open agents have no API key of their own in their card.
      expect(s.view().providers.find((p) => p.provider === 'pi')).toMatchObject({ apiKeyMasked: '', apiKeyStorage: undefined });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never gets the ports npm run dev set for its own server and Vite, which another checkout's npm run dev would take for its own", () => {
    vi.stubEnv('npm_lifecycle_event', 'dev');
    vi.stubEnv('PORT', '8790');
    vi.stubEnv('RELAY_DEV_WEB_PORT', '5174');
    try {
      const s = new SettingsStore(db);
      for (const p of ['claude', 'codex', 'goose'] as const) {
        expect(s.env(p).PORT, p).toBeUndefined();
        expect(s.env(p).RELAY_DEV_WEB_PORT, p).toBeUndefined();
      }
      // Under npm start (and in the desktop app), PORT reaches the CLIs as it always did.
      vi.stubEnv('npm_lifecycle_event', 'start');
      expect(s.env('claude').PORT).toBe('8790');
      expect(s.env('claude').RELAY_DEV_WEB_PORT).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('masked keys and endpoint addresses', () => {
  it('shows only the last four characters of a long key, and nothing of a short one', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('lab-key-1234')).toBe('••••');
    expect(maskSecret('sk-test-openai-00000000000000wxyz')).toBe('••••wxyz');
  });

  it("refuses Harness Relay's own address however it is spelled, and allows other hosts and ports", () => {
    const own = ['192.168.1.20'];
    const refused = [
      'http://127.0.0.1:8787/v1',
      'http://127.1.2.3:8787',
      'http://localhost:8787',
      'http://localhost.:8787',
      'http://api.localhost:8787',
      'http://[::1]:8787',
      'http://[::ffff:127.0.0.1]:8787',
      'http://[::]:8787',
      'http://0:8787',
      'http://0x7f000001:8787',
      'http://192.168.1.20:8787',
      'http://localhost:5173', // the dev server's port, which reaches the API too
      'http://127.0.0.1:8789', // npm run dev's API
    ];
    for (const url of refused)
      expect(() => withLang('en', () => validEndpointUrl(url, 8787, own)), url).toThrow(/Harness Relay's own address/);
    expect(validEndpointUrl('http://10.0.0.5:8787/v1', 8787, own)).toBe('http://10.0.0.5:8787/v1');
    expect(validEndpointUrl('http://localhost:11434/v1', 8787, own)).toBe('http://localhost:11434/v1');
  });

  it("refuses the port npm run dev's Vite took when 5173 was in use", () => {
    const own = ['192.168.1.20'];
    expect(validEndpointUrl('http://localhost:5174/v1', 8790, own)).toBe('http://localhost:5174/v1');
    vi.stubEnv('RELAY_DEV_WEB_PORT', '5174');
    try {
      expect(() => withLang('en', () => validEndpointUrl('http://localhost:5174/v1', 8790, own))).toThrow(/Harness Relay's own address/);
      expect(() => withLang('en', () => validEndpointUrl('http://127.0.0.1:8790', 8790, own))).toThrow(/Harness Relay's own address/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('model backends over HTTP, and the open agents in Settings', () => {
  const HOST = { host: '127.0.0.1:8787' };
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  function setup(auth: InstanceType<typeof AuthStore> | null = null, keyring = fakeKeyring()) {
    const settings = new SettingsStore(db, keyring);
    const store = new Store(db);
    const hub = new Hub();
    const providers = new ProviderService(settings);
    const app = createApp({ auth, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers });
    return { app, settings, keyring, providers };
  }

  async function withModelServer(handler: RequestListener, run: (origin: string) => Promise<void>) {
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('lists unique catalog IDs in server order and uses a saved key only for the same endpoint and address', async () => {
    const { app, settings } = setup();
    const ids = Array.from({ length: 125 }, (_, i) => `org/model-${i}`);
    const seen: [string | undefined, string | undefined, string | undefined][] = [];
    await withModelServer(
      (req, res) => {
        seen.push([req.method, req.url, req.headers.authorization]);
        res.end(
          JSON.stringify({
            data: [
              ...ids.map((id) => ({ id })),
              { id: ids[0] },
              { id: 'has space' },
              { id: 'bad\u0000id' },
              { id: 'x'.repeat(201) },
              null,
              {},
            ],
          }),
        );
      },
      async (origin) => {
        const baseUrl = origin + '/v1';
        const put = await app.request(
          '/api/backends/endpoints/lab',
          json('PUT', { ...endpoint, baseUrl: baseUrl + '/', apiKey: 'saved-key' }),
        );
        expect(put.status).toBe(200);
        const catalog = (input: object) => app.request('/api/backends/endpoint-models', json('POST', { baseUrl, ...input }));
        const found = await catalog({ endpointId: 'lab', baseUrl: baseUrl + '//' });
        expect(found.status).toBe(200);
        expect(await found.json()).toEqual({ models: ids });
        for (const input of [
          {},
          { endpointId: 'other' },
          { endpointId: 'lab', baseUrl: origin + '/other' },
          { endpointId: 'lab', apiKey: ' new-key ' },
          { endpointId: 'lab', apiKey: null },
        ])
          expect((await catalog(input)).status).toBe(200);
        expect(seen).toEqual([
          ['GET', '/v1/models', 'Bearer saved-key'],
          ['GET', '/v1/models', undefined],
          ['GET', '/v1/models', undefined],
          ['GET', '/other/models', undefined],
          ['GET', '/v1/models', 'Bearer new-key'],
          ['GET', '/v1/models', undefined],
        ]);
        expect(settings.backends.forRun().endpoints[0]).toEqual({ id: 'lab', ...endpoint, baseUrl, apiKey: 'saved-key' });
        const save = await app.request(
          '/api/backends/endpoints/lab',
          json('PUT', { ...endpoint, baseUrl: origin + '/other', models: [ids[124]] }),
        );
        expect(save.status).toBe(200);
        await catalog({ endpointId: 'lab', baseUrl: origin + '/other' });
        expect(seen.at(-1)).toEqual(['GET', '/other/models', undefined]);
      },
    );
  });

  it('checks sign-in, rejects Relay addresses and malformed input, and handles an unreadable key without guessing', async () => {
    const ask = (app: ReturnType<typeof createApp>, input: object) => app.request('/api/backends/endpoint-models', json('POST', input));
    const { app: protectedApp } = setup(new AuthStore(db));
    expect((await ask(protectedApp, { baseUrl: endpoint.baseUrl })).status).toBe(401);
    const lookup = vi.spyOn(SYSTEM_NET, 'lookup').mockResolvedValue(['127.0.0.1']);
    try {
      expect((await ask(setup().app, { baseUrl: 'http://relay-alias.test:8787' })).status).toBe(400);
      expect(lookup).toHaveBeenCalledWith('relay-alias.test');
    } finally {
      lookup.mockRestore();
    }
    const keyring = fakeKeyring();
    await withModelServer(
      (_req, res) => res.end('{"data":[]}'),
      async (origin) => {
        const baseUrl = origin + '/v1';
        new ModelBackendStore(db, keyring).putEndpoint('lab', { ...endpoint, baseUrl, apiKey: 'saved-key' });
        const get = keyring.get;
        keyring.get = (name) => {
          if (name === 'endpoint-lab-api-key') throw new Error('locked');
          return get(name);
        };
        const { app } = setup(null, keyring);
        const unreadable = await ask(app, { baseUrl, endpointId: 'lab' });
        expect(unreadable.status).toBe(409);
        expect(await unreadable.text()).toContain('saved API key could not be read');
        for (const input of [{ baseUrl, apiKey: null }, { baseUrl, apiKey: 'replacement' }, { baseUrl: origin + '/v2' }]) {
          const found = await ask(app, { ...input, endpointId: 'lab' });
          expect(await found.json()).toEqual({ models: [] });
        }
        for (const input of [
          {},
          { baseUrl: 'http://user:sensitive@localhost/' },
          { baseUrl: 'http://localhost/?key=sensitive' },
          { baseUrl: 'http://127.0.0.1:8787' },
          { baseUrl, apiKey: 2 },
          { baseUrl, apiKey: 'a'.repeat(4097) },
          { baseUrl, endpointId: {} },
          { baseUrl, endpointId: 'openai' },
        ]) {
          const rejected = await ask(app, input);
          expect(rejected.status).toBe(400);
          expect(await rejected.text()).not.toContain('sensitive');
        }
      },
    );
  });

  it('returns localized, bounded catalog errors without following redirects or relaying upstream error bodies', async () => {
    const { app } = setup();
    const requests: string[] = [];
    await withModelServer(
      (req, res) => {
        requests.push(req.url!);
        if (req.url === '/redirect/models') res.writeHead(302, { location: '/target/models' });
        if (req.url === '/auth/models') res.writeHead(401);
        if (req.url === '/large/models') {
          res.write('{"data":[],"padding":"');
          return res.end(' '.repeat(4 * 1024 * 1024) + '"}');
        }
        res.end('sensitive upstream detail');
      },
      async (origin) => {
        for (const [path, error] of [
          ['redirect', /HTTP 302/],
          ['auth', /API key/],
          ['bad', /JSON/],
          ['large', /4 MiB/],
        ] as const) {
          const res = await app.request(
            '/api/backends/endpoint-models',
            json('POST', { baseUrl: origin + '/' + path, apiKey: 'request-key' }),
          );
          expect(res.status).toBe(502);
          const message = await res.text();
          expect(message).toMatch(error);
          expect(message).not.toMatch(/sensitive|request-key/);
        }
        expect(requests).toEqual(['/redirect/models', '/auth/models', '/bad/models', '/large/models']);
      },
    );
  });

  it('verifies a save against the catalog and the exact per-model resource before changing any settings', async () => {
    const { app, settings } = setup();
    const seen: [string, string | undefined][] = [];
    await withModelServer(
      (req, res) => {
        seen.push([req.url!, req.headers.authorization]);
        switch (req.url) {
          case '/v1/models':
            return res.end(JSON.stringify({ data: [{ id: 'listed' }] }));
          case '/v1/models/org%2Funlisted':
            return res.end(JSON.stringify({ id: 'org/unlisted' }));
          case '/v1/models/alias':
            return res.end(JSON.stringify({ id: 'another' }));
          case '/v1/models/private':
            res.writeHead(401);
            break;
          case '/v2/models':
            res.writeHead(405);
            break;
          case '/v2/models/only':
            return res.end(JSON.stringify({ id: 'only' }));
          case '/private/models':
            res.writeHead(403);
            break;
          case '/bad/models':
            return res.end('upstream-secret');
          case '/offline/models':
            return req.socket.destroy();
          default:
            res.writeHead(404);
        }
        res.end('upstream-secret');
      },
      async (origin) => {
        const put = (body: object) =>
          app.request('/api/backends/endpoints/lab', json('PUT', { ...endpoint, baseUrl: origin + '/v1', verifyModels: true, ...body }));
        const original = { ...endpoint, baseUrl: origin + '/v1', models: ['listed'], apiKey: 'first' };
        settings.backends.putEndpoint('lab', original);
        expect((await put({ models: ['listed', 'org/unlisted', 'org/unlisted'] })).status).toBe(200);
        expect(seen.splice(0)).toEqual([
          ['/v1/models', 'Bearer first'],
          ['/v1/models/org%2Funlisted', 'Bearer first'],
        ]);
        const saved = settings.backends.forRun();
        for (const [input, paths, message] of [
          [{ models: ['listed', 'alias'] }, ['/v1/models', '/v1/models/alias'], /alias/],
          [{ models: ['unknown', 'never-probed'], apiKey: 'replacement' }, ['/v1/models', '/v1/models/unknown'], /unknown.*404/],
          [{ models: ['private', 'never-probed'] }, ['/v1/models', '/v1/models/private'], /private.*401/],
          [{ models: [], baseUrl: origin + '/v2' }, ['/v2/models'], /at least one model ID/],
          [{ models: ['x'], baseUrl: origin + '/private' }, ['/private/models'], /403/],
          [{ models: [], baseUrl: origin + '/bad' }, ['/bad/models'], /JSON/],
          [{ models: [], baseUrl: origin + '/offline' }, ['/offline/models'], /connection/],
        ] as const) {
          const refused = await put(input);
          expect(refused.status).toBeGreaterThanOrEqual(400);
          const text = await refused.text();
          expect(text).toMatch(message);
          expect(text).not.toMatch(/upstream-secret|replacement/);
          expect(seen.splice(0).map(([path]) => path)).toEqual(paths);
          expect(settings.backends.forRun()).toEqual(saved);
        }
        expect((await put({ verifyModels: 1 })).status).toBe(400);
        expect((await put({ models: [] })).status).toBe(200);
        expect(seen.splice(0)).toEqual([['/v1/models', 'Bearer first']]);
        expect((await put({ baseUrl: origin + '/v2', models: ['only'] })).status).toBe(200);
        expect(seen.splice(0)).toEqual([
          ['/v2/models', undefined],
          ['/v2/models/only', undefined],
        ]);
        expect(settings.backends.forRun().endpoints[0]).toEqual({ id: 'lab', ...endpoint, baseUrl: origin + '/v2', models: ['only'] });
        expect((await put({ baseUrl: origin + '/v2', verifyModels: false, models: ['unchecked'] })).status).toBe(200);
        expect(seen).toEqual([]);
      },
    );
  });

  it('requires explicit consent when both metadata routes are absent and never overrides an actual verification failure', async () => {
    const { app, settings } = setup();
    const requests: string[] = [];
    let canceledRecord = false;
    await withModelServer(
      (req, res) => {
        requests.push(req.method + ' ' + req.url);
        switch (req.url) {
          case '/v1/models':
            return res.writeHead(405).end();
          case '/v1/models/streaming':
            res.on('close', () => {
              canceledRecord = true;
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.flushHeaders();
            return;
          case '/v1/models/known':
            return res.end('{"id":"known"}');
          case '/v1/models/mismatch':
            return res.end('{"id":"other"}');
          case '/v1/models/denied':
            return res.writeHead(403).end();
          case '/v1/models/offline':
            return req.socket.destroy();
          default:
            return res.writeHead(404).end();
        }
      },
      async (origin) => {
        const baseUrl = origin + '/v1';
        const put = (models: string[], extra: object = {}) =>
          app.request('/api/backends/endpoints/lab', json('PUT', { ...endpoint, baseUrl, verifyModels: true, models, ...extra }));
        const ids = ['first', 'second'];
        const first = await put(ids);
        expect(first.status).toBe(409);
        expect(await first.json()).toMatchObject({ code: 'endpoint-metadata-unavailable' });
        expect(settings.backends.forRun().endpoints).toEqual([]);
        const probes = ['GET /v1/models', 'GET /v1/models/first', 'GET /v1/models/second'];
        expect(requests.splice(0)).toEqual(probes);
        expect((await put(ids, { allowMissingMetadata: true })).status).toBe(200);
        expect(requests.splice(0)).toEqual(probes);
        for (const [models, expected] of [
          [['first', 'known'], /first.*404/],
          [['first', 'streaming'], /first.*404/],
          [['known', 'second'], /second.*404/],
          [['first', 'denied'], /403/],
          [['first', 'offline'], /offline.*connection/],
          [['mismatch'], /matching record/],
        ] as const) {
          const failed = await put([...models], { allowMissingMetadata: true, name: 'Rejected' });
          expect(failed.status).toBeGreaterThanOrEqual(400);
          expect(await failed.json()).toEqual({ error: expect.stringMatching(expected) });
          expect(settings.backends.forRun().endpoints[0]).toMatchObject({ name: endpoint.name, models: ids });
        }
        await vi.waitFor(() => expect(canceledRecord).toBe(true));
        expect((await put(ids, { allowMissingMetadata: 'yes' })).status).toBe(400);
        expect((await put(ids, { verifyModels: false, allowMissingMetadata: true })).status).toBe(400);
        // A legacy chat backend can have no catalog and no saved IDs. A label-only change is local.
        settings.backends.putEndpoint('lab', { ...endpoint, baseUrl, models: [], apiKey: 'existing' });
        requests.length = 0;
        expect((await put([], { name: 'New label' })).status).toBe(200);
        expect(requests).toEqual([]);
        expect(settings.backends.forRun().endpoints[0]).toMatchObject({ name: 'New label', apiKey: 'existing' });
        expect((await put([], { name: 'Changed key', apiKey: 'new' })).status).toBe(400);
        expect(requests).toEqual(['GET /v1/models']);
        expect(settings.backends.forRun().endpoints[0]).toMatchObject({ name: 'New label', apiKey: 'existing' });
      },
    );
  });

  it('applies the same deadline to individual records after a slow catalog', async () => {
    const { app, settings } = setup();
    const now = Date.now.bind(Date);
    let elapsed = 0;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
    const paths: string[] = [];
    try {
      await withModelServer(
        (req, res) => {
          paths.push(req.url!);
          elapsed = 11_000;
          res.end('{"data":[]}');
        },
        async (origin) => {
          const response = await app.request(
            '/api/backends/endpoints/lab',
            json('PUT', {
              ...endpoint,
              baseUrl: origin + '/v1',
              models: ['manual'],
              verifyModels: true,
              allowMissingMetadata: true,
            }),
          );
          expect(response.status).toBe(502);
          expect(await response.text()).toMatch(/manual.*timed out/);
          expect(paths).toEqual(['/v1/models']);
          expect(settings.backends.forRun().endpoints).toEqual([]);
        },
      );
    } finally {
      time.mockRestore();
    }
  });

  it('bounds the combined size of individual model records and stops checking on the first over-budget response', async () => {
    const { app, settings } = setup();
    const models = ['one', 'two', 'three', 'four'];
    const padding = ' '.repeat(3 * 1024 * 1024);
    const paths: string[] = [];
    await withModelServer(
      (req, res) => {
        paths.push(req.url!);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/models') return res.end('{"data":[]}');
        const id = models.find((model) => req.url === `/v1/models/${model}`);
        if (!id) return res.writeHead(404).end();
        res.end(JSON.stringify({ id, padding }));
      },
      async (origin) => {
        const res = await app.request(
          '/api/backends/endpoints/lab',
          json('PUT', {
            ...endpoint,
            baseUrl: origin + '/v1',
            verifyModels: true,
            models,
          }),
        );
        expect(res.status).toBe(502);
        expect(await res.text()).toMatch(/three.*8 MiB/);
        expect(paths).toEqual(['/v1/models', '/v1/models/one', '/v1/models/two', '/v1/models/three']);
        expect(settings.backends.forRun().endpoints).toEqual([]);
        const unknown = await fetch(origin + '/v1/models/unknown');
        expect(unknown.status).toBe(404);
        expect(await unknown.text()).toBe('');
      },
    );
  });

  it('refuses a stale verified save after the same endpoint ID was deleted and recreated during the lookup', async () => {
    const { app, settings } = setup();
    let replace!: () => void;
    await withModelServer(
      (_req, res) => {
        replace();
        res.end(JSON.stringify({ data: [{ id: 'new-selection' }] }));
      },
      async (origin) => {
        const saved = { ...endpoint, baseUrl: origin + '/v1', apiKey: 'same-key' };
        settings.backends.putEndpoint('lab', saved);
        replace = () => {
          settings.backends.deleteEndpoint('lab');
          settings.backends.putEndpoint('lab', saved);
        };
        const res = await app.request(
          '/api/backends/endpoints/lab',
          json('PUT', {
            ...saved,
            name: 'stale edit',
            models: ['new-selection'],
            verifyModels: true,
          }),
        );
        expect(res.status).toBe(409);
        expect(await res.text()).toContain('settings changed');
        expect(settings.backends.forRun().endpoints).toEqual([{ id: 'lab', ...saved }]);
      },
    );
  });

  it('reads the context window from the answers the save checks, keeps what the user set over it, and asks nothing for a new name', async () => {
    const { app, settings } = setup();
    const seen: string[] = [];
    await withModelServer(
      (req, res) => {
        seen.push(req.url!);
        switch (req.url) {
          case '/vllm/models':
            // vLLM: max_model_len, and a LoRA adapter of the base model, which has none of its own.
            return res.end(
              JSON.stringify({
                object: 'list',
                data: [
                  { id: 'Qwen/Qwen3-32B', object: 'model', owned_by: 'vllm', root: '/models/qwen', max_model_len: 32768 },
                  { id: 'sql-lora', object: 'model', owned_by: 'vllm', parent: 'Qwen/Qwen3-32B' },
                ],
              }),
            );
          case '/llama/models':
            // llama.cpp: the context of one slot (meta.n_ctx), not what the model was trained for.
            return res.end(
              JSON.stringify({
                object: 'list',
                data: [{ id: 'gemma', object: 'model', owned_by: 'llamacpp', meta: { n_ctx: 8192, n_ctx_train: 131072 } }],
              }),
            );
          case '/ollama/models':
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3', object: 'model' }] }));
          case '/ollama/models/extra':
            return res.end(JSON.stringify({ id: 'extra', max_model_len: 4096 }));
          default:
            res.writeHead(404);
            res.end();
        }
      },
      async (origin) => {
        const put = (body: object) => app.request('/api/backends/endpoints/lab', json('PUT', { ...endpoint, verifyModels: true, ...body }));
        const view = async (r: Response) => {
          expect(r.status).toBe(200);
          return ((await r.json()) as ModelBackendsView).endpoints[0]!;
        };
        let e = await view(
          await put({ baseUrl: origin + '/vllm', models: ['Qwen/Qwen3-32B', 'sql-lora'], limits: { 'sql-lora': { output: 1024 } } }),
        );
        expect(e.limits).toEqual({
          'Qwen/Qwen3-32B': { reported: { context: 32768 } },
          'sql-lora': { output: 1024, reported: { context: 32768 } },
        });
        // The user's context window wins over the server's.
        e = await view(
          await put({ baseUrl: origin + '/vllm', models: ['Qwen/Qwen3-32B'], limits: { 'Qwen/Qwen3-32B': { context: 16384 } } }),
        );
        expect(settings.backends.forRun().endpoints[0]!.limits).toEqual({ 'Qwen/Qwen3-32B': { context: 16384 } });
        seen.splice(0);
        // A new name only: the server is not asked, and what it reported stays.
        e = await view(await put({ name: 'Renamed', baseUrl: origin + '/vllm', models: ['Qwen/Qwen3-32B'], limits: {} }));
        expect(seen).toEqual([]);
        expect(e.limits).toEqual({ 'Qwen/Qwen3-32B': { reported: { context: 32768 } } });
        e = await view(await put({ name: 'Renamed', baseUrl: origin + '/llama', models: ['gemma'], limits: {} }));
        expect(e.limits).toEqual({ gemma: { reported: { context: 8192 } } });
        // A server that reports none (Ollama), and a model's own record that does.
        e = await view(await put({ name: 'Renamed', baseUrl: origin + '/ollama', models: ['llama3', 'extra'] }));
        expect(e.limits).toEqual({ extra: { reported: { context: 4096 } } });
        expect(seen.slice(-2)).toEqual(['/ollama/models', '/ollama/models/extra']);
        // An output limit the server's window cannot hold refuses the save, which changes nothing.
        const before = settings.backends.view();
        const refused = await put({ name: 'Renamed', baseUrl: origin + '/llama', models: ['gemma'], limits: { gemma: { output: 9000 } } });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toMatch(/output limit of "gemma" \(9000 tokens\)/);
        expect(settings.backends.view()).toEqual(before);
      },
    );
  });

  it('takes only whole token counts in range, for the models the endpoint lists', async () => {
    const { app } = setup();
    const put = (limits: unknown) => app.request('/api/backends/endpoints/lab', json('PUT', { ...endpoint, models: ['m'], limits }));
    for (const limits of [
      [],
      'x',
      { other: { context: 32768 } },
      { m: { context: 1000 } },
      { m: { context: 32768.5 } },
      { m: { context: '32768' } },
      { m: { output: 0 } },
      { m: { context: 8192, output: 8192 } },
      { m: { context: 8192, extra: 1 } },
      { m: null },
    ]) {
      const r = await put(limits);
      expect(r.status, JSON.stringify(limits)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/context window is a whole number of tokens from 1024 to 10000000/);
    }
    const ok = await put({ m: { context: 32768, output: 4096 } });
    expect(((await ok.json()) as ModelBackendsView).endpoints[0]!.limits).toEqual({ m: { context: 32768, output: 4096 } });
    // An empty entry sets nothing.
    expect(((await (await put({ m: {} })).json()) as ModelBackendsView).endpoints[0]).not.toHaveProperty('limits');
  });

  it('reads vLLM’s max_model_len and llama.cpp’s meta.n_ctx, and nothing else, as the context window', () => {
    expect(reportedLimits({ id: 'a', max_model_len: 32768 })).toEqual({ context: 32768 });
    expect(reportedLimits({ id: 'a', meta: { n_ctx: 8192, n_ctx_train: 131072 } })).toEqual({ context: 8192 });
    expect(reportedLimits({ id: 'a', meta: { n_ctx_train: 131072 } })).toEqual({});
    expect(reportedLimits({ id: 'a', context_length: 131072 })).toEqual({});
    expect(reportedLimits({ id: 'a', max_model_len: '32768' })).toEqual({});
    expect(reportedLimits({ id: 'a', max_model_len: 10 })).toEqual({});
    expect(reportedLimits(null)).toEqual({});
  });

  it('sets and removes API keys, shown masked only', async () => {
    const { app, keyring } = setup();
    const res = await app.request('/api/backends/openai', json('PUT', { apiKey: ' sk-test-openai-9999 ' }));
    expect(res.status).toBe(200);
    const view = (await res.json()) as ModelBackendsView;
    expect(view.apis[0]).toEqual({ id: 'openai', keyMasked: '••••', keyStorage: 'keychain' });
    expect(JSON.stringify(view)).not.toContain('sk-test-openai-9999');
    expect(keyring.data.get('backend-openai-api-key')).toBe('sk-test-openai-9999');
    expect(((await (await app.request('/api/backends', { headers: HOST })).json()) as ModelBackendsView).apis[0]!.keyMasked).toBe('••••');
    expect((await app.request('/api/backends/openai', json('PUT', { apiKey: null }))).status).toBe(200);
    expect(keyring.data.size).toBe(0);
    expect((await app.request('/api/backends/gemini', json('PUT', { apiKey: 'x' }))).status).toBe(404);
    expect((await app.request('/api/backends/openai', json('PUT', { apiKey: 7 }))).status).toBe(400);
    // Writes need JSON, as every write does.
    expect(
      (
        await app.request('/api/backends/openai', {
          method: 'PUT',
          headers: { ...HOST, 'content-type': 'text/plain' },
          body: '{"apiKey":"x"}',
        })
      ).status,
    ).toBe(415);
  });

  it('adds, changes and deletes endpoints, and checks what it is given', async () => {
    const { app } = setup();
    const put = (id: string, body: unknown) => app.request(`/api/backends/endpoints/${id}`, json('PUT', body));
    const res = await put('homelab', {
      name: ' Homelab ',
      baseUrl: 'http://10.0.0.5:8000/v1/',
      models: ['muse', 'muse', ' other '],
      apiKey: 'lab-key-1234',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ModelBackendsView).endpoints).toEqual([
      {
        id: 'homelab',
        name: 'Homelab',
        baseUrl: 'http://10.0.0.5:8000/v1',
        models: ['muse', 'other'],
        keyMasked: '••••',
        keyStorage: 'keychain',
      },
    ]);
    const refused = async (id: string, body: unknown, pattern: RegExp) => {
      const r = await put(id, body);
      expect(r.status, `${id} ${JSON.stringify(body)}`).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(pattern);
    };
    await refused('openai', endpoint, /name of a built-in model backend/);
    await refused('Home_Lab', endpoint, /may only hold lowercase letters/);
    await refused('lab', { ...endpoint, name: '' }, /Enter a name/);
    await refused('lab', { ...endpoint, baseUrl: 'ftp://10.0.0.5/v1' }, /not an endpoint address/);
    await refused('lab', { ...endpoint, baseUrl: 'http://user:pw@10.0.0.5/v1' }, /not an endpoint address/);
    await refused('lab', { ...endpoint, baseUrl: 'http://10.0.0.5/v1?key=1' }, /not an endpoint address/);
    await refused('lab', { ...endpoint, baseUrl: 'http://127.0.0.1:8787/v1' }, /Harness Relay's own address/);
    await refused('lab', { ...endpoint, models: ['has space'] }, /without spaces/);
    const deleted = await app.request('/api/backends/endpoints/homelab', json('DELETE'));
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as ModelBackendsView).deletedEndpoints).toEqual(['homelab']);
    expect((await app.request('/api/backends/endpoints/homelab', json('DELETE'))).status).toBe(404);
    // Its id, forgotten: once (404 after), and only an endpoint id.
    const forgot = await app.request('/api/backends/deleted-endpoints/homelab', json('DELETE'));
    expect(forgot.status).toBe(200);
    expect(((await forgot.json()) as ModelBackendsView).deletedEndpoints).toEqual([]);
    expect((await app.request('/api/backends/deleted-endpoints/homelab', json('DELETE'))).status).toBe(404);
    expect((await app.request('/api/backends/deleted-endpoints/Home_Lab', json('DELETE'))).status).toBe(400);
  });

  it("refreshes the model menus and the agents' status also after a change that failed part way", async () => {
    const { app, keyring, providers } = setup();
    const changed = vi.spyOn(providers, 'backendsChanged');
    keyring.set = () => {
      throw new Error('the keychain is locked');
    };
    // The endpoint is saved, only its key is refused: what the menus show must follow.
    const r = await app.request('/api/backends/endpoints/lab', json('PUT', { ...endpoint, apiKey: 'lab-key-1234' }));
    expect(r.status).toBe(500);
    expect(changed).toHaveBeenCalledTimes(1);
    const view = (await (await app.request('/api/backends', { headers: HOST })).json()) as ModelBackendsView;
    expect(view.endpoints.map((e) => e.id)).toEqual(['lab']);
    expect((await app.request('/api/backends/openai', json('PUT', { apiKey: 'sk-test-openai-9999' }))).status).toBe(500);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')(
    'shows an open agent ready once it is installed, its adapter is done and a backend is set up; it has no sign-in',
    async () => {
      const { app, settings, providers } = setup();
      const fake = join(root, 'fake-opencode');
      writeFileSync(fake, '#!/bin/sh\necho "1.19.5"\n', { mode: 0o755 });
      settings.update('opencode', { bin: fake });
      // Asked of this CLI alone (GET /api/providers would ask every CLI on this computer).
      const status = (refresh = true) => withLang('en', () => providers.status('opencode', refresh));
      // An adapter that is not done yet.
      const done = opencodeAcp.implemented;
      opencodeAcp.implemented = false;
      try {
        expect(await status()).toMatchObject({
          installed: true,
          version: '1.19.5',
          auth: { loggedIn: false, detail: expect.stringMatching(/not implemented yet/) },
        });
        opencodeAcp.implemented = true;
        expect((await status()).auth).toEqual({ loggedIn: false, detail: 'No model connection set up yet (Settings → Model connections)' });
        await app.request('/api/backends/endpoints/homelab', json('PUT', endpoint));
        await app.request('/api/backends/xai', json('PUT', { apiKey: 'xai-key-0000' }));
        // A change of backends is seen at once (the status cache is dropped).
        expect((await status(false)).auth).toEqual({ loggedIn: true, detail: 'Model connections: xAI, Homelab' });
      } finally {
        opencodeAcp.implemented = done;
      }
      expect(await (await app.request('/api/providers/opencode/login-methods', { headers: HOST })).json()).toEqual([]);
      expect((await app.request('/api/providers/opencode/login', json('POST', {}))).status).toBe(400);
      expect((await app.request('/api/providers/opencode/logout', json('POST', {}))).status).toBe(400);
      providers.shutdown();
    },
  );

  it("drops the cached menus of Claude Code, Codex and Grok (every account's) after the endpoints change, not Cursor's", () => {
    const { providers } = setup();
    const cache = (providers as unknown as { modelCache: Map<string, unknown> }).modelCache;
    const keys = ['claude\0', 'claude\0work', 'codex\0', 'grok\0team', 'cursor\0', 'cursor\0work'];
    for (const key of keys) cache.set(key, { at: Date.now(), models: Promise.resolve({ models: [] }) });
    providers.backendsChanged();
    expect([...cache.keys()]).toEqual(['cursor\0', 'cursor\0work']);
  });

  it("adds each endpoint's models to Claude Code's menu, and asks again after the endpoints change", async () => {
    const { app, settings, providers } = setup();
    // Claude Code's models are its aliases, and its defaults come from its settings file: in a home of the test's own.
    settings.setAgentHome(join(root, `homes-${n}`));
    const ids = async () => (await providers.models('claude')).models.map((m) => m.id);
    expect(await ids()).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    await app.request('/api/backends/endpoints/homelab', json('PUT', endpoint));
    expect(await ids()).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'homelab/muse-glimmer-30b-nvfp4']);
    await app.request('/api/backends/endpoints/homelab', json('DELETE'));
    expect(await ids()).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it("offers an open agent's models of the configured backends: its CLI's catalog and each endpoint's", async () => {
    const { settings, providers } = setup();
    settings.backends.setApiKey('openai', 'sk-o');
    settings.backends.putEndpoint('homelab', endpoint);
    const agent = openAgents.goose;
    const before = { models: agent.models, efforts: agent.efforts };
    // An open agent without a catalog (Cline has one: taken away here, so its CLI is not started).
    const plain = openAgents.cline;
    const plainModels = plain.models;
    plain.models = undefined;
    agent.models = async () => ({
      models: [
        { id: 'openai/gpt-5.4-nano' },
        { id: 'anthropic/claude-haiku-5-5' },
        { id: 'no-backend' },
        { id: 'homelab/muse-glimmer-30b-nvfp4', label: 'Muse' },
      ],
      efforts: ['low', 'high'],
      defaultModel: 'anthropic/claude-haiku-5-5',
    });
    try {
      // Asked of the open agents alone (GET /api/models would ask every CLI on this computer).
      const goose = await providers.models('goose', true);
      expect(goose.models).toEqual([{ id: 'openai/gpt-5.4-nano' }, { id: 'homelab/muse-glimmer-30b-nvfp4', label: 'Muse' }]);
      expect(goose.efforts).toEqual(['low', 'high']);
      expect(goose.cliDefaultModel).toBeUndefined(); // on a backend that is not set up
      expect(goose.source).toBe('cli');
      // Without a catalog: the endpoints' typed models.
      expect((await providers.models('cline', true)).models).toEqual([
        { id: 'homelab/muse-glimmer-30b-nvfp4', label: 'muse-glimmer-30b-nvfp4 · Homelab' },
      ]);
      // Relay's own default comes first.
      settings.updateAccount('goose', '', { defaultModel: 'homelab/muse-glimmer-30b-nvfp4' });
      providers.invalidate('goose');
      expect((await providers.models('goose')).defaultModel).toBe('homelab/muse-glimmer-30b-nvfp4');
    } finally {
      Object.assign(agent, before);
      plain.models = plainModels;
    }
  });
});

describe('the endpoint form (Settings → Model connections)', () => {
  it('makes an id from the name, reads the models typed, and checks the form as the server does', () => {
    expect(endpointSlug('Homelab vLLM')).toBe('homelab-vllm');
    expect(endpointSlug('  Ollama @ home!!  ')).toBe('ollama-home');
    expect(endpointSlug('é'.repeat(3) + 'x'.repeat(40))).toHaveLength(32);
    expect(parseModelList('a\nb, c  a\n')).toEqual(['a', 'b', 'c']);
    expect(normalizedBaseUrl(' https://EXAMPLE.com:443/v1/ ')).toBe('https://example.com/v1');
    expect(normalizedBaseUrl('https://example.com:8443/v1')).toBe('https://example.com:8443/v1');
    expect(validBaseUrl('http://10.0.0.5:8000/v1')).toBe(true);
    expect(validBaseUrl('http://10.0.0.5/v1?x=1')).toBe(false);
    const d = { ...endpointDraft(), name: 'Lab', id: 'lab', baseUrl: 'http://h:1/v1', models: ['m1', 'm2'] };
    expect(endpointProblems(d, [])).toEqual([]);
    expect(endpointProblems({ ...d, id: 'xai' }, [])).toEqual(['idReserved']);
    expect(endpointProblems(d, [{ id: 'lab' }])).toEqual(['idTaken']);
    // Editing one: its id cannot change, so it is not checked.
    expect(endpointProblems({ ...d, id: '' }, [{ id: 'lab' }], 'lab')).toEqual([]);
    expect(endpointProblems({ ...d, name: ' ', baseUrl: 'x', id: 'Bad' }, [])).toEqual(['name', 'id', 'url']);
    // A name too long says so (not "enter a name"); too many models, or one too long, is one problem.
    expect(endpointProblems({ ...d, name: 'x'.repeat(61) }, [])).toEqual(['nameLong']);
    expect(endpointProblems({ ...d, models: Array.from({ length: 101 }, (_, i) => `m${i}`) }, [])).toEqual(['models']);
    expect(endpointProblems({ ...d, models: ['x'.repeat(201)] }, [])).toEqual(['models']);
    expect(endpointUpdate({ ...d, apiKey: ' k ' })).toEqual({
      name: 'Lab',
      baseUrl: 'http://h:1/v1',
      models: ['m1', 'm2'],
      apiKey: 'k',
      limits: {},
    });
    expect(endpointUpdate({ ...d, removeKey: true })).toMatchObject({ apiKey: null });
    expect('apiKey' in endpointUpdate(d)).toBe(false);
  });

  it("takes each model's context window and output limit as typed, and shows where each comes from", () => {
    const view = {
      id: 'lab',
      name: 'Lab',
      baseUrl: 'http://h:1/v1',
      models: ['m1', 'm2', 'm3'],
      keyMasked: '',
      keyStorage: 'database' as const,
      limits: {
        m1: { reported: { context: 32768 } },
        m2: { context: 8192, output: 1024, reported: { context: 4096 } },
        m3: { output: 512 },
      },
    };
    const d = endpointDraft(view);
    // Only what the user set is theirs to change: the server's figure is shown beside it.
    expect(d.limits).toEqual({ m2: { context: '8192', output: '1024' }, m3: { context: '', output: '512' } });
    expect(limitsShown(view)).toEqual([
      { model: 'm1', context: 32768, fromServer: true },
      { model: 'm2', context: 8192, output: 1024 },
      { model: 'm3', output: 512 },
    ]);
    expect(tokenCount(32768)).toBe('32,768');
    expect(tokensTyped(' 32,768 ')).toBe(32768);
    expect(tokensTyped('32 768')).toBe(32768);
    expect(tokensTyped('')).toBe('');
    expect(tokensTyped('32k')).toBeNaN();
    expect(tokensTyped('-1')).toBeNaN();
    expect(limitDraft(d, 'm1')).toEqual({ context: '', output: '' });
    expect(limitDraft(d, 'toString')).toEqual({ context: '', output: '' });
    const typed = { ...d, limits: withLimit(d, 'm1', { context: '16,384' }) };
    expect(endpointUpdate(typed).limits).toEqual({ m1: { context: 16384 }, m2: { context: 8192, output: 1024 }, m3: { output: 512 } });
    // A model no longer selected takes its figures along; a cleared one has none (the server's applies).
    const cleared = { ...typed, models: ['m1', 'm2'], limits: withLimit(typed, 'm2', { context: '', output: '' }) };
    expect(endpointUpdate(cleared).limits).toEqual({ m1: { context: 16384 } });
    expect(endpointProblems({ ...cleared, name: 'Lab', id: 'lab' }, [])).toEqual([]);
    for (const bad of [
      { context: '512' },
      { context: 'abc' },
      { output: '0' },
      { context: '8192', output: '8192' },
      { context: '20000000' },
    ])
      expect(endpointProblems({ ...cleared, limits: withLimit(cleared, 'm1', bad) }, []), JSON.stringify(bad)).toEqual(['limits']);
    expect(limitsTyped({ limits: { m9: { context: 'x', output: '' } } }, ['m1'])).toEqual({});
  });
});
