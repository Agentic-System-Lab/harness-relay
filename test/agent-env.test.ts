import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_PROVIDERS, PROVIDERS, isOpenProvider, type Provider } from '../src/shared/types';
import {
  MAX_PASS_ENV,
  MODEL_ADDRESS_VARS,
  MODEL_KEY_VARS,
  OWN_KEY_VARS,
  SIGN_IN_ORDER,
  codexConfigKeys,
  codexHomeFor,
  codexHomeKeys,
  envSignIn,
  passEnvList,
  withheldEnv,
  type SignInProvider,
} from '../src/server/agentEnv';
import { INHERITED_BACKEND_VARS } from '../src/server/backends';
import { openDatabase, type Database } from '../src/server/db';
import type { SecretStore } from '../src/server/secrets';
import { API_KEY_ENV, CREDENTIAL_ENV, SettingsStore } from '../src/server/settings';

const GITHUB_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN'];
const SIGN_IN = PROVIDERS.filter((p): p is SignInProvider => !isOpenProvider(p));

let dir: string;
let file: string;
let db: Database;

/** Every key and address of the lists unset, so that the developer's own environment does not count. */
function clearModelVars(): void {
  const order = Object.values(SIGN_IN_ORDER).flat();
  for (const k of [...MODEL_KEY_VARS, ...MODEL_ADDRESS_VARS, ...INHERITED_BACKEND_VARS, ...GITHUB_TOKENS, ...order, 'CODEX_HOME'])
    vi.stubEnv(k, '');
}

