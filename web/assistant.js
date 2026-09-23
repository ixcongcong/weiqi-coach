'use strict';
/* 弈的对话助手。
 * 1) 离线：用引擎精确计算回答关于棋盘的问题（气、地盘、得到的目、断点、能吃的棋、危险的棋、眼……），并在棋盘上标出来。
 * 2) 其它问题交给大模型，按顺序尝试：家里 Mac 的本地模型 → OpenRouter 免费模型 → DeepSeek。
 *    发给模型的是引擎算好的“局面事实”，模型只负责用自然语言解释，不需要自己看懂棋盘。 */

const AI_KEY = 'weiqi-coach-ai';
const AI = { useLocal: true, orKey: '', orModel: '', dsKey: '', useOR: true, useDS: true, order: 'openrouter,local,deepseek' };
// 默认用 NVIDIA Nemotron 3 Ultra（OpenRouter 免费）；被限流时依次换下面的免费模型
const OR_PREFERRED = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free'];
try { Object.assign(AI, JSON.parse(localStorage.getItem(AI_KEY) || '{}')); } catch (e) { /* 忽略 */ }
function saveAI() { try { localStorage.setItem(AI_KEY, JSON.stringify(AI)); } catch (e) { /* 忽略 */ } }

// ---------------- 局面工具 ----------------

/** 从一段文字里找出棋盘坐标（例如 D4、q16）。 */
function coordsIn(text, b) {
  const out = [];
  for (const m of String(text).matchAll(/(?<![A-Za-z])([A-HJ-Ta-hj-t])\s?(1[0-9]|[1-9])(?![0-9])/g)) {
    const p = nameToPt(b, m[1] + m[2]);
    if (p >= 0 && !out.includes(p)) out.push(p);
  }
  return out;
}

function allGroups(b) {
  const seen = new Set(), out = [];
  for (let p = 0; p < b.size; p++) {
    const v = b.b[p];
    if ((v !== BLACK && v !== WHITE) || seen.has(p)) continue;
    const g = G.groupLibs(b, p);
    g.stones.forEach(q => seen.add(q));
    out.push({ color: v, p, stones: g.stones, libs: g.libs });
  }
  return out;
}

const names = (b, pts, max) => pts.slice(0, max || 40).map(p => b.name(p)).join('、') + (pts.length > (max || 40) ? ` 等 ${pts.length} 个` : '');
const whoName = c => (S.mode === 'play' && S.game.opp !== 'human' ? (c === S.game.human ? '你' : 'AI') : colorName(c));

/** 当前问题所针对的局面、视角和分析。 */
function assistantContext() {
  const c = askContext();
  const k = S.mode === 'study' ? T.idx : S.history.length;
  const list = S.mode === 'study' ? T.analyses : S.analyses;
  const la = S.mode === 'practice' ? null : latestAnalysis(list, k);
  let lastMove = c.b.lastMove, lastComment = null;
  if (S.mode === 'play' && S.history.length) {
    // 最近一手“你”下的棋
    for (let j = S.history.length - 1; j >= 0; j--) {
      if (boardAt(j).toPlay === S.game.human) { lastComment = S.comments[j] || null; if (S.history[j] >= 0) lastMove = S.history[j]; break; }
    }
  }
  return { ...c, a: la ? la.a : null, lastMove, lastComment };
}

/** 问题问的是哪一方：“对方/AI/白棋/黑棋”，否则是自己 */
function askedColor(ctx, q) {
  return /对方|AI|电脑|白棋|白子|它/.test(q) && S.mode === 'play' ? 3 - ctx.me : /白/.test(q) ? WHITE : /黑/.test(q) ? BLACK : ctx.me;
}

/** 从问题里判断问的是哪块棋：优先坐标，其次“对方/白棋/黑棋”，否则是自己最近下的那块。 */
function targetGroup(ctx, q) {
  const b = ctx.b;
  const pts = coordsIn(q, b).filter(p => b.b[p] === BLACK || b.b[p] === WHITE);
  if (pts.length) return G.groupLibs(b, pts[0]);
  const opp = /对方|AI|电脑|白棋|白子|它/.test(q) && S.mode === 'play' ? 3 - ctx.me : /白/.test(q) ? WHITE : /黑/.test(q) ? BLACK : ctx.me;
  // 最近一手属于该颜色的棋
  if (ctx.lastMove >= 0 && b.b[ctx.lastMove] === opp && S.mode === 'play' && opp === ctx.me) return G.groupLibs(b, ctx.lastMove);
  if (b.lastMove >= 0 && b.b[b.lastMove] === opp) return G.groupLibs(b, b.lastMove);
  const gs = allGroups(b).filter(g => g.color === opp).sort((x, y) => x.libs.length - y.libs.length || y.stones.length - x.stones.length);
  return gs[0] ? G.groupLibs(b, gs[0].p) : null;
}

