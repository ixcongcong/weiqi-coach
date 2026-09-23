/* 国际象棋规则：0x88 棋盘、走法生成、FEN、SAN 记谱、中文讲解、评估函数。
 * 整个文件是一个函数，页面、Worker、Node 测试都能用。 */
function ccChess(root) {
  'use strict';
  const WHITE = 0, BLACK = 1;
  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  const NAMES = ['', '兵', '马', '象', '车', '后', '王'];
  const LET = ' PNBRQK';
  const VAL = [0, 100, 320, 330, 500, 900, 20000];
  const SCORE = [0, 1, 3, 3, 5, 9, 0]; // 给初学者看的分值
  const N_OFF = [33, 31, 18, 14, -33, -31, -18, -14];
  const B_OFF = [15, 17, -15, -17], R_OFF = [1, -1, 16, -16], K_OFF = [15, 17, -15, -17, 1, -1, 16, -16];
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[0] = 13; CASTLE_MASK[7] = 14; CASTLE_MASK[4] = 12;
  CASTLE_MASK[112] = 7; CASTLE_MASK[119] = 11; CASTLE_MASK[116] = 3;

  // Zobrist
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const ZL = new Int32Array(16 * 128), ZH = new Int32Array(16 * 128);
  for (let i = 0; i < ZL.length; i++) { ZL[i] = rnd(); ZH[i] = rnd(); }
  const ZSL = rnd(), ZSH = rnd();
  const ZCL = Int32Array.from({ length: 16 }, rnd), ZCH = Int32Array.from({ length: 16 }, rnd);
  const ZEL = Int32Array.from({ length: 8 }, rnd), ZEH = Int32Array.from({ length: 8 }, rnd);

  const color = p => p >> 3, type = p => p & 7;
  const sqName = s => 'abcdefgh'[s & 7] + ((s >> 4) + 1);
  const parseSq = t => (t.charCodeAt(1) - 49) * 16 + (t.charCodeAt(0) - 97);
  // 走法编码：from | to<<7 | promo<<14 | flag<<17（flag：1 吃过路兵，2 王车易位，4 兵走两格）
  const mv = (f, t, pr, fl) => f | (t << 7) | ((pr || 0) << 14) | ((fl || 0) << 17);
  const mFrom = m => m & 127, mTo = m => (m >> 7) & 127, mPromo = m => (m >> 14) & 7, mFlag = m => (m >> 17) & 7;

  class Pos {
    constructor() {
      this.b = new Int8Array(128);
      this.turn = WHITE; this.castle = 0; this.ep = -1; this.half = 0; this.full = 1;
      this.k = [4, 116]; this.hl = 0; this.hh = 0;
      this.stack = []; this.hist = [];
    }

    clone() {
      const p = new Pos();
      p.b.set(this.b);
      p.turn = this.turn; p.castle = this.castle; p.ep = this.ep; p.half = this.half; p.full = this.full;
      p.k = this.k.slice(); p.hl = this.hl; p.hh = this.hh;
      p.hist = this.hist.slice();
      return p;
    }

    rehash() {
      let l = 0, h = 0;
      for (let s = 0; s < 128; s++) if (!(s & 0x88) && this.b[s]) { l ^= ZL[this.b[s] * 128 + s]; h ^= ZH[this.b[s] * 128 + s]; }
      if (this.turn) { l ^= ZSL; h ^= ZSH; }
      l ^= ZCL[this.castle]; h ^= ZCH[this.castle];
      if (this.ep >= 0) { l ^= ZEL[this.ep & 7]; h ^= ZEH[this.ep & 7]; }
      this.hl = l; this.hh = h;
    }
  }

  function fromFEN(fen) {
    const p = new Pos(), [board, turn, cas, ep, half, full] = fen.trim().split(/\s+/);
    let r = 7, f = 0;
    for (const ch of board) {
      if (ch === '/') { r--; f = 0; continue; }
      if (/\d/.test(ch)) { f += +ch; continue; }
      const t = LET.indexOf(ch.toUpperCase()), c = ch === ch.toUpperCase() ? WHITE : BLACK;
      const s = r * 16 + f;
      p.b[s] = t | (c << 3);
      if (t === K) p.k[c] = s;
      f++;
    }
    p.turn = turn === 'b' ? BLACK : WHITE;
    p.castle = 0;
    if (cas && cas !== '-') for (const ch of cas) p.castle |= { K: 1, Q: 2, k: 4, q: 8 }[ch] || 0;
    p.ep = ep && ep !== '-' ? parseSq(ep) : -1;
    p.half = +half || 0; p.full = +full || 1;
    p.rehash();
    return p;
  }

  function toFEN(p) {
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let e = 0;
      for (let f = 0; f < 8; f++) {
        const x = p.b[r * 16 + f];
        if (!x) { e++; continue; }
        if (e) { out += e; e = 0; }
        const ch = LET[type(x)];
        out += color(x) ? ch.toLowerCase() : ch;
      }
      if (e) out += e;
      if (r) out += '/';
    }
    let cs = '';
    if (p.castle & 1) cs += 'K'; if (p.castle & 2) cs += 'Q'; if (p.castle & 4) cs += 'k'; if (p.castle & 8) cs += 'q';
    return `${out} ${p.turn ? 'b' : 'w'} ${cs || '-'} ${p.ep >= 0 ? sqName(p.ep) : '-'} ${p.half} ${p.full}`;
  }

  function attacked(p, s, by) {
    const b = p.b;
    if (by === WHITE) {
      if (!((s - 15) & 0x88) && b[s - 15] === P) return true;
      if (!((s - 17) & 0x88) && b[s - 17] === P) return true;
    } else {
      if (!((s + 15) & 0x88) && b[s + 15] === (P | 8)) return true;
      if (!((s + 17) & 0x88) && b[s + 17] === (P | 8)) return true;
    }
    const cb = by << 3;
    for (const o of N_OFF) { const t = s + o; if (!(t & 0x88) && b[t] === (N | cb)) return true; }
    for (const o of K_OFF) { const t = s + o; if (!(t & 0x88) && b[t] === (K | cb)) return true; }
    for (const o of B_OFF) {
      for (let t = s + o; !(t & 0x88); t += o) {
        const x = b[t];
        if (x) { if (x === (B | cb) || x === (Q | cb)) return true; break; }
      }
    }
    for (const o of R_OFF) {
      for (let t = s + o; !(t & 0x88); t += o) {
        const x = b[t];
        if (x) { if (x === (R | cb) || x === (Q | cb)) return true; break; }
      }
    }
    return false;
  }

  /** 攻击 s 格的某方棋子（位置列表） */
  function attackers(p, s, by) {
    const out = [], b = p.b, cb = by << 3;
    const pd = by === WHITE ? [-15, -17] : [15, 17];
    for (const o of pd) { const t = s + o; if (!(t & 0x88) && b[t] === (P | cb)) out.push(t); }
    for (const o of N_OFF) { const t = s + o; if (!(t & 0x88) && b[t] === (N | cb)) out.push(t); }
    for (const o of K_OFF) { const t = s + o; if (!(t & 0x88) && b[t] === (K | cb)) out.push(t); }
    for (const o of B_OFF) for (let t = s + o; !(t & 0x88); t += o) { const x = b[t]; if (x) { if (x === (B | cb) || x === (Q | cb)) out.push(t); break; } }
    for (const o of R_OFF) for (let t = s + o; !(t & 0x88); t += o) { const x = b[t]; if (x) { if (x === (R | cb) || x === (Q | cb)) out.push(t); break; } }
    return out;
  }

  const inCheck = p => attacked(p, p.k[p.turn], p.turn ^ 1);

  /** 伪合法走法（可能送将）；caps 为真时只生成吃子和升变 */
  function genMoves(p, caps) {
    const out = [], b = p.b, us = p.turn, them = us ^ 1;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const x = b[s];
      if (!x || color(x) !== us) continue;
      const t = type(x);
      if (t === P) {
        const d = us ? -16 : 16, r = s >> 4, last = us ? 1 : 6, home = us ? 6 : 1;
        const one = s + d;
        if (!(one & 0x88) && !b[one]) {
          if (r === last) for (const pr of [Q, R, B, N]) out.push(mv(s, one, pr));
          else if (!caps) {
            out.push(mv(s, one));
            if (r === home && !b[one + d]) out.push(mv(s, one + d, 0, 4));
          }
        }
        for (const o of [d - 1, d + 1]) {
          const c = s + o;
          if (c & 0x88) continue;
          if (b[c] && color(b[c]) === them) {
            if (r === last) for (const pr of [Q, R, B, N]) out.push(mv(s, c, pr));
            else out.push(mv(s, c));
          } else if (c === p.ep) out.push(mv(s, c, 0, 1));
        }
      } else if (t === N || t === K) {
        for (const o of t === N ? N_OFF : K_OFF) {
          const c = s + o;
          if (c & 0x88) continue;
          if (!b[c]) { if (!caps) out.push(mv(s, c)); } else if (color(b[c]) === them) out.push(mv(s, c));
        }
        if (t === K && !caps) {
          if (us === WHITE && s === 4) {
            if ((p.castle & 1) && !b[5] && !b[6] && b[7] === R && !attacked(p, 4, them) && !attacked(p, 5, them) && !attacked(p, 6, them)) out.push(mv(4, 6, 0, 2));
            if ((p.castle & 2) && !b[3] && !b[2] && !b[1] && b[0] === R && !attacked(p, 4, them) && !attacked(p, 3, them) && !attacked(p, 2, them)) out.push(mv(4, 2, 0, 2));
          } else if (us === BLACK && s === 116) {
            if ((p.castle & 4) && !b[117] && !b[118] && b[119] === (R | 8) && !attacked(p, 116, them) && !attacked(p, 117, them) && !attacked(p, 118, them)) out.push(mv(116, 118, 0, 2));
            if ((p.castle & 8) && !b[115] && !b[114] && !b[113] && b[112] === (R | 8) && !attacked(p, 116, them) && !attacked(p, 115, them) && !attacked(p, 114, them)) out.push(mv(116, 114, 0, 2));
          }
        }
      } else {
        const offs = t === B ? B_OFF : t === R ? R_OFF : K_OFF;
        for (const o of offs) {
          for (let c = s + o; !(c & 0x88); c += o) {
            if (!b[c]) { if (!caps) out.push(mv(s, c)); continue; }
            if (color(b[c]) === them) out.push(mv(s, c));
            break;
          }
        }
      }
    }
    return out;
  }

  function put(p, s, x) { p.b[s] = x; p.hl ^= ZL[x * 128 + s]; p.hh ^= ZH[x * 128 + s]; }
  function lift(p, s) { const x = p.b[s]; p.b[s] = 0; p.hl ^= ZL[x * 128 + s]; p.hh ^= ZH[x * 128 + s]; return x; }

  /** 走一步；送将则撤回并返回 false */
  function make(p, m) {
    const f = mFrom(m), t = mTo(m), fl = mFlag(m), us = p.turn;
    const u = { m, cap: p.b[t], castle: p.castle, ep: p.ep, half: p.half, hl: p.hl, hh: p.hh, k0: p.k[0], k1: p.k[1] };
    p.stack.push(u);
    p.hist.push(p.hl);
    if (p.ep >= 0) { p.hl ^= ZEL[p.ep & 7]; p.hh ^= ZEH[p.ep & 7]; }
    p.hl ^= ZCL[p.castle]; p.hh ^= ZCH[p.castle];
    let x = lift(p, f);
    if (u.cap) lift(p, t);
    if (fl === 1) { const cs = t + (us ? 16 : -16); u.cap = p.b[cs]; u.epSq = cs; lift(p, cs); }
    if (mPromo(m)) x = mPromo(m) | (us << 3);
    put(p, t, x);
    if (fl === 2) {
      if (t === 6) put(p, 5, lift(p, 7)); else if (t === 2) put(p, 3, lift(p, 0));
      else if (t === 118) put(p, 117, lift(p, 119)); else put(p, 115, lift(p, 112));
    }
    if (type(x) === K) p.k[us] = t;
    p.castle &= CASTLE_MASK[f] & CASTLE_MASK[t];
    p.ep = fl === 4 ? (f + t) >> 1 : -1;
    p.hl ^= ZCL[p.castle]; p.hh ^= ZCH[p.castle];
    if (p.ep >= 0) { p.hl ^= ZEL[p.ep & 7]; p.hh ^= ZEH[p.ep & 7]; }
    p.half = type(x) === P || u.cap ? 0 : p.half + 1;
    if (us === BLACK) p.full++;
    p.turn ^= 1; p.hl ^= ZSL; p.hh ^= ZSH;
    if (attacked(p, p.k[us], us ^ 1)) { unmake(p); return false; }
    return true;
  }

  function unmake(p) {
    const u = p.stack.pop();
    p.hist.pop();
    const m = u.m, f = mFrom(m), t = mTo(m), fl = mFlag(m);
    p.turn ^= 1;
    const us = p.turn;
    let x = p.b[t];
    if (mPromo(m)) x = P | (us << 3);
    p.b[f] = x;
    p.b[t] = fl === 1 ? 0 : u.cap;
    if (fl === 1) p.b[u.epSq] = u.cap;
    if (fl === 2) {
      if (t === 6) { p.b[7] = p.b[5]; p.b[5] = 0; } else if (t === 2) { p.b[0] = p.b[3]; p.b[3] = 0; }
      else if (t === 118) { p.b[119] = p.b[117]; p.b[117] = 0; } else { p.b[112] = p.b[115]; p.b[115] = 0; }
    }
    if (us === BLACK) p.full--;
    p.castle = u.castle; p.ep = u.ep; p.half = u.half; p.hl = u.hl; p.hh = u.hh; p.k[0] = u.k0; p.k[1] = u.k1;
  }

  function makeNull(p) {
    p.stack.push({ nul: true, ep: p.ep, hl: p.hl, hh: p.hh, half: p.half });
    p.hist.push(p.hl);
    if (p.ep >= 0) { p.hl ^= ZEL[p.ep & 7]; p.hh ^= ZEH[p.ep & 7]; }
    p.ep = -1; p.turn ^= 1; p.hl ^= ZSL; p.hh ^= ZSH; p.half++;
  }
  function unmakeNull(p) {
    const u = p.stack.pop();
    p.hist.pop();
    p.turn ^= 1; p.ep = u.ep; p.hl = u.hl; p.hh = u.hh; p.half = u.half;
  }

  function legalMoves(p) {
    const out = [];
    for (const m of genMoves(p, false)) if (make(p, m)) { unmake(p); out.push(m); }
    return out;
  }

  function insufficient(p) {
    let minors = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const t = type(p.b[s]);
      if (t === P || t === R || t === Q) return false;
      if (t === N || t === B) minors++;
    }
    return minors <= 1;
  }

  function repetitions(p) {
    let n = 0;
    for (let i = p.hist.length - 2; i >= 0 && i >= p.hist.length - p.half; i -= 2) if (p.hist[i] === p.hl) n++;
    return n;
  }

  /** 对局结果：null 表示还没结束；否则 { winner: 0/1/-1(和), reason } */
  function result(p) {
    const legal = legalMoves(p);
    if (!legal.length) {
      if (inCheck(p)) return { winner: p.turn ^ 1, reason: '将死' };
      return { winner: -1, reason: '逼和（无子可动又没被将军）' };
    }
    if (insufficient(p)) return { winner: -1, reason: '双方子力都不足以将死' };
    if (p.half >= 100) return { winner: -1, reason: '50 回合没有吃子也没有动兵' };
    if (repetitions(p) >= 2) return { winner: -1, reason: '同一局面重复三次' };
    return null;
  }

  // ---------------- 记谱 ----------------

  function san(p, m) {
    const f = mFrom(m), t = mTo(m), x = p.b[f], ty = type(x);
    let s;
    if (mFlag(m) === 2) s = (t & 7) === 6 ? 'O-O' : 'O-O-O';
    else {
      const cap = p.b[t] || mFlag(m) === 1;
      if (ty === P) s = (cap ? 'abcdefgh'[f & 7] + 'x' : '') + sqName(t) + (mPromo(m) ? '=' + LET[mPromo(m)] : '');
      else {
        let dis = '';
        const others = legalMoves(p).filter(o => o !== m && mTo(o) === t && p.b[mFrom(o)] === x);
        if (others.length) {
          const sameFile = others.some(o => (mFrom(o) & 7) === (f & 7)), sameRank = others.some(o => (mFrom(o) >> 4) === (f >> 4));
          dis = !sameFile ? 'abcdefgh'[f & 7] : !sameRank ? String((f >> 4) + 1) : sqName(f);
        }
        s = LET[ty] + dis + (cap ? 'x' : '') + sqName(t);
      }
    }
    if (make(p, m)) {
      if (inCheck(p)) s += legalMoves(p).length ? '+' : '#';
      unmake(p);
    }
    return s;
  }

  function parseSan(p, str) {
    const clean = str.replace(/[+#!?]/g, '').replace(/0/g, 'O');
    for (const m of legalMoves(p)) if (san(p, m).replace(/[+#]/g, '') === clean) return m;
    // 也接受 e2e4 这种写法
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(str)) return parseUci(p, str);
    return 0;
  }

  const uci = m => sqName(mFrom(m)) + sqName(mTo(m)) + (mPromo(m) ? ' pnbrqk'[mPromo(m)] : '');
  function parseUci(p, s) {
    for (const m of legalMoves(p)) if (uci(m) === s) return m;
    return 0;
  }

  const sideName = c => (c === WHITE ? '白方' : '黑方');
  /** 中文描述：马 g1→f3 */
  function moveName(p, m) {
    const x = p.b[mFrom(m)];
    if (mFlag(m) === 2) return (mTo(m) & 7) === 6 ? '短易位' : '长易位';
    return `${NAMES[type(x)]} ${sqName(mFrom(m))}→${sqName(mTo(m))}${mPromo(m) ? `（升变为${NAMES[mPromo(m)]}）` : ''}`;
  }

  // ---------------- 评估 ----------------

  const T = {
    [P]: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    [N]: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    [B]: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    [R]: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    [Q]: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  };
  const KMID = [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20];
  const KEND = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];
  const PASSED = [0, 5, 10, 20, 35, 60, 100, 0];

  /** 静态评估（从轮到走的一方看，单位：百分之一兵） */
  function evaluate(p) {
    const b = p.b;
    let mg = 0, eg = 0, phase = 0;
    const bishops = [0, 0], pawnFiles = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];
    const pawnMin = [[9, 9, 9, 9, 9, 9, 9, 9], [9, 9, 9, 9, 9, 9, 9, 9]], pawnMax = [[-1, -1, -1, -1, -1, -1, -1, -1], [-1, -1, -1, -1, -1, -1, -1, -1]];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const x = b[s];
      if (!x) continue;
      const c = color(x), t = type(x), r = s >> 4, f = s & 7;
      const idx = (c === WHITE ? 7 - r : r) * 8 + f, sg = c === WHITE ? 1 : -1;
      if (t === K) { mg += sg * KMID[idx]; eg += sg * KEND[idx]; continue; }
      const v = VAL[t] + T[t][idx];
      mg += sg * v; eg += sg * v;
      if (t === N || t === B) phase += 1; else if (t === R) phase += 2; else if (t === Q) phase += 4;
      if (t === B) bishops[c]++;
      if (t === P) {
        pawnFiles[c][f]++;
        const rr = c === WHITE ? r : 7 - r;
        if (rr < pawnMin[c][f]) pawnMin[c][f] = rr;
        if (rr > pawnMax[c][f]) pawnMax[c][f] = rr;
      }
    }
    for (let c = 0; c < 2; c++) {
      const sg = c === WHITE ? 1 : -1;
      if (bishops[c] >= 2) { mg += sg * 30; eg += sg * 40; }
      for (let f = 0; f < 8; f++) {
        if (pawnFiles[c][f] > 1) { mg -= sg * 10 * (pawnFiles[c][f] - 1); eg -= sg * 20 * (pawnFiles[c][f] - 1); }
        if (!pawnFiles[c][f]) continue;
        // 通路兵：前方和两侧没有对方的兵挡
        const rr = pawnMax[c][f];
        let passed = true;
        for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1) && passed; g++) {
          const oppFront = pawnFiles[c ^ 1][g] ? 7 - pawnMin[c ^ 1][g] : -1;
          if (oppFront > rr) passed = false;
        }
        if (passed) { mg += sg * PASSED[rr] / 2; eg += sg * PASSED[rr]; }
      }
    }
    phase = Math.min(24, phase);
    const score = (mg * phase + eg * (24 - phase)) / 24;
    return (p.turn === WHITE ? score : -score) | 0;
  }

  function captureValue(p, m) {
    const victim = mFlag(m) === 1 ? P : type(p.b[mTo(m)]);
    return VAL[victim] * 10 - VAL[type(p.b[mFrom(m)])] / 100 + (mPromo(m) ? VAL[mPromo(m)] : 0);
  }
  const isCapture = (p, m) => !!p.b[mTo(m)] || mFlag(m) === 1;

  // ---------------- 讲解（给初学者看的原因） ----------------

  /** 某方有哪些子“挂着”：被攻击且没保护，或被更便宜的子攻击 */
  function hanging(p, c) {
    const out = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
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
    const cap = mFlag(m) === 1 ? P : type(p.b[t]);
    const beforeHang = hanging(p, us);
    if (mFlag(m) === 2) out.push('王车易位：王躲到角落更安全，车也走到了中间，一步棋两个好处。');
    if (cap) out.push(`吃掉${sideName(them)}的${NAMES[cap]}（${SCORE[cap]} 分）${mFlag(m) === 1 ? '——这是“吃过路兵”' : ''}。`);
    if (mPromo(m)) out.push(`兵走到底线，升变为${NAMES[mPromo(m)]}！`);
    if (!make(p, m)) return ['这步棋不合规则。'];
    const chk = inCheck(p), legal = legalMoves(p);
    if (chk && !legal.length) out.push('将死！对方的王无路可逃，比赛结束。');
    else if (chk) out.push('将军！对方必须先应将（躲开、挡住或吃掉将军的子）。');
    else if (!legal.length) out.push('注意：对方无棋可走又没被将军，这是逼和（和棋）。');
    // 这个子现在攻击了哪些对方的子
    const targets = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const y = p.b[s];
      if (!y || color(y) !== them) continue;
      if (attackers(p, s, us).includes(t)) {
        const defended = attackers(p, s, them).length > 0;
        if (type(y) === K || !defended || VAL[type(y)] > VAL[ty]) targets.push(s);
      }
    }
    const tn = targets.filter(s => type(p.b[s]) !== K);
    if (tn.length + (chk ? 1 : 0) >= 2) out.push(`双击（捉双）：这个${NAMES[ty]}同时攻击${chk ? '王和' : ''}${tn.map(s => NAMES[type(p.b[s])]).join('、')}，对方很难都保住。`);
    else if (tn.length) out.push(`攻击对方的${NAMES[type(p.b[tn[0]])]}（${sqName(tn[0])}）${attackers(p, tn[0], them).length ? '，它比你这个子值钱' : '，它没有保护'}。`);
    const afterHang = hanging(p, us);
    const saved = beforeHang.filter(s => s === f || !afterHang.includes(s));
    if (saved.length && !cap) out.push(`把受到威胁的${NAMES[type(p.b[saved[0] === f ? t : saved[0]])] || NAMES[ty]}救了出来。`);
    const newHang = afterHang.filter(s => !beforeHang.includes(s) || s === t);
    if (newHang.length && !(chk && !legal.length)) {
      out.push(`小心：${me}的${newHang.map(s => `${NAMES[type(p.b[s])]}（${sqName(s)}）`).join('、')}${newHang.length > 1 ? '都' : ''}可能被对方吃掉${attackers(p, newHang[0], us).length ? '（虽然有保护，但对方用更便宜的子来换也划算）' : '，它没有保护'}。`);
    }
    unmake(p);
    // 开局原则
    if (p.full <= 12 && !cap && mFlag(m) !== 2) {
      const homeRank = us === WHITE ? 0 : 7;
      if ((ty === N || ty === B) && (f >> 4) === homeRank) out.push('出子：把马、象从底线走出来参加战斗，是开局最重要的事。');
      if (ty === P && [51, 52, 67, 68].includes(t)) out.push('挺中心兵：占领、控制中心（d4、e4、d5、e5 这四格）。');
      else if (ty === P && [3, 4].includes(f & 7) && Math.abs(t - f) === 16) out.push('挺兵给象让出路来，同时巩固中心。');
      if (ty === Q && p.full <= 6) out.push('开局太早出后，容易被对方一边出子一边赶着打，浪费步数。');
      if (ty === K) out.push('开局随便动王会失去易位的权利，王留在中间比较危险。');
    }
    if (ty === P && !mPromo(m) && ((us === WHITE && (t >> 4) >= 5) || (us === BLACK && (t >> 4) <= 2))) out.push('兵快走到底了，快要升变，对方必须想办法拦住它。');
    if (!out.length) out.push(ty === P ? '挺兵：抢占空间。' : `调整${NAMES[ty]}的位置。`);
    return out;
  }

  // ---------------- 画棋盘用 ----------------
  const W = 8, H = 8;
  /** 画面坐标（x 从左到右，y 从上到下，白方在下）↔ 格子 */
  const sqAt = (x, y) => (7 - y) * 16 + x;
  const xyOf = s => [s & 7, 7 - (s >> 4)];
  const GLYPH = ['', '♟', '♞', '♝', '♜', '♛', '♚'];

  root.Chess = {
    id: 'chess', WHITE, BLACK, P, N, B, R, Q, K, NAMES, VAL, SCORE, START, W, H, GLYPH,
    Pos, fromFEN, toFEN, genMoves, make, unmake, makeNull, unmakeNull, legalMoves, inCheck, attacked, attackers,
    result, repetitions, san, parseSan, uci, parseUci, moveName, evaluate, captureValue, isCapture, describe, hanging,
    mFrom, mTo, mPromo, mFlag, sqName, color, type, sqAt, xyOf, sideName, insufficient,
    // 搜索需要的：不能走空着的局面（被将军或残局子力太少）
    nullOk: p => !inCheck(p) && p.b.some((x, s) => x && !(s & 0x88) && color(x) === p.turn && type(x) > P && type(x) < K),
    drawScore: 0,
    noMovesScore: (p, ply) => (inCheck(p) ? -30000 + ply : 0),
    isDraw: p => p.half >= 100 || insufficient(p) || repetitions(p) >= 1,
  };
}

if (typeof module !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'undefined') {
  ccChess(globalThis);
  module.exports = globalThis.Chess;
}
