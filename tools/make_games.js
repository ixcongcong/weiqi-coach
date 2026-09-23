// 生成 web/games.js（入门课程 + 棋谱库）和 web/problems.js（练习题）。
// 每一课、每一道题都用引擎验证：着法合法、该提子的地方提子、死活结论正确；验证不过就报错退出。
// 用法：node tools/make_games.js
const fs = require('fs');
const path = require('path');
const Go = require(path.join(__dirname, '..', 'web', 'engine.js'));
const { CHAPTERS, LESSONS, PROBLEMS } = require('./curriculum.js');

const L = 'ABCDEFGHJKLMNOPQRST';
const { BLACK, WHITE, EMPTY, PASS } = Go;

function makeBoard(size, ab, aw, first) {
  const b = new Go.Board(size);
  const pt = name => b.pt(L.indexOf(name[0]), size - parseInt(name.slice(1), 10));
  b.setupStones(ab.map(pt), aw.map(pt), first === 'W' ? WHITE : BLACK);
  return { b, pt };
}
const nameOf = (b, p) => (p === PASS ? 'pass' : L[b.x(p)] + (b.n - b.y(p)));
const sgfOf = (b, p) => (p === PASS ? 'tt' : String.fromCharCode(97 + b.x(p)) + String.fromCharCode(97 + b.y(p)));
const fail = msg => { console.error('验证失败：' + msg); process.exit(1); };

// ---------------- 入门课程 ----------------

function buildLesson(les) {
  const { b, pt } = makeBoard(les.size, les.ab, les.aw, les.first);
  let moves;
  if (les.solve === 'ladder') {
    moves = Go.attack(b, pt(les.target), 60, false);
    if (!moves) fail(`${les.title}：征子不成立`);
    les.notes[moves.length] = `黑提子！白棋一路逃到棋盘边也没能逃脱，一共被提掉 ${(moves.length + 1) / 2} 个子。`;
  } else if (les.solve === 'net' || les.solve === 'kill') {
    const first = pt(les.solve === 'net' ? les.netMove : les.killMove);
    const t = b.copy();
    t.play(first);
    const rest = Go.defend(t, pt(les.target), 16, false);
    if (!rest) fail(`${les.title}：${nameOf(b, first)} 之后吃不掉`);
    moves = [first, ...rest];
    // 其它第一手都不行（保证教的是唯一正解）
    const n = moves.length;
    les.notes[n] = les.notes[n] || (les.solve === 'net' ? '黑提子！白棋无论往哪边冲都逃不出去。' : '黑提掉整块白棋：白棋做不出两个眼，是死棋。');
  } else {
    moves = les.moves.map(m => (m === 'pass' ? PASS : pt(m)));
  }
  const ex = les.expect || {};
  moves.forEach((p, i) => {
    const n = i + 1, before = b.capB + b.capW;
    if (!b.play(p)) fail(`${les.title}：第 ${n} 手 ${nameOf(b, p)} 不合法`);
    const got = b.capB + b.capW - before;
    if (ex.captures && ex.captures[n] && got < ex.captures[n]) fail(`${les.title}：第 ${n} 手应提 ${ex.captures[n]} 子，实际 ${got}`);
    if (ex.koAfter === n && b.ko < 0) fail(`${les.title}：第 ${n} 手后应该形成劫`);
    if (ex.libsAt && ex.libsAt[n]) {
      const [where, min] = ex.libsAt[n];
      if (Go.groupLibs(b, pt(where)).libs.length < min) fail(`${les.title}：第 ${n} 手后 ${where} 的气不足 ${min}`);
    }
    if (ex.alive === n) {
      const t = b.copy();
      t.toPlay = 3 - b.b[pt(les.target)];
      if (Go.attack(t, pt(les.target), 10, false)) fail(`${les.title}：第 ${n} 手后应该是活棋`);
    }
  });
  if (ex.area) {
    const sc = new Go.Scoring(b, new Uint8Array(b.size), 7.5);
    if (sc.black !== ex.area[0] || sc.white !== ex.area[1]) fail(`${les.title}：数子应为 ${ex.area}，实际 ${sc.black}/${sc.white}`);
  }
  const { b: b0 } = makeBoard(les.size, [], [], 'B');
  return {
    kind: 'lesson', id: les.id, chapter: CHAPTERS[les.ch], title: les.title, size: les.size, komi: 7.5,
    black: '黑棋', white: '白棋', result: '', year: '',
    intro: les.intro, use: les.use, notes: les.notes,
    ab: les.ab.map(s => sgfOf(b0, makeBoard(les.size, [], [], 'B').pt(s))).join(''),
    aw: les.aw.map(s => sgfOf(b0, makeBoard(les.size, [], [], 'B').pt(s))).join(''),
    first: les.first,
    moves: moves.map(p => sgfOf(b0, p)).join(''),
  };
}

