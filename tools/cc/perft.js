// 走法计数测试：与公认结果对比，验证规则实现
const path = require('path');
const game = process.argv[2] || 'chess';
const Rl = require(path.join(__dirname, '../../web/cc', game + '.js'));
function perft(p, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of Rl.genMoves(p, false)) {
    if (!Rl.make(p, m)) continue;
    n += d === 1 ? 1 : perft(p, d - 1);
    Rl.unmake(p);
  }
  return n;
}
const cases = game === 'chess' ? [
  [Rl.START, [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
] : [
  [Rl.START, [44, 1920, 79666, 3290240]],
  ['r1ba1a3/4kn3/2n1b4/pNp1p1p1p/4c4/6P2/P1P2R2P/1CcC5/9/2BAKAB2 w', [38, 1128, 43929]],
  ['1cbak4/9/n2a5/2p1p3p/5cp2/2n2N3/6PCP/3AB4/2C6/3A1K1N1 w', [7, 281, 8620]],
];
let ok = true;
for (const [fen, exp] of cases) {
  const p = Rl.fromFEN(fen);
  const got = exp.map((_, i) => perft(p, i + 1));
  const good = got.every((v, i) => v === exp[i]);
  ok = ok && good;
  console.log(good ? 'OK ' : 'BAD', fen.slice(0, 40), got.join(','), good ? '' : 'expected ' + exp.join(','));
  if (Rl.toFEN && game === 'chess' && Rl.toFEN(Rl.fromFEN(fen)).split(' ').slice(0, 4).join(' ') !== fen.split(' ').slice(0, 4).join(' ')) { console.log('FEN roundtrip BAD'); ok = false; }
}
process.exit(ok ? 0 : 1);