// ---------------- 离线回答 ----------------

const INTENTS = [
  {
    test: q => /气/.test(q) && !/(天气|生气|气氛)/.test(q),
    run(ctx, q) {
      const b = ctx.b;
      // 没有指定坐标、也没说“这块/刚才”：列出这一方所有棋块的气
      const specific = coordsIn(q, b).some(p => b.b[p] === BLACK || b.b[p] === WHITE) || /这块|这个子|这颗|这一块|刚才|刚下|那块|最后/.test(q);
      if (!specific) {
        const color = askedColor(ctx, q);
        const gs = allGroups(b).filter(x => x.color === color)
          .sort((x, y) => x.libs.length - y.libs.length || y.stones.length - x.stones.length);
        if (!gs.length) return { html: `<p>${whoName(color)}在棋盘上还没有棋子。</p>` };
        const all = [];
        for (const x of gs) for (const l of x.libs) if (!all.includes(l)) all.push(l);
        Q.mark = all;
        Q.area = null;
        const warn = n => (n === 1 ? ' <b style="color:var(--bad)">只剩 1 口气，正被叫吃！</b>' : n === 2 ? ' <b style="color:var(--warn)">只有 2 口气，比较危险。</b>' : n >= 4 ? ' 暂时安全。' : '');
        const items = gs.map(x => `<li><b>${esc(names(b, x.stones, 6))}</b>（${x.stones.length} 子）：<b>${x.libs.length} 口气</b>——${esc(names(b, x.libs))}。${warn(x.libs.length)}</li>`).join('');
        return {
          html: `<p>${whoName(color)}现在有 <b>${gs.length} 块棋</b>，一共 ${all.length} 口气（棋盘上的蓝圈，两块棋共用的气只画一次）：</p><ul>${items}</ul>
            <p class="note">气 = 棋块上下左右相邻的空点。只有上下左右连着的棋子才算一块，斜着相邻的是两块棋，各算各的气。想只看某一块，就在问题里写坐标，例如“D4 有几口气”。</p>`,
        };
      }
      const g = targetGroup(ctx, q);
      if (!g) return { html: '<p>棋盘上还没有棋子。</p>' };
      const c = b.b[g.stones[0]];
      Q.mark = g.libs.slice();
      Q.area = null;
      const warn = g.libs.length === 1 ? '只剩 1 口气，正被叫吃！' : g.libs.length === 2 ? '只有 2 口气，比较危险。' : g.libs.length >= 4 ? '气很多，暂时安全。' : '';
      return {
        html: `<p>${whoName(c)}在 <b>${esc(b.name(g.stones[0]))}</b> 的这块棋共 ${g.stones.length} 个子，有 <b>${g.libs.length} 口气</b>：${esc(names(b, g.libs))}（棋盘上的蓝圈）。${warn}</p>
          <p class="note">气 = 这块棋上下左右相邻的空点（斜的不算）；连在一起的棋子共用所有的气。想问别的棋，在问题里写上坐标，例如“D4 有几口气”。</p>`,
      };
    },
  },
  {
    test: q => /目|地盘|围了|实地|空/.test(q) && !/目标|题目|节目/.test(q),
    needsA: true,
    run(ctx, q) {
      const b = ctx.b;
      // 问“刚才/这手/得到的目” → 显示那手棋带来的点
      if (/刚才|这手|这步|得到|多了|赚/.test(q) && ctx.lastComment && ctx.lastComment.gain) {
        const cm = ctx.lastComment, pts = cm.gain.map(n => nameToPt(b, n)).filter(p => p >= 0);
        Q.area = pts;
        Q.mark = null;
        if (!pts.length) {
          return { html: `<p>你第 ${cm.j + 1} 手下在 <b>${esc(cm.name)}</b>，没有哪个点因为这手棋“明显”变成你的地盘。开局阶段一手棋的作用分散在一大片区域里，每个点只增加了一点点可能性，所以标不出具体的点；越到后面，得失会越集中、越容易标出来。</p>` };
        }
        return {
          html: `<p>你第 ${cm.j + 1} 手下在 <b>${esc(cm.name)}</b> 之后，下面这些点更可能变成你的地盘：<b>${esc(cm.gain.join('、'))}</b>（棋盘上的蓝色方块，共 ${pts.length} 个）。</p>
            <p class="note">“约多少目”是这样估出来的：引擎从下棋前、下棋后各模拟几百盘，看每个点最后归谁的比例变化了多少，加起来就是这手棋让双方目差变化的大小。它是估算，不是已经确定的地。</p>`,
        };
      }
      if (!ctx.a) return { html: '<p>引擎这会儿没能分析这个局面（可能刚换了局面），请再点一次问题。</p>' };
      const mine = [], theirs = [], open = [];
      const sgn = ctx.me === BLACK ? 1 : -1;
      for (let p = 0; p < b.size; p++) {
        if (b.b[p] !== EMPTY) continue;
        const o = ctx.a.own[p] * sgn;
        if (o > 0.5) mine.push(p); else if (o < -0.5) theirs.push(p); else open.push(p);
      }
      const other = /对方|AI|白|它的/.test(q) && S.mode === 'play';
      Q.area = other ? theirs : mine;
      Q.mark = null;
      const me = ctx.meName, op = S.mode === 'play' ? 'AI' : colorName(3 - ctx.me);
      return {
        html: `<p>按引擎估算，现在空点里大约 <b>${mine.length}</b> 个属于${esc(me)}，<b>${theirs.length}</b> 个属于${esc(op)}，还有 ${open.length} 个没有确定。棋盘上的蓝色方块是${other ? esc(op) : esc(me)}的地盘。</p>
          <p>加上棋子本身，形势：${ctx.a.score > 0 ? '黑' : '白'}领先约 ${Math.abs(ctx.a.score).toFixed(1)}（已算贴目）。</p>
          <p class="note">“目”就是围住的空点。本程序按中国规则数子：棋子数 + 围住的空点数。没确定的点，双方都还有机会去争。</p>`,
      };
    },
  },
  {
    test: q => /断点|切断|断开|能断|被断/.test(q),
    run(ctx, q) {
      const b = ctx.b, mineSide = !/对方|AI|白/.test(q) || S.mode !== 'play';
      const owner = mineSide ? ctx.me : 3 - ctx.me, cutter = 3 - owner, pts = [];
      for (let p = 0; p < b.size; p++) {
        if (b.b[p] !== EMPTY) continue;
        const ids = new Set();
        for (const d of b.dir) if (b.b[p + d] === owner) ids.add(G.groupLibs(b, p + d).stones[0]);
        if (ids.size >= 2 && b.isLegal(p, cutter) && !b.isSelfAtari(p, cutter)) pts.push(p);
      }
      Q.mark = pts;
      Q.area = null;
      if (!pts.length) return { html: `<p>${mineSide ? esc(ctx.meName) + '的棋' : '对方的棋'}现在没有明显的断点。</p>` };
      return {
        html: `<p>${mineSide ? esc(ctx.meName) + '的棋' : '对方的棋'}有这些断点：<b>${esc(names(b, pts))}</b>（蓝圈）。${mineSide ? '对方下在这些点，就能把你的棋分成两块。重要的断点要及时补（粘上或者虎一手）。' : '你下在这些点，可以把对方分开，然后分别攻击。'}</p>`,
      };
    },
  },
  {
    test: q => /(能|可以|怎么).{0,4}(吃|提)|吃掉|吃哪/.test(q),
    run(ctx) {
      const b = ctx.b, found = [];
      for (const g of allGroups(b)) {
        if (g.color === ctx.me || g.libs.length > 3) continue;
        const t = b.copy();
        t.toPlay = ctx.me;
        const r = G.attack(t, g.p, g.libs.length === 1 ? 2 : 10, false);
        if (r && r.length) found.push({ g, first: r[0] });
      }
      Q.mark = found.map(f => f.first);
      Q.area = found.flatMap(f => f.g.stones);
      if (!found.length) return { html: '<p>现在没有能直接吃掉的对方棋子。可以先紧对方气少的棋，或者去抢大场。</p>' };
      return {
        html: `<p>可以吃掉：</p><ul>${found.map(f => `<li>${esc(b.name(f.g.stones[0]))} 一带的 ${f.g.stones.length} 个子（现在 ${f.g.libs.length} 口气）：先下 <b>${esc(b.name(f.first))}</b>${f.g.libs.length === 1 ? '，直接提掉' : '，对方怎么逃都逃不掉（按引擎计算）'}。</li>`).join('')}</ul>
          <p class="note">蓝色方块是能吃的棋子，蓝圈是第一手应该下的点。</p>`,
      };
    },
  },
  {
    test: q => /危险|会被吃|被叫吃|要补|救/.test(q),
    run(ctx) {
      const b = ctx.b, found = [];
      for (const g of allGroups(b)) {
        if (g.color !== ctx.me || g.libs.length > 3) continue;
        const t = b.copy();
        t.toPlay = 3 - ctx.me;
        const r = G.attack(t, g.p, g.libs.length === 1 ? 2 : 10, false);
        if (r && r.length) {
          const t2 = b.copy();
          t2.toPlay = ctx.me;
          found.push({ g, threat: r[0], save: G.findDefense(t2, g.p, 10, false) });
        }
      }
      Q.area = found.flatMap(f => f.g.stones);
      Q.mark = found.map(f => (f.save !== null && f.save !== undefined ? f.save : f.threat)).filter(p => p >= 0);
      if (!found.length) return { html: `<p>按引擎计算，${esc(ctx.meName)}现在没有马上会被吃掉的棋。</p><p class="note">想看整体的死活，可以点“哪块棋最危险？”。</p>` };
      return {
        html: `<p>这些棋有被吃的危险：</p><ul>${found.map(f => `<li>${esc(b.name(f.g.stones[0]))} 一带的 ${f.g.stones.length} 个子（${f.g.libs.length} 口气）：对方下 ${esc(b.name(f.threat))} 就能吃掉。${f.save !== null && f.save !== undefined ? `可以下 <b>${esc(b.name(f.save))}</b> 来救。` : '已经很难救了，可以考虑放弃，去下别处。'}</li>`).join('')}</ul>
          <p class="note">蓝色方块是危险的棋子，蓝圈是建议的救法。</p>`,
      };
    },
  },
  {
    test: q => /眼/.test(q) && !/眼光|眼睛/.test(q),
    run(ctx, q) {
      const b = ctx.b, g = targetGroup(ctx, q);
      if (!g) return { html: '<p>棋盘上还没有棋子。</p>' };
      const c = b.b[g.stones[0]], eyes = [];
      for (const l of g.libs) if (b.isEye(l, c)) eyes.push(l);
      Q.mark = eyes;
      Q.area = g.stones;
      return {
        html: `<p>${whoName(c)}在 ${esc(b.name(g.stones[0]))} 的这块棋（蓝色方块）${eyes.length ? `有 <b>${eyes.length}</b> 个完整的眼：${esc(names(b, eyes))}（蓝圈）。` : '还没有完整的眼。'}${eyes.length >= 2 ? '两个眼，已经是活棋。' : eyes.length === 1 ? '只有一个眼，还需要再做一个才能活。' : '需要扩大眼位、做出两个眼才能活。'}</p>
          <p class="note">这里只数已经成形的单个眼；还没围好的大眼位，可以问“这块棋活吗？”（点提问里的按钮，再点这块棋）。</p>`,
      };
    },
  },
  {
    test: q => /为什么|这手|这步|刚才|讲解|什么意思/.test(q) && !/这盘|本局|总结|整盘/.test(q) && S.mode === 'play',
    run(ctx) {
      const cm = ctx.lastComment;
      if (!cm) return null;
      Q.area = (cm.gain || []).map(n => nameToPt(ctx.b, n)).filter(p => p >= 0);
      Q.mark = cm.best ? [cm.best.move] : null;
      return {
        html: `<p>你第 ${cm.j + 1} 手下在 <b>${esc(cm.name)}</b>${cm.q ? `，评价“${esc(cm.q.label)}”` : ''}：</p>${reasonsHtml(cm.reasons)}
          ${cm.best ? `<p>更好的是 <b>${esc(cm.best.name)}</b>（蓝圈）：</p>${reasonsHtml(cm.best.reasons)}` : ''}`,
        askMore: true,
      };
    },
  },
];

