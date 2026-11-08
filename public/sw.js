// Service Worker: App-Hülle offline, Push-Nachrichten anzeigen, Tipp auf Nachricht öffnet die App.
const CACHE = 'autopilot-v2';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|media|v)\//.test(u.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Autopilot', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Autopilot', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', tag: d.tag || undefined,
    data: { url: d.url || '/', videoId: d.videoId || null }, actions: (d.actions || []).slice(0, 2), requireInteraction: Boolean(d.actions && d.actions.length),
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (e.action === 'post' && d.videoId) {
    // „OK – hochladen“ direkt aus der Benachrichtigung: sofort überall veröffentlichen.
    e.waitUntil(fetch(`/api/videos/${d.videoId}/post-now`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => self.registration.showNotification(r.ok ? 'Wird hochgeladen' : 'Bitte in der App bestätigen', {
        body: r.ok ? 'Du bekommst eine Nachricht, sobald es überall online ist.' : 'Die Freigabe aus der Benachrichtigung hat nicht geklappt. Öffne die App.',
        icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', tag: d.videoId, data: { url: d.url || '/' },
      }))
      .catch(() => {}));
    return;
  }
  const url = d.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.postMessage({ open: url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