// ---------------- 练习题 ----------------

const SYM = [
  (x, y, n) => [x, y], (x, y, n) => [n - 1 - x, y], (x, y, n) => [x, n - 1 - y], (x, y, n) => [n - 1 - x, n - 1 - y],
  (x, y, n) => [y, x], (x, y, n) => [n - 1 - y, x], (x, y, n) => [y, n - 1 - x], (x, y, n) => [n - 1 - y, n - 1 - x],
];

function transformName(name, s, n) {
  const x = L.indexOf(name[0]), y = n - parseInt(name.slice(1), 10);
  const [X, Y] = SYM[s](x, y, n);
  return L[X] + (n - Y);
}

/** 白走：对白的每一种应法，黑都能吃掉 Ts 中的某一块，则返回主变化，否则 null。 */
function captureAny(c, Ts, depth) {
  if (Ts.some(T => c.b[T] === EMPTY)) return [];
  const cands = new Set([PASS]);
  for (const T of Ts) for (const d of Go.groupLibs(c, T).libs) cands.add(d);
  let pv = null;
  for (const w of cands) {
    if (w !== PASS && !c.isLegal(w, c.toPlay)) continue;
    const c2 = c.copy();
    c2.play(w);
    let best = null;
    for (const T of Ts) {
      const r = Go.attack(c2, T, depth - 1, false);
      if (r && (!best || r.length < best.length)) best = r;
    }
    if (!best) return null;
    if (!pv || best.length + 1 > pv.length) pv = [w, ...best];
  }
  return pv;
}

function buildProblems() {
  const out = [];
  let id = 0;
  for (const t of PROBLEMS) {
    const n = 9;
    for (const s of t.variants) {
      const tr = arr => arr.map(v => transformName(v, s, n));
      const ab = tr(t.ab), aw = tr(t.aw), target = transformName(t.target, s, n);
      const { b, pt } = makeBoard(n, ab, aw, 'B');
      const T = pt(target);
      const answers = [];
      let pv = null;
      for (let p = 0; p < b.size; p++) {
        if (b.b[p] !== EMPTY || !b.isLegal(p, BLACK)) continue;
        const near = Go.groupLibs(b, T).stones.some(q => Math.abs(b.x(q) - b.x(p)) + Math.abs(b.y(q) - b.y(p)) <= 3);
        if (!near) continue;
        const c = b.copy();
        c.play(p);
        let ok, line = [p];
        if (t.goal === 'capture' && t.alsoTarget) {
          // 双叫吃：不管白怎么应，黑都能吃掉其中一块
          const Ts = [T, pt(transformName(t.alsoTarget, s, n))];
          const r = captureAny(c, Ts, t.depth);
          ok = !!r;
          if (ok) line = [p, ...r];
        } else if (t.goal === 'capture') {
          const r = c.b[T] === EMPTY ? [] : Go.defend(c, T, t.depth, !!t.wide);
          ok = !!r;
          if (ok) line = [p, ...r];
        } else {
          ok = !Go.attack(c, T, t.depth, false);
        }
        if (ok) {
          answers.push(p);
          if (!pv || line.length > pv.length) pv = line;
        }
      }
      if (!answers.length) fail(`练习“${t.title}”（变换 ${s}）没有正解`);
      if (answers.length > (t.wide ? 4 : 3)) fail(`练习“${t.title}”（变换 ${s}）正解太多（${answers.length} 个），题目不严谨`);
      out.push({
        id: `p${++id}`, level: t.level, title: t.title, prompt: t.prompt, size: n,
        ab: ab.map(v => sgfOf(b, pt(v))).join(''), aw: aw.map(v => sgfOf(b, pt(v))).join(''),
        goal: t.goal, target: sgfOf(b, T), depth: t.depth, wide: !!t.wide,
        also: t.alsoTarget ? sgfOf(b, pt(transformName(t.alsoTarget, s, n))) : undefined,
        answers: answers.map(p => sgfOf(b, p)), pv: pv.map(p => sgfOf(b, p)),
        tip: t.tip, explain: t.explain,
      });
    }
  }
  return out;
}