// ---------------- 给大模型的局面事实 ----------------

function boardText(b) {
  const L = G.LETTERS.slice(0, b.n).split('');
  const rows = [`   ${L.join(' ')}`];
  for (let y = 0; y < b.n; y++) {
    let r = String(b.n - y).padStart(2, ' ') + ' ';
    for (let x = 0; x < b.n; x++) {
      const v = b.b[b.pt(x, y)];
      r += (v === BLACK ? 'X' : v === WHITE ? 'O' : '.') + ' ';
    }
    rows.push(r.trimEnd());
  }
  return rows.join('\n');
}

function buildFacts(ctx) {
  const b = ctx.b, lines = [];
  const modeText = S.mode === 'play' ? `学生正在和 AI 对局（学生执${colorName(S.game.human)}，${captureRule() ? `吃子棋：先吃到 ${S.game.captureN} 子获胜` : `正式对局，贴目 ${S.game.komi}`}）`
    : S.mode === 'study' ? `学生在看《${sg().title}》第 ${T.idx} 手` : `学生在做练习题：${pb() ? pb().prompt : ''}`;
  lines.push(`【场景】${modeText}`);
  lines.push(`【棋盘】${b.n} 路。X=黑，O=白，.=空。列 ${G.LETTERS.slice(0, b.n)}（没有 I），行号从下往上。现在轮到${colorName(b.toPlay)}下。提子：黑 ${b.capB}，白 ${b.capW}。`);
  lines.push(boardText(b));
  if (S.mode === 'play' && S.history.length) {
    const recent = [];
    for (let j = Math.max(0, S.history.length - 6); j < S.history.length; j++) {
      const c0 = boardAt(j).toPlay;
      recent.push(`第${j + 1}手 ${whoName(c0)}(${colorName(c0)}) ${S.history[j] === PASS ? '停一手' : b.name(S.history[j])}`);
    }
    lines.push(`【最近几手】${recent.join('；')}`);
  }
  lines.push('【棋块】');
  const sgn = c => (c === BLACK ? 1 : -1);
  for (const g of allGroups(b).sort((x, y) => x.libs.length - y.libs.length).slice(0, 24)) {
    let safe = '';
    if (ctx.a) {
      const s = g.stones.reduce((t, p) => t + ctx.a.own[p] * sgn(g.color), 0) / g.stones.length;
      safe = s > 0.6 ? '，安全' : s > 0.2 ? '，比较安全' : s > -0.2 ? '，死活未定' : '，基本死了';
    }
    lines.push(`- ${whoName(g.color)}(${colorName(g.color)}) ${g.stones.length}子 [${names(b, g.stones, 10)}]：${g.libs.length}口气 [${names(b, g.libs, 12)}]${safe}`);
  }
  if (ctx.a) {
    const me = ctx.me, meWr = ctx.a.toPlay === me ? ctx.a.wr : 1 - ctx.a.wr;
    const mine = [], theirs = [];
    for (let p = 0; p < b.size; p++) {
      if (b.b[p] !== EMPTY) continue;
      const o = ctx.a.own[p] * sgn(me);
      if (o > 0.5) mine.push(p); else if (o < -0.5) theirs.push(p);
    }
    if (ctx.a.nn) lines.push('【引擎】KataGo 神经网络（业余高段以上水平）的分析，胜率和目数都比较可靠。');
    lines.push(`【引擎分析】${ctx.meName}的胜率约 ${pct(meWr)}；形势：${ctx.a.score > 0 ? '黑' : '白'}领先约 ${Math.abs(ctx.a.score).toFixed(1)}（含贴目）。`);
    lines.push(`【地盘估计】${ctx.meName}的空点 ${mine.length} 个 [${names(b, mine, 30)}]；对方的空点 ${theirs.length} 个 [${names(b, theirs, 30)}]。`);
    lines.push(`【引擎推荐】${ctx.a.cands.slice(0, 3).map(c => `${b.name(c.move)}（走后胜率 ${pct(c.wr)}${c.lead !== undefined ? `，走后${c.lead >= 0 ? '领先' : '落后'}约 ${Math.abs(c.lead).toFixed(1)} 目` : ''}）`).join('，')}（这是轮到${colorName(ctx.a.toPlay)}时的推荐）`);
  }
  if (S.mode === 'play' && S.summary && (S.result || S.scoring)) lines.push(`【本局总结】\n${S.summary.facts}`);
  const cm = ctx.lastComment;
  if (cm) {
    lines.push(`【学生上一手的讲解】第${cm.j + 1}手 ${cm.name}${cm.q ? `，评价：${cm.q.label}` : ''}。${(cm.reasons || []).join(' ')}${cm.best ? ` 更好的下法：${cm.best.name}。` : ''}`);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `你是围棋老师“弈”。学生是刚学围棋几天的初学者。
要求：
1. 关于当前棋盘的问题，只根据【局面事实】回答。事实是围棋引擎精确计算的，不要编造棋盘上不存在的棋子、坐标或结论；事实里没有的，就说“引擎没有算到这一点”，再给一般性的建议。
2. 坐标写法和事实一致（例如 D4），程序会自动在棋盘上标出你提到的坐标。
3. 用简体中文，简短清楚（一般不超过 200 字），可以分点；专业词第一次出现时顺便解释。
4. 围棋规则和知识类问题可以直接回答。`;

// ---------------- 大模型后端 ----------------

let localHealth = { at: 0, ok: false, model: '' };
async function checkLocal(force) {
  if (!AI.useLocal) return false;
  if (!force && Date.now() - localHealth.at < 60000) return localHealth.ok;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(`${syncServer()}/api/llm/health`, { signal: ctl.signal, cache: 'no-store' });
    const d = await r.json();
    localHealth = { at: Date.now(), ok: !!d.ok, model: d.model || '', reason: d.reason || '' };
  } catch (e) {
    localHealth = { at: Date.now(), ok: false, model: '', reason: '连不上家里的 Mac（不在家里的网络，或学习中心没有启动）' };
  } finally {
    clearTimeout(timer);
  }
  return localHealth.ok;
}

let orFree = null;
async function pickFreeModel() {
  if (AI.orModel) return AI.orModel;
  if (orFree && orFree.length) return orFree[0];
  orFree = OR_PREFERRED.slice();
  try {
    const cached = JSON.parse(localStorage.getItem('weiqi-coach-orfree') || 'null');
    if (cached && Date.now() - cached.at < 86400000 && cached.list.length) { orFree = cached.list; return orFree[0]; }
  } catch (e) { /* 忽略 */ }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const d = await r.json();
    const free = d.data.map(m => m.id).filter(id => id.endsWith(':free'));
    const rank = id => ['nemotron-3-ultra', 'nemotron-3-super', 'qwen', 'deepseek', 'glm', 'kimi', 'gemma', 'llama', 'mistral'].findIndex(k => id.includes(k));
    orFree = free.filter(id => !/safety|guard|embed/.test(id)).sort((x, y) => ((rank(x) + 99) % 99) - ((rank(y) + 99) % 99));
  } catch (e) {
    orFree = OR_PREFERRED.slice();
  }
  try { localStorage.setItem('weiqi-coach-orfree', JSON.stringify({ at: Date.now(), list: orFree })); } catch (e) { /* 忽略 */ }
  return orFree[0];
}

