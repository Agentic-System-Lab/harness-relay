import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALERTED_KEY,
  BACKGROUND_DELAY_MS,
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
  notifyNoteFor,
  syncPush,
  SOUND_UNLOCK_EVENTS,
  PageAlerts,
  type PushApi,
  type BrowserAlertPrefs,
  type NotifyEnv,
  type PageEnv,
} from '../src/web/alerts';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { PUSH_GONE, PUSH_TAKEN, type Conversation, type ConversationSummary } from '../src/shared/types';

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
  it('lets one tab of the browser handle each alert, the same tab again, and forgets old ones', () => {
    const storage = memoryStorage();
    const key = alertKey({ id: 'c1', lastReplyId: 'm5' }, 'done');
    expect(key).toBe('c1:done:m5');
    expect(claimAlert(storage, key, 'tabA', 1000)).toBe(true);
    expect(claimAlert(storage, key, 'tabB', 2000)).toBe(false);
    // The same tab: a second approval in one reply, say.
    expect(claimAlert(storage, key, 'tabA', 2000)).toBe(true);
    expect(claimAlert(storage, 'c2:done:m1', 'tabB', 2000)).toBe(true);
    expect(claimAlert(storage, key, 'tabB', 11 * 60_000)).toBe(true);
    expect(Object.keys(JSON.parse(storage.data.get(ALERTED_KEY)!))).toEqual([key]);
    expect(claimAlert(undefined, key, 'tabC', 0)).toBe(true);
  });
});