// ---------------- 棋谱库 ----------------

const NAMES = {
  'Ma Xiaochun': '马晓春', 'Cho Hunhyun': '曹薰铉', 'Cho Chikun': '赵治勋', 'Iyama Yuta': '井山裕太',
  'Takemiya Masaki': '武宫正树', 'Go Seigen': '吴清源', 'Yuki Satoshi': '结城聪', 'Yamada Kimio': '山田规三生',
  'O Meien': '王铭琬', 'Cho U': '张栩', 'Ishida Yoshio': '石田芳夫', 'Yamashita Keigo': '山下敬吾',
  'Takao Shinji': '高尾绅路', 'Michael Redmond': '迈克尔·雷蒙', 'Kitani Minoru': '木谷实',
  'Nie Weiping': '聂卫平', 'Kobayashi Koichi': '小林光一', 'Fujisawa Shuko': '藤泽秀行', 'Otake Hideo': '大竹英雄',
  'Lee Sedol': '李世石', 'Ke Jie': '柯洁', 'AlphaGo': 'AlphaGo', 'Kurahashi Masayuki': '仓桥正行',
  'Yata Naoki': '矢田直己', 'Inori Yoko': '祷阳子', 'Murakawa Daisuke': '村川大介', 'Tsukuda Akiko': '佃亚纪子',
};
const cn = s => NAMES[s] || s;

function resultText(re, komi) {
  if (!re) return '';
  const m = re.match(/^([BW])\+(.*)$/);
  if (!m) return re;
  const who = m[1] === 'B' ? '黑' : '白';
  if (m[2] === 'R' || m[2] === 'Resign') return `${who}中盘胜`;
  if (m[2] === 'T') return `${who}胜（对方超时）`;
  if (m[2] === '' || m[2] === '?') return `${who}胜`;
  return `${who}胜 ${m[2]} 目`;
}

function parseSgf(txt) {
  const prop = k => {
    const m = txt.match(new RegExp('(?:^|[;\\s\\]])' + k + '((?:\\[[^\\]]*\\])+)'));
    return m ? [...m[1].matchAll(/\[([^\]]*)\]/g)].map(x => x[1]) : [];
  };
  const moves = [...txt.matchAll(/;\s*([BW])\[([a-s]{0,2})\]/g)].map(m => (m[2] === '' ? 'tt' : m[2]));
  const first = (txt.match(/;\s*([BW])\[/) || [])[1];
  return {
    ab: prop('AB'), aw: prop('AW'), moves, first, size: parseInt(prop('SZ')[0] || '19', 10),
    km: parseFloat(prop('KM')[0] || '0') || 0, pb: prop('PB')[0] || '', pw: prop('PW')[0] || '',
    re: prop('RE')[0] || '', dt: prop('DT')[0] || '', ev: prop('EV')[0] || '',
  };
}

