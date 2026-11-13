/**
 * Notifications and sound when agents finish or need the user (Settings → Notifications), in this
 * browser. Which changes count is the shared rule (`src/shared/notify.ts`), on the conversations the
 * sidebar polls. What this page does with one depends on where the user is:
 *
 * - looking at that conversation (the page in front, its window focused): nothing, they see it;
 * - the page in front: a sound, and a system notification when its window is behind another one;
 * - the page in the background: nothing when this browser gets push notifications (the server sends
 *   one: it holds them only while the page says it is in front, `src/server/alerts.ts`), else a
 *   system notification and the sound.
 *
 * Push notifications (Web Push) reach a phone, or a browser with no Harness Relay page open: this
 * browser subscribes with its push service through the service worker (`public/sw.js`), which shows
 * them. The desktop app's window has no push service, so there the page alone tells the user, while
 * the window is open. The DOM-free parts are tested in test/alerts-web.test.ts.
 */
import { useSyncExternalStore } from 'react';
import { AlertTracker, alertDetail, alertTag, alertUrl, wanted } from '../shared/notify';
import { PUSH_GONE, PUSH_TAKEN, type AlertKind, type AlertPrefs, type Conversation, type ConversationSummary, type PushSubscriptionJson } from '../shared/types';
import type { Messages } from './i18n';
import { isAppWindow } from './update';

/** What this browser wants: system notifications (`notify`), a sound, and for which alerts. */
export interface BrowserAlertPrefs extends AlertPrefs {
  notify: boolean;
}

/** Where the choices are kept (this browser only, like the theme). */
export const ALERTS_KEY = 'relay:alerts';

/** Off until turned on (notifications need the browser's permission); both kinds once they are. */
export const DEFAULT_ALERT_PREFS: BrowserAlertPrefs = { notify: false, sound: false, done: true, needs: true };

/** Saved choices; what is missing or not a boolean is the default. */
export function parseAlertPrefs(value: string | null | undefined): BrowserAlertPrefs {
  let raw: Record<string, unknown> = {};
  try {
    raw = value ? ((JSON.parse(value) as Record<string, unknown>) ?? {}) : {};
  } catch {
    /* defaults */
  }
  const flag = (k: keyof BrowserAlertPrefs) => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : DEFAULT_ALERT_PREFS[k]);
  return { notify: flag('notify'), sound: flag('sound'), done: flag('done'), needs: flag('needs') };
}

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readAlertPrefs(storage: PrefStorage | null | undefined): BrowserAlertPrefs {
  try {
    return parseAlertPrefs(storage?.getItem(ALERTS_KEY));
  } catch {
    return DEFAULT_ALERT_PREFS;
  }
}

export function saveAlertPrefs(storage: PrefStorage | null | undefined, prefs: BrowserAlertPrefs): void {
  try {
    storage?.setItem(ALERTS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: kept until the page is loaded again */
  }
}

/** What the browser can do here, and why not. */
export type NotifySupport = 'ok' | 'insecure' | 'install' | 'unsupported';

/** What `notifySupport` reads of the browser (a fake one in the tests). */
export interface NotifyEnv {
  userAgent: string;
  maxTouchPoints: number;
  /** `window.isSecureContext`: HTTPS, or this computer (localhost). */
  secure: boolean;
  hasNotification: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  /** Opened from the home screen (`display-mode: standalone`, or iOS's `navigator.standalone`). */
  standalone: boolean;
}

/** An iPhone or iPad (iPadOS says it is a Mac, but has a touch screen). */
export const isIos = (env: Pick<NotifyEnv, 'userAgent' | 'maxTouchPoints'>) =>
  /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);

/**
 * Whether this browser can show notifications (`ok`), and whether it gets push notifications too. Not:
 * on a page not served over HTTPS (nor from this computer), in Safari on an iPhone or iPad until it is
 * opened from the home screen, or in a browser without them.
 */
export function notifySupport(env: NotifyEnv): { support: NotifySupport; push: boolean } {
  if (isAppWindow(env.userAgent)) return { support: env.hasNotification ? 'ok' : 'unsupported', push: false };
  if (!env.secure) return { support: 'insecure', push: false };
  if (isIos(env) && !env.standalone) return { support: 'install', push: false };
  if (!env.hasNotification) return { support: 'unsupported', push: false };
  return { support: 'ok', push: env.hasServiceWorker && env.hasPushManager };
}

