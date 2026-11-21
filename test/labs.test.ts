import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SecretStore } from '../src/server/secrets';
import type { LabsView, ModelBackendsView } from '../src/shared/types';
import { labChanged, labConnections, labDraft, labEnvName, labModelSuggestions } from '../src/web/labs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-labs-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { SettingsStore } = await import('../src/server/settings');
const { createApp } = await import('../src/server/app');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { Store } = await import('../src/server/store');

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeKeyring(): SecretStore {
  const data = new Map<string, string>();
  return {
    storage: 'keychain',
    get: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
  };
}

describe('Settings → Labs, as the server keeps it', () => {
  let settings: InstanceType<typeof SettingsStore>;
  beforeEach(() => {
    settings = new SettingsStore(openDatabase(':memory:'), fakeKeyring());
  });

  it("is off unless chosen, the environment's until changed in Settings, and Settings' from then on", () => {
    expect(settings.labs({ runCode: false })).toEqual({ mode: 'off', source: 'default' });
    expect(settings.labs({ runCode: true })).toEqual({ mode: 'code', source: 'env' });
    expect(settings.labs({ runCode: true, rlmModel: 'anthropic/claude-haiku-5-5' })).toEqual({
      mode: 'rlm',
      rlmModel: 'anthropic/claude-haiku-5-5',
      source: 'env',
    });
    // Once saved, also off, the environment no longer decides.
    settings.setLabs({ mode: 'off' });
    expect(settings.labs({ runCode: true, rlmModel: 'anthropic/claude-haiku-5-5' })).toEqual({ mode: 'off', source: 'saved' });
    settings.setLabs({ mode: 'rlm', rlmModel: 'homelab/qwen' });
    expect(settings.labs({ runCode: false })).toEqual({ mode: 'rlm', rlmModel: 'homelab/qwen', source: 'saved' });
    // A model kept only with RLM.
    settings.setLabs({ mode: 'code', rlmModel: 'homelab/qwen' });
    expect(settings.labs({ runCode: false })).toEqual({ mode: 'code', source: 'saved' });
  });
});

describe('Settings → Labs, over the HTTP API', () => {
  let settings: InstanceType<typeof SettingsStore>;
  let unavailable: string | undefined;
  let app: ReturnType<typeof createApp>;
  const HOST = { host: '127.0.0.1:8787' };
  const put = (body: unknown) =>
    app.request('/api/labs', { method: 'PUT', headers: { ...HOST, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    const db = openDatabase(':memory:');
    settings = new SettingsStore(db, fakeKeyring());
    unavailable = undefined;
    const hub = new Hub();
    const store = new Store(db);
    app = createApp({
      auth: null,
      store,
      settings,
      hub,
      orchestrator: new Orchestrator(store, hub, settings),
      providers: new ProviderService(settings),
      labsUnavailable: async () => unavailable,
    });
  });

  it('gives the mode on now and where it comes from, and keeps one mode at a time', async () => {
    const view = await app.request('/api/labs', { headers: HOST });
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual({ mode: 'off', source: 'default' });
    const code = await put({ mode: 'code', rlmModel: 'anthropic/claude-haiku-5-5' });
    expect(await code.json()).toEqual({ mode: 'code', source: 'saved' });
    expect(settings.labs()).toMatchObject({ mode: 'code' });
  });

  it('takes RLM only with a sub-model on a model connection set up now, as <backend>/<model>', async () => {
    const refused = async (body: unknown) => {
      const res = await put(body);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await refused({ mode: 'everything' })).toMatch(/off|關閉/i);
    expect(await refused({ mode: 'rlm' })).toBeTruthy();
    expect(await refused({ mode: 'rlm', rlmModel: 'claude-haiku-5-5' })).toContain('claude-haiku-5-5');
    expect(await refused({ mode: 'rlm', rlmModel: 'anthropic/claude-haiku-5-5' })).toContain('anthropic');
    expect(settings.labs()).toMatchObject({ mode: 'off' });

    settings.backends.setApiKey('anthropic', 'sk-ant-test');
    const ok = await put({ mode: 'rlm', rlmModel: ' anthropic/claude-haiku-5-5 ' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ mode: 'rlm', rlmModel: 'anthropic/claude-haiku-5-5', source: 'saved' });
    // One of the user's own endpoints, whose model's name holds a `/`.
    settings.backends.putEndpoint('homelab', { name: 'Home lab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['Qwen/Qwen3-30B-A3B'] });
    expect((await put({ mode: 'rlm', rlmModel: 'homelab/Qwen/Qwen3-30B-A3B' })).status).toBe(200);
  });

  it('says why the modes cannot run on this computer', async () => {
    unavailable = 'bubblewrap is not installed';
    expect(await (await app.request('/api/labs', { headers: HOST })).json()).toEqual({
      mode: 'off',
      source: 'default',
      unavailable: 'bubblewrap is not installed',
    });
  });
});

describe('Settings → Labs, on the page', () => {
  const backends: ModelBackendsView = {
    apis: [
      { id: 'openai', keyMasked: '', keyStorage: 'keychain' },
      { id: 'anthropic', keyMasked: 'sk-…test', keyStorage: 'keychain' },
      { id: 'xai', keyMasked: '', keyStorage: 'keychain' },
    ],
    endpoints: [
      {
        id: 'homelab',
        name: 'Home lab',
        baseUrl: 'http://10.0.0.5:8000/v1',
        models: ['qwen', 'gemma'],
        keyMasked: '',
        keyStorage: 'keychain',
      },
    ],
    deletedEndpoints: [],
  };

  it("offers the connections set up, the endpoints' models first", () => {
    expect(labConnections(backends)).toEqual(['anthropic', 'homelab']);
    expect(labModelSuggestions(backends)).toEqual(['homelab/qwen', 'homelab/gemma', 'anthropic/']);
    expect(labConnections(undefined)).toEqual([]);
  });

  it('saves a mode at once, and RLM only with a model on one of those connections', () => {
    const on = labConnections(backends);
    expect(labDraft('off', '', on)).toEqual({ settings: { mode: 'off' } });
    expect(labDraft('code', 'ignored/model', on)).toEqual({ settings: { mode: 'code' } });
    expect(labDraft('rlm', '', on)).toEqual({ problem: 'model' });
    expect(labDraft('rlm', 'qwen', on)).toEqual({ problem: 'model' });
    expect(labDraft('rlm', 'openai/gpt-5.4-nano', on)).toEqual({ problem: 'connection' });
    expect(labDraft('rlm', ' homelab/qwen ', on)).toEqual({ settings: { mode: 'rlm', rlmModel: 'homelab/qwen' } });
  });

  it('has something to save when the draft differs, or the mode comes from the environment', () => {
    const saved: LabsView = { mode: 'rlm', rlmModel: 'homelab/qwen', source: 'saved' };
    expect(labChanged(saved, { mode: 'rlm', rlmModel: 'homelab/qwen' })).toBe(false);
    expect(labChanged(saved, { mode: 'rlm', rlmModel: 'homelab/gemma' })).toBe(true);
    expect(labChanged(saved, { mode: 'off' })).toBe(true);
    const env: LabsView = { mode: 'code', source: 'env' };
    expect(labChanged(env, { mode: 'code' })).toBe(true);
    expect(labEnvName(env)).toBe('RELAY_RUN_CODE');
    expect(labEnvName({ mode: 'rlm', rlmModel: 'x/y', source: 'env' })).toBe('RELAY_RLM');
    expect(labChanged(undefined, { mode: 'off' })).toBe(false);
  });
});
