/* 神经网络 Worker：加载 ONNX 网络（onnxruntime-web，WebAssembly），做 PUCT 搜索和单次评估。
 * 所有文件都在本机缓存，离线可用。任务按顺序执行；收到 cancel 就放弃排队中和进行中的任务。 */
importScripts('engine.js', 'nn.js');
goEngine(self);
goNN(self);

const NN = self.NN, Go = self.Go;
let session = null, evaluator = null, search = null, modelName = '', threads = 1, backend = 'wasm', ortKind = '';
let gen = 0, chain = Promise.resolve();

/** 选运行库：大网络在支持 WebGPU 的设备上用显卡，否则用 CPU（WebAssembly 多线程） */
function loadOrt(kind) {
  if (!ortKind) {
    importScripts(kind === 'webgpu' ? 'ort/ort.webgpu.min.js' : 'ort/ort.wasm.min.js');
    ortKind = kind;
    ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
    ort.env.wasm.proxy = false;
  }
  return ortKind;
}

/** 下载网络，边下载边报告进度（大网络第一次要下载近 100 MB） */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载网络失败（${res.status}）`);
  const total = +res.headers.get('Content-Length') || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader(), parts = [];
  let got = 0, lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    const pct = Math.min(99, Math.floor(got / total * 100));
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; self.postMessage({ type: 'progress', pct }); }
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const part of parts) { buf.set(part, off); off += part.length; }
  return buf.buffer;
}

async function load(name, wantGpu) {
  const t0 = Date.now();
  let adapter = null;
  if (wantGpu && self.navigator && navigator.gpu) {
    try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { adapter = null; }
  }
  const kind = loadOrt(adapter ? 'webgpu' : 'wasm');
  // 实测超过 4 线程反而变慢
  threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  const buf = await download(`models/${name}.onnx`);
  backend = 'wasm';
  if (kind === 'webgpu' && adapter) {
    try {
      session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      backend = 'webgpu';
    } catch (e) { session = null; }
  }
  if (!session) session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  modelName = name;
  evaluator = new NN.Evaluator(async (sp, gl, B, n) => {
    const o = await session.run({
      spatial: new ort.Tensor('float32', sp, [B, NN.NSP, n, n]),
      global: new ort.Tensor('float32', gl, [B, NN.NGL]),
    });
    return { policy: o.policy.data, value: o.value.data, score: o.score.data, ownership: o.ownership.data };
  });
  search = new NN.Search(evaluator);
  // 预热，同时测速
  const b = new Go.Board(9);
  const t1 = Date.now();
  await evaluator.evalMany([b], 7, () => [0]);
  evaluator.cache.clear();
  return { loadMs: t1 - t0, evalMs: Date.now() - t1 };
}

function boardOf(state) {
  const b = Go.Board.fromState(state);
  b.track = true;
  return b;
}

async function doEval(m) {
  const bd = boardOf(m.state);
  const [e] = await evaluator.evalMany([bd], m.komi, () => [0, 5]);
  const n = bd.n, own = new Float32Array(bd.size), sgn = bd.toPlay === Go.BLACK ? 1 : -1;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) own[bd.pt(x, y)] = sgn * e.own[y * n + x];
  const policy = [];
  for (let i = 0; i < e.P.length; i++) {
    if (e.P[i] > 0.005) policy.push({ move: i === n * n ? Go.PASS : bd.pt(i % n, (i / n) | 0), prior: e.P[i] });
  }
  policy.sort((a, b) => b.prior - a.prior);
  return { own, score: sgn * e.lead, wr: e.win, lead: e.lead, stdev: e.stdev, policy };
}

async function doSearch(m, myGen) {
  const bd = boardOf(m.state);
  const batch = backend === 'webgpu' ? (bd.n <= 9 ? 16 : bd.n <= 13 ? 12 : 8) : bd.n <= 9 ? 8 : bd.n <= 13 ? 6 : 4;
  return search.run(bd, m.komi, { visits: m.visits, ms: m.ms, batch, stop: () => myGen !== gen });
}

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    chain = chain.then(() => load(m.model, m.gpu))
      .then(r => self.postMessage({ type: 'ready', model: modelName, threads, backend, ...r }))
      .catch(err => self.postMessage({ type: 'error', msg: String(err && err.message || err) }));
    return;
  }
  if (m.type === 'cancel') { gen++; return; }
  const myGen = gen;
  chain = chain.then(async () => {
    if (myGen !== gen || !session) { self.postMessage({ id: m.id, res: null }); return; }
    try {
      const res = m.type === 'eval' ? await doEval(m) : await doSearch(m, myGen);
      self.postMessage({ id: m.id, res: myGen === gen ? res : null });
    } catch (err) {
      self.postMessage({ id: m.id, res: null, err: String(err && err.message || err) });
    }
  });
};