/**
 * What Settings says under "Show notifications": what turning them on gives here (push, or only while
 * the page is open, or the desktop app's window), or why it cannot be (the browser, the site blocked,
 * subscribing failed, the server cannot send them).
 */
export function notifyNoteFor(
  s: {
    support: NotifySupport;
    canPush: boolean;
    app: boolean;
    permission: NotificationPermission | 'unsupported';
    notifying: boolean;
    push: Pick<PushInfo, 'active' | 'error' | 'failure'>;
  },
  n: Messages['notifications'],
): { text: string; warn?: boolean } {
  if (s.support !== 'ok') return { text: n.support[s.support], warn: true };
  if (s.permission === 'denied') return { text: n.denied, warn: true };
  if (s.notifying && s.push.failure) return { text: n.pushFailed(s.push.failure), warn: true };
  if (s.notifying && s.push.error) return { text: s.push.error, warn: true };
  if (s.app) return { text: n.notifyApp };
  if (!s.canPush || (s.notifying && !s.push.active)) return { text: n.notifyPage };
  return { text: n.notifyPush };
}

/** Where the user is when an alert comes. */
export interface AlertSituation {
  /** The page is shown (not a background tab, a minimized window or a locked phone). */
  visible: boolean;
  /** Its window has the keyboard (not behind another program's). */
  focused: boolean;
  /** It shows the conversation the alert is about. */
  viewing: boolean;
  /** This browser gets push notifications, which tell it while the page is in the background. */
  pushActive: boolean;
}

/** What the page does about an alert: play the sound, show a system notification. */
export function alertActions(prefs: Pick<BrowserAlertPrefs, 'notify' | 'sound'>, s: AlertSituation): { sound: boolean; notify: boolean } {
  if (s.visible && s.focused && s.viewing) return { sound: false, notify: false };
  if (s.visible) return { sound: prefs.sound, notify: prefs.notify && !s.focused };
  if (s.pushActive) return { sound: false, notify: false };
  return { sound: prefs.sound, notify: prefs.notify };
}

/** The alerts each tab of this browser has already handled (so that only one of them does). */
export const ALERTED_KEY = 'relay:alerted';
const ALERTED_FOR_MS = 10 * 60_000;

/**
 * Whether this tab (`tab`: its own id) is the one of this browser to handle an alert (`key`); records
 * it when it is. Another tab's claim of the same alert in the last ten minutes wins; this tab's own
 * does not (the same need again, a second approval in one reply). Without storage, every tab is.
 */
export function claimAlert(storage: PrefStorage | null | undefined, key: string, tab: string, now: number): boolean {
  let seen: Record<string, { tab?: unknown; at?: unknown }> = {};
  try {
    seen = (JSON.parse(storage?.getItem(ALERTED_KEY) ?? '{}') as typeof seen) ?? {};
  } catch {
    seen = {};
  }
  const live = (e: { at?: unknown } | undefined) => typeof e?.at === 'number' && now - e.at < ALERTED_FOR_MS;
  const mine = seen[key];
  if (live(mine) && mine!.tab !== tab) return false;
  const kept = Object.fromEntries(Object.entries(seen).filter(([, e]) => live(e)));
  try {
    storage?.setItem(ALERTED_KEY, JSON.stringify({ ...kept, [key]: { tab, at: now } }));
  } catch {
    /* storage unavailable */
  }
  return true;
}

/**
 * An alert's key among the tabs: the same news in every tab, whenever each polled (the conversation,
 * the kind, and the latest reply it is about).
 */
export const alertKey = (conv: Pick<ConversationSummary, 'id' | 'lastReplyId'>, kind: AlertKind) => `${conv.id}:${kind}:${conv.lastReplyId ?? ''}`;

/** A notification's text: the conversation's title, then what happened and what the agent said. */
export function alertText(
  conv: Pick<ConversationSummary, 'title'>,
  kind: AlertKind,
  full: Pick<Conversation, 'agents' | 'messages'> | undefined,
  m: Messages['notifications'],
): { title: string; body: string } {
  const detail = full ? alertDetail(full, kind) : {};
  const line = m.alert[kind](detail.agent);
  return { title: conv.title || 'Harness Relay', body: detail.text ? `${line}\n${detail.text}` : line };
}

/** Whether a push subscription was made with this server's key (base64url). */
export function sameKey(key: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!key) return false;
  let s = '';
  for (const byte of new Uint8Array(key)) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === publicKey.replace(/=+$/, '');
}

