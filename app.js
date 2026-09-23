'use strict';
/* 围棋对战教练：对战、学习（课程与名局）、练习、提问。
 * 引擎在 engine.js；蒙特卡洛计算在 Web Worker 里进行，局部死活计算在主线程（很快）。 */

const APP_VERSION = '3.2';
const G = window.Go;
const { EMPTY, BLACK, WHITE, PASS, NONE, RESIGN } = G;
const GAMES = window.GAMES || [];
const PROBLEMS = window.PROBLEMS || [];

// kind：mcts = 传统蒙特卡洛引擎；policy = 神经网络的第一感（不计算）；nn = 神经网络 + 搜索。
// 神经网络不可用时，policy / nn 难度改用 playouts / ms 指定的传统引擎。
const LEVELS = [
  { name: '入门', kind: 'mcts', playouts: 300, ms: 1000, random: true, note: '适合新手' },
  { name: '初级', kind: 'mcts', playouts: 1500, ms: 2000 },
  { name: '中级', kind: 'policy', temp: 1, playouts: 6000, ms: 4000, note: '凭棋感，偶尔随意' },
  { name: '高级', kind: 'policy', greedy: true, playouts: 20000, ms: 8000, note: '神经网络第一感' },
  { name: '业余高段', kind: 'nn', visits: 0, playouts: 60000, ms: 15000, note: '神经网络 + 计算' },
  { name: '职业水平', kind: 'nn', visits: 1600, nnMs: 12000, playouts: 60000, ms: 15000, note: '思考较久' },
];
// 每个局面的分析量（用于讲解、胜率、形势判断）。visits 是神经网络搜索的次数，playouts 是传统引擎的模拟次数
const BUDGET = {
  9: { playouts: 8000, ms: 2500, own: 400, visits: 200 },
  13: { playouts: 5000, ms: 3000, own: 300, visits: 120 },
  19: { playouts: 4000, ms: 3500, own: 240, visits: 80 },
};
const STUDY_BUDGET = { playouts: 2500, ms: 2000, own: 200, visits: 60 };
const ENGINES = {
  b10: '神经网络（强，推荐）',
  b6: '神经网络（快，适合旧设备）',
  mcts: '传统引擎（不用神经网络）',
};
const FINAL_OWN = { 9: 1200, 13: 900, 19: 600 };
const STORE_KEY_BASE = 'weiqi-coach-v1';
const RECORDS_KEY_BASE = 'weiqi-coach-records';
const USERS_KEY = 'weiqi-coach-users';

