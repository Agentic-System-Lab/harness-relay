import { describe, expect, it } from 'vitest';
import type { DesktopUpdate, ServerToDesktop, UpdateStatus } from '../src/shared/types';
import { Updates } from '../src/server/updates';
import { en } from '../src/web/locales/en';
import { isAppWindow, pollDelay, shouldOffer, updateLine } from '../src/web/update';

/** The desktop app, as the server's parent port: what the server sends it, and what it says. */
function fakeApp() {
  const sent: ServerToDesktop[] = [];
  let listener: ((u: DesktopUpdate) => void) | undefined;
  return {
    sent,
    say: (u: DesktopUpdate) => listener?.(u),
    parent: { send: (m: ServerToDesktop) => sent.push(m), onUpdate: (fn: (u: DesktopUpdate) => void) => (listener = fn) },
  };
}

const version = async () => '2026-11-11';
const available = { version: '2026-11-12', page: 'https://github.com/x/y/releases/tag/2026-11-12' };

describe("the desktop app's updates, as the server passes them on", () => {
  it('are only the version when no desktop app started the server', async () => {
    const updates = new Updates(undefined, version);
    expect(await updates.status()).toEqual({ updates: false, current: '2026-11-11' });
    expect(await updates.check()).toEqual({ updates: false, current: '2026-11-11' });
    expect(updates.install()).toBe(false);
  });

  it('are what the app last said, with this version', async () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    app.say({ updates: true, available, checkedAt: 5 });
    expect(await updates.status()).toEqual({ updates: true, available, checkedAt: 5, current: '2026-11-11' });
  });

  it('asks the app to check now, and gives what it says once it has checked', async () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    app.say({ updates: true });
    const checked = updates.check();
    expect(app.sent).toEqual([{ type: 'update-check' }]);
    app.say({ updates: true, checking: true });
    app.say({ updates: true, available, checkedAt: 9 });
    expect(await checked).toEqual({ updates: true, available, checkedAt: 9, current: '2026-11-11' });
  });

  it('gives what is known when the app does not say in time, and does not ask an app that does not update', async () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    expect(await updates.check(10)).toEqual({ updates: false, current: '2026-11-11' });
    expect(app.sent).toEqual([]);
    app.say({ updates: true, checkedAt: 1 });
    expect(await updates.check(10)).toEqual({ updates: true, checkedAt: 1, current: '2026-11-11' });
  });

  it('asks the app to update only when there is a newer version and none under way', () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    app.say({ updates: true });
    expect(updates.install()).toBe(false);
    app.say({ updates: true, available, progress: { kind: 'downloading', percent: 10 } });
    expect(updates.install()).toBe(false);
    app.say({ updates: true, available });
    expect(updates.install()).toBe(true);
    expect(app.sent).toEqual([{ type: 'update-install' }]);
  });
});

describe('the update in the chat', () => {
  const status = (s: Partial<UpdateStatus> = {}): UpdateStatus => ({ updates: true, current: '2026-11-11', ...s });
  const electron = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) harness-relay/2026.1111.0 Chrome/138.0 Electron/37.2.0 Safari/537.36';
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

  it("knows the desktop app's own window from another browser", () => {
    expect(isAppWindow(electron)).toBe(true);
    expect(isAppWindow(phone)).toBe(false);
    expect(isAppWindow('')).toBe(false);
  });

  it('offers a newer version with a dialog once, in the app window, and not while one is under way', () => {
    expect(shouldOffer(status({ available }), null, true)).toBe(true);
    expect(shouldOffer(status({ available }), '2026-11-12', true)).toBe(false);
    expect(shouldOffer(status({ available }), '2026-11-10', true)).toBe(true);
    expect(shouldOffer(status({ available }), null, false)).toBe(false);
    expect(shouldOffer(status({ available, progress: { kind: 'installing' } }), null, true)).toBe(false);
    expect(shouldOffer(status(), null, true)).toBe(false);
    expect(shouldOffer(undefined, null, true)).toBe(false);
  });

  it('asks the server often while something changes, else now and then', () => {
    expect(pollDelay(status({ checking: true }))).toBe(2000);
    expect(pollDelay(status({ progress: { kind: 'downloading', percent: 3 } }))).toBe(2000);
    expect(pollDelay(status())).toBe(60_000);
    expect(pollDelay(undefined)).toBe(60_000);
  });

  it('says what there is to know of updates, an update under way first', () => {
    const v = en.settings.version;
    expect(updateLine(status({ updates: false }), en, 'en')).toEqual({ text: v.noUpdates, tone: 'muted' });
    expect(updateLine(status({ available, progress: { kind: 'downloading', percent: 42 } }), en, 'en')).toEqual({ text: v.downloading(42), tone: 'news' });
    expect(updateLine(status({ progress: { kind: 'waiting' } }), en, 'en').text).toBe(v.waiting);
    expect(updateLine(status({ checking: true, available }), en, 'en').text).toBe(v.checking);
    expect(updateLine(status({ available }), en, 'en')).toEqual({ text: v.available('2026-11-12'), tone: 'news' });
    expect(updateLine(status({ checkFailed: true }), en, 'en')).toEqual({ text: v.checkFailed, tone: 'warn' });
    expect(updateLine(status(), en, 'en')).toEqual({ text: v.notChecked, tone: 'muted' });
    const up = updateLine(status({ checkedAt: Date.UTC(2026, 10, 11, 8, 30) }), en, 'en');
    expect(up.tone).toBe('ok');
    expect(up.text).toMatch(/^Up to date \(checked .*2026.*\)$/);
  });
});