/** A base64url key as the bytes `pushManager.subscribe` takes. */
export function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(publicKey.length / 4) * 4, '='));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------- In the browser ----------

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let prefs: BrowserAlertPrefs = DEFAULT_ALERT_PREFS;
let prefsRead = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function currentPrefs(): BrowserAlertPrefs {
  if (!prefsRead) {
    prefsRead = true;
    prefs = readAlertPrefs(browserStorage());
    // Changed in another tab: this one follows.
    globalThis.addEventListener?.('storage', (e: StorageEvent) => {
      if (e.key !== ALERTS_KEY) return;
      prefs = parseAlertPrefs(e.newValue);
      notify();
    });
  }
  return prefs;
}

/** This browser's choices now. */
export const alertPrefsNow = (): BrowserAlertPrefs => currentPrefs();

export function setAlertPrefs(next: Partial<BrowserAlertPrefs>): void {
  prefs = { ...currentPrefs(), ...next };
  saveAlertPrefs(browserStorage(), prefs);
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** This browser's choices, kept up to date. */
export function useAlertPrefs(): BrowserAlertPrefs {
  return useSyncExternalStore(subscribe, currentPrefs, currentPrefs);
}

/** This browser's push subscription, as the last sync left it. */
export interface PushInfo {
  active: boolean;
  endpoint?: string;
  /** Why it has none although notifications are on: the server's word (it cannot send them now). */
  error?: string;
  /** The browser's own, when subscribing failed (its push service refused, say). */
  failure?: string;
}

let push: PushInfo = { active: false };
const pushListeners = new Set<() => void>();
const pushInfo = () => push;

function setPush(next: PushInfo): void {
  push = next;
  pushListeners.forEach((fn) => fn());
}

export function usePushInfo(): PushInfo {
  return useSyncExternalStore(
    (fn) => {
      pushListeners.add(fn);
      return () => pushListeners.delete(fn);
    },
    pushInfo,
    pushInfo,
  );
}

/** How often an open page checks its push subscription (the server may have dropped it). */
export const PUSH_RESYNC_MS = 10 * 60_000;

/** Whether this browser gets push notifications now. */
export const pushActive = () => push.active;

/** What this browser can do (the real one). */
export function browserSupport(): { support: NotifySupport; push: boolean } {
  const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined;
  return notifySupport({
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    secure: globalThis.isSecureContext === true,
    hasNotification: typeof globalThis.Notification === 'function',
    hasServiceWorker: Boolean(nav && 'serviceWorker' in nav),
    hasPushManager: typeof (globalThis as { PushManager?: unknown }).PushManager === 'function',
    standalone: nav?.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches),
  });
}

/** The browser's permission to show notifications ('default': not asked yet). */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  return typeof globalThis.Notification === 'function' ? Notification.permission : 'unsupported';
}

/** The parts of the HTTP API the push sync uses (`api.ts`). */
export interface PushApi {
  pushStatus(): Promise<{ publicKey?: string; error?: string }>;
  pushSubscribe(subscription: PushSubscriptionJson, prefs: AlertPrefs): Promise<unknown>;
  pushUnsubscribe(endpoint: string): Promise<unknown>;
}

async function registration(register: boolean): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  if (!register) return navigator.serviceWorker.getRegistration('/');
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/**
 * Puts this browser's push subscription in step with its choices: subscribed (with this server's
 * key, made again when the key changed; anew when its push service told the server it is gone) and
 * the server told of it and of the choices, while notifications are on and allowed; else
 * unsubscribed, on both sides. Run at start, on each change, when the page comes back to the front
 * and now and then (the server may have dropped a subscription its push service no longer took).
 * One at a time: a call waits for the one before it.
 */
export function syncPush(api: PushApi, p: BrowserAlertPrefs): Promise<PushInfo> {
  syncing = syncing.then(() => syncOnce(api, p));
  return syncing;
}

let syncing: Promise<PushInfo> = Promise.resolve({ active: false });