/** 调用 OpenAI 兼容的接口（OpenRouter / DeepSeek）。给了 onDelta 就边生成边回调，答案一段段出来。 */
async function openAICompatible(url, key, model, messages, extraHeaders, onDelta, extraBody) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(extraHeaders || {}) },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 3000, stream: true, ...(extraBody || {}) }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error((d.error && (d.error.message || d.error)) || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', content = '', reasoning = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || String(j.error));
        const delta = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
        if (!delta) continue;
        if (delta.content) { content += delta.content; if (onDelta) onDelta(content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '')); }
        if (delta.reasoning) reasoning += delta.reasoning;
        else if (delta.reasoning_content) reasoning += delta.reasoning_content;
      }
    }
    const text = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || reasoning.trim();
    if (!text) throw new Error('模型没有返回内容');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const BACKENDS = [
  {
    id: 'local', name: '家里 Mac 的本地模型',
    ready: () => checkLocal(false),
    async chat(messages) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 120000);
      try {
        const r = await fetch(`${syncServer()}/api/llm/chat`, {
          method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }),
        });
        const d = await r.json();
        if (!r.ok || !d.text) throw new Error(d.error || `HTTP ${r.status}`);
        return { text: d.text, src: `家里 Mac 的本地模型（${d.model}）` };
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    id: 'openrouter', name: 'OpenRouter 免费模型',
    ready: async () => AI.useOR && !!AI.orKey && navigator.onLine,
    async chat(messages, onDelta) {
      const model = await pickFreeModel();
      const call = m => openAICompatible('https://openrouter.ai/api/v1/chat/completions', AI.orKey, m, messages,
        { 'X-Title': 'Yi Go Coach' }, onDelta, { reasoning: { effort: 'low' } });
      try {
        return { text: await call(model), src: `OpenRouter 免费模型（${model}）` };
      } catch (e) {
        // 免费模型经常限流：换下一个免费模型再试一次
        if (!AI.orModel && orFree && orFree.length > 1) {
          const next = orFree[1];
          orFree.push(orFree.shift());
          return { text: await call(next), src: `OpenRouter 免费模型（${next}）` };
        }
        throw e;
      }
    },
  },
  {
    id: 'deepseek', name: 'DeepSeek',
    ready: async () => AI.useDS && !!AI.dsKey && navigator.onLine,
    async chat(messages, onDelta) {
      const text = await openAICompatible('https://api.deepseek.com/chat/completions', AI.dsKey, 'deepseek-chat', messages, null, onDelta);
      return { text, src: 'DeepSeek（deepseek-chat）' };
    },
  },
];

