import { expect, it, vi } from 'vitest';

it('restores both the request ID and the original interrupt choice across a reload', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  const attempts: { requestId: string; interrupt: boolean }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    attempts.push(JSON.parse(String(init.body)));
    if (attempts.length === 1) throw new TypeError('Connection lost');
    return Response.json({ ok: true, queued: false });
  });
  try {
    const { loadMessages, currentLang } = await import('../src/web/i18n');
    await loadMessages(currentLang());
    const { api } = await import('../src/web/api');
    await expect(api.send('test', 'Original draft', [], true)).rejects.toThrow();
    expect([...saved.entries()].flat().join()).not.toContain('Original draft');
    vi.resetModules();
    const reloaded = (await import('../src/web/api')).api;
    await reloaded.send('test', 'Original draft', [], false);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[1]?.interrupt).toBe(true);
    expect(saved.size).toBe(0);
    await reloaded.send('test', 'Original draft', [], false);
    expect(attempts[2]?.requestId).not.toBe(attempts[0]?.requestId);
    expect(attempts[2]?.interrupt).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
