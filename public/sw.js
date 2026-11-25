// App-shell cache so the driver view opens with no signal. API calls are never cached.
const CACHE = 'tawseel-shell-v1';
const SHELL = ['/', '/index.html', '/driver.html', '/dispatch.html', '/track.html', '/app.css', '/common.js', '/i18n.js', '/driver.js', '/dispatch.js', '/track.js', '/index.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/driver.html')))
  );
});