// 用户：每个用户的对局、进度分开保存；用户 ID 与家里“弈 · 学习中心”的用户 ID 相同
let USERS = null;
function newUserId() { return `coach-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function saveUsers() { try { localStorage.setItem(USERS_KEY, JSON.stringify(USERS)); } catch (e) { /* 忽略 */ } }
function loadUsers() {
  try { USERS = JSON.parse(localStorage.getItem(USERS_KEY) || 'null'); } catch (e) { USERS = null; }
  if (USERS && USERS.list && USERS.list.length) return;
  // 第一次使用（或从旧版本升级）：旧数据归到第一个用户；旧版同步过的学习中心用户直接沿用
  let id = newUserId(), name = '我';
  try {
    const old = JSON.parse(localStorage.getItem(STORE_KEY_BASE) || 'null');
    if (old && old.sync && old.sync.userId) { id = old.sync.userId; name = old.sync.userName || name; }
    for (const k of [STORE_KEY_BASE, RECORDS_KEY_BASE]) {
      const v = localStorage.getItem(k);
      if (v !== null && localStorage.getItem(`${k}:${id}`) === null) localStorage.setItem(`${k}:${id}`, v);
    }
  } catch (e) { /* 忽略 */ }
  const now = new Date().toISOString();
  USERS = { current: id, list: [{ id, name, createdAt: now, updatedAt: now }] };
  saveUsers();
}
function curUser() { return USERS.list.find(u => u.id === USERS.current) || USERS.list[0]; }
const storeKey = () => `${STORE_KEY_BASE}:${curUser().id}`;
const recordsKey = () => `${RECORDS_KEY_BASE}:${curUser().id}`;
loadUsers();
const LEVEL_NAMES = { 1: '第 1 级：吃子入门', 2: '第 2 级：吃子技巧', 3: '第 3 级：对杀与死活' };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => Math.round(v * 100) + '%';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const colorName = c => (c === BLACK ? '黑' : '白');
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function sgfPt(b, s) {
  return s === 'tt' ? PASS : b.pt(s.charCodeAt(0) - 97, s.charCodeAt(1) - 97);
}
/** 坐标名（如 D4）→ 棋盘点；不合法返回 -1 */
function nameToPt(b, name) {
  const m = /^([A-HJ-T])(\d{1,2})$/i.exec(String(name).trim());
  if (!m) return -1;
  const x = G.LETTERS.indexOf(m[1].toUpperCase()), row = +m[2];
  if (x < 0 || x >= b.n || row < 1 || row > b.n) return -1;
  return b.pt(x, b.n - row);
}

function sgfList(b, s) {
  const r = [];
  for (let k = 0; k < s.length; k += 2) r.push(sgfPt(b, s.slice(k, k + 2)));
  return r;
}

// ---------------- 神经网络引擎（KataGo 网络，在 nnworker.js 里运行） ----------------

class NNEngine {
  constructor() {
    this.worker = null; this.model = ''; this.ready = false; this.failed = ''; this.info = null;
    this.seq = 0; this.pending = new Map();
  }

  start(model) {
    if (model === this.model && (this.worker || this.failed)) return;
    this.stop();
    this.model = model;
    if (model === 'mcts') return;
    if (typeof WebAssembly === 'undefined') { this.failed = '这个浏览器不支持 WebAssembly'; return; }
    let w;
    try { w = new Worker('nnworker.js'); } catch (e) { this.failed = String(e.message || e); return; }
    this.worker = w;
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'ready') { this.ready = true; this.info = m; this.changed(); return; }
      if (m.type === 'error') { this.fail(m.msg); return; }
      if (m.err) this.fail(m.err);
      const res = this.pending.get(m.id);
      if (res) { this.pending.delete(m.id); res(m.res); }
    };
    w.onerror = e => { e.preventDefault(); this.fail(e.message || '神经网络加载失败'); };
    w.postMessage({ type: 'init', model });
  }

  stop() {
    if (this.worker) this.worker.terminate();
    this.worker = null; this.ready = false; this.failed = ''; this.info = null;
    for (const res of this.pending.values()) res(null);
    this.pending.clear();
  }

  fail(msg) {
    console.error('nn', msg);
    const model = this.model;
    this.stop();
    this.model = model;
    this.failed = msg;
    this.changed();
  }

  changed() { if (typeof render === 'function') render(); if (typeof showEngineStatus === 'function') showEngineStatus(); }

  cancel() {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel' });
    for (const res of this.pending.values()) res(null);
    this.pending.clear();
  }

  call(msg) {
    return new Promise(res => {
      msg.id = ++this.seq;
      this.pending.set(msg.id, res);
      this.worker.postMessage(msg);
    });
  }

  /** 搜索：返回候选（访问数、胜率、领先目数）、归属、网络直觉 */
  async search(board, visits, ms, komi) {
    const r = await this.call({ type: 'search', state: board.state(), visits, ms, komi });
    return r && { ...r, nn: true, toPlay: board.toPlay };
  }

  /** 单次评估：归属（黑 +1）与领先目数（黑为正） */
  evaluate(board, komi) {
    return this.call({ type: 'eval', state: board.state(), komi });
  }

  /** 网络正在加载时先等一等（最多 ms 毫秒），加载好了再分析，避免第一手用传统引擎 */
  whenReady(ms) {
    return new Promise(res => {
      const t0 = Date.now();
      const tick = () => {
        if (this.ready || this.failed || !this.worker || Date.now() - t0 > ms) res();
        else setTimeout(tick, 100);
      };
      tick();
    });
  }

  status() {
    if (this.model === 'mcts') return '现在用的是传统引擎。';
    if (this.failed) return `神经网络不可用（${this.failed}），暂时用传统引擎。`;
    if (!this.ready) return '正在加载神经网络…（第一次需要下载约 30 MB，之后离线可用）';
    const i = this.info;
    return `神经网络已就绪：${this.model === 'b10' ? '10 层 128 通道' : '6 层 96 通道'}的 KataGo 网络，单次计算约 ${i.evalMs} 毫秒${i.threads > 1 ? `，${i.threads} 线程` : ''}。`;
  }
}

const nn = new NNEngine();

// ---------------- Worker 池 ----------------

class Pool {
  constructor() {
    const hc = navigator.hardwareConcurrency || 4;
    this.size = Math.max(1, Math.min(4, hc - 1));
    const src = `${goEngine.toString()}\n${goWorker.toString()}\ngoEngine(self);goWorker(self);`;
    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.seq = 0;
    this.spawn();
  }

  spawn() {
    this.pending = new Map();
    this.workers = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(this.url);
      w.onmessage = e => {
        const res = this.pending.get(e.data.id);
        if (res) { this.pending.delete(e.data.id); res(e.data); }
      };
      w.onerror = e => {
        console.error('worker error', e.message);
        for (const res of this.pending.values()) res(null);
        this.pending.clear();
      };
      this.workers.push(w);
    }
    this.next = 0;
  }

  cancel() {
    nn.cancel();
    for (const w of this.workers) w.terminate();
    for (const res of this.pending.values()) res(null);
    this.spawn();
  }

  call(msg) {
    return new Promise(res => {
      msg.id = ++this.seq;
      msg.seed = (Math.random() * 4294967295) >>> 0;
      this.pending.set(msg.id, res);
      this.workers[this.next++ % this.size].postMessage(msg);
    });
  }

  async search(board, playouts, ms, komi) {
    const state = board.state(), k = this.size;
    const per = Math.max(50, Math.ceil(playouts / k));
    const rs = await Promise.all(Array.from({ length: k }, () =>
      this.call({ type: 'search', state, playouts: per, ms, komi })));
    if (rs.some(r => !r)) return null;
    const agg = new Map();
    let total = 0;
    for (const r of rs) {
      total += r.playouts;
      for (const [move, n, w] of r.kids) {
        const e = agg.get(move) || { move, visits: 0, wins: 0 };
        e.visits += n; e.wins += w;
        agg.set(move, e);
      }
    }
    const cands = [...agg.values()].filter(c => c.visits > 0)
      .map(c => ({ move: c.move, visits: c.visits, wr: c.wins / c.visits }))
      .sort((a, b) => b.visits - a.visits);
    return { cands, playouts: total, wr: cands.length ? cands[0].wr : 0.5 };
  }

  async ownership(board, count, komi) {
    await nn.whenReady(20000);
    if (nn.ready) {
      const r = await nn.evaluate(board, komi);
      if (r || nn.ready) return r && { own: r.own, score: r.score, nn: true };
    }
    const state = board.state(), k = this.size;
    const per = Math.max(20, Math.ceil(count / k));
    const rs = await Promise.all(Array.from({ length: k }, () =>
      this.call({ type: 'own', state, count: per, komi })));
    if (rs.some(r => !r)) return null;
    const own = new Float32Array(board.size);
    let score = 0, n = 0;
    for (const r of rs) {
      for (let i = 0; i < own.length; i++) own[i] += r.own[i];
      score += r.score; n += r.count;
    }
    for (let i = 0; i < own.length; i++) own[i] /= n;
    return { own, score: score / n };
  }

  async analyze(board, budget, komi) {
    await nn.whenReady(20000);
    if (nn.ready) {
      const r = await nn.search(board, budget.visits, budget.ms, komi);
      if (r || nn.ready) return r;
    }
    const [s, o] = await Promise.all([
      this.search(board, budget.playouts, budget.ms, komi),
      this.ownership(board, budget.own, komi),
    ]);
    if (!s || !o) return null;
    return { ...s, own: o.own, score: o.score, toPlay: board.toPlay };
  }
}

const pool = new Pool();

// ---------------- 状态 ----------------

const S = {
  mode: 'play',
  game: { size: 9, human: BLACK, handicap: 0, komi: 7.5, rule: 'normal', captureN: 1, opp: 'ai' },
  prefs: { level: 0, target: 100, engine: 'b10', coach: true, confirm: false, cands: false, own: false, helper: true, marks: true },
  summary: null,
  setup: [],
  history: [],
  result: null,
  comments: {},
  board: null,
  analyses: [],
  aprom: [],
  scoring: null,
  scoringBusy: false,
  aiThinking: false,
  hint: null,
  view: null,       // 回看：显示第 view 手之前的局面
  tries: [],        // 回看时的试下着法
  tryNote: null,
  gen: 0,
  ghost: NONE,
  pendingTap: NONE,
  done: { lessons: {}, problems: {}, yi: {} },
  sync: { server: '', on: false, last: '' },
};

// 提问
const Q = { open: false, pick: null, seq: 0, mark: null, area: null, log: [] };

// 学习（课程 + 名局）
const T = {
  gi: 0, idx: 0, gen: 0,
  cat: 'learn', last: {},   // 学习（课程）/ 棋谱（名局与我的对局）两个标签页各自记住看到哪里
  analyses: [], aprom: [], comments: {},
  guess: false, hit: 0, tried: 0, lastGuess: null,
  auto: 0, cache: null,
};

// 《弈》课程：当前练习、作答反馈、按步走的进度
const YI = { ex: 0, fb: {}, pos: 0, board: null, numbers: false, input: '' };

// 练习
const P = { i: 0, board: null, phase: 'ask', msg: '', showTip: false, anim: 0, last: NONE };

const captureRule = () => S.game.rule === 'capture';

function boardAt(k) {
  const b = new G.Board(S.game.size);
  b.setup(S.setup);
  for (let i = 0; i < k && i < S.history.length; i++) {
    if (!b.play(S.history[i])) break;
  }
  return b;
}

function rebuild() { S.board = boardAt(S.history.length); }

function save() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify({
      mode: S.mode, game: S.game, prefs: S.prefs, setup: S.setup, history: S.history,
      result: S.scoring ? null : S.result, comments: S.comments, done: S.done, sync: S.sync,
      study: { gi: T.gi, idx: T.idx, cat: T.cat, last: T.last }, practice: { i: P.i },
    }));
  } catch (e) { /* 存储不可用时忽略 */ }
}

/** 读取保存的状态；返回 true 表示这是第一次打开。 */
function load() {
  let first = true;
  try {
    const d = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (d) {
      first = false;
      Object.assign(S.game, d.game);
      Object.assign(S.prefs, d.prefs);
      S.setup = d.setup || [];
      S.history = d.history || [];
      S.result = d.result || null;
      S.comments = d.comments || {};
      S.done = Object.assign({ lessons: {}, problems: {}, yi: {} }, d.done || {});
      Object.assign(S.sync, d.sync || {});
      S.mode = ['play', 'study', 'practice'].includes(d.mode) ? d.mode : 'play';
      if (d.study) {
        T.gi = clamp(d.study.gi | 0, 0, Math.max(0, GAMES.length - 1));
        T.idx = d.study.idx | 0;
        T.cat = d.study.cat === 'games' ? 'games' : 'learn';
        T.last = d.study.last || {};
      }
      if (d.practice) P.i = clamp(d.practice.i | 0, 0, Math.max(0, PROBLEMS.length - 1));
    }
  } catch (e) { /* 数据损坏时从头开始 */ }
  rebuild();
  return first;
}

/** 停掉所有后台计算，让进行中的结果作废。 */
function cancelWork() {
  S.gen++;
  T.gen++;
  pool.cancel();
  S.aiThinking = false;
  S.scoringBusy = false;
  S.aprom = S.aprom.map((p, k) => (S.analyses[k] ? p : undefined));
  T.aprom = T.aprom.map((p, k) => (T.analyses[k] ? p : undefined));
}

function truncate(len) {
  S.analyses.length = Math.min(S.analyses.length, len + 1);
  S.aprom.length = Math.min(S.aprom.length, len + 1);
  for (const j of Object.keys(S.comments)) if (+j >= len) delete S.comments[j];
}

/** 真人对战：两个人在同一台设备上轮流下，其它功能不变。 */
const pvp = () => S.game.opp === 'human';
const isHumanTurn = () => pvp() || S.board.toPlay === S.game.human;
/** 讲解、提示、提问的视角：对 AI 时是“你”，真人对战时是轮到下棋的一方。 */
const perspective = () => (pvp() ? S.board.toPlay : S.game.human);
const sideName = c => (pvp() ? `${colorName(c)}方` : c === S.game.human ? '你' : 'AI');

function canHumanMove() {
  return S.mode === 'play' && !S.result && !S.scoring && !S.scoringBusy && S.view === null &&
    isHumanTurn() && !S.aiThinking;
}

// ---------------- 对战：分析与流程 ----------------

function getAnalysis(k) {
  if (S.analyses[k]) return Promise.resolve(S.analyses[k]);
  if (!S.aprom[k]) {
    const gen = S.gen, pos = boardAt(k);
    S.aprom[k] = pool.analyze(pos, BUDGET[S.game.size], S.game.komi).then(a => {
      if (!a || gen !== S.gen) return null;
      S.analyses[k] = a;
      onAnalysis(k);
      return a;
    });
  }
  return S.aprom[k];
}

function onAnalysis(k) {
  if (S.prefs.coach) {
    if (k >= 1) makeComment(k - 1);
    makeComment(k);
  }
  render();
}

let looping = false, again = false;
async function advance() {
  if (looping) { again = true; return; }
  looping = true;
  try {
    do { again = false; await step(); } while (again);
  } finally {
    looping = false;
  }
}

async function step() {
  const gen = S.gen;
  while (gen === S.gen && S.mode === 'play' && !S.result && !S.scoring && !S.scoringBusy) {
    const k = S.history.length;
    if (captureRule()) {
      if (isHumanTurn()) return;
      await captureTurn(gen);
      continue;
    }
    const a = await getAnalysis(k);
    if (gen !== S.gen || !a) return;
    if (S.history.length !== k) continue;
    if (isHumanTurn()) return;
    await aiTurn(gen, k);
  }
}

function settled(pos, own) {
  for (let p = 0; p < pos.size; p++) {
    if (pos.b[p] === EMPTY && Math.abs(own[p]) < 0.9) return false;
  }
  return true;
}

function pickTarget(a, target) {
  const top = a.cands[0];
  if (!top) return PASS;
  if (top.wr <= target) return top.move;
  const minV = Math.max(a.nn ? 2 : 10, top.visits * 0.03);
  let best = top, bd = Infinity;
  for (const c of a.cands) {
    if (c.visits < minV) continue;
    const d = Math.abs(c.wr - target);
    if (d < bd) { bd = d; best = c; }
  }
  return best.move;
}

/** 神经网络“第一感”：greedy 取概率最高的一手；否则按概率（温度 temp）随机挑，只在比较像样的着法里挑 */
function pickPolicy(a, lv) {
  const list = (a.policy || []).filter(p => p.prior >= 0.02 || p === a.policy[0]);
  if (!list.length) return a.cands[0] ? a.cands[0].move : PASS;
  if (lv.greedy) return list[0].move;
  const ws = list.map(p => Math.pow(p.prior, 1 / lv.temp)), sum = ws.reduce((s, w) => s + w, 0);
  let x = Math.random() * sum;
  for (let i = 0; i < list.length; i++) { x -= ws[i]; if (x <= 0) return list[i].move; }
  return list[0].move;
}

function pickRandom(r) {
  const top = r.cands[0];
  if (!top) return PASS;
  const list = r.cands.filter(c => c.visits >= top.visits * 0.05);
  const sum = list.reduce((s, c) => s + c.visits, 0);
  let x = Math.random() * sum;
  for (const c of list) { x -= c.visits; if (x <= 0) return c.move; }
  return top.move;
}

async function aiTurn(gen, k) {
  S.aiThinking = true;
  render();
  const t0 = Date.now();
  const pos = S.board.copy(), ai = pos.toPlay, n = pos.n;
  const a = await getAnalysis(k);
  if (gen !== S.gen) return;
  if (!a) { S.aiThinking = false; render(); return; }
  const late = pos.moveCount > n * n / 2;
  const target = S.prefs.target < 100 ? S.prefs.target / 100 : 0;
  let move;
  if (pos.lastMove === PASS && pos.moveCount > 0) {
    const sc = new G.Scoring(pos, G.guessDead(pos, a.own), S.game.komi);
    if (sc.winner() === ai) move = PASS;
  }
  if (move === undefined && late && a.playouts >= (a.nn ? 30 : 300) && a.wr < (target ? 0.03 : a.nn ? 0.02 : 0.06)) move = RESIGN;
  if (move === undefined && late && settled(pos, a.own)) move = PASS;
  if (move === undefined && a.nn && a.cands[0] && a.cands[0].move === PASS && pos.moveCount > n) move = PASS;
  if (move === undefined) {
    const lv = LEVELS[S.prefs.level] || LEVELS[0];
    if (target) {
      move = pickTarget(a, target);
    } else if (lv.kind !== 'mcts' && a.nn) {
      if (lv.kind === 'policy') move = pickPolicy(a, lv);
      else {
        let r = a;
        if (lv.visits > a.playouts) {
          r = await nn.search(pos, lv.visits, lv.nnMs, S.game.komi);
          if (!r || gen !== S.gen) return;
        }
        move = r.cands[0] ? r.cands[0].move : PASS;
      }
    } else {
      const r = await pool.search(pos, lv.playouts, lv.ms, S.game.komi);
      if (!r || gen !== S.gen) return;
      move = lv.random ? pickRandom(r) : (r.cands[0] ? r.cands[0].move : PASS);
    }
  }
  const wait = 350 - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  if (gen !== S.gen) return;
  S.aiThinking = false;
  if (move === RESIGN) {
    S.result = { text: 'AI 认输，你赢了！', winner: S.game.human };
    recordGame();
    save();
    finishGame('AI 认输，你赢了！');
    return;
  }
  if (move === PASS) toast('AI 停一手');
  playMove(move, true);
}

/** 吃子棋的 AI：规则很简单，不需要大量计算。 */
async function captureTurn(gen) {
  S.aiThinking = true;
  render();
  await sleep(450);
  if (gen !== S.gen) return;
  const lvl = S.prefs.level <= 0 ? 0 : S.prefs.level === 1 ? 1 : 2;
  const move = G.captureMove(S.board.copy(), G.makeRng((Math.random() * 1e9) | 0), lvl);
  S.aiThinking = false;
  playMove(move, true);
}

function checkCaptureWin() {
  const b = S.board, n = S.game.captureN;
  const w = b.capB >= n ? BLACK : b.capW >= n ? WHITE : 0;
  if (!w) return false;
  const you = pvp() || w === S.game.human;
  S.result = { text: pvp() ? `${colorName(w)}方先吃到 ${n} 个子，${colorName(w)}方赢了！` : you ? `你先吃到 ${n} 个子，你赢了！` : `AI 先吃到 ${n} 个子，AI 赢了`, winner: w };
  recordGame();
  save();
  setTimeout(() => finishGame(`${S.result.text}\n\n${pvp() ? '' : you ? '很好！试试把“先吃到几个子”调高一点。' : '点“回看”看看是哪一步被叫吃了，想一想怎么逃。'}`, '吃子棋结束'), 300);
  return true;
}

function atariGroups(b, color) {
  const seen = new Set(), out = [];
  for (let p = 0; p < b.size; p++) {
    if (b.b[p] !== color || seen.has(p)) continue;
    const g = G.groupLibs(b, p);
    g.stones.forEach(s => seen.add(s));
    if (g.libs.length === 1) out.push(g);
  }
  return out;
}

/** 新手辅助：对方刚下完，轮到的一方有棋子被叫吃时提醒。 */
function warnAtari(mover) {
  if (!S.prefs.helper || (!pvp() && mover === S.game.human)) return;
  const who = pvp() ? S.board.toPlay : S.game.human;
  const at = atariGroups(S.board, who);
  if (at.length) toast(`注意：${pvp() ? colorName(who) + '方' : '你'}的 ${at.reduce((n, g) => n + g.stones.length, 0)} 个子被叫吃了（红圈）`);
}

function playMove(m, internal) {
  const mover = S.board.toPlay;
  if (!S.board.play(m)) return false;
  S.history.push(m);
  S.hint = null;
  Q.mark = null;
  Q.area = null;
  S.pendingTap = NONE;
  save();
  if (captureRule()) {
    captureComment(S.history.length - 1);
    if (!checkCaptureWin()) warnAtari(mover);
  } else {
    if (S.board.passes >= 2) startScoring();
    else warnAtari(mover);
  }
  render();
  if (!internal) advance();
  return true;
}

async function startScoring() {
  S.scoringBusy = true;
  render();
  const gen = S.gen, pos = S.board.copy();
  const o = await pool.ownership(pos, FINAL_OWN[pos.n], S.game.komi);
  if (!o || gen !== S.gen) return;
  S.scoringBusy = false;
  S.scoring = new G.Scoring(S.board, G.guessDead(pos, o.own), S.game.komi);
  recordGame();
  render();
  const won = S.scoring.winner() === S.game.human;
  finishGame(`${scoreText()}\n\n${pvp() ? `${colorName(S.scoring.winner())}方获胜` : won ? '你赢了！' : 'AI 获胜'}\n\n如果死活判断有误，可以点棋盘上的棋子切换死活。`);
}

function scoreText() {
  const sc = S.scoring;
  const d = sc.diff();
  return `黑 ${sc.black}，白 ${sc.white}（黑贴 ${S.game.komi}）\n${d > 0 ? '黑' : '白'}胜 ${Math.abs(d)}`;
}

// ---------------- 对战：讲解 ----------------

const QUALITY = [{ cls: 'best', label: '最佳' }, { cls: 'good', label: '好棋' }, { cls: 'ok', label: '可以' }, { cls: 'slow', label: '缓手' }, { cls: 'bad', label: '恶手' }];
/** 按胜率损失评价；有神经网络的目数时，也按亏的目数评价，取较差的那个（大优或大劣时胜率几乎不变，目数更能说明问题） */
function quality(delta, isBest, pts) {
  if (isBest) return QUALITY[0];
  let q = delta < 0.03 ? 1 : delta < 0.08 ? 2 : delta < 0.15 ? 3 : 4;
  if (pts !== null && pts !== undefined) q = Math.max(q, pts < 1 ? 1 : pts < 2.5 ? 2 : pts < 5 ? 3 : 4);
  return QUALITY[q];
}
const ptsText = v => `${Math.round(Math.abs(v) * 2) / 2} 目`;

async function makeComment(j) {
  const A = S.analyses[j], B = S.analyses[j + 1];
  if (!A || !B || S.comments[j] || j >= S.history.length) return;
  const pre = boardAt(j), m = S.history[j], c = pre.toPlay;
  const you = pvp() || c === S.game.human, me = sideName(c), op = sideName(3 - c);
  const top = A.cands[0];
  let wrMove = 1 - B.wr;
  const cand = A.cands.find(x => x.move === m);
  if (cand && top && cand.visits >= 0.15 * top.visits) wrMove = cand.wr;
  const isBest = !!top && top.move === m;
  const wrBest = top ? Math.max(top.wr, wrMove) : wrMove;
  const delta = isBest ? 0 : Math.max(0, wrBest - wrMove);
  // 神经网络的领先目数：这手棋比最佳下法亏了几目
  let pts = null, leadAfter = null;
  if (A.nn && B.nn && top) {
    leadAfter = cand && top && cand.visits >= 0.15 * top.visits ? cand.lead : -B.lead;
    pts = isBest ? 0 : Math.max(0, Math.max(top.lead, leadAfter) - leadAfter);
  }
  const cm = {
    j, color: c, you, who: me, move: m, name: pre.name(m), q: quality(delta, isBest, pts), pts, leadAfter,
    wrBefore: wrBest, wrAfter: wrMove,
    reasons: G.explain(pre, m, c, A.own, B.own, me, op),
    best: null, isBest,
    eased: !you && S.prefs.target < 100 && !isBest && delta >= 0.05,
    wrNext: B.wr,
  };
  if (you && top && !isBest && (delta >= 0.03 || (pts !== null && pts >= 1.5))) {
    cm.best = { move: top.move, name: pre.name(top.move), wr: top.wr, pts, reasons: null };
  }
  cm.gain = gainPoints(pre, c, A.own, B.own);
  if (cm.gain.length) cm.reasons.push(`这手之后更可能变成${me}地盘的点：${cm.gain.slice(0, 12).join('、')}${cm.gain.length > 12 ? ' 等' : ''}（共 ${cm.gain.length} 个，点“在棋盘上看”）。`);
  S.comments[j] = cm;
  save();
  render();
  if (cm.best) {
    const gen = S.gen, after = pre.copy();
    after.play(top.move);
    const o = await pool.ownership(after, BUDGET[S.game.size].own, S.game.komi);
    if (!o || gen !== S.gen || S.comments[j] !== cm) return;
    cm.best.reasons = G.explain(pre, top.move, c, A.own, o.own, me, op);
    save();
    render();
  }
}

/** 这手棋让哪些点明显更偏向下棋的一方（“得到的目”在哪里）。返回坐标名。 */
function gainPoints(pre, c, ownB, ownA) {
  const sgn = c === BLACK ? 1 : -1, out = [];
  for (let p = 0; p < pre.size; p++) {
    if (pre.b[p] === G.BORDER || pre.b[p] === c) continue;
    const b0 = ownB[p] * sgn, a0 = ownA[p] * sgn;
    if (a0 - b0 > 0.35 && a0 > 0.3) out.push(p);
  }
  return out.map(p => pre.name(p));
}

/** 吃子棋的讲解：只讲吃子、叫吃、逃子这些手段。 */
function captureComment(j) {
  const pre = boardAt(j), m = S.history[j], c = pre.toPlay;
  const you = pvp() || c === S.game.human, me = sideName(c), op = sideName(3 - c);
  const reasons = G.explain(pre, m, c, null, null, me, op);
  const after = boardAt(j + 1);
  const threat = atariGroups(after, 3 - c);
  if (threat.length && (!you || pvp())) reasons.push(`${me}在叫吃${op}的棋！${op}想一想：往外长能不能长出 3 口气？能不能反过来提掉叫吃的子？`);
  if (atariGroups(after, c).length) reasons.push(`小心：${me}自己还有棋子只剩一口气（红圈）。`);
  S.comments[j] = { j, you, who: me, move: m, name: pre.name(m), reasons, simple: true };
}

async function showHint() {
  if (!canHumanMove()) return;
  if (captureRule()) {
    const b = S.board.copy();
    const m = G.captureMove(b.copy(), G.makeRng(7), 2);
    if (m === PASS) { toast('没有好的着法了'); return; }
    S.hint = { move: m, name: b.name(m), wr: null, reasons: G.explain(b, m, b.toPlay, null, null, sideName(b.toPlay), sideName(3 - b.toPlay)), others: [] };
    Q.mark = [m];
    render();
    return;
  }
  const gen = S.gen, k = S.history.length;
  S.hint = { loading: true };
  render();
  const a = await getAnalysis(k);
  if (!a || gen !== S.gen || S.history.length !== k) return;
  const top = a.cands[0];
  if (!top) { S.hint = null; render(); return; }
  const pre = S.board.copy(), after = pre.copy();
  after.play(top.move);
  const o = await pool.ownership(after, BUDGET[S.game.size].own, S.game.komi);
  if (!o || gen !== S.gen || S.history.length !== k) return;
  S.hint = {
    move: top.move, name: pre.name(top.move), wr: top.wr,
    reasons: G.explain(pre, top.move, pre.toPlay, a.own, o.own, sideName(pre.toPlay), sideName(3 - pre.toPlay)),
    others: a.cands.slice(1, 3).map(c => ({ name: pre.name(c.move), wr: c.wr })),
  };
  render();
}

// ---------------- 本局总结：为什么赢、为什么输 ----------------

const REGION_NAMES = [['左上角', '上边', '右上角'], ['左边', '中央', '右边'], ['左下角', '下边', '右下角']];
function regionOf(b, p) {
  const t = b.n / 3;
  return REGION_NAMES[Math.min(2, Math.floor(b.y(p) / t))][Math.min(2, Math.floor(b.x(p) / t))];
}

/** 终局时每个点归谁：数子时用确认的结果，认输时用引擎的估计。 */
function finalOwner(b) {
  const own = new Int8Array(b.size);
  if (S.scoring) {
    for (let p = 0; p < b.size; p++) {
      const v = b.b[p];
      if (S.scoring.terr[p]) own[p] = S.scoring.terr[p];
      else if ((v === BLACK || v === WHITE) && !S.scoring.dead[p]) own[p] = v;
    }
    return own;
  }
  const la = latestAnalysis(S.analyses, S.history.length);
  if (!la) return null;
  for (let p = 0; p < b.size; p++) {
    if (b.b[p] === G.BORDER) continue;
    const v = la.a.own[p];
    own[p] = v > 0.3 ? BLACK : v < -0.3 ? WHITE : 0;
  }
  return own;
}

function deadChains(b) {
  let dead = null;
  if (S.scoring) dead = S.scoring.dead;
  else {
    const la = latestAnalysis(S.analyses, S.history.length);
    if (la) dead = G.guessDead(b, la.a.own);
  }
  if (!dead) return [];
  const seen = new Set(), out = [];
  for (let p = 0; p < b.size; p++) {
    if (!dead[p] || seen.has(p)) continue;
    const g = G.groupLibs(b, p);
    g.stones.forEach(q => seen.add(q));
    out.push({ color: b.b[p], stones: g.stones, where: regionOf(b, p) });
  }
  return out.sort((x, y) => y.stones.length - x.stones.length);
}

/** 吃子棋：每一次提子是哪一手、之前是从哪一手开始被叫吃、当时该怎么救。 */
function captureEvents() {
  const out = [];
  for (let j = 0; j < S.history.length; j++) {
    const before = boardAt(j), after = boardAt(j + 1);
    const n = after.capB + after.capW - before.capB - before.capW;
    if (!n) continue;
    const mover = before.toPlay, victim = 3 - mover;
    const gone = [];
    for (let p = 0; p < before.size; p++) if (before.b[p] === victim && after.b[p] === EMPTY) gone.push(p);
    // 往前找：这块棋从哪一手开始只剩一口气
    let atariAt = j - 1, save = null;
    for (let k = j - 1; k >= 0; k--) {
      const bk = boardAt(k + 1);
      if (!gone.every(p => bk.b[p] === victim)) break;
      if (G.groupLibs(bk, gone[0]).libs.length !== 1) break;
      atariAt = k;
    }
    if (atariAt >= 0) {
      const bk = boardAt(atariAt + 1);
      if (bk.toPlay === victim && bk.b[gone[0]] === victim) {
        const d = G.findDefense(bk, gone[0], 10, false);
        save = d !== null && d !== undefined && d >= 0 ? bk.name(d) : null;
      }
    }
    out.push({ j, mover, victim, n, at: after.name(S.history[j]), atariAt, atariMove: atariAt >= 0 ? boardAt(atariAt).name(S.history[atariAt]) : '', save, where: regionOf(before, gone[0]) });
  }
  return out;
}

function buildSummary() {
  const b = S.board, g = S.game, pv = pvp();
  const winner = S.result ? S.result.winner : S.scoring ? S.scoring.winner() : 0;
  if (!winner) return null;
  const loser = 3 - winner, me = g.human;
  const won = !pv && winner === me;
  const head = pv ? `${colorName(winner)}方获胜` : won ? '你赢了！' : '这盘你输了';
  const items = [], tips = [], facts = [`结果：${head}。`];
  if (captureRule()) {
    for (const e of captureEvents()) {
      const t = `第 ${e.j + 1} 手，${sideName(e.mover)}在 ${e.at} 提掉了${sideName(e.victim)}在${e.where}的 ${e.n} 个子。`
        + (e.atariAt >= 0 && e.atariAt < e.j ? `这块棋从第 ${e.atariAt + 1} 手（${sideName(3 - e.victim)}下 ${e.atariMove}）起就只剩一口气了，${e.save ? `当时${sideName(e.victim)}下 <b>${e.save}</b> 就能救出来。` : '当时已经很难救了。'}` : '');
      items.push({ html: t, j: e.atariAt >= 0 ? e.atariAt + 1 : e.j });
      facts.push(t.replace(/<[^>]+>/g, ''));
    }
    if (!won && !pv) tips.push('每下一手之前，先看看自己有没有只剩一口气（红圈）的棋子；被叫吃了就往外长，长出 3 口气才安全。');
    if (won && !pv) tips.push('你已经会吃子了！试试把“先吃到几个子”调高，或者去下 9 路的正式对局。');
  } else {
    if (S.scoring) {
      const sc = S.scoring;
      items.push({ html: `数子：黑 ${sc.black}，白 ${sc.white}（黑贴 ${g.komi}）→ ${sc.diff() > 0 ? '黑' : '白'}胜 ${Math.abs(sc.diff())}。` });
    } else if (S.result) {
      items.push({ html: `${esc(S.result.text)}。` });
    }
    const own = finalOwner(b);
    if (own) {
      const reg = {};
      for (let p = 0; p < b.size; p++) {
        if (!own[p]) continue;
        const r = regionOf(b, p);
        reg[r] = reg[r] || { [BLACK]: 0, [WHITE]: 0 };
        reg[r][own[p]]++;
      }
      const diffs = Object.entries(reg).map(([r, c]) => ({ r, b: c[BLACK], w: c[WHITE], d: c[BLACK] - c[WHITE] }))
        .filter(x => Math.abs(x.d) >= 3).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 4);
      if (diffs.length) {
        const t = '各区域的地盘（棋子 + 围住的空点）：' + diffs.map(x => `${x.r} 黑 ${x.b}、白 ${x.w}（${x.d > 0 ? '黑' : '白'}多 ${Math.abs(x.d)}）`).join('；') + '。';
        items.push({ html: t });
        facts.push(t);
        const bestForWinner = diffs.filter(x => (x.d > 0) === (winner === BLACK));
        if (bestForWinner.length) facts.push(`${sideName(winner)}主要赢在：${bestForWinner.slice(0, 2).map(x => x.r).join('、')}。`);
      }
    }
    for (const dg of deadChains(b).slice(0, 3)) {
      const t = `${sideName(dg.color)}在${dg.where}的 ${dg.stones.length} 个子最后成了死棋（对方因此多得约 ${dg.stones.length * 2}）。`;
      items.push({ html: t });
      facts.push(t);
    }
    const drops = Object.values(S.comments)
      .filter(c => !c.simple && c.q && (pv || c.color === me) && (c.wrBefore - c.wrAfter > 0.06 || c.pts >= 4))
      .sort((x, y) => (y.wrBefore - y.wrAfter + (y.pts || 0) / 40) - (x.wrBefore - x.wrAfter + (x.pts || 0) / 40)).slice(0, 3);
    for (const c of drops) {
      const t = `第 ${c.j + 1} 手 ${esc(c.who || '你')}下 ${esc(c.name)}（${c.q.label}）：胜率从 ${pct(c.wrBefore)} 降到 ${pct(c.wrAfter)}${c.pts >= 0.5 ? `，亏了约 ${ptsText(c.pts)}` : ''}${c.best ? `，更好的是 <b>${esc(c.best.name)}</b>` : ''}。`;
      items.push({ html: t, j: c.j });
      facts.push(t.replace(/<[^>]+>/g, ''));
    }
    if (!pv) {
      const myDead = deadChains(b).filter(d => d.color === me).reduce((n, d) => n + d.stones.length, 0);
      if (drops.some(c => (c.reasons || []).some(r => r.includes('一路')))) tips.push('开局和中盘少下一路（最边上的线），先占角、再拆边，价值大得多。');
      if (myDead >= 3) tips.push('被包围的棋要早点“出头”（往中央跑）或者做出两个眼；气只剩 2 口时就要小心。');
      if (drops.length) tips.push('点上面带编号的那几手，可以回看当时的局面，试下 AI 推荐的点，比较一下差别。');
      if (won) tips.push('赢了就把难度调高一级，或者把“AI 胜率控制”往上调。');
      if (!tips.length) tips.push('下完多回看几遍，重点看胜率掉得最多的那一手。');
    }
  }
  const html = `<div class="cm summary best"><div class="h"><b>本局总结：${esc(head)}</b></div>
    <h4>${pv ? '胜负原因' : won ? '你为什么赢' : '你为什么输'}</h4>
    <ul>${items.map(it => `<li>${it.html}${it.j !== undefined ? ` <button class="small" data-j="${it.j}">回看这一手</button>` : ''}</li>`).join('')}</ul>
    ${tips.length ? `<h4>下次注意</h4><ul>${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <p><button class="small primary" data-sumai="1">让 AI 老师讲讲这盘棋</button></p></div>`;
  return { html, facts: facts.join('\n') };
}

/** 对局结束：生成总结，弹出结果。 */
function finishGame(text, title) {
  S.summary = buildSummary();
  render();
  showMessage(title || '对局结束', `${text}\n\n下方的“本局总结”里有详细的${pvp() ? '胜负' : '输赢'}原因。`, true);
}

// ---------------- 对战：操作 ----------------

function newGame(opts) {
  S.summary = null;
  cancelWork();
  Object.assign(S.game, opts);
  S.setup = G.handicapPoints(S.game.size, S.game.handicap);
  S.game.recId = null;
  S.history = [];
  S.result = null;
  S.comments = {};
  S.analyses = [];
  S.aprom = [];
  S.scoring = null;
  S.hint = null;
  exitReview();
  rebuild();
  save();
  layout();
  render();
  advance();
}

function undo() {
  if (!S.history.length) return;
  S.summary = null;
  cancelWork();
  S.result = null;
  S.scoring = null;
  S.hint = null;
  exitReview();
  do {
    S.history.pop();
    rebuild();
  } while (S.history.length && !pvp() && S.board.toPlay !== S.game.human);
  truncate(S.history.length);
  save();
  render();
  advance();
}

function humanPass() {
  if (!canHumanMove()) return;
  toast(pvp() ? `${colorName(S.board.toPlay)}方停了一手` : '你停了一手');
  playMove(PASS);
}

function resign() {
  if (S.result || S.scoring) return;
  const loser = pvp() ? S.board.toPlay : S.game.human;
  showMessage('认输', pvp() ? `确定${colorName(loser)}方认输吗？` : '确定要认输吗？', false, [
    { label: '取消' },
    {
      label: '认输', primary: true, fn: () => {
        cancelWork();
        S.result = { text: pvp() ? `${colorName(loser)}方认输，${colorName(3 - loser)}方获胜` : '你认输了，AI 获胜', winner: 3 - loser };
        recordGame();
        save();
        finishGame(S.result.text);
      },
    },
  ]);
}

// ---------------- 对局记录（每一盘都保存在本机） ----------------

let RECORDS = [];
function loadRecords() {
  try { RECORDS = JSON.parse(localStorage.getItem(recordsKey()) || '[]'); } catch (e) { RECORDS = []; }
  // 只保留下完的对局
  RECORDS = RECORDS.filter(r => r && r.result && r.result !== '未下完');
}
function saveRecords() {
  try { localStorage.setItem(recordsKey(), JSON.stringify(RECORDS)); } catch (e) { toast('本机存储空间不足，对局记录没有保存成功'); }
}

/** 把当前这盘棋存成一条记录（同一盘棋反复调用只会更新同一条）。 */
function recordGame() {
  if (!S.history.length || (!S.result && !S.scoring)) return;
  const b0 = new G.Board(S.game.size), sg2 = p => (p === PASS ? 'tt' : String.fromCharCode(97 + b0.x(p)) + String.fromCharCode(97 + b0.y(p)));
  if (!S.game.recId) S.game.recId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const g = S.game, b = S.board;
  const pvp = g.opp === 'human';
  let result = '';
  if (S.result) result = S.result.text;
  else if (S.scoring) result = `${S.scoring.winner() === BLACK ? '黑' : '白'}胜 ${Math.abs(S.scoring.diff())}${pvp ? '' : `（${S.scoring.winner() === g.human ? '你赢了' : 'AI 赢了'}）`}`;
  const rec = {
    id: g.recId, date: new Date().toISOString(), size: g.size, human: g.human, rule: g.rule, captureN: g.captureN,
    handicap: g.handicap, komi: g.komi, level: pvp ? '真人' : LEVELS[S.prefs.level].name, target: S.prefs.target, opp: pvp ? 'human' : 'ai',
    ab: S.setup.map(sg2).join(''), moves: S.history.map(sg2).join(''), moveCount: S.history.length,
    result, won: pvp ? null : S.result ? S.result.winner === g.human : S.scoring ? S.scoring.winner() === g.human : null,
    winner: S.result ? S.result.winner : S.scoring ? S.scoring.winner() : 0,
    caps: [b.capB, b.capW],
  };
  const i = RECORDS.findIndex(r => r.id === rec.id);
  if (i >= 0) RECORDS[i] = Object.assign(RECORDS[i], rec); else RECORDS.unshift(rec);
  saveRecords();
  fillGameSelect();
  if (S.sync.on) syncNow(true);
}

function recordToGame(r) {
  const d = new Date(r.date);
  const when = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const you = r.human === BLACK ? '黑' : '白';
  return {
    kind: 'mine', id: r.id, group: '我的对局（保存在本机）',
    title: r.opp === 'human'
      ? `${when} · ${r.size}路${r.rule === 'capture' ? ` 吃子棋（${r.captureN} 子）` : ''} · 真人对战 · ${r.winner === BLACK ? '黑胜' : r.winner === WHITE ? '白胜' : ''}`
      : `${when} · ${r.size}路${r.rule === 'capture' ? ` 吃子棋（${r.captureN} 子）` : ''} · 你执${you} · ${r.won === true ? '赢' : '输'}`,
    size: r.size, komi: r.komi,
    black: r.opp === 'human' ? '黑方' : r.human === BLACK ? '你' : `AI（${r.level}）`, white: r.opp === 'human' ? '白方' : r.human === WHITE ? '你' : `AI（${r.level}）`,
    year: d.getFullYear(), result: r.result || '未下完', notes: {},
    intro: `你在 ${d.toLocaleString('zh-CN')} 下的一盘棋，共 ${r.moveCount} 手，结果：${r.result || '未下完'}。一步步回看，留意胜率大幅下降的地方；打开“猜棋”，看看自己能不能找到 AI 推荐的下法。`,
    ab: r.ab, aw: '', first: r.ab ? 'W' : 'B', moves: r.moves,
  };
}

function exportRecords() {
  const data = JSON.stringify({ app: 'weiqi-coach', version: 1, exported: new Date().toISOString(), records: RECORDS, done: S.done }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `围棋对局记录-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** 导入：按记录 ID 合并，不会删除本机已有的记录。 */
function importRecords(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (d.app !== 'weiqi-coach' || !Array.isArray(d.records)) throw new Error('bad');
      let added = 0;
      for (const r of d.records) {
        if (!r || !r.id || typeof r.moves !== 'string') continue;
        const i = RECORDS.findIndex(x => x.id === r.id);
        if (i < 0) { RECORDS.push(r); added++; } else if ((r.moveCount || 0) > (RECORDS[i].moveCount || 0)) RECORDS[i] = r;
      }
      RECORDS.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (d.done) for (const k of ['lessons', 'problems', 'yi']) Object.assign(S.done[k], d.done[k] || {});
      saveRecords();
      save();
      fillGameSelect();
      fillProblemSelect();
      toast(`导入完成：新增 ${added} 盘对局，学习进度已合并`);
    } catch (e) {
      toast('这个文件不是本程序导出的对局记录');
    }
  };
  fr.readAsText(file);
}

// ---------------- 同步（家里 Mac 上的“弈 · 学习中心”） ----------------

const DEFAULT_SYNC_SERVER = 'https://VincentdeMac-mini.local:8767';

function syncServer() {
  if (S.sync.server) return S.sync.server.replace(/\/+$/, '');
  // 从学习中心本身打开时，直接用当前地址
  if (location.protocol === 'https:' && location.pathname.startsWith('/coach/')) return location.origin;
  return DEFAULT_SYNC_SERVER;
}

async function syncPost(server, payload, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 6000);
  try {
    const res = await fetch(`${server}/api/v2/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctl.signal, cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok || data.service !== 'go-learning-lan') throw new Error(data.error || `学习中心返回 ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 本机的《弈》进度，转成学习中心的格式。时间戳故意设得很早：只补充已完成的内容，不改动当前学到第几课。 */
function yiProgressPayload() {
  const now = new Date().toISOString(), ex = {};
  for (const id of Object.keys(S.done.yi)) ex[id] = { mastered: true, attempts: 1, mistakes: 0, answer: '', updatedAt: now };
  const completed = Object.keys(S.done.lessons).filter(k => /^yi\d+$/.test(k)).map(k => +k.slice(2));
  return { completedLessons: completed, exerciseProgress: ex, updatedAt: '1970-01-01T00:00:00.000Z' };
}

function applySyncResult(data) {
  const uid = curUser().id;
  const prog = data.progress && data.progress[uid];
  if (prog) {
    for (const [id, r] of Object.entries(prog.exerciseProgress || {})) if (r && r.mastered) S.done.yi[id] = true;
    for (const n of prog.completedLessons || []) S.done.lessons[`yi${n}`] = true;
  }
  let added = 0;
  if (data.coach && data.coach.userId === uid) {
    for (const r of data.coach.records || []) {
      const i = RECORDS.findIndex(x => x.id === r.id);
      if (i < 0) { RECORDS.push(r); added++; } else if ((r.moveCount || 0) > (RECORDS[i].moveCount || 0)) RECORDS[i] = r;
    }
    RECORDS.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const done = data.coach.done || {};
    for (const k of ['lessons', 'problems', 'yi']) Object.assign(S.done[k], done[k] || {});
  }
  S.sync.last = new Date().toISOString();
  saveRecords();
  save();
  fillGameSelect();
  fillProblemSelect();
  return added;
}

let syncing = false;
async function syncNow(quiet) {
  if (syncing) return false;
  syncing = true;
  const u = curUser();
  try {
    const coachDone = { lessons: {}, problems: S.done.problems, yi: S.done.yi };
    for (const [k, v] of Object.entries(S.done.lessons)) if (!/^yi\d+$/.test(k)) coachDone.lessons[k] = v;
    const data = await syncPost(syncServer(), {
      schema: 2, client: 'weiqi-coach',
      profiles: [{ id: u.id, name: u.name, createdAt: u.createdAt || new Date().toISOString(), updatedAt: u.updatedAt || new Date().toISOString() }],
      progress: { [u.id]: yiProgressPayload() },
      coach: { userId: u.id, records: RECORDS, done: coachDone },
    }, quiet ? 4000 : 8000);
    const prof = (data.profiles || []).find(p => p.id === u.id);
    if (prof && prof.name !== u.name && (prof.updatedAt || '') > (u.updatedAt || '')) { u.name = prof.name; u.updatedAt = prof.updatedAt; saveUsers(); }
    const added = applySyncResult(data);
    S.sync.on = true;
    save();
    if (!quiet) toast(`同步完成：${u.name}，共 ${RECORDS.length} 盘对局${added ? `（新增 ${added} 盘）` : ''}`);
    else if (added) toast(`已从家里同步 ${added} 盘对局`);
    render();
    return true;
  } catch (e) {
    if (!quiet) toast(`同步失败：${syncErrorText(e)}`);
    return false;
  } finally {
    syncing = false;
  }
}

function syncErrorText(e) {
  if (e && e.name === 'AbortError') return '连不上学习中心（是否在家里的 Wi-Fi？Mac 上的学习中心是否已启动？）';
  if (e instanceof TypeError) return '连不上学习中心：请确认在家里的 Wi-Fi、Mac 上的学习中心已启动，并且这台设备已安装信任家里的证书';
  return e.message || String(e);
}

function openSync() {
  $('syncServer').value = syncServer();
  $('syncStatus').textContent = `当前用户：${curUser().name}${S.sync.last ? `，上次同步：${new Date(S.sync.last).toLocaleString('zh-CN')}` : '，还没有同步过'}。要换用户，点右上角的用户名。`;
  $('dlgSync').showModal();
}

async function syncFromDialog() {
  const server = $('syncServer').value.trim().replace(/\/+$/, '');
  S.sync.server = server === DEFAULT_SYNC_SERVER ? '' : server;
  save();
  $('syncStatus').textContent = '正在同步…';
  const ok = await syncNow(false);
  $('syncStatus').textContent = ok ? `同步完成：${curUser().name}，共 ${RECORDS.length} 盘对局。以后在家里打开本应用会自动同步。` : '同步没有成功，看上面的提示。';
}

// ---------------- 用户 ----------------

function openUsers() {
  const box = $('userList');
  box.innerHTML = USERS.list.map(u => `<button type="button" data-uid="${esc(u.id)}"${u.id === USERS.current ? ' class="on"' : ''}>${esc(u.name)}${u.id === USERS.current ? '（当前）' : ''}</button>`).join('');
  $('userRename').value = curUser().name;
  $('userStatus').textContent = '';
  $('dlgUser').showModal();
}

function switchUser(id) {
  if (id === USERS.current) return;
  save();
  USERS.current = id;
  saveUsers();
  location.reload();
}

$('userList').addEventListener('click', e => {
  const r = e.target.closest('[data-remote]');
  if (r) {
    const now = new Date().toISOString();
    USERS.list.push({ id: r.dataset.remote, name: r.dataset.name, createdAt: now, updatedAt: '1970-01-01T00:00:00.000Z' });
    // 切换过去以后自动同步一次，拿回这个用户在学习中心的记录和进度
    try { localStorage.setItem(`${STORE_KEY_BASE}:${r.dataset.remote}`, JSON.stringify({ sync: { on: true, server: S.sync.server } })); } catch (err) { /* 忽略 */ }
    switchUser(r.dataset.remote);
    return;
  }
  const b = e.target.closest('[data-uid]');
  if (b) switchUser(b.dataset.uid);
});
$('btnUserAdd').addEventListener('click', () => {
  const name = $('userNewName').value.trim();
  if (!name) { $('userStatus').textContent = '请先填写名字。'; return; }
  const now = new Date().toISOString(), id = newUserId();
  USERS.list.push({ id, name, createdAt: now, updatedAt: now });
  switchUser(id);
});
$('btnUserRename').addEventListener('click', () => {
  const name = $('userRename').value.trim();
  if (!name) return;
  const u = curUser();
  u.name = name;
  u.updatedAt = new Date().toISOString();
  saveUsers();
  render();
  openUsers();
});
$('btnUserFetch').addEventListener('click', async () => {
  $('userStatus').textContent = '正在连接家里的学习中心…';
  try {
    const data = await syncPost(syncServer(), { schema: 2, profiles: [], progress: {} });
    const extra = data.profiles.filter(p => !USERS.list.some(u => u.id === p.id));
    if (!extra.length) { $('userStatus').textContent = `学习中心的 ${data.profiles.length} 个用户都已经在这台设备上了。`; return; }
    $('userList').insertAdjacentHTML('beforeend', extra.map(p => `<button type="button" data-remote="${esc(p.id)}" data-name="${esc(p.name)}">添加并切换到：${esc(p.name)}（学习中心）</button>`).join(''));
    $('userStatus').textContent = '点上面带“学习中心”的用户，就会把它加到这台设备并切换过去，然后自动同步它的记录和进度。';
  } catch (e) {
    $('userStatus').textContent = `连接失败：${syncErrorText(e)}`;
  }
});

// ---------------- 回看（不改变对局） ----------------

function enterReview(j) {
  if (!S.history.length) { toast('还没有下棋，没有可以回看的'); return; }
  if (j === undefined) {
    // 默认回到你最近一手之前：看看当时该怎么下
    j = S.history.length - 1;
    for (let k = S.history.length - 1; k >= 0 && !pvp(); k--) {
      if (boardAt(k).toPlay === S.game.human) { j = k; break; }
    }
  }
  S.view = clamp(j, 0, S.history.length - 1);
  S.tries = [];
  S.tryNote = null;
  if (!captureRule() && !S.analyses[S.view]) getAnalysis(S.view);
  render();
}

function exitReview() {
  S.view = null;
  S.tries = [];
  S.tryNote = null;
}

function reviewStep(d) {
  if (S.view === null) return;
  const j = clamp(S.view + d, 0, S.history.length - 1);
  if (j === S.view) return;
  S.view = j;
  S.tries = [];
  S.tryNote = null;
  if (!captureRule() && !S.analyses[j]) getAnalysis(j);
  render();
}

function reviewBoard() {
  const b = boardAt(S.view);
  for (const m of S.tries) b.play(m);
  return b;
}

async function reviewTry(p) {
  const b = reviewBoard();
  if (b.b[p] !== EMPTY) return;
  if (!b.isLegal(p, b.toPlay)) { toast('这里不能下'); return; }
  const first = S.tries.length === 0, c = b.toPlay;
  S.tries.push(p);
  render();
  if (!first || captureRule()) return;
  // 试下的第一手：评价一下它和实战、和 AI 推荐的差别
  const j = S.view, gen = S.gen;
  S.tryNote = { name: b.name(p), text: '正在分析这手试下…' };
  render();
  const A = await getAnalysis(j);
  const after = b.copy();
  after.play(p);
  const B = await pool.analyze(after, BUDGET[S.game.size], S.game.komi);
  if (!A || !B || gen !== S.gen || S.view !== j || S.tries[0] !== p) return;
  const top = A.cands[0];
  const wrMove = 1 - B.wr, isBest = top && top.move === p;
  const q = quality(isBest ? 0 : Math.max(0, (top ? top.wr : wrMove) - wrMove), isBest);
  const who = c === S.game.human ? '你' : 'AI';
  S.tryNote = {
    name: b.name(p), q, wr: wrMove, best: top && !isBest ? { name: b.name(top.move), wr: top.wr } : null,
    reasons: G.explain(b, p, c, A.own, B.own, who, who === '你' ? 'AI' : '你'), who,
  };
  render();
}

// ---------------- 学习：课程与名局 ----------------

function sg() { return GAMES[T.gi]; }

function gameMoves(g) {
  if (g.kind === 'yi') return [];
  if (!g._moves) g._moves = sgfList(new G.Board(g.size), g.moves);
  return g._moves;
}

function studyBoardAt(i) {
  const g = sg();
  if (T.cache && T.cache.gi === T.gi && T.cache.i === i) return T.cache.b.copy();
  const b = new G.Board(g.size);
  b.setupStones(sgfList(b, g.ab), sgfList(b, g.aw), g.first === 'W' ? WHITE : BLACK);
  const mv = gameMoves(g);
  for (let k = 0; k < i && k < mv.length; k++) {
    // 课程里有“停一手”，棋谱里颜色可能不严格交替：按记录的颜色走
    b.play(mv[k]);
  }
  T.cache = { gi: T.gi, i, b: b.copy() };
  return b;
}

function getStudyAnalysis(i) {
  if (T.analyses[i]) return Promise.resolve(T.analyses[i]);
  if (!T.aprom[i]) {
    const gen = T.gen, gi = T.gi;
    T.aprom[i] = pool.analyze(studyBoardAt(i), STUDY_BUDGET, sg().komi || 0).then(a => {
      if (!a || gen !== T.gen || gi !== T.gi) return null;
      T.analyses[i] = a;
      studyComment(i - 1);
      studyComment(i);
      if (S.mode === 'study') render();
      return a;
    });
  }
  return T.aprom[i];
}

function studyComment(i) {
  if (i < 0 || T.comments[i]) return;
  const A = T.analyses[i], B = T.analyses[i + 1];
  if (!A || !B) return;
  const pre = studyBoardAt(i), m = gameMoves(sg())[i], c = pre.toPlay;
  if (m === PASS) { T.comments[i] = { reasons: ['停一手。'], top: null, blackWr: B.toPlay === BLACK ? B.wr : 1 - B.wr }; return; }
  const top = A.cands[0];
  let reasons = G.explain(pre, m, c, A.own, B.own, colorName(c), colorName(3 - c));
  if (sg().kind === 'game') {
    // 本机引擎远弱于名局里的高手：不让它给高手的棋下“亏了”的结论
    const n0 = reasons.length;
    reasons = reasons.filter(r => !r.startsWith('这手棋让形势亏了') && !r.startsWith('一路的棋通常价值很小'));
    if (reasons.length < n0 || !reasons.length) {
      reasons.push('这手棋的深意超出了本机引擎的计算能力。高手的着法往往着眼于几十手之后，值得反复琢磨。');
    }
  }
  T.comments[i] = {
    reasons,
    top: top ? { name: pre.name(top.move), same: top.move === m } : null,
    blackWr: B.toPlay === BLACK ? B.wr : 1 - B.wr,
  };
}

function studyGo(idx) {
  const g = sg();
  if (g.kind === 'yi') { save(); render(); return; }
  const n = gameMoves(g).length;
  T.idx = clamp(idx, 0, n);
  Q.mark = null;
  Q.area = null;
  if (g.kind === 'lesson' && T.idx === n && !S.done.lessons[g.id]) {
    S.done.lessons[g.id] = true;
    fillGameSelect();
    toast('这一课学完了！');
  }
  const want = new Set([T.idx - 1, T.idx, T.idx + 1].filter(i => i >= 0 && i <= n));
  const stale = T.aprom.some((p, i) => p && !T.analyses[i] && !want.has(i));
  if (stale) {
    T.gen++;
    pool.cancel();
    T.aprom = T.aprom.map((p, i) => (T.analyses[i] ? p : undefined));
  }
  for (const i of [T.idx, T.idx - 1, T.idx + 1]) if (want.has(i)) getStudyAnalysis(i);
  save();
  render();
}

function selectGame(gi) {
  if (!GAMES[gi]) return;
  stopAuto();
  T.gen++;
  pool.cancel();
  T.gi = gi;
  T.analyses = [];
  T.aprom = [];
  T.comments = {};
  T.cache = null;
  T.hit = T.tried = 0;
  T.lastGuess = null;
  if (sg().kind === 'yi') yiSelect(0);
  layout();
  studyGo(0);
}

// ---------------- 《弈》课程 ----------------

function yiEx() { return sg().exercises[YI.ex]; }

/** 根据当前练习（以及按步走的进度）摆出棋盘。 */
function yiSetBoard() {
  const e = yiEx();
  if (!e || !e.board) { YI.board = null; return; }
  const n = e.board.size, b = new G.Board(n);
  const P0 = i => b.pt(i % n, Math.floor(i / n));
  b.setupStones(e.board.black.map(P0), e.board.white.map(P0), e.toPlay || BLACK);
  if (e.type === 'play') {
    for (let k = 0; k < YI.pos; k++) { b.toPlay = e.line[k].color; b.play(P0(e.line[k].index)); }
    if (YI.pos < e.line.length) b.toPlay = e.line[YI.pos].color;
  }
  YI.board = b;
}

function yiSelect(k) {
  const g = sg();
  YI.ex = clamp(k, 0, Math.max(0, g.exercises.length - 1));
  YI.pos = 0;
  YI.input = '';
  yiSetBoard();
  layout();
}

function yiIndex(p) {
  const e = yiEx(), n = e.board.size;
  return YI.board.y(p) * n + YI.board.x(p);
}

function yiAnswer(correct, detail) {
  const e = yiEx(), g = sg();
  YI.fb[e.id] = { correct, text: correct ? e.explanation : `还没答对。${e.hint || ''}${detail ? ' ' + detail : ''}` };
  if (correct) {
    S.done.yi[e.id] = true;
    if (g.exercises.every(x => S.done.yi[x.id]) && !S.done.lessons[g.id]) {
      S.done.lessons[g.id] = true;
      fillGameSelect();
      toast(`第 ${g.num} 课的练习全部通过！`);
    }
    save();
  }
  render();
}

function yiTap(p) {
  const e = yiEx();
  if (!e || !e.board || p === NONE) return;
  const idx = yiIndex(p);
  if (e.type === 'point') {
    yiAnswer(e.answers.includes(idx));
  } else if (e.type === 'play') {
    if (YI.pos >= e.line.length) return;
    const want = e.line[YI.pos];
    if (idx !== want.index) {
      yiAnswer(false, `这一步应该由${colorName(want.color)}棋下。`);
      return;
    }
    YI.pos++;
    yiSetBoard();
    if (YI.pos >= e.line.length) yiAnswer(true);
    else { delete YI.fb[e.id]; render(); }
  }
}

function yiCoachHtml() {
  const g = sg(), exs = g.exercises, e = exs[YI.ex];
  const allDone = exs.length && exs.every(x => S.done.yi[x.id]);
  let h = `<div class="cm game"><div class="h"><b>第 ${g.num} 课 · ${esc(g.title)}</b><span class="wr">第 ${g.stage} 阶段 ${esc(g.stageTitle)} · 约 ${g.minutes} 分钟</span></div>
    ${g.subtitle ? `<p class="note">${esc(g.subtitle)}</p>` : ''}
    ${g.objectives.length ? `<div class="note">学习目标：</div><ul>${g.objectives.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}</div>`;
  for (const sec of g.sections) h += `<div class="cm"><b>${esc(sec.heading)}</b><p>${esc(sec.body)}</p></div>`;
  if (e) {
    const fb = YI.fb[e.id];
    h += `<div class="cm ${fb ? (fb.correct ? 'right' : 'wrong') : 'hint'}"><div class="h"><b>课后练习 ${YI.ex + 1} / ${exs.length}</b>
      <span class="wr">${S.done.yi[e.id] ? '已答对' : ''}</span></div><p class="prompt">${esc(e.prompt)}</p>`;
    if (e.type === 'choice') {
      h += '<div class="keys">' + e.options.map((o, i) => `<button data-opt="${i}">${esc(o)}</button>`).join('') + '</div>';
    } else if (e.type === 'number') {
      h += `<form class="ask-form" data-num="1"><input id="yiNum" type="number" inputmode="numeric" placeholder="填一个数字" value="${esc(YI.input)}"><button class="primary small">确定</button></form>`;
    } else if (e.type === 'point') {
      h += '<p class="note">在棋盘上点你的答案。</p>';
    } else if (e.type === 'play') {
      h += `<p class="note">在棋盘上按顺序下出这几步（黑白都由你来下）。已下 ${YI.pos} / ${e.line.length} 步${YI.pos < e.line.length ? `，下一步轮到${colorName(e.line[YI.pos].color)}` : ''}。</p>`;
    }
    if (fb) h += `<p><b>${fb.correct ? '答对了！' : ''}</b>${esc(fb.text)}</p>`;
    h += `<div class="keys">${YI.ex > 0 ? '<button data-yi="prev">上一题</button>' : ''}
      ${e.type === 'play' ? '<button data-yi="reset">重新下</button>' : ''}
      ${e.board ? `<button data-yi="numbers">${YI.numbers ? '隐藏编号' : '显示编号'}</button>` : ''}
      ${YI.ex < exs.length - 1 ? '<button data-yi="next" class="on">下一题</button>' : ''}</div>`;
    if (e.board) h += '<p class="note">题目里的数字是点位编号：从左上角 0 开始逐行往右数；点“显示编号”可以在棋盘上对照。</p>';
    h += '</div>';
  }
  if (allDone || !exs.length) {
    h += `<div class="cm best"><b>本课要点</b><div class="key">${esc(g.takeaway)}</div>${g.practice ? `<p class="note">课后实践：${esc(g.practice)}</p>` : ''}</div>`;
  }
  return h;
}

function stopAuto() {
  if (T.auto) { clearInterval(T.auto); T.auto = 0; }
}

function toggleAuto() {
  if (T.auto) { stopAuto(); render(); return; }
  T.auto = setInterval(() => {
    if (S.mode !== 'study' || T.idx >= gameMoves(sg()).length) { stopAuto(); render(); return; }
    studyGo(T.idx + 1);
  }, 3500);
  studyGo(T.idx + 1);
}

function studyTap(p) {
  if (!T.guess || p === NONE) return;
  const mv = gameMoves(sg());
  if (T.idx >= mv.length) return;
  const b = studyBoardAt(T.idx), actual = mv[T.idx];
  T.tried++;
  if (p === actual) {
    T.hit++;
    T.lastGuess = { ok: true, at: T.idx + 1 };
    toast('猜中了！');
  } else {
    T.lastGuess = { ok: false, at: T.idx + 1, p, guess: b.name(p), actual: b.name(actual) };
    toast(`实战下在 ${b.name(actual)}`);
  }
  studyGo(T.idx + 1);
}

// ---------------- 练习 ----------------

function pb() { return PROBLEMS[P.i]; }

function practiceStart() {
  clearTimeout(P.anim);
  const q = pb();
  if (!q) return;
  const b = new G.Board(q.size);
  b.setupStones(sgfList(b, q.ab), sgfList(b, q.aw), BLACK);
  P.board = b;
  P.phase = 'ask';
  P.msg = '';
  P.showTip = false;
  P.last = NONE;
  layout();
  save();
  render();
}

function practiceGo(i) {
  P.i = clamp(i, 0, PROBLEMS.length - 1);
  practiceStart();
}

/** 自动演示一串着法。 */
function practicePlayLine(moves, then) {
  clearTimeout(P.anim);
  let k = 0;
  const stepLine = () => {
    if (k >= moves.length) { if (then) then(); render(); return; }
    P.board.play(moves[k]);
    P.last = moves[k];
    k++;
    render();
    P.anim = setTimeout(stepLine, 650);
  };
  stepLine();
}

function practiceTap(p) {
  const q = pb();
  if (!q || p === NONE) return;
  if (P.phase !== 'ask') { practiceStart(); return; }
  const b = P.board;
  if (b.b[p] !== EMPTY) return;
  if (!b.isLegal(p, BLACK)) { toast('这里不能下（禁着点）'); return; }
  const answers = q.answers.map(s => sgfPt(b, s));
  if (answers.includes(p)) {
    P.phase = 'right';
    P.msg = '';
    // 用正解里的主变化演示；如果答的是另一种正解，也先落这一手
    const pv = sgfList(b, q.pv.join(''));
    const line = pv[0] === p ? pv : [p];
    practicePlayLine(line, () => {
      if (!S.done.problems[q.id]) { S.done.problems[q.id] = true; fillProblemSelect(); save(); }
    });
    return;
  }
  // 答错：找出白棋的应法
  P.phase = 'wrong';
  const c = b.copy();
  c.play(p);
  const T0 = sgfPt(b, q.target), depth = Math.min(q.depth, 12);
  let reply = null, msg;
  if (q.goal === 'capture') {
    const targets = [T0].concat(q.also ? [sgfPt(b, q.also)] : []);
    if (c.b[T0] === EMPTY) reply = null;
    else if (targets.length > 1) {
      for (const d of new Set(targets.flatMap(t => G.groupLibs(c, t).libs))) {
        const c2 = c.copy();
        if (!c2.play(d)) continue;
        if (targets.every(t => !G.attack(c2, t, depth - 1, false))) { reply = d; break; }
      }
    } else {
      reply = G.findDefense(c, T0, depth, !!q.wide);
    }
    const lifeDeath = /点眼|对杀/.test(q.title);
    msg = reply !== null && reply !== undefined
      ? `不对。白下在 ${b.name(reply)}，${lifeDeath ? '白棋就活了（或者对杀赢了）' : '白棋就逃掉了'}。`
      : '不对，这样吃不掉白棋。';
  } else {
    const r = G.attack(c, T0, depth, false);
    reply = r && r.length ? r[0] : null;
    msg = reply !== null ? `不对。白下在 ${b.name(reply)}，黑棋就活不成了。` : '不对，这样救不了黑棋。';
  }
  P.board.play(p);
  P.last = p;
  if (reply !== null && reply !== undefined && reply !== PASS) {
    setTimeout(() => {
      if (P.phase !== 'wrong') return;
      P.board.play(reply);
      P.last = reply;
      render();
    }, 500);
  }
  P.msg = msg + ' 点“重做”或点一下棋盘再试一次。';
  P.showTip = true;
  render();
}

function practiceAnswer() {
  practiceStart();
  P.phase = 'shown';
  const q = pb();
  practicePlayLine(sgfList(P.board, q.pv.join('')));
}

// ---------------- 模式切换 ----------------

const catOf = g => (g.kind === 'game' || g.kind === 'mine' ? 'games' : 'learn');

/** 切换“学习”或“棋谱”标签页：各自回到上次看的那一课 / 那一局。 */
function setStudyCat(cat) {
  if (S.mode === 'study' && T.cat === cat) return;
  if (S.mode === 'study') T.last[T.cat] = T.gi;
  T.cat = cat;
  const want = T.last[cat];
  const gi = GAMES[want] && catOf(GAMES[want]) === cat ? want : GAMES.findIndex(g => catOf(g) === cat);
  if (S.mode !== 'study') { if (T.gi !== gi) T.idx = 0; T.gi = gi; setMode('study'); if (sg().kind === 'yi') { yiSelect(0); render(); } return; }
  fillGameSelect();
  selectGame(gi);
}

function setMode(m) {
  if (S.mode === m) return;
  if (m === 'study' && (!GAMES[T.gi] || catOf(GAMES[T.gi]) !== T.cat)) {
    T.gi = GAMES.findIndex(g => catOf(g) === T.cat);
    T.idx = 0;
  }
  stopAuto();
  clearTimeout(P.anim);
  cancelWork();
  exitReview();
  S.mode = m;
  S.ghost = NONE;
  Q.mark = null;
  if (Q.open) openAsk(false);
  save();
  if (m === 'practice') practiceStart();
  if (m === 'study') fillGameSelect();
  layout();
  render();
  if (m === 'play') advance();
  else if (m === 'study') studyGo(T.idx);
}

// ---------------- 棋盘绘制 ----------------

const canvas = $('board'), ctx = canvas.getContext('2d');
const geom = { cell: 0, org: 0, px: 0, n: 9 };

function layout() {
  const wrap = $('boardWrap');
  const landscape = innerWidth >= innerHeight;
  let size;
  if (landscape) size = Math.min(wrap.clientWidth, wrap.clientHeight) - 12;
  else size = Math.min(innerWidth - 12, innerHeight * 0.62);
  size = Math.max(200, Math.floor(size));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = canvas.style.height = size + 'px';
  canvas.width = canvas.height = Math.round(size * dpr);
  geom.px = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBoard();
}

function latestAnalysis(list, k) {
  for (let i = k; i >= 0; i--) if (list[i]) return { a: list[i], k: i };
  return null;
}

function drawStone(x, y, r, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.beginPath(); ctx.arc(x + r * 0.08, y + r * 0.12, r, 0, Math.PI * 2); ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r * 1.1);
  if (color === BLACK) { g.addColorStop(0, '#6a6a6a'); g.addColorStop(0.5, '#1c1c1c'); g.addColorStop(1, '#000'); }
  else { g.addColorStop(0, '#fff'); g.addColorStop(0.6, '#ececec'); g.addColorStop(1, '#bdbdbd'); }
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function starPoints(n) {
  if (n === 9) return [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]];
  if (n === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]];
  const a = [3, 9, 15], r = [];
  for (const x of a) for (const y of a) r.push([x, y]);
  return r;
}

/** 当前要画的局面，以及它的附加信息。 */
function boardView() {
  if (S.mode === 'practice') {
    return { b: P.board || new G.Board(9), practice: true, ghostColor: P.phase === 'ask' ? BLACK : 0, last: P.last };
  }
  if (S.mode === 'study' && sg().kind === 'yi') {
    return { b: YI.board || new G.Board(sg().size || 9), yi: true, ghostColor: YI.board && yiEx() && (yiEx().type === 'point' || yiEx().type === 'play') ? YI.board.toPlay : 0 };
  }
  if (S.mode === 'study') {
    const n = gameMoves(sg()).length;
    const b = studyBoardAt(T.idx);
    return { b, k: T.idx, list: T.analyses, study: true, ghostColor: T.guess && T.idx < n ? b.toPlay : 0 };
  }
  if (S.view !== null) {
    const b = reviewBoard();
    return { b, k: S.view, list: S.analyses, review: true, ghostColor: b.toPlay };
  }
  return { b: S.board, k: S.history.length, list: S.analyses, ghostColor: canHumanMove() ? S.board.toPlay : 0 };
}

function drawBoard() {
  const s = geom.px;
  if (!s) return;
  const v = boardView(), b = v.b;
  const n = b.n, cell = s / (n + 0.8), org = cell * 0.9, end = org + (n - 1) * cell;
  geom.cell = cell; geom.org = org; geom.n = n;
  const X = p => org + b.x(p) * cell, Y = p => org + b.y(p) * cell;

  const bg = ctx.createLinearGradient(0, 0, s, s);
  if (isDark()) { bg.addColorStop(0, '#a88450'); bg.addColorStop(1, '#8e6c3c'); } else { bg.addColorStop(0, '#e9c27c'); bg.addColorStop(1, '#d6a65b'); }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = '#3b2a14';
  ctx.lineWidth = Math.max(1, cell * 0.035);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const t = org + i * cell;
    ctx.moveTo(org, t); ctx.lineTo(end, t);
    ctx.moveTo(t, org); ctx.lineTo(t, end);
  }
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, cell * 0.06);
  ctx.strokeRect(org, org, end - org, end - org);
  ctx.fillStyle = '#3b2a14';
  for (const [x, y] of starPoints(n)) {
    ctx.beginPath(); ctx.arc(org + x * cell, org + y * cell, Math.max(2.5, cell * 0.1), 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#6b4a1c';
  ctx.font = `${Math.round(cell * 0.3)}px -apple-system, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const t = org + i * cell;
    ctx.fillText(G.LETTERS[i], t, org - cell * 0.55);
    ctx.fillText(String(n - i), org - cell * 0.6, t);
  }

  const r = cell * 0.47;
  const scoring = S.mode === 'play' && !v.review ? S.scoring : null;

  if (S.mode === 'play' && !v.review && S.prefs.own && !scoring && !captureRule()) {
    const la = latestAnalysis(v.list, v.k);
    if (la) {
      for (let p = 0; p < b.size; p++) {
        if (b.b[p] === G.BORDER) continue;
        const o = la.a.own[p];
        if (Math.abs(o) < 0.2) continue;
        const h = cell * 0.42 * Math.min(1, Math.abs(o));
        ctx.fillStyle = o > 0 ? `rgba(0,0,0,${0.15 + 0.35 * Math.abs(o)})` : `rgba(255,255,255,${0.25 + 0.5 * Math.abs(o)})`;
        ctx.fillRect(X(p) - h / 2, Y(p) - h / 2, h, h);
      }
    }
  }

  const ghost = S.pendingTap !== NONE && S.mode === 'play' && !v.review ? S.pendingTap : S.ghost;
  if (v.ghostColor && ghost >= 0 && ghost < b.size && b.b[ghost] === EMPTY) {
    ctx.strokeStyle = 'rgba(21,101,192,.45)';
    ctx.lineWidth = Math.max(2, cell * 0.06);
    ctx.beginPath();
    ctx.moveTo(org, Y(ghost)); ctx.lineTo(end, Y(ghost));
    ctx.moveTo(X(ghost), org); ctx.lineTo(X(ghost), end);
    ctx.stroke();
    drawStone(X(ghost), Y(ghost), r, v.ghostColor, S.pendingTap === ghost ? 0.8 : 0.5);
  }

  for (let p = 0; p < b.size; p++) {
    const c = b.b[p];
    if (c !== BLACK && c !== WHITE) continue;
    drawStone(X(p), Y(p), r, c, scoring && scoring.dead[p] ? 0.35 : 1);
  }

  // 新手辅助：被叫吃（只剩一口气）的棋子套红圈
  if (S.prefs.helper && (S.mode === 'play' || S.mode === 'practice') && !scoring) {
    ctx.save();
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = Math.max(2, r * 0.13);
    ctx.setLineDash([r * 0.35, r * 0.2]);
    for (const color of [BLACK, WHITE]) {
      for (const g of atariGroups(b, color)) {
        for (const p of g.stones) { ctx.beginPath(); ctx.arc(X(p), Y(p), r * 1.08, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  if (scoring) {
    const h = cell * 0.16;
    for (let p = 0; p < b.size; p++) {
      const t = scoring.terr[p];
      if (!t) continue;
      ctx.fillStyle = t === BLACK ? '#111' : '#fafafa';
      ctx.fillRect(X(p) - h, Y(p) - h, 2 * h, 2 * h);
      if (t === WHITE) { ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.strokeRect(X(p) - h, Y(p) - h, 2 * h, 2 * h); }
    }
  }

  // 候选点：数字是走那里之后，下这手一方的胜率
  let cands = null;
  if (v.review && !S.tries.length && !captureRule()) {
    if (S.analyses[S.view]) cands = S.analyses[S.view].cands.slice(0, 3);
  } else if (!v.review && S.mode === 'play' && !captureRule() && (S.prefs.cands || (S.hint && !S.hint.loading)) && canHumanMove() && S.analyses[v.k]) {
    cands = S.analyses[v.k].cands.slice(0, 3);
  }
  if (cands) {
    const cols = ['#2e7d32', '#1565c0', '#6a1b9a'];
    cands.forEach((c, i) => {
      if (c.move < 0 || b.b[c.move] !== EMPTY) return;
      ctx.fillStyle = cols[i] + 'cc';
      ctx.beginPath(); ctx.arc(X(c.move), Y(c.move), r * 0.92, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(cell * 0.3)}px -apple-system, sans-serif`;
      ctx.fillText(String(Math.round(c.wr * 100)), X(c.move), Y(c.move) + 1);
    });
  }

  const numberStone = (p, num, color) => {
    ctx.fillStyle = b.b[p] === BLACK ? '#fff' : '#111';
    ctx.font = `bold ${Math.round(cell * (num >= 100 ? 0.3 : 0.36))}px -apple-system, sans-serif`;
    ctx.fillText(String(num), X(p), Y(p) + 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.beginPath(); ctx.arc(X(p), Y(p), r * 1.02, 0, Math.PI * 2); ctx.stroke();
  };

  if (v.review) {
    if (S.tries.length) {
      // 试下的棋子标上 1、2、3……
      S.tries.forEach((m, i) => { if (b.b[m] !== EMPTY) numberStone(m, i + 1, '#1565c0'); });
    } else {
      const m = S.history[S.view];
      if (m >= 0) {
        drawStone(X(m), Y(m), r, b.toPlay, 0.55);
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = Math.max(2, r * 0.18);
        ctx.beginPath(); ctx.arc(X(m), Y(m), r * 0.95, 0, Math.PI * 2); ctx.stroke();
      }
    }
  } else if (v.study) {
    if (b.lastMove >= 0) numberStone(b.lastMove, T.idx, '#e53935');
  } else if (v.practice) {
    if (v.last >= 0 && b.b[v.last] !== EMPTY) {
      ctx.fillStyle = '#e53935';
      ctx.beginPath(); ctx.arc(X(v.last), Y(v.last), r * 0.28, 0, Math.PI * 2); ctx.fill();
    }
  } else if (b.lastMove >= 0 && !scoring) {
    ctx.fillStyle = '#e53935';
    ctx.beginPath(); ctx.arc(X(b.lastMove), Y(b.lastMove), r * 0.28, 0, Math.PI * 2); ctx.fill();
  }

  if (v.yi && YI.board && yiEx() && yiEx().board) {
    const e = yiEx(), n0 = e.board.size;
    ctx.font = `bold ${Math.round(cell * 0.34)}px -apple-system, sans-serif`;
    for (let i = 0; i < n0 * n0; i++) {
      const p = b.pt(i % n0, Math.floor(i / n0));
      const mark = e.board.marks && e.board.marks[i];
      const label = YI.numbers ? String(i) : mark;
      if (!label) continue;
      if (b.b[p] === EMPTY) {
        ctx.fillStyle = 'rgba(233,194,124,.9)';
        ctx.beginPath(); ctx.arc(X(p), Y(p), r * 0.62, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = b.b[p] === BLACK ? '#fff' : mark && !YI.numbers ? '#1565c0' : '#3b2a14';
      if (YI.numbers) ctx.font = `${Math.round(cell * 0.28)}px -apple-system, sans-serif`;
      ctx.fillText(label, X(p), Y(p) + 1);
    }
    const fb = YI.fb[e.id];
    if (fb && fb.correct && e.type === 'point') {
      ctx.strokeStyle = '#2e7d32';
      ctx.lineWidth = Math.max(2, r * 0.18);
      for (const i of e.answers) { const p = b.pt(i % n0, Math.floor(i / n0)); ctx.beginPath(); ctx.arc(X(p), Y(p), r, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  // 标出得失：最近一手让哪些点变成了谁的（方块），以及被紧气的棋还剩哪几口气（红点）
  if (S.prefs.marks && S.mode === 'play' && !v.review && !scoring && !Q.area && !Q.mark && S.history.length) {
    const j = S.history.length - 1, last = S.history[j], cm = S.comments[j];
    if (cm && cm.gain && cm.gain.length) {
      const blue = pvp() ? cm.color === BLACK : cm.color === S.game.human;
      ctx.fillStyle = blue ? 'rgba(21,101,192,.4)' : 'rgba(230,81,0,.42)';
      const h = cell * 0.2;
      for (const nm of cm.gain) { const p = nameToPt(b, nm); if (p >= 0 && b.b[p] === EMPTY) ctx.fillRect(X(p) - h, Y(p) - h, 2 * h, 2 * h); }
    }
    if (last >= 0 && b.b[last] !== EMPTY) {
      const seenG = new Set();
      for (const q of [last, ...b.dir.map(d => last + d)]) {
        const c = b.b[q];
        if (c !== BLACK && c !== WHITE) continue;
        const gl = G.groupLibs(b, q);
        if (seenG.has(gl.stones[0]) || gl.libs.length > 3) continue;
        seenG.add(gl.stones[0]);
        ctx.fillStyle = '#d32f2f';
        for (const l of gl.libs) { ctx.beginPath(); ctx.arc(X(l), Y(l), Math.max(2.5, r * 0.2), 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }

  if (Q.area) {
    ctx.fillStyle = 'rgba(21,101,192,.45)';
    const h = cell * 0.22;
    for (const p of Q.area) if (p >= 0 && p < b.size) ctx.fillRect(X(p) - h, Y(p) - h, 2 * h, 2 * h);
  }

  if (Q.mark) {
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = Math.max(2, r * 0.2);
    for (const p of Q.mark) { ctx.beginPath(); ctx.arc(X(p), Y(p), r * 1.05, 0, Math.PI * 2); ctx.stroke(); }
  }

  if (v.study && T.lastGuess && !T.lastGuess.ok && T.lastGuess.at === T.idx) {
    const p = T.lastGuess.p, d = r * 0.45;
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = Math.max(2, r * 0.16);
    ctx.beginPath();
    ctx.moveTo(X(p) - d, Y(p) - d); ctx.lineTo(X(p) + d, Y(p) + d);
    ctx.moveTo(X(p) + d, Y(p) - d); ctx.lineTo(X(p) - d, Y(p) + d);
    ctx.stroke();
  }
}

function toPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top, n = geom.n;
  const gx = Math.round((x - geom.org) / geom.cell), gy = Math.round((y - geom.org) / geom.cell);
  if (gx < 0 || gy < 0 || gx >= n || gy >= n) return NONE;
  return (gy + 1) * (n + 2) + gx + 1;
}

function onBoardTap(p) {
  if (Q.pick && p !== NONE) { askPicked(p); return; }
  if (S.mode === 'study') { if (sg().kind === 'yi') yiTap(p); else studyTap(p); return; }
  if (S.mode === 'practice') { practiceTap(p); return; }
  if (p === NONE) return;
  if (S.view !== null) { reviewTry(p); return; }
  if (S.scoring) {
    if (S.scoring.toggle(p)) { S.summary = buildSummary(); recordGame(); render(); }
    return;
  }
  if (!canHumanMove()) return;
  const b = S.board, me = b.toPlay;
  if (!b.isLegal(p, me)) {
    if (b.b[p] === EMPTY) toast(p === b.ko ? '打劫：需要先在别处走一手，才能提回' : '这里不能落子（禁着点）');
    return;
  }
  if (S.pendingTap !== p) {
    // 新手辅助：这手会让自己被叫吃时先提醒
    if (S.prefs.helper && b.isSelfAtari(p, me)) {
      S.pendingTap = p;
      toast(`注意：下在这里，${pvp() ? colorName(me) + '方' : '你'}的棋只剩一口气，可能被提掉。确定要下就再点一次。`);
      drawBoard();
      return;
    }
    if (S.prefs.confirm) {
      S.pendingTap = p;
      drawBoard();
      return;
    }
  }
  playMove(p);
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  S.ghost = toPoint(e);
  drawBoard();
});
canvas.addEventListener('pointermove', e => {
  const p = toPoint(e);
  if (p !== S.ghost) { S.ghost = p; drawBoard(); }
});
canvas.addEventListener('pointerup', e => {
  const p = toPoint(e);
  S.ghost = NONE;
  onBoardTap(p);
  drawBoard();
});
canvas.addEventListener('pointercancel', () => { S.ghost = NONE; drawBoard(); });
canvas.addEventListener('pointerleave', e => {
  if (e.pointerType === 'mouse') { S.ghost = NONE; drawBoard(); }
});

// ---------------- 侧栏 ----------------

/** 顶部的胜率横条：左边标签、左边所占比例、右边标签；不给参数就隐藏。 */
function setWr(left, frac, right, blackWhite) {
  const box = $('wrBox');
  if (left === undefined || frac === null || frac === undefined) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle('bw', !!blackWhite);
  $('wrLeft').textContent = left;
  $('wrRight').textContent = right;
  $('wrFill').style.width = `${Math.round(frac * 100)}%`;
}

/** 你（真人对战时是黑方）领先的目数，只有神经网络的分析才有 */
function humanLead() {
  const la = latestAnalysis(S.analyses, S.history.length);
  if (!la || !la.a.nn) return null;
  return (pvp() ? BLACK : S.game.human) === BLACK ? la.a.score : -la.a.score;
}
const leadNote = v => (v === null ? '' : Math.abs(v) < 0.5 ? ' · 均势' : ` · ${v > 0 ? '领先' : '落后'}${Math.round(Math.abs(v) * 2) / 2}目`);

function humanWr() {
  const la = latestAnalysis(S.analyses, S.history.length);
  if (!la) return null;
  return la.a.toPlay === (pvp() ? BLACK : S.game.human) ? la.a.wr : 1 - la.a.wr;
}

function statusText() {
  if (S.view !== null) return '回看中（对局不会被改变）';
  if (S.scoringBusy) return '正在数子…';
  if (S.scoring) return '终局 · 点棋子可切换死活\n' + scoreText();
  if (S.result) return S.result.text;
  const g = S.game, b = S.board;
  const info = captureRule()
    ? (pvp() ? `吃子棋 · 先吃到 ${g.captureN} 子获胜 · 黑吃了 ${b.capB}，白吃了 ${b.capW}`
      : `吃子棋 · 先吃到 ${g.captureN} 子获胜 · 你吃了 ${g.human === BLACK ? b.capB : b.capW}，AI 吃了 ${g.human === BLACK ? b.capW : b.capB}`)
    : `${g.size}路 · 第 ${b.moveCount} 手 · 提子 黑${b.capB} 白${b.capW}`;
  let s;
  if (pvp()) {
    s = `真人对战 · 轮到${colorName(b.toPlay)}方`;
    if (b.lastMove === PASS && b.moveCount > 0) s += `（${colorName(3 - b.toPlay)}方停了一手）`;
  } else if (b.toPlay !== g.human) s = `AI（${captureRule() ? '吃子棋' : S.prefs.target < 100 ? '让棋' : LEVELS[S.prefs.level].name}）思考中…`;
  else {
    s = `轮到你（执${colorName(g.human)}）`;
    if (b.lastMove === PASS && b.moveCount > 0) s += ' · AI 停了一手';
  }
  s += `　${info}`;
  if (S.prefs.own && !captureRule()) {
    const la = latestAnalysis(S.analyses, S.history.length);
    if (la) s += `\n形势判断：${la.a.score > 0 ? '黑' : '白'}领先约 ${Math.abs(la.a.score).toFixed(1)}`;
  }
  if (S.prefs.marks && S.history.length) s += `\n棋盘标记：${pvp() ? '蓝/橙方块 = 黑/白方' : '蓝方块 = 你、橙方块 = AI'}这手得到的点；红点 = 被紧气的棋剩下的气`;
  return s;
}

function reasonsHtml(list) {
  if (!list) return '<ul><li>正在分析…</li></ul>';
  return '<ul>' + list.map(r => `<li>${esc(r)}</li>`).join('') + '</ul>';
}

function commentHtml(c) {
  const num = `第 ${c.j + 1} 手`;
  if (c.simple) {
    return `<div class="cm ${c.you ? 'good' : 'ai'}${S.view === c.j ? ' viewing' : ''}" data-j="${c.j}">
      <div class="h"><b>${num}</b> ${esc(c.who || (c.you ? '你' : 'AI'))}下 ${esc(c.name)}</div>${reasonsHtml(c.reasons)}</div>`;
  }
  if (c.you) {
    let h = `<div class="cm ${c.q.cls}${S.view === c.j ? ' viewing' : ''}" data-j="${c.j}">
      <div class="h"><b>${num}</b> ${esc(c.who || '你')}下 ${esc(c.name)} <span class="tag ${c.q.cls}">${c.q.label}</span>
      <span class="wr">胜率 ${pct(c.wrBefore)} → ${pct(c.wrAfter)}${c.pts >= 0.5 ? ` · 亏 ${ptsText(c.pts)}` : ''}</span></div>${reasonsHtml(c.reasons)}`;
    if (c.leadAfter !== null && c.leadAfter !== undefined) h += `<p class="note">这手之后，${esc(c.who || '你')}${c.leadAfter >= 0 ? '领先' : '落后'}约 ${ptsText(c.leadAfter)}（按数子、含贴目）。</p>`;
    if (c.best) {
      h += `<div class="better">更好的是 <b>${esc(c.best.name)}</b>（胜率约 ${pct(c.best.wr)}${c.best.pts >= 0.5 ? `，比实战多 ${ptsText(c.best.pts)}` : ''}）${reasonsHtml(c.best.reasons)}</div>`;
    }
    if (c.gain && c.gain.length) h += `<p><button class="small" data-gain="${c.j}">在棋盘上看这些目</button></p>`;
    if (c.q.cls === 'slow' || c.q.cls === 'bad') h += '<p class="note">点这条点评，可以回看当时的局面并试下。</p>';
    return h + '</div>';
  }
  const yourWr = c.wrNext !== undefined ? c.wrNext : 1 - c.wrAfter;
  return `<div class="cm ai${S.view === c.j ? ' viewing' : ''}" data-j="${c.j}">
    <div class="h"><b>${num}</b> AI 下 ${esc(c.name)}${c.eased ? ' <span class="note">（让棋）</span>' : ''}
    <span class="wr">你的胜率 ${pct(yourWr)}</span></div>${reasonsHtml(c.reasons)}
    ${c.gain && c.gain.length ? `<p><button class="small" data-gain="${c.j}">在棋盘上看 AI 得到的点</button></p>` : ''}</div>`;
}

function reviewHtml() {
  const j = S.view, b = boardAt(j), m = S.history[j], c = b.toPlay;
  let h = `<div class="cm hint"><div class="h"><b>回看：第 ${j + 1} 手之前</b></div>
    <p>实战${sideName(c)}下在 <b>${esc(b.name(m))}</b>（红圈）。${captureRule() ? '' : '彩色圆圈是 AI 推荐的点，数字是走那里之后的胜率。'}</p>
    <p class="note">在棋盘上点一下就是“试下”，可以连续试几手（黑白轮流），真正的对局不会被改变。看完点“回到当前”继续下。</p>`;
  const tn = S.tryNote;
  if (tn) {
    h += '<div class="better">';
    if (!tn.q) h += `<p>试下 ${esc(tn.name)}：${esc(tn.text)}</p>`;
    else {
      h += `<p>试下 <b>${esc(tn.name)}</b>：<span class="tag ${tn.q.cls}">${tn.q.label}</span> 走这里之后的胜率约 ${pct(tn.wr)}${tn.best ? `（AI 推荐 ${esc(tn.best.name)} 约 ${pct(tn.best.wr)}）` : ''}</p>${reasonsHtml(tn.reasons)}`;
    }
    h += '</div>';
  }
  const cm = S.comments[j];
  return h + '</div>' + (cm ? commentHtml(cm) : '');
}

function playCoachHtml() {
  if (S.view !== null) return reviewHtml();
  let html = '';
  if ((S.result || S.scoring) && !S.summary) S.summary = buildSummary();
  if ((S.result || S.scoring) && S.summary) html += S.summary.html;
  if (S.hint) {
    if (S.hint.loading) html += '<div class="cm hint"><b>提示</b> 正在计算…</div>';
    else {
      html += `<div class="cm hint"><div class="h"><b>提示</b> 推荐 <b>${esc(S.hint.name)}</b>
        ${S.hint.wr !== null ? `<span class="wr">胜率约 ${pct(S.hint.wr)}</span>` : ''}</div>${reasonsHtml(S.hint.reasons)}
        ${S.hint.others.length ? `<div class="note">其他候选：${S.hint.others.map(o => `${esc(o.name)}（${pct(o.wr)}）`).join('，')}；棋盘上的数字是走那里之后你的胜率。</div>` : ''}</div>`;
    }
  }
  if (captureRule() && !S.history.length) {
    html += `<div class="cm game"><b>吃子棋</b><p>规则：谁先吃到 ${S.game.captureN} 个子谁赢，不用管地盘。</p>
      <p>要点：1）数一数双方的气，只剩一口气的子（红圈）马上就会被吃；2）自己被叫吃时往外长，能长出 3 口气就安全；3）叫吃对方时，把它往你自己的棋子那边赶。</p></div>`;
  }
  if (!S.prefs.coach) {
    return html + '<div class="empty">讲解已关闭。勾选“讲解”就能看到每步棋的点评。</div>';
  }
  const keys = Object.keys(S.comments).map(Number).sort((a, b) => b - a);
  if (!keys.length && !captureRule()) {
    html += '<div class="empty">下棋后，这里会逐手点评：这步棋好不好、为什么，以及更好的下法。<br>点一条点评，或者点“回看”，可以回到前面的局面想一想、试下几手。</div>';
  }
  for (const j of keys) html += commentHtml(S.comments[j]);
  return html;
}

function studyCoachHtml() {
  const g = sg(), mv = gameMoves(g), n = mv.length, i = T.idx;
  const lesson = g.kind === 'lesson';
  const keysHtml = '<div class="keys">' + Object.keys(g.notes).map(Number).filter(k => k <= n).map(k =>
    `<button data-go="${k}"${k === i ? ' class="on"' : ''}>第 ${k} 手</button>`).join('') + '</div>';
  const nextLesson = lesson && i === n ? GAMES.findIndex((x, k) => k > T.gi && x.kind === 'lesson') : -1;
  const info = `<div class="cm game"><div class="h"><b>${esc(g.title)}</b>
    <span class="wr">${lesson ? esc(g.chapter) : `${g.year} 年 · ${esc(g.result)}`}</span></div>
    ${lesson ? '' : `<div>黑：${esc(g.black)}　白：${esc(g.white)}</div>`}
    ${i === 0 ? `<p>${esc(g.intro)}</p><p class="note">点“下一手”一步步看，每一手都有讲解；打开“猜棋”先自己想下一手再揭晓，是提高棋力最有效的练习。</p>` : ''}
    ${lesson && (i === 0 || i === n) ? `<div class="key">${esc(g.use)}</div>` : ''}
    ${nextLesson >= 0 ? `<p><button class="small primary" data-lesson="${nextLesson}">下一课：${esc(GAMES[nextLesson].title)}</button></p>` : ''}
    ${g.kind === 'mine' ? '<p class="keys"><button data-rec="export">导出全部对局记录</button><button data-rec="import">导入对局记录</button></p><p class="note">共保存了 ' + RECORDS.length + ' 盘对局。导出的文件可以存到云盘或发到别的设备，再导入合并。</p>' : ''}
    ${Object.keys(g.notes).length ? `<div class="note">${lesson ? '每一步：' : '重点手：'}</div>${keysHtml}` : ''}</div>`;
  if (i === 0) return info;
  const b = studyBoardAt(i - 1), m = mv[i - 1], c = b.toPlay;
  const cm = T.comments[i - 1];
  const note = g.notes[i];
  const who = lesson ? colorName(c) : `${colorName(c)}（${esc(c === BLACK ? g.black : g.white)}）`;
  let h = `<div class="cm${note ? ' best' : ''}"><div class="h"><b>第 ${i} 手</b> ${who}${m === PASS ? '停一手' : '下 ' + esc(b.name(m))}
    ${cm && !lesson ? `<span class="wr">黑胜率约 ${pct(cm.blackWr)}</span>` : ''}</div>`;
  if (note) h += `<div class="key"><b>讲解：</b>${esc(note)}</div>`;
  if (T.lastGuess && T.lastGuess.at === i) {
    h += T.lastGuess.ok
      ? '<p>你猜中了这一手！</p>'
      : `<p>你猜的是 ${esc(T.lastGuess.guess)}（棋盘上的蓝色叉号），实战下在 ${esc(T.lastGuess.actual)}。对比一下两手棋的区别。</p>`;
  }
  if (m !== PASS && (!lesson || !note)) {
    h += `<div class="note" style="margin-top:6px">AI 讲解：</div>${reasonsHtml(cm && cm.reasons)}`;
    if (cm && cm.top && !lesson) {
      h += cm.top.same
        ? '<p class="note">这手棋与本机 AI 引擎的首选一致。</p>'
        : g.kind === 'mine'
          ? `<p class="note">AI 推荐的是 ${esc(cm.top.name)}。</p>`
          : `<p class="note">本机 AI 引擎的首选是 ${esc(cm.top.name)}。引擎棋力远不如这些高手，这里只作对照：想一想高手为什么没有下那里。</p>`;
    }
  }
  if (i === n && !lesson) h += `<p><b>终局：${esc(g.result)}</b></p>`;
  return h + '</div>' + info;
}

function practiceCoachHtml() {
  const q = pb();
  if (!q) return '<div class="empty">没有练习题。</div>';
  const doneN = PROBLEMS.filter(x => S.done.problems[x.id]).length;
  let h = `<div class="cm ${P.phase === 'right' ? 'right' : P.phase === 'wrong' ? 'wrong' : 'game'}">
    <div class="h"><b>${esc(LEVEL_NAMES[q.level])} · ${esc(q.title)}</b><span class="wr">第 ${P.i + 1} / ${PROBLEMS.length} 题 · 已完成 ${doneN}</span></div>
    <p class="prompt">${esc(q.prompt)}</p>`;
  if (P.phase === 'ask') h += '<p class="note">在棋盘上点你的答案（黑先）。</p>';
  if (P.showTip || P.phase === 'shown') h += `<div class="key">提示：${esc(q.tip)}</div>`;
  if (P.phase === 'right') h += `<p><b>正确！</b>${esc(q.explain)}</p><p class="note">棋盘上正在演示完整的变化。点“下一题”继续。</p>`;
  if (P.phase === 'wrong') h += `<p><b>${esc(P.msg)}</b></p>`;
  if (P.phase === 'shown') h += `<p><b>答案：</b>${esc(q.explain)}</p><p class="note">点“重做”自己再做一遍。</p>`;
  return h + '</div>';
}

function render() {
  const mode = S.mode;
  $('btnUser').textContent = curUser().name;
  // “提示”只在正显示提示时高亮
  $('btnHint').classList.toggle('on', !!S.hint);
  $('tabPlay').classList.toggle('on', mode === 'play');
  $('tabStudy').classList.toggle('on', mode === 'study' && T.cat === 'learn');
  $('tabGames').classList.toggle('on', mode === 'study' && T.cat === 'games');
  $('tabPractice').classList.toggle('on', mode === 'practice');
  $('playBar').hidden = mode !== 'play' || S.view !== null;
  $('reviewBar').hidden = mode !== 'play' || S.view === null;
  $('studyBar').hidden = mode !== 'study';
  $('practiceBar').hidden = mode !== 'practice';

  if (mode === 'study' && sg().kind === 'yi') {
    const g = sg();
    setWr();
    const doneN = GAMES.filter(x => x.kind === 'yi' && S.done.lessons[x.id]).length;
    $('status').textContent = `《弈》第 ${g.num} / 54 课 · 已学 ${doneN} 课`;
    $('selGame').value = String(T.gi);
    for (const id of ['btnFirst', 'btnPrev', 'btnNext', 'btnLast', 'btnAuto', 'btnGuess', 'rngMove', 'btnAsk2']) $(id).hidden = true;
    $('btnLsPrev').hidden = $('btnLsNext').hidden = false;
    $('btnLsPrev').disabled = T.gi === 0 || GAMES[T.gi - 1].kind !== 'yi';
    $('btnLsNext').disabled = !GAMES[T.gi + 1];
    $('coach').innerHTML = yiCoachHtml();
  } else if (mode === 'study') {
    for (const id of ['btnFirst', 'btnPrev', 'btnNext', 'btnLast', 'btnAuto', 'btnGuess', 'rngMove', 'btnAsk2']) $(id).hidden = false;
    const lessonKind = sg().kind === 'lesson';
    $('btnLsPrev').hidden = $('btnLsNext').hidden = !lessonKind;
    $('btnLsPrev').disabled = T.gi === 0;
    $('btnLsNext').disabled = !GAMES[T.gi + 1] || GAMES[T.gi + 1].kind !== 'lesson';
    const g = sg(), n = gameMoves(g).length;
    const la = latestAnalysis(T.analyses, T.idx);
    if (la && g.kind !== 'lesson') { const bw = la.a.toPlay === BLACK ? la.a.wr : 1 - la.a.wr; setWr(`黑 ${pct(bw)}`, bw, `白 ${pct(1 - bw)}`, true); } else setWr();
    let st = `${g.title}　第 ${T.idx} / ${n} 手`;
    if (T.idx < n) st += ` · 下一手：${colorName(studyBoardAt(T.idx).toPlay)}`;
    if (T.guess) st += ` · 猜棋 ${T.hit}/${T.tried}`;
    $('status').textContent = st;
    $('selGame').value = String(T.gi);
    $('rngMove').max = String(n);
    $('rngMove').value = String(T.idx);
    $('btnFirst').disabled = $('btnPrev').disabled = T.idx === 0;
    $('btnNext').disabled = $('btnLast').disabled = T.idx >= n;
    $('btnAuto').classList.toggle('on', !!T.auto);
    $('btnAuto').textContent = T.auto ? '暂停' : '自动播放';
    $('btnGuess').classList.toggle('on', T.guess);
    $('coach').innerHTML = studyCoachHtml();
  } else if (mode === 'practice') {
    setWr();
    $('status').textContent = '练习：黑先';
    $('selProblem').value = String(P.i);
    $('btnPbPrev').disabled = P.i === 0;
    $('btnPbNext').disabled = P.i >= PROBLEMS.length - 1;
    $('coach').innerHTML = practiceCoachHtml();
  } else {
    if (captureRule()) {
      const b = S.board, me = S.game.human;
      setWr();
    } else {
      const hw = humanWr();
      if (hw === null) setWr();
      else if (pvp()) setWr(`黑 ${pct(hw)}${leadNote(humanLead())}`, hw, `白 ${pct(1 - hw)}`, true);
      else setWr(`你 ${pct(hw)}${leadNote(humanLead())}`, hw, `AI ${pct(1 - hw)}`);
    }
    $('status').textContent = statusText();
    const my = canHumanMove();
    $('btnUndo').disabled = !S.history.length;
    $('btnPass').disabled = !my;
    $('btnHint').disabled = !my;
    $('btnOwn').disabled = captureRule();
    $('btnReview').disabled = !S.history.length;
    $('btnResign').disabled = !!(S.result || S.scoring);
    $('btnOwn').classList.toggle('on', S.prefs.own);
    $('chkCoach').checked = S.prefs.coach;
    $('chkCands').checked = S.prefs.cands;
    $('chkConfirm').checked = S.prefs.confirm;
    $('chkHelper').checked = S.prefs.helper;
    $('chkMarks').checked = S.prefs.marks;
    if (S.view !== null) {
      $('reviewText').textContent = `回看第 ${S.view + 1} 手之前${S.tries.length ? ` · 已试下 ${S.tries.length} 手` : ''}`;
      $('btnRvPrev').disabled = S.view === 0;
      $('btnRvNext').disabled = S.view >= S.history.length - 1;
      $('btnRvClear').disabled = !S.tries.length;
    }
    $('coach').innerHTML = playCoachHtml();
  }
  drawBoard();
}

// ---------------- 提问 ----------------

/** 当前局面及其分析：对战里以“你”为视角，学习里以轮到下棋的一方为视角。 */
function askContext() {
  if (S.mode === 'study') {
    const b = studyBoardAt(T.idx);
    return { b, getA: () => getStudyAnalysis(T.idx), me: b.toPlay, meName: colorName(b.toPlay), komi: sg().komi || 0, budget: STUDY_BUDGET };
  }
  const k = S.history.length;
  return { b: S.board.copy(), getA: () => getAnalysis(k), me: perspective(), meName: sideName(perspective()), komi: S.game.komi, budget: BUDGET[S.game.size] };
}

/** 对话记录：同一个问题的“正在分析…”会被后来的答案替换。 */
function askShow(q, html, src, isPending) {
  const pending = isPending === undefined ? /正在/.test(html) : isPending;
  const last = Q.log[Q.log.length - 1];
  // 记下这次回答在棋盘上标的点，之后可以再看
  const marks = { mark: Q.mark ? Q.mark.slice() : null, area: Q.area ? Q.area.slice() : null, key: askPosKey() };
  if (last && last.q === q && last.pending) Object.assign(last, { html, src, pending }, (marks.mark || marks.area) ? marks : {});
  else Q.log.push({ q, html, src, pending, ...marks });
  if (Q.log.length > 30) Q.log.shift();
  const box = $('askAnswer');
  // 只显示最新的一问一答（之前的问答仍留在 Q.log 里，给大模型当上下文）
  box.innerHTML = Q.log.slice(-1).map(m => `<div class="chat-q">${esc(m.q)}</div><div class="chat-a">${m.html}${(m.mark && m.mark.length) || (m.area && m.area.length) ? '<p><button type="button" class="small" data-askshow>在棋盘上再看一次</button></p>' : ''}${m.src ? `<div class="note src">${esc(m.src)}</div>` : ''}</div>`).join('');
  box.scrollTop = 0;
}

/** 当前局面的标识：局面变了，旧答案标的点就不对了 */
function askPosKey() {
  return S.mode === 'play' ? `p${S.history.length}:${S.view}` : S.mode === 'study' ? `s${T.gi}:${T.idx}` : `x${S.mode}`;
}

$('askAnswer').addEventListener('click', e => {
  if (!e.target.closest('[data-askshow]')) return;
  const m = Q.log[Q.log.length - 1];
  if (!m) return;
  if (m.key !== askPosKey()) { toast('局面变了，按现在的局面重新回答'); askText(m.q); return; }
  Q.mark = m.mark ? m.mark.slice() : null;
  Q.area = m.area ? m.area.slice() : null;
  drawBoard();
  $('board').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function openAsk(open) {
  Q.open = open;
  Q.pick = null;
  Q.mark = null;
  $('askPanel').hidden = !open;
  $('btnAsk').classList.toggle('on', open);
  $('btnAsk2').classList.toggle('on', open);
  if (open && !Q.log.length) $('askAnswer').innerHTML = '<p class="note">可以问棋盘上的事：哪些是这块棋的气、哪些是我的地盘、刚才那手得到的目在哪、哪里是断点、我能吃掉哪块棋、哪块棋有危险、眼在哪……也可以问围棋知识。答案里提到的位置会在棋盘上标出来。</p>';
  syncAskChips();
  drawBoard();
}

function syncAskChips() {
  for (const el of document.querySelectorAll('[data-ask]')) el.classList.toggle('on', Q.pick === el.dataset.ask);
}

async function ask(kind, label) {
  const seq = ++Q.seq, ctx0 = askContext(), b = ctx0.b;
  const alive = () => seq === Q.seq;
  if (kind === 'point' || kind === 'group') {
    if (S.mode === 'play' && kind === 'point' && !canHumanMove()) { askShow(label, '<p>等轮到你下的时候再问这个问题。</p>'); return; }
    Q.pick = kind;
    syncAskChips();
    askShow(label, `<p>请在棋盘上点${kind === 'point' ? '一个空点' : '一块棋的任意一个棋子'}。</p>`);
    return;
  }
  if (S.mode === 'play' && captureRule() && kind !== 'weak') {
    askShow(label, '<p>吃子棋只比谁先吃到子。可以问“哪块棋最危险？”，或者点“提示”。</p>');
    return;
  }
  askShow(label, '<p>正在分析…</p>');
  const a = await ctx0.getA();
  if (!alive()) return;
  if (!a) { askShow(label, '<p>分析被打断了，请再问一次。</p>'); return; }
  const meWr = a.toPlay === ctx0.me ? a.wr : 1 - a.wr;
  if (kind === 'lead') {
    const sc = a.score;
    const lead = Math.abs(sc) < 1 ? '双方非常接近' : `${sc > 0 ? '黑' : '白'}领先约 ${Math.abs(sc).toFixed(1)}`;
    const feel = meWr > 0.7 ? '形势明显有利，稳健地下，不要冒险。' : meWr > 0.55 ? '稍微领先，注意补强自己的弱棋。'
      : meWr > 0.45 ? '难解难分，下一两手很关键。' : meWr > 0.3 ? '稍微落后，需要找机会主动出击。' : '形势落后较多，要在对方的薄弱处寻找战斗机会。';
    askShow(label, `<p>形势判断：${lead}（已计入贴目 ${ctx0.komi}）。</p><p>${esc(ctx0.meName)}的胜率约 ${pct(meWr)}：${feel}</p><p class="note">想看双方地盘的分布，可以打开“形势”。</p>`);
    return;
  }
  if (kind === 'best') {
    const top = a.cands.slice(0, 3);
    if (!top.length) { askShow(label, '<p>已经没有可下的地方了，可以停一手。</p>'); return; }
    const after = b.copy();
    after.play(top[0].move);
    const o = await pool.ownership(after, ctx0.budget.own, ctx0.komi);
    if (!alive() || !o) return;
    Q.mark = top.map(c => c.move).filter(m => m >= 0);
    drawBoard();
    const reasons = G.explain(b, top[0].move, b.toPlay, a.own, o.own, colorName(b.toPlay), colorName(3 - b.toPlay));
    askShow(label, `<p>推荐 <b>${esc(b.name(top[0].move))}</b>（下这手之后${colorName(b.toPlay)}的胜率约 ${pct(top[0].wr)}）：</p>${reasonsHtml(reasons)}
      ${top.length > 1 ? `<p class="note">其他候选：${top.slice(1).map(c => `${esc(b.name(c.move))}（${pct(c.wr)}）`).join('，')}。棋盘上用蓝圈标出了这几个点。</p>` : ''}`);
    return;
  }
  if (kind === 'weak') {
    const sgn = ctx0.me === BLACK ? 1 : -1, seen = new Set();
    let worst = null;
    for (let p = 0; p < b.size; p++) {
      if (b.b[p] !== ctx0.me || seen.has(p)) continue;
      const g = b.group(p);
      g.stones.forEach(q => seen.add(q));
      const s = g.stones.reduce((t, q) => t + a.own[q] * sgn, 0) / g.stones.length;
      const score = s - Math.min(g.stones.length, 8) * 0.02 - (g.libs === 1 ? 1 : 0);
      if (s > -0.6 && (!worst || score < worst.score)) worst = { g, s, score };
    }
    if (!worst || (worst.s > 0.6 && worst.g.libs > 1)) { askShow(label, `<p>${esc(ctx0.meName)}的棋目前都比较安全，可以放心去抢大场或攻击对方。</p>`); return; }
    Q.mark = worst.g.stones;
    drawBoard();
    askShow(label, `<p>${esc(ctx0.meName)}在 <b>${esc(b.name(worst.g.stones[0]))}</b> 一带的 ${worst.g.stones.length} 个子最危险（已用蓝圈标出），${groupState(worst.s, worst.g.libs)}</p>
      <p>${groupAdvice(true, worst.s)}</p>`);
  }
}

function groupState(s, libs) {
  const life = s > 0.6 ? '基本是活棋' : s > 0.2 ? '比较安全' : s > -0.2 ? '死活还不确定，处在危险中' : '已经很难活了';
  return `${life}，还有 ${libs} 口气${libs === 1 ? '——正被叫吃！' : libs === 2 ? '，气很紧' : ''}。`;
}

function groupAdvice(mine, s) {
  if (mine) {
    if (s > 0.6) return '这块棋不用急着补，可以去下别的大地方。';
    if (s > -0.2) return '建议：扩大眼位、向中央出头，或者和附近自己的棋连起来；不要让对方把它封在里面。';
    return '这块棋已经很难救了，可以考虑“弃子”，利用它在外面得到一些好处。（逢危须弃）';
  }
  if (s > 0.6) return '这块棋已经活了，不要浪费手数去攻击它。';
  if (s > -0.2) return '这是攻击的好目标：封锁它的出路、破坏它的眼位，在攻击中顺便围地。';
  return '这块棋基本被吃住了，不必再花手数，除非对方还有明显的做活手段。';
}

async function askPicked(p) {
  const kind = Q.pick, seq = ++Q.seq;
  Q.pick = null;
  syncAskChips();
  const ctx0 = askContext(), b = ctx0.b;
  const alive = () => seq === Q.seq;
  if (kind === 'group') {
    const c = b.b[p];
    if (c !== BLACK && c !== WHITE) { askShow('这块棋活吗？', '<p>这里没有棋子。请点一块棋的任意一个棋子。</p>'); Q.pick = 'group'; syncAskChips(); return; }
    const label = `${b.name(p)} 这块棋活吗？`;
    askShow(label, '<p>正在分析…</p>');
    const a = await ctx0.getA();
    if (!alive() || !a) return;
    const g = b.group(p), sgn = c === BLACK ? 1 : -1;
    const s = g.stones.reduce((t, q) => t + a.own[q] * sgn, 0) / g.stones.length;
    Q.mark = g.stones;
    drawBoard();
    const whose = S.mode === 'play' ? (c === S.game.human ? '你' : 'AI') : colorName(c);
    const mine = S.mode === 'play' ? c === S.game.human : c === b.toPlay;
    askShow(label, `<p>这块${colorName(c)}棋共 ${g.stones.length} 个子（已用蓝圈标出），是${esc(whose)}的棋：${groupState(s, g.libs)}</p><p>${groupAdvice(mine, s)}</p>
      <p class="note">判断依据：从当前局面模拟几百盘，这些棋子最后留在棋盘上的比例。</p>`);
    return;
  }
  const label = `下在 ${b.name(p)} 怎么样？`;
  const c = b.toPlay;
  if (b.b[p] !== EMPTY) { askShow(label, '<p>这里已经有棋子了。请点一个空点。</p>'); Q.pick = 'point'; syncAskChips(); return; }
  if (!b.isLegal(p, c)) {
    askShow(label, `<p>${p === b.ko ? '不能下：这是刚被提的劫，需要先在别处下一手（找劫材）才能提回。' : '不能下：这是禁着点——下进去自己没有气，也提不掉对方的子。'}</p>`);
    return;
  }
  askShow(label, '<p>正在试下这一手，大约需要几秒…</p>');
  const a = await ctx0.getA();
  if (!alive() || !a) return;
  const after = b.copy();
  after.play(p);
  const B = await pool.analyze(after, ctx0.budget, ctx0.komi);
  if (!alive()) return;
  if (!B) { askShow(label, '<p>分析被打断了，请再问一次。</p>'); return; }
  const top = a.cands[0];
  const wrMove = 1 - B.wr, wrBest = top ? Math.max(top.wr, wrMove) : wrMove;
  const isBest = top && top.move === p;
  const q = quality(isBest ? 0 : wrBest - wrMove, isBest);
  Q.mark = [p];
  drawBoard();
  const reasons = G.explain(b, p, c, a.own, B.own, colorName(c), colorName(3 - c));
  askShow(label, `<p>评价：<span class="tag ${q.cls}">${q.label}</span>　下在这里之后${colorName(c)}的胜率约 ${pct(wrMove)}${isBest ? '' : `（最好的 ${esc(b.name(top.move))} 约 ${pct(top.wr)}）`}。</p>${reasonsHtml(reasons)}
    <p class="note">这只是试下，棋盘没有变化。</p>`);
}

function askText(text) {
  const t = text.trim();
  if (!t) return;
  $('askInput').value = '';
  const has = (...ws) => ws.some(w => t.includes(w));
  if (has('谁领先', '形势', '谁赢', '领先', '胜率多少', '优势')) return ask('lead', t);
  if (has('下哪', '怎么下', '下一手', '推荐', '走哪')) return ask('best', t);
  if (has('危险', '最弱', '弱棋', '要补')) return ask('weak', t);
  if (has('这块', '这片', '活不活', '死了吗', '能活')) return ask('group', t);
  if (has('这里下', '下这里', '这一手', '这手怎么样')) return ask('point', t);
  const faq = window.FAQ || [];
  const lower = t.toLowerCase();
  // 单个字的关键词（如“气”“眼”“劫”）只在问的就是这个词时才算，避免“天气”之类误配
  const hit = k => {
    k = k.toLowerCase();
    if (!lower.includes(k)) return false;
    if (k.length > 1) return true;
    const core = lower.replace(/[？?。！!，,\s]|什么是|是什么|什么叫|怎么|吗|呢|的|请问/g, '');
    return core === k || core.length <= 2;
  };
  const scored = faq.map(f => ({ f, s: f.keys.reduce((n, k) => n + (hit(k) ? k.length * k.length : 0), 0) }))
    .filter(x => x.s > 0).sort((x, y) => y.s - x.s);
  if (!scored.length) {
    askShow(t, `<p>抱歉，这个问题我答不上来。我内置的是一个下棋引擎和一本围棋小词典，不能像聊天机器人那样理解任意问题。</p>
      <p>你可以问：关于当前局面的问题（点上面的按钮），或者围棋知识，例如：${faq.slice(0, 8).map(f => esc(f.q)).join('、')}……</p>`);
    return;
  }
  const best = scored[0].f, more = scored.slice(1, 3).filter(x => x.s >= scored[0].s / 2);
  askShow(t, `<p><b>${esc(best.q)}</b></p><p>${esc(best.a)}</p>${more.length ? `<p class="note">相关问题：${more.map(x => `<a href="#" data-faq="${faq.indexOf(x.f)}">${esc(x.f.q)}</a>`).join('、')}</p>` : ''}`);
}

$('btnAsk').addEventListener('click', () => openAsk(!Q.open));
$('btnAsk2').addEventListener('click', () => openAsk(!Q.open));
$('btnAskClose').addEventListener('click', () => openAsk(false));
$('askPanel').addEventListener('click', e => {
  const b = e.target.closest('[data-ask]');
  if (b) { e.preventDefault(); ask(b.dataset.ask, b.textContent); return; }
  const f = e.target.closest('[data-faq]');
  if (f) {
    e.preventDefault();
    const item = window.FAQ[+f.dataset.faq];
    askShow(item.q, `<p>${esc(item.a)}</p>`);
  }
});
$('askForm').addEventListener('submit', e => { e.preventDefault(); askText($('askInput').value); });

// ---------------- 对话框与提示 ----------------

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function showMessage(title, text, withNewGame, buttons) {
  const dlg = $('dlgMsg');
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  const menu = $('msgMenu');
  menu.innerHTML = '';
  const btns = buttons || (withNewGame
    ? [{ label: '回看这盘棋', fn: () => enterReview() }, { label: '再来一局', primary: true, fn: openNewGame }]
    : [{ label: '好', primary: true }]);
  for (const bt of btns) {
    const el = document.createElement('button');
    el.textContent = bt.label;
    el.value = bt.label;
    if (bt.primary) el.className = 'primary';
    el.addEventListener('click', () => { if (bt.fn) setTimeout(bt.fn, 0); });
    menu.appendChild(el);
  }
  if (dlg.open) dlg.close();
  dlg.showModal();
}

const dlgNew = $('dlgNew'), fNew = dlgNew.querySelector('form');

function fillHandicap(size, value) {
  const max = size === 9 ? 5 : 9;
  fNew.handicap.innerHTML = '<option value="0">不让子</option>' +
    Array.from({ length: max - 1 }, (_, i) => `<option value="${i + 2}">让 ${i + 2} 子</option>`).join('');
  const v = Math.min(value, max);
  fNew.handicap.value = String(v >= 2 ? v : 0);
}

function showTarget() {
  const t = +fNew.target.value;
  $('targetText').textContent = t >= 100 ? '全力' : `AI≈${t}%`;
}

function openNewGame() {
  if (S.mode !== 'play') setMode('play');
  fNew.rule.value = captureRule() ? `capture${S.game.captureN}` : 'normal';
  fNew.opp.value = S.game.opp === 'human' ? 'human' : 'ai';
  fNew.size.value = String(S.game.size);
  fNew.human.value = String(S.game.human);
  fillHandicap(S.game.size, S.game.handicap);
  fNew.komi.value = S.game.komiAuto === false ? String(S.game.komi) : 'auto';
  fNew.level.value = String(S.prefs.level);
  fNew.engine.value = S.prefs.engine || 'b10';
  showEngineStatus();
  fNew.target.value = String(S.prefs.target);
  showTarget();
  dlgNew.returnValue = '';
  dlgNew.showModal();
}

fNew.level.innerHTML = LEVELS.map((l, i) => `<option value="${i}">${l.name}${l.note ? `（${l.note}）` : ''}</option>`).join('');
fNew.engine.innerHTML = Object.entries(ENGINES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
function showEngineStatus() { const el = $('engineStatus'); if (el) el.textContent = nn.status(); }

fNew.size.addEventListener('change', () => fillHandicap(+fNew.size.value, +fNew.handicap.value));
fNew.target.addEventListener('input', showTarget);
$('versionText').textContent = `版本 ${APP_VERSION}`;

dlgNew.addEventListener('close', () => {
  const rv = dlgNew.returnValue;
  if (rv !== 'ok' && rv !== 'apply') return;
  S.prefs.level = +fNew.level.value;
  S.prefs.target = +fNew.target.value;
  S.prefs.engine = fNew.engine.value;
  const engineChanged = nn.model !== S.prefs.engine;
  if (engineChanged) { cancelWork(); nn.start(S.prefs.engine); }
  if (rv === 'apply') {
    save();
    render();
    toast('AI 设置已更新，从下一手开始生效');
    if (engineChanged && S.mode === 'play') advance();
    return;
  }
  const rule = fNew.rule.value;
  const handicap = rule === 'normal' ? +fNew.handicap.value : 0, auto = fNew.komi.value === 'auto';
  newGame({
    opp: fNew.opp.value === 'human' ? 'human' : 'ai',
    rule: rule === 'normal' ? 'normal' : 'capture',
    captureN: rule === 'normal' ? 1 : +rule.slice(7),
    size: +fNew.size.value, human: +fNew.human.value, handicap,
    komi: auto ? (handicap >= 2 ? 0.5 : 7.5) : +fNew.komi.value,
    komiAuto: auto,
  });
});

$('dlgWelcome').addEventListener('close', () => {
  const rv = $('dlgWelcome').returnValue;
  if (rv === 'learn') { T.cat = 'learn'; setMode('study'); selectGame(0); }
  else if (rv === 'practice') { setMode('practice'); practiceGo(0); }
  else setMode('play');
});

// ---------------- 下拉列表 ----------------

function fillGameSelect() {
  // 我的对局放在列表最后（每次重建，最新的在前）
  while (GAMES.length && GAMES[GAMES.length - 1].kind === 'mine') GAMES.pop();
  for (const r of RECORDS) GAMES.push(recordToGame(r));
  if (T.gi >= GAMES.length) T.gi = 0;
  const groups = [];
  GAMES.forEach((g, i) => {
    if (catOf(g) !== T.cat) return;
    const label = g.kind === 'yi' ? `《弈》第 ${g.stage} 阶段 · ${g.stageTitle}` : g.kind === 'lesson' ? `动画演示课 · ${g.chapter}` : g.group;
    let grp = groups.find(x => x.label === label);
    if (!grp) groups.push(grp = { label, items: [] });
    const text = g.kind === 'yi'
      ? `第 ${g.num} 课 ${g.title}${S.done.lessons[g.id] ? '（已学）' : ''}`
      : g.kind === 'lesson'
      ? `${g.title}${S.done.lessons[g.id] ? '（已学）' : ''}`
      : g.kind === 'mine' ? `${g.title}（${gameMoves(g).length} 手）`
      : `${g.title}（${g.year}${g.result ? '，' + g.result : ''}，${gameMoves(g).length} 手）`;
    grp.items.push(`<option value="${i}">${esc(text)}</option>`);
  });
  if (T.cat === 'games' && !RECORDS.length) groups.push({ label: '我的对局', items: ['<option disabled>还没有下完的对局（下完一盘就会出现在这里）</option>'] });
  $('selGame').innerHTML = groups.map(g => `<optgroup label="${esc(g.label)}">${g.items.join('')}</optgroup>`).join('');
  $('selGame').value = String(T.gi);
}

function fillProblemSelect() {
  const byLevel = {};
  PROBLEMS.forEach((q, i) => {
    (byLevel[q.level] = byLevel[q.level] || []).push(`<option value="${i}">${i + 1}. ${esc(q.title)}${S.done.problems[q.id] ? '（已完成）' : ''}</option>`);
  });
  $('selProblem').innerHTML = Object.keys(byLevel).map(l => `<optgroup label="${esc(LEVEL_NAMES[l])}">${byLevel[l].join('')}</optgroup>`).join('');
  $('selProblem').value = String(P.i);
}

// ---------------- 绑定 ----------------

$('tabPlay').addEventListener('click', () => setMode('play'));
$('tabStudy').addEventListener('click', () => setStudyCat('learn'));
$('tabGames').addEventListener('click', () => setStudyCat('games'));
$('tabPractice').addEventListener('click', () => setMode('practice'));
$('btnNew').addEventListener('click', openNewGame);
$('btnUndo').addEventListener('click', undo);
$('btnPass').addEventListener('click', humanPass);
$('btnHint').addEventListener('click', () => {
  // 再点一次收起提示
  if (S.hint && !S.hint.loading) { S.hint = null; Q.mark = null; render(); return; }
  showHint();
});
$('btnResign').addEventListener('click', resign);
$('btnOwn').addEventListener('click', () => { S.prefs.own = !S.prefs.own; save(); render(); });
$('btnReview').addEventListener('click', () => enterReview());
$('btnRvPrev').addEventListener('click', () => reviewStep(-1));
$('btnRvNext').addEventListener('click', () => reviewStep(1));
$('btnRvClear').addEventListener('click', () => { S.tries = []; S.tryNote = null; render(); });
$('btnRvBack').addEventListener('click', () => { exitReview(); render(); advance(); });
$('btnHelp').addEventListener('click', () => $('dlgHelp').showModal());
$('btnSync').addEventListener('click', openSync);
$('btnSyncNow').addEventListener('click', syncFromDialog);
$('btnUser').addEventListener('click', openUsers);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.sync.on) syncNow(true); });

function bindPref(id, key, after) {
  $(id).addEventListener('change', e => {
    S.prefs[key] = e.target.checked;
    if (after) after();
    save();
    render();
  });
}
bindPref('chkCoach', 'coach', () => {
  if (S.prefs.coach && !captureRule()) S.analyses.forEach((a, k) => a && makeComment(k));
});
bindPref('chkCands', 'cands');
bindPref('chkMarks', 'marks');
bindPref('chkConfirm', 'confirm', () => { S.pendingTap = NONE; });
bindPref('chkHelper', 'helper', () => { S.pendingTap = NONE; });

$('coach').addEventListener('click', e => {
  const opt = e.target.closest('[data-opt]');
  if (opt) { yiAnswer(+opt.dataset.opt === yiEx().correct); return; }
  const yb = e.target.closest('[data-yi]');
  if (yb) {
    const a = yb.dataset.yi;
    if (a === 'prev') yiSelect(YI.ex - 1);
    else if (a === 'next') yiSelect(YI.ex + 1);
    else if (a === 'reset') { YI.pos = 0; delete YI.fb[yiEx().id]; yiSetBoard(); }
    else if (a === 'numbers') YI.numbers = !YI.numbers;
    render();
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) { stopAuto(); studyGo(+go.dataset.go); return; }
  if (e.target.closest('[data-sumai]')) {
    openAsk(true);
    const q = pvp() ? '请结合【本局总结】讲讲这盘棋胜负的原因，双方下次各要注意什么。' : '请结合【本局总结】讲讲我这盘棋为什么赢或者为什么输，下次要注意什么。';
    anyLLM().then(ok => {
      if (ok) askLLM(q);
      else askShow('这盘棋为什么这样结束？', `${S.summary ? S.summary.html : ''}<p class="note">现在没有可用的大模型，上面是本机引擎的分析。联网或回到家里时，可以让 AI 老师用大白话再讲一遍。</p>`, '回答来自：本机围棋引擎');
    });
    return;
  }
  const gb = e.target.closest('[data-gain]');
  if (gb) {
    e.stopPropagation();
    const cm = S.comments[+gb.dataset.gain], b = S.board;
    Q.mark = null;
    Q.area = (cm.gain || []).map(n => nameToPt(b, n)).filter(p => p >= 0);
    toast(`棋盘上的蓝色方块：这手棋之后更可能变成${cm.you ? '你' : ' AI '}地盘的 ${Q.area.length} 个点`);
    drawBoard();
    return;
  }
  const rec = e.target.closest('[data-rec]');
  if (rec) { if (rec.dataset.rec === 'export') exportRecords(); else $('fileImport').click(); return; }
  const les = e.target.closest('[data-lesson]');
  if (les) { selectGame(+les.dataset.lesson); return; }
  const el = e.target.closest('[data-j]');
  if (el && S.mode === 'play') {
    const j = +el.dataset.j;
    if (S.view === j) { exitReview(); render(); } else enterReview(j);
  }
});

$('selGame').addEventListener('change', e => selectGame(+e.target.value));
$('btnLsPrev').addEventListener('click', () => { if (T.gi > 0) selectGame(T.gi - 1); });
$('btnLsNext').addEventListener('click', () => { if (GAMES[T.gi + 1]) selectGame(T.gi + 1); });
$('coach').addEventListener('submit', e => {
  if (!e.target.matches('[data-num]')) return;
  e.preventDefault();
  const v = $('yiNum').value.trim();
  YI.input = v;
  if (v === '') return;
  yiAnswer(yiEx().answers.map(Number).includes(Number(v)));
});
$('btnFirst').addEventListener('click', () => { stopAuto(); studyGo(0); });
$('btnPrev').addEventListener('click', () => { stopAuto(); studyGo(T.idx - 1); });
$('btnNext').addEventListener('click', () => studyGo(T.idx + 1));
$('btnLast').addEventListener('click', () => { stopAuto(); studyGo(gameMoves(sg()).length); });
$('btnAuto').addEventListener('click', toggleAuto);
$('btnGuess').addEventListener('click', () => {
  T.guess = !T.guess;
  toast(T.guess ? '猜棋：在棋盘上点你认为的下一手' : '已关闭猜棋');
  render();
});
$('rngMove').addEventListener('input', e => { T.idx = +e.target.value; render(); });
$('rngMove').addEventListener('change', e => { stopAuto(); studyGo(+e.target.value); });

$('selProblem').addEventListener('change', e => practiceGo(+e.target.value));
$('btnPbPrev').addEventListener('click', () => practiceGo(P.i - 1));
$('btnPbNext').addEventListener('click', () => practiceGo(P.i + 1));
$('btnPbRetry').addEventListener('click', practiceStart);
$('btnPbTip').addEventListener('click', () => { P.showTip = true; render(); });
$('btnPbAnswer').addEventListener('click', practiceAnswer);

addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || e.target.tagName === 'INPUT') return;
  if (S.mode === 'study') {
    if (e.key === 'ArrowRight') studyGo(T.idx + 1);
    else if (e.key === 'ArrowLeft') { stopAuto(); studyGo(T.idx - 1); }
  } else if (S.mode === 'play' && S.view !== null) {
    if (e.key === 'ArrowRight') reviewStep(1);
    else if (e.key === 'ArrowLeft') reviewStep(-1);
  }
});

let resizeTimer = 0;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });

// ---------------- 离线与更新 ----------------

if ('serviceWorker' in navigator && !/WeiqiApp/.test(navigator.userAgent) && location.protocol === 'https:') {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('updateBar').hidden = false;
    hadController = true;
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}
$('btnReload').addEventListener('click', () => location.reload());

// ---------------- 白天 / 夜晚 ----------------
function isDark() { return document.documentElement.dataset.theme === 'dark'; }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = t === 'dark' ? '#1b1814' : '#f4ebdd';
}
applyTheme(isDark() ? 'dark' : 'light');
$('btnTheme').addEventListener('click', () => {
  const t = isDark() ? 'light' : 'dark';
  applyTheme(t);
  try { localStorage.setItem('weiqi-theme', t); } catch (e) { /* 忽略 */ }
  render();
  toast(t === 'dark' ? '夜晚模式' : '白天模式');
});
$('fileImport').addEventListener('change', e => { if (e.target.files[0]) importRecords(e.target.files[0]); e.target.value = ''; });

// ---------------- 启动 ----------------

loadRecords();
const firstRun = load();
nn.start(S.prefs.engine || 'b10');
fillGameSelect();
fillProblemSelect();
if (S.mode === 'practice') practiceStart();
layout();
render();
if (S.mode === 'study' && sg().kind === 'yi') { yiSelect(0); render(); }
if (S.mode === 'study') studyGo(T.idx);
else if (S.mode === 'play') {
  if (!S.result && !captureRule() && S.board.passes >= 2) startScoring();
  else advance();
}
if (firstRun) $('dlgWelcome').showModal();
else if (S.sync.on) setTimeout(() => syncNow(true), 1500);
