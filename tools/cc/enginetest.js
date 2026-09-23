const path = require('path');
const C = require('../../web/cc/chess.js'), X = require('../../web/cc/xiangqi.js'), S = require('../../web/cc/search.js');
function run(R, fen, ms, label) {
  const e = new S.Engine(R), p = R.fromFEN(fen);
  const t = Date.now();
  const r = e.analyze(p, { ms });
  const h0 = p.hl; p.rehash();
  console.log(label, 'best', R.moveName(p, r.best), R.san(p, r.best), 'score', r.score, 'mate', S.mateIn(r.score), 'depth', r.depth, 'nodes', r.nodes, (r.nodes / ((Date.now() - t) / 1000) | 0) + ' n/s', 'pv', r.pv.map(R.uci).join(' '), h0 === p.hl ? '' : 'HASH MISMATCH');
}
run(C, C.START, 2000, '国象开局');
run(C, 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 1000, '学者杀一步杀');
run(C, '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 1000, '底线杀');
run(C, 'r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 0', 3000, '勒加尔杀（两步杀）');
run(X, X.START, 2000, '象棋开局');
run(X, '3akab2/9/9/9/9/9/9/9/4C4/3K1R3 w', 1500, '车炮杀');
