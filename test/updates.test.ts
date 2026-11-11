import { describe, expect, it, vi } from 'vitest';
import type { DesktopUpdate, ServerToDesktop, UpdateStatus } from '../src/shared/types';
import { CHECK_ANSWER_MS, Updates } from '../src/server/updates';
import { CHECK_TIMEOUT_MS, CheckAnswers } from '../desktop/src/update';
import { en } from '../src/web/locales/en';
import { dialogsHeld, dialogsOpen, holdDialogs, onDialogsChange, openDialog } from '../src/web/dialogs';
import { isAppWindow, offerShows, pollDelay, shouldOffer, typesText, updateLine, versionChanged, watchVersion } from '../src/web/update';

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
    expect(updates.install()).toBe('none');
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
    expect(app.sent).toEqual([{ type: 'update-check', id: 1 }]);
    app.say({ updates: true, checking: true });
    app.say({ updates: true, available, checkedAt: 9, answered: [1] });
    // What it answered is not part of the state the chat gets.
    expect(await checked).toEqual({ updates: true, available, checkedAt: 9, current: '2026-11-11' });
  });

  it('is not answered by a state already on its way when the check was asked for', async () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    app.say({ updates: true });
    let done = false;
    const checked = updates.check().then((s) => ((done = true), s));
    // The app told this before it heard of the check (a download's progress, say).
    app.say({ updates: true, checkedAt: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    app.say({ updates: true, available, checkedAt: 2, answered: [1] });
    expect(await checked).toMatchObject({ available, checkedAt: 2 });
  });

  it('gives what is known when the app does not say in time, and does not ask an app that does not update', async () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    expect(await updates.check(10)).toEqual({ updates: false, current: '2026-11-11' });
    expect(app.sent).toEqual([]);
    app.say({ updates: true, checking: true, checkedAt: 1 });
    expect(await updates.check(10)).toEqual({ updates: true, checking: true, checkedAt: 1, current: '2026-11-11' });
    // A check not answered in time is no longer waited for.
    expect((updates as unknown as { waiting: Map<number, unknown> }).waiting.size).toBe(0);
  });

  it('asks the app to update only when there is a newer version and none under way, saying which it is', () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    app.say({ updates: true });
    expect(updates.install()).toBe('none');
    app.say({ updates: true, available, progress: { kind: 'downloading', percent: 10 } });
    expect(updates.install()).toBe('under-way');
    app.say({ updates: true, available });
    expect(updates.install()).toBe('asked');
    expect(app.sent).toEqual([{ type: 'update-install' }]);
  });

  it('answers every check asked for at once when the app has checked', async () => {
    const app = fakeApp();
    const updates = new Updates(app.parent, version);
    app.say({ updates: true });
    const both = Promise.all([updates.check(), updates.check()]);
    expect(app.sent).toEqual([{ type: 'update-check', id: 1 }, { type: 'update-check', id: 2 }]);
    app.say({ updates: true, checkedAt: 3, answered: [1, 2] });
    expect((await both).map((s) => s.checkedAt)).toEqual([3, 3]);
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

  it('asks the server often while a check, a download or an install goes on, or a while after Update; else now and then', () => {
    expect(pollDelay(status({ checking: true }))).toBe(2000);
    expect(pollDelay(status({ progress: { kind: 'downloading', percent: 3 } }))).toBe(2000);
    expect(pollDelay(status({ progress: { kind: 'installing' } }))).toBe(2000);
    // Waiting for the conversations can take as long as they reply.
    expect(pollDelay(status({ progress: { kind: 'waiting' } }))).toBe(60_000);
    expect(pollDelay(status())).toBe(60_000);
    expect(pollDelay(undefined)).toBe(60_000);
    // Update was pressed: the app's own dialog may start the update any time now.
    expect(pollDelay(status(), 1000, 5000)).toBe(2000);
    expect(pollDelay(status(), 5000, 5000)).toBe(60_000);
  });

  it('offers a new version only while no other dialog nor the tour is open, then keeps it while it is on offer', () => {
    expect(offerShows(false, { offerable: true, tourOpen: false, dialogsOpen: 0, typing: false })).toBe(true);
    // Never over another dialog (it would take that one's keys), nor over the tour.
    expect(offerShows(false, { offerable: true, tourOpen: false, dialogsOpen: 1, typing: false })).toBe(false);
    expect(offerShows(false, { offerable: true, tourOpen: true, dialogsOpen: 0, typing: false })).toBe(false);
    // Shown, it counts as an open dialog itself: it stays.
    expect(offerShows(true, { offerable: true, tourOpen: false, dialogsOpen: 1, typing: false })).toBe(true);
    // Dismissed, or an update started from the menu: it goes.
    expect(offerShows(true, { offerable: false, tourOpen: false, dialogsOpen: 1, typing: false })).toBe(false);
    expect(offerShows(false, { offerable: false, tourOpen: false, dialogsOpen: 0, typing: false })).toBe(false);
    // Not while the user types into a text field: it would take their keys. Shown, typing elsewhere does not close it.
    expect(offerShows(false, { offerable: true, tourOpen: false, dialogsOpen: 0, typing: true })).toBe(false);
    expect(offerShows(true, { offerable: true, tourOpen: false, dialogsOpen: 1, typing: true })).toBe(true);
    // Not over a voice recording (it holds dialogs back): Escape would close both.
    expect(offerShows(false, { offerable: true, tourOpen: false, dialogsOpen: 0, typing: false, held: true })).toBe(false);
  });

  it('counts keys into text fields as typing, and no others', () => {
    expect(typesText({ tagName: 'TEXTAREA' })).toBe(true);
    expect(typesText({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(typesText({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(typesText({ tagName: 'INPUT' })).toBe(true);
    expect(typesText({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(typesText({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(typesText({ tagName: 'BUTTON' })).toBe(false);
    expect(typesText({ tagName: 'BODY' })).toBe(false);
    expect(typesText(null)).toBe(false);
  });

  it('is not offered again while the page is open once closed without Later, but is next time', () => {
    expect(shouldOffer(status({ available }), null, true, '2026-11-12')).toBe(false);
    expect(shouldOffer(status({ available }), null, true, undefined)).toBe(true);
    // A newer one than the one closed is offered.
    expect(shouldOffer(status({ available: { ...available, version: '2026-11-13' } }), null, true, '2026-11-12')).toBe(true);
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

describe('the dialogs open on the page', () => {
  it('give keys to the top one only, and say how many are open as they open and close', () => {
    let told = 0;
    const stop = onDialogsChange(() => told++);
    const report = openDialog();
    expect(report.isTop()).toBe(true);
    const update = openDialog();
    expect(dialogsOpen()).toBe(2);
    // Escape goes to the update dialog over the report, not to both.
    expect(update.isTop()).toBe(true);
    expect(report.isTop()).toBe(false);
    update.close();
    expect(report.isTop()).toBe(true);
    update.close(); // once only
    report.close();
    expect(dialogsOpen()).toBe(0);
    expect(told).toBe(4);
    stop();
    openDialog().close();
    expect(told).toBe(4);
  });

  it('give keys back to the one below when one under the top closes first', () => {
    const a = openDialog();
    const b = openDialog();
    a.close();
    expect(b.isTop()).toBe(true);
    b.close();
  });

  it('are held back while something that is no dialog goes on (a voice recording), until it is released once', () => {
    let told = 0;
    const stop = onDialogsChange(() => told++);
    const release = holdDialogs();
    expect(dialogsHeld()).toBe(1);
    release();
    release(); // once only
    expect(dialogsHeld()).toBe(0);
    expect(told).toBe(2);
    stop();
  });
});

describe("the app's answers to the chat's checks", () => {
  it('answer each check with the first state told once no check is under way, once', () => {
    const answers = new CheckAnswers();
    expect(answers.take(false)).toBeUndefined();
    answers.ask(1);
    // A check under way: answered when it ends, not before.
    expect(answers.take(true)).toBeUndefined();
    answers.ask(2);
    expect(answers.take(false)).toEqual([1, 2]);
    expect(answers.take(false)).toBeUndefined();
  });
});

describe("the server's wait for a check", () => {
  it("outlasts the app's own wait for GitHub, so a question that stalls is answered as failed, not left under way", () => {
    expect(CHECK_ANSWER_MS).toBeGreaterThan(CHECK_TIMEOUT_MS);
  });
});

describe("the page's watch on the server's version", () => {
  const answer = (current: string) => ({ current }) as UpdateStatus;

  it('tells another version from the one the page was loaded from', () => {
    expect(versionChanged('2026-11-11', '2026-11-12')).toBe(true);
    expect(versionChanged('2026-11-11', '2026-11-11')).toBe(false);
    // No version known yet, or none answered: nothing to compare.
    expect(versionChanged(undefined, '2026-11-12')).toBe(false);
    expect(versionChanged('2026-11-11', undefined)).toBe(false);
  });

  it('reloads the page once the server answers another version, now and then and when the window comes back', async () => {
    vi.useFakeTimers();
    try {
      const versions = ['source (abc)', 'source (abc)', 'down', 'source (def)'];
      const ask = vi.fn(async () => {
        const v = versions.shift() ?? 'source (def)';
        if (v === 'down') throw new Error('restarting');
        return answer(v);
      });
      const reload = vi.fn();
      let focus = () => {};
      const stop = watchVersion(ask, reload, { every: 1000, on: (_event, listener) => ((focus = listener), () => (focus = () => {})) });
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).not.toHaveBeenCalled();
      // The window comes back: asked at once; the same version.
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(ask).toHaveBeenCalledTimes(2);
      // The server is restarting: no answer is no change.
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      // Back with another version: the page reloads, once.
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).toHaveBeenCalledTimes(1);
      // And asks no more.
      const asked = ask.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      focus();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledTimes(asked);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
