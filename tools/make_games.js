// 把 tools/sgf 里的经典棋谱转成 web/games.js（主线着法 + 介绍 + 关键手讲解）。
const fs = require('fs');
const path = require('path');

const META = [
  {
    file: '1846-ear-reddening.sgf', id: 'ear', title: '耳赤之局', year: 1846,
    black: '本因坊秀策', white: '井上幻庵因硕', result: '黑胜 2 目（无贴目）',
    intro: '1846 年，年仅 17 岁的秀策（当时是四段）执黑，对阵当时的顶尖高手井上幻庵因硕（八段）。那时还没有贴目。这盘棋因黑第 127 手的“耳赤之手”而闻名：据说旁观的医生看到幻庵听到这手棋后耳朵发红，由此断定黑棋形势好转。',
    notes: {
      1: '黑 1、3、5 都下在小目——这是秀策最擅长的布局风格，重视实地、棋形坚实。',
      127: '耳赤之手！这一手同时起了好几个作用：扩张下方的黑阵、削弱白棋在中腹的势力，还照应到周围几处黑棋。一子多用，是“全局观”的典范。学习要点：好棋往往不只做一件事。',
      325: '终局，黑胜 2 目。秀策此后被誉为“棋圣”。',
    },
  },
  {
    file: '1933-go-seigen-shusai.sgf', id: 'seigen', title: '三三·星·天元', year: 1933,
    black: '吴清源', white: '本因坊秀哉', result: '白胜 2 目',
    intro: '1933 年秋开始的一盘名局：19 岁的吴清源（五段）执黑，对阵本因坊秀哉名人。吴清源开局依次下在三三、星位和天元，这是他和木谷实倡导的“新布局”，震动了当时的棋界。按当时的规矩，名人可以随时“打挂”（暂停），这盘棋断断续续下了三个多月。',
    notes: {
      1: '黑 1 三三：一手就确保角地。在重视“小目”的年代，这被看作离经叛道。',
      3: '黑 3 星位：比小目快，更重视向边上和中央发展。',
      5: '黑 5 天元（棋盘正中央）！新布局的核心思想：重视速度和全局配合，而不只是角上的实地。',
      160: '白 160：据传这手妙手出自秀哉门下弟子的研究。这个说法流传很广，但一直没有定论。',
      252: '终局，白胜 2 目。这盘棋虽然输了，却让“新布局”名扬天下。',
    },
  },
  {
    file: '2016-alphago-lee-2.sgf', id: 'ag2', title: 'AlphaGo 第 37 手', year: 2016,
    black: 'AlphaGo', white: '李世石', result: '黑中盘胜',
    intro: '2016 年 3 月 10 日，谷歌 DeepMind 挑战赛第 2 局。AlphaGo 执黑，李世石九段执白，中国规则，贴 7.5 目。这盘棋最著名的是黑第 37 手：一手第五路的“肩冲”。当时的职业棋手普遍认为这不是人类会下的棋，赛后却被公认为好棋。',
    notes: {
      37: '第 37 手，五路肩冲！按传统观念，五路太高，会让对方在下边轻松围地。但 AlphaGo 看重的是这手棋对中央和右边的影响——它改变了很多人对“高”和“低”的看法。据 DeepMind 介绍，AlphaGo 当时估计人类棋手下这手棋的概率大约只有万分之一。',
      211: '李世石认输，AlphaGo 中盘胜。',
    },
  },
  {
    file: '2016-alphago-lee-4.sgf', id: 'ag4', title: '李世石“神之一手”', year: 2016,
    black: 'AlphaGo', white: '李世石', result: '白中盘胜',
    intro: '2016 年 3 月 13 日，挑战赛第 4 局。前三局李世石全部落败，这一局他执白。白第 78 手的“挖”后来被称为“神之一手”，AlphaGo 随后出现一连串失误，李世石中盘获胜——这是人类在这次五番棋中赢下的唯一一局。',
    notes: {
      78: '第 78 手，挖！在黑棋看起来很厚实的中央阵地里挖进去，同时制造出好几个断点。学习要点：对方阵地里看似没有棋的地方，找到“一手多用”的要点就能打开局面。',
      79: '黑 79：一般认为这是 AlphaGo 的关键失误，它没有找到正确的应对。',
      180: 'AlphaGo 认输，李世石中盘胜。',
    },
  },
  {
    file: '1739-danghu.sgf', id: 'danghu', title: '当湖十局（选局）', year: 1739,
    black: '施襄夏', white: '范西屏', result: '黑胜 2 子半（古代数子法）',
    intro: '1739 年，清代国手范西屏与施襄夏在浙江平湖的当湖对弈十局，被誉为中国古代围棋的巅峰之作。古代采用“座子”制：开局前在四个角的星位上黑白各摆两子，然后白棋先下。本局施襄夏执黑、范西屏执白。',
    notes: {
      1: '古代座子棋：四个星位上已经摆好了子，所以一开局就是边角上的接触战。这也是古代棋风比现代更重视战斗的原因之一。',
    },
  },
];

