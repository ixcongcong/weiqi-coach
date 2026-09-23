/* 象棋类通用搜索：迭代加深 + Alpha-Beta（PVS）+ 静态搜索 + 置换表 + 空着裁剪 + 杀手/历史启发。
 * 规则对象（Chess / Xiangqi）提供走法生成、走子、评估等接口。 */
function ccSearch(root) {
  'use strict';
  const MATE = 30000, INF = 32000;
  const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;

  class Engine {
    constructor(R) {
      this.R = R;
      this.ttKey = new Int32Array(TT_SIZE);
      this.ttMove = new Int32Array(TT_SIZE);
      this.ttScore = new Int16Array(TT_SIZE);
      this.ttDepth = new Int8Array(TT_SIZE);
      this.ttFlag = new Int8Array(TT_SIZE); // 1 精确，2 下界，3 上界
      this.hist = new Int32Array(1 << 16);
      this.killers = [];
    }

    clear() { this.ttFlag.fill(0); this.hist.fill(0); }

    ttProbe(p) {
      const i = p.hl & TT_MASK;
      if (this.ttFlag[i] && this.ttKey[i] === p.hh) return i;
      return -1;
    }

    ttStore(p, depth, flag, score, move, ply) {
      const i = p.hl & TT_MASK;
      if (this.ttFlag[i] && this.ttKey[i] === p.hh && this.ttDepth[i] > depth && flag !== 1) return;
      // 杀棋分数按“离当前局面”的步数存
      if (score > MATE - 500) score += ply; else if (score < -MATE + 500) score -= ply;
      this.ttKey[i] = p.hh; this.ttMove[i] = move; this.ttScore[i] = score; this.ttDepth[i] = depth; this.ttFlag[i] = flag;
    }

    timeUp() {
      if ((++this.nodes & 2047) === 0 && Date.now() > this.deadline) this.stopped = true;
      return this.stopped;
    }

    order(p, moves, ttMove, ply) {
      const R = this.R, k = this.killers[ply] || [0, 0];
      const sc = moves.map(m => {
        if (m === ttMove) return 1e9;
        if (R.isCapture(p, m) || R.mPromo(m)) return 1e8 + R.captureValue(p, m);
        if (m === k[0]) return 9e7;
        if (m === k[1]) return 8e7;
        return this.hist[m & 0xffff];
      });
      const idx = moves.map((_, i) => i).sort((a, b) => sc[b] - sc[a]);
      return idx.map(i => moves[i]);
    }

    quiesce(p, alpha, beta, ply) {
      const R = this.R;
      if (this.timeUp()) return 0;
      const inChk = ply < 40 && R.inCheck(p);
      if (!inChk) {
        const stand = R.evaluate(p);
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
      }
      const moves = this.order(p, R.genMoves(p, !inChk), 0, ply);
      let any = false;
      for (const m of moves) {
        if (!R.make(p, m)) continue;
        any = true;
        const s = -this.quiesce(p, -beta, -alpha, ply + 1);
        R.unmake(p);
        if (this.stopped) return 0;
        if (s >= beta) return s;
        if (s > alpha) alpha = s;
      }
      if (inChk && !any) return R.noMovesScore(p, ply);
      return alpha;
    }

    search(p, depth, alpha, beta, ply, nullOk) {
      const R = this.R;
      if (ply > 0 && R.isDraw(p)) return R.drawScore;
      if (depth <= 0) return this.quiesce(p, alpha, beta, ply);
      if (this.timeUp()) return 0;
      // 杀棋距离裁剪
      alpha = Math.max(alpha, -MATE + ply); beta = Math.min(beta, MATE - ply - 1);
      if (alpha >= beta) return alpha;
      const pv = beta - alpha > 1;
      let ttMove = 0;
      const ti = this.ttProbe(p);
      if (ti >= 0) {
        ttMove = this.ttMove[ti];
        if (this.ttDepth[ti] >= depth && !pv) {
          let s = this.ttScore[ti];
          if (s > MATE - 500) s -= ply; else if (s < -MATE + 500) s += ply;
          const fl = this.ttFlag[ti];
          if (fl === 1 || (fl === 2 && s >= beta) || (fl === 3 && s <= alpha)) return s;
        }
      }
      const inChk = R.inCheck(p);
      if (inChk) depth++;
      // 空着裁剪
      if (nullOk && !pv && !inChk && depth >= 3 && R.nullOk(p) && R.evaluate(p) >= beta) {
        R.makeNull(p);
        const s = -this.search(p, depth - 3, -beta, -beta + 1, ply + 1, false);
        R.unmakeNull(p);
        if (this.stopped) return 0;
        if (s >= beta && s < MATE - 500) return s;
      }
      const moves = this.order(p, R.genMoves(p, false), ttMove, ply);
      let best = -INF, bestMove = 0, legal = 0;
      const a0 = alpha;
      for (const m of moves) {
        if (!R.make(p, m)) continue;
        legal++;
        const quiet = !p.stack[p.stack.length - 1].cap && !R.mPromo(m);
        let s;
        if (legal === 1) s = -this.search(p, depth - 1, -beta, -alpha, ply + 1, true);
        else {
          // 后面的安静着法先用减少深度的窄窗口试一下
          let red = 0;
          if (depth >= 3 && legal > 4 && quiet && !inChk) red = legal > 12 ? 2 : 1;
          s = -this.search(p, depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
          if (s > alpha && (red || s < beta)) s = -this.search(p, depth - 1, -beta, -alpha, ply + 1, true);
        }
        R.unmake(p);
        if (this.stopped) return 0;
        if (s > best) { best = s; bestMove = m; }
        if (s > alpha) alpha = s;
        if (alpha >= beta) {
          if (quiet) {
            const k = this.killers[ply] || (this.killers[ply] = [0, 0]);
            if (k[0] !== m) { k[1] = k[0]; k[0] = m; }
            this.hist[m & 0xffff] += depth * depth;
          }
          break;
        }
      }
      if (!legal) return R.noMovesScore(p, ply);
      this.ttStore(p, depth, best >= beta ? 2 : best > a0 ? 1 : 3, best, bestMove, ply);
      return best;
    }

    /**
     * 分析：迭代加深，根节点每一步都算出准确分数（便于讲解、降低难度时挑选次优着法）。
     * opts: { depth, ms, all } all=true 时每个根着法都用完整窗口
     * 返回 { best, score, depth, moves:[{m, score}], nodes, pv }
     */
    analyze(p, opts) {
      const R = this.R;
      this.nodes = 0; this.stopped = false;
      this.deadline = Date.now() + (opts.ms || 1e9);
      this.killers = [];
      for (let i = 0; i < this.hist.length; i++) this.hist[i] >>= 2;
      const root = R.legalMoves(p);
      if (!root.length) return { best: 0, score: R.noMovesScore(p, 0), depth: 0, moves: [], nodes: 0 };
      let scored = root.map(m => ({ m, score: 0 }));
      let done = null;
      const maxD = opts.depth || 64;
      for (let d = 1; d <= maxD; d++) {
        const cur = [];
        let alpha = -INF;
        for (let i = 0; i < scored.length; i++) {
          const m = scored[i].m;
          R.make(p, m);
          let s;
          if (opts.all || i === 0) s = -this.search(p, d - 1, -INF, INF, 1, true);
          else {
            s = -this.search(p, d - 1, -alpha - 1, -alpha, 1, true);
            if (s > alpha && !this.stopped) s = -this.search(p, d - 1, -INF, -alpha, 1, true);
          }
          R.unmake(p);
          if (this.stopped) break;
          cur.push({ m, score: s });
          if (s > alpha) alpha = s;
        }
        // 时间到了、这一层没算完：要所有着法的准确分数时，用上一层完整的结果；
        // 只要最佳着法时，已算完的部分仍然有效（第一个着法是上一层的最佳，一定先算完）
        if (this.stopped && done) {
          if (!opts.all && cur.length) {
            cur.sort((a, b) => b.score - a.score);
            const seen = new Set(cur.map(c => c.m)), low = cur[cur.length - 1].score - 1;
            for (const x of scored) if (!seen.has(x.m)) cur.push({ m: x.m, score: low, bound: true });
            scored = cur; done = d;
          }
          break;
        }
        cur.sort((a, b) => b.score - a.score);
        if (this.stopped) {
          const seen = new Set(cur.map(c => c.m));
          for (const x of scored) if (!seen.has(x.m)) cur.push({ m: x.m, score: cur.length ? cur[cur.length - 1].score : 0 });
        }
        scored = cur; done = d;
        if (this.stopped) break;
        if (Math.abs(scored[0].score) > MATE - 200 && d >= 2) {
          // 找到杀棋：再多算一层确认后停止
          if (opts.stopOnMate !== false && d > MATE - Math.abs(scored[0].score) + 1) break;
        }
        if (opts.nodes && this.nodes > opts.nodes) break;
      }
      if (!opts.all) {
        // 非完整窗口时，除第一名外的分数只是上界：标出来
        for (let i = 1; i < scored.length; i++) scored[i].bound = true;
      }
      return { best: scored[0].m, score: scored[0].score, depth: done || 0, moves: scored, nodes: this.nodes, pv: this.pv(p, scored[0].m) };
    }

    /** 从置换表取出主要变化 */
    pv(p, first) {
      const R = this.R, out = [first];
      const q = p.clone ? p.clone() : p;
      if (!R.make(q, first)) return out;
      for (let i = 0; i < 12; i++) {
        const ti = this.ttProbe(q);
        if (ti < 0) break;
        const m = this.ttMove[ti];
        if (!m || !R.legalMoves(q).includes(m)) break;
        R.make(q, m);
        out.push(m);
      }
      return out;
    }
  }

  const mateIn = s => (Math.abs(s) > MATE - 500 ? Math.sign(s) * Math.ceil((MATE - Math.abs(s)) / 2) : 0);
  root.CCSearch = { Engine, MATE, mateIn };
}

if (typeof module !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'undefined') {
  ccSearch(globalThis);
  module.exports = globalThis.CCSearch;
}