async function syncOnce(api: PushApi, p: BrowserAlertPrefs): Promise<PushInfo> {
  const { push: canPush } = browserSupport();
  const on = p.notify && canPush && notifyPermission() === 'granted';
  try {
    const reg = await registration(on);
    let sub = (await reg?.pushManager?.getSubscription()) ?? null;
    if (!on) {
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
        await sub.unsubscribe().catch(() => false);
      }
      // Not needed with notifications off (nor where there is no push service: the page shows them).
      await reg?.unregister().catch(() => false);
      return setPushInfo({ active: false });
    }
    const status = await api.pushStatus();
    if (!status.publicKey) return setPushInfo({ active: false, error: status.error });
    if (sub && !sameKey(sub.options.applicationServerKey, status.publicKey)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    const subscribe = () => reg!.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey!) });
    const choices = { done: p.done, needs: p.needs, sound: p.sound };
    sub ??= await subscribe();
    try {
      await api.pushSubscribe(sub.toJSON() as PushSubscriptionJson, choices);
    } catch (err) {
      // Its push service told the server it is gone, or another session of this browser (signed in
      // anew) still has it: a new one, once.
      const code = (err as { code?: unknown }).code;
      if (code !== PUSH_GONE && code !== PUSH_TAKEN) throw err;
      await sub.unsubscribe().catch(() => false);
      sub = await subscribe();
      await api.pushSubscribe(sub.toJSON() as PushSubscriptionJson, choices);
    }
    return setPushInfo({ active: true, endpoint: sub.endpoint });
  } catch (err) {
    return setPushInfo({ active: false, failure: (err as Error).message || String(err) });
  }
}

function setPushInfo(info: PushInfo): PushInfo {
  setPush(info);
  return info;
}

/**
 * Shows a system notification; clicking it opens `url` (the chat) in this page. Through the service
 * worker where there is one (Chrome on Android shows no other kind), else with `new Notification`.
 * Silent: the page plays its own sound.
 */
export async function showNotification(title: string, body: string, tag: string, url: string): Promise<void> {
  const options = { body, tag, renotify: true, silent: true, icon: '/icons/icon-192.png', data: { url } } as NotificationOptions;
  if (!isAppWindow(navigator.userAgent)) {
    const reg = await registration(false).catch(() => undefined);
    if (reg?.active) {
      await reg.showNotification(title, options);
      return;
    }
  }
  const n = new Notification(title, options);
  n.onclick = () => {
    window.focus();
    openUrl(url);
    n.close();
  };
}

/** Goes to a link of this site in this page (a notification's: the chat's route). */
export function openUrl(url: string): void {
  try {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) location.hash = u.hash;
  } catch {
    /* not a link */
  }
}

/** The service worker says a notification was clicked: this page opens its chat. */
export function listenForClicks(): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === 'relay:open' && typeof data.url === 'string') openUrl(data.url);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

// ---------- Sound ----------

let audio: AudioContext | undefined;

/**
 * What the user does that lets the page play sound from then on. A tap's `pointerdown` does not count
 * in Safari on an iPhone (its `pointerup`, `touchend` and `click` do), and a key's `keydown` does.
 */
export const SOUND_UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/** Starts the page's sound: browsers let a page play one only after the user did something on it. */
export function unlockSound(): void {
  try {
    audio ??= new AudioContext();
    // Suspended until the user does something on the page; Safari also has 'interrupted'.
    if (audio.state !== 'running') void audio.resume().catch(() => undefined);
  } catch {
    /* no Web Audio */
  }
}

/** The notes of each sound (Hz, from its start in seconds): two rising for a reply, three for a need. */
export const CHIMES: Record<'done' | 'needs', [number, number][]> = {
  done: [
    [659.25, 0],
    [987.77, 0.14],
  ],
  needs: [
    [880, 0],
    [880, 0.16],
    [1174.66, 0.32],
  ],
};

/** Plays the sound for an alert (short, soft; generated, no file to load). */
export function playChime(kind: AlertKind | 'test'): void {
  unlockSound();
  const ctx = audio;
  // Not allowed yet (nothing done on the page since it loaded): no sound, rather than every sound
  // since then at once on the first click.
  if (!ctx || ctx.state !== 'running') return;
  const notes = CHIMES[kind === 'approval' || kind === 'confirm' || kind === 'answer' ? 'needs' : 'done'];
  const start = ctx.currentTime + 0.02;
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.18, start + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.4);
  }
}

// ---------- Watching the conversations ----------

/** Where the page is and what it can do, now (`browserPage()`; a fake one in the tests). */
export interface PageEnv {
  visible(): boolean;
  focused(): boolean;
  /** The browser allows notifications. */
  allowed(): boolean;
  pushActive(): boolean;
  prefs(): BrowserAlertPrefs;
  storage: PrefStorage | null | undefined;
  now(): number;
  /** Runs `fn` after `ms`. */
  later(fn: () => void, ms: number): void;
  play(kind: AlertKind): void;
  show(title: string, body: string, tag: string, url: string): Promise<void>;
}

