import { describe, expect, it } from 'vitest';
import { KEYRING_SERVICE, keyringService, openSystemKeyring } from '../src/server/secrets';

describe('the credential store', () => {
  it('files keys under harness-relay, or the name RELAY_KEYRING_SERVICE gives (the desktop app)', () => {
    expect(KEYRING_SERVICE).toBe('harness-relay');
    expect(keyringService({})).toBe('harness-relay');
    expect(keyringService({ RELAY_KEYRING_SERVICE: ' ' })).toBe('harness-relay');
    expect(keyringService({ RELAY_KEYRING_SERVICE: 'harness-relay-desktop' })).toBe('harness-relay-desktop');
  });

  it('is not used with RELAY_KEYRING=off', () => {
    const before = process.env.RELAY_KEYRING;
    process.env.RELAY_KEYRING = 'off';
    try {
      expect(openSystemKeyring()).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.RELAY_KEYRING;
      else process.env.RELAY_KEYRING = before;
    }
  });
});
