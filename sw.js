// PHANTOM BEATS PWA Service Worker —— 缓存应用外壳，支持离线安装
const CACHE = 'pb-pwa-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // 非 GET（含 WebSocket）直接放行
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 网络优先：每次打开都拉最新代码；离线时回退缓存
  e.respondWith(
    fetch(req).then((resp) => {
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});
