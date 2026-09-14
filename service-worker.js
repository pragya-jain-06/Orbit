// Orbit service worker — only handles push notifications and notification clicks.
// It intentionally does no caching, so the app always loads the latest files from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload = { title: 'Orbit', body: 'You have a deadline coming up.', url: '/' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch { /* keep default */ }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: payload.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});