'use strict';
/* 中国象棋 / 国际象棋：对战（AI 讲解）、学习（互动课程）、棋谱、练习。
 * 规则在 chess.js / xiangqi.js，引擎在 worker.js（search.js）。 */

ccChess(window);
ccXiangqi(window);
const GAME = document.documentElement.dataset.game === 'chess' ? 'chess' : 'xiangqi';
const IS_CHESS = GAME === 'chess';
const R = IS_CHESS ? window.Chess : window.Xiangqi;
const DATA = (window.CC_DATA || {})[GAME] || { lessons: [], puzzles: [], games: [] };
const GAME_NAME = IS_CHESS ? '国际象棋' : '中国象棋';
const SIDES = IS_CHESS ? ['白方', '黑方'] : ['红方', '黑方'];
const SIDE_SHORT = IS_CHESS ? ['白', '黑'] : ['红', '黑'];
const MATE = 30000;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => Math.round(v * 100) + '%';

document.title = `弈 · ${GAME_NAME}`;
$('title').textContent = GAME_NAME;

function userId() {
  try { const u = JSON.parse(localStorage.getItem('weiqi-coach-users') || 'null'); return (u && u.current) || 'default'; } catch (e) { return 'default'; }
}
const STORE = `cc-${GAME}:${userId()}`;

const LEVELS = [
  { name: '入门', ms: 150, temp: 160, note: '常走软着，适合刚学会走子' },
  { name: '初级', ms: 300, temp: 70, note: '会吃子，偶尔失误' },
  { name: '中级', ms: 700, temp: 25, note: '基本不送子' },
  { name: '高级', ms: 1500, temp: 0, note: '全力计算约 1.5 秒' },
  { name: '大师', ms: 5000, temp: 0, note: '每步思考约 5 秒' },
];
const ANALYZE_MS = 700;

// ---------------- 引擎 ----------------

class Eng {
  constructor() { this.spawn(); }
  spawn() {
    this.w = new Worker('cc/worker.js');
    this.seq = 0; this.pend = new Map();
    this.w.onmessage = e => { const r = this.pend.get(e.data.id); if (r) { this.pend.delete(e.data.id); r(e.data); } };
    this.w.onerror = e => { console.error('cc worker', e.message); for (const r of this.pend.values()) r(null); this.pend.clear(); };
  }
  cancel() { this.w.terminate(); for (const r of this.pend.values()) r(null); this.pend.clear(); this.spawn(); }
  run(fen, moves, opts) {
    return new Promise(res => {
      const id = ++this.seq;
      this.pend.set(id, res);
      this.w.postMessage({ id, game: GAME, fen, moves, ...opts });
    });
  }
}
const eng = new Eng();

// ---------------- 工具 ----------------

function build(fen, moves, k) {
  const p = R.fromFEN(fen);
  const n = k === undefined ? moves.length : k;
  for (let i = 0; i < n && i < moves.length; i++) {
    const m = R.parseUci(p, moves[i]);
    if (!m) break;
    R.make(p, m);
  }
  return p;
}
function sqByName(s) {
  if (IS_CHESS) return (s.charCodeAt(1) - 49) * 16 + (s.charCodeAt(0) - 97);
  return R.sqOf(+s.slice(1), s.charCodeAt(0) - 97);
}
const uciFrom = u => sqByName(u.slice(0, 2)), uciTo = u => sqByName(u.slice(2, 4));
/** 分数（从某方看）→ 便于比较的“分”（杀棋折算成很大的数） */
const cp = s => (Math.abs(s) > MATE - 500 ? Math.sign(s) * (5000 - (MATE - Math.abs(s)) * 10) : s);
const mateIn = s => (Math.abs(s) > MATE - 500 ? Math.sign(s) * Math.ceil((MATE - Math.abs(s)) / 2) : 0);
const winProb = s => (Math.abs(s) > MATE - 500 ? (s > 0 ? 1 : 0) : 1 / (1 + Math.pow(10, -s / 400)));
function scoreText(s, who) {
  const mi = mateIn(s);
  if (mi > 0) return `${who}${mi} 步内可以${IS_CHESS ? '将死' : '杀棋'}`;
  if (mi < 0) return `${who}${-mi} 步内会被${IS_CHESS ? '将死' : '杀'}`;
  const v = Math.round(Math.abs(s) / 10) / 10;
  if (v < 0.3) return '双方大致均势';
  return `${s > 0 ? who + '领先' : who + '落后'}约 ${v} 分（兵 = 1 分）`;
}
function moveLabel(p, m) {
  return IS_CHESS ? `${R.moveName(p, m)}（${R.san(p, m)}）` : R.moveName(p, m);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => { t.hidden = true; }, 2600);
}

function showMsg(title, html) {
  $('msgTitle').textContent = title;
  $('msgBody').innerHTML = html;
  $('dlgMsg').showModal();
}

// ---------------- 状态 ----------------

const S = {
  mode: 'play',
  prefs: { level: 1, coach: true, threat: true },
  play: { fen: R.START, moves: [], human: 0, opp: 'ai', result: null, comments: {} },
  learn: { li: 0, si: 0 },
  games: { gi: 0, idx: 0 },
  practice: { pi: 0 },
  done: { lessons: {}, puzzles: {} },
  records: [],
  flip: false,
};
let A = [], Aprom = [], gen = 0, aiBusy = false;
let sel = -1, view = null, hint = null, flipNow = false;

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* 忽略 */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (d) for (const k of Object.keys(S)) if (d[k] !== undefined) S[k] = typeof S[k] === 'object' && !Array.isArray(S[k]) ? { ...S[k], ...d[k] } : d[k];
  } catch (e) { /* 忽略 */ }
}

// ---------------- 棋盘绘制 ----------------

const canvas = $('board'), ctx = canvas.getContext('2d');
const geom = { cell: 40, ox: 0, oy: 0, w: 0, h: 0 };
const isDark = () => document.documentElement.dataset.theme === 'dark';

function layout() {
  const wrap = $('boardWrap');
  const landscape = innerWidth >= innerHeight;
  const cols = IS_CHESS ? 8 : 9.8, rows = IS_CHESS ? 8 : 10.8;
  let maxW, maxH;
  if (landscape) { maxW = wrap.clientWidth - 12; maxH = wrap.clientHeight - 12; } else { maxW = innerWidth - 12; maxH = innerHeight * 0.64; }
  const cell = Math.max(24, Math.floor(Math.min(maxW / cols, maxH / rows)));
  const w = Math.round(cell * cols), h = Math.round(cell * rows);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  geom.cell = cell; geom.w = w; geom.h = h;
  geom.ox = IS_CHESS ? 0 : cell * 0.9; geom.oy = IS_CHESS ? 0 : cell * 0.9;
  draw();
}

/** 棋盘格 (x,y) → 画面坐标中心 */
function center(x, y) {
  const { cell, ox, oy } = geom;
  const dx = flipNow ? R.W - 1 - x : x, dy = flipNow ? R.H - 1 - y : y;
  return IS_CHESS ? [ox + (dx + 0.5) * cell, oy + (dy + 0.5) * cell] : [ox + dx * cell, oy + dy * cell];
}
function cellAt(px, py) {
  const { cell, ox, oy } = geom;
  let x, y;
  if (IS_CHESS) { x = Math.floor((px - ox) / cell); y = Math.floor((py - oy) / cell); } else { x = Math.round((px - ox) / cell); y = Math.round((py - oy) / cell); }
  if (x < 0 || y < 0 || x >= R.W || y >= R.H) return null;
  if (flipNow) { x = R.W - 1 - x; y = R.H - 1 - y; }
  return [x, y];
}

