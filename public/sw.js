const CACHE = 'kicklive-shell-v3';
const APP_SHELL = ['/', '/index.html', '/site.webmanifest', '/kicklive-icon.png', '/kicklive-logo.png.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Always check the network for the version manifest and HTML, while keeping
  // the last working shell as an offline fallback.
  const isNavigation = event.request.mode === 'navigate' || requestUrl.pathname === '/app-version.json';
  event.respondWith((isNavigation
    ? fetch(event.request).then(response => {
        if (response.ok && requestUrl.pathname !== '/app-version.json') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
    : caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }))
  ).catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html'))));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const client = clients[0];
    if (client) return client.focus();
    return self.clients.openWindow('/#/');
  }));
});
