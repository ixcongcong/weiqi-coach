'use strict';
/* 围棋对战教练：界面、对局流程、棋谱学习、讲解。引擎在 engine.js，计算在 Web Worker 里进行。 */

const APP_VERSION = '2.2';
const G = window.Go;
const { EMPTY, BLACK, WHITE, PASS, NONE, RESIGN } = G;
const GAMES = window.GAMES || [];

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
const STUDY_BUDGET = { playouts: 2500, ms: 2000, own: 200 };
const FINAL_OWN = { 9: 1200, 13: 900, 19: 600 };
const STORE_KEY = 'weiqi-coach-v1';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => Math.round(v * 100) + '%';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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
  mode: 'play',
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

// 提问的状态：pick = 等待在棋盘上点一个点 / 一块棋；mark = 棋盘上要圈出来的棋子
const Q = { open: false, pick: null, seq: 0, mark: null };

// 棋谱学习的状态
const T = {
  gi: 0, idx: 0, gen: 0,
  analyses: [], aprom: [], comments: {},
  guess: false, hit: 0, tried: 0, lastGuess: null,
  auto: 0, cache: null,
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
      mode: S.mode, game: S.game, prefs: S.prefs, setup: S.setup, history: S.history,
      result: S.scoring ? null : S.result, comments: S.comments,
      study: { gi: T.gi, idx: T.idx },
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
      S.mode = d.mode === 'study' ? 'study' : 'play';
      if (d.study) {
        T.gi = clamp(d.study.gi | 0, 0, Math.max(0, GAMES.length - 1));
        T.idx = d.study.idx | 0;
      }
    }
  } catch (e) { /* 数据损坏时从新局开始 */ }
  rebuild();
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

function canHumanMove() {
  return S.mode === 'play' && !S.result && !S.scoring && !S.scoringBusy && S.view === null &&
    S.board.toPlay === S.game.human && !S.aiThinking;
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
    S.result = { text: 'AI 认输，你赢了！', winner: S.game.human };
    save();
    render();
    showMessage('对局结束', 'AI 认输，你赢了！', true);
    return;
  }
  if (move === PASS) toast('AI 停一手');
  playMove(move, true);
}

function playMove(m, internal) {
  if (!S.board.play(m)) return false;
  S.history.push(m);
  S.hint = null;
  Q.mark = null;
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
  showMessage('对局结束', `${scoreText()}\n\n${won ? '你赢了！' : 'AI 获胜'}\n\n如果死活判断有误，可以点棋盘上的棋子切换死活。`, true);
}

function scoreText() {
  const sc = S.scoring;
  const d = sc.diff();
  return `黑 ${sc.black} 子，白 ${sc.white} 子（贴 ${S.game.komi}）\n${d > 0 ? '黑' : '白'}胜 ${Math.abs(d)} 子`;
}

// ---------------- 对战：讲解 ----------------

