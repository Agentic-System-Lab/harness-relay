import { describe, expect, it } from 'vitest';
import {
  ALERTED_KEY,
  CHIMES,
  DEFAULT_ALERT_PREFS,
  alertActions,
  alertKey,
  alertText,
  claimAlert,
  isIos,
  keyBytes,
  notifySupport,
  parseAlertPrefs,
  readAlertPrefs,
  sameKey,
  saveAlertPrefs,
  type NotifyEnv,
} from '../src/web/alerts';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import type { Conversation } from '../src/shared/types';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ELECTRON = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) harness-relay/2026.11.1 Chrome/140.0 Electron/39.0.0 Safari/537.36';

const env = (o: Partial<NotifyEnv> = {}): NotifyEnv => ({
  userAgent: CHROME_MAC,
  maxTouchPoints: 0,
  secure: true,
  hasNotification: true,
  hasServiceWorker: true,
  hasPushManager: true,
  standalone: false,
  ...o,
});

describe('notification preferences', () => {
  it('start off, both kinds on once turned on, and read what was saved', () => {
    expect(parseAlertPrefs(null)).toEqual(DEFAULT_ALERT_PREFS);
    expect(DEFAULT_ALERT_PREFS).toEqual({ notify: false, sound: false, done: true, needs: true });
    expect(parseAlertPrefs('{"notify":true,"sound":"yes","done":false}')).toEqual({ notify: true, sound: false, done: false, needs: true });
    expect(parseAlertPrefs('not json')).toEqual(DEFAULT_ALERT_PREFS);
    const storage = memoryStorage();
    saveAlertPrefs(storage, { notify: true, sound: true, done: true, needs: false });
    expect(readAlertPrefs(storage)).toEqual({ notify: true, sound: true, done: true, needs: false });
    expect(readAlertPrefs(undefined)).toEqual(DEFAULT_ALERT_PREFS);
  });
});

describe('notifySupport', () => {
  it('gives notifications and push to a browser over HTTPS or on this computer', () => {
    expect(notifySupport(env())).toEqual({ support: 'ok', push: true });
    expect(notifySupport(env({ hasPushManager: false }))).toEqual({ support: 'ok', push: false });
  });

  it('gives none to a page that is not HTTPS, nor to Safari on an iPhone or iPad until opened from the home screen', () => {
    expect(notifySupport(env({ secure: false }))).toEqual({ support: 'insecure', push: false });
    expect(notifySupport(env({ userAgent: IPHONE, hasNotification: false, hasPushManager: false }))).toEqual({ support: 'install', push: false });
    expect(notifySupport(env({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 }))).toEqual({ support: 'install', push: false });
    expect(notifySupport(env({ userAgent: IPHONE, standalone: true }))).toEqual({ support: 'ok', push: true });
    expect(notifySupport(env({ hasNotification: false }))).toEqual({ support: 'unsupported', push: false });
    expect(isIos({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0 })).toBe(false);
  });

  it("gives the desktop app's window notifications without push (Electron has no push service)", () => {
    expect(notifySupport(env({ userAgent: ELECTRON, secure: false }))).toEqual({ support: 'ok', push: false });
  });
});

describe('alertActions', () => {
  const on = { notify: true, sound: true };
  const where = (o: Partial<Parameters<typeof alertActions>[1]>) => ({ visible: true, focused: true, viewing: false, pushActive: false, ...o });

  it('does nothing about the conversation the user is looking at', () => {
    expect(alertActions(on, where({ viewing: true }))).toEqual({ sound: false, notify: false });
  });

  it('plays the sound in front, and shows a notification only when the window is behind another', () => {
    expect(alertActions(on, where({}))).toEqual({ sound: true, notify: false });
    expect(alertActions(on, where({ focused: false }))).toEqual({ sound: true, notify: true });
    expect(alertActions(on, where({ focused: false, viewing: true }))).toEqual({ sound: true, notify: true });
    expect(alertActions(on, where({ focused: false, pushActive: true }))).toEqual({ sound: true, notify: true });
    expect(alertActions({ notify: false, sound: true }, where({ focused: false }))).toEqual({ sound: true, notify: false });
  });

  it('leaves a page in the background to push notifications, where the browser gets them', () => {
    expect(alertActions(on, where({ visible: false, focused: false, pushActive: true }))).toEqual({ sound: false, notify: false });
    expect(alertActions(on, where({ visible: false, focused: false }))).toEqual({ sound: true, notify: true });
    expect(alertActions({ notify: false, sound: false }, where({ visible: false }))).toEqual({ sound: false, notify: false });
  });
});

describe('claimAlert', () => {
  it('lets one tab of the browser handle each alert, and forgets old ones', () => {
    const storage = memoryStorage();
    const key = alertKey({ id: 'c1', updatedAt: 5 }, 'done');
    expect(key).toBe('c1:done:5');
    expect(claimAlert(storage, key, 1000)).toBe(true);
    expect(claimAlert(storage, key, 2000)).toBe(false);
    expect(claimAlert(storage, 'c2:done:5', 2000)).toBe(true);
    expect(claimAlert(storage, 'c3:done:1', 11 * 60_000)).toBe(true);
    expect(Object.keys(JSON.parse(storage.data.get(ALERTED_KEY)!))).toEqual(['c3:done:1']);
    expect(claimAlert(undefined, key, 0)).toBe(true);
  });
});

describe('alertText', () => {
  const full = {
    agents: [{ id: 'a1', name: 'Claude' }],
    messages: [{ id: 'm', author: { kind: 'agent', agentId: 'a1' }, createdAt: 0, parts: [{ type: 'text', text: 'Shall I deploy? [ASK_USER]' }], status: 'done', asked: true }],
  } as unknown as Conversation;

  it("names the conversation, what happened and what the agent said, in the UI's language", () => {
    expect(alertText({ title: 'Release' }, 'answer', full, en.notifications)).toEqual({ title: 'Release', body: 'Claude asked you something\nShall I deploy?' });
    expect(alertText({ title: 'Release' }, 'done', full, zhTW.notifications).body).toBe('Claude 回覆完了\nShall I deploy?');
    expect(alertText({ title: '' }, 'confirm', undefined, en.notifications)).toEqual({ title: 'Harness Relay', body: "The lead agent's team is ready for you to confirm" });
  });
});

describe('push keys', () => {
  it("tells whether a subscription was made with the server's key", () => {
    const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
    const bytes = keyBytes(key);
    expect(bytes).toHaveLength(65);
    expect(Buffer.from(bytes).toString('base64url')).toBe(key);
    expect(sameKey(bytes.buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array(65).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });

  it('has a sound for each kind of alert: two notes for a reply, three for a need', () => {
    expect(CHIMES.done).toHaveLength(2);
    expect(CHIMES.needs).toHaveLength(3);
  });
});