function orderedBackends() {
  const order = (AI.order || 'openrouter,local,deepseek').split(',');
  return BACKENDS.slice().sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
}

async function anyLLM() {
  for (const bk of orderedBackends()) if (await bk.ready()) return true;
  return false;
}

async function llmAnswer(question, onDelta) {
  const ctx = assistantContext();
  const history = [];
  for (const m of Q.log.slice(-5, -1)) {
    if (m.pending || !m.llm) continue;
    history.push({ role: 'user', content: m.q }, { role: 'assistant', content: m.llm });
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `【局面事实】\n${buildFacts(ctx)}\n\n【学生的问题】${question}` },
  ];
  const errors = [];
  for (const bk of orderedBackends()) {
    if (!(await bk.ready())) continue;
    try {
      const r = await bk.chat(messages, onDelta);
      return { ...r, ctx };
    } catch (e) {
      errors.push(`${bk.name}：${e.message || e}`);
    }
  }
  if (errors.length) throw new Error(errors.join('；'));
  return null;
}

function mdLite(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');
}

async function askLLM(q) {
  const who = (await firstReadyName()) || '大模型';
  askShow(q, `<p>正在思考…（${esc(who)}，推理模型可能要等十几秒）</p>`, '', true);
  let pending = 0;
  const onDelta = text => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => askShow(q, `<p>${mdLite(text)}</p>`, `${who} 正在回答…`, true));
  };
  try {
    const r = await llmAnswer(q, onDelta);
    cancelAnimationFrame(pending);
    if (!r) return false;
    const pts = coordsIn(r.text, r.ctx.b);
    Q.mark = pts.length ? pts : Q.mark;
    Q.area = null;
    drawBoard();
    askShow(q, `<p>${mdLite(r.text)}</p>`, `回答来自：${r.src}${pts.length ? ' · 提到的位置已在棋盘上标出' : ''}`);
    const last = Q.log[Q.log.length - 1];
    if (last) last.llm = r.text;
    return true;
  } catch (e) {
    askShow(q, `<p>大模型暂时没有回答成功：${esc(e.message || e)}</p><p class="note">可以点“AI 设置”检查；离线能回答的问题（气、地盘、断点、能吃的棋……）不受影响。</p>`);
    return true;
  }
}

