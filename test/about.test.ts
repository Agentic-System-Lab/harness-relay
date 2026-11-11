import { describe, expect, it } from 'vitest';
import { aboutInfo, bundledVersion, versionText } from '../src/server/about';

describe('about', () => {
  it('names the version the desktop app was built as, else the commit it runs from', () => {
    expect(versionText('2026-11-10-rc.1', 'abc1234')).toBe('2026-11-10-rc.1');
    expect(versionText(undefined, 'abc1234')).toBe('source (abc1234)');
    expect(versionText(undefined, undefined)).toBe('source');
  });

  it('has no bundled version when run from source', () => {
    expect(bundledVersion()).toBeUndefined();
  });

  it('says how it runs and on what, without paths', async () => {
    const info = await aboutInfo(true, async () => '2026-11-10');
    expect(info).toEqual({ version: '2026-11-10', desktop: true, os: expect.stringMatching(/^\S+ \S+ \(\S+\)$/), node: process.version });
  });
});
