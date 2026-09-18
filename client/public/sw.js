// Spica Service Worker v1.0.0
const CACHE_NAME = 'spica-pwa-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/logo.jpg',
  '/favicon.jpg',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log('[SW] Removing old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIリクエストやActivityPub、POST等はネットワーク優先
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/inbox') ||
    url.pathname.startsWith('/users/') ||
    url.pathname.startsWith('/.well-known/') ||
    url.pathname.startsWith('/nodeinfo/') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // 静的アセット: Network first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ==========================================
// 🔔 Web Push 通知受信 (PWA / バックグラウンド)
// ==========================================
self.addEventListener('push', (event) => {
  let data = {
    title: 'Spica',
    body: '新しい通知が届きました',
    icon: '/logo.jpg',
    url: '/?view=notifications',
    tag: 'spica-notification',
  };

  if (event.data) {
    try {
      const json = event.data.json();
      data = { ...data, ...json };
    } catch {
      data.body = event.data.text() || data.body;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/logo.jpg',
    badge: '/favicon.jpg',
    tag: data.tag || 'spica-notification',
    data: { url: data.url || '/?view=notifications' },
    vibrate: [100, 50, 100],
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 通知クリック時のアプリ遷移・フォーカス
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/?view=notifications';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if (client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