async function firstReadyName() {
  for (const bk of orderedBackends()) if (await bk.ready()) return bk.name;
  return '';
}

// ---------------- 问题分派 ----------------

function faqAnswer(t) {
  const faq = window.FAQ || [];
  const lower = t.toLowerCase();
  const hit = k => {
    k = k.toLowerCase();
    if (!lower.includes(k)) return false;
    if (k.length > 1) return true;
    const core = lower.replace(/[？?。！!，,\s]|什么是|是什么|什么叫|怎么|吗|呢|的|请问/g, '');
    return core === k || core.length <= 2;
  };
  const scored = faq.map(f => ({ f, s: f.keys.reduce((n, k) => n + (hit(k) ? k.length * k.length : 0), 0) }))
    .filter(x => x.s > 0).sort((x, y) => y.s - x.s);
  return scored.length ? scored[0] : null;
}

/* 覆盖 app.js 里的 askText：先离线精确回答，其次知识库，再交给大模型。 */
// eslint-disable-next-line no-func-assign
askText = async function (text) {
  const t = text.trim();
  if (!t) return;
  $('askInput').value = '';
  const has = (...ws) => ws.some(w => t.includes(w));
  if (has('谁领先', '形势', '谁赢', '胜率多少', '优势')) return ask('lead', t);
  if (has('下哪', '怎么下', '下一手', '推荐', '走哪')) return ask('best', t);
  if (has('活不活', '死了吗', '能活', '活吗')) return ask('group', t);
  if (has('这里下', '下这里', '下在这')) return ask('point', t);
  if (S.mode !== 'practice' || true) {
    const ctx = assistantContext();
    for (const it of INTENTS) {
      if (!it.test(t)) continue;
      if (it.needsA && ctx.getA) {
        // 需要当前局面的引擎分析：没算完就等它算完，不让用户再问一次
        const seq = ++Q.seq;
        askShow(t, '<p>正在分析这个局面，马上就好…</p>', '', true);
        const a = await ctx.getA();
        if (seq !== Q.seq) return;
        if (a) ctx.a = a;
      }
      const r = it.run(ctx, t);
      if (!r) continue;
      drawBoard();
      const more = (await anyLLM()) ? `<p><button class="small" data-more="${esc(t)}">让 AI 老师再详细解释</button></p>` : '';
      askShow(t, r.html + more, '回答来自：本机围棋引擎（精确计算）');
      return;
    }
  }
  const f = faqAnswer(t);
  const llmOk = await anyLLM();
  if (f && (f.s >= 4 || !llmOk)) {
    askShow(t, `<p><b>${esc(f.f.q)}</b></p><p>${esc(f.f.a)}</p>${llmOk ? `<p><button class="small" data-more="${esc(t)}">让 AI 老师再详细解释</button></p>` : ''}`, '回答来自：内置围棋知识库');
    return;
  }
  if (llmOk) { await askLLM(t); return; }
  askShow(t, `<p>这个问题需要大模型来回答，但现在没有可用的大模型：不在家里的网络（家里 Mac 的本地模型），也没有设置 OpenRouter 或 DeepSeek 的密钥。</p>
    <p>离线可以问：这块棋有几口气 / 哪些是我的地盘 / 刚才得到的目在哪 / 哪里是断点 / 我能吃掉哪块棋 / 哪块棋有危险 / 眼在哪，以及围棋知识（例如“什么是打劫”）。</p>
    <p><button class="small" data-aiset="1">打开 AI 设置</button></p>`);
};