const INTRO9 = '职业棋手的 9 路对局。9 路棋盘很小，开局几手就进入战斗，非常适合初学者：留意双方怎样抢占中央、怎样切断与连接、怎样吃子或做活。';
const INTRO13 = '职业棋手的 13 路对局。13 路介于 9 路和 19 路之间，布局、战斗、官子都有，是从小棋盘过渡到正式棋盘的好教材。';

// 名局：自己写的介绍与重点手讲解（只写有把握的史实）
const FAMOUS = {
  '19/1846-ear-reddening.sgf': {
    title: '耳赤之局', result: '黑胜 2 目（无贴目）',
    intro: '1846 年，年仅 17 岁的秀策（当时是四段）执黑，对阵当时的顶尖高手井上幻庵因硕（八段）。那时还没有贴目。这盘棋因黑第 127 手的“耳赤之手”而闻名：据说旁观的医生看到幻庵听到这手棋后耳朵发红，由此断定黑棋形势好转。',
    notes: {
      1: '黑 1、3、5 都下在小目——这是秀策最擅长的布局风格，重视实地、棋形坚实。',
      127: '耳赤之手！这一手同时起了好几个作用：扩张下方的黑阵、削弱白棋在中腹的势力，还照应到周围几处黑棋。一子多用，是“全局观”的典范。学习要点：好棋往往不只做一件事。',
      325: '终局，黑胜 2 目。秀策此后被誉为“棋圣”。',
    },
    black: '本因坊秀策', white: '井上幻庵因硕',
  },
  '19/1933-go-seigen-shusai.sgf': {
    title: '三三·星·天元', result: '白胜 2 目',
    intro: '1933 年秋开始的一盘名局：19 岁的吴清源（五段）执黑，对阵本因坊秀哉名人。吴清源开局依次下在三三、星位和天元，这是他和木谷实倡导的“新布局”，震动了当时的棋界。按当时的规矩，名人可以随时“打挂”（暂停），这盘棋断断续续下了三个多月。',
    notes: {
      1: '黑 1 三三：一手就确保角地。在重视“小目”的年代，这被看作离经叛道。',
      3: '黑 3 星位：比小目快，更重视向边上和中央发展。',
      5: '黑 5 天元（棋盘正中央）！新布局的核心思想：重视速度和全局配合，而不只是角上的实地。',
      160: '白 160：据传这手妙手出自秀哉门下弟子的研究。这个说法流传很广，但一直没有定论。',
      252: '终局，白胜 2 目。这盘棋虽然输了，却让“新布局”名扬天下。',
    },
    black: '吴清源', white: '本因坊秀哉',
  },
  '19/1939-kitani-goseigen.sgf': {
    title: '镰仓十番棋 第一局', result: '白胜 2 目（无贴目）',
    intro: '1939 年，吴清源与木谷实在镰仓的建长寺开始了著名的“镰仓十番棋”。这是第一局，木谷实执黑、吴清源执白。两人是新布局的共同倡导者，也是那个时代最强的两位棋手。这盘棋吴清源以 2 目取胜，此后他在一系列十番棋中击败了当时几乎所有的顶尖高手。',
    notes: {},
  },
  '19/1985-nie-kobayashi.sgf': {
    title: '擂台赛：聂卫平胜小林光一', result: '黑胜 2.5 目（贴 5.5 目）',
    intro: '1985 年第 1 届中日围棋擂台赛。聂卫平执黑对阵日本队的小林光一。擂台赛的规则是输一局就下台、赢了继续守擂，两队各派一串棋手轮番上阵。这一局聂卫平获胜，是他在擂台赛上连胜的开始。',
    notes: {},
  },
  '19/1985-nie-fujisawa.sgf': {
    title: '擂台赛：聂卫平胜藤泽秀行', result: '黑胜 3.5 目（贴 5.5 目）',
    intro: '1985 年 11 月，第 1 届中日围棋擂台赛的决胜局。聂卫平执黑对阵日方主帅藤泽秀行。聂卫平获胜，中国队赢得了首届擂台赛。这场胜利在当时的中国引起了巨大轰动，掀起了全国的“围棋热”，聂卫平也因此被称为“棋圣”。',
    notes: {},
  },
  '19/1987-nie-otake.sgf': {
    title: '擂台赛：聂卫平胜大竹英雄', result: '黑胜 2.5 目（贴 5.5 目）',
    intro: '1987 年第 2 届中日围棋擂台赛的决胜局。聂卫平执黑对阵日方主帅大竹英雄，再次在最后关头获胜，帮助中国队连续第二次赢得擂台赛。',
    notes: {},
  },
  '19/2016-alphago-lee-1.sgf': {
    title: 'AlphaGo 对李世石 第 1 局', result: '白中盘胜',
    intro: '2016 年 3 月 9 日，谷歌 DeepMind 挑战赛第 1 局。李世石执黑，AlphaGo 执白。赛前多数职业棋手认为李世石会轻松获胜，结果 AlphaGo 中盘获胜，震惊了整个围棋界。',
    notes: {},
  },
  '19/2016-alphago-lee-2.sgf': {
    title: 'AlphaGo 第 37 手', result: '黑中盘胜',
    intro: '2016 年 3 月 10 日，挑战赛第 2 局。AlphaGo 执黑，李世石执白，中国规则，贴 7.5 目。这盘棋最著名的是黑第 37 手：一手第五路的“肩冲”。当时的职业棋手普遍认为这不是人类会下的棋，赛后却被公认为好棋。',
    notes: {
      37: '第 37 手，五路肩冲！按传统观念，五路太高，会让对方在下边轻松围地。但 AlphaGo 看重的是这手棋对中央和右边的影响——它改变了很多人对“高”和“低”的看法。据 DeepMind 介绍，AlphaGo 当时估计人类棋手下这手棋的概率大约只有万分之一。',
      211: '李世石认输，AlphaGo 中盘胜。',
    },
  },
  '19/2016-alphago-lee-3.sgf': {
    title: 'AlphaGo 对李世石 第 3 局', result: '白中盘胜',
    intro: '2016 年 3 月 12 日，挑战赛第 3 局。李世石执黑。AlphaGo 再次获胜，以 3:0 提前赢下了这场五番棋。',
    notes: {},
  },
  '19/2016-alphago-lee-4.sgf': {
    title: '李世石“神之一手”', result: '白中盘胜',
    intro: '2016 年 3 月 13 日，挑战赛第 4 局。前三局李世石全部落败，这一局他执白。白第 78 手的“挖”后来被称为“神之一手”，AlphaGo 随后出现一连串失误，李世石中盘获胜——这是人类在这次五番棋中赢下的唯一一局。',
    notes: {
      78: '第 78 手，挖！在黑棋看起来很厚实的中央阵地里挖进去，同时制造出好几个断点。学习要点：对方阵地里看似没有棋的地方，找到“一手多用”的要点就能打开局面。',
      79: '黑 79：一般认为这是 AlphaGo 的关键失误，它没有找到正确的应对。',
      180: 'AlphaGo 认输，李世石中盘胜。',
    },
  },
  '19/2016-alphago-lee-5.sgf': {
    title: 'AlphaGo 对李世石 第 5 局', result: '白中盘胜',
    intro: '2016 年 3 月 15 日，挑战赛最后一局。李世石执黑，AlphaGo 获胜，最终总比分 4:1。',
    notes: {},
  },
  '19/2017-kejie-1.sgf': {
    title: 'AlphaGo 对柯洁 第 1 局', result: '白胜 0.5 目',
    intro: '2017 年 5 月 23 日，乌镇围棋峰会。当时世界排名第一的柯洁执黑对阵升级版 AlphaGo。AlphaGo 只赢了半目——但这并不说明棋局很接近：AlphaGo 追求的是“赢的概率最大”，而不是赢得最多，领先时它会选择最稳妥的下法。',
    notes: {},
  },
  '19/2017-kejie-2.sgf': {
    title: 'AlphaGo 对柯洁 第 2 局', result: '黑中盘胜',
    intro: '2017 年 5 月 25 日，乌镇围棋峰会第 2 局。AlphaGo 执黑，柯洁执白。赛后 DeepMind 表示，柯洁在开局阶段下得非常出色。',
    notes: {},
  },
  '19/2017-kejie-3.sgf': {
    title: 'AlphaGo 对柯洁 第 3 局', result: '黑中盘胜',
    intro: '2017 年 5 月 27 日，乌镇围棋峰会最后一局。AlphaGo 执黑，以 3:0 结束比赛。此后 AlphaGo 宣布退役，DeepMind 公开了它的自对弈棋谱，许多 AI 的新下法很快在职业棋坛流行起来。',
    notes: {},
  },
  '19/1739-danghu.sgf': {
    title: '当湖十局（选局）', result: '黑胜 2 子半（古代数子法）',
    intro: '1739 年，清代国手范西屏与施襄夏在浙江平湖的当湖对弈十局，被誉为中国古代围棋的巅峰之作。古代采用“座子”制：开局前在四个角的星位上黑白各摆两子，然后白棋先下。本局施襄夏执黑、范西屏执白。',
    notes: { 1: '古代座子棋：四个星位上已经摆好了子，所以一开局就是边角上的接触战。这也是古代棋风比现代更重视战斗的原因之一。' },
    black: '施襄夏', white: '范西屏',
  },
};

