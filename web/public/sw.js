// Minimal service worker. Network-first for /api/* and HTML navigations,
// cache-first for hashed build assets. Lets the PWA load offline once visited;
// API still requires backend.
const CACHE = 'bearclaw-v4';
const STATIC = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

function put(req, res) {
  const copy = res.clone();
  caches
    .open(CACHE)
    .then((c) => c.put(req, copy))
    .catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) {
    // Always go to network for API + SSE.
    return;
  }
  if (req.method !== 'GET') return;

  // HTML must come from the network: a cached page points at hashed chunks
  // that the next deploy deletes, which crashes the app on load.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => put(req, res))
        .catch(async () => {
          // Never resolve undefined here — that surfaces as a bare network
          // error instead of a page.
          const hit = (await caches.match(req)) || (await caches.match('/'));
          return (
            hit ||
            new Response('<h1>Offline</h1>', {
              status: 503,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          );
        }),
    );
    return;
  }

  // Hashed build output is immutable — safe to serve from cache.
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => put(req, res))
            .catch(() => Response.error()),
      ),
    );
    return;
  }

  // Everything else: cache, revalidating in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => put(req, res))
        .catch(() => hit || Response.error());
      return hit || net;
    }),
  );
});
