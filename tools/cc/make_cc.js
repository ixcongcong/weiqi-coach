#!/usr/bin/env node
// 生成 web/cc/data-chess.js、web/cc/data-xiangqi.js：
//  1. 课程：展开每一步的局面，检查局面合法、答案合法、答案确实是好棋（引擎验证）、“将死”题确实将死；
//  2. 练习：用引擎自我对弈生成局面，挑出“唯一解”的一步杀、两步杀、得子题；
//  3. 棋谱：把记谱转成内部着法，逐步检查合法。
// 用法：node tools/cc/make_cc.js [chess|xiangqi]
'use strict';
const fs = require('fs');
const path = require('path');
const Chess = require('../../web/cc/chess.js');
const Xiangqi = require('../../web/cc/xiangqi.js');
const { Engine, MATE, mateIn } = require('../../web/cc/search.js');

const OUT = path.join(__dirname, '../../web/cc');
const only = process.argv[2];
let errors = 0;
const fail = msg => { errors++; console.error('✗', msg); };

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function parse(R, p, str, where) {
  const m = R.parseSan(p, str);
  if (!m) fail(`${where}：着法“${str}”不合法（局面 ${R.toFEN(p)}）`);
  return m;
}

function isMate(R, p, m) {
  if (!R.make(p, m)) return false;
  const r = !R.legalMoves(p).length && (R.id === 'xiangqi' || R.inCheck(p));
  R.unmake(p);
  return r;
}

function buildLessons(R, eng, src) {
  const out = [];
  for (const l of src) {
    let prev = null;
    const steps = [];
    l.steps.forEach((st, si) => {
      const where = `${l.title} 第 ${si + 1} 步`;
      let p;
      if (st.fen) p = R.fromFEN(st.fen);
      else if (prev) p = R.fromFEN(prev);
      else { fail(`${where}：没有局面`); p = R.fromFEN(R.START); }
      // 对方不能正处在被将军的状态
      p.turn ^= 1;
      if (R.inCheck(p)) fail(`${where}：不该走的一方正被将军，局面不合法`);
      p.turn ^= 1;
      let last = null;
      for (const mv of st.moves || []) {
        const m = parse(R, p, mv, where);
        if (!m) break;
        last = R.uci(m);
        R.make(p, m);
      }
      const fen = R.toFEN(p);
      const o = { text: st.text, fen };
      if (last) o.last = last;
      if (st.marks) o.marks = st.marks;
      if (st.task) {
        const t = st.task, answers = [];
        for (const a of t.answers) { const m = parse(R, p, a, where); if (m) answers.push(m); }
        if (!R.legalMoves(p).length) fail(`${where}：没有合法着法`);
        if (t.mate) {
          const mates = R.legalMoves(p).filter(m => isMate(R, p, m));
          if (!mates.length) fail(`${where}：标成“将死”，但这个局面没有一步杀`);
          for (const m of answers) if (!isMate(R, p, m)) fail(`${where}：答案 ${R.san(p, m)} 不是杀棋`);
        } else if (!t.free && !t.noStalemate && answers.length) {
          const r = eng.analyze(p, { ms: 1500, all: true });
          const best = r.moves[0].score;
          for (const m of answers) {
            const x = r.moves.find(y => y.m === m);
            if (!x || best - x.score > 60) fail(`${where}：答案 ${R.san(p, m)} 不够好（${x && x.score} 对比最佳 ${R.san(p, r.best)} ${best}）`);
          }
          const better = r.moves.filter(y => !answers.includes(y.m) && y.score > best - 20 && best - y.score < 20);
          if (better.length && !t.answers.length) void better;
        }
        const task = { answers: answers.map(R.uci) };
        for (const k of ['prompt', 'hint', 'ok', 'no', 'mate', 'noStalemate']) if (t[k] !== undefined) task[k] = t[k];
        const first = answers[0];
        const q = R.fromFEN(fen);
        if (first) { R.make(q, first); }
        if (t.reply) {
          const rm = parse(R, q, t.reply, where + ' 对方应着');
          if (rm) { task.reply = R.uci(rm); R.make(q, rm); }
        }
        o.task = task;
        prev = R.toFEN(q);
      } else {
        prev = fen;
      }
      if (st.goal) {
        o.goal = { limit: st.goal.limit };
        for (const k of ['prompt', 'ok']) if (st.goal[k]) o.goal[k] = st.goal[k];
        const r = eng.analyze(p, { ms: 4000 });
        const mi = mateIn(r.score);
        console.log(`  ${where}：目标局面引擎评估 ${mi > 0 ? `${mi} 步杀` : r.score}`);
        if (r.score < 300) fail(`${where}：目标局面看起来赢不了`);
      }
      steps.push(o);
    });
    out.push({ id: l.id, stage: l.stage, title: l.title, steps });
  }
  return out;
}

function buildGames(R, src) {
  const out = [];
  for (const g of src) {
    const p = R.fromFEN(g.fen || R.START), moves = [];
    for (const mv of g.moves) {
      const m = parse(R, p, mv, `棋谱《${g.title}》第 ${moves.length + 1} 手`);
      if (!m) break;
      moves.push(R.uci(m));
      R.make(p, m);
    }
    if (g.endsInMate && R.legalMoves(p).length) fail(`棋谱《${g.title}》最后应当是杀棋`);
    out.push({ id: g.id, title: g.title, info: g.info, intro: g.intro, fen: R.toFEN(R.fromFEN(g.fen || R.START)), moves, notes: g.notes || {} });
  }
  return out;
}

