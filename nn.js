/* 神经网络引擎：KataGo g170 网络（已转成 ONNX）+ PUCT 搜索。
 * 输入特征与 KataGo 的 V7 特征一致（棋子、气、打劫、最近 5 手、征子、活棋区域、贴目），
 * 这样网络才能发挥出原来的棋力。整个文件是一个函数，在 Worker 里和 Node 测试里都能用。 */
function goNN(root) {
  'use strict';
  const Go = root.Go;
  const { EMPTY, BLACK, WHITE, PASS, NONE } = Go;
  const NSP = 22, NGL = 19;

  // ---------------- 棋块 ----------------

  /** 全盘棋块：每个棋子所属棋块编号、每块的气数与棋子。 */
  function chainInfo(bd) {
    const size = bd.size, b = bd.b, dir = bd.dir;
    const id = new Int32Array(size).fill(-1), mark = new Int32Array(size);
    const libs = [], stones = [];
    let stamp = 0;
    for (let p = 0; p < size; p++) {
      const c = b[p];
      if ((c !== BLACK && c !== WHITE) || id[p] >= 0) continue;
      const k = stones.length, st = [p];
      id[p] = k; stamp++;
      let L = 0;
      for (let i = 0; i < st.length; i++) {
        const q = st[i];
        for (let d = 0; d < 4; d++) {
          const r = q + dir[d], v = b[r];
          if (v === EMPTY) { if (mark[r] !== stamp) { mark[r] = stamp; L++; } } else if (v === c && id[r] < 0) { id[r] = k; st.push(r); }
        }
      }
      stones.push(st); libs.push(L);
    }
    return { id, libs, stones };
  }

  function chainStones(bd, p) {
    const b = bd.b, c = b[p], dir = bd.dir, out = [p], seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (let d = 0; d < 4; d++) {
        const r = out[i] + dir[d];
        if (b[r] === c && !seen.has(r)) { seen.add(r); out.push(r); }
      }
    }
    return out;
  }

  function liberties(bd, p, out) {
    out = out || [];
    const b = bd.b, dir = bd.dir;
    for (const q of chainStones(bd, p)) {
      for (let d = 0; d < 4; d++) {
        const r = q + dir[d];
        if (b[r] === EMPTY && !out.includes(r)) out.push(r);
      }
    }
    return out;
  }

  // ---------------- 征子（照搬 KataGo 的征子搜索） ----------------

  function libertyGainingCaptures(bd, loc) {
    const b = bd.b, dir = bd.dir, opp = 3 - b[loc], out = [], seen = [];
    for (const q of chainStones(bd, loc)) {
      for (let d = 0; d < 4; d++) {
        const r = q + dir[d];
        if (b[r] === opp && bd.libs(r, 2) === 1) {
          const key = Math.min(...chainStones(bd, r));
          if (!seen.includes(key)) { seen.push(key); liberties(bd, r, out); }
        }
      }
    }
    return out;
  }

  function hasLibertyGainingCaptures(bd, loc) {
    const b = bd.b, dir = bd.dir, opp = 3 - b[loc];
    for (const q of chainStones(bd, loc)) {
      for (let d = 0; d < 4; d++) {
        const r = q + dir[d];
        if (b[r] === opp && bd.libs(r, 2) === 1) return true;
      }
    }
    return false;
  }

  function boundLibsAfterPlay(bd, loc, pla) {
    const b = bd.b, dir = bd.dir, opp = 3 - pla;
    let imm = 0, caps = 0, potCaps = 0, conn = 0, maxConn = 0;
    for (let d = 0; d < 4; d++) {
      const r = loc + dir[d], v = b[r];
      if (v === EMPTY) imm++;
      else if (v === opp) {
        if (bd.libs(r, 2) === 1) { caps++; potCaps += chainStones(bd, r).length; }
      } else if (v === pla) {
        const c = bd.libs(r, 1000) - 1;
        conn += c;
        if (c > maxConn) maxConn = c;
      }
    }
    return [caps + Math.max(maxConn, imm), imm + potCaps + conn];
  }

  function immediateLibs(bd, loc) {
    let n = 0;
    for (let d = 0; d < 4; d++) if (bd.b[loc + bd.dir[d]] === EMPTY) n++;
    return n;
  }

  function connLibsX2(bd, loc, pla) {
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const r = loc + bd.dir[d];
      if (bd.b[r] === pla) {
        const L = bd.libs(r, 1000);
        if (L > 1) n += L * 2 - 3;
      }
    }
    return n;
  }

  function wouldBeKoCapture(bd, loc, pla) {
    const b = bd.b;
    if (b[loc] !== EMPTY) return false;
    const opp = 3 - pla;
    let cap = NONE;
    for (let d = 0; d < 4; d++) {
      const r = loc + bd.dir[d], v = b[r];
      if (v !== Go.BORDER && v !== opp) return false;
      if (v === opp && bd.libs(r, 2) === 1) {
        if (cap !== NONE) return false;
        cap = r;
      }
    }
    if (cap === NONE) return false;
    return chainStones(bd, cap).length === 1;
  }

  function libsAfterPlay(bd, loc, pla, max) {
    const b = bd.b, dir = bd.dir, opp = 3 - pla, libs = [], capKeys = [];
    for (let d = 0; d < 4; d++) {
      const r = loc + dir[d], v = b[r];
      if (v === EMPTY) {
        libs.push(r);
        if (libs.length >= max) return max;
      } else if (v === opp && bd.libs(r, 2) === 1) {
        libs.push(r);
        if (libs.length >= max) return max;
        for (const s of chainStones(bd, r)) if (!capKeys.includes(s)) capKeys.push(s);
      }
    }
    const wouldBeEmpty = q => b[q] === EMPTY || (b[q] === opp && capKeys.includes(q));
    const done = [];
    for (let d = 0; d < 4; d++) {
      const r = loc + dir[d];
      if (b[r] !== pla || done.includes(r)) continue;
      const st = chainStones(bd, r);
      for (const s of st) done.push(s);
      for (const s of st) {
        for (let k = 0; k < 4; k++) {
          const q = s + dir[k];
          if (q !== loc && wouldBeEmpty(q) && !libs.includes(q)) {
            libs.push(q);
            if (libs.length >= max) return max;
          }
        }
      }
    }
    return libs.length;
  }

  function isAdjacent(bd, a, c) { const d = Math.abs(a - c); return d === 1 || d === bd.w; }

  const LADDER_BUDGET = 25000;
  const boardStack = [];
  function stackBoard(depth, n) {
    let s = boardStack[depth];
    if (!s || s.n !== n) s = boardStack[depth] = new Go.Board(n);
    return s;
  }

  /** loc 所在棋块能否被征吃。defenderFirst：轮到逃的一方先走。 */
  function ladderCaptured(bd0, loc, defenderFirst) {
    const pla = bd0.b[loc], opp = 3 - pla;
    const L0 = bd0.libs(loc, 3);
    if (L0 > 2 || (defenderFirst && L0 > 1)) return false;
    const n = bd0.n, maxDepth = ((n * n * 3) >> 1) + 1;
    let nodes = 0, aborted = false;
    const start = stackBoard(0, n);
    start.copyFrom(bd0);
    if (defenderFirst) start.ko = NONE;

    function rec(b, isDef, depth) {
      if (depth >= maxDepth - 1) return true;
      if (nodes >= LADDER_BUDGET) { aborted = true; return false; }
      const libs = b.libs(loc, 3);
      if (!isDef && libs <= 1) return true;
      if (!isDef && libs >= 3) return false;
      if (isDef && libs >= 2) return false;
      if (isDef && b.ko !== NONE) return false;
      let moves;
      if (isDef) {
        moves = libertyGainingCaptures(b, loc);
        liberties(b, loc, moves);
        const [lo, hi] = boundLibsAfterPlay(b, moves[moves.length - 1], pla);
        if (lo >= 3) return false;
        if (moves.length === 1 && hi <= 1) return true;
      } else {
        moves = liberties(b, loc);
        let l0 = immediateLibs(b, moves[0]), l1 = immediateLibs(b, moves[1]);
        if (l0 === 0 && l1 === 0 && wouldBeKoCapture(b, moves[0], opp) && wouldBeKoCapture(b, moves[1], opp) &&
          libsAfterPlay(b, moves[0], pla, 3) <= 2 && libsAfterPlay(b, moves[1], pla, 3) <= 2 && !hasLibertyGainingCaptures(b, loc)) return true;
        if (!isAdjacent(b, moves[0], moves[1])) {
          if (l0 >= 3 && l1 >= 3) return false;
          else if (l0 >= 3) moves = [moves[0]];
          else if (l1 >= 3) moves = [moves[1]];
        }
        if (moves.length > 1) {
          l0 = l0 * 2 + connLibsX2(b, moves[0], pla);
          l1 = l1 * 2 + connLibsX2(b, moves[1], pla);
          if (l1 > l0) moves = [moves[1], moves[0]];
        }
      }
      const who = isDef ? pla : opp;
      for (const m of moves) {
        if (!b.isLegal(m, who)) continue;
        const c = stackBoard(depth + 1, n);
        c.copyFrom(b);
        c.toPlay = who;
        c.playFast(m);
        nodes++;
        const r = rec(c, !isDef, depth + 1);
        if (aborted) return false;
        if (isDef && !r) return false;
        if (!isDef && r) return true;
      }
      return isDef;
    }
    const r = rec(start, defenderFirst, 0);
    return aborted ? false : r;
  }

  /** 两口气的棋块：进攻方先走能否征吃，返回能征吃的着点（没有则 null）。 */
  function ladderAttackerFirst(bd, loc) {
    if (bd.libs(loc, 3) !== 2) return null;
    const opp = 3 - bd.b[loc], out = [];
    const c = new Go.Board(bd.n);
    for (const m of liberties(bd, loc)) {
      if (!bd.isLegal(m, opp)) continue;
      c.copyFrom(bd);
      c.toPlay = opp;
      c.playFast(m);
      if (ladderCaptured(c, loc, true)) out.push(m);
    }
    return out.length ? out : null;
  }

  /** 全盘征子：返回 { stones: 会被征吃的棋子, working: 对手棋子的征吃着点 }（working 只对 toPlay 的对手的棋块）。 */
  function iterLadders(bd, opp) {
    const n = bd.n, ci = chainInfo(bd), solved = new Map(), stones = [], working = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = bd.pt(x, y), k = ci.id[p];
        if (k < 0) continue;
        const L = ci.libs[k];
        if (L !== 1 && L !== 2) continue;
        if (solved.has(k)) { if (solved.get(k)) stones.push(p); continue; }
        let lad, work = null;
        if (L === 1) lad = ladderCaptured(bd, p, true);
        else { work = ladderAttackerFirst(bd, p); lad = !!work; }
        solved.set(k, lad);
        if (lad) {
          stones.push(p);
          if (work && bd.b[p] === opp) for (const m of work) working.push(m);
        }
      }
    }
    return { stones, working };
  }

  // ---------------- 活棋区域（Benson 算法，照搬 KataGo 的 calculateArea） ----------------

  function areaForPla(bd, ci, pla, res) {
    const b = bd.b, dir = bd.dir, n = bd.n, opp = 3 - pla;
    const region = new Int32Array(bd.size).fill(-1), regions = [];
    let atLeastOnePla = false;
    const adjToPla = q => { for (let d = 0; d < 4; d++) if (b[q + dir[d]] === pla) return true; return false; };
    const adjToChain = (q, k) => { for (let d = 0; d < 4; d++) if (ci.id[q + dir[d]] === k) return true; return false; };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = bd.pt(x, y);
        if (region[p] !== -1) continue;
        if (b[p] !== EMPTY) { if (b[p] === pla) atLeastOnePla = true; continue; }
        const vital = [];
        for (let d = 0; d < 4; d++) {
          const q = p + dir[d];
          if (b[q] === pla && !vital.includes(ci.id[q])) vital.push(ci.id[q]);
        }
        const R = { locs: [], vital, internal: 0, hasOpp: false, borders: false };
        const r = regions.length;
        regions.push(R);
        const queue = [p];
        region[p] = r;
        for (let qi = 0; qi < queue.length; qi++) {
          const loc = queue[qi];
          if (R.vital.length && b[loc] === EMPTY) R.vital = R.vital.filter(k => adjToChain(loc, k));
          if (R.internal < 2 && !adjToPla(loc)) R.internal++;
          if (b[loc] === opp) R.hasOpp = true;
          R.locs.push(loc);
          for (let d = 0; d < 4; d++) {
            const q = loc + dir[d];
            if ((b[q] === EMPTY || b[q] === opp) && region[q] === -1) { region[q] = r; queue.push(q); }
          }
        }
      }
    }
    const nc = ci.stones.length, vcount = new Int32Array(nc), killed = new Uint8Array(nc);
    for (const R of regions) for (const k of R.vital) vcount[k]++;
    for (;;) {
      let any = false;
      for (let k = 0; k < nc; k++) {
        if (killed[k] || b[ci.stones[k][0]] !== pla || vcount[k] >= 2) continue;
        killed[k] = 1; any = true;
        for (const s of ci.stones[k]) {
          for (let d = 0; d < 4; d++) {
            const q = s + dir[d], r = region[q];
            if (r >= 0 && !regions[r].borders) {
              regions[r].borders = true;
              for (const v of regions[r].vital) vcount[v]--;
            }
          }
        }
      }
      if (!any) break;
    }
    for (let k = 0; k < nc; k++) {
      if (!killed[k] && b[ci.stones[k][0]] === pla) for (const s of ci.stones[k]) res[s] = pla;
    }
    for (const R of regions) {
      const mark = atLeastOnePla && !R.borders && (R.internal <= 1 || !R.hasOpp);
      if (mark) for (const q of R.locs) res[q] = pla;
      else if (atLeastOnePla && !R.hasOpp) for (const q of R.locs) if (res[q] === EMPTY) res[q] = pla;
    }
  }

  /** 每个点的归属：活棋、活棋围住的地、只被一方围住的空地；其余棋子算自己。 */
  function calcArea(bd, ci) {
    const res = new Uint8Array(bd.size);
    ci = ci || chainInfo(bd);
    areaForPla(bd, ci, BLACK, res);
    areaForPla(bd, ci, WHITE, res);
    for (let p = 0; p < bd.size; p++) {
      if (res[p] === EMPTY && (bd.b[p] === BLACK || bd.b[p] === WHITE)) res[p] = bd.b[p];
    }
    return res;
  }

  // ---------------- 输入特征 ----------------

  const symCache = new Map();
  /** 对称变换：原棋盘的点（带边框的下标）→ 网络里的位置。 */
  function symMap(n, sym) {
    const key = n * 8 + sym;
    let m = symCache.get(key);
    if (m) return m;
    const w = n + 2;
    m = new Int32Array(w * w).fill(-1);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let X = x, Y = y;
        if (sym & 4) { const t = X; X = Y; Y = t; }
        if (sym & 1) Y = n - 1 - Y;
        if (sym & 2) X = n - 1 - X;
        m[(y + 1) * w + x + 1] = Y * n + X;
      }
    }
    symCache.set(key, m);
    return m;
  }

  const ladderCache = new Map();
  function laddersOf(bd, opp) {
    const key = String.fromCharCode.apply(null, bd.b) + opp;
    let r = ladderCache.get(key);
    if (!r) {
      r = iterLadders(bd, opp);
      if (ladderCache.size > 4000) ladderCache.clear();
      ladderCache.set(key, r);
    }
    return r;
  }

  function boardFromArray(n, arr) {
    const b = new Go.Board(n);
    b.b.set(arr);
    return b;
  }

  /** 生成网络输入。komi：黑贴白的目数（中国规则数子）。 */
  function features(bd, komi, sym, sp, gl, off) {
    const n = bd.n, N = n * n, b = bd.b, pla = bd.toPlay, opp = 3 - pla;
    const map = symMap(n, sym);
    off = off || 0;
    const goff = (off / (NSP * N)) * NGL;
    sp.fill(0, off, off + NSP * N);
    gl.fill(0, goff, goff + NGL);
    const set = (ch, p) => { sp[off + ch * N + map[p]] = 1; };
    const ci = chainInfo(bd);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = bd.pt(x, y);
        set(0, p);
        const c = b[p];
        if (c === pla) set(1, p); else if (c === opp) set(2, p);
        if (c === pla || c === opp) {
          const L = ci.libs[ci.id[p]];
          if (L === 1) set(3, p); else if (L === 2) set(4, p); else if (L === 3) set(5, p);
        }
      }
    }
    if (bd.ko !== NONE && bd.ko >= 0) set(6, bd.ko);
    const area = calcArea(bd, ci);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = bd.pt(x, y);
        if (area[p] === pla) set(18, p); else if (area[p] === opp) set(19, p);
      }
    }
    // 最近 5 手（必须是双方交替下的）
    const hist = bd.hist || [];
    let turns = 0;
    for (let i = 0; i < 5 && i < hist.length; i++) {
      const [m, c] = hist[hist.length - 1 - i];
      if (c !== (i % 2 === 0 ? opp : pla)) break;
      turns = i + 1;
      if (m === PASS) gl[goff + i] = 1;
      else if (m >= 0) set(9 + i, m);
    }
    // 征子
    const lad = laddersOf(bd, opp);
    for (const p of lad.stones) {
      set(14, p);
    }
    for (const m of lad.working) set(17, m);
    const prevArr = turns >= 1 && bd.prev && bd.prev[0] ? bd.prev[0] : null;
    const prevBd = prevArr ? boardFromArray(n, prevArr) : bd;
    for (const p of laddersOf(prevBd, opp).stones) set(15, p);
    const pp = turns >= 2 && bd.prev && bd.prev[1] ? boardFromArray(n, bd.prev[1]) : prevBd;
    for (const p of laddersOf(pp, opp).stones) set(16, p);
    // 全局：贴目、停一手会不会终局、贴目奇偶
    let selfKomi = pla === WHITE ? komi : -komi;
    selfKomi = Math.max(-N - 20, Math.min(N + 20, selfKomi));
    gl[goff + 5] = selfKomi / 20;
    if (bd.passes >= 1) gl[goff + 14] = 1;
    const floor = N % 2 === 0 ? Math.floor(selfKomi / 2) * 2 : Math.floor((selfKomi - 1) / 2) * 2 + 1;
    const delta = Math.max(0, Math.min(2, selfKomi - floor));
    gl[goff + 18] = delta < 0.5 ? delta : delta < 1.5 ? 1 - delta : delta - 2;
  }

  // ---------------- 网络评估（带缓存与对称） ----------------

  function softplus(x) { return x > 30 ? x : Math.log1p(Math.exp(x)); }

  class Evaluator {
    /** runner(spatial, global, batch, n) → Promise<{policy, value, score, ownership}>（ONNX 输出的原始数组） */
    constructor(runner) {
      this.runner = runner;
      this.cache = new Map();
      this.evals = 0;
    }

    key(bd, komi) {
      let h = '';
      if (bd.hist) for (const [m] of bd.hist) h += m + ',';
      return `${bd.toPlay}|${bd.ko}|${bd.passes > 0 ? 1 : 0}|${komi}|${h}|${String.fromCharCode.apply(null, bd.b)}`;
    }

    /** 评估一批局面，每个局面可指定若干对称（结果取平均）。 */
    async evalMany(boards, komi, syms) {
      const out = new Array(boards.length), todo = [];
      for (let i = 0; i < boards.length; i++) {
        const k = this.key(boards[i], komi), hit = this.cache.get(k);
        if (hit) { out[i] = hit; continue; }
        todo.push({ i, k, bd: boards[i], syms: syms ? syms(i) : [(Math.random() * 8) | 0] });
      }
      if (todo.length) {
        const n = boards[0].n, N = n * n;
        const total = todo.reduce((s, t) => s + t.syms.length, 0);
        const sp = new Float32Array(total * NSP * N), gl = new Float32Array(total * NGL);
        let j = 0;
        for (const t of todo) for (const s of t.syms) features(t.bd, komi, s, sp, gl, (j++) * NSP * N);
        const raw = await this.runner(sp, gl, total, n);
        this.evals += total;
        j = 0;
        for (const t of todo) {
          const r = this.post(t.bd, raw, j, t.syms, N);
          j += t.syms.length;
          if (this.cache.size > 30000) this.cache.clear();
          this.cache.set(t.k, r);
          out[t.i] = r;
        }
      }
      return out;
    }

    post(bd, raw, j0, syms, N) {
      const P = new Float32Array(N + 1), own = new Float32Array(N);
      let win = 0, loss = 0, lead = 0, mean = 0, stdev = 0;
      const k = syms.length, pla = bd.toPlay, n = bd.n;
      for (let t = 0; t < k; t++) {
        const j = j0 + t, map = symMap(n, syms[t]);
        const v = raw.value.subarray(j * 3, j * 3 + 3), mx = Math.max(v[0], v[1], v[2]);
        const e0 = Math.exp(v[0] - mx), e1 = Math.exp(v[1] - mx), e2 = Math.exp(v[2] - mx), es = e0 + e1 + e2;
        win += e0 / es / k; loss += e1 / es / k;
        const nsc = raw.score.length / (raw.value.length / 3);
        const sc = raw.score.subarray(j * nsc, j * nsc + nsc);
        mean += sc[0] * 20 / k; stdev += softplus(sc[1]) * 20 / k; lead += sc[2] * 20 / k;
        const pol = raw.policy.subarray(j * (N + 1), (j + 1) * (N + 1)), ow = raw.ownership.subarray(j * N, (j + 1) * N);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const p = bd.pt(x, y), q = map[p], i = y * n + x;
            P[i] += pol[q] / k;
            own[i] += Math.tanh(ow[q]) / k;
          }
        }
        P[N] += pol[N] / k;
      }
      // 只在合法着点上做 softmax
      let mx = -Infinity;
      const legal = new Uint8Array(N + 1);
      legal[N] = 1;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const p = bd.pt(x, y);
          if (bd.b[p] === EMPTY && bd.isLegal(p, pla)) legal[y * n + x] = 1;
        }
      }
      for (let i = 0; i <= N; i++) if (legal[i] && P[i] > mx) mx = P[i];
      let s = 0;
      for (let i = 0; i <= N; i++) { P[i] = legal[i] ? Math.exp(P[i] - mx) : 0; s += P[i]; }
      for (let i = 0; i <= N; i++) P[i] /= s;
      return { P, own, win, loss, lead, mean, stdev };
    }
  }

  // ---------------- PUCT 搜索 ----------------

  class Node {
    constructor(move, P) {
      this.move = move; this.P = P;
      this.N = 0; this.vl = 0;
      this.Wu = 0; this.Ww = 0; this.Wl = 0; // 从“下这手的一方”看：效用、胜率、领先目数
      this.kids = null; this.ev = null; this.term = null; this.pending = false; this.key = null;
    }
  }

  const CPUCT = 1.0, CPUCT_LOG = 0.45, FPU = 0.2, FPU_ROOT = 0.1, SCORE_W = 0.25;

  class Search {
    constructor(evaluator) {
      this.ev = evaluator;
      this.root = null;
    }

    scoreUtil(lead, n) { return SCORE_W * (2 / Math.PI) * Math.atan(lead / (Math.sqrt(n * n) * 0.5)); }

    /** 把网络结果转成从 pla 看的效用 */
    util(e, n) { return (e.win - e.loss) + this.scoreUtil(e.lead, n); }

    idxOf(bd, m) { return m === PASS ? bd.n * bd.n : bd.y(m) * bd.n + bd.x(m); }

    expand(node, bd, e) {
      const n = bd.n, N = n * n, kids = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const pr = e.P[y * n + x];
          if (pr > 0) kids.push(new Node(bd.pt(x, y), pr));
        }
      }
      kids.push(new Node(PASS, e.P[N]));
      kids.sort((a, b) => b.P - a.P);
      node.kids = kids;
      node.ev = { own: e.own, lead: e.lead, win: e.win, loss: e.loss, stdev: e.stdev, pla: bd.toPlay, P: e.P };
    }

    select(node, isRoot) {
      const total = node.N + node.vl;
      const cp = CPUCT + CPUCT_LOG * Math.log((total + 500) / 500);
      const sq = Math.sqrt(total + 0.01);
      let visitedP = 0;
      for (const k of node.kids) if (k.N + k.vl > 0) visitedP += k.P;
      const parentQ = node.N > 0 ? -node.Wu / node.N : 0;
      const fpu = parentQ - (isRoot ? FPU_ROOT : FPU) * Math.sqrt(visitedP);
      let best = null, bv = -Infinity;
      for (const k of node.kids) {
        const nk = k.N + k.vl;
        const q = nk > 0 ? (k.Wu - k.vl) / nk : fpu;
        const v = q + cp * k.P * sq / (1 + nk);
        if (v > bv) { bv = v; best = k; }
      }
      return best;
    }

    descend(rootBd) {
      const bd = rootBd.copy();
      bd.track = true;
      let node = this.root;
      const path = [node];
      while (node.kids && !node.term) {
        const k = this.select(node, node === this.root);
        bd.play(k.move);
        path.push(k);
        node = k;
        if (bd.passes >= 2 && !node.term) {
          // 双方连续停一手：按上一个局面的网络归属数子
          const src = path[path.length - 2].ev;
          let s = -this.komi;
          for (let i = 0; i < src.own.length; i++) {
            const v = src.pla === BLACK ? src.own[i] : -src.own[i];
            if (v > 0) s++; else if (v < 0) s--;
          }
          const pla = bd.toPlay, sp = pla === BLACK ? s : -s;
          const win = sp > 0 ? 1 : sp < 0 ? 0 : 0.5;
          node.term = { win, loss: 1 - win, lead: sp };
        }
      }
      if (node.pending) return null;
      for (const p of path) p.vl++;
      node.pending = true;
      return { node, path, bd };
    }

    backup(path, u, win, lead) {
      // u、win、lead 是从叶子局面“轮到下棋的一方”看的；叶子节点本身记录的是“刚下这手的一方”
      let sgn = -1;
      for (let i = path.length - 1; i >= 0; i--) {
        const nd = path[i];
        nd.vl--;
        nd.N++;
        nd.Wu += sgn * u;
        nd.Ww += sgn > 0 ? win : 1 - win;
        nd.Wl += sgn * lead;
        sgn = -sgn;
      }
    }

    /** 找能复用的旧搜索树（新局面是旧根节点之后 0~2 手） */
    reuse(key) {
      const r = this.root;
      if (!r) return null;
      if (r.key === key) return r;
      if (r.kids) {
        for (const a of r.kids) {
          if (a.key === key) return a;
          if (a.kids) for (const b of a.kids) if (b.key === key) return b;
        }
      }
      return null;
    }

    /**
     * 搜索。opts: { visits, ms, batch, stop() }
     * 返回 { cands:[{move, visits, wr, lead, prior}], playouts, wr, lead, own(下标=棋盘点, 黑+1), policy }
     */
    async run(rootBd, komi, opts) {
      const n = rootBd.n;
      this.komi = komi;
      const deadline = Date.now() + (opts.ms || 1e9);
      const key = this.ev.key(rootBd, komi);
      let root = this.reuse(key);
      if (!root) root = new Node(NONE, 1);
      this.root = root;
      root.key = key;
      if (!root.ev) {
        const [e] = await this.ev.evalMany([rootBd], komi, () => [0, 5]);
        this.expand(root, rootBd, e);
        if (root.N === 0) { root.vl++; this.backup([root], this.util(e, n), e.win, e.lead); }
      }
      const batch = opts.batch || 8;
      let guard = 0;
      while (root.N < opts.visits && Date.now() < deadline) {
        if (opts.stop && opts.stop()) break;
        const leaves = [];
        for (let i = 0; i < batch && root.N + leaves.length < opts.visits; i++) {
          const d = this.descend(rootBd);
          if (!d) break;
          if (d.node.term) {
            const t = d.node.term;
            d.node.pending = false;
            this.backup(d.path, (t.win - t.loss) + this.scoreUtil(t.lead, n), t.win, t.lead);
            continue;
          }
          leaves.push(d);
        }
        if (!leaves.length) {
          if (++guard > 1000) break;
          continue;
        }
        guard = 0;
        const es = await this.ev.evalMany(leaves.map(l => l.bd), komi);
        for (let i = 0; i < leaves.length; i++) {
          const { node, path, bd } = leaves[i], e = es[i];
          node.pending = false;
          if (!node.kids) { this.expand(node, bd, e); node.key = this.ev.key(bd, komi); }
          this.backup(path, this.util(e, n), e.win, e.lead);
        }
      }
      return this.result(rootBd);
    }

    result(bd) {
      const root = this.root, n = bd.n, ev = root.ev;
      const cands = root.kids.filter(k => k.N > 0)
        .map(k => ({ move: k.move, visits: k.N, wr: k.Ww / k.N, lead: k.Wl / k.N, prior: k.P }))
        .sort((a, b) => b.visits - a.visits || b.wr - a.wr);
      const own = new Float32Array(bd.size), sgn = ev.pla === BLACK ? 1 : -1;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) own[bd.pt(x, y)] = sgn * ev.own[y * n + x];
      const wr = cands.length ? cands[0].wr : ev.win;
      const lead = cands.length ? cands[0].lead : ev.lead;
      return {
        cands, playouts: root.N, wr, lead,
        own, score: sgn * lead, rawWr: ev.win, rawLead: ev.lead,
        policy: root.kids.slice(0, 12).map(k => ({ move: k.move, prior: k.P })),
      };
    }
  }

  root.NN = { NSP, NGL, chainInfo, ladderCaptured, ladderAttackerFirst, iterLadders, calcArea, features, symMap, Evaluator, Search };
}

if (typeof module !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'undefined') {
  goNN(globalThis);
  module.exports = globalThis.NN;
}
