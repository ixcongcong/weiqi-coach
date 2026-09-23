/* 离线缓存：第一次打开后，所有文件都缓存在本机，断网也能用。
 * 发布新版本时修改 VERSION：浏览器发现 sw.js 变了，就会在后台下载新文件，
 * 页面收到 controllerchange 后提示“新版本已下载好”。
 * 神经网络和 onnxruntime 很大（约 30 MB），放在单独的 ASSETS 缓存里，文件名不变就不重新下载。 */
const VERSION = 'weiqi-coach-3.1';
const ASSETS = 'weiqi-assets-1';
const FILES = [
  './', 'index.html', 'app.css', 'app.js', 'engine.js', 'nn.js', 'nnworker.js', 'games.js', 'problems.js', 'faq.js', 'assistant.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const BIG = ['ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm', 'models/b10.onnx', 'models/b6.onnx'];
const isBig = url => /\/(ort|models)\//.test(new URL(url).pathname);

async function cacheBig() {
  const c = await caches.open(ASSETS);
  for (const f of BIG) {
    const req = new Request(f);
    if (!(await c.match(req))) {
      try { const res = await fetch(req); if (res.ok) await c.put(req, res); } catch (e) { /* 下次再试 */ }
    }
  }
}

self.addEventListener('install', e => {
  // cache: 'reload' 跳过 HTTP 缓存，确保拿到的是刚发布的新文件
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => cacheBig())
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== ASSETS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 加上跨源隔离的响应头，WebAssembly 才能用多线程（神经网络算得更快）
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (new URL(url).origin !== self.location.origin) return;
  if (isBig(url)) {
    // 大文件：缓存优先，不在后台刷新
    e.respondWith(caches.open(ASSETS).then(async cache => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return isolate(hit);
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return isolate(res);
    }));
    return;
  }
  // 先用缓存（离线可用），同时在后台更新缓存
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => hit);
    return isolate(hit || await net);
  }));
});