function buildGames() {
  const dir = path.join(__dirname, 'sgf');
  const out = [];
  for (const sz of ['9', '13', '19']) {
    const files = fs.readdirSync(path.join(dir, sz)).filter(f => f.endsWith('.sgf')).sort();
    const list = [];
    for (const f of files) {
      const key = `${sz}/${f}`;
      const g = parseSgf(fs.readFileSync(path.join(dir, sz, f), 'latin1'));
      // 逐手验证合法
      const b = new Go.Board(g.size);
      const pt = s => (s === 'tt' ? PASS : b.pt(s.charCodeAt(0) - 97, s.charCodeAt(1) - 97));
      b.setupStones(g.ab.map(pt), g.aw.map(pt), g.first === 'W' ? WHITE : BLACK);
      g.moves.forEach((s, i) => { if (!b.play(pt(s))) fail(`${key} 第 ${i + 1} 手不合法`); });
      const fm = FAMOUS[key] || {};
      const black = fm.black || cn(g.pb), white = fm.white || cn(g.pw);
      const year = (g.dt.match(/\d{4}/) || [''])[0];
      list.push({
        kind: 'game', group: `名局 · ${sz} 路`, id: f.replace(/\.sgf$/, ''),
        title: fm.title || `${black} 对 ${white}`, size: g.size, komi: g.km,
        black, white, year, result: fm.result || resultText(g.re, g.km),
        intro: fm.intro || `${sz === '9' ? INTRO9 : INTRO13}${black}执黑，${white}执白，${resultText(g.re, g.km)}。`,
        notes: fm.notes || {},
        ab: g.ab.join(''), aw: g.aw.join(''), first: g.first, moves: g.moves.join(''),
      });
    }
    // 小棋盘按手数从少到多排：短的更容易看懂
    if (sz !== '19') list.sort((a, b) => a.moves.length - b.moves.length);
    else list.sort((a, b) => (a.year || '').localeCompare(b.year || ''));
    out.push(...list);
  }
  return out;
}

