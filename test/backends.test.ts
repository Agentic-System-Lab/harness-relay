import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBackendModel, type ModelBackendsView } from '../src/shared/types';
import type { SecretStore } from '../src/server/secrets';
import { endpointDraft, endpointProblems, endpointSlug, endpointUpdate, parseModelList, validBaseUrl } from '../src/web/backends';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-backends-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { ModelBackendStore, backendEnv, backendRun, urlHost } = await import('../src/server/backends');
const { SettingsStore, OPEN_AGENT_HOME_ENV, OPEN_HOMES_DIR } = await import('../src/server/settings');
const { createApp } = await import('../src/server/app');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { Store } = await import('../src/server/store');
const { openAgents } = await import('../src/server/agents');
const { opencodeAcp } = await import('../src/server/agents/opencode');
const { withLang } = await import('../src/server/i18n');
const { maskSecret } = await import('../src/server/secrets');
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

const keyColumn = () => (db.prepare('SELECT id, api_key FROM model_backends ORDER BY id').all() as { id: string; api_key: string }[]).map((r) => [r.id, r.api_key]);
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
    } satisfies ModelBackendsView);
    expect(again.configured()).toEqual(['openai', 'homelab']);
    expect(again.forRun()).toEqual({ apis: { openai: 'sk-test-openai-1234' }, endpoints: [{ id: 'homelab', ...endpoint, apiKey: 'lab-key-5678' }] });
    // Removing a key drops the API backend's row; the endpoint keeps its own.
    again.setApiKey('openai', null);
    again.putEndpoint('homelab', { ...endpoint, models: ['a', 'b'] });
    expect(keyColumn()).toEqual([['homelab', 'lab-key-5678']]);
    expect(new ModelBackendStore(reopen()).forRun().endpoints[0]).toMatchObject({ models: ['a', 'b'], apiKey: 'lab-key-5678' });
  });

  it('keeps keys in the credential store, never in the database, under backend-<id> and endpoint-<id>', () => {
    const keyring = fakeKeyring();
    const s = new ModelBackendStore(db, keyring);
    s.setApiKey('anthropic', 'sk-ant-test-0000');
    s.putEndpoint('homelab', { ...endpoint, apiKey: 'lab-key-5678' });
    expect(Object.fromEntries(keyring.data)).toEqual({ 'backend-anthropic-api-key': 'sk-ant-test-0000', 'endpoint-homelab-api-key': 'lab-key-5678' });
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
    expect(s.view().endpoints.map((e) => e.id).slice(0, 3)).toEqual(['lab-0', 'lab-1', 'lab-2']);
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
    expect(lab).toMatchObject({ kind: 'endpoint', model: 'muse', hosts: ['10.0.0.5:8000'], endpoint: { baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'lab' } });
    // On an endpoint, no API backend's key at all; its own key is not one of the usual variables: the adapter places it.
    expect(lab.env).toEqual({});
    expect(lab.backends).toEqual({ apis: {}, endpoints: backends.endpoints });
    // An adapter that asks for every key (allBackendKeys) gets them all.
    expect(backendRun(backends, 'homelab/muse', 'Goose', undefined, true).env).toEqual({ OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' });
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

describe('an open agent’s environment', () => {
  it('gets the configured keys instead of any the server inherited, and a home of Harness Relay’s own', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-the-shell');
    vi.stubEnv('OPENAI_BASE_URL', 'https://elsewhere.example');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-the-shell');
    try {
      const s = new SettingsStore(db);
      s.backends.setApiKey('anthropic', 'sk-ant-settings');
      const env = s.env('goose');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-settings');
      expect(env[OPEN_AGENT_HOME_ENV]).toBe(join(OPEN_HOMES_DIR, 'goose'));
      expect(s.backendsFor('goose')).toEqual({ apis: { anthropic: 'sk-ant-settings' }, endpoints: [] });
      // The other CLIs keep theirs, and get no backends.
      expect(s.env('claude').ANTHROPIC_API_KEY).toBe('sk-ant-from-the-shell');
      expect(s.env('claude')[OPEN_AGENT_HOME_ENV]).toBeUndefined();
      expect(s.backendsFor('claude')).toBeUndefined();
      // With an agent-home folder, the open agents' homes are in it too.
      s.setAgentHome(join(root, 'homes'));
      expect(s.env('pi')[OPEN_AGENT_HOME_ENV]).toBe(join(root, 'homes', 'pi'));
      // Open agents have no API key of their own in their card.
      expect(s.view().providers.find((p) => p.provider === 'pi')).toMatchObject({ apiKeyMasked: '', apiKeyStorage: undefined });
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
    for (const url of refused) expect(() => withLang('en', () => validEndpointUrl(url, 8787, own)), url).toThrow(/Harness Relay's own address/);
    expect(validEndpointUrl('http://10.0.0.5:8787/v1', 8787, own)).toBe('http://10.0.0.5:8787/v1');
    expect(validEndpointUrl('http://localhost:11434/v1', 8787, own)).toBe('http://localhost:11434/v1');
  });
});

describe('model backends over HTTP, and the open agents in Settings', () => {
  const HOST = { host: '127.0.0.1:8787' };
  const json = (method: string, body?: unknown) => ({ method, headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  function setup() {
    const keyring = fakeKeyring();
    const settings = new SettingsStore(db, keyring);
    const store = new Store(db);
    const hub = new Hub();
    const providers = new ProviderService(settings);
    const app = createApp({ auth: null, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers });
    return { app, settings, keyring, providers };
  }

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
    expect((await app.request('/api/backends/openai', { method: 'PUT', headers: { ...HOST, 'content-type': 'text/plain' }, body: '{"apiKey":"x"}' })).status).toBe(415);
  });

  it('adds, changes and deletes endpoints, and checks what it is given', async () => {
    const { app } = setup();
    const put = (id: string, body: unknown) => app.request(`/api/backends/endpoints/${id}`, json('PUT', body));
    const res = await put('homelab', { name: ' Homelab ', baseUrl: 'http://10.0.0.5:8000/v1/', models: ['muse', 'muse', ' other '], apiKey: 'lab-key-1234' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ModelBackendsView).endpoints).toEqual([
      { id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['muse', 'other'], keyMasked: '••••', keyStorage: 'keychain' },
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
    expect((await app.request('/api/backends/endpoints/homelab', json('DELETE'))).status).toBe(200);
    expect((await app.request('/api/backends/endpoints/homelab', json('DELETE'))).status).toBe(404);
  });

  it('shows an open agent ready once it is installed, its adapter is done and a backend is set up; it has no sign-in', async () => {
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
      expect(await status()).toMatchObject({ installed: true, version: '1.19.5', auth: { loggedIn: false, detail: expect.stringMatching(/not implemented yet/) } });
      opencodeAcp.implemented = true;
      expect((await status()).auth).toEqual({ loggedIn: false, detail: 'No model backend set up yet (Settings → Model backends)' });
      await app.request('/api/backends/endpoints/homelab', json('PUT', endpoint));
      await app.request('/api/backends/xai', json('PUT', { apiKey: 'xai-key-0000' }));
      // A change of backends is seen at once (the status cache is dropped).
      expect((await status(false)).auth).toEqual({ loggedIn: true, detail: 'Model backends: xAI, Homelab' });
    } finally {
      opencodeAcp.implemented = done;
    }
    expect(await (await app.request('/api/providers/opencode/login-methods', { headers: HOST })).json()).toEqual([]);
    expect((await app.request('/api/providers/opencode/login', json('POST', {}))).status).toBe(400);
    expect((await app.request('/api/providers/opencode/logout', json('POST', {}))).status).toBe(400);
    providers.shutdown();
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
      models: [{ id: 'openai/gpt-5.4-nano' }, { id: 'anthropic/claude-haiku-5-5' }, { id: 'no-backend' }, { id: 'homelab/muse-glimmer-30b-nvfp4', label: 'Muse' }],
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
      expect((await providers.models('cline', true)).models).toEqual([{ id: 'homelab/muse-glimmer-30b-nvfp4', label: 'muse-glimmer-30b-nvfp4 · Homelab' }]);
      // Relay's own default comes first.
      settings.update('goose', { defaultModel: 'homelab/muse-glimmer-30b-nvfp4' });
      providers.invalidate('goose');
      expect((await providers.models('goose')).defaultModel).toBe('homelab/muse-glimmer-30b-nvfp4');
    } finally {
      Object.assign(agent, before);
      plain.models = plainModels;
    }
  });
});

describe('the endpoint form (Settings → Model backends)', () => {
  it('makes an id from the name, reads the models typed, and checks the form as the server does', () => {
    expect(endpointSlug('Homelab vLLM')).toBe('homelab-vllm');
    expect(endpointSlug('  Ollama @ home!!  ')).toBe('ollama-home');
    expect(endpointSlug('é'.repeat(3) + 'x'.repeat(40))).toHaveLength(32);
    expect(parseModelList('a\nb, c  a\n')).toEqual(['a', 'b', 'c']);
    expect(validBaseUrl('http://10.0.0.5:8000/v1')).toBe(true);
    expect(validBaseUrl('http://10.0.0.5/v1?x=1')).toBe(false);
    const d = { ...endpointDraft(), name: 'Lab', id: 'lab', baseUrl: 'http://h:1/v1', models: 'm1\nm2' };
    expect(endpointProblems(d, [])).toEqual([]);
    expect(endpointProblems({ ...d, id: 'xai' }, [])).toEqual(['idReserved']);
    expect(endpointProblems(d, [{ id: 'lab' }])).toEqual(['idTaken']);
    // Editing one: its id cannot change, so it is not checked.
    expect(endpointProblems({ ...d, id: '' }, [{ id: 'lab' }], 'lab')).toEqual([]);
    expect(endpointProblems({ ...d, name: ' ', baseUrl: 'x', id: 'Bad' }, [])).toEqual(['name', 'id', 'url']);
    // A name too long says so (not "enter a name"); too many models, or one too long, is one problem.
    expect(endpointProblems({ ...d, name: 'x'.repeat(61) }, [])).toEqual(['nameLong']);
    expect(endpointProblems({ ...d, models: Array.from({ length: 101 }, (_, i) => `m${i}`).join('\n') }, [])).toEqual(['models']);
    expect(endpointProblems({ ...d, models: 'x'.repeat(201) }, [])).toEqual(['models']);
    expect(endpointUpdate({ ...d, apiKey: ' k ' })).toEqual({ name: 'Lab', baseUrl: 'http://h:1/v1', models: ['m1', 'm2'], apiKey: 'k' });
    expect(endpointUpdate({ ...d, removeKey: true })).toMatchObject({ apiKey: null });
    expect('apiKey' in endpointUpdate(d)).toBe(false);
  });
});
