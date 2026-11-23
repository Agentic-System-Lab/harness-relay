import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PASS_ENV } from '../src/shared/agentEnv';
import type { Provider, ProviderSettingsView, SettingsView } from '../src/shared/types';
import { NOTICE_KEY, addPassName, readNoticeSeen, removePassName, showNotice, withheldByCli, writeNoticeSeen } from '../src/web/agentEnv';

/** A settings view with only what these functions read: each CLI's environment. */
function view(envs: Partial<Record<Provider, { withheld: string[] } | undefined>>): SettingsView {
  const providers = Object.entries(envs).map(
    ([provider, env]) =>
      ({ provider, ...(env ? { environment: { pass: [], withheld: env.withheld } } : {}) }) as unknown as ProviderSettingsView,
  );
  return { providers } as unknown as SettingsView;
}

afterEach(() => vi.unstubAllGlobals());

describe('the notice of the keys a CLI is not given', () => {
  const v = view({
    claude: { withheld: ['OPENAI_API_KEY'] },
    codex: { withheld: [] },
    grok: { withheld: ['HF_TOKEN', 'MISTRAL_API_KEY'] },
    opencode: undefined,
  });

  it("lists the CLIs that are not given some key, in Settings' order, the installed ones when told", () => {
    expect(withheldByCli(v)).toEqual([
      { provider: 'claude', names: ['OPENAI_API_KEY'] },
      { provider: 'grok', names: ['HF_TOKEN', 'MISTRAL_API_KEY'] },
    ]);
    expect(withheldByCli(v, (p) => p === 'grok')).toEqual([{ provider: 'grok', names: ['HF_TOKEN', 'MISTRAL_API_KEY'] }]);
    expect(withheldByCli(undefined)).toEqual([]);
  });

  it('shows once, while some installed CLI is not given a key', () => {
    expect(showNotice(v, false)).toBe(true);
    expect(showNotice(v, true)).toBe(false);
    expect(showNotice(undefined, false)).toBe(false);
    expect(showNotice(v, false, (p) => p === 'codex')).toBe(false);
    expect(showNotice(view({ claude: { withheld: [] } }), false)).toBe(false);
  });

  it('remembers in this browser that it was seen, and copes without storage', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, value: string) => void data.set(k, value),
    });
    expect(readNoticeSeen()).toBe(false);
    writeNoticeSeen();
    expect(data.get(NOTICE_KEY)).toBe('1');
    expect(readNoticeSeen()).toBe(true);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readNoticeSeen()).toBe(false);
    expect(() => writeNoticeSeen()).not.toThrow();
  });
});

describe("a CLI's pass-through list in the page", () => {
  it('adds a name trimmed, once, while there is room, as the server takes it', () => {
    expect(addPassName(['HF_TOKEN'], ' OPENAI_API_KEY ')).toEqual({ list: ['HF_TOKEN', 'OPENAI_API_KEY'] });
    expect(addPassName(['HF_TOKEN'], 'HF_TOKEN')).toEqual({ error: 'twice' });
    for (const bad of ['', '1ABC', 'A-B', 'A B', 'A=B', 'x'.repeat(129)]) expect(addPassName([], bad), bad).toEqual({ error: 'name' });
    const full = Array.from({ length: MAX_PASS_ENV }, (_, i) => `V${i}`);
    expect(addPassName(full, 'ONE_MORE')).toEqual({ error: 'full' });
    expect(removePassName(['A', 'B', 'C'], 'B')).toEqual(['A', 'C']);
  });
});
