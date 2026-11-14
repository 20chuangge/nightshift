/* Desk service worker - shell only.
 *
 *  - never touch /api (SSE + polling must always hit the network)
 *  - navigations: network first, fall back to the cached shell, then offline.html
 *  - static assets: network first, the cache only when offline (cache first
 *    showed the old icon after the rename until a second reload)
 *
 * Only registered on https or localhost: LAN http:// is not a secure context.
 */
// A new name drops every older cache once (activate below).
const VERSION = 'evenlight-v3';
const SHELL = [
  '/', '/index.html', '/manifest.json', '/offline.html',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy)).catch(() => undefined);
          return res;
        })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || Response.error()),
  );
});
