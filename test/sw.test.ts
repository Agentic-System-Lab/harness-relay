import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/*
 * The service worker (src/web/public/sw.js), run as a browser would load it, with a stand-in `self`:
 * what it shows for a push, and where a click on a notification goes.
 */

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'web', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://relay.tail1234.ts.net';

interface FakeClient {
  url: string;
  focused: boolean;
  visibilityState: 'visible' | 'hidden';
  messages: unknown[];
  postMessage(m: unknown): void;
  focus(): Promise<FakeClient>;
  focusedTimes: number;
}

function client(o: Partial<Pick<FakeClient, 'focused' | 'visibilityState'>> = {}): FakeClient {
  const c: FakeClient = {
    url: `${ORIGIN}/`,
    focused: o.focused ?? false,
    visibilityState: o.visibilityState ?? 'hidden',
    messages: [],
    focusedTimes: 0,
    postMessage: (m) => void c.messages.push(m),
    focus: async () => {
      c.focusedTimes++;
      return c;
    },
  };
  return c;
}

function worker(windows: FakeClient[] = []) {
  const handlers = new Map<string, (e: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const subscribed: unknown[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => void handlers.set(type, fn),
    skipWaiting: () => Promise.resolve(),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
      pushManager: { subscribe: async (options: unknown) => void subscribed.push(options) },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  runInNewContext(SOURCE, { self, URL });
  /** Fires an event and waits for what it asked to be waited for. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
  };
  return { handlers, shown, opened, subscribed, fire };
}

const pushEvent = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } });

describe('the service worker', () => {
  it('listens for what it needs, and handles no requests (no fetch handler)', () => {
    expect([...worker().handlers.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push', 'pushsubscriptionchange']);
  });

  it('shows every push as the server wrote it, with its tag, sound and link', async () => {
    const w = worker();
    await w.fire('push', pushEvent({ title: 'Fix login', body: 'Claude finished replying', tag: 'relay-c1', url: '/#/c/c1', silent: true }));
    expect(w.shown).toEqual([
      {
        title: 'Fix login',
        options: { body: 'Claude finished replying', tag: 'relay-c1', renotify: true, silent: true, icon: '/icons/icon-192.png', data: { url: `${ORIGIN}/#/c/c1` } },
      },
    ]);
  });

  it('shows a notification also for a push it cannot read, and links only to its own site', async () => {
    const w = worker();
    await w.fire('push', { data: { json: () => JSON.parse('not json') } });
    await w.fire('push', { data: null });
    await w.fire('push', pushEvent({ title: 42, url: 'https://evil.example/' }));
    expect(w.shown.map((n) => [n.title, n.options.body, n.options.tag, (n.options.data as { url: string }).url])).toEqual([
      ['Harness Relay', '', undefined, `${ORIGIN}/`],
      ['Harness Relay', '', undefined, `${ORIGIN}/`],
      ['Harness Relay', '', undefined, `${ORIGIN}/`],
    ]);
  });

  it('opens the chat of a clicked notification in a window it has, the focused one first, or in a new one', async () => {
    const close = () => undefined;
    const notification = { close, data: { url: `${ORIGIN}/#/c/c1` } };
    const hidden = client();
    const focused = client({ focused: true, visibilityState: 'visible' });
    const w = worker([hidden, focused]);
    await w.fire('notificationclick', { notification });
    expect(focused.messages).toEqual([{ type: 'relay:open', url: `${ORIGIN}/#/c/c1` }]);
    expect(focused.focusedTimes).toBe(1);
    expect(hidden.messages).toEqual([]);

    const none = worker([]);
    await none.fire('notificationclick', { notification: { close, data: { url: 'https://evil.example/' } } });
    expect(none.opened).toEqual([`${ORIGIN}/`]);
  });

  it('subscribes again with the same key when the push service replaced the subscription', async () => {
    const w = worker();
    const options = { userVisibleOnly: true, applicationServerKey: new Uint8Array([4, 1, 2]) };
    await w.fire('pushsubscriptionchange', { oldSubscription: { options } });
    await w.fire('pushsubscriptionchange', {});
    expect(w.subscribed).toEqual([options]);
  });
});
