import { describe, expect, it } from 'vitest';
import type { AccountStatus, ProviderStatus } from '../src/shared/types';
import { en } from '../src/web/locales/en';
import { accountName, accountOf, accountState, readyAccount, switchProvider, timeoutSignal } from '../src/web/util';

describe('switching an agent to another CLI', () => {
  it('restores the model and effort picked for a CLI when switching back to it', () => {
    const lead = { provider: 'claude' as const, model: '', effort: 'xhigh' };
    const toCodex = switchProvider(lead, 'codex', {});
    expect(toCodex.value).toEqual({ provider: 'codex', model: '', effort: '' });
    const picked = { ...toCodex.value, model: 'gpt-5', effort: 'high' };
    const back = switchProvider(picked, 'claude', toCodex.kept);
    expect(back.value).toEqual({ provider: 'claude', model: '', effort: 'xhigh' });
    // And Codex keeps what was picked for it.
    expect(switchProvider(back.value, 'codex', back.kept).value).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'high' });
  });

  it("starts a CLI never picked with its defaults, and keeps the agent's other fields", () => {
    const agent = { id: 'a', name: 'Ann', role: 'Reviews', provider: 'claude' as const, model: 'opus', effort: 'max', tools: { memory: false } };
    const { value } = switchProvider(agent, 'grok', {});
    expect(value).toEqual({ id: 'a', name: 'Ann', role: 'Reviews', provider: 'grok', model: '', effort: '', tools: { memory: false } });
  });

  it('treats a model or effort left unset as the default', () => {
    const lead = { provider: 'grok' as const };
    const away = switchProvider(lead, 'claude', {});
    expect(away.kept.grok).toEqual({ model: '', effort: '' });
    expect(switchProvider(away.value, 'grok', away.kept).value).toEqual({ provider: 'grok', model: '', effort: '' });
  });
});

describe("an agent's account", () => {
  const account = (id: string, loggedIn: boolean | null, extra: Partial<AccountStatus> = {}): AccountStatus => ({
    id,
    label: '',
    auth: { loggedIn },
    usingStoredApiKey: false,
    ...extra,
  });
  const status = (accounts: AccountStatus[], installed = true): ProviderStatus => ({
    provider: 'codex',
    installed,
    bin: 'codex',
    auth: accounts[0]!.auth,
    usingStoredApiKey: accounts[0]!.usingStoredApiKey,
    accounts,
  });

  it('belongs to its CLI: switching away drops it, switching back brings it back', () => {
    const agent = { id: 'a', name: 'Ann', role: '', provider: 'codex' as const, account: 'work0001', model: 'gpt-5' };
    const away = switchProvider(agent, 'claude', {});
    expect(away.value).toEqual({ id: 'a', name: 'Ann', role: '', provider: 'claude', model: '', effort: '' });
    expect('account' in away.value).toBe(false);
    expect(switchProvider({ ...away.value, account: 'claude01' }, 'codex', away.kept).value).toEqual({ ...agent, effort: '' });
  });

  it('is the one it names while the CLI has it, else the default one, and says whether it can run', () => {
    const s = status([account('', false), account('work0001', true, { label: 'Work' }), account('key00001', false, { usingStoredApiKey: true })]);
    expect(accountOf(s, 'work0001')!.label).toBe('Work');
    expect(accountOf(s, 'removed1')!.id).toBe('');
    expect(accountOf(s, undefined)!.id).toBe('');
    expect(accountState(s, undefined)).toBe('warn');
    expect(accountState(s, 'work0001')).toBe('ok');
    expect(accountState(s, 'key00001')).toBe('ok');
    expect(accountState(s, 'removed1')).toBe('warn');
    expect(accountState(status([account('', null)]), undefined)).toBe('ok'); // could not tell
    expect(accountState(status([account('', true)], false), undefined)).toBe('off');
    expect(accountState(undefined, undefined)).toBe('off');
  });

  it("gives a new member the default account when it is ready, else the first that is", () => {
    expect(readyAccount(status([account('', true), account('work0001', true)]))).toBeUndefined();
    expect(readyAccount(status([account('', false), account('work0001', false), account('alt00001', true)]))).toBe('alt00001');
    expect(readyAccount(status([account('', false), account('work0001', false)]))).toBeUndefined();
    expect(readyAccount(status([account('', false), account('work0001', true)], false))).toBeUndefined();
  });

  it('is called by its name, else "Default account", else by its id', () => {
    expect(accountName({ id: '', label: '' }, en)).toBe('Default account');
    expect(accountName({ id: '', label: 'Personal' }, en)).toBe('Personal');
    expect(accountName({ id: 'ab12cd34', label: '' }, en)).toBe('Account ab12cd34');
  });
});

describe('a timeout signal', () => {
  it('aborts after its time, as AbortSignal.timeout() does', async () => {
    const { signal } = timeoutSignal(20);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });

  it('does not abort once cleared, the request being done', async () => {
    const { signal, clear } = timeoutSignal(20);
    clear();
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(false);
  });
});