function parse(txt) {
  const prop = k => {
    const m = txt.match(new RegExp('(?:^|[;\\s\\]])' + k + '((?:\\[[^\\]]*\\])+)'));
    return m ? [...m[1].matchAll(/\[([^\]]*)\]/g)].map(x => x[1]) : [];
  };
  const moves = [...txt.matchAll(/;\s*([BW])\[([a-s]{0,2})\]/g)].map(m => (m[2] === '' ? 'tt' : m[2]));
  const first = (txt.match(/;\s*([BW])\[/) || [])[1];
  return { ab: prop('AB'), aw: prop('AW'), moves, first, km: parseFloat(prop('KM')[0] || '0') || 0 };
}

const dir = path.join(__dirname, 'sgf');
const games = META.map(m => {
  const g = parse(fs.readFileSync(path.join(dir, m.file), 'latin1'));
  const { file, ...meta } = m;
  return { ...meta, size: 19, komi: g.km, ab: g.ab.join(''), aw: g.aw.join(''), first: g.first, moves: g.moves.join('') };
});
// ---------------- 套路讲解（构造的局面，每课都用引擎验证） ----------------

const Go = require(path.join(__dirname, '..', 'web', 'engine.js'));
const L = 'ABCDEFGHJKLMNOPQRST';
const toSgf = (name, n) => String.fromCharCode(97 + L.indexOf(name[0])) + String.fromCharCode(97 + n - parseInt(name.slice(1), 10));
const sgfList = (names, n) => names.map(x => toSgf(x, n)).join('');

function boardFor(les) {
  const b = new Go.Board(les.size);
  const pt = name => b.pt(L.indexOf(name[0]), les.size - parseInt(name.slice(1), 10));
  b.setupStones(les.ab.map(pt), les.aw.map(pt), les.first === 'W' ? Go.WHITE : Go.BLACK);
  return { b, pt };
}

/** 征子：黑每次在能让白长出后仍只有两口气的一侧叫吃，直到白被提。 */
function solveLadder(les) {
  const { b, pt } = boardFor(les);
  const seq = [];
  for (let guard = 0; guard < 60; guard++) {
    const w = b.group(pt(les.target));
    const libs = [];
    for (const s of w.stones) for (const d of b.dir) if (b.b[s + d] === Go.EMPTY && !libs.includes(s + d)) libs.push(s + d);
    if (libs.length === 1) { seq.push(libs[0]); b.play(libs[0]); return seq; }
    let done = false;
    for (const a of libs) {
      const other = libs.find(x => x !== a);
      const t = b.copy();
      if (!t.play(a) || !t.play(other)) continue;
      const g2 = t.group(other);
      if (g2.libs <= 2) { seq.push(a, other); b.play(a); b.play(other); done = true; break; }
    }
    if (!done) throw new Error('ladder broke');
  }
  throw new Error('ladder too long');
}