/** The real page. */
export function browserPage(): PageEnv {
  return {
    visible: () => document.visibilityState === 'visible',
    focused: () => document.hasFocus(),
    allowed: () => notifyPermission() === 'granted',
    pushActive,
    prefs: currentPrefs,
    storage: browserStorage(),
    now: Date.now,
    later: (fn, ms) => void setTimeout(fn, ms),
    play: playChime,
    show: showNotification,
  };
}

/** What `PageAlerts` needs from the page. */
export interface PageAlertDeps {
  /** The conversation shown now, if any. */
  viewing(): string | undefined;
  /** A conversation in full, for who replied and what they said. */
  conversation(id: string): Promise<Conversation>;
  messages(): Messages['notifications'];
  env?: PageEnv;
}

/**
 * How long a tab in the background waits before it handles an alert: a tab in front asks for the
 * conversations every 3 seconds, and claims each alert first (also one it says nothing of).
 */
export const BACKGROUND_DELAY_MS = 3500;

/** An id of the page's own, for its tab's claims and to tell the server which page is in front. */
const pageId = () => `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/**
 * The page's side: hears the conversations the sidebar polls, and alerts the user to what changed
 * (`alertActions`). The first list it hears is where it starts: nothing before is news.
 */
export class PageAlerts {
  private tracker = new AlertTracker();
  /** Back in front with push on: the next list asked for since then is where it starts again. */
  private rebase = false;
  /** When the page came back (a list asked for before then does not end `rebase`). */
  private returnedAt = 0;
  /** It has heard its first list. */
  private started = false;
  private readonly env: PageEnv;
  /** This page's id (its tab's claims; `?page=` for the server). */
  readonly id = pageId();

  constructor(private readonly deps: PageAlertDeps) {
    this.env = deps.env ?? browserPage();
  }

  /**
   * The page came back to the front. With push on, what happened while it was away was pushed (or
   * held for the page while it was still in front, and sent once it went), so the next list tells of
   * nothing: a phone opened again does not ring once more for what its lock screen showed.
   */
  returned(): void {
    if (!this.env.pushActive()) return;
    this.rebase = true;
    this.returnedAt = this.env.now();
  }

  /**
   * Whether the page's next poll tells the server it is in front: not before the page has a list to
   * start from (its first, and its first after it came back), so that the server keeps pushing what
   * changed before it, which the page will take as where it starts.
   */
  inFront(): boolean {
    return this.env.visible() && this.started && !this.rebase;
  }

  /** A new list of the conversations, asked for at `askedAt`. */
  heard(list: ConversationSummary[], askedAt = this.env.now()): void {
    const alerts = this.tracker.next(list);
    this.started = true;
    if (this.rebase) {
      // An answer to a poll from before the page came back is no place to start from.
      if (askedAt >= this.returnedAt) this.rebase = false;
      return;
    }
    for (const { conv, kind } of alerts) {
      if (!wanted(kind, this.env.prefs())) continue;
      if (this.env.visible()) this.handle(conv, kind);
      else this.env.later(() => this.handle(conv, kind), BACKGROUND_DELAY_MS);
    }
  }

  private handle(conv: ConversationSummary, kind: AlertKind): void {
    const p = this.env.prefs();
    const visible = this.env.visible();
    const act = alertActions(
      { notify: p.notify && this.env.allowed(), sound: p.sound },
      { visible, focused: this.env.focused(), viewing: this.deps.viewing() === conv.id, pushActive: this.env.pushActive() },
    );
    // A tab in front claims every alert, also one it says nothing of (the chat it shows): no tab in
    // the background then tells of it.
    if (!visible && !act.sound && !act.notify) return;
    if (!claimAlert(this.env.storage, alertKey(conv, kind), this.id, this.env.now())) return;
    if (act.sound) this.env.play(kind);
    if (act.notify) void this.show(conv, kind);
  }

  private async show(conv: ConversationSummary, kind: AlertKind): Promise<void> {
    const full = await this.deps.conversation(conv.id).catch(() => undefined);
    const { title, body } = alertText(conv, kind, full, this.deps.messages());
    await this.env.show(title, body, alertTag(conv.id), alertUrl(conv.id)).catch((err: unknown) => console.warn('[alerts] could not show a notification:', err));
  }
}