$('askAnswer').addEventListener('click', e => {
  const more = e.target.closest('[data-more]');
  if (more) { askLLM(more.dataset.more + '（请结合局面详细解释）'); return; }
  if (e.target.closest('[data-aiset]')) openAISettings();
});

// ---------------- AI 设置 ----------------

async function openAISettings() {
  const d = $('dlgAI');
  $('aiUseLocal').checked = AI.useLocal;
  $('aiUseOR').checked = AI.useOR;
  $('aiUseDS').checked = AI.useDS;
  $('aiORKey').value = AI.orKey;
  $('aiDSKey').value = AI.dsKey;
  $('aiOrder').value = AI.order || 'openrouter,local,deepseek';
  $('aiLocalState').textContent = '检测中…';
  d.showModal();
  const ok = await checkLocal(true);
  $('aiLocalState').textContent = ok ? `可用：${localHealth.model}（在家时自动优先使用，免费）` : `现在不可用：${localHealth.reason || ''}`;
  const sel = $('aiORModel');
  const opts = list => '<option value="">自动：Nemotron 3 Ultra 免费，忙时换其它免费模型（推荐）</option>' + list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  sel.innerHTML = opts(OR_PREFERRED.concat(AI.orModel && !OR_PREFERRED.includes(AI.orModel) ? [AI.orModel] : []));
  sel.value = AI.orModel;
  try {
    orFree = null;
    localStorage.removeItem('weiqi-coach-orfree');
    await pickFreeModel();
    sel.innerHTML = opts(orFree || OR_PREFERRED);
    sel.value = AI.orModel;
  } catch (e) { /* 离线时拿不到模型列表 */ }
}