const LESSONS = [
  {
    id: 'double', title: '双叫吃', size: 9, first: 'B',
    ab: ['C5', 'D6', 'F6', 'G5'], aw: ['D5', 'F5'], moves: ['E5', 'D4', 'F4'],
    expect: { captureAt: 3 },
    intro: '一手棋同时叫吃对方两块棋，对方只能救一块，另一块一定被吃。这是最简单、也最常用的吃子手段。',
    use: '实战中怎么用：看到对方有两块只剩两口气的棋，并且它们共用一个气眼附近的点时，找找有没有一手能同时紧两块的气。反过来，自己有两块气紧的棋时，要提前补强，防止被双叫吃。',
    notes: {
      1: '黑下在两块白棋中间：左边白 D5 只剩 D4 一口气，右边白 F5 只剩 F4 一口气——这就是双叫吃。',
      2: '白只能救一块，这里选择长出 D4 救左边。',
      3: '黑提掉右边的白子。一手棋制造两个威胁，对方顾此失彼。',
    },
  },
  {
    id: 'ladder', title: '征子（扭羊头）', size: 9, first: 'B',
    ab: ['B3', 'C2', 'B4'], aw: ['C3'], target: 'C3', ladder: true,
    intro: '被叫吃的棋子向外逃，每逃一步，对方就在另一侧再叫吃，逃跑的棋子沿着斜线一路被追到棋盘边，最后全部被提。这叫“征子”。',
    use: '实战中怎么用：征子前一定先沿着斜线看一看，逃跑方向上如果有对方的棋子（叫“引征”），征子就会失败，追的一方反而满盘断点。所以：征子不利时不要征，被征的一方也不要硬逃。',
    notes: {
      1: '黑叫吃白 C3。注意黑是从哪一边叫吃的：要让白逃出后仍然只有两口气。',
      2: '白长出，现在有两口气。',
      3: '黑换一侧继续叫吃，白棋只能沿斜线继续逃。',
    },
  },
  {
    id: 'snapback', title: '倒扑', size: 9, first: 'B',
    ab: ['B1', 'B2', 'C3', 'D3', 'E3', 'F2', 'F1'], aw: ['C1', 'C2', 'D2', 'E2'], moves: ['D1', 'E1', 'D1'],
    expect: { captureAt: 3, minCaptured: 5 },
    intro: '先故意送一个子给对方吃，对方提子之后，自己的棋反而只剩一口气，被一口气全部吃掉。这叫“倒扑”。',
    use: '实战中怎么用：当对方的棋只剩两口气、其中一口气是“对方提子后仍然出不来”的形状时，就可以扑进去。被扑的一方要注意：提了子之后要数一数自己的气，有时不提、先接更好。',
    notes: {
      1: '黑扑进去！这个黑子只有一口气，看起来是送死。',
      2: '白提掉黑子——但提完之后，白棋整块只剩 D1 一口气。',
      3: '黑再下 D1，把白棋 5 个子全部提掉。舍一子，吃五子。',
    },
  },
  {
    id: 'ko', title: '打劫与劫材', size: 9, first: 'B',
    ab: ['D5', 'C4', 'D3', 'H2'], aw: ['E5', 'D4', 'F4', 'E3', 'G2', 'H3'], moves: ['E4', 'H1', 'J2', 'D4'],
    expect: { captureAt: 1, koAfter: 1 },
    intro: '双方可以来回互相提一个子的形状叫“劫”。规则规定：被提劫之后，不能马上提回，必须先在别处下一手（叫“找劫材”），对方应了之后才能提回。',
    use: '实战中怎么用：开劫前先数一数双方的劫材——对方必须应的威胁手越多，打劫越有利。劫材最好是“损失不大、但对方不得不应”的棋。劫材不够时，就不要轻易开劫。',
    notes: {
      1: '黑提劫，吃掉白 D4。现在白不能马上在 D4 提回。',
      2: '白找劫材：叫吃黑 H2。这手棋逼黑必须应。',
      3: '黑应劫材，长出 J2。（如果黑不应、而是去消劫，白就会吃掉黑子。）',
      4: '白现在可以提回劫了。接下来轮到黑去找劫材——打劫就是这样一来一回，直到一方劫材用完或放弃。',
    },
  },
  {
    id: 'opening', title: '布局次序：角、边、中腹', size: 13, first: 'B',
    ab: [], aw: [], moves: ['K10', 'D4', 'D10', 'K4', 'G10', 'K7', 'D7'],
    expect: {},
    intro: '布局的基本顺序是：先占角，再守角或挂角，然后拆边，最后才是中腹。俗话叫“金角银边草肚皮”：同样的子数，在角上围的地最多，边上其次，中腹最少。',
    use: '实战中怎么用：开局先把空角占掉；角都占完后，找两边都能“拆”的大场。拆边的距离可以记住“立二拆三、立三拆四”：边上的棋越厚，拆得越远。不要太早走到中腹去。',
    notes: {
      1: '黑占右上角的星位。',
      2: '白占左下角。开局双方都先抢空角。',
      3: '黑再占一个空角。',
      4: '白占最后一个空角。四个角都有棋了，接下来是边上的大场。',
      5: '黑在两个黑角之间拆边，把两个角连成一片阵势（模样）。',
      6: '白“分投”：下在对方和自己的棋之间，上下两边都留有再拆的余地，不容易被攻击。',
      7: '黑同样在左边分投。布局阶段结束，接下来双方会围绕这些棋展开攻防。',
    },
  },
];

const lessons = LESSONS.map(les => {
  const { b, pt } = boardFor(les);
  let movePts;
  if (les.ladder) {
    movePts = solveLadder(les);
    const n = movePts.length;
    les.notes[n] = `黑提子！白棋一路逃到棋盘边也没能逃脱，一共被提掉 ${n / 2 + 0.5 | 0} 个子。`;
  } else {
    movePts = les.moves.map(pt);
  }
  movePts.forEach((p, i) => {
    const capBefore = b.capB + b.capW;
    if (!b.play(p)) throw new Error(`${les.title}: 第 ${i + 1} 手不合法`);
    const got = b.capB + b.capW - capBefore;
    if (les.expect && les.expect.captureAt === i + 1) {
      if (!got) throw new Error(`${les.title}: 第 ${i + 1} 手应该提子`);
      if (les.expect.minCaptured && got < les.expect.minCaptured) throw new Error(`${les.title}: 提子数不对 ${got}`);
    }
    if (les.expect && les.expect.koAfter === i + 1 && b.ko < 0) throw new Error(`${les.title}: 应该形成劫`);
  });
  const toName = p => L[b.x(p)] + (les.size - b.y(p));
  return {
    kind: 'lesson', id: les.id, title: les.title, size: les.size, komi: 0,
    black: '黑棋', white: '白棋', result: '', year: '',
    intro: les.intro, use: les.use, notes: les.notes,
    ab: sgfList(les.ab, les.size), aw: sgfList(les.aw, les.size), first: les.first,
    moves: movePts.map(p => toSgf(toName(p), les.size)).join(''),
  };
});

const out = '/* 套路讲解与经典棋谱（由 tools/make_games.js 生成）。 */\nwindow.GAMES = ' + JSON.stringify([...lessons, ...games], null, 1) + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'web', 'games.js'), out);
console.log([...lessons, ...games].map(g => `${g.title}: ${g.moves.length / 2} 手`).join('\n'));
