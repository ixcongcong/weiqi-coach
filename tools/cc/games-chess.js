// 国际象棋棋谱：著名短局与常见开局。notes 的键是手数（第几步之后显示）。
const s = t => t.trim().split(/\s+/).filter(x => !/^\d+\.$/.test(x)).map(x => x.replace(/^\d+\./, ''));
module.exports = [
  {
    id: 'opera', title: '歌剧院之局：莫菲 对 公爵与伯爵（1858）', info: '巴黎歌剧院包厢里下的一盘棋，白方 17 步将死，是“快速出子、打开线路”的最好示范。', endsInMate: true,
    intro: '白方莫菲在看歌剧时和两位贵族（联手执黑）下了这盘棋。注意白方每一步都在出子或进攻，而黑方浪费了很多步数。',
    moves: s('1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8#'),
    notes: { 5: '黑方用象换掉了白方出好的马，白后反而更早出来了。', 7: '白后同时攻击 b7 和 f7 两个弱点（双击）。', 19: '白方弃马打开 b 线，让象和后冲进去。', 23: '长易位，车立刻投入战斗。', 32: '弃后！黑马只能吃后，底线失去保护。', 33: '车杀！白方只剩一车一象，却将死了对方。' },
  },
  {
    id: 'immortal', title: '不朽之局：安德森 对 基泽里茨基（1851）', info: '白方连弃双车、一象、一后，最后用三个轻子将死黑王。', endsInMate: true,
    moves: s('1.e4 e5 2.f4 exf4 3.Bc4 Qh4+ 4.Kf1 b5 5.Bxb5 Nf6 6.Nf3 Qh6 7.d3 Nh5 8.Nh4 Qg5 9.Nf5 c6 10.g4 Nf6 11.Rg1 cxb5 12.h4 Qg6 13.h5 Qg5 14.Qf3 Ng8 15.Bxf4 Qf6 16.Nc3 Bc5 17.Nd5 Qxb2 18.Bd6 Bxg1 19.e5 Qxa1+ 20.Ke2 Na6 21.Nxg7+ Kd8 22.Qf6+ Nxf6 23.Be7#'),
    notes: { 2: '王翼弃兵：白方弃一个兵，换取快速出子和打开 f 线。', 35: '弃象！白方要的是出子速度。', 45: '白方已经送掉两个车，但黑方的子全在边上睡觉。', 45.5: '' },
  },
  {
    id: 'evergreen', title: '常青之局：安德森 对 杜夫雷纳（1852）', info: '意大利开局的伊文斯弃兵，白方一连串的弃子组合，最后象杀。', endsInMate: true,
    moves: s('1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4 Bxb4 5.c3 Ba5 6.d4 exd4 7.O-O d3 8.Qb3 Qf6 9.e5 Qg6 10.Re1 Nge7 11.Ba3 b5 12.Qxb5 Rb8 13.Qa4 Bb6 14.Nbd2 Bb7 15.Ne4 Qf5 16.Bxd3 Qh5 17.Nf6+ gxf6 18.exf6 Rg8 19.Rad1 Qxf3 20.Rxe7+ Nxe7 21.Qxd7+ Kxd7 22.Bf5+ Ke8 23.Bd7+ Kf8 24.Bxe7#'),
    notes: { 7: '伊文斯弃兵：弃 b 兵，为了抢时间在中心建立兵阵。', 41: '弃后！', 47: '两个象交叉将军，最后象杀。' },
  },
  {
    id: 'legall', title: '勒加尔杀（1750）', info: '著名的开局陷阱：白方弃后，用三个轻子将死。', endsInMate: true,
    moves: s('1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6 5.Nxe5 Bxd1 6.Bxf7+ Ke7 7.Nd5#'),
    notes: { 9: '白马“丢下”后不管，吃掉 e5 兵。黑方贪吃后……', 11: '象将军，黑王只能走到 e7。', 13: '马杀！黑方虽然多一个后，却被三个轻子将死。' },
  },
  {
    id: 'scholar', title: '学者杀（四步杀）', info: '初学者最常遇到的陷阱：后和象一起攻击 f7。', endsInMate: true,
    moves: s('1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#'),
    notes: { 5: '后和象都瞄准 f7。黑方应该走 g6 或 Qe7 防守。', 6: '错！马攻击后，却忘了保护 f7。', 7: '后在象的保护下吃 f7，将死。' },
  },
  {
    id: 'fool', title: '愚人杀（两步杀）', info: '最快的将死：白方两步走错，就被黑后将死。', endsInMate: true,
    moves: s('1.f3 e5 2.g4 Qh4#'),
    notes: { 1: '开局动 f 兵会打开王前的斜线，很危险。', 4: '黑后沿打开的斜线将死白王。' },
  },
  {
    id: 'italian', title: '开局：意大利开局', info: '最古老、最适合初学者的开局：快速出子，象瞄准 f7。',
    moves: s('1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6 5.d4 exd4 6.cxd4 Bb4+ 7.Bd2 Bxd2+ 8.Nbxd2 d5'),
    notes: { 5: '象出到 c4，瞄准黑方最弱的 f7。', 7: '准备 d4，在中心建立两个兵。', 16: '黑方反击中心，局面平衡。' },
  },
  {
    id: 'ruylopez', title: '开局：西班牙开局', info: '职业比赛中最常见的开局之一，白方给 e5 兵施加长期压力。',
    moves: s('1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O 9.h3'),
    notes: { 5: '象攻击保护 e5 的马。', 9: '先易位，王安全了再说。', 17: 'h3 防止黑象到 g4 牵制马，是经典的准备走法。' },
  },
  {
    id: 'sicilian', title: '开局：西西里防御', info: '黑方用 c 兵对付 e4，局面不对称，双方都有机会。',
    moves: s('1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6'),
    notes: { 2: '黑方不跟着走 e5，而是从侧面争夺 d4。', 10: '纳伊道夫变例：世界冠军费舍尔和卡斯帕罗夫最爱的走法。' },
  },
  {
    id: 'qgd', title: '开局：后翼弃兵', info: '1.d4 开局的代表：白方用 c 兵换黑方的中心兵。',
    moves: s('1.d4 d5 2.c4 e6 3.Nc3 Nf6 4.Bg5 Be7 5.e3 O-O 6.Nf3 h6 7.Bh4 b6'),
    notes: { 3: '“弃兵”其实随时能吃回来，目的是把黑方的中心兵引开。', 4: '黑方不吃，用 e6 巩固中心。' },
  },
  {
    id: 'french', title: '开局：法兰西防御', info: '黑方先守后攻：用 e6、d5 建立坚固的兵链。',
    moves: s('1.e4 e6 2.d4 d5 3.Nc3 Nf6 4.Bg5 Be7 5.e5 Nfd7 6.Bxe7 Qxe7'),
  },
  {
    id: 'carokann', title: '开局：卡罗-康防御', info: '稳健的防御：先 c6 再 d5，黑方的白格象能顺利出来。',
    moves: s('1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Bf5 5.Ng3 Bg6 6.h4 h6'),
  },
];