function fakeKeyring(): SecretStore {
  const data = new Map<string, string>();
  return {
    storage: 'keychain',
    get: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-agent-env-'));
  file = join(dir, 'relay.db');
  db = openDatabase(file);
  clearModelVars();
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('the lists of model keys', () => {
  it('sorts every variable the open agents lose into a key or an address, once', () => {
    const keys = new Set<string>(MODEL_KEY_VARS);
    const addresses = new Set<string>(MODEL_ADDRESS_VARS);
    for (const k of INHERITED_BACKEND_VARS) expect(keys.has(k) !== addresses.has(k), k).toBe(true);
    for (const k of [...keys, ...addresses]) expect(INHERITED_BACKEND_VARS as readonly string[], k).toContain(k);
    expect(keys.size).toBe(MODEL_KEY_VARS.length);
    expect(addresses.size).toBe(MODEL_ADDRESS_VARS.length);
  });

  it("counts each CLI's own sign-in among the keys, and keeps it its own", () => {
    for (const p of SIGN_IN) {
      for (const k of CREDENTIAL_ENV[p]) {
        // GitHub's tokens, and a sign-in's kind (Antigravity's AGY_ADC_AUTH), are no model key.
        if (GITHUB_TOKENS.includes(k) || (MODEL_ADDRESS_VARS as readonly string[]).includes(k)) continue;
        expect(MODEL_KEY_VARS as readonly string[], `${p}: ${k}`).toContain(k);
        expect(OWN_KEY_VARS[p], `${p}: ${k}`).toContain(k);
      }
      if (API_KEY_ENV[p]) expect(OWN_KEY_VARS[p]).toContain(API_KEY_ENV[p]);
      for (const k of OWN_KEY_VARS[p]) expect(MODEL_KEY_VARS as readonly string[], `${p}: ${k}`).toContain(k);
    }
  });

  it("never withholds GitHub's or the cloud's tokens, nor an address", () => {
    for (const k of [...GITHUB_TOKENS, 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) {
      expect(MODEL_KEY_VARS as readonly string[]).not.toContain(k);
    }
    for (const k of MODEL_ADDRESS_VARS) expect(MODEL_KEY_VARS as readonly string[]).not.toContain(k);
  });
});

describe('the sign-in a default account runs on (envSignIn)', () => {
  it('lists every variable each CLI takes a sign-in from, in its order', () => {
    for (const p of SIGN_IN) for (const k of CREDENTIAL_ENV[p]) expect(SIGN_IN_ORDER[p], `${p}: ${k}`).toContain(k);
  });

  it('names the first one the CLI takes, not the first one listed', () => {
    // Claude Code takes ANTHROPIC_AUTH_TOKEN before ANTHROPIC_API_KEY, and a cloud provider before both.
    expect(envSignIn('claude', { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o' })).toBe(
      'ANTHROPIC_AUTH_TOKEN',
    );
    expect(envSignIn('claude', { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('CLAUDE_CODE_USE_BEDROCK');
    expect(envSignIn('claude', { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: 'false' })).toBe(
      'ANTHROPIC_API_KEY',
    );
    expect(envSignIn('copilot', { GITHUB_TOKEN: 'g', GH_TOKEN: 'h' })).toBe('GH_TOKEN');
    expect(envSignIn('grok', {})).toBeUndefined();
    expect(envSignIn('opencode', { OPENAI_API_KEY: 'k' })).toBeUndefined();
  });

  it('names none once a key Settings keeps comes first, and the one above it when one does', () => {
    // A saved Copilot token goes in COPILOT_GITHUB_TOKEN, which Copilot takes before GH_TOKEN.
    expect(envSignIn('copilot', { GH_TOKEN: 'h' }, 'COPILOT_GITHUB_TOKEN')).toBeUndefined();
    // A saved Claude key goes in ANTHROPIC_API_KEY, which ANTHROPIC_AUTH_TOKEN still goes before.
    expect(envSignIn('claude', { ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o' }, 'ANTHROPIC_API_KEY')).toBe(
      'ANTHROPIC_AUTH_TOKEN',
    );
    expect(envSignIn('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'o' }, 'ANTHROPIC_API_KEY')).toBeUndefined();
  });
});

describe('withheldEnv', () => {
  const shell = {
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-ant',
    XAI_API_KEY: 'xai',
    HF_TOKEN: 'hf',
    GEMINI_API_KEY: '',
    GH_TOKEN: 'gh',
    AWS_SECRET_ACCESS_KEY: 'aws',
    OPENAI_BASE_URL: 'https://llm.example',
    OLLAMA_HOST: '10.0.0.2:11434',
  };

  it("lists the other providers' keys that are set, in the list's order", () => {
    expect(withheldEnv('claude', shell)).toEqual(['OPENAI_API_KEY', 'XAI_API_KEY', 'HF_TOKEN']);
    expect(withheldEnv('codex', shell)).toEqual(['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'HF_TOKEN']);
    expect(withheldEnv('grok', shell)).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN']);
  });

  it("keeps what the user passes on, and what Codex's configuration names, for that CLI", () => {
    expect(withheldEnv('claude', shell, { pass: ['OPENAI_API_KEY', 'NOT_SET'] })).toEqual(['XAI_API_KEY', 'HF_TOKEN']);
    expect(withheldEnv('codex', shell, { codexKeys: ['ANTHROPIC_API_KEY'] })).toEqual(['XAI_API_KEY', 'HF_TOKEN']);
    // A key Codex's configuration names is Codex's alone.
    expect(withheldEnv('claude', shell, { codexKeys: ['OPENAI_API_KEY'] })).toContain('OPENAI_API_KEY');
  });

  it("withholds nothing from an open agent, whose environment is its backend's alone", () => {
    for (const p of OPEN_PROVIDERS) expect(withheldEnv(p, shell, { pass: ['OPENAI_API_KEY'] })).toEqual([]);
  });
});

describe("Codex's configuration", () => {
  it('reads the keys its model providers name, in tables and inline ones, skipping comments', () => {
    const toml = [
      'model_provider = "openrouter"',
      '# env_key = "COMMENTED_OUT"',
      '[model_providers.openrouter]',
      'base_url = "https://openrouter.ai/api/v1"',
      'env_key = "OPENROUTER_API_KEY"',
      "model_providers.azure = { name = 'Azure', env_key = 'AZURE_OPENAI_API_KEY' }",
      '[model_providers.again]',
      'env_key="OPENROUTER_API_KEY"',
      'env_key = "not a name"',
    ].join('\n');
    expect(codexConfigKeys(toml)).toEqual(['OPENROUTER_API_KEY', 'AZURE_OPENAI_API_KEY']);
    expect(codexConfigKeys('')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || !existsSync('/dev/zero'))(
    'reads no config.toml that is not a plain file, which could hold the server up',
    () => {
      const home = join(dir, 'device-home');
      mkdirSync(home);
      symlinkSync('/dev/zero', join(home, 'config.toml'));
      expect(codexHomeKeys(home)).toEqual([]);
    },
  );

  it("finds the home's config.toml, and reads none that is missing or too large", () => {
    const home = join(dir, 'codex-home');
    mkdirSync(home);
    expect(codexHomeKeys(home)).toEqual([]);
    writeFileSync(join(home, 'config.toml'), '[model_providers.m]\nenv_key = "MISTRAL_API_KEY"\n');
    expect(codexHomeKeys(home)).toEqual(['MISTRAL_API_KEY']);
    writeFileSync(join(home, 'config.toml'), `env_key = "MISTRAL_API_KEY"\n${'#'.repeat(1024 * 1024)}`);
    expect(codexHomeKeys(home)).toEqual([]);
    expect(codexHomeFor('/a/home', { CODEX_HOME: '/env/home' })).toBe('/a/home');
    expect(codexHomeFor(undefined, { CODEX_HOME: '/env/home' })).toBe('/env/home');
    expect(codexHomeFor(undefined, {})).toMatch(/\.codex$/);
  });
});

describe('passEnvList', () => {
  it('trims, keeps each name once in order, and refuses what is not a list of names', () => {
    expect(passEnvList([' OPENAI_API_KEY ', 'HF_TOKEN', 'OPENAI_API_KEY', '_X1'])).toEqual({
      names: ['OPENAI_API_KEY', 'HF_TOKEN', '_X1'],
    });
    expect(passEnvList([])).toEqual({ names: [] });
    expect(passEnvList('OPENAI_API_KEY')).toBeUndefined();
    expect(passEnvList([7])).toBeUndefined();
    expect(passEnvList(['1ABC'])).toEqual({ bad: '1ABC' });
    expect(passEnvList(['A-B'])).toEqual({ bad: 'A-B' });
    expect(passEnvList([''])).toEqual({ bad: '' });
    expect(passEnvList(['A=B'])).toEqual({ bad: 'A=B' });
    expect(passEnvList(Array.from({ length: MAX_PASS_ENV }, (_, i) => `V${i}`))).toMatchObject({ names: expect.any(Array) });
    expect(passEnvList(Array.from({ length: MAX_PASS_ENV + 1 }, (_, i) => `V${i}`))).toEqual({ tooMany: true });
    // The same name twice counts once.
    expect(passEnvList([...Array.from({ length: MAX_PASS_ENV }, (_, i) => `V${i}`), 'V0'])).toMatchObject({ names: expect.any(Array) });
  });
});

describe("a CLI's environment (SettingsStore.env)", () => {
  const shell: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant-shell',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-shell',
    OPENAI_API_KEY: 'sk-openai-shell',
    CODEX_API_KEY: 'codex-shell',
    XAI_API_KEY: 'xai-shell',
    GEMINI_API_KEY: 'gemini-shell',
    CURSOR_API_KEY: 'cursor-shell',
    COPILOT_GITHUB_TOKEN: 'copilot-shell',
    META_API_KEY: 'meta-shell',
    HF_TOKEN: 'hf-shell',
    MISTRAL_API_KEY: 'mistral-shell',
    GH_TOKEN: 'gh-shell',
    AWS_SECRET_ACCESS_KEY: 'aws-shell',
    OPENAI_BASE_URL: 'https://llm.example/v1',
    OLLAMA_HOST: '10.0.0.2:11434',
  };
  const stubShell = () => {
    for (const [k, v] of Object.entries(shell)) vi.stubEnv(k, v);
    vi.stubEnv('CODEX_HOME', join(dir, 'codex-default'));
  };
  const keysOf = (env: NodeJS.ProcessEnv) => MODEL_KEY_VARS.filter((k) => env[k]);

  it("gives each CLI's default account its own keys only, and everything else of the server's", () => {
    stubShell();
    const s = new SettingsStore(db);
    expect(keysOf(s.env('claude'))).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(keysOf(s.env('codex'))).toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY']);
    expect(keysOf(s.env('grok'))).toEqual(['XAI_API_KEY']);
    expect(keysOf(s.env('cursor'))).toEqual(['CURSOR_API_KEY']);
    expect(keysOf(s.env('antigravity'))).toEqual(['GEMINI_API_KEY']);
    expect(keysOf(s.env('copilot'))).toEqual(['COPILOT_GITHUB_TOKEN']);
    expect(keysOf(s.env('muse'))).toEqual(['META_API_KEY']);
    for (const p of SIGN_IN) {
      // Nor do they lose GitHub's token, the cloud's, or an address.
      expect(s.env(p), p).toMatchObject({
        GH_TOKEN: 'gh-shell',
        AWS_SECRET_ACCESS_KEY: 'aws-shell',
        OPENAI_BASE_URL: 'https://llm.example/v1',
        OLLAMA_HOST: '10.0.0.2:11434',
      });
    }
  });

  it("leaves the open agents as they were: no key of the server's, whatever is passed on", () => {
    stubShell();
    const s = new SettingsStore(db);
    s.update('opencode', { passEnv: ['HF_TOKEN'] });
    expect(s.passEnv('opencode')).toEqual([]);
    for (const p of OPEN_PROVIDERS) expect(keysOf(s.env(p)), p).toEqual([]);
  });

  it('passes on the keys the user names to that CLI only, for each of its accounts, and keeps the list', () => {
    stubShell();
    const s = new SettingsStore(db);
    s.setAgentHome(join(dir, 'agents'));
    const work = s.addAccount('claude', 'Work');
    s.update('claude', { passEnv: ['OPENAI_API_KEY', 'HF_TOKEN', 'NOT_SET_HERE'] });
    expect(s.env('claude')).toMatchObject({ OPENAI_API_KEY: 'sk-openai-shell', HF_TOKEN: 'hf-shell' });
    // Another account gets them too, but still none of the sign-ins the server was started with.
    const other = s.env('claude', work);
    expect([other.OPENAI_API_KEY, other.HF_TOKEN, other.ANTHROPIC_API_KEY, other.CLAUDE_CODE_OAUTH_TOKEN]).toEqual([
      'sk-openai-shell',
      'hf-shell',
      undefined,
      undefined,
    ]);
    // Not another CLI.
    expect(s.env('grok').OPENAI_API_KEY).toBeUndefined();
    expect(s.env('grok').HF_TOKEN).toBeUndefined();
    // Kept across a restart; set back, withheld again.
    db.close();
    db = openDatabase(file);
    const again = new SettingsStore(db);
    expect(again.passEnv('claude')).toEqual(['OPENAI_API_KEY', 'HF_TOKEN', 'NOT_SET_HERE']);
    expect(again.env('claude').OPENAI_API_KEY).toBe('sk-openai-shell');
    again.update('claude', { passEnv: [] });
    expect(again.env('claude').OPENAI_API_KEY).toBeUndefined();
    expect(again.passEnv('claude')).toEqual([]);
  });

  it("keeps the keys Codex's configuration names, the account's own home's for each account", () => {
    stubShell();
    const s = new SettingsStore(db);
    // The default account without the CLIs' own folder: CODEX_HOME.
    mkdirSync(join(dir, 'codex-default'));
    writeFileSync(join(dir, 'codex-default', 'config.toml'), '[model_providers.m]\nenv_key = "MISTRAL_API_KEY"\n');
    expect(s.env('codex').MISTRAL_API_KEY).toBe('mistral-shell');
    expect(s.env('claude').MISTRAL_API_KEY).toBeUndefined();
    // With the CLIs' own folder: the one there; another account: its own.
    s.setAgentHome(join(dir, 'agents'));
    expect(s.env('codex').MISTRAL_API_KEY).toBeUndefined();
    const work = s.addAccount('codex', 'Work');
    const workHome = s.accountHome('codex', work)!;
    mkdirSync(workHome, { recursive: true });
    writeFileSync(join(workHome, 'config.toml'), '[model_providers.hf]\nenv_key = "HF_TOKEN"\n');
    expect(s.env('codex', work).HF_TOKEN).toBe('hf-shell');
    expect(s.env('codex').HF_TOKEN).toBeUndefined();
    expect(s.withheldEnv('codex', work)).not.toContain('HF_TOKEN');
    expect(s.withheldEnv('codex')).toContain('HF_TOKEN');
  });

  it('shows names only: the variable the default account signs in with, the keys withheld and the ones passed on', () => {
    stubShell();
    vi.stubEnv('GH_TOKEN', 'gh-shell');
    const s = new SettingsStore(db, fakeKeyring());
    s.update('claude', { passEnv: ['HF_TOKEN'] });
    const view = s.view();
    const env = (p: Provider) => view.providers.find((x) => x.provider === p)!.environment;
    expect(env('claude')).toEqual({
      signIn: 'ANTHROPIC_API_KEY',
      withheld: [
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'XAI_API_KEY',
        'GEMINI_API_KEY',
        'MISTRAL_API_KEY',
        'CURSOR_API_KEY',
        'COPILOT_GITHUB_TOKEN',
        'META_API_KEY',
      ],
      pass: ['HF_TOKEN'],
    });
    expect(env('copilot')!.signIn).toBe('COPILOT_GITHUB_TOKEN');
    // A key Settings keeps comes before its variable and the ones below it: the account runs on it.
    s.update('claude', { apiKey: 'sk-ant-stored-123456' });
    s.update('copilot', { apiKey: 'github_pat_stored_123456' });
    const stored = s.view().providers;
    expect(stored.find((x) => x.provider === 'claude')!.environment).not.toHaveProperty('signIn');
    expect(stored.find((x) => x.provider === 'copilot')!.environment).not.toHaveProperty('signIn');
    // Unless one the CLI takes before it is set.
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'bearer-shell');
    expect(s.view().providers.find((x) => x.provider === 'claude')!.environment!.signIn).toBe('ANTHROPIC_AUTH_TOKEN');
    for (const p of OPEN_PROVIDERS) expect(env(p), p).toBeUndefined();
    expect(JSON.stringify(s.view())).not.toMatch(/-shell/);
  });

  it("drops a CLI's saved list that is not valid as it reads it, and keeps the others'", () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('pass_env', ?)").run(
      JSON.stringify({ claude: ['HF_TOKEN'], codex: ['1BAD'], grok: 'HF_TOKEN', opencode: ['HF_TOKEN'], nobody: ['HF_TOKEN'] }),
    );
    const s = new SettingsStore(db);
    expect(PROVIDERS.filter((p) => s.passEnv(p).length).map((p) => [p, s.passEnv(p)])).toEqual([['claude', ['HF_TOKEN']]]);
  });

  it("keeps the list through the CLI's other settings, and leaves it as it was when it cannot be saved", () => {
    const s = new SettingsStore(db);
    s.update('claude', { passEnv: ['HF_TOKEN'] });
    s.update('claude', { bin: '/opt/claude' });
    expect(s.passEnv('claude')).toEqual(['HF_TOKEN']);
    db.close();
    expect(() => s.update('claude', { passEnv: ['MISTRAL_API_KEY'] })).toThrow();
    expect(s.passEnv('claude')).toEqual(['HF_TOKEN']);
    db = openDatabase(file);
  });

  it("passes on a CLI's own sign-in variable to its default account, never to its other accounts", () => {
    stubShell();
    const s = new SettingsStore(db);
    s.setAgentHome(join(dir, 'agents'));
    const work = s.addAccount('codex', 'Work');
    s.update('codex', { passEnv: ['OPENAI_API_KEY', 'HF_TOKEN'] });
    expect(s.env('codex').OPENAI_API_KEY).toBe('sk-openai-shell');
    expect(s.env('codex', work).OPENAI_API_KEY).toBeUndefined();
    expect(s.env('codex', work).HF_TOKEN).toBe('hf-shell');
  });

  it('reads a broken saved list as none', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('pass_env', 'not json')").run();
    expect(new SettingsStore(db).passEnv('claude')).toEqual([]);
  });
});
