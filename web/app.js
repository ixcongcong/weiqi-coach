'use strict';
/* 围棋对战教练：界面、对局流程、讲解。引擎在 engine.js，计算在 Web Worker 里进行。 */

const G = window.Go;
const { EMPTY, BLACK, WHITE, PASS, NONE, RESIGN } = G;

const LEVELS = [
  { name: '入门', playouts: 300, ms: 1000, random: true },
  { name: '初级', playouts: 1500, ms: 2000 },
  { name: '中级', playouts: 6000, ms: 4000 },
  { name: '高级', playouts: 20000, ms: 8000 },
  { name: '大师', playouts: 60000, ms: 15000 },
];
// 每个局面的分析量（用于讲解、胜率、形势判断）
const BUDGET = {
  9: { playouts: 8000, ms: 2500, own: 400 },
  13: { playouts: 5000, ms: 3000, own: 300 },
  19: { playouts: 4000, ms: 3500, own: 240 },
};
const FINAL_OWN = { 9: 1200, 13: 900, 19: 600 };
const STORE_KEY = 'weiqi-coach-v1';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => Math.round(v * 100) + '%';
const colorName = c => (c === BLACK ? '黑' : '白');
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

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
  game: { size: 9, human: BLACK, handicap: 0, komi: 7.5 },
  prefs: { level: 2, target: 100, coach: true, confirm: false, cands: false, own: false },
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
  view: null,
  gen: 0,
  ghost: NONE,
  pendingTap: NONE,
};

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
    localStorage.setItem(STORE_KEY, JSON.stringify({
      game: S.game, prefs: S.prefs, setup: S.setup, history: S.history,
      result: S.scoring ? null : S.result, comments: S.comments,
    }));
  } catch (e) { /* 存储不可用时忽略 */ }
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d) {
      Object.assign(S.game, d.game);
      Object.assign(S.prefs, d.prefs);
      S.setup = d.setup || [];
      S.history = d.history || [];
      S.result = d.result || null;
      S.comments = d.comments || {};
    }
  } catch (e) { /* 数据损坏时从新局开始 */ }
  rebuild();
}

function cancelWork() {
  S.gen++;
  pool.cancel();
  S.aiThinking = false;
  S.scoringBusy = false;
  S.aprom = S.aprom.map((p, k) => (S.analyses[k] ? p : undefined));
}

function truncate(len) {
  S.analyses.length = Math.min(S.analyses.length, len + 1);
  S.aprom.length = Math.min(S.aprom.length, len + 1);
  for (const j of Object.keys(S.comments)) if (+j >= len) delete S.comments[j];
}

function canHumanMove() {
  return !S.result && !S.scoring && !S.scoringBusy && S.view === null &&
    S.board.toPlay === S.game.human && !S.aiThinking;
}