// ---------------- 练习题：自我对弈 + 筛选 ----------------

function genPuzzles(R, eng, want, seed) {
  const rand = rng(seed);
  const found = { mate1: [], mate2: [], win: [] }, seen = new Set();
  const full = () => Object.keys(want).every(k => found[k].length >= want[k]);
  let games = 0;
  while (!full() && games < 400) {
    games++;
    const p = R.fromFEN(R.START);
    for (let ply = 0; ply < 160; ply++) {
      const legal = R.legalMoves(p);
      if (!legal.length || R.isDraw(p)) break;
      if (ply >= 8) {
        const fen = R.toFEN(p), key = fen.split(' ').slice(0, 2).join(' ');
        if (!seen.has(key)) {
          seen.add(key);
          const mates = legal.filter(m => isMate(R, p, m));
          if (mates.length === 1 && found.mate1.length < want.mate1 && !R.inCheck(p)) {
            found.mate1.push({ fen, kind: 'mate1', best: R.uci(mates[0]), score: MATE - 1 });
          } else if (!mates.length && !R.inCheck(p)) {
            const r = eng.analyze(p, { depth: 4, all: true, stopOnMate: false });
            const m2 = r.moves.filter(x => x.score >= MATE - 3);
            if (m2.length === 1 && found.mate2.length < want.mate2) {
              found.mate2.push({ fen, kind: 'mate2', best: R.uci(m2[0].m), score: m2[0].score });
            } else if (!m2.length && r.moves.length > 1 && found.win.length < want.win) {
              const best = r.moves[0].score, second = r.moves[1].score, stand = R.evaluate(p);
              const bm = r.moves[0].m;
              if (best >= 250 && best < MATE - 500 && best - second >= 250 && best - stand >= 200 && (R.isCapture(p, bm) || isCheckMove(R, p, bm))) {
                // 用更深的搜索确认
                const r2 = eng.analyze(p, { depth: 6, all: true });
                if (r2.best === bm && r2.moves[0].score - r2.moves[1].score >= 200 && r2.moves[0].score >= 250) {
                  found.win.push({ fen, kind: 'win', best: R.uci(bm), score: r2.moves[0].score });
                }
              }
            }
          }
        }
      }
      // 选下一手：浅层搜索 + 随机，模拟业余对局
      const r = eng.analyze(p, { depth: 2, all: true });
      const top = r.moves[0].score, temp = 70;
      const list = r.moves.filter(x => x.score > top - 300);
      const ws = list.map(x => Math.exp((x.score - top) / temp));
      let z = rand() * ws.reduce((a, b) => a + b, 0), pick = list[0].m;
      for (let i = 0; i < list.length; i++) { z -= ws[i]; if (z <= 0) { pick = list[i].m; break; } }
      R.make(p, pick);
    }
    process.stdout.write(`\r  自我对弈 ${games} 盘：一步杀 ${found.mate1.length}，两步杀 ${found.mate2.length}，得子 ${found.win.length}   `);
  }
  console.log();
  // 按难度交错排列：一步杀 → 得子 → 两步杀
  const out = [];
  const n = Math.max(want.mate1, want.mate2, want.win);
  for (let i = 0; i < n; i++) for (const k of ['mate1', 'win', 'mate2']) if (found[k][i]) out.push(found[k][i]);
  return out.map((z, i) => ({ id: `${R.id[0]}p${i + 1}`, ...z }));
}

function isCheckMove(R, p, m) {
  if (!R.make(p, m)) return false;
  const c = R.inCheck(p);
  R.unmake(p);
  return c;
}

// ---------------- 主程序 ----------------

for (const [id, R] of [['chess', Chess], ['xiangqi', Xiangqi]]) {
  if (only && only !== id) continue;
  console.log(`== ${id}`);
  const eng = new Engine(R);
  const lessons = buildLessons(R, eng, require(`./lessons-${id}.js`));
  console.log(`  课程 ${lessons.length} 课，${lessons.reduce((n, l) => n + l.steps.length, 0)} 步`);
  const games = buildGames(R, require(`./games-${id}.js`));
  console.log(`  棋谱 ${games.length} 局`);
  const puzzles = genPuzzles(R, eng, { mate1: 14, mate2: 12, win: 14 }, id === 'chess' ? 20260924 : 90124);
  console.log(`  练习 ${puzzles.length} 题`);
  const data = { lessons, puzzles, games };
  fs.writeFileSync(path.join(OUT, `data-${id}.js`),
    `/* 由 tools/cc/make_cc.js 生成，不要手工修改 */\nwindow.CC_DATA = window.CC_DATA || {};\nwindow.CC_DATA[${JSON.stringify(id)}] = ${JSON.stringify(data)};\n`);
}
if (errors) { console.error(`\n共 ${errors} 个问题`); process.exit(1); }
console.log('全部检查通过');
