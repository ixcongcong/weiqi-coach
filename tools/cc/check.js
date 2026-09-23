// 快速检查局面：node check.js xiangqi "FEN"  → 列出一步杀、合法性
const [,, game, fen] = process.argv;
const R = require(`../../web/cc/${game}.js`), { Engine, mateIn } = require('../../web/cc/search.js');
const p = R.fromFEN(fen);
p.turn ^= 1; const bad = R.inCheck(p); p.turn ^= 1;
const mates = R.legalMoves(p).filter(m => { R.make(p, m); const r = !R.legalMoves(p).length && (game === 'xiangqi' || R.inCheck(p)); R.unmake(p); return r; });
const r = new Engine(R).analyze(p, { ms: 1500 });
console.log(bad ? 'ILLEGAL(对方被将)' : 'ok', 'inCheck', R.inCheck(p), 'mate1:', mates.map(m => R.san(p, m)).join(' ') || '-', '| best', R.san(p, r.best), r.score, 'mateIn', mateIn(r.score));
