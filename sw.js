/* PHANTOM BEATS Service Worker (v3.83)
 * 策略：
 *   · index.html / app.js  = 网络优先，成功即更新缓存，断网回退缓存（刷新即最新，断网也能开）
 *   · 图标等静态资源       = 缓存优先
 *   · /api/ 动态接口与跨域请求 = 一律直连，不缓存（在线曲库、云端识别等）
 * 注：Service Worker 仅在 HTTPS / localhost 生效；局域网 http://IP 访问时浏览器
 *     会拒绝注册，页面自动跳过，一切功能不受影响。 */
const CACHE = 'pb-v3.83';
const SHELL = ['./', './index.html', './app.js', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // 跨域（云端API等）直连
  if (url.pathname.includes('/api/')) return;      // 动态接口直连（在线曲库等）

  // 图标：缓存优先
  if (/icon-\d+\.png$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const cp = res.clone();
        caches.open(CACHE).then(c => c.put(req, cp));
        return res;
      }))
    );
    return;
  }

  // 页面/脚本：网络优先，失败回退缓存
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const cp = res.clone();
        caches.open(CACHE).then(c => c.put(req, cp));
      }
      return res;
    }).catch(() =>
      caches.match(req).then(hit => hit || caches.match('./index.html'))
    )
  );
});