function quality(delta, isBest) {
  if (isBest) return { cls: 'best', label: '最佳' };
  if (delta < 0.03) return { cls: 'good', label: '好棋' };
  if (delta < 0.08) return { cls: 'ok', label: '可以' };
  if (delta < 0.15) return { cls: 'slow', label: '缓手' };
  return { cls: 'bad', label: '恶手' };
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

// ---------------- 对战：操作 ----------------

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

function openReview(j) {
  if (j >= S.history.length) return;
  S.view = S.view === j ? null : j;
  if (S.view !== null && !S.analyses[j]) getAnalysis(j);
  render();
}

// ---------------- 棋谱学习 ----------------

function sg() { return GAMES[T.gi]; }

function sgfPt(b, s) {
  return s === 'tt' ? PASS : b.pt(s.charCodeAt(0) - 97, s.charCodeAt(1) - 97);
}

function gameMoves(g) {
  if (!g._moves) {
    const b = new G.Board(g.size);
    g._moves = [];
    for (let i = 0; i < g.moves.length; i += 2) g._moves.push(sgfPt(b, g.moves.slice(i, i + 2)));
  }
  return g._moves;
}

function studyBoardAt(i) {
  const g = sg();
  if (T.cache && T.cache.gi === T.gi && T.cache.i === i) return T.cache.b.copy();
  const b = new G.Board(g.size);
  const pts = s => {
    const r = [];
    for (let k = 0; k < s.length; k += 2) r.push(sgfPt(b, s.slice(k, k + 2)));
    return r;
  };
  b.setupStones(pts(g.ab), pts(g.aw), g.first === 'W' ? WHITE : BLACK);
  const mv = gameMoves(g);
  for (let k = 0; k < i && k < mv.length; k++) b.play(mv[k]);
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
  const top = A.cands[0];
  let reasons = G.explain(pre, m, c, A.own, B.own, colorName(c), colorName(3 - c));
  if (sg().kind !== 'lesson') {
    // 本机引擎远弱于名局里的高手：不让它给大师的棋下“亏了”的结论
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
  const n = gameMoves(sg()).length;
  T.idx = clamp(idx, 0, n);
  Q.mark = null;
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
  studyGo(0);
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

function setMode(m) {
  if (S.mode === m) return;
  stopAuto();
  cancelWork();
  S.mode = m;
  S.ghost = NONE;
  save();
  layout();
  render();
  if (m === 'play') advance();
  else studyGo(T.idx);
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

/** 当前要画的局面，以及它的分析、候选点视角等。 */
function boardView() {
  if (S.mode === 'study') {
    const n = gameMoves(sg()).length;
    return {
      b: studyBoardAt(T.idx), k: T.idx, list: T.analyses, study: true,
      ghostColor: T.guess && T.idx < n ? studyBoardAt(T.idx).toPlay : 0,
    };
  }
  if (S.view !== null) return { b: boardAt(S.view), k: S.view, list: S.analyses, review: true };
  return { b: S.board, k: S.history.length, list: S.analyses, ghostColor: canHumanMove() ? S.game.human : 0 };
}

function drawBoard() {
  const s = geom.px;
  if (!s) return;
  const v = boardView(), b = v.b;
  const n = b.n, cell = s / (n + 0.8), org = cell * 0.9, end = org + (n - 1) * cell;
  geom.cell = cell; geom.org = org; geom.n = n;
  const X = p => org + b.x(p) * cell, Y = p => org + b.y(p) * cell;

  const bg = ctx.createLinearGradient(0, 0, s, s);
  bg.addColorStop(0, '#e9c27c'); bg.addColorStop(1, '#d6a65b');
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
  const scoring = !v.study && !v.review ? S.scoring : null;

  if (S.mode === 'play' && S.prefs.own && !scoring) {
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

  const ghost = S.pendingTap !== NONE && !v.study ? S.pendingTap : S.ghost;
  if (v.ghostColor && ghost >= 0 && b.b[ghost] === EMPTY) {
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

  // 候选点：数字是走那里之后，下这手的一方的胜率
  let cands = null;
  if (v.review) {
    if (S.analyses[S.view]) cands = S.analyses[S.view].cands.slice(0, 3);
  } else if (!v.study && (S.prefs.cands || (S.hint && !S.hint.loading)) && canHumanMove() && S.analyses[v.k]) {
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

  if (v.review) {
    const m = S.history[S.view];
    if (m >= 0) {
      drawStone(X(m), Y(m), r, b.toPlay, 0.55);
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = Math.max(2, r * 0.18);
      ctx.beginPath(); ctx.arc(X(m), Y(m), r * 0.95, 0, Math.PI * 2); ctx.stroke();
    }
  } else if (b.lastMove >= 0 && !scoring) {
    const lm = b.lastMove;
    if (v.study) {
      // 棋谱里在最后一手上标出手数
      ctx.fillStyle = b.b[lm] === BLACK ? '#fff' : '#111';
      ctx.font = `bold ${Math.round(cell * (T.idx >= 100 ? 0.3 : 0.36))}px -apple-system, sans-serif`;
      ctx.fillText(String(T.idx), X(lm), Y(lm) + 1);
      ctx.strokeStyle = '#e53935';
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.beginPath(); ctx.arc(X(lm), Y(lm), r * 1.02, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = '#e53935';
      ctx.beginPath(); ctx.arc(X(lm), Y(lm), r * 0.28, 0, Math.PI * 2); ctx.fill();
    }
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
  if (S.mode === 'study') { studyTap(p); return; }
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

function humanWr() {
  const la = latestAnalysis(S.analyses, S.history.length);
  if (!la) return null;
  return la.a.toPlay === S.game.human ? la.a.wr : 1 - la.a.wr;
}

function statusText() {
  if (S.view !== null) return `复盘：第 ${S.view + 1} 手`;
  if (S.scoringBusy) return '正在数子…';
  if (S.scoring) return '终局 · 点棋子可切换死活\n' + scoreText();
  if (S.result) return S.result.text;
  const g = S.game, b = S.board;
  const info = `${g.size}路 · 第 ${b.moveCount} 手 · 提子 黑${b.capB} 白${b.capW}`;
  let s;
  if (b.toPlay !== g.human) s = `AI（${S.prefs.target < 100 ? '让棋' : LEVELS[S.prefs.level].name}）思考中…`;
  else {
    s = `轮到你（执${colorName(g.human)}）`;
    if (b.lastMove === PASS && b.moveCount > 0) s += ' · AI 停了一手';
  }
  s += `　${info}`;
  if (S.prefs.own) {
    const la = latestAnalysis(S.analyses, S.history.length);
    if (la) s += `\n形势判断：${la.a.score > 0 ? '黑' : '白'}领先约 ${Math.abs(la.a.score).toFixed(1)} 子`;
  }
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

function playCoachHtml() {
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
    return html + '<div class="empty">讲解已关闭。勾选“讲解”就能看到每步棋的点评。</div>';
  }
  const keys = Object.keys(S.comments).map(Number).sort((a, b) => b - a);
  if (!keys.length) {
    html += '<div class="empty">下棋后，这里会逐手点评：这步棋好不好、为什么，以及更好的下法。<br>点一条点评可以回看当时的局面。<br>想学名局，点上方的“棋谱”。</div>';
  }
  for (const j of keys) html += commentHtml(S.comments[j]);
  return html;
}

function studyCoachHtml() {
  const g = sg(), mv = gameMoves(g), n = mv.length, i = T.idx;
  const keysHtml = '<div class="keys">' + Object.keys(g.notes).map(Number).map(k =>
    `<button data-go="${k}"${k === i ? ' class="on"' : ''}>第 ${k} 手</button>`).join('') + '</div>';
  const lesson = g.kind === 'lesson';
  const info = `<div class="cm game"><div class="h"><b>${esc(g.title)}</b>
    <span class="wr">${lesson ? '套路讲解' : `${g.year} 年 · ${esc(g.result)}`}</span></div>
    ${lesson ? '' : `<div>黑：${esc(g.black)}　白：${esc(g.white)}</div>`}
    ${i === 0 ? `<p>${esc(g.intro)}</p><p class="note">点“下一手”一步步看，每一手都有讲解；打开“猜棋”先自己想下一手再揭晓，是提高棋力最有效的练习。</p>` : ''}
    ${lesson && (i === 0 || i === n) ? `<div class="key">${esc(g.use)}</div>` : ''}
    <div class="note">${lesson ? '每一步：' : '重点手：'}</div>${keysHtml}</div>`;
  if (i === 0) return info;
  const b = studyBoardAt(i - 1), m = mv[i - 1], c = b.toPlay;
  const cm = T.comments[i - 1];
  const note = g.notes[i];
  const who = lesson ? colorName(c) : `${colorName(c)}（${esc(c === BLACK ? g.black : g.white)}）`;
  let h = `<div class="cm${note ? ' best' : ''}"><div class="h"><b>第 ${i} 手</b> ${who}下 ${esc(b.name(m))}
    ${cm ? `<span class="wr">黑胜率约 ${pct(cm.blackWr)}</span>` : ''}</div>`;
  if (note) h += `<div class="key"><b>讲解：</b>${esc(note)}</div>`;
  if (T.lastGuess && T.lastGuess.at === i) {
    h += T.lastGuess.ok
      ? '<p>你猜中了这一手！</p>'
      : `<p>你猜的是 ${esc(T.lastGuess.guess)}（棋盘上的蓝色叉号），实战下在 ${esc(T.lastGuess.actual)}。对比一下两手棋的区别。</p>`;
  }
  h += `<div class="note" style="margin-top:6px">AI 讲解：</div>${reasonsHtml(cm && cm.reasons)}`;
  if (cm && cm.top) {
    h += cm.top.same
      ? '<p class="note">这手棋与本机 AI 引擎的首选一致。</p>'
      : `<p class="note">本机 AI 引擎的首选是 ${esc(cm.top.name)}。引擎棋力远不如这些高手，这里只作对照：想一想高手为什么没有下那里。</p>`;
  }
  if (i === n && !lesson) h += `<p><b>终局：${esc(g.result)}</b></p>`;
  return h + '</div>' + info;
}

function render() {
  const study = S.mode === 'study';
  $('tabPlay').classList.toggle('on', !study);
  $('tabStudy').classList.toggle('on', study);
  $('playBar').hidden = study;
  $('studyBar').hidden = !study;

  if (study) {
    const g = sg(), n = gameMoves(g).length;
    const la = latestAnalysis(T.analyses, T.idx);
    $('wrText').textContent = la ? `黑 ${pct(la.a.toPlay === BLACK ? la.a.wr : 1 - la.a.wr)}` : '';
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
    $('viewBanner').hidden = true;
  } else {
    const hw = humanWr();
    $('wrText').textContent = hw === null ? '' : `你 ${pct(hw)}`;
    $('status').textContent = statusText();
    const my = canHumanMove();
    $('btnUndo').disabled = !S.history.length;
    $('btnPass').disabled = !my;
    $('btnHint').disabled = !my;
    $('btnResign').disabled = $('btnResign2').disabled = !!(S.result || S.scoring);
    $('btnOwn').classList.toggle('on', S.prefs.own);
    for (const [a, b, key] of [['chkCoach', 'chkCoach2', 'coach'], ['chkCands', 'chkCands2', 'cands'], ['chkConfirm', 'chkConfirm2', 'confirm']]) {
      $(a).checked = $(b).checked = S.prefs[key];
    }
    $('viewBanner').hidden = S.view === null;
    if (S.view !== null) $('viewText').textContent = `第 ${S.view + 1} 手之前 · 红圈=实战 · 数字=AI 推荐（胜率%）`;
    $('coach').innerHTML = playCoachHtml();
  }
  drawBoard();
}

// ---------------- 提问 ----------------

/** 当前局面及其分析：对战里以“你”为视角，棋谱里以轮到下棋的一方为视角。 */
function askContext() {
  if (S.mode === 'study') {
    const b = studyBoardAt(T.idx);
    return { b, getA: () => getStudyAnalysis(T.idx), me: b.toPlay, meName: colorName(b.toPlay), opName: colorName(3 - b.toPlay), komi: sg().komi || 0, budget: STUDY_BUDGET };
  }
  const k = S.history.length;
  return { b: S.board.copy(), getA: () => getAnalysis(k), me: S.game.human, meName: '你', opName: 'AI', komi: S.game.komi, budget: BUDGET[S.game.size] };
}

function askShow(q, html) {
  $('askAnswer').innerHTML = `<div class="q">问：${esc(q)}</div>${html}`;
}

function openAsk(open) {
  Q.open = open;
  Q.pick = null;
  Q.mark = null;
  $('askPanel').hidden = !open;
  $('btnAsk').classList.toggle('on', open);
  $('btnAsk2').classList.toggle('on', open);
  if (open) $('askAnswer').innerHTML = '';
  syncAskChips();
  drawBoard();
}

function syncAskChips() {
  for (const el of document.querySelectorAll('[data-ask]')) el.classList.toggle('on', Q.pick === el.dataset.ask);
}

/** 执行一个提问；返回 false 表示需要先在棋盘上点选。 */
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
  askShow(label, '<p>正在分析…</p>');
  const a = await ctx0.getA();
  if (!alive()) return;
  if (!a) { askShow(label, '<p>分析被打断了，请再问一次。</p>'); return; }
  const meWr = a.toPlay === ctx0.me ? a.wr : 1 - a.wr;
  if (kind === 'lead') {
    const sc = a.score;
    const lead = Math.abs(sc) < 1 ? '双方非常接近' : `${sc > 0 ? '黑' : '白'}领先约 ${Math.abs(sc).toFixed(1)} 子`;
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
      // 越危险、越大的棋越值得关心；已经基本死掉的小棋子不算
      const score = s - Math.min(g.stones.length, 8) * 0.02;
      if (s > -0.6 && (!worst || score < worst.score)) worst = { g, s, score };
    }
    if (!worst || worst.s > 0.6) { askShow(label, `<p>${esc(ctx0.meName)}的棋目前都比较安全，可以放心去抢大场或攻击对方。</p>`); return; }
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
  // point：下在这里怎么样
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

/** 文字提问：先识别局面类问题，否则在知识库里按关键词找答案。 */
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
  fNew.size.value = String(S.game.size);
  fNew.human.value = String(S.game.human);
  fillHandicap(S.game.size, S.game.handicap);
  fNew.komi.value = S.game.komiAuto === false ? String(S.game.komi) : 'auto';
  fNew.level.value = String(S.prefs.level);
  fNew.target.value = String(S.prefs.target);
  showTarget();
  dlgNew.returnValue = '';
  dlgNew.showModal();
}

fNew.level.innerHTML = LEVELS.map((l, i) => `<option value="${i}">${l.name}${i === 0 ? '（适合新手）' : i === 4 ? '（思考较久）' : ''}</option>`).join('');
fNew.size.addEventListener('change', () => fillHandicap(+fNew.size.value, +fNew.handicap.value));
fNew.target.addEventListener('input', showTarget);
$('versionText').textContent = `版本 ${APP_VERSION}`;

dlgNew.addEventListener('close', () => {
  const rv = dlgNew.returnValue;
  if (rv !== 'ok' && rv !== 'apply') return;
  S.prefs.level = +fNew.level.value;
  S.prefs.target = +fNew.target.value;
  if (rv === 'apply') {
    save();
    render();
    toast('AI 设置已更新，从下一手开始生效');
    return;
  }
  const handicap = +fNew.handicap.value, auto = fNew.komi.value === 'auto';
  newGame({
    size: +fNew.size.value, human: +fNew.human.value, handicap,
    komi: auto ? (handicap >= 2 ? 0.5 : 7.5) : +fNew.komi.value,
    komiAuto: auto,
  });
});

$('dlgMore').addEventListener('close', () => {
  if ($('dlgMore').returnValue === 'resign') resign();
});

// ---------------- 绑定 ----------------

$('tabPlay').addEventListener('click', () => setMode('play'));
$('tabStudy').addEventListener('click', () => setMode('study'));
$('btnNew').addEventListener('click', openNewGame);
$('btnUndo').addEventListener('click', undo);
$('btnPass').addEventListener('click', humanPass);
$('btnHint').addEventListener('click', showHint);
$('btnResign').addEventListener('click', resign);
$('btnMore').addEventListener('click', () => { $('dlgMore').returnValue = ''; $('dlgMore').showModal(); });
$('btnOwn').addEventListener('click', () => { S.prefs.own = !S.prefs.own; save(); render(); });
$('btnBackLive').addEventListener('click', () => { S.view = null; render(); });

function bindPref(ids, key, after) {
  for (const id of ids) {
    $(id).addEventListener('change', e => {
      S.prefs[key] = e.target.checked;
      if (after) after();
      save();
      render();
    });
  }
}
bindPref(['chkCoach', 'chkCoach2'], 'coach', () => {
  if (S.prefs.coach) S.analyses.forEach((a, k) => a && makeComment(k));
});
bindPref(['chkCands', 'chkCands2'], 'cands');
bindPref(['chkConfirm', 'chkConfirm2'], 'confirm', () => { S.pendingTap = NONE; });

$('coach').addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { stopAuto(); studyGo(+go.dataset.go); return; }
  const el = e.target.closest('[data-j]');
  if (el) openReview(+el.dataset.j);
});

$('selGame').innerHTML =
  `<optgroup label="套路讲解（入门必学）">${GAMES.map((g, i) => g.kind === 'lesson' ? `<option value="${i}">${esc(g.title)}</option>` : '').join('')}</optgroup>` +
  `<optgroup label="经典名局">${GAMES.map((g, i) => g.kind !== 'lesson' ? `<option value="${i}">${esc(g.title)}（${g.year}，${esc(g.black)} vs ${esc(g.white)}）</option>` : '').join('')}</optgroup>`;
$('selGame').addEventListener('change', e => selectGame(+e.target.value));
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

addEventListener('keydown', e => {
  if (S.mode !== 'study' || document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowRight') studyGo(T.idx + 1);
  else if (e.key === 'ArrowLeft') { stopAuto(); studyGo(T.idx - 1); }
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
$('btnHelp').addEventListener('click', () => $('dlgHelp').showModal());

load();
layout();
render();
if (S.mode === 'study') studyGo(T.idx);
else if (!S.result && S.board.passes >= 2) startScoring();
else advance();