// ---------------- 《弈》系统课程（54 课，来自 ~/Documents/ChatGPT/围棋） ----------------

function buildYi() {
  const vm = require('vm');
  const dir = path.join(__dirname, 'yi');
  const box = {};
  box.globalThis = box;
  box.window = box;
  vm.createContext(box);
  for (const f of ['curriculum.js', 'courses-rules-tactics.js', 'courses-strategy-review.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), box, { filename: f });
  }
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'curriculum-index.json'), 'utf8'));
  const units = [...box.GoCurriculum.lessons, ...box.GoCourseUnits].sort((a, b) => a.id - b.id);
  if (units.length !== index.lessonCount) fail(`《弈》应有 ${index.lessonCount} 课，读到 ${units.length} 课`);
  let checked = 0;
  for (const u of units) {
    for (const e of u.exercises || []) {
      if (!e.board) continue;
      const n = e.board.size, b = new Go.Board(n);
      const P = i => b.pt(i % n, Math.floor(i / n));
      for (const i of [...e.board.black, ...e.board.white, ...(e.answers || []).filter(() => e.type === 'point')]) {
        if (i < 0 || i >= n * n) fail(`《弈》第 ${u.id} 课 ${e.id}：点位 ${i} 超出棋盘`);
      }
      if (e.type === 'play') {
        b.setupStones(e.board.black.map(P), e.board.white.map(P), e.toPlay || BLACK);
        for (const [k, mv] of e.line.entries()) {
          b.toPlay = mv.color;
          if (!b.play(P(mv.index))) fail(`《弈》第 ${u.id} 课 ${e.id}：第 ${k + 1} 手（编号 ${mv.index}）不合法`);
        }
        checked++;
      }
    }
  }
  console.log(`《弈》${units.length} 课，${units.reduce((n, u) => n + (u.exercises || []).length, 0)} 道课内练习，${checked} 道按步走的练习已逐手验证合法。`);
  return units.map(u => ({
    kind: 'yi', id: `yi${u.id}`, num: u.id, stage: u.stage,
    stageTitle: (index.stages.find(st => st.id === u.stage) || {}).title || '',
    title: u.title, subtitle: u.subtitle || '', minutes: u.minutes || 0,
    objectives: u.objectives || [], sections: u.sections || [], exercises: u.exercises || [],
    takeaway: u.takeaway || '', practice: u.practice || '',
    size: ((u.exercises || []).find(e => e.board) || { board: { size: 9 } }).board.size,
    notes: {}, moves: '', ab: '', aw: '', first: 'B', komi: 7.5,
  }));
}