function readAISettings() {
  AI.useLocal = $('aiUseLocal').checked;
  AI.useOR = $('aiUseOR').checked;
  AI.useDS = $('aiUseDS').checked;
  AI.orKey = $('aiORKey').value.trim();
  AI.dsKey = $('aiDSKey').value.trim();
  AI.orModel = $('aiORModel').value;
  AI.order = $('aiOrder').value;
  saveAI();
  localHealth.at = 0;
}

$('btnAISettings').addEventListener('click', openAISettings);
$('btnAISave').addEventListener('click', () => { readAISettings(); $('dlgAI').close(); toast('AI 设置已保存'); });
$('btnAITest').addEventListener('click', async () => {
  readAISettings();
  const out = $('aiTestOut');
  out.textContent = '正在测试…';
  const lines = [];
  for (const bk of orderedBackends()) {
    if (!(await bk.ready())) { lines.push(`${bk.name}：未启用或不可用`); continue; }
    try {
      const t0 = Date.now();
      const r = await bk.chat([{ role: 'system', content: '用一句简体中文回答，不超过 30 个字。' }, { role: 'user', content: '围棋里的“气”是什么？' }]);
      lines.push(`${bk.name}：可用（${((Date.now() - t0) / 1000).toFixed(1)} 秒）。${r.src}：${r.text.slice(0, 60)}`);
    } catch (e) {
      lines.push(`${bk.name}：失败（${e.message || e}）`);
    }
  }
  out.textContent = lines.join('\n');
});
