import { describe, expect, it } from 'vitest';
import { AUTO_CONFIRM_KEY, lastAutoConfirm, rememberAutoConfirm } from '../src/web/autoConfirm';

/** A browser's storage, as far as this needs it. */
function storage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

describe('how a new chat starts', () => {
  it("answers right away in a browser's first new chat, and in one whose wait was stored as nothing before", () => {
    expect(lastAutoConfirm(storage())).toBe(true);
    expect(lastAutoConfirm(storage({ [AUTO_CONFIRM_KEY]: '' }))).toBe(true);
    expect(lastAutoConfirm(undefined)).toBe(true);
  });

  it('starts as the last one did, waiting included', () => {
    const store = storage();
    rememberAutoConfirm(false, store);
    expect(store.items.get(AUTO_CONFIRM_KEY)).toBe('0');
    expect(lastAutoConfirm(store)).toBe(false);
    rememberAutoConfirm(true, store);
    expect(lastAutoConfirm(store)).toBe(true);
    rememberAutoConfirm(undefined, store);
    expect(lastAutoConfirm(store)).toBe(false);
  });

  it('answers right away when the storage refuses', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(lastAutoConfirm(broken)).toBe(true);
    expect(() => rememberAutoConfirm(false, broken)).not.toThrow();
  });
});