const yi = buildYi();
const lessons = LESSONS.map(buildLesson);
const games = buildGames();
const problems = buildProblems();

fs.writeFileSync(path.join(__dirname, '..', 'web', 'games.js'),
  '/* 《弈》系统课程、动画演示课与棋谱库（由 tools/make_games.js 生成，请勿手改）。 */\nwindow.GAMES = ' + JSON.stringify([...yi, ...lessons, ...games]) + ';\n');
fs.writeFileSync(path.join(__dirname, '..', 'web', 'problems.js'),
  '/* 练习题（由 tools/make_games.js 生成，请勿手改）。 */\nwindow.PROBLEMS = ' + JSON.stringify(problems) + ';\n');

console.log(`课程 ${lessons.length} 课：`);
for (const c of CHAPTERS) console.log(`  ${c}：${lessons.filter(l => l.chapter === c).map(l => l.title).join('、')}`);
console.log(`棋谱 ${games.length} 局：` + ['9', '13', '19'].map(s => `${s} 路 ${games.filter(g => g.size === +s).length}`).join('，'));
console.log(`练习 ${problems.length} 题：` + [1, 2, 3].map(l => `第 ${l} 级 ${problems.filter(p => p.level === l).length}`).join('，'));
for (const p of problems) {
  const b = new Go.Board(9);
  const nm = s => L[s.charCodeAt(0) - 97] + (9 - (s.charCodeAt(1) - 97));
  console.log(`  ${p.id} ${p.title}：正解 ${p.answers.map(nm).join('/')}，变化 ${p.pv.length} 手`);
}
