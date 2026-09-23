/* 象棋引擎 Worker：收到局面（起始 FEN + 走过的着法），返回每一步的分数和最佳着法。 */
importScripts('chess.js', 'xiangqi.js', 'search.js');
ccChess(self);
ccXiangqi(self);
ccSearch(self);
const engines = {};
self.onmessage = e => {
  const m = e.data, R = m.game === 'chess' ? self.Chess : self.Xiangqi;
  const eng = engines[m.game] || (engines[m.game] = new self.CCSearch.Engine(R));
  const p = R.fromFEN(m.fen);
  for (const u of m.moves || []) { const x = R.parseUci(p, u); if (!x || !R.make(p, x)) break; }
  const r = eng.analyze(p, { ms: m.ms, depth: m.depth, all: m.all });
  self.postMessage({
    id: m.id, best: r.best ? R.uci(r.best) : null, score: r.score, depth: r.depth, nodes: r.nodes,
    moves: r.moves.map(x => ({ u: R.uci(x.m), s: x.score, b: !!x.bound })),
    pv: (r.pv || []).map(R.uci),
  });
};
