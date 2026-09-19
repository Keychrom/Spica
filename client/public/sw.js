// Spica Service Worker v3.0.0 (Robust Offline & PWA Navigation & Maskable Icons)
const CACHE_NAME = 'spica-pwa-v3';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.jpg',
  '/favicon.jpg'
];

// 📦 インストール時: 必須シェルアセットをプリキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching app shell assets');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 🔄 アクティベート時: 古いキャッシュの自動パージ & 即時クライアント制御
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log('[SW] Deleting legacy cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 🌐 フェッチハンドラ: ナビゲーションと静的アセットの最適キャッシュ
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. 非GETリクエスト、API、ActivityPub、WebSocket、外部ドメインはキャッシュ対象外
  if (
    req.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/inbox') ||
    url.pathname.startsWith('/nodeinfo/') ||
    url.pathname.startsWith('/.well-known/')
  ) {
    return;
  }

  // 2. 📱 ナビゲーションリクエスト（HTML画面遷移・PWA起動）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('/index.html', clone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          console.log('[SW] Offline navigation fallback to cached /index.html');
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          return caches.match('/');
        })
    );
    return;
  }

  // 3. 🎨 静的アセット（JS / CSS / 画像 / フォントなど）
  // Cache-First: キャッシュにあれば即返却、なければネットワークから取得してキャッシュに保存
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, clone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // 画像等で取得できない場合のフォールバック
          if (req.destination === 'image') {
            return caches.match('/favicon.jpg');
          }
          return null;
        });
    })
  );
});

// ==========================================
// 🔔 Web Push 通知受信 (PWA / バックグラウンド)
// ==========================================
self.addEventListener('push', (event) => {
  let data = {
    title: 'Spica',
    body: '新しい通知が届きました',
    icon: '/icon-192.png',
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
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
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
