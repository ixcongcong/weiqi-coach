/* 围棋引擎：规则、蒙特卡洛树搜索（RAVE）、数子、讲解。
 * 整个文件是一个函数，这样既能在页面里运行，也能被转成 Web Worker 的源码。 */
function goEngine(root) {
  'use strict';
  const EMPTY = 0, BLACK = 1, WHITE = 2, BORDER = 3;
  const PASS = -1, NONE = -2, RESIGN = -3;
  const LETTERS = 'ABCDEFGHJKLMNOPQRST';

  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function (n) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return (s >>> 0) % n;
    };
  }

  class Board {
    constructor(n) {
      this.n = n;
      const w = this.w = n + 2;
      this.size = w * w;
      this.b = new Uint8Array(this.size);
      this.mark = new Int32Array(this.size);
      this.stack = new Int32Array(this.size);
      this.stamp = 0;
      this.dir = [-w, 1, w, -1];
      this.diag = [-w - 1, -w + 1, w - 1, w + 1];
      this.ko = NONE; this.toPlay = BLACK; this.lastMove = NONE;
      this.passes = 0; this.moveCount = 0; this.capB = 0; this.capW = 0;
      this.lastLib = 0;
      // 神经网络需要最近几手和前两个局面（只有 track 为 true 的棋盘才记录，模拟对局不记录）
      this.track = true; this.hist = null; this.prev = null;
      for (let i = 0; i < this.size; i++) {
        const x = i % w, y = (i / w) | 0;
        this.b[i] = (x === 0 || y === 0 || x === w - 1 || y === w - 1) ? BORDER : EMPTY;
      }
    }

    static fromState(s) {
      const g = new Board(s.n);
      g.b.set(s.b);
      g.ko = s.ko; g.toPlay = s.toPlay; g.lastMove = s.lastMove; g.passes = s.passes;
      g.moveCount = s.moveCount; g.capB = s.capB; g.capW = s.capW;
      g.track = !!s.track; g.hist = s.hist || null; g.prev = s.prev || null;
      return g;
    }

    state() {
      return {
        n: this.n, b: this.b.slice(), ko: this.ko, toPlay: this.toPlay, lastMove: this.lastMove,
        passes: this.passes, moveCount: this.moveCount, capB: this.capB, capW: this.capW,
        track: this.track, hist: this.hist, prev: this.prev,
      };
    }

    copyFrom(o) {
      this.b.set(o.b);
      this.ko = o.ko; this.toPlay = o.toPlay; this.lastMove = o.lastMove; this.passes = o.passes;
      this.moveCount = o.moveCount; this.capB = o.capB; this.capW = o.capW;
      this.hist = o.hist; this.prev = o.prev;
    }

    copy() { const g = new Board(this.n); g.copyFrom(this); g.track = this.track; return g; }

    setup(points) {
      for (const p of points) this.b[p] = BLACK;
      if (points.length) this.toPlay = WHITE;
    }

    /** 摆好黑白预置子（如古代座子），并指定谁先走。 */
    setupStones(black, white, toPlay) {
      for (const p of black) this.b[p] = BLACK;
      for (const p of white) this.b[p] = WHITE;
      this.toPlay = toPlay;
    }

    pt(x, y) { return (y + 1) * this.w + x + 1; }
    x(p) { return p % this.w - 1; }
    y(p) { return ((p / this.w) | 0) - 1; }
    name(p) {
      if (p === PASS) return '停一手';
      return LETTERS[this.x(p)] + (this.n - this.y(p));
    }

    nextStamp() {
      if (++this.stamp > 2000000000) { this.mark.fill(0); this.stamp = 1; }
      return this.stamp;
    }

    /** 数 p 所在棋块的气，数到 max 为止。 */
    libs(p, max) {
      const b = this.b, mark = this.mark, st = this.stack, dir = this.dir;
      const c = b[p], s = this.nextStamp();
      let sp = 0, cnt = 0;
      st[sp++] = p; mark[p] = s;
      while (sp > 0) {
        const q = st[--sp];
        for (let k = 0; k < 4; k++) {
          const r = q + dir[k];
          if (mark[r] === s) continue;
          const v = b[r];
          if (v === EMPTY) {
            mark[r] = s; this.lastLib = r;
            if (++cnt >= max) return cnt;
          } else if (v === c) {
            mark[r] = s; st[sp++] = r;
          }
        }
      }
      return cnt;
    }

    /** 棋块的全部棋子与气数。 */
    group(p) {
      const b = this.b, c = b[p], seen = new Set([p]), stones = [p], libs = new Set();
      for (let i = 0; i < stones.length; i++) {
        for (const d of this.dir) {
          const r = stones[i] + d;
          if (b[r] === EMPTY) libs.add(r);
          else if (b[r] === c && !seen.has(r)) { seen.add(r); stones.push(r); }
        }
      }
      return { stones, libs: libs.size, key: Math.min(...stones), color: c };
    }

    removeGroup(p) {
      const b = this.b, st = this.stack, dir = this.dir, c = b[p];
      let sp = 0, cnt = 0;
      st[sp++] = p; b[p] = EMPTY;
      while (sp > 0) {
        const q = st[--sp]; cnt++;
        for (let k = 0; k < 4; k++) {
          const r = q + dir[k];
          if (b[r] === c) { b[r] = EMPTY; st[sp++] = r; }
        }
      }
      return cnt;
    }

    isLegal(p, c) {
      if (p === PASS) return true;
      if (p < 0 || p >= this.size || this.b[p] !== EMPTY || p === this.ko) return false;
      const o = 3 - c, b = this.b, dir = this.dir;
      for (let k = 0; k < 4; k++) {
        const r = p + dir[k], v = b[r];
        if (v === EMPTY) return true;
        if (v === c) { if (this.libs(r, 2) >= 2) return true; }
        else if (v === o) { if (this.libs(r, 2) === 1) return true; }
      }
      return false;
    }

    play(p) {
      if (this.track && (p === PASS || this.isLegal(p, this.toPlay))) {
        // 记录：新数组，不改旧的（复制棋盘时只复制引用）
        this.prev = [this.b.slice(), this.prev ? this.prev[0] : null];
        this.hist = (this.hist ? this.hist.slice(-4) : []).concat([[p, this.toPlay]]);
      }
      if (p === PASS) {
        this.passes++; this.ko = NONE; this.lastMove = PASS;
        this.toPlay = 3 - this.toPlay; this.moveCount++;
        return true;
      }
      if (!this.isLegal(p, this.toPlay)) return false;
      this.playFast(p);
      return true;
    }

    playFast(p) {
      const b = this.b, dir = this.dir, c = this.toPlay, o = 3 - c;
      let captured = 0, capPt = NONE;
      b[p] = c;
      for (let k = 0; k < 4; k++) {
        const r = p + dir[k];
        if (b[r] === o && this.libs(r, 1) === 0) { captured += this.removeGroup(r); capPt = r; }
      }
      if (c === BLACK) this.capB += captured; else this.capW += captured;
      this.ko = NONE;
      if (captured === 1) {
        let alone = true;
        for (let k = 0; k < 4; k++) if (b[p + dir[k]] === c) alone = false;
        if (alone && this.libs(p, 2) === 1) this.ko = capPt;
      }
      this.lastMove = p; this.passes = 0; this.toPlay = o; this.moveCount++;
    }

    isEye(p, c) {
      const b = this.b;
      for (let k = 0; k < 4; k++) {
        const v = b[p + this.dir[k]];
        if (v !== c && v !== BORDER) return false;
      }
      const o = 3 - c;
      let bad = 0, edge = 0;
      for (let k = 0; k < 4; k++) {
        const v = b[p + this.diag[k]];
        if (v === o) bad++; else if (v === BORDER) edge = 1;
      }
      return bad + edge < 2;
    }

    isSelfAtari(p, c) {
      const b = this.b, o = 3 - c;
      let empties = 0;
      for (let k = 0; k < 4; k++) {
        const r = p + this.dir[k], v = b[r];
        if (v === EMPTY) empties++;
        else if (v === o && this.libs(r, 2) === 1) return false;
      }
      if (empties >= 2) return false;
      b[p] = c;
      const l = this.libs(p, 2);
      b[p] = EMPTY;
      return l < 2;
    }

    /** 2 = 能提子，1 = 能救出被叫吃的棋，0 = 都不是。 */
    tacticalValue(p, c) {
      const b = this.b, o = 3 - c;
      let v = 0;
      for (let k = 0; k < 4; k++) {
        const r = p + this.dir[k];
        if (b[r] === o && this.libs(r, 2) === 1) v = 2;
        else if (b[r] === c && v === 0 && this.libs(r, 2) === 1) v = 1;
      }
      return v;
    }

    /** 模拟对局的走子策略：先应对上一手附近的叫吃，否则随机选一个合理的点。 */
    policyMove(rnd) {
      const b = this.b, c = this.toPlay, o = 3 - c, lm = this.lastMove;
      if (lm >= 0) {
        if (b[lm] === o && this.libs(lm, 2) === 1) {
          const l = this.lastLib;
          if (this.isLegal(l, c)) return l;
        }
        for (let k = 0; k < 4; k++) {
          const r = lm + this.dir[k];
          if (b[r] === c && this.libs(r, 2) === 1) {
            const l = this.lastLib;
            if (this.isLegal(l, c) && !this.isSelfAtari(l, c)) return l;
          }
        }
      }
      const size = this.size, start = rnd(size);
      for (let i = 0; i < size; i++) {
        let p = start + i;
        if (p >= size) p -= size;
        if (b[p] !== EMPTY || p === this.ko) continue;
        if (this.isEye(p, c) || !this.isLegal(p, c) || this.isSelfAtari(p, c)) continue;
        return p;
      }
      return PASS;
    }

    owner(p) {
      let f = 0;
      for (let k = 0; k < 4; k++) {
        const v = this.b[p + this.dir[k]];
        if (v === BLACK) f |= 1; else if (v === WHITE) f |= 2;
      }
      return f === 1 ? BLACK : f === 2 ? WHITE : EMPTY;
    }

    areaScore(komi) {
      let s = 0;
      for (let p = 0; p < this.size; p++) {
        let v = this.b[p];
        if (v === EMPTY) v = this.owner(p);
        if (v === BLACK) s++; else if (v === WHITE) s--;
      }
      return s - komi;
    }
  }

  function playout(bd, rnd, moves, colors, len) {
    const limit = bd.moveCount + bd.n * bd.n * 3;
    while (bd.passes < 2 && bd.moveCount < limit) {
      const c = bd.toPlay, m = bd.policyMove(rnd);
      if (m === PASS) bd.play(PASS); else bd.playFast(m);
      if (moves && len < moves.length) { moves[len] = m; colors[len++] = c; }
    }
    return len;
  }

  // ---------- 蒙特卡洛树搜索 ----------

  const RAVE_EQ = 3000, EXPLORE = 0.1;

  class Node {
    constructor(move, color, pw, pv) {
      this.move = move; this.color = color; this.kids = null;
      this.n = 0; this.w = pw; this.v = pv; this.aw = 0; this.av = 0; this.rw = 0;
    }
  }

  /** 在一个线程里搜索；返回根节点每个候选的访问数与胜局数。 */
  function searchOne(pos, playouts, ms, komi, seed) {
    const deadline = Date.now() + ms;
    const rnd = makeRng(seed);
    const bd = new Board(pos.n);
    bd.track = false;
    const rootNode = new Node(NONE, 3 - pos.toPlay, 0, 0);
    const maxPath = 512;
    const path = new Array(maxPath);
    const moves = new Int32Array(pos.n * pos.n * 3 + maxPath + 8);
    const colors = new Int32Array(moves.length);
    const first = new Uint8Array(pos.size);
    const expandAt = pos.n >= 13 ? 16 : 8;
    const n2 = pos.n * pos.n;

    function expand(node) {
      const c = bd.toPlay, early = bd.moveCount < n2 / 3, kids = [];
      for (let p = 0; p < bd.size; p++) {
        if (bd.b[p] !== EMPTY || !bd.isLegal(p, c) || bd.isEye(p, c)) continue;
        let pw = 5;
        const x = bd.x(p), y = bd.y(p);
        const line = Math.min(x, y, bd.n - 1 - x, bd.n - 1 - y);
        if (line === 0) pw = early ? 2 : 4;
        else if (early && line === 1) pw = 4;
        else if (early && bd.n >= 13 && (line === 2 || line === 3)) pw = 6;
        const tac = bd.tacticalValue(p, c);
        if (tac === 2) pw = 9; else if (tac === 1) pw = 8;
        if (bd.isSelfAtari(p, c)) pw = 1;
        kids.push(new Node(p, c, pw, 10));
      }
      if (!kids.length) kids.push(new Node(PASS, c, 0, 0));
      node.kids = kids;
    }

    function select(node) {
      let best = null, bestV = -1e9;
      const logN = Math.log(node.n + 1);
      for (const k of node.kids) {
        let val;
        if (k.v === 0 && k.av === 0) {
          val = 10 + rnd(1000) / 1000;
        } else {
          const q = k.v > 0 ? k.w / k.v : 0.5;
          if (k.av > 0) {
            const beta = k.av / (k.av + k.v + k.av * k.v / RAVE_EQ);
            val = (1 - beta) * q + beta * (k.aw / k.av);
          } else val = q;
          val += EXPLORE * Math.sqrt(logN / (k.n + 1));
        }
        if (val > bestV) { bestV = val; best = k; }
      }
      return best;
    }

    function step(node, k, len) {
      if (k.move === PASS) bd.play(PASS); else bd.playFast(k.move);
      moves[len] = k.move; colors[len] = k.color;
    }

    function iterate() {
      bd.copyFrom(pos);
      let node = rootNode, depth = 0, len = 0;
      path[0] = node;
      while (node.kids && bd.passes < 2 && depth < maxPath - 2) {
        const k = select(node);
        step(node, k, len++);
        node = k; path[++depth] = node;
      }
      if (bd.passes < 2 && depth < maxPath - 2 && (node === rootNode || node.n >= expandAt)) {
        expand(node);
        const k = select(node);
        step(node, k, len++);
        node = k; path[++depth] = node;
      }
      len = playout(bd, rnd, moves, colors, len);
      const winner = bd.areaScore(komi) > 0 ? BLACK : WHITE;

      first.fill(0);
      let i = len - 1;
      for (let d = depth; d >= 0; d--) {
        const nd = path[d];
        nd.n++;
        if (d > 0) {
          nd.v++;
          if (winner === nd.color) { nd.w++; nd.rw++; }
        }
        while (i >= d) {
          if (moves[i] >= 0) first[moves[i]] = colors[i];
          i--;
        }
        if (nd.kids) {
          for (const kid of nd.kids) {
            if (kid.move >= 0 && first[kid.move] === kid.color) {
              kid.av++;
              if (winner === kid.color) kid.aw++;
            }
          }
        }
      }
    }

    let it = 0;
    while (it < playouts) {
      iterate();
      if ((++it & 15) === 0 && Date.now() > deadline) break;
    }
    const kids = rootNode.kids ? rootNode.kids.map(k => [k.move, k.n, k.rw]) : [];
    return { kids, playouts: it };
  }

  /** 从局面出发做 count 盘模拟，累计每个点的归属（黑 +1，白 -1）和平均目差。 */
  function ownershipSum(pos, count, komi, seed) {
    const bd = new Board(pos.n), rnd = makeRng(seed);
    bd.track = false;
    const own = new Float32Array(pos.size);
    let score = 0;
    for (let i = 0; i < count; i++) {
      bd.copyFrom(pos);
      playout(bd, rnd, null, null, 0);
      score += bd.areaScore(komi);
      for (let p = 0; p < pos.size; p++) {
        let v = bd.b[p];
        if (v === EMPTY) v = bd.owner(p);
        if (v === BLACK) own[p]++; else if (v === WHITE) own[p]--;
      }
    }
    return { own, score };
  }

  // ---------- 数子 ----------

  function chainOf(pos, p, seen) {
    const c = pos.b[p], out = [p];
    seen[p] = 1;
    for (let i = 0; i < out.length; i++) {
      for (const d of pos.dir) {
        const r = out[i] + d;
        if (!seen[r] && pos.b[r] === c) { seen[r] = 1; out.push(r); }
      }
    }
    return out;
  }

  function guessDead(pos, own) {
    const dead = new Uint8Array(pos.size), seen = new Uint8Array(pos.size);
    for (let p = 0; p < pos.size; p++) {
      const c = pos.b[p];
      if ((c !== BLACK && c !== WHITE) || seen[p]) continue;
      const ch = chainOf(pos, p, seen);
      let sum = 0;
      for (const q of ch) sum += own[q];
      if (c === WHITE) sum = -sum;
      if (sum < 0) for (const q of ch) dead[q] = 1;
    }
    return dead;
  }

  class Scoring {
    constructor(pos, dead, komi) {
      this.pos = pos; this.dead = dead; this.komi = komi;
      this.terr = new Uint8Array(pos.size);
      this.recount();
    }
    open(p) {
      const v = this.pos.b[p];
      return v === EMPTY || ((v === BLACK || v === WHITE) && this.dead[p]);
    }
    recount() {
      const pos = this.pos, b = pos.b, seen = new Uint8Array(pos.size);
      this.terr.fill(0);
      let bl = 0, wh = 0;
      for (let p = 0; p < pos.size; p++) {
        if (b[p] === BLACK && !this.dead[p]) bl++;
        else if (b[p] === WHITE && !this.dead[p]) wh++;
      }
      for (let p = 0; p < pos.size; p++) {
        if (seen[p] || !this.open(p)) continue;
        const region = [p];
        let mask = 0;
        seen[p] = 1;
        for (let i = 0; i < region.length; i++) {
          for (const d of pos.dir) {
            const r = region[i] + d;
            if (this.open(r)) { if (!seen[r]) { seen[r] = 1; region.push(r); } }
            else if (b[r] === BLACK) mask |= 1;
            else if (b[r] === WHITE) mask |= 2;
          }
        }
        const owner = mask === 1 ? BLACK : mask === 2 ? WHITE : EMPTY;
        for (const q of region) this.terr[q] = owner;
        if (owner === BLACK) bl += region.length; else if (owner === WHITE) wh += region.length;
      }
      this.black = bl; this.white = wh;
    }
    toggle(p) {
      const c = this.pos.b[p];
      if (c !== BLACK && c !== WHITE) return false;
      const ch = chainOf(this.pos, p, new Uint8Array(this.pos.size));
      const d = this.dead[p] ? 0 : 1;
      for (const q of ch) this.dead[q] = d;
      this.recount();
      return true;
    }
    diff() { return this.black - this.white - this.komi; }
    winner() { return this.diff() > 0 ? BLACK : WHITE; }
  }

  function handicapPoints(n, h) {
    if (h < 2) return [];
    const d = n >= 13 ? 3 : 2, m = n >> 1, e = n - 1 - d;
    const A = [e, d], B = [d, e], C = [e, e], D = [d, d], T = [m, m];
    const L = [d, m], R = [e, m], U = [m, d], W = [m, e];
    const table = {
      2: [A, B], 3: [A, B, C], 4: [A, B, C, D], 5: [A, B, C, D, T],
      6: [A, B, C, D, L, R], 7: [A, B, C, D, L, R, T],
      8: [A, B, C, D, L, R, U, W], 9: [A, B, C, D, L, R, U, W, T],
    };
    const b = new Board(n);
    return (table[Math.min(h, n === 9 ? 5 : 9)] || []).map(([x, y]) => b.pt(x, y));
  }

  // ---------- 讲解 ----------

  const SHAPE_NAMES = { '3,3': '三三', '4,4': '星位', '3,4': '小目', '3,5': '目外', '4,5': '高目' };

  function openingLimit(n) { return n === 9 ? 10 : n === 13 ? 24 : 50; }

  function positional(pre, m, c) {
    const n = pre.n, x = pre.x(m), y = pre.y(m), o = 3 - c;
    const lx = Math.min(x, n - 1 - x) + 1, ly = Math.min(y, n - 1 - y) + 1;
    const line = Math.min(lx, ly);
    const opening = pre.moveCount < openingLimit(n);
    if (!opening) return null;
    if (pre.dir.some(d => pre.b[m + d] === o)) return null;
    if (line === 1) return '一路在布局阶段价值很低：离边太近，几乎围不到地。';
    if (line === 2 && n >= 13) return '二路在布局阶段偏低，容易被对方压在下面，围到的地也少。';
    const cz = n >= 13 ? 6 : 4;
    if (lx <= cz && ly <= cz && n >= 9) {
      const x0 = x < n / 2 ? 0 : n - cz, y0 = y < n / 2 ? 0 : n - cz;
      let own = 0, opp = 0;
      for (let yy = y0; yy < y0 + cz; yy++) for (let xx = x0; xx < x0 + cz; xx++) {
        const v = pre.b[pre.pt(xx, yy)];
        if (v === c) own++; else if (v === o) opp++;
      }
      const key = Math.min(lx, ly) + ',' + Math.max(lx, ly);
      const nm = SHAPE_NAMES[key];
      if (!own && !opp) return `占角${nm ? '（' + nm + '）' : ''}：金角银边草肚皮——角上用最少的棋子就能围到地，布局要先占空角。`;
      if (!own && opp) return key === '3,3'
        ? '点三三：直接钻进对方的角里，抢夺角部实地。'
        : '挂角：靠近对方的角，不让对方轻松守角成空。';
      if (own && !opp) return '守角：加固自己的角，把角地确定下来。';
      return '角部争夺：双方都有棋子，这里是当前的焦点。';
    }
    if (n === 9 && line >= 4) return '占据中央：9 路棋盘很小，中央的棋子能同时照顾四个角。';
    if (line >= 3 && line <= 4 && (lx <= 4 || ly <= 4)) {
      let nearOpp = 0, nearOwn = 0;
      for (let p = 0; p < pre.size; p++) {
        const v = pre.b[p];
        if (v !== BLACK && v !== WHITE) continue;
        const dist = Math.abs(pre.x(p) - x) + Math.abs(pre.y(p) - y);
        if (v === o && dist <= 4) nearOpp++;
        if (v === c && dist <= 6) nearOwn++;
      }
      if (nearOpp) return '逼近/打入：限制对方在边上的发展。';
      if (nearOwn) return '拆边：沿着边展开，和自己的棋子互相呼应，形成阵地。';
      return '占边：边上的大场，价值仅次于角。';
    }
    if (line >= 5 && n >= 13) return '走向中腹：着眼于势力，追求全局的平衡。';
    return null;
  }

  function shape(pre, m, c) {
    const n = pre.n, x = pre.x(m), y = pre.y(m), o = 3 - c;
    const at = (dx, dy) => {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= n || Y >= n) return BORDER;
      return pre.b[pre.pt(X, Y)];
    };
    const orth = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const ownAdj = orth.some(([a, b]) => at(a, b) === c);
    const oppAdj = orth.some(([a, b]) => at(a, b) === o);
    if (ownAdj && oppAdj) return '贴身作战（长/扳）：紧挨着对方行棋，要时刻注意双方的气。';
    if (oppAdj) return '碰/靠：直接接触对方的棋子，试探对方的应手或借机腾挪。';
    if (ownAdj) return '长/粘：和自己的棋子连在一起，棋形坚实，但速度较慢。';
    if ([[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([a, b]) => at(a, b) === c)) {
      return '尖：斜着连络，棋形坚实，对方很难切断。';
    }
    for (const [a, b] of orth) {
      if (at(2 * a, 2 * b) === c && at(a, b) === EMPTY) return '一间跳：出头快，常用于向中腹发展或逃出。';
    }
    const knights = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
    if (knights.some(([a, b]) => at(a, b) === c)) return '小飞：行棋轻快，兼顾速度与连络。';
    return null;
  }

  /** 讲解一手棋。pre 为落子前的局面，ownB / ownA 为落子前后的归属估计。
   *  me / op 是这手棋的一方和对方的称呼（如“你”/“AI”）。 */
  function explain(pre, m, c, ownB, ownA, me, op) {
    const R = [];
    if (m === PASS) return ['停一手：放弃这一手。只有双方都没有有价值的地方可下时才应该停一手。'];
    const o = 3 - c, sgn = c === BLACK ? 1 : -1;
    const myG = [], opG = [], seen = new Set();
    for (const d of pre.dir) {
      const q = m + d, v = pre.b[q];
      if (v !== BLACK && v !== WHITE) continue;
      const g = pre.group(q);
      if (seen.has(g.key)) continue;
      seen.add(g.key);
      (v === c ? myG : opG).push(g);
    }
    const post = pre.copy();
    post.play(m);
    const captured = c === BLACK ? post.capB - pre.capB : post.capW - pre.capW;
    const mine = post.group(m);
    if (captured) R.push(`提子：吃掉${op}的 ${captured} 个子。`);
    const rescued = myG.filter(g => g.libs === 1).reduce((s, g) => s + g.stones.length, 0);
    if (rescued && mine.libs >= 2) R.push(`逃子：把被叫吃的 ${rescued} 个子长出来，气变成 ${mine.libs} 口。`);
    let atari = 0;
    const seen2 = new Set();
    for (const d of post.dir) {
      const q = m + d;
      if (post.b[q] !== o) continue;
      const g = post.group(q);
      if (seen2.has(g.key)) continue;
      seen2.add(g.key);
      if (g.libs === 1) atari += g.stones.length;
    }
    if (atari) R.push(`叫吃（打吃）：${op}的 ${atari} 个子只剩 1 口气，下一手就能提掉。`);
    if (myG.length >= 2) R.push(`连接：把 ${myG.length} 块棋连成一块，不给对方分断的机会。`);
    if (opG.length >= 2 && !captured) R.push('分断：插进对方棋子之间，让对方难以连络。（棋从断处生）');
    if (mine.libs === 1 && !captured) R.push(`危险：这块棋只剩 1 口气（自紧气），${op}可以直接提掉。`);

    let valueNote = null;
    if (ownB && ownA) {
      const s = (own, p) => own[p] * sgn;
      const seen3 = new Uint8Array(post.size);
      const lifeNotes = [];
      for (let p = 0; p < post.size; p++) {
        const v = post.b[p];
        if ((v !== BLACK && v !== WHITE) || seen3[p]) continue;
        const ch = chainOf(post, p, seen3);
        if (ch.length < 2) continue;
        let sb = 0, sa = 0;
        for (const q of ch) { sb += s(ownB, q); sa += s(ownA, q); }
        sb /= ch.length; sa /= ch.length;
        const where = post.name(ch.includes(m) ? m : ch[0]);
        if (v === c) {
          if (sb < 0.2 && sa > 0.55) lifeNotes.push(`安定：${me}在 ${where} 一带的 ${ch.length} 个子从危险变得安全了。`);
          else if (sb > 0.4 && sa < -0.1) lifeNotes.push(`隐患：这手之后，${me}在 ${where} 一带的 ${ch.length} 个子变得危险了。`);
        } else if (sb < 0.2 && sa > 0.55) {
          lifeNotes.push(`攻杀：${op}在 ${where} 一带的 ${ch.length} 个子基本被吃住了。`);
        }
      }
      R.push(...lifeNotes.slice(0, 2));
      let gain = 0, broke = 0, built = 0;
      for (let p = 0; p < post.size; p++) {
        if (pre.b[p] === BORDER) continue;
        const b0 = s(ownB, p), a0 = s(ownA, p);
        gain += a0 - b0;
        if (b0 < -0.4 && a0 - b0 > 0.4) broke++;
        else if (b0 > -0.4 && b0 < 0.4 && a0 > 0.5) built++;
      }
      if (broke >= 2) R.push(`破空：侵入${op}的势力范围，破坏了约 ${broke} 个点的地盘。`);
      if (built >= 2) R.push(`围地/扩张：把约 ${built} 个还没确定归属的点变成了${me}的势力范围。`);
      if (gain >= 2) valueNote = `这手棋的价值约 ${gain.toFixed(0)} 目（按双方目差的变化估算）。`;
      else if (gain <= -2) valueNote = `这手棋让形势亏了约 ${(-gain).toFixed(0)} 目。`;
    }
    const tactical = captured || rescued || atari || myG.length >= 2 || opG.length >= 2;
    if (!tactical && R.length < 3) {
      const pz = positional(pre, m, c);
      if (pz) R.push(pz);
    }
    if (!tactical && R.length < 3) {
      const sh = shape(pre, m, c);
      if (sh) R.push(sh);
    }
    const n = pre.n, x = pre.x(m), y = pre.y(m);
    const line = Math.min(x, y, n - 1 - x, n - 1 - y) + 1;
    if (!tactical && line === 1 && pre.moveCount >= openingLimit(n) && pre.moveCount < n * n * 0.5) {
      R.push('一路的棋通常价值很小：除非是为了做活、吃棋或收官，中盘阶段应该先走更大的地方。');
    }
    if (valueNote) R.push(valueNote);
    if (!R.length) R.push('这是一手普通的调整，局面没有大的变化。');
    return R;
  }

  // ---------- 局部死活/吃子计算（练习题判题、吃子棋 AI 用） ----------

  function groupLibs(b, p) {
    const g = b.group(p), libs = new Set();
    for (const s of g.stones) for (const d of b.dir) if (b.b[s + d] === EMPTY) libs.add(s + d);
    return { stones: g.stones, libs: [...libs] };
  }

  function candidates(b, target, wide, forDefender) {
    const { stones, libs } = groupLibs(b, target), out = new Set(libs);
    if (forDefender) {
      // 防守方还可以提掉紧贴着自己、只剩一口气的对方棋子
      const own = b.b[target];
      for (const s of stones) for (const d of b.dir) {
        const q = s + d;
        // 提掉只剩一口气的对方棋子；对杀时还可以反过来紧对方的气（对方只有两口气时）
        if (b.b[q] === 3 - own) { const g = groupLibs(b, q); if (g.libs.length <= 2) g.libs.forEach(l => out.add(l)); }
      }
    }
    if (wide) for (const l of libs) for (const d of b.dir) if (b.b[l + d] === EMPTY) out.add(l + d);
    return [...out];
  }

  /** 进攻方走：depth 手之内能否提掉 target 所在的棋块。能则返回着法序列，否则 null。 */
  function attack(b, target, depth, wide) {
    if (b.b[target] === EMPTY) return [];
    if (depth <= 0) return null;
    // 长距离追杀（征子）只看连续叫吃：对方已有 3 口气以上就算逃出
    if (!wide && depth > 20 && groupLibs(b, target).libs.length >= 3) return null;
    const a = b.toPlay;
    for (const m of candidates(b, target, wide, false)) {
      if (!b.isLegal(m, a)) continue;
      const c = b.copy();
      c.track = false;
      c.play(m);
      if (c.b[target] === EMPTY) return [m];
      const r = defend(c, target, depth - 1, wide);
      if (r) return [m, ...r];
    }
    return null;
  }

  /** 防守方走：如果所有防守都失败，返回（抵抗最久的）着法序列；只要有一种防守成立就返回 null。 */
  function defend(b, target, depth, wide) {
    if (b.b[target] === EMPTY) return [];
    if (groupLibs(b, target).libs.length >= 4 || depth <= 0) return null;
    const d = b.toPlay;
    let pv = null, any = false;
    for (const m of candidates(b, target, wide, true)) {
      if (!b.isLegal(m, d)) continue;
      any = true;
      const c = b.copy();
      c.track = false;
      c.play(m);
      const r = attack(c, target, depth - 1, wide);
      if (!r) return null;
      if (!pv || r.length > pv.length - 1) pv = [m, ...r];
    }
    if (!any) {
      const c = b.copy();
      c.track = false;
      c.play(PASS);
      const r = attack(c, target, depth - 1, wide);
      return r ? [PASS, ...r] : null;
    }
    return pv;
  }

  /** 防守方走：找一手能让 target 不被提掉的棋。 */
  function findDefense(b, target, depth, wide) {
    if (b.b[target] === EMPTY) return null;
    for (const m of candidates(b, target, wide, true)) {
      if (!b.isLegal(m, b.toPlay)) continue;
      const c = b.copy();
      c.track = false;
      c.play(m);
      if (!attack(c, target, depth - 1, wide)) return m;
    }
    return null;
  }

  /** 吃子棋 AI：能吃就吃，被叫吃就逃，能征吃就叫吃，否则找一手不送死、又能紧对方气的棋。 */
  function captureMove(b, rnd, level) {
    const me = b.toPlay, op = 3 - me, seen = new Set();
    const groups = [];
    for (let p = 0; p < b.size; p++) {
      const v = b.b[p];
      if ((v !== BLACK && v !== WHITE) || seen.has(p)) continue;
      const g = groupLibs(b, p);
      g.stones.forEach(s => seen.add(s));
      groups.push({ color: v, p, ...g });
    }
    const legal = m => m >= 0 && b.b[m] === EMPTY && b.isLegal(m, me);
    const safe = m => legal(m) && !b.isSelfAtari(m, me);
    const sloppy = level === 0 && rnd(100) < 35;
    // 1. 提子
    let best = null;
    for (const g of groups) {
      if (g.color === op && g.libs.length === 1 && legal(g.libs[0]) && (!best || g.stones.length > best.n)) best = { m: g.libs[0], n: g.stones.length };
    }
    if (best) return best.m;
    // 2. 自己被叫吃：逃，或者提掉叫吃的子
    if (!sloppy) {
      for (const g of groups) {
        if (g.color !== me || g.libs.length !== 1) continue;
        const l = g.libs[0];
        if (safe(l)) {
          const c = b.copy();
          c.play(l);
          c.toPlay = op;
          if (!attack(c, l, 12, false)) return l;
        }
      }
    }
    // 3. 叫吃对方，而且对方逃不掉（征子等）
    if (!sloppy) {
      for (const g of groups) {
        if (g.color !== op || g.libs.length !== 2) continue;
        const r = attack(b, g.p, level >= 2 ? 16 : 8, false);
        if (r && safe(r[0])) return r[0];
      }
    }
    // 4. 其它：靠近棋子、不送死；优先紧对方气少的棋
    const scored = [];
    for (let p = 0; p < b.size; p++) {
      if (!safe(p)) continue;
      let s = rnd(10);
      for (const d of b.dir) {
        const v = b.b[p + d];
        if (v === op) { const g = groupLibs(b, p + d); s += 30 / g.libs.length; }
        else if (v === me) { const g = groupLibs(b, p + d); if (g.libs.length <= 2) s += 15; }
      }
      const x = b.x(p), y = b.y(p), line = Math.min(x, y, b.n - 1 - x, b.n - 1 - y);
      if (line === 0) s -= 8;
      scored.push({ p, s });
    }
    if (!scored.length) return PASS;
    scored.sort((u, v) => v.s - u.s);
    const top = sloppy ? scored.slice(0, 8) : scored.slice(0, 2);
    return top[rnd(top.length)].p;
  }

  root.Go = {
    EMPTY, BLACK, WHITE, BORDER, PASS, NONE, RESIGN, LETTERS,
    Board, searchOne, ownershipSum, guessDead, Scoring, handicapPoints, explain, makeRng,
    groupLibs, attack, defend, findDefense, captureMove,
  };
}

/* Worker 端：接收搜索 / 归属估计请求。 */
function goWorker(self) {
  const G = self.Go;
  self.onmessage = e => {
    const m = e.data;
    const b = G.Board.fromState(m.state);
    if (m.type === 'search') {
      const r = G.searchOne(b, m.playouts, m.ms, m.komi, m.seed);
      self.postMessage({ id: m.id, kids: r.kids, playouts: r.playouts });
    } else if (m.type === 'own') {
      const r = G.ownershipSum(b, m.count, m.komi, m.seed);
      self.postMessage({ id: m.id, own: r.own, score: r.score, count: m.count }, [r.own.buffer]);
    }
  };
}

if (typeof window !== 'undefined') goEngine(window);
else if (typeof module !== 'undefined') { goEngine(globalThis); module.exports = globalThis.Go; }
