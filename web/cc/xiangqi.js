/* 中国象棋规则：走法生成、FEN、中文记谱（炮二平五）、讲解、评估函数。
 * 棋盘下标 sq = (行+2)*16 + (列+2)，行 0 是红方底线，列 0 是红方左手边。
 * 和 chess.js 接口相同，搜索和界面可以共用。 */
function ccXiangqi(root) {
  'use strict';
  const RED = 0, BLACK = 1;
  const K = 1, A = 2, E = 3, N = 4, R = 5, C = 6, P = 7;
  const NAMES_R = ['', '帅', '仕', '相', '马', '车', '炮', '兵'];
  const NAMES_B = ['', '将', '士', '象', '马', '车', '炮', '卒'];
  const LET = ' KABNRCP';
  const VAL = [0, 10000, 200, 200, 400, 900, 450, 100];
  const SCORE = [0, 0, 2, 2, 4, 9, 4.5, 1];
  const START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
  const sqOf = (r, f) => (r + 2) * 16 + f + 2;
  const rowOf = s => (s >> 4) - 2, colOf = s => (s & 15) - 2;
  const INB = new Uint8Array(256), PALACE = [new Uint8Array(256), new Uint8Array(256)], SIDE = [new Uint8Array(256), new Uint8Array(256)];
  for (let r = 0; r < 10; r++) {
    for (let f = 0; f < 9; f++) {
      const s = sqOf(r, f);
      INB[s] = 1;
      if (f >= 3 && f <= 5 && r <= 2) PALACE[RED][s] = 1;
      if (f >= 3 && f <= 5 && r >= 7) PALACE[BLACK][s] = 1;
      SIDE[r <= 4 ? RED : BLACK][s] = 1;
    }
  }
  const ORTH = [1, -1, 16, -16], DIAG = [15, 17, -15, -17];
  // 马：[走法, 马腿]
  const KN = [[33, 16], [31, 16], [-33, -16], [-31, -16], [18, 1], [-14, 1], [14, -1], [-18, -1]];
  // 反查“能跳到这里的马”：马在 s - d，马腿在 s - d + leg
  const ELE = [[34, 17], [30, 15], [-34, -17], [-30, -15]];

  let seed = 0x6a09e667;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const ZL = new Int32Array(16 * 256), ZH = new Int32Array(16 * 256);
  for (let i = 0; i < ZL.length; i++) { ZL[i] = rnd(); ZH[i] = rnd(); }
  const ZSL = rnd(), ZSH = rnd();

  const color = x => x >> 3, type = x => x & 7;
  const mv = (f, t) => f | (t << 8);
  const mFrom = m => m & 255, mTo = m => (m >> 8) & 255, mPromo = () => 0, mFlag = () => 0;

  class Pos {
    constructor() {
      this.b = new Int8Array(256);
      this.turn = RED; this.k = [0, 0]; this.hl = 0; this.hh = 0;
      this.half = 0; this.full = 1; this.stack = []; this.hist = [];
    }
    clone() {
      const p = new Pos();
      p.b.set(this.b);
      p.turn = this.turn; p.k = this.k.slice(); p.hl = this.hl; p.hh = this.hh; p.half = this.half; p.full = this.full;
      p.hist = this.hist.slice();
      return p;
    }
    rehash() {
      let l = 0, h = 0;
      for (let s = 0; s < 256; s++) if (this.b[s]) { l ^= ZL[this.b[s] * 256 + s]; h ^= ZH[this.b[s] * 256 + s]; }
      if (this.turn) { l ^= ZSL; h ^= ZSH; }
      this.hl = l; this.hh = h;
    }
  }

  function fromFEN(fen) {
    const p = new Pos(), parts = fen.trim().split(/\s+/);
    let r = 9, f = 0;
    for (const ch of parts[0]) {
      if (ch === '/') { r--; f = 0; continue; }
      if (/\d/.test(ch)) { f += +ch; continue; }
      let u = ch.toUpperCase();
      if (u === 'H') u = 'N'; if (u === 'E') u = 'B';
      const t = Math.max(0, LET.indexOf(u)); // LET 里 B 的位置正好是相（E）
      const c = ch === ch.toUpperCase() ? RED : BLACK, s = sqOf(r, f);
      p.b[s] = t | (c << 3);
      if (t === K) p.k[c] = s;
      f++;
    }
    p.turn = parts[1] === 'b' ? BLACK : RED;
    p.half = +parts[4] || 0; p.full = +parts[5] || 1;
    p.rehash();
    return p;
  }

  function toFEN(p) {
    let out = '';
    for (let r = 9; r >= 0; r--) {
      let e = 0;
      for (let f = 0; f < 9; f++) {
        const x = p.b[sqOf(r, f)];
        if (!x) { e++; continue; }
        if (e) { out += e; e = 0; }
        const ch = type(x) === E ? 'B' : LET[type(x)];
        out += color(x) ? ch.toLowerCase() : ch;
      }
      if (e) out += e;
      if (r) out += '/';
    }
    return `${out} ${p.turn ? 'b' : 'w'} - - ${p.half} ${p.full}`;
  }

  /** 两个将帅在同一列、中间没有子（“白脸将”） */
  function facing(p) {
    const a = p.k[0], b = p.k[1];
    if ((a & 15) !== (b & 15)) return false;
    for (let s = a + 16; s < b; s += 16) if (p.b[s]) return false;
    return true;
  }

  function attackers(p, s, by) {
    const out = [], b = p.b, cb = by << 3;
    for (const d of ORTH) {
      let t = s + d, screen = false;
      for (; INB[t]; t += d) {
        const x = b[t];
        if (!x) continue;
        if (!screen) {
          if (x === (R | cb)) out.push(t);
          screen = true;
        } else {
          if (x === (C | cb)) out.push(t);
          break;
        }
      }
    }
    for (const [d, leg] of KN) {
      const n = s - d;
      if (INB[n] && b[n] === (N | cb) && !b[n + leg]) out.push(n);
    }
    // 兵
    const fwd = by === RED ? 16 : -16;
    if (INB[s - fwd] && b[s - fwd] === (P | cb)) out.push(s - fwd);
    for (const d of [1, -1]) {
      const n = s + d;
      if (INB[n] && b[n] === (P | cb) && !SIDE[by][n]) out.push(n);
    }
    // 将帅、仕、相只在自己的地盘里
    if (PALACE[by][s]) {
      for (const d of ORTH) if (b[s + d] === (K | cb)) out.push(s + d);
      for (const d of DIAG) if (b[s + d] === (A | cb)) out.push(s + d);
    }
    if (SIDE[by][s]) for (const [d, eye] of ELE) if (INB[s + d] && b[s + d] === (E | cb) && !b[s + eye]) out.push(s + d);
    return out;
  }

  function attacked(p, s, by) { return attackers(p, s, by).length > 0; }
  const inCheck = p => attacked(p, p.k[p.turn], p.turn ^ 1) || facing(p);

  function genMoves(p, caps) {
    const out = [], b = p.b, us = p.turn, them = us ^ 1;
    const add = (s, t) => {
      const y = b[t];
      if (!y) { if (!caps) out.push(mv(s, t)); } else if (color(y) === them) out.push(mv(s, t));
    };
    for (let s = 34; s < 190; s++) {
      const x = b[s];
      if (!x || color(x) !== us) continue;
      switch (type(x)) {
        case K: for (const d of ORTH) if (PALACE[us][s + d]) add(s, s + d); break;
        case A: for (const d of DIAG) if (PALACE[us][s + d]) add(s, s + d); break;
        case E: for (const [d, eye] of ELE) if (INB[s + d] && SIDE[us][s + d] && !b[s + eye]) add(s, s + d); break;
        case N: for (const [d, leg] of KN) if (INB[s + d] && !b[s + leg]) add(s, s + d); break;
        case R:
          for (const d of ORTH) for (let t = s + d; INB[t]; t += d) { add(s, t); if (b[t]) break; }
          break;
        case C:
          for (const d of ORTH) {
            let t = s + d;
            for (; INB[t] && !b[t]; t += d) if (!caps) out.push(mv(s, t));
            for (t += d; INB[t]; t += d) if (b[t]) { if (color(b[t]) === them) out.push(mv(s, t)); break; }
          }
          break;
        case P: {
          const fwd = us === RED ? 16 : -16;
          if (INB[s + fwd]) add(s, s + fwd);
          if (!SIDE[us][s]) for (const d of [1, -1]) if (INB[s + d]) add(s, s + d);
          break;
        }
      }
    }
    return out;
  }

  function make(p, m) {
    const f = mFrom(m), t = mTo(m), us = p.turn, x = p.b[f], cap = p.b[t];
    p.stack.push({ m, cap, hl: p.hl, hh: p.hh, half: p.half, k: p.k[us] });
    p.hist.push(p.hl);
    p.hl ^= ZL[x * 256 + f] ^ ZL[x * 256 + t] ^ ZSL; p.hh ^= ZH[x * 256 + f] ^ ZH[x * 256 + t] ^ ZSH;
    if (cap) { p.hl ^= ZL[cap * 256 + t]; p.hh ^= ZH[cap * 256 + t]; }
    p.b[t] = x; p.b[f] = 0;
    if (type(x) === K) p.k[us] = t;
    p.half = cap ? 0 : p.half + 1;
    if (us === BLACK) p.full++;
    p.turn ^= 1;
    if (attacked(p, p.k[us], us ^ 1) || facing(p)) { unmake(p); return false; }
    return true;
  }

  function unmake(p) {
    const u = p.stack.pop();
    p.hist.pop();
    p.turn ^= 1;
    const f = mFrom(u.m), t = mTo(u.m);
    p.b[f] = p.b[t]; p.b[t] = u.cap;
    p.k[p.turn] = u.k;
    if (p.turn === BLACK) p.full--;
    p.hl = u.hl; p.hh = u.hh; p.half = u.half;
  }

  function makeNull(p) {
    p.stack.push({ nul: true, hl: p.hl, hh: p.hh, half: p.half });
    p.hist.push(p.hl);
    p.turn ^= 1; p.hl ^= ZSL; p.hh ^= ZSH; p.half++;
  }
  function unmakeNull(p) {
    const u = p.stack.pop();
    p.hist.pop();
    p.turn ^= 1; p.hl = u.hl; p.hh = u.hh; p.half = u.half;
  }

  function legalMoves(p) {
    const out = [];
    for (const m of genMoves(p, false)) if (make(p, m)) { unmake(p); out.push(m); }
    return out;
  }

  function repetitions(p) {
    let n = 0;
    for (let i = p.hist.length - 2; i >= 0 && i >= p.hist.length - p.half; i -= 2) if (p.hist[i] === p.hl) n++;
    return n;
  }

  function hasAttackers(p, c) {
    for (let s = 34; s < 190; s++) {
      const t = type(p.b[s]);
      if (p.b[s] && color(p.b[s]) === c && (t === N || t === R || t === C || t === P)) return true;
    }
    return false;
  }

  function result(p) {
    if (!legalMoves(p).length) return { winner: p.turn ^ 1, reason: inCheck(p) ? '将死' : '困毙（无子可动，也算输）' };
    if (!hasAttackers(p, RED) && !hasAttackers(p, BLACK)) return { winner: -1, reason: '双方都没有能过河进攻的子' };
    if (p.half >= 120) return { winner: -1, reason: '60 回合没有吃子' };
    if (repetitions(p) >= 2) return { winner: -1, reason: '同一局面重复三次（本程序按和棋处理）' };
    return null;
  }

  // ---------------- 记谱：炮二平五、马8进7 ----------------
  const CN = '零一二三四五六七八九';
  const fileNum = (c, f) => (c === RED ? CN[9 - f] : String(f + 1));
  const steps = (c, n) => (c === RED ? CN[n] : String(n));
  const pieceName = x => (color(x) === RED ? NAMES_R : NAMES_B)[type(x)];

  function moveName(p, m) {
    const f = mFrom(m), t = mTo(m), x = p.b[f], c = color(x), ty = type(x);
    const r1 = rowOf(f), c1 = colOf(f), r2 = rowOf(t), c2 = colOf(t);
    // 同一列有同种的子：用前、后（中）区分
    const same = [];
    for (let r = 0; r < 10; r++) if (p.b[sqOf(r, c1)] === x) same.push(r);
    let head;
    if (same.length >= 2) {
      const order = c === RED ? same.slice().sort((a, b) => b - a) : same.slice().sort((a, b) => a - b); // 离对方近的是“前”
      const i = order.indexOf(r1);
      const tags = same.length === 2 ? ['前', '后'] : same.length === 3 ? ['前', '中', '后'] : ['一', '二', '三', '四', '五'];
      head = tags[i] + pieceName(x);
    } else head = pieceName(x) + fileNum(c, c1);
    const fwd = c === RED ? r2 > r1 : r2 < r1;
    if (r1 === r2) return `${head}平${fileNum(c, c2)}`;
    const dir = fwd ? '进' : '退';
    if (ty === A || ty === E || ty === N) return `${head}${dir}${fileNum(c, c2)}`;
    return `${head}${dir}${steps(c, Math.abs(r2 - r1))}`;
  }
  const san = moveName;

  const COLS = 'abcdefghi';
  const uci = m => COLS[colOf(mFrom(m))] + rowOf(mFrom(m)) + COLS[colOf(mTo(m))] + rowOf(mTo(m));
  function parseUci(p, s) {
    for (const m of legalMoves(p)) if (uci(m) === s) return m;
    return 0;
  }
  function parseSan(p, s) {
    const t = s.trim().replace(/[１-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    for (const m of legalMoves(p)) {
      const nm = moveName(p, m);
      if (nm === t || nm.replace(/[将帅]/, '将') === t.replace(/[将帅]/, '将') || nm.replace('象', '相').replace('卒', '兵').replace('士', '仕').replace('将', '帅') === t.replace('象', '相').replace('卒', '兵').replace('士', '仕').replace('将', '帅')) return m;
    }
    if (/^[a-i]\d[a-i]\d$/.test(t)) return parseUci(p, t);
    return 0;
  }
  const sqName = s => `${COLS[colOf(s)]}${rowOf(s)}`;
  const sideName = c => (c === RED ? '红方' : '黑方');

  // ---------------- 评估 ----------------
  // 表格按红方视角：行 0 = 红方底线
  const PST = {};
  PST[P] = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, -5, 0, 5, 0, -5, 0, 0], [5, 0, 10, 0, 15, 0, 10, 0, 5],
    [60, 70, 80, 90, 95, 90, 80, 70, 60], [70, 90, 110, 120, 125, 120, 110, 90, 70], [80, 100, 120, 130, 140, 130, 120, 100, 80],
    [70, 90, 110, 130, 140, 130, 110, 90, 70], [10, 20, 30, 40, 50, 40, 30, 20, 10],
  ];
  const mk = fn => Array.from({ length: 10 }, (_, r) => Array.from({ length: 9 }, (__, f) => fn(r, f)));
  PST[N] = mk((r, f) => 4 * (4 - Math.abs(f - 4)) + (r >= 5 ? 25 : r >= 3 ? 10 : 0) + (r === 7 || r === 8 ? 15 : 0) - (f === 0 || f === 8 ? 15 : 0) - (r === 0 ? 10 : 0));
  PST[C] = mk((r, f) => (f === 4 ? 20 : 0) + (r === 2 && (f === 1 || f === 7) ? 5 : 0) + (r >= 7 ? 10 : 0) + (r === 9 ? 5 : 0) + 2 * (4 - Math.abs(f - 4)));
  PST[R] = mk((r, f) => (r >= 5 ? 15 : 0) + (r === 7 || r === 8 ? 10 : 0) + 3 * (4 - Math.abs(f - 4)) - (r === 0 && (f === 0 || f === 8) ? 10 : 0));
  PST[A] = mk((r, f) => (r === 1 && f === 4 ? 8 : 0));
  PST[E] = mk((r, f) => (r === 2 && f === 4 ? 8 : 0) + (r === 0 && (f === 2 || f === 6) ? 2 : 0));
  PST[K] = mk((r, f) => -10 * r - (f !== 4 ? 5 : 0));

  function evaluate(p) {
    const b = p.b;
    let s = 0;
    const defenders = [0, 0];
    for (let q = 34; q < 190; q++) {
      const x = b[q];
      if (!x) continue;
      const c = color(x), t = type(x), r = rowOf(q), f = colOf(q);
      const rr = c === RED ? r : 9 - r, ff = c === RED ? f : 8 - f;
      let v = (t === K ? 0 : VAL[t]) + PST[t][rr][ff];
      if (t === R) {
        // 车的灵活性
        let mob = 0;
        for (const d of ORTH) for (let u = q + d; INB[u]; u += d) { mob++; if (b[u]) break; }
        v += mob * 3;
      } else if (t === N) {
        let mob = 0;
        for (const [d, leg] of KN) if (INB[q + d] && !b[q + leg] && (!b[q + d] || color(b[q + d]) !== c)) mob++;
        v += mob * 5 - 10;
      }
      if (t === A || t === E) defenders[c]++;
      s += c === RED ? v : -v;
    }
    // 缺士少象，炮和车的攻击更有威胁（简单处理）
    s += (defenders[RED] - defenders[BLACK]) * 10;
    return p.turn === RED ? s : -s;
  }

  function captureValue(p, m) {
    return VAL[type(p.b[mTo(m)])] * 10 - VAL[type(p.b[mFrom(m)])] / 100;
  }
  const isCapture = (p, m) => !!p.b[mTo(m)];

  // ---------------- 讲解 ----------------

  function hanging(p, c) {
    const out = [];
    for (let s = 34; s < 190; s++) {
      const x = p.b[s];
      if (!x || color(x) !== c || type(x) === K) continue;
      const att = attackers(p, s, c ^ 1);
      if (!att.length) continue;
      const def = attackers(p, s, c);
      const cheapest = Math.min(...att.map(a => VAL[type(p.b[a])]));
      if (!def.length || cheapest < VAL[type(x)]) out.push(s);
    }
    return out;
  }

  function describe(p, m, me) {
    me = me || '你';
    const out = [], f = mFrom(m), t = mTo(m), x = p.b[f], us = p.turn, them = us ^ 1, ty = type(x);
    const cap = p.b[t];
    const beforeHang = hanging(p, us);
    const early = p.full <= 10;
    if (cap) out.push(`吃掉${sideName(them)}的${pieceName(cap)}（约 ${SCORE[type(cap)]} 分）。`);
    if (!make(p, m)) return ['这步棋不合规则。'];
    const chk = inCheck(p), legal = legalMoves(p);
    if (!legal.length) out.push(chk ? '绝杀！对方的将（帅）无路可走，比赛结束。' : '困毙！对方一步棋都走不了，也算输。');
    else if (chk) out.push('将军！对方必须先应将（躲开、垫子挡住或吃掉将军的子）。');
    const targets = [];
    for (let s = 34; s < 190; s++) {
      const y = p.b[s];
      if (!y || color(y) !== them || type(y) === K) continue;
      if (attackers(p, s, us).includes(t)) {
        const defended = attackers(p, s, them).length > 0;
        if (!defended || VAL[type(y)] > VAL[ty]) targets.push(s);
      }
    }
    if (targets.length >= 2) out.push(`双捉：这个${pieceName(x)}同时捉${targets.map(s => pieceName(p.b[s])).join('、')}，对方很难都保住。`);
    else if (targets.length && !chk) out.push(`捉对方的${pieceName(p.b[targets[0]])}${attackers(p, targets[0], them).length ? '（它比你这个子值钱）' : '（它没有保护）'}。`);
    else if (targets.length && chk) out.push(`将军的同时还捉着对方的${pieceName(p.b[targets[0]])}（抽将），对方应将后就能吃掉它。`);
    const afterHang = hanging(p, us);
    const saved = beforeHang.filter(s => s === f || !afterHang.includes(s));
    if (saved.length && !cap) out.push('把受到威胁的子救了出来。');
    const newHang = afterHang.filter(s => !beforeHang.includes(s) || s === t);
    if (newHang.length && legal.length) out.push(`小心：${me}的${newHang.map(s => pieceName(p.b[s])).join('、')}可能被对方吃掉${attackers(p, newHang[0], us).length ? '（对方用更便宜的子来换也划算）' : '，它没有保护'}。`);
    unmake(p);
    const r1 = rowOf(f), r2 = rowOf(t), c2 = colOf(t);
    const home = us === RED ? 0 : 9;
    if (ty === C && c2 === 4 && early && colOf(f) !== 4) out.push('架中炮（当头炮）：炮瞄准对方中路的兵和将，是最常见的进攻开局。');
    if (ty === N && r1 === home && early) out.push('跳马：马从底线跳出来，保护中兵、准备出车，是开局要务。');
    if (ty === R && early && (r1 === home) && !cap) out.push('出车：车是威力最大的子，要尽早出动（“三步不出车，必定要输棋”）。');
    if ((ty === E || ty === A) && early) out.push(ty === E ? '飞相：巩固防守，相连在一起互相保护。' : '补士：加固九宫，防止对方的车马杀进来。');
    if (ty === P && SIDE[us][f] && !SIDE[us][t]) out.push('兵过河：过河以后可以横着走，威力大增。');
    if (!out.length) out.push(ty === P ? '挺兵：活通马路，或者准备过河。' : `调整${pieceName(x)}的位置。`);
    void r2;
    return out;
  }

  // 画面坐标：x 0..8 左到右，y 0..9 上到下（红方在下）
  const W = 9, H = 10;
  const sqAt = (x, y) => sqOf(9 - y, x);
  const xyOf = s => [colOf(s), 9 - rowOf(s)];

  root.Xiangqi = {
    id: 'xiangqi', WHITE: RED, BLACK, RED, K, A, E, N, R, C, P, NAMES_R, NAMES_B, VAL, SCORE, START, W, H,
    Pos, fromFEN, toFEN, genMoves, make, unmake, makeNull, unmakeNull, legalMoves, inCheck, attacked, attackers,
    result, repetitions, san, parseSan, uci, parseUci, moveName, evaluate, captureValue, isCapture, describe, hanging,
    mFrom, mTo, mPromo, mFlag, sqName, color, type, sqAt, xyOf, sideName, pieceName, facing, rowOf, colOf, sqOf,
    nullOk: p => !inCheck(p) && hasAttackers(p, p.turn),
    drawScore: 0,
    noMovesScore: (p, ply) => -30000 + ply,
    isDraw: p => p.half >= 120 || repetitions(p) >= 1,
  };
}

if (typeof module !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'undefined') {
  ccXiangqi(globalThis);
  module.exports = globalThis.Xiangqi;
}