function drawChessBoard() {
  const { cell } = geom, dark = isDark();
  const light = dark ? '#b9a27f' : '#f0d9b5', deep = dark ? '#7d6244' : '#b58863';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 ? deep : light;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.font = `600 ${Math.round(cell * 0.2)}px -apple-system, sans-serif`;
  for (let i = 0; i < 8; i++) {
    const file = flipNow ? 7 - i : i, rank = flipNow ? i + 1 : 8 - i;
    ctx.fillStyle = (i + 7) % 2 ? light : deep;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('abcdefgh'[file], (i + 1) * cell - 3, 8 * cell - 2);
    ctx.fillStyle = i % 2 ? light : deep;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(String(rank), 3, i * cell + 2);
  }
}

function drawXiangqiBoard() {
  const { cell, ox, oy, w, h } = geom, dark = isDark();
  const g = ctx.createLinearGradient(0, 0, w, h);
  if (dark) { g.addColorStop(0, '#a88450'); g.addColorStop(1, '#8e6c3c'); } else { g.addColorStop(0, '#edc987'); g.addColorStop(1, '#dcae63'); }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#3b2a14';
  ctx.lineWidth = Math.max(1, cell * 0.03);
  ctx.beginPath();
  for (let y = 0; y < 10; y++) { ctx.moveTo(ox, oy + y * cell); ctx.lineTo(ox + 8 * cell, oy + y * cell); }
  for (let x = 0; x < 9; x++) {
    if (x === 0 || x === 8) { ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + 9 * cell); } else {
      ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + 4 * cell);
      ctx.moveTo(ox + x * cell, oy + 5 * cell); ctx.lineTo(ox + x * cell, oy + 9 * cell);
    }
  }
  // 九宫斜线
  for (const y0 of [0, 7]) {
    ctx.moveTo(ox + 3 * cell, oy + y0 * cell); ctx.lineTo(ox + 5 * cell, oy + (y0 + 2) * cell);
    ctx.moveTo(ox + 5 * cell, oy + y0 * cell); ctx.lineTo(ox + 3 * cell, oy + (y0 + 2) * cell);
  }
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, cell * 0.06);
  ctx.strokeRect(ox - cell * 0.12, oy - cell * 0.12, 8 * cell + cell * 0.24, 9 * cell + cell * 0.24);
  // 兵、炮位置的记号
  ctx.lineWidth = Math.max(1, cell * 0.025);
  const mark = (x, y) => {
    const cx = ox + x * cell, cy = oy + y * cell, a = cell * 0.08, b = cell * 0.2;
    for (const sx of [-1, 1]) {
      if ((x === 0 && sx < 0) || (x === 8 && sx > 0)) continue;
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * a, cy + sy * (a + b)); ctx.lineTo(cx + sx * a, cy + sy * a); ctx.lineTo(cx + sx * (a + b), cy + sy * a);
        ctx.stroke();
      }
    }
  };
  for (const y of [2, 7]) for (const x of [1, 7]) mark(x, y);
  for (const y of [3, 6]) for (let x = 0; x < 9; x += 2) mark(x, y);
  ctx.fillStyle = '#3b2a14';
  ctx.font = `${Math.round(cell * 0.5)}px "STKaiti","KaiTi","Kaiti SC","Songti SC",serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ry = oy + 4.5 * cell;
  ctx.fillText(flipNow ? '汉　界' : '楚　河', ox + 2 * cell, ry);
  ctx.fillText(flipNow ? '楚　河' : '汉　界', ox + 6 * cell, ry);
  // 路数：下方红方（一到九，从右往左），上方黑方（1 到 9，从左往右）
  ctx.font = `${Math.round(cell * 0.26)}px -apple-system, sans-serif`;
  ctx.fillStyle = dark ? '#2a1c0a' : '#6b4a1c';
  const CN = '一二三四五六七八九';
  for (let x = 0; x < 9; x++) {
    const bottomSide = flipNow ? 1 : 0;
    const f = flipNow ? 8 - x : x;
    const bot = bottomSide === 0 ? CN[8 - f] : String(f + 1), topL = bottomSide === 0 ? String(f + 1) : CN[8 - f];
    ctx.fillText(bot, ox + x * cell, oy + 9 * cell + cell * 0.66);
    ctx.fillText(topL, ox + x * cell, oy - cell * 0.66);
  }
}

function drawPiece(x, y, piece, alpha) {
  const [cx, cy] = center(x, y), cell = geom.cell;
  const c = R.color(piece), t = R.type(piece);
  ctx.save();
  ctx.globalAlpha = alpha || 1;
  if (IS_CHESS) {
    ctx.font = `${Math.round(cell * 0.8)}px "Apple Symbols","Segoe UI Symbol","Noto Sans Symbols 2","DejaVu Sans",serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const gl = R.GLYPH[t] + '︎';
    ctx.lineWidth = Math.max(1.2, cell * 0.045);
    ctx.lineJoin = 'round';
    if (c === 0) { ctx.strokeStyle = '#1a1a1a'; ctx.strokeText(gl, cx, cy + cell * 0.04); ctx.fillStyle = '#fdfdfd'; ctx.fillText(gl, cx, cy + cell * 0.04); } else { ctx.shadowColor = 'rgba(255,255,255,.55)'; ctx.shadowBlur = Math.max(1, cell * 0.04); ctx.fillStyle = '#141414'; ctx.fillText(gl, cx, cy + cell * 0.04); }
  } else {
    const r = cell * 0.44;
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.arc(cx + r * 0.06, cy + r * 0.1, r, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#fff6df'); g.addColorStop(1, '#e8c98e');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    const col = c === 0 ? '#b71c1c' : '#1b1b1b';
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, cell * 0.035);
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = `bold ${Math.round(cell * 0.5)}px "STKaiti","KaiTi","Kaiti SC","Songti SC",serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((c === 0 ? R.NAMES_R : R.NAMES_B)[t], cx, cy + cell * 0.02);
  }
  ctx.restore();
}

function hl(sq, color, kind) {
  const [x, y] = R.xyOf(sq), [cx, cy] = center(x, y), cell = geom.cell;
  ctx.save();
  if (kind === 'sq') {
    ctx.fillStyle = color;
    if (IS_CHESS) ctx.fillRect(cx - cell / 2, cy - cell / 2, cell, cell);
    else { ctx.beginPath(); ctx.arc(cx, cy, cell * 0.48, 0, Math.PI * 2); ctx.fill(); }
  } else if (kind === 'dot') {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, cell * 0.14, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, cell * 0.07);
    ctx.beginPath(); ctx.arc(cx, cy, cell * 0.44, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function arrow(from, to, color) {
  const [x1, y1] = center(...R.xyOf(from)), [x2, y2] = center(...R.xyOf(to)), cell = geom.cell;
  const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1) - cell * 0.3;
  ctx.save();
  ctx.translate(x1, y1); ctx.rotate(ang);
  ctx.fillStyle = color; ctx.globalAlpha = 0.8;
  const t = cell * 0.09, hw = cell * 0.24, hl2 = cell * 0.32;
  ctx.beginPath();
  ctx.moveTo(0, -t); ctx.lineTo(len - hl2, -t); ctx.lineTo(len - hl2, -hw); ctx.lineTo(len, 0);
  ctx.lineTo(len - hl2, hw); ctx.lineTo(len - hl2, t); ctx.lineTo(0, t); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/** 当前模式下显示的局面与标注 */
function boardView() {
  if (S.mode === 'play') {
    const k = view === null ? S.play.moves.length : view;
    const p = build(S.play.fen, S.play.moves, k);
    const last = k > 0 ? S.play.moves[k - 1] : null;
    const v = { p, last, movable: view === null && canHumanMove() };
    if (hint && view === null) v.arrows = [[hint, '#e65100']];
    if (S.prefs.threat && view === null && !S.play.result && isHumanTurnPlay()) v.danger = R.hanging(p, p.turn);
    return v;
  }
  if (S.mode === 'learn') return { p: L.pos, last: L.last, movable: L.waiting, marks: L.marks, arrows: L.arrows };
  if (S.mode === 'games') {
    const g = gameList()[S.games.gi];
    if (!g) return { p: R.fromFEN(R.START) };
    return { p: build(g.fen, g.moves, S.games.idx), last: S.games.idx > 0 ? g.moves[S.games.idx - 1] : null, arrows: GS.best ? [[GS.best, '#1565c0']] : null };
  }
  return { p: PZ.pos || R.fromFEN(R.START), last: PZ.last, movable: PZ.waiting, arrows: PZ.arrows, marks: PZ.marks };
}

function draw() {
  const v = boardView(), p = v.p;
  flipNow = S.mode === 'play' ? S.flip : S.mode === 'practice' && PZ.side === 1;
  ctx.clearRect(0, 0, geom.w, geom.h);
  if (IS_CHESS) drawChessBoard(); else drawXiangqiBoard();
  if (v.last) {
    const c = isDark() ? 'rgba(255,213,79,.35)' : 'rgba(255,213,79,.5)';
    hl(uciFrom(v.last), c, 'sq'); hl(uciTo(v.last), c, 'sq');
  }
  if (R.inCheck(p)) hl(p.k[p.turn], 'rgba(229,57,53,.55)', 'sq');
  if (sel >= 0) hl(sel, 'rgba(33,150,243,.45)', 'sq');
  for (const s of v.danger || []) hl(s, 'rgba(229,57,53,.9)', 'ring');
  for (const s of v.marks || []) hl(sqByName(s), '#1565c0', 'ring');
  for (let y = 0; y < R.H; y++) {
    for (let x = 0; x < R.W; x++) {
      const s = R.sqAt(x, y), piece = p.b[s];
      if (piece) drawPiece(x, y, piece);
    }
  }
  if (sel >= 0) {
    for (const m of R.legalMoves(p)) {
      if (R.mFrom(m) !== sel) continue;
      const t = R.mTo(m);
      hl(t, p.b[t] ? 'rgba(229,57,53,.75)' : 'rgba(21,101,192,.6)', p.b[t] ? 'ring' : 'dot');
    }
  }
  for (const [u, color] of v.arrows || []) arrow(uciFrom(u), uciTo(u), color);
}

// ---------------- 点棋盘走子 ----------------

let promoWait = null;
canvas.addEventListener('pointerdown', async e => {
  const rect = canvas.getBoundingClientRect();
  const c = cellAt(e.clientX - rect.left, e.clientY - rect.top);
  if (!c) return;
  const v = boardView();
  if (!v.movable) { if (S.mode === 'play' && view !== null) toast('正在回看，点“回到当前”继续下'); return; }
  const p = v.p, s = R.sqAt(c[0], c[1]);
  if (sel >= 0) {
    const cands = R.legalMoves(p).filter(m => R.mFrom(m) === sel && R.mTo(m) === s);
    if (cands.length) {
      let m = cands[0];
      if (cands.length > 1) {
        const ch = await askPromo();
        m = cands.find(x => ' pnbrqk'[R.mPromo(x)] === ch) || cands[0];
      }
      sel = -1;
      userMove(R.uci(m));
      return;
    }
  }
  sel = p.b[s] && R.color(p.b[s]) === p.turn ? s : -1;
  draw();
});

function askPromo() {
  return new Promise(res => {
    const d = $('dlgPromo');
    promoWait = res;
    d.returnValue = '';
    d.showModal();
  });
}
$('dlgPromo').addEventListener('close', () => { if (promoWait) { promoWait($('dlgPromo').returnValue || 'q'); promoWait = null; } });

function userMove(u) {
  hint = null;
  if (S.mode === 'play') playUserMove(u);
  else if (S.mode === 'learn') learnMove(u);
  else if (S.mode === 'practice') puzzleMove(u);
}

// ---------------- 对战 ----------------

const pvp = () => S.play.opp === 'human';
function playPos() { return build(S.play.fen, S.play.moves); }
function isHumanTurnPlay() { const p = playPos(); return pvp() || p.turn === S.play.human; }
function canHumanMove() { return S.mode === 'play' && !S.play.result && !aiBusy && isHumanTurnPlay(); }
const sideLabel = c => (pvp() ? SIDES[c] : c === S.play.human ? '你' : 'AI');

function newGame(opts) {
  eng.cancel();
  gen++;
  aiBusy = false;
  S.play = { fen: R.START, moves: [], human: opts.human, opp: opts.opp, result: null, comments: {} };
  S.flip = opts.opp === 'ai' && opts.human === 1;
  A = []; Aprom = []; view = null; hint = null; sel = -1;
  save();
  render();
  advance();
}

function getAnalysis(k) {
  if (A[k]) return Promise.resolve(A[k]);
  if (!Aprom[k]) {
    const g = gen;
    Aprom[k] = eng.run(S.play.fen, S.play.moves.slice(0, k), { ms: ANALYZE_MS }).then(r => {
      if (!r || g !== gen) return null;
      A[k] = r;
      if (k >= 1) makeComment(k - 1);
      render();
      return r;
    });
  }
  return Aprom[k];
}

async function advance() {
  const g = gen;
  for (;;) {
    if (g !== gen || S.mode !== 'play') return;
    const p = playPos(), k = S.play.moves.length;
    const res = R.result(p);
    if (res) { finishGame(res); return; }
    if (S.prefs.coach || !pvp()) getAnalysis(k);
    if (isHumanTurnPlay()) return;
    await aiMove(g);
    if (g !== gen) return;
  }
}

async function aiMove(g) {
  aiBusy = true;
  render();
  const t0 = Date.now();
  const lv = LEVELS[S.prefs.level] || LEVELS[1];
  const k = S.play.moves.length;
  const r = await eng.run(S.play.fen, S.play.moves, { ms: lv.ms, all: lv.temp > 0 });
  if (!r || g !== gen) return;
  let u = r.best;
  if (lv.temp > 0 && r.moves.length > 1) {
    const top = cp(r.moves[0].s);
    const list = r.moves.filter(x => cp(x.s) > top - 400 && !(mateIn(r.moves[0].s) > 0 && mateIn(x.s) <= 0 && Math.random() < 0.5));
    const ws = list.map(x => Math.exp((cp(x.s) - top) / lv.temp));
    let z = Math.random() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) { z -= ws[i]; if (z <= 0) { u = list[i].u; break; } }
  }
  if (!A[k] && r.depth >= 3 && lv.temp === 0) A[k] = r;
  const wait = 400 - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  if (g !== gen) return;
  aiBusy = false;
  S.play.moves.push(u);
  save();
  render();
}

function playUserMove(u) {
  if (!canHumanMove()) return;
  S.play.moves.push(u);
  save();
  render();
  advance();
}

const QUALITY = [
  { cls: 'best', label: '最佳' }, { cls: 'good', label: '好棋' }, { cls: 'ok', label: '可以' },
  { cls: 'slow', label: '缓手' }, { cls: 'bad', label: '失误' }, { cls: 'bad', label: '恶手' },
];

function makeComment(j) {
  const a = A[j], b = A[j + 1];
  if (!a || !b || S.play.comments[j] || j >= S.play.moves.length) return;
  const pre = build(S.play.fen, S.play.moves, j), u = S.play.moves[j], m = R.parseUci(pre, u);
  if (!m) return;
  const mover = pre.turn, bestScore = a.score, moveScore = -b.score;
  const isBest = a.best === u;
  const loss = isBest ? 0 : Math.max(0, cp(bestScore) - cp(moveScore));
  let qi = isBest ? 0 : loss <= 30 ? 1 : loss <= 90 ? 2 : loss <= 200 ? 3 : loss <= 400 ? 4 : 5;
  if (!isBest && mateIn(bestScore) > 0 && mateIn(moveScore) <= 0) qi = Math.max(qi, 4);
  const cm = {
    j, mover, u, name: moveLabel(pre, m), q: qi, loss, reasons: R.describe(pre, m, sideLabel(mover)), after: moveScore,
  };
  if (qi >= 3 && a.best) {
    const bm = R.parseUci(pre, a.best);
    if (bm) cm.best = { u: a.best, name: moveLabel(pre, bm), reasons: R.describe(pre, bm, sideLabel(mover)), score: bestScore };
  }
  S.play.comments[j] = cm;
  save();
}

function commentHtml(c) {
  const q = QUALITY[c.q], you = pvp() || c.mover === S.play.human;
  let h = `<div class="cm ${you ? q.cls : 'ai'}" data-j="${c.j}"><div class="h"><b>第 ${c.j + 1} 手</b> ${esc(sideLabel(c.mover))}：${esc(c.name)}
    ${you ? `<span class="tag ${q.cls}">${q.label}</span>` : ''}<span class="wr">${esc(scoreText(c.after, SIDE_SHORT[c.mover]))}</span></div>
    <ul>${c.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
  if (you && c.best) {
    h += `<div class="better">更好的是 <b>${esc(c.best.name)}</b>${c.loss >= 30 ? `（这手大约亏了 ${Math.round(c.loss / 10) / 10} 分）` : ''}<ul>${c.best.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
    h += '<p class="note">点这条点评可以回看当时的局面。</p>';
  }
  return h + '</div>';
}

function finishGame(res) {
  if (S.play.result) return;
  S.play.result = res;
  const text = res.winner < 0 ? `和棋：${res.reason}` : `${SIDES[res.winner]}胜（${res.reason}）`;
  S.records.unshift({ date: new Date().toISOString(), fen: S.play.fen, moves: S.play.moves.slice(), result: text, human: S.play.human, opp: S.play.opp, level: LEVELS[S.prefs.level].name });
  S.records = S.records.slice(0, 50);
  save();
  fillGames();
  render();
  const you = !pvp() && res.winner === S.play.human, lost = !pvp() && res.winner >= 0 && !you;
  const mistakes = Object.values(S.play.comments).filter(c => (pvp() || c.mover === S.play.human) && c.q >= 3).sort((x, y) => y.loss - x.loss).slice(0, 3);
  let body = `<p><b>${esc(text)}</b>${pvp() ? '' : you ? ' —— 你赢了！' : lost ? ' —— 这盘输了，看看下面的关键失误。' : ''}</p>`;
  if (mistakes.length) {
    body += `<p>${you ? '虽然赢了，但这几手可以更好：' : '关键失误：'}</p><ul>${mistakes.map(c => `<li>第 ${c.j + 1} 手 ${esc(c.name)}（${QUALITY[c.q].label}）${c.best ? `，更好的是 ${esc(c.best.name)}` : ''}</li>`).join('')}</ul>`;
  } else if (!pvp()) body += '<p>你没有明显的大失误，下得很稳！</p>';
  body += '<p class="note">对局已保存到“棋谱 → 我的对局”，可以随时复盘。</p>';
  showMsg('对局结束', body);
}

function undo() {
  if (!S.play.moves.length) return;
  eng.cancel();
  gen++;
  aiBusy = false;
  let n = 1;
  if (!pvp()) {
    const p = playPos();
    n = p.turn === S.play.human ? 2 : 1;
  }
  n = Math.min(n, S.play.moves.length);
  S.play.moves.length -= n;
  S.play.result = null;
  for (const j of Object.keys(S.play.comments)) if (+j >= S.play.moves.length) delete S.play.comments[j];
  A.length = Math.min(A.length, S.play.moves.length + 1);
  Aprom = [];
  view = null; hint = null; sel = -1;
  save();
  render();
  advance();
}

async function showHint() {
  if (!canHumanMove()) return;
  const k = S.play.moves.length, g = gen;
  toast('正在计算…');
  const a = await getAnalysis(k);
  if (!a || g !== gen || S.play.moves.length !== k || !a.best) return;
  hint = a.best;
  const p = playPos(), m = R.parseUci(p, a.best);
  HINT_HTML = `<div class="cm hint"><div class="h"><b>提示</b>：${esc(moveLabel(p, m))}<span class="wr">${esc(scoreText(a.score, SIDE_SHORT[p.turn]))}</span></div><ul>${R.describe(p, m).map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
  render();
}
let HINT_HTML = '';

// ---------------- 学习 ----------------

const L = { pos: null, last: null, waiting: false, marks: null, arrows: null, fb: '', solved: false, goalMoves: 0, busy: false };

function lesson() { return DATA.lessons[S.learn.li]; }
function step() { const l = lesson(); return l && l.steps[S.learn.si]; }

function loadStep() {
  const st = step();
  L.fb = ''; L.solved = false; L.goalMoves = 0; L.busy = false; L.hinted = false; sel = -1;
  if (!st) { L.pos = R.fromFEN(R.START); L.waiting = false; render(); return; }
  L.pos = R.fromFEN(st.fen);
  L.last = st.last || null;
  L.marks = st.marks || null;
  L.arrows = (st.arrows || []).map(a => [a[0] + a[1], '#1565c0']);
  L.waiting = !!(st.task || st.goal);
  L.start = st.fen;
  L.moves = [];
  const l = lesson();
  if (S.learn.si === l.steps.length - 1 && !st.task && !st.goal) markLessonDone();
  save();
  render();
}

function markLessonDone() {
  const l = lesson();
  if (l && !S.done.lessons[l.id]) { S.done.lessons[l.id] = true; fillLessons(); toast('这一课学完了！'); }
}

async function learnMove(u) {
  const st = step();
  if (!st || !L.waiting || L.busy) return;
  const p = L.pos, m = R.parseUci(p, u);
  if (!m) return;
  if (st.task) {
    let ok = st.task.answers.includes(u);
    if (!ok && st.task.mate) { R.make(p, m); ok = !R.legalMoves(p).length && R.inCheck(p); R.unmake(p); }
    if (!ok && st.task.noStalemate) { R.make(p, m); ok = R.legalMoves(p).length > 0 || R.inCheck(p); R.unmake(p); }
    if (ok) {
      const name = moveLabel(p, m);
      R.make(p, m);
      L.last = u; L.marks = null; L.arrows = null;
      L.fb = `<p class="feedback ok">对了！${esc(name)}。${esc(st.task.ok || '')}</p>`;
      L.waiting = false; L.solved = true;
      render();
      if (st.task.reply) {
        await sleep(700);
        const rm = R.parseUci(L.pos, st.task.reply);
        if (rm) { R.make(L.pos, rm); L.last = st.task.reply; }
        render();
      }
      if (S.learn.si === lesson().steps.length - 1) markLessonDone();
    } else {
      const reasons = R.describe(p, m);
      L.fb = `<p class="feedback no">不对哦：${esc(moveLabel(p, m))}。</p><p class="note">${esc(reasons[0] || '')}</p><p>${esc(st.task.no || '再想想，也可以点“提示”。')}</p>`;
      render();
    }
    return;
  }
  if (st.goal) {
    // 和引擎下完这一段：目标是将死（或吃掉指定的子）
    R.make(p, m);
    L.moves.push(u);
    L.last = u; L.goalMoves++;
    const res = R.result(p);
    if (res && res.winner === (1 - p.turn)) { goalDone(); return; }
    if (res) { L.fb = `<p class="feedback no">${esc(res.reason)}，没能完成。点“重来”再试一次。</p>`; L.waiting = false; render(); return; }
    if (L.goalMoves >= st.goal.limit) { L.fb = `<p class="feedback no">已经走了 ${st.goal.limit} 步还没完成，点“重来”再试（可以用“提示”）。</p>`; L.waiting = false; render(); return; }
    L.busy = true; L.fb = '<p class="note">对方在想…</p>';
    render();
    const g = gen;
    const r = await eng.run(L.start, L.moves, { ms: 500 });
    if (!r || g !== gen || step() !== st) return;
    L.busy = false;
    const rm = R.parseUci(p, r.best);
    if (rm) { R.make(p, rm); L.moves.push(r.best); L.last = r.best; }
    const res2 = R.result(p);
    if (res2) { L.fb = `<p class="feedback no">${esc(res2.reason)}，没能完成。点“重来”再试一次。</p>`; L.waiting = false; render(); return; }
    L.fb = `<p class="note">已走 ${L.goalMoves} 步（最多 ${st.goal.limit} 步）。</p>`;
    render();
  }
}

function goalDone() {
  L.fb = `<p class="feedback ok">成功！用了 ${L.goalMoves} 步。${esc(step().goal.ok || '')}</p>`;
  L.waiting = false; L.solved = true;
  if (S.learn.si === lesson().steps.length - 1) markLessonDone();
  render();
}

async function learnHint() {
  const st = step();
  if (!st || !L.waiting) return;
  if (st.task) {
    const u = st.task.answers[0];
    if (st.task.hint && !L.hinted) { L.hinted = true; L.fb = `<p class="note">提示：${esc(st.task.hint)}</p>`; render(); return; }
    if (u) { L.arrows = [[u, '#e65100']]; L.fb = '<p class="note">看箭头：从这里走到那里。</p>'; render(); return; }
  }
  const r = await eng.run(L.start, L.moves, { ms: 600 });
  if (r && r.best) { L.arrows = [[r.best, '#e65100']]; render(); }
}

function learnHtml() {
  const l = lesson(), st = step();
  if (!l) return '<p class="empty">还没有课程。</p>';
  const text = st.text.split('\n').map(t => `<p>${esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`).join('');
  let h = `<div class="cm game"><div class="h"><b>${esc(l.title)}</b><span class="wr">第 ${S.learn.si + 1} / ${l.steps.length} 步</span></div><div class="lesson-text">${text}</div>`;
  if (st.task) h += `<div class="task">${esc(st.task.prompt || '请在棋盘上走一步。')}</div>`;
  if (st.goal) h += `<div class="task">${esc(st.goal.prompt || `在 ${st.goal.limit} 步之内将死对方。`)}</div>`;
  h += L.fb;
  if (!st.task && !st.goal && S.learn.si === l.steps.length - 1) h += `<p class="feedback ok">这一课完成了！${S.learn.li + 1 < DATA.lessons.length ? '点“下一步”进入下一课。' : '全部课程都学完了，去“练习”和“对战”试试吧！'}</p>`;
  return h + '</div>';
}

function stepGo(d) {
  const l = lesson();
  if (!l) return;
  let si = S.learn.si + d, li = S.learn.li;
  if (si >= l.steps.length) { if (li + 1 < DATA.lessons.length) { li++; si = 0; } else si = l.steps.length - 1; }
  if (si < 0) { if (li > 0) { li--; si = DATA.lessons[li].steps.length - 1; } else si = 0; }
  S.learn = { li, si };
  $('selLesson').value = String(li);
  loadStep();
}

function fillLessons() {
  // 按阶段分组（第 1 阶段……、套路 · 杀法……）
  let html = '', stage = null;
  DATA.lessons.forEach((l, i) => {
    if (l.stage !== stage) { if (stage !== null) html += '</optgroup>'; stage = l.stage; html += `<optgroup label="${esc(stage || '')}">`; }
    html += `<option value="${i}">${S.done.lessons[l.id] ? '✓ ' : ''}${esc(l.title)}</option>`;
  });
  $('selLesson').innerHTML = html + (stage !== null ? '</optgroup>' : '');
  $('selLesson').value = String(S.learn.li);
}

// ---------------- 棋谱 ----------------

const GS = { best: null, eval: null, auto: null, names: null, gi: -1 };
function gameList() {
  const mine = S.records.map((r, i) => ({
    id: `my${i}`, title: `我的对局 ${new Date(r.date).toLocaleDateString('zh-CN')} · ${r.opp === 'human' ? '真人' : `执${SIDE_SHORT[r.human]}对 AI（${r.level}）`} · ${r.result}`,
    fen: r.fen, moves: r.moves, notes: {}, info: r.result, mine: true,
  }));
  return DATA.games.concat(mine);
}
function gameNames(g) {
  if (GS.gi === S.games.gi && GS.names) return GS.names;
  const p = R.fromFEN(g.fen), names = [];
  for (const u of g.moves) { const m = R.parseUci(p, u); if (!m) break; names.push({ san: IS_CHESS ? R.san(p, m) : R.moveName(p, m), full: moveLabel(p, m) }); R.make(p, m); }
  GS.gi = S.games.gi; GS.names = names;
  return names;
}
function gameGo(idx) {
  const g = gameList()[S.games.gi];
  if (!g) return;
  S.games.idx = Math.max(0, Math.min(g.moves.length, idx));
  GS.best = null; GS.eval = null;
  save();
  render();
  const k = S.games.idx, gi = S.games.gi;
  eng.cancel();
  eng.run(g.fen, g.moves.slice(0, k), { ms: 600 }).then(r => {
    if (!r || S.games.idx !== k || S.games.gi !== gi || S.mode !== 'games') return;
    GS.eval = r; GS.best = r.best;
    render();
  });
}
function gamesHtml() {
  const list = gameList(), g = list[S.games.gi];
  if (!g) return '<p class="empty">还没有棋谱。</p>';
  const names = gameNames(g), k = S.games.idx;
  let h = `<div class="cm game"><div class="h"><b>${esc(g.title)}</b><span class="wr">第 ${k} / ${g.moves.length} 手</span></div>${g.info ? `<p class="note">${esc(g.info)}</p>` : ''}`;
  if (k === 0 && g.intro) h += `<p>${esc(g.intro)}</p>`;
  if (k > 0) {
    const pre = build(g.fen, g.moves, k - 1), m = R.parseUci(pre, g.moves[k - 1]);
    h += `<p><b>第 ${k} 手 ${SIDES[pre.turn]}：${esc(names[k - 1].full)}</b></p>`;
    if (g.notes && g.notes[k]) h += `<p>${esc(g.notes[k])}</p>`;
    h += `<ul>${R.describe(pre, m, SIDES[pre.turn]).map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
  }
  if (GS.eval) {
    const p = build(g.fen, g.moves, k);
    if (GS.eval.best) h += `<p class="note">引擎：${esc(scoreText(GS.eval.score, SIDE_SHORT[p.turn]))}；这时${SIDES[p.turn]}最好下 ${esc(moveLabel(p, R.parseUci(p, GS.eval.best)))}（蓝色箭头）${k < g.moves.length ? (g.moves[k] === GS.eval.best ? '，实战下的就是这一步。' : '。') : '。'}</p>`;
  }
  return h + '</div>';
}

// ---------------- 练习 ----------------

const KIND = { mate1: '一步杀', mate2: '两步杀', mate3: '三步杀', win: '得子' };
const PZ = { pos: null, last: null, waiting: false, side: 0, left: 0, fb: '', state: '', arrows: null, marks: null, moves: [], hints: 0 };
function puzzle() { return DATA.puzzles[S.practice.pi]; }
function loadPuzzle() {
  const z = puzzle();
  sel = -1;
  if (!z) { PZ.pos = null; render(); return; }
  PZ.pos = R.fromFEN(z.fen);
  PZ.side = PZ.pos.turn; PZ.last = null; PZ.waiting = true; PZ.fb = ''; PZ.state = 'solving'; PZ.arrows = null; PZ.marks = null; PZ.moves = []; PZ.hints = 0;
  PZ.left = z.kind === 'mate2' ? 2 : z.kind === 'mate3' ? 3 : 1;
  save();
  render();
}
async function puzzleMove(u) {
  const z = puzzle(), p = PZ.pos;
  if (!z || !PZ.waiting) return;
  const m = R.parseUci(p, u);
  if (!m) return;
  const name = moveLabel(p, m);
  PZ.waiting = false; PZ.arrows = null; PZ.marks = null;
  R.make(p, m); PZ.moves.push(u); PZ.last = u;
  render();
  const res = R.result(p);
  if (res && res.winner === PZ.side) return puzzleSolved(`${name}，${res.reason}！`);
  const g = gen;
  PZ.fb = '<p class="note">正在检查…</p>';
  render();
  const r = await eng.run(z.fen, PZ.moves, { ms: 900 });
  if (!r || g !== gen || puzzle() !== z) return;
  if (z.kind === 'win') {
    const got = -r.score;
    if (got >= Math.min(z.score - 90, 250)) return puzzleSolved(`${name}。这样能赢得子力（引擎评估：${scoreText(got, SIDE_SHORT[PZ.side])}）。`);
    return puzzleFailed(name);
  }
  PZ.left--;
  const oppMate = mateIn(r.score); // 对方视角：负数 = 对方几步内被杀
  if (oppMate < 0 && -oppMate <= PZ.left) {
    const rm = R.parseUci(p, r.best);
    await sleep(400);
    if (g !== gen || puzzle() !== z) return;
    R.make(p, rm); PZ.moves.push(r.best); PZ.last = r.best;
    PZ.fb = `<p class="feedback ok">${esc(name)}，好棋！对方应了 ${esc(R.uci(rm) && moveLabelAfter(z, PZ.moves.length - 1))}，继续。</p>`;
    PZ.waiting = true;
    render();
    return;
  }
  puzzleFailed(name);
}
function moveLabelAfter(z, k) {
  const p = build(z.fen, PZ.moves, k), m = R.parseUci(p, PZ.moves[k]);
  return moveLabel(p, m);
}
function puzzleSolved(msg) {
  const z = puzzle();
  PZ.state = 'solved'; PZ.waiting = false;
  PZ.fb = `<p class="feedback ok">正确！${esc(msg)}</p>`;
  if (!S.done.puzzles[z.id]) { S.done.puzzles[z.id] = true; fillPuzzles(); }
  save();
  render();
}
function puzzleFailed(name) {
  const z = puzzle(), p0 = R.fromFEN(z.fen), bm = R.parseUci(p0, z.best);
  PZ.state = 'failed'; PZ.waiting = false;
  PZ.fb = `<p class="feedback no">${esc(name)} 不是正解。</p><p>正解第一步：<b>${esc(moveLabel(p0, bm))}</b>。</p><ul>${R.describe(p0, bm).map(r => `<li>${esc(r)}</li>`).join('')}</ul><p class="note">点“重做”再试一次。</p>`;
  render();
}
function puzzleHint() {
  const z = puzzle();
  if (!z || !PZ.waiting) return;
  const p = PZ.pos;
  PZ.hints++;
  if (PZ.hints === 1) {
    PZ.fb = `<p class="note">提示：${z.kind === 'win' ? '找找对方没有保护的子，或者一步棋同时攻击两个子。' : IS_CHESS ? '先看看所有能将军的走法（将军的走法最有力）。' : '先看看所有能将军的走法，注意对方将（帅）能躲到哪里。'}</p>`;
  } else {
    const u = PZ.moves.length ? null : z.best;
    if (u) { PZ.marks = [u.slice(0, 2)]; PZ.fb = '<p class="note">提示：动蓝圈里的这个子。</p>'; } else {
      eng.run(z.fen, PZ.moves, { ms: 600 }).then(r => { if (r && r.best) { PZ.arrows = [[r.best, '#e65100']]; render(); } });
    }
  }
  void p;
  render();
}
function puzzleHtml() {
  const z = puzzle();
  if (!z) return '<p class="empty">还没有练习题。</p>';
  const done = Object.keys(S.done.puzzles).length;
  let h = `<div class="cm game"><div class="h"><span class="pz-kind">${KIND[z.kind]}</span><b>第 ${S.practice.pi + 1} 题</b><span class="wr">已完成 ${done} / ${DATA.puzzles.length}</span></div>`;
  h += `<p>${SIDES[PZ.side]}先走，${z.kind === 'win' ? '找到能得子（赢得子力）的一步。' : `${z.kind === 'mate1' ? '一步' : z.kind === 'mate2' ? '两步之内' : '三步之内'}${IS_CHESS ? '将死' : '杀死'}对方。`}${z.src ? `<span class="note">（${esc(z.src)}）</span>` : ''}</p>`;
  return h + PZ.fb + '</div>';
}
function fillPuzzles() {
  $('selPuzzle').innerHTML = DATA.puzzles.map((z, i) => `<option value="${i}">${S.done.puzzles[z.id] ? '✓ ' : ''}${i + 1}. ${KIND[z.kind]}${z.title ? ' · ' + esc(z.title) : ''}</option>`).join('');
  $('selPuzzle').value = String(S.practice.pi);
}

// ---------------- 界面 ----------------

function setWr(left, frac, right) {
  const box = $('wrBox');
  if (frac === null || frac === undefined) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle('bw', IS_CHESS);
  $('wrLeft').textContent = left; $('wrRight').textContent = right;
  $('wrFill').style.width = `${Math.round(frac * 100)}%`;
}

function movesHtml(names, cur, clickable, marks) {
  let h = '';
  names.forEach((n, i) => {
    if (i % 2 === 0) h += `<span class="num">${i / 2 + 1}.</span>`;
    const cls = [i + 1 === cur ? 'on' : '', marks && marks[i] ? marks[i] : ''].join(' ').trim();
    h += `<span${cls ? ` class="${cls}"` : ''}${clickable ? ` data-k="${i + 1}"` : ''}>${esc(n)}</span>`;
  });
  return h;
}

function render() {
  const mode = S.mode;
  for (const [id, m] of [['tabPlay', 'play'], ['tabLearn', 'learn'], ['tabGames', 'games'], ['tabPractice', 'practice']]) $(id).classList.toggle('on', mode === m);
  $('playBar').hidden = mode !== 'play';
  $('viewBar').hidden = !(mode === 'play' && view !== null);
  $('learnBar').hidden = mode !== 'learn';
  $('gamesBar').hidden = mode !== 'games';
  $('practiceBar').hidden = mode !== 'practice';
  $('chkCoach').checked = S.prefs.coach;
  $('chkThreat').checked = S.prefs.threat;
  let status = '', coach = '', moves = '';
  if (mode === 'play') {
    const p = playPos(), k = S.play.moves.length;
    if (S.play.result) status = S.play.result.winner < 0 ? `和棋：${S.play.result.reason}` : `${SIDES[S.play.result.winner]}胜：${S.play.result.reason}`;
    else if (aiBusy) status = `AI（${LEVELS[S.prefs.level].name}）思考中…`;
    else status = `轮到${pvp() ? SIDES[p.turn] : p.turn === S.play.human ? `你（执${SIDE_SHORT[S.play.human]}）` : 'AI'}走 · 第 ${Math.floor(k / 2) + 1} 回合${R.inCheck(p) ? ' · 被将军了！' : ''}`;
    const la = A[k] || A[k - 1] && { score: -A[k - 1].score, stale: true };
    const lk = A[k] ? k : k - 1;
    if (la && lk >= 0) {
      const turnAt = build(S.play.fen, S.play.moves, lk).turn, me = pvp() ? 0 : S.play.human;
      const sMe = turnAt === me ? A[lk].score : -A[lk].score, w = winProb(sMe);
      setWr(`${pvp() ? SIDE_SHORT[me] : '你'} ${pct(w)}`, w, `${pvp() ? SIDE_SHORT[1 - me] : 'AI'} ${pct(1 - w)}`);
    } else setWr('', null, '');
    $('btnUndo').disabled = !S.play.moves.length;
    $('btnHint').disabled = !canHumanMove();
    $('btnResign').disabled = !!S.play.result || pvp();
    $('btnHint').classList.toggle('on', !!hint);
    const list = [];
    if (hint && HINT_HTML) list.push(HINT_HTML);
    if (S.prefs.coach) {
      const cs = Object.values(S.play.comments).sort((a, b) => b.j - a.j);
      for (const c of cs.slice(0, 20)) list.push(commentHtml(c));
    }
    if (!list.length) list.push(`<p class="empty">${S.prefs.coach ? '走棋后，这里会逐手点评：好不好、为什么、更好的走法是什么。' : '讲解已关闭。'}<br>点棋子，再点要去的位置；有圆点的地方都可以走。</p>`);
    coach = list.join('');
    const names = [], marks = [];
    const q = R.fromFEN(S.play.fen);
    for (const u of S.play.moves) { const m = R.parseUci(q, u); if (!m) break; names.push(IS_CHESS ? R.san(q, m) : R.moveName(q, m)); R.make(q, m); }
    for (const c of Object.values(S.play.comments)) if ((pvp() || c.mover === S.play.human) && c.q >= 3) marks[c.j] = c.q >= 4 ? 'bad' : 'slow';
    moves = movesHtml(names, view === null ? names.length : view, true, marks);
    if (view !== null) $('viewText').textContent = `回看：第 ${view} 手之后`;
  } else if (mode === 'learn') {
    const l = lesson();
    status = l ? `${l.stage ? l.stage + ' · ' : ''}${Object.keys(S.done.lessons).length} / ${DATA.lessons.length} 课已完成` : '';
    setWr('', null, '');
    coach = learnHtml();
    $('btnStepPrev').disabled = S.learn.li === 0 && S.learn.si === 0;
    $('btnStepHint').disabled = !L.waiting;
  } else if (mode === 'games') {
    const g = gameList()[S.games.gi];
    status = g ? `${SIDES[build(g.fen, g.moves, S.games.idx).turn]}走` : '';
    if (GS.eval) {
      const p = build(g.fen, g.moves, S.games.idx), s0 = p.turn === 0 ? GS.eval.score : -GS.eval.score, w = winProb(s0);
      setWr(`${SIDE_SHORT[0]} ${pct(w)}`, w, `${SIDE_SHORT[1]} ${pct(1 - w)}`);
    } else setWr('', null, '');
    coach = gamesHtml();
    if (g) {
      $('rngGame').max = String(g.moves.length); $('rngGame').value = String(S.games.idx);
      moves = movesHtml(gameNames(g).map(n => n.san), S.games.idx, true);
    }
    $('btnGAuto').textContent = GS.auto ? '停止播放' : '自动播放';
  } else {
    const z = puzzle();
    status = z ? `${SIDES[PZ.side]}先走 · ${KIND[z.kind]}` : '';
    setWr('', null, '');
    coach = puzzleHtml();
    $('btnPzHint').disabled = !PZ.waiting;
  }
  $('status').textContent = status;
  $('coach').innerHTML = coach;
  $('moveList').innerHTML = moves;
  $('moveList').hidden = !moves;
  draw();
}

function setMode(m) {
  if (S.mode === m) return;
  eng.cancel();
  gen++;
  aiBusy = false;
  stopAuto();
  S.mode = m; sel = -1; view = null; hint = null;
  save();
  if (m === 'learn') loadStep();
  else if (m === 'practice') loadPuzzle();
  else if (m === 'games') gameGo(S.games.idx);
  else { Aprom = []; render(); advance(); }
  render();
}

function fillGames() {
  const list = gameList();
  if (S.games.gi >= list.length) S.games = { gi: 0, idx: 0 };
  $('selGame').innerHTML = list.map((g, i) => `<option value="${i}">${esc(g.title)}</option>`).join('');
  $('selGame').value = String(S.games.gi);
}

function stopAuto() { if (GS.auto) { clearInterval(GS.auto); GS.auto = null; } }

// ---------------- 事件 ----------------

$('tabPlay').addEventListener('click', () => setMode('play'));
$('tabLearn').addEventListener('click', () => setMode('learn'));
$('tabGames').addEventListener('click', () => setMode('games'));
$('tabPractice').addEventListener('click', () => setMode('practice'));

const dlgNew = $('dlgNew'), fNew = dlgNew.querySelector('form');
fNew.side.innerHTML = `<option value="0">${SIDES[0]}（先走）</option><option value="1">${SIDES[1]}（后走）</option>`;
fNew.level.innerHTML = LEVELS.map((l, i) => `<option value="${i}">${l.name}${l.note ? `（${l.note}）` : ''}</option>`).join('');
$('levelNote').textContent = IS_CHESS ? '引擎完全离线运行。“入门”“初级”会故意走一些软着，适合练习。' : '引擎完全离线运行。“入门”“初级”会故意走一些软着，适合练习。本程序把长将、长捉等重复局面都按和棋处理。';
$('btnNew').addEventListener('click', () => {
  fNew.opp.value = S.play.opp; fNew.side.value = String(S.play.human); fNew.level.value = String(S.prefs.level);
  dlgNew.returnValue = '';
  dlgNew.showModal();
});
dlgNew.addEventListener('close', () => {
  const rv = dlgNew.returnValue;
  if (rv !== 'ok' && rv !== 'apply') return;
  S.prefs.level = +fNew.level.value;
  if (rv === 'apply') { save(); render(); toast('难度已更新'); return; }
  newGame({ opp: fNew.opp.value, human: +fNew.side.value });
});
$('btnUndo').addEventListener('click', undo);
$('btnHint').addEventListener('click', () => { if (hint) { hint = null; render(); } else showHint(); });
$('btnFlip').addEventListener('click', () => { S.flip = !S.flip; save(); draw(); });
$('btnResign').addEventListener('click', () => {
  if (S.play.result || pvp()) return;
  finishGame({ winner: 1 - S.play.human, reason: '你认输了' });
});
$('chkCoach').addEventListener('change', e => { S.prefs.coach = e.target.checked; save(); render(); if (S.mode === 'play') advance(); });
$('chkThreat').addEventListener('change', e => { S.prefs.threat = e.target.checked; save(); render(); });
$('coach').addEventListener('click', e => {
  const c = e.target.closest('[data-j]');
  if (c && S.mode === 'play') { view = +c.dataset.j; render(); }
});
$('moveList').addEventListener('click', e => {
  const s = e.target.closest('[data-k]');
  if (!s) return;
  const k = +s.dataset.k;
  if (S.mode === 'play') { view = k === S.play.moves.length ? null : k; render(); } else if (S.mode === 'games') { stopAuto(); gameGo(k); }
});
$('btnViewPrev').addEventListener('click', () => { view = Math.max(0, (view === null ? S.play.moves.length : view) - 1); render(); });
$('btnViewNext').addEventListener('click', () => { const v = (view === null ? S.play.moves.length : view) + 1; view = v >= S.play.moves.length ? null : v; render(); });
$('btnViewBack').addEventListener('click', () => { view = null; render(); });

$('selLesson').addEventListener('change', e => { S.learn = { li: +e.target.value, si: 0 }; loadStep(); });
$('btnStepPrev').addEventListener('click', () => stepGo(-1));
$('btnStepNext').addEventListener('click', () => stepGo(1));
$('btnStepRetry').addEventListener('click', () => { gen++; loadStep(); });
$('btnStepHint').addEventListener('click', learnHint);

$('selGame').addEventListener('change', e => { stopAuto(); S.games = { gi: +e.target.value, idx: 0 }; GS.names = null; gameGo(0); });
$('btnGFirst').addEventListener('click', () => { stopAuto(); gameGo(0); });
$('btnGPrev').addEventListener('click', () => { stopAuto(); gameGo(S.games.idx - 1); });
$('btnGNext').addEventListener('click', () => { stopAuto(); gameGo(S.games.idx + 1); });
$('btnGLast').addEventListener('click', () => { stopAuto(); const g = gameList()[S.games.gi]; if (g) gameGo(g.moves.length); });
$('btnGAuto').addEventListener('click', () => {
  if (GS.auto) { stopAuto(); render(); return; }
  GS.auto = setInterval(() => {
    const g = gameList()[S.games.gi];
    if (!g || S.games.idx >= g.moves.length || S.mode !== 'games') { stopAuto(); render(); return; }
    gameGo(S.games.idx + 1);
  }, 1800);
  render();
});
$('rngGame').addEventListener('input', e => { stopAuto(); gameGo(+e.target.value); });

$('selPuzzle').addEventListener('change', e => { gen++; S.practice.pi = +e.target.value; loadPuzzle(); });
$('btnPzPrev').addEventListener('click', () => { gen++; S.practice.pi = Math.max(0, S.practice.pi - 1); $('selPuzzle').value = String(S.practice.pi); loadPuzzle(); });
$('btnPzNext').addEventListener('click', () => { gen++; S.practice.pi = Math.min(DATA.puzzles.length - 1, S.practice.pi + 1); $('selPuzzle').value = String(S.practice.pi); loadPuzzle(); });
$('btnPzRetry').addEventListener('click', () => { gen++; loadPuzzle(); });
$('btnPzHint').addEventListener('click', puzzleHint);

$('btnTheme').addEventListener('click', () => {
  const t = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('weiqi-theme', t); } catch (e) { /* 忽略 */ }
  draw();
});

const HELP = {
  xiangqi: `<h3>怎么用</h3><ul>
    <li><b>学习</b>：从认识棋盘开始，一课一课学每个子怎么走、怎么将军、基本杀法和开局。课里有“请走一步”的小任务，走对了才算学会。</li>
    <li><b>练习</b>：一步杀、两步杀、得子题。答错会告诉你正解和原因。</li>
    <li><b>对战</b>：和 AI 下，五档难度。打开“讲解”后，每一步都会点评好坏、原因和更好的走法；“标出危险”会用红圈标出你可能被吃的子。</li>
    <li><b>棋谱</b>：经典开局和你自己下完的对局，一步步看，引擎会给出评估和建议（蓝色箭头）。</li></ul>
    <h3>规则说明</h3><p>困毙（无子可动）算输。长将、长捉等复杂规则本程序简化为：同一局面重复三次判和。</p>
    <p>全部离线运行，不需要网络。左上角“三条线”菜单可以切换回围棋或国际象棋。</p>`,
  chess: `<h3>怎么用</h3><ul>
    <li><b>学习</b>：从棋盘和每个子的走法开始，学将军、将死、王车易位、吃过路兵、升变、开局原则、基本战术和基本杀法。课里有小任务，走对了才算学会。</li>
    <li><b>练习</b>：一步杀、两步杀、得子题。答错会告诉你正解和原因。</li>
    <li><b>对战</b>：和 AI 下，五档难度。打开“讲解”后每一步都会点评；“标出危险”会用红圈标出你没保护好的子。</li>
    <li><b>棋谱</b>：著名对局（歌剧院之局、不朽之局等）和你自己下完的对局，引擎会给出评估和建议。</li></ul>
    <p>全部离线运行，不需要网络。左上角“三条线”菜单可以切换回围棋或中国象棋。</p>`,
};
$('btnHelp').addEventListener('click', () => {
  $('helpTitle').textContent = `${GAME_NAME} · 说明`;
  $('helpBody').innerHTML = HELP[GAME];
  $('dlgHelp').showModal();
});

addEventListener('resize', () => layout());

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  let had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) $('updateBar').hidden = false; had = true; });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
$('btnReload').addEventListener('click', () => location.reload());

// ---------------- 启动 ----------------
load();
if (S.learn.li >= DATA.lessons.length) S.learn = { li: 0, si: 0 };
if (S.practice.pi >= DATA.puzzles.length) S.practice.pi = 0;
fillLessons();
fillPuzzles();
fillGames();
layout();
const m0 = S.mode;
S.mode = '';
setMode(m0 || 'play');
