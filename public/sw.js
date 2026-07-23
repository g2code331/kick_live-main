const CACHE = 'kicklive-shell-v4';
const APP_SHELL = ['/', '/index.html', '/site.webmanifest', '/kicklive-icon.png', '/kicklive-logo.png.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation = event.request.mode === 'navigate';
  const isVersionManifest = url.pathname === '/app-version.json';
  const isApk = url.pathname.endsWith('.apk');

  // Never cache version checks or APKs. They must always reach the server.
  if (isVersionManifest || isApk) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isNavigation) {
    // Fresh HTML prevents stale bundles after the app has been suspended.
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for the static shell, with a network fallback for new assets.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const client = clients[0];
    if (client) return client.focus();
    return self.clients.openWindow('/#/');
  }));
});