// ---------------- 分析与对局流程 ----------------

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
  while (gen === S.gen && !S.result && !S.scoring && !S.scoringBusy) {
    const k = S.history.length;
    const a = await getAnalysis(k);
    if (gen !== S.gen || !a) return;
    if (S.history.length !== k) continue;
    if (S.board.toPlay === S.game.human) return;
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
  const minV = Math.max(10, top.visits * 0.03);
  let best = top, bd = Infinity;
  for (const c of a.cands) {
    if (c.visits < minV) continue;
    const d = Math.abs(c.wr - target);
    if (d < bd) { bd = d; best = c; }
  }
  return best.move;
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
  if (move === undefined && late && a.playouts >= 300 && a.wr < (target ? 0.03 : 0.06)) move = RESIGN;
  if (move === undefined && late && settled(pos, a.own)) move = PASS;
  if (move === undefined) {
    if (target) {
      move = pickTarget(a, target);
    } else {
      const lv = LEVELS[S.prefs.level];
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
    S.result = { text: 'AI 认输，你赢了！🎉', winner: S.game.human };
    save();
    render();
    showMessage('对局结束', 'AI 认输，你赢了！🎉', true);
    return;
  }
  if (move === PASS) toast('AI 停一手');
  playMove(move, true);
}

function playMove(m, internal) {
  if (!S.board.play(m)) return false;
  S.history.push(m);
  S.hint = null;
  S.pendingTap = NONE;
  save();
  if (S.board.passes >= 2) startScoring();
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
  render();
  const won = S.scoring.winner() === S.game.human;
  showMessage('对局结束', `${scoreText()}\n\n${won ? '你赢了！🎉' : 'AI 获胜'}\n\n如果死活判断有误，可以点棋盘上的棋子切换死活。`, true);
}

function scoreText() {
  const sc = S.scoring;
  const d = sc.diff();
  return `黑 ${sc.black} 子，白 ${sc.white} 子（贴 ${S.game.komi}）\n${d > 0 ? '黑' : '白'}胜 ${Math.abs(d)} 子`;
}

// ---------------- 讲解 ----------------

function quality(delta, isBest) {
  if (isBest) return { cls: 'best', label: '最佳 ✨' };
  if (delta < 0.03) return { cls: 'good', label: '好棋 👍' };
  if (delta < 0.08) return { cls: 'ok', label: '可以 🙂' };
  if (delta < 0.15) return { cls: 'slow', label: '缓手 ⚠️' };
  return { cls: 'bad', label: '恶手 ❌' };
}

async function makeComment(j) {
  const A = S.analyses[j], B = S.analyses[j + 1];
  if (!A || !B || S.comments[j] || j >= S.history.length) return;
  const pre = boardAt(j), m = S.history[j], c = pre.toPlay;
  const you = c === S.game.human, me = you ? '你' : 'AI', op = you ? 'AI' : '你';
  const top = A.cands[0];
  let wrMove = 1 - B.wr;
  const cand = A.cands.find(x => x.move === m);
  if (cand && top && cand.visits >= 0.15 * top.visits) wrMove = cand.wr;
  const isBest = !!top && top.move === m;
  const wrBest = top ? Math.max(top.wr, wrMove) : wrMove;
  const delta = isBest ? 0 : Math.max(0, wrBest - wrMove);
  const cm = {
    j, color: c, you, move: m, name: pre.name(m), q: quality(delta, isBest),
    wrBefore: wrBest, wrAfter: wrMove,
    reasons: G.explain(pre, m, c, A.own, B.own, me, op),
    best: null, isBest,
    eased: !you && S.prefs.target < 100 && !isBest && delta >= 0.05,
    wrNext: B.wr,
  };
  if (you && top && !isBest && delta >= 0.03) {
    cm.best = { move: top.move, name: pre.name(top.move), wr: top.wr, reasons: null };
  }
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

async function showHint() {
  if (!canHumanMove()) return;
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
    reasons: G.explain(pre, top.move, pre.toPlay, a.own, o.own, '你', 'AI'),
    others: a.cands.slice(1, 3).map(c => ({ name: pre.name(c.move), wr: c.wr })),
  };
  render();
}

// ---------------- 操作 ----------------

function newGame(opts) {
  cancelWork();
  Object.assign(S.game, opts);
  S.setup = G.handicapPoints(S.game.size, S.game.handicap);
  S.history = [];
  S.result = null;
  S.comments = {};
  S.analyses = [];
  S.aprom = [];
  S.scoring = null;
  S.hint = null;
  S.view = null;
  rebuild();
  save();
  layout();
  render();
  advance();
}

function undo() {
  if (!S.history.length) return;
  cancelWork();
  S.result = null;
  S.scoring = null;
  S.hint = null;
  S.view = null;
  do {
    S.history.pop();
    rebuild();
  } while (S.history.length && S.board.toPlay !== S.game.human);
  truncate(S.history.length);
  save();
  render();
  advance();
}

function humanPass() {
  if (!canHumanMove()) return;
  toast('你停了一手');
  playMove(PASS);
}

function resign() {
  if (S.result || S.scoring) return;
  showMessage('认输', '确定要认输吗？', false, [
    { label: '取消' },
    {
      label: '认输', primary: true, fn: () => {
        cancelWork();
        S.result = { text: '你认输了，AI 获胜', winner: 3 - S.game.human };
        save();
        render();
      },
    },
  ]);
}

function onBoardTap(p) {
  if (p === NONE || S.view !== null) return;
  if (S.scoring) {
    if (S.scoring.toggle(p)) render();
    return;
  }
  if (!canHumanMove()) return;
  if (!S.board.isLegal(p, S.game.human)) {
    if (S.board.b[p] === EMPTY) toast(p === S.board.ko ? '打劫：需要先在别处走一手，才能提回' : '这里不能落子（禁着点）');
    return;
  }
  if (S.prefs.confirm && S.pendingTap !== p) {
    S.pendingTap = p;
    drawBoard();
    return;
  }
  playMove(p);
}

function openReview(j) {
  if (j >= S.history.length) return;
  S.view = S.view === j ? null : j;
  if (S.view !== null && !S.analyses[j]) getAnalysis(j);
  render();
}

// ---------------- 绘制棋盘 ----------------

const canvas = $('board'), ctx = canvas.getContext('2d');
let geom = { cell: 0, org: 0, px: 0 };

function layout() {
  const wrap = $('boardWrap');
  const landscape = innerWidth >= innerHeight;
  let size;
  if (landscape) {
    size = Math.min(wrap.clientWidth - 16, wrap.clientHeight - 16);
  } else {
    size = Math.min(innerWidth - 16, innerHeight * 0.56);
  }
  size = Math.max(200, Math.floor(size));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = canvas.style.height = size + 'px';
  canvas.width = canvas.height = Math.round(size * dpr);
  geom.px = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBoard();
  drawGraph();
}

function latestAnalysis(k) {
  for (let i = k; i >= 0; i--) if (S.analyses[i]) return { a: S.analyses[i], k: i };
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

function drawBoard() {
  const s = geom.px;
  if (!s) return;
  const viewing = S.view !== null;
  const b = viewing ? boardAt(S.view) : S.board;
  const n = b.n, cell = s / (n + 0.8), org = cell * 0.9, end = org + (n - 1) * cell;
  geom.cell = cell; geom.org = org;
  const X = p => org + b.x(p) * cell, Y = p => org + b.y(p) * cell;

  const bg = ctx.createLinearGradient(0, 0, s, s);
  bg.addColorStop(0, '#e9c27c'); bg.addColorStop(1, '#d6a65b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = '#3b2a14';
  ctx.lineWidth = Math.max(1, cell * 0.035);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const v = org + i * cell;
    ctx.moveTo(org, v); ctx.lineTo(end, v);
    ctx.moveTo(v, org); ctx.lineTo(v, end);
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
    const v = org + i * cell;
    ctx.fillText(G.LETTERS[i], v, org - cell * 0.55);
    ctx.fillText(String(n - i), org - cell * 0.6, v);
  }

  const r = cell * 0.47;
  const k = viewing ? S.view : S.history.length;

  // 形势（归属）覆盖层
  if (S.prefs.own && !S.scoring) {
    const la = latestAnalysis(k);
    if (la) {
      for (let p = 0; p < b.size; p++) {
        if (b.b[p] === G.BORDER) continue;
        const v = la.a.own[p];
        if (Math.abs(v) < 0.2) continue;
        const h = cell * 0.42 * Math.min(1, Math.abs(v));
        ctx.fillStyle = v > 0 ? `rgba(0,0,0,${0.15 + 0.35 * Math.abs(v)})` : `rgba(255,255,255,${0.25 + 0.5 * Math.abs(v)})`;
        ctx.fillRect(X(p) - h / 2, Y(p) - h / 2, h, h);
      }
    }
  }

  // 预览落子
  const ghost = S.pendingTap !== NONE ? S.pendingTap : S.ghost;
  if (!viewing && ghost >= 0 && b.b[ghost] === EMPTY && canHumanMove()) {
    ctx.strokeStyle = 'rgba(21,101,192,.45)';
    ctx.lineWidth = Math.max(2, cell * 0.06);
    ctx.beginPath();
    ctx.moveTo(org, Y(ghost)); ctx.lineTo(end, Y(ghost));
    ctx.moveTo(X(ghost), org); ctx.lineTo(X(ghost), end);
    ctx.stroke();
    drawStone(X(ghost), Y(ghost), r, S.game.human, S.pendingTap === ghost ? 0.8 : 0.5);
  }

  for (let p = 0; p < b.size; p++) {
    const v = b.b[p];
    if (v !== BLACK && v !== WHITE) continue;
    const dead = S.scoring && !viewing && S.scoring.dead[p];
    drawStone(X(p), Y(p), r, v, dead ? 0.35 : 1);
  }

  if (S.scoring && !viewing) {
    const h = cell * 0.16;
    for (let p = 0; p < b.size; p++) {
      const t = S.scoring.terr[p];
      if (!t) continue;
      ctx.fillStyle = t === BLACK ? '#111' : '#fafafa';
      ctx.fillRect(X(p) - h, Y(p) - h, 2 * h, 2 * h);
      if (t === WHITE) { ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.strokeRect(X(p) - h, Y(p) - h, 2 * h, 2 * h); }
    }
  }

  // 候选点
  let cands = null;
  if (viewing) {
    const A = S.analyses[S.view];
    if (A) cands = A.cands.slice(0, 3);
  } else if ((S.prefs.cands || (S.hint && !S.hint.loading)) && canHumanMove() && S.analyses[k]) {
    cands = S.analyses[k].cands.slice(0, 3);
  }
  if (cands) {
    const cols = ['#2e7d32', '#1565c0', '#6a1b9a'];
    cands.forEach((c, i) => {
      if (c.move < 0 || b.b[c.move] !== EMPTY) return;
      const humanWr = b.toPlay === S.game.human ? c.wr : 1 - c.wr;
      ctx.fillStyle = cols[i] + 'cc';
      ctx.beginPath(); ctx.arc(X(c.move), Y(c.move), r * 0.92, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(cell * 0.3)}px -apple-system, sans-serif`;
      ctx.fillText(String(Math.round(humanWr * 100)), X(c.move), Y(c.move) + 1);
    });
  }

  if (viewing) {
    const m = S.history[S.view];
    if (m >= 0) {
      drawStone(X(m), Y(m), r, b.toPlay, 0.55);
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = Math.max(2, r * 0.18);
      ctx.beginPath(); ctx.arc(X(m), Y(m), r * 0.95, 0, Math.PI * 2); ctx.stroke();
    }
  } else if (b.lastMove >= 0 && !S.scoring) {
    ctx.fillStyle = '#e53935';
    ctx.beginPath(); ctx.arc(X(b.lastMove), Y(b.lastMove), r * 0.28, 0, Math.PI * 2); ctx.fill();
  }
}

function toPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const n = S.board.n;
  const gx = Math.round((x - geom.org) / geom.cell), gy = Math.round((y - geom.org) / geom.cell);
  if (gx < 0 || gy < 0 || gx >= n || gy >= n) return NONE;
  return S.board.pt(gx, gy);
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

// ---------------- 胜率曲线 ----------------

function humanWrAt(k) {
  const a = S.analyses[k];
  if (!a) return null;
  return a.toPlay === S.game.human ? a.wr : 1 - a.wr;
}

function drawGraph() {
  const cv = $('graph'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#cfc2ae'; g.setLineDash([4, 4]); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  g.setLineDash([]);
  const len = S.history.length, span = Math.max(len, 10);
  const pts = [];
  for (let k = 0; k <= len; k++) {
    const v = humanWrAt(k);
    if (v !== null) pts.push([k / span * (w - 4) + 2, (1 - v) * (h - 4) + 2]);
  }
  if (pts.length >= 2) {
    g.fillStyle = 'rgba(160,82,26,.15)';
    g.beginPath(); g.moveTo(pts[0][0], h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(pts[pts.length - 1][0], h); g.closePath(); g.fill();
    g.strokeStyle = '#a0521a'; g.lineWidth = 2;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }
  if (S.view !== null) {
    const x = S.view / span * (w - 4) + 2;
    g.strokeStyle = '#1565c0'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  g.fillStyle = '#7a6446'; g.font = '11px -apple-system, sans-serif';
  g.fillText('你的胜率', 4, 12);
}

// ---------------- 侧栏 ----------------

function statusText() {
  if (S.view !== null) return `复盘：第 ${S.view + 1} 手`;
  if (S.scoringBusy) return '正在数子…';
  if (S.scoring) return '终局 · 点棋子可切换死活\n' + scoreText();
  if (S.result) return S.result.text;
  if (S.board.toPlay !== S.game.human) return `AI（${S.prefs.target < 100 ? '让棋模式' : LEVELS[S.prefs.level].name}）思考中…`;
  let s = `轮到你落子（执${colorName(S.game.human)}）`;
  if (S.board.lastMove === PASS && S.board.moveCount > 0) s += ' · AI 停了一手';
  return s;
}

function reasonsHtml(list) {
  if (!list) return '<ul><li>正在分析…</li></ul>';
  return '<ul>' + list.map(r => `<li>${esc(r)}</li>`).join('') + '</ul>';
}

function commentHtml(c) {
  const num = `第 ${c.j + 1} 手`;
  if (c.you) {
    let h = `<div class="cm ${c.q.cls}${S.view === c.j ? ' viewing' : ''}" data-j="${c.j}">
      <div class="h"><b>${num}</b> 你下 ${esc(c.name)} <span class="tag ${c.q.cls}">${c.q.label}</span>
      <span class="wr">胜率 ${pct(c.wrBefore)} → ${pct(c.wrAfter)}</span></div>${reasonsHtml(c.reasons)}`;
    if (c.best) {
      h += `<div class="better">更好的是 <b>${esc(c.best.name)}</b>（胜率约 ${pct(c.best.wr)}）${reasonsHtml(c.best.reasons)}</div>`;
    }
    return h + '</div>';
  }
  const yourWr = c.wrNext !== undefined ? c.wrNext : 1 - c.wrAfter;
  return `<div class="cm ai${S.view === c.j ? ' viewing' : ''}" data-j="${c.j}">
    <div class="h"><b>${num}</b> AI 下 ${esc(c.name)}${c.eased ? ' <span class="note">（让棋）</span>' : ''}
    <span class="wr">你的胜率 ${pct(yourWr)}</span></div>${reasonsHtml(c.reasons)}</div>`;
}

function renderCoach() {
  const box = $('coach');
  let html = '';
  if (S.hint) {
    if (S.hint.loading) html += '<div class="cm hint"><b>提示</b> 正在计算…</div>';
    else {
      html += `<div class="cm hint"><div class="h"><b>提示</b> 推荐 <b>${esc(S.hint.name)}</b>
        <span class="wr">胜率约 ${pct(S.hint.wr)}</span></div>${reasonsHtml(S.hint.reasons)}
        ${S.hint.others.length ? `<div class="note">其他候选：${S.hint.others.map(o => `${esc(o.name)}（${pct(o.wr)}）`).join('，')}；棋盘上的数字是走那里之后你的胜率。</div>` : ''}</div>`;
    }
  }
  if (!S.prefs.coach) {
    html += '<div class="empty">讲解已关闭。打开“讲解每一手”就能看到每步棋的点评。</div>';
  } else {
    const keys = Object.keys(S.comments).map(Number).sort((a, b) => b - a);
    if (!keys.length) {
      html += '<div class="empty">下棋后，这里会逐手点评：<br>这步棋好不好、为什么，以及更好的下法。<br>点一条点评可以回看当时的局面。</div>';
    }
    for (const j of keys) html += commentHtml(S.comments[j]);
  }
  box.innerHTML = html;
}

function render() {
  const g = S.game, b = S.board;
  $('meta').textContent = `${g.size}路 · 你执${colorName(g.human)}${g.handicap >= 2 ? ` · 让${g.handicap}子` : ''} · 贴目 ${g.komi} · 第 ${b.moveCount} 手 · 提子 黑${b.capB} 白${b.capW}`;
  let st = statusText();
  if (S.prefs.own && !S.scoring && S.view === null) {
    const la = latestAnalysis(S.history.length);
    if (la) {
      const sc = la.a.score;
      st += `\n形势判断：${sc > 0 ? '黑' : '白'}领先约 ${Math.abs(sc).toFixed(1)} 子`;
    }
  }
  $('status').textContent = st;

  const la = latestAnalysis(S.history.length);
  const hw = la ? humanWrAt(la.k) : 0.5;
  $('wrYou').style.width = pct(hw);
  $('wrYouLabel').textContent = `你 ${pct(hw)}`;
  $('wrAiLabel').textContent = `AI ${pct(1 - hw)}`;

  const my = canHumanMove();
  $('btnUndo').disabled = !S.history.length;
  $('btnPass').disabled = !my;
  $('btnHint').disabled = !my;
  $('btnResign').disabled = !!(S.result || S.scoring);
  $('btnOwn').classList.toggle('on', S.prefs.own);

  $('selLevel').value = String(S.prefs.level);
  $('selLevel').disabled = S.prefs.target < 100;
  $('rngTarget').value = String(S.prefs.target);
  $('targetText').textContent = S.prefs.target >= 100 ? '全力' : `AI≈${S.prefs.target}%`;
  $('targetNote').textContent = S.prefs.target >= 100
    ? '拖动滑块可以让 AI 放水：AI 会挑选让自己胜率接近设定值的下法。'
    : `让棋模式：AI 会尽量把自己的胜率保持在 ${S.prefs.target}% 左右（数值越低越让着你）。`;
  $('chkCoach').checked = S.prefs.coach;
  $('chkCands').checked = S.prefs.cands;
  $('chkConfirm').checked = S.prefs.confirm;

  const banner = $('viewBanner');
  banner.hidden = S.view === null;
  if (S.view !== null) $('viewText').textContent = `第 ${S.view + 1} 手之前 · 红圈=实战 · 数字=AI 推荐（你的胜率%）`;

  renderCoach();
  drawBoard();
  drawGraph();
}

// ---------------- 对话框与提示 ----------------

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function showMessage(title, text, withNewGame, buttons) {
  const dlg = $('dlgMsg');
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  const menu = $('msgMenu');
  menu.innerHTML = '';
  const btns = buttons || (withNewGame
    ? [{ label: '查看棋盘' }, { label: '再来一局', primary: true, fn: openNewGame }]
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

function fillHandicap(size, value) {
  const sel = $('dlgNew').querySelector('[name=handicap]');
  const max = size === 9 ? 5 : 9;
  sel.innerHTML = '<option value="0">不让子</option>' +
    Array.from({ length: max - 1 }, (_, i) => `<option value="${i + 2}">让 ${i + 2} 子</option>`).join('');
  sel.value = String(Math.min(value, max) >= 2 ? Math.min(value, max) : 0);
}

function openNewGame() {
  const dlg = $('dlgNew'), f = dlg.querySelector('form');
  f.size.value = String(S.game.size);
  f.human.value = String(S.game.human);
  fillHandicap(S.game.size, S.game.handicap);
  f.komi.value = S.game.komiAuto === false ? String(S.game.komi) : 'auto';
  dlg.returnValue = '';
  dlg.showModal();
}

$('dlgNew').querySelector('[name=size]').addEventListener('change', e => {
  fillHandicap(+e.target.value, +$('dlgNew').querySelector('[name=handicap]').value);
});

$('dlgNew').addEventListener('close', () => {
  const dlg = $('dlgNew'), f = dlg.querySelector('form');
  if (dlg.returnValue !== 'ok') return;
  const size = +f.size.value, handicap = +f.handicap.value;
  const auto = f.komi.value === 'auto';
  newGame({
    size, human: +f.human.value, handicap,
    komi: auto ? (handicap >= 2 ? 0.5 : 7.5) : +f.komi.value,
    komiAuto: auto,
  });
});

// ---------------- 绑定 ----------------

$('selLevel').innerHTML = LEVELS.map((l, i) => `<option value="${i}">${l.name}</option>`).join('');
$('btnNew').addEventListener('click', openNewGame);
$('btnUndo').addEventListener('click', undo);
$('btnPass').addEventListener('click', humanPass);
$('btnHint').addEventListener('click', showHint);
$('btnResign').addEventListener('click', resign);
$('btnOwn').addEventListener('click', () => { S.prefs.own = !S.prefs.own; save(); render(); });
$('btnBackLive').addEventListener('click', () => { S.view = null; render(); });
$('selLevel').addEventListener('change', e => { S.prefs.level = +e.target.value; save(); render(); });
$('rngTarget').addEventListener('input', e => { S.prefs.target = +e.target.value; save(); render(); });
$('chkCoach').addEventListener('change', e => {
  S.prefs.coach = e.target.checked;
  save();
  if (S.prefs.coach) S.analyses.forEach((a, k) => a && makeComment(k));
  render();
});
$('chkCands').addEventListener('change', e => { S.prefs.cands = e.target.checked; save(); render(); });
$('chkConfirm').addEventListener('change', e => { S.prefs.confirm = e.target.checked; S.pendingTap = NONE; save(); render(); });
$('coach').addEventListener('click', e => {
  const el = e.target.closest('[data-j]');
  if (el) openReview(+el.dataset.j);
});

let resizeTimer = 0;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });

if ('serviceWorker' in navigator && !/WeiqiApp/.test(navigator.userAgent) &&
    location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load();
layout();
render();
if (!S.result && S.board.passes >= 2) startScoring();
else advance();
