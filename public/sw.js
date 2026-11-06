/* Deliberately small offline boundary: no app shell, API, OAuth, user images or audio caching. */
const CACHE = 'mugi-public-offline-v1';
const PUBLIC_FILES = ['/offline.html', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC_FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mugi-public-offline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never intercept sensitive routes, including their query strings or unexpected subpaths.
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/auth/') || url.pathname === '/auth') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
