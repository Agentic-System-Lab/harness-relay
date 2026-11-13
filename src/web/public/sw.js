// Harness Relay's service worker: it shows the push notifications the server sends when agents finish
// or need the user (src/server/push.ts, src/server/alerts.ts), and opens the chat when one is clicked.
// The page registers it only once notifications are turned on (src/web/alerts.ts). It handles no
// requests and keeps nothing offline: every page and API request goes to the server as before.
// Written by hand, not built: it is copied into the build as it is, like the rest of public/.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** A link to this site only (the chat's route), else its start page. */
function sameSite(url) {
  try {
    const u = new URL(typeof url === 'string' ? url : '/', self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + '/';
  } catch {
    return self.location.origin + '/';
  }
}

// Every push shows a notification, right away: Safari takes a subscription away whose pushes show
// none. The server sends none to a browser whose Harness Relay page is in front: that page tells it.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const text = (v) => (typeof v === 'string' ? v : '');
  const tag = text(data.tag);
  event.waitUntil(
    self.registration.showNotification(text(data.title) || 'Harness Relay', {
      body: text(data.body),
      ...(tag ? { tag, renotify: true } : {}),
      silent: data.silent === true,
      icon: '/icons/icon-192.png',
      data: { url: sameSite(data.url) },
    }),
  );
});

// Clicked: a window of Harness Relay comes forward and opens the chat (the page follows the message),
// or a new one opens on it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameSite(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((c) => c.focused) || windows.find((c) => c.visibilityState === 'visible') || windows[0];
      if (!client) return self.clients.openWindow(url);
      client.postMessage({ type: 'relay:open', url });
      return client.focus();
    })(),
  );
});
