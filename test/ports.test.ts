import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../desktop/src/prefs';
import { DEFAULT_PORT, DEV_API_PORT, DEV_WEB_PORT, apiPort, devWebPort, isDevRun } from '../src/server/ports';

describe("Harness Relay's ports", () => {
  it('listens on 8787 for npm start, and on a port of its own for npm run dev', () => {
    expect(apiPort({})).toBe(8787);
    expect(apiPort({ npm_lifecycle_event: 'start' })).toBe(8787);
    expect(apiPort({ npm_lifecycle_event: 'dev' })).toBe(DEV_API_PORT);
    expect(isDevRun({ npm_lifecycle_event: 'dev' })).toBe(true);
    expect(isDevRun({ npm_lifecycle_event: 'login' })).toBe(false);
  });

  it('takes PORT over either default', () => {
    expect(apiPort({ PORT: '9000' })).toBe(9000);
    expect(apiPort({ PORT: '9000', npm_lifecycle_event: 'dev' })).toBe(9000);
  });

  it("takes Vite's port from RELAY_DEV_WEB_PORT (the one npm run dev found free), else 5173", () => {
    expect(devWebPort({})).toBe(DEV_WEB_PORT);
    expect(devWebPort({ RELAY_DEV_WEB_PORT: '5174' })).toBe(5174);
    for (const wrong of ['', '0', 'abc', '5173.5', '-1', '65536'])
      expect(devWebPort({ RELAY_DEV_WEB_PORT: wrong }), wrong).toBe(DEV_WEB_PORT);
  });

  it('keeps npm run dev off the port npm start and the desktop app use', () => {
    expect(DEFAULT_PREFS.port).toBe(DEFAULT_PORT);
    expect(new Set([DEFAULT_PORT, DEV_API_PORT, DEV_WEB_PORT]).size).toBe(3);
  });
});
