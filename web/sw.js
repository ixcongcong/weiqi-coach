/* 离线缓存：第一次打开后，所有文件都缓存在本机，断网也能用。
 * 发布新版本时修改 VERSION：浏览器发现 sw.js 变了，就会在后台下载新文件，
 * 页面收到 controllerchange 后提示“新版本已下载好”。 */
const VERSION = 'weiqi-coach-2.5';
const FILES = [
  './', 'index.html', 'app.css', 'app.js', 'engine.js', 'games.js', 'problems.js', 'faq.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' 跳过 HTTP 缓存，确保拿到的是刚发布的新文件
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 先用缓存（离线可用），同时在后台更新缓存
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