describe('PageAlerts', () => {
  const summary = (id: string, s: Partial<ConversationSummary> = {}): ConversationSummary => ({
    id,
    title: `Chat ${id}`,
    createdAt: 0,
    updatedAt: 0,
    agents: [],
    running: false,
    lastStatus: 'done',
    ...s,
  });
  const full = {
    agents: [{ id: 'a1', name: 'Claude' }],
    messages: [{ id: 'm2', author: { kind: 'agent', agentId: 'a1' }, createdAt: 0, parts: [{ type: 'text', text: 'All done.' }], status: 'done' }],
  } as unknown as Conversation;

  /** A page: where it is, what it plays and shows, and what it put off. */
  function page(o: { visible?: boolean; focused?: boolean; push?: boolean; viewing?: string; prefs?: Partial<BrowserAlertPrefs>; storage?: ReturnType<typeof memoryStorage> } = {}) {
    const state = { visible: o.visible ?? true, focused: o.focused ?? true, push: o.push ?? false, viewing: o.viewing };
    const played: string[] = [];
    const shown: { title: string; body: string; tag: string; url: string }[] = [];
    const later: (() => void)[] = [];
    const env: PageEnv = {
      visible: () => state.visible,
      focused: () => state.focused,
      allowed: () => true,
      pushActive: () => state.push,
      prefs: () => ({ notify: true, sound: true, done: true, needs: true, ...o.prefs }),
      storage: o.storage ?? memoryStorage(),
      now: () => 1000,
      later: (fn, ms) => {
        expect(ms).toBe(BACKGROUND_DELAY_MS);
        later.push(fn);
      },
      play: (kind) => void played.push(kind),
      show: async (title, body, tag, url) => void shown.push({ title, body, tag, url }),
    };
    const alerts = new PageAlerts({ viewing: () => state.viewing, conversation: async () => full, messages: () => en.notifications, env });
    // The first list is where it starts; the second has c1's reply.
    const start = () => alerts.heard([summary('c1', { running: true, lastReplyId: 'm1' })]);
    const reply = () => alerts.heard([summary('c1', { lastReplyId: 'm2' })]);
    return { state, played, shown, later, alerts, start, reply };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('says nothing of the chat it shows in front, and keeps a tab in the background from saying it', async () => {
    const storage = memoryStorage();
    const front = page({ viewing: 'c1', storage });
    const back = page({ visible: false, focused: false, storage });
    for (const p of [front, back]) p.start();
    front.reply();
    back.reply();
    back.later.forEach((fn) => fn());
    await settle();
    expect([front.played, front.shown, back.played, back.shown]).toEqual([[], [], [], []]);
  });

  it('plays the sound in front, and shows the notification, with who replied and what, when its window is behind another', async () => {
    const p = page({ focused: false });
    p.start();
    p.reply();
    await settle();
    expect(p.played).toEqual(['done']);
    expect(p.shown).toEqual([{ title: 'Chat c1', body: 'Claude finished replying\nAll done.', tag: 'relay-c1', url: '/#/c/c1' }]);
  });

  it('in the background, leaves it to push where the browser has it, and else says it after the tab in front had its turn', async () => {
    const pushed = page({ visible: false, focused: false, push: true });
    pushed.start();
    pushed.reply();
    pushed.later.forEach((fn) => fn());
    expect(pushed.played).toEqual([]);

    const alone = page({ visible: false, focused: false });
    alone.start();
    alone.reply();
    expect(alone.played).toEqual([]);
    alone.later.forEach((fn) => fn());
    await settle();
    expect(alone.played).toEqual(['done']);
    expect(alone.shown).toHaveLength(1);
  });

  it('tells nothing of what happened while it was away, once back with push on, and says it is in front only after that', () => {
    const p = page({ push: true });
    p.start();
    p.state.visible = false;
    expect(p.alerts.inFront()).toBe(false);
    p.state.visible = true;
    p.alerts.returned();
    expect(p.alerts.inFront()).toBe(false);
    p.reply();
    expect(p.alerts.inFront()).toBe(true);
    expect(p.played).toEqual([]);
    p.alerts.heard([summary('c1', { running: true, lastReplyId: 'm2' })]);
    p.alerts.heard([summary('c1', { lastReplyId: 'm3' })]);
    expect(p.played).toEqual(['done']);
  });

  it('says only what this browser asked for', () => {
    const p = page({ prefs: { done: false } });
    p.start();
    p.reply();
    expect(p.played).toEqual([]);
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

describe('PageAlerts, where it starts', () => {
  const summary = (id: string, s: Partial<ConversationSummary> = {}): ConversationSummary => ({ id, title: id, createdAt: 0, updatedAt: 0, agents: [], running: false, ...s });

  function page(push: boolean) {
    let now = 1000;
    const played: string[] = [];
    const env: PageEnv = {
      visible: () => true,
      focused: () => true,
      allowed: () => true,
      pushActive: () => push,
      prefs: () => ({ notify: true, sound: true, done: true, needs: true }),
      storage: null,
      now: () => now,
      later: () => undefined,
      play: (kind) => void played.push(kind),
      show: async () => undefined,
    };
    const alerts = new PageAlerts({ viewing: () => undefined, conversation: async () => ({ agents: [], messages: [] }) as unknown as Conversation, messages: () => en.notifications, env });
    return { alerts, played, tick: (ms: number) => (now += ms), at: () => now };
  }

  it('says it is in front only once it has a list to start from', () => {
    const p = page(true);
    expect(p.alerts.inFront()).toBe(false);
    p.alerts.heard([summary('c1')]);
    expect(p.alerts.inFront()).toBe(true);
  });

  it('starts again only from a list asked for after it came back, not one asked for before', () => {
    const p = page(true);
    p.alerts.heard([summary('c1', { running: true, lastStatus: 'done', lastReplyId: 'm1' })]);
    const before = p.at();
    p.tick(1000);
    p.alerts.returned();
    // An answer to a poll from before it went away comes in late.
    p.alerts.heard([summary('c1', { running: true, lastStatus: 'done', lastReplyId: 'm1' })], before);
    expect(p.alerts.inFront()).toBe(false);
    p.tick(10);
    // The list asked for since then, with what was pushed meanwhile: no sound.
    p.alerts.heard([summary('c1', { lastStatus: 'done', lastReplyId: 'm2' })], p.at());
    expect(p.played).toEqual([]);
    expect(p.alerts.inFront()).toBe(true);
  });

  it('starts the sound on a tap in Safari too (its pointerdown does not count)', () => {
    expect(SOUND_UNLOCK_EVENTS).toEqual(expect.arrayContaining(['pointerup', 'touchend', 'click', 'keydown']));
  });
});

describe('notifyNoteFor', () => {
  const n = en.notifications;
  const base = { support: 'ok' as const, canPush: true, app: false, permission: 'granted' as const, notifying: true, push: { active: true } };

  it('says what turning notifications on gives here', () => {
    expect(notifyNoteFor(base, n)).toEqual({ text: n.notifyPush });
    expect(notifyNoteFor({ ...base, notifying: false, push: { active: false } }, n)).toEqual({ text: n.notifyPush });
    expect(notifyNoteFor({ ...base, canPush: false }, n)).toEqual({ text: n.notifyPage });
    expect(notifyNoteFor({ ...base, app: true, canPush: false }, n)).toEqual({ text: n.notifyApp });
    // On, but not subscribed (yet): only while the page is open.
    expect(notifyNoteFor({ ...base, push: { active: false } }, n)).toEqual({ text: n.notifyPage });
  });

  it('says why it cannot be, the most basic first', () => {
    expect(notifyNoteFor({ ...base, support: 'install', permission: 'unsupported' }, n)).toEqual({ text: n.support.install, warn: true });
    expect(notifyNoteFor({ ...base, permission: 'denied', notifying: false }, n)).toEqual({ text: n.denied, warn: true });
    expect(notifyNoteFor({ ...base, push: { active: false, failure: 'no push service' } }, n)).toEqual({ text: n.pushFailed('no push service'), warn: true });
    expect(notifyNoteFor({ ...base, push: { active: false, error: 'The server cannot.' } }, n)).toEqual({ text: 'The server cannot.', warn: true });
  });
});

describe('syncPush', () => {
  const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const OTHER = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const ON = { notify: true, sound: false, done: true, needs: false };

  /** A browser with a push service: what its service worker and push manager were asked. */
  function browser(o: { subscribeFails?: boolean } = {}) {
    const calls: string[] = [];
    let n = 0;
    let registered = false;
    let current: { endpoint: string; options: { applicationServerKey: ArrayBuffer } } | null = null;
    const make = (key: ArrayBuffer) => {
      const endpoint = `https://fcm.googleapis.com/fcm/send/${++n}`;
      const sub = {
        endpoint,
        options: { applicationServerKey: key },
        toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
        unsubscribe: async () => {
          calls.push(`unsubscribe ${n}`);
          current = null;
          return true;
        },
      };
      current = sub;
      return sub;
    };
    const reg = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (opts: { applicationServerKey: Uint8Array<ArrayBuffer> }) => {
          if (o.subscribeFails) throw new Error('Registration failed - push service error');
          calls.push('subscribe');
          return make(opts.applicationServerKey.buffer);
        },
      },
      unregister: async () => {
        calls.push('unregister');
        registered = false;
        return true;
      },
    };
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
      maxTouchPoints: 0,
      serviceWorker: {
        register: async () => void (registered = true),
        ready: Promise.resolve(reg),
        getRegistration: async () => (registered ? reg : undefined),
      },
    });
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'granted' }));
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    return { calls, keep: (key: string) => make(keyBytes(key).buffer) };
  }

  /** The server: its key, and what it was told. */
  function server(o: { key?: string; error?: string; refuse?: string[] } = {}) {
    const told: string[] = [];
    const refuse = [...(o.refuse ?? [])];
    const api: PushApi = {
      pushStatus: async () => (o.key === undefined && o.error ? { error: o.error } : { publicKey: o.key ?? KEY }),
      pushSubscribe: async (sub, prefs) => {
        const code = refuse.shift();
        if (code) throw Object.assign(new Error(code), { code });
        told.push(`keep ${sub.endpoint.split('/').pop()} ${JSON.stringify(prefs)}`);
      },
      pushUnsubscribe: async (endpoint) => void told.push(`drop ${endpoint.split('/').pop()}`),
    };
    return { api, told };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('subscribes with the server key and tells the server, with the choices', async () => {
    const b = browser();
    const s = server();
    expect(await syncPush(s.api, ON)).toEqual({ active: true, endpoint: 'https://fcm.googleapis.com/fcm/send/1' });
    expect(b.calls).toEqual(['subscribe']);
    expect(s.told).toEqual(['keep 1 {"done":true,"needs":false,"sound":false}']);
    // Again (each load): the same subscription.
    await syncPush(s.api, ON);
    expect(b.calls).toEqual(['subscribe']);
  });

  it('subscribes anew when the server has another key (as after the keyring fix)', async () => {
    const b = browser();
    const s = server({ key: KEY });
    await syncPush(server({ key: OTHER }).api, ON);
    await syncPush(s.api, ON);
    expect(b.calls).toEqual(['subscribe', 'unsubscribe 1', 'subscribe']);
    expect(s.told).toEqual(['keep 2 {"done":true,"needs":false,"sound":false}']);
  });

  it('subscribes anew, once, when the server says the subscription is gone or another session has it', async () => {
    for (const code of [PUSH_GONE, PUSH_TAKEN]) {
      const b = browser();
      const s = server({ refuse: [code] });
      expect((await syncPush(s.api, ON)).active).toBe(true);
      expect(b.calls).toEqual(['subscribe', 'unsubscribe 1', 'subscribe']);
      expect(s.told).toEqual(['keep 2 {"done":true,"needs":false,"sound":false}']);
      vi.unstubAllGlobals();
    }
    browser();
    const twice = server({ refuse: [PUSH_GONE, PUSH_GONE] });
    expect(await syncPush(twice.api, ON)).toMatchObject({ active: false, failure: PUSH_GONE });
  });

  it('unsubscribes on both sides and unregisters the service worker when turned off', async () => {
    const b = browser();
    const s = server();
    await syncPush(s.api, ON);
    expect(await syncPush(s.api, { ...ON, notify: false })).toEqual({ active: false });
    expect(b.calls).toEqual(['subscribe', 'unsubscribe 1', 'unregister']);
    expect(s.told).toEqual(['keep 1 {"done":true,"needs":false,"sound":false}', 'drop 1']);
  });

  it("says why when the server cannot send them, or the browser's push service refused", async () => {
    browser();
    expect(await syncPush(server({ error: 'No push here.' }).api, ON)).toEqual({ active: false, error: 'No push here.' });
    vi.unstubAllGlobals();
    browser({ subscribeFails: true });
    expect(await syncPush(server().api, ON)).toEqual({ active: false, failure: 'Registration failed - push service error' });
  });
});
