/* 成长系统（围棋、中国象棋、国际象棋共用）：
 *  - 等级分：和 AI 的计分对局按等级分公式加减分（赢强的加得多，输给弱的扣得多），前 10 盘是定级赛，变化大；
 *  - 段级：25 级 → 1 级 → 1 段 → 9 段，每 100 分一级；升级即时，降级有 50 分保护；级位阶段三连胜直接升一级；
 *  - 练习积分：做题按题目难度加减分；
 *  - 弱点统计、错题本（间隔 1/3/7/15/30 天复习）、每日训练和连续打卡。
 * 只依赖 localStorage，全部在本机。 */
(function (root) {
  'use strict';
  const BASE = 600, STEP = 100, MAX_I = 33;
  const DAY = 86400000;
  const BOX_DAYS = [1, 3, 7, 15, 30];

  function rankOf(r) {
    const i = Math.max(0, Math.min(MAX_I, Math.floor((r - BASE) / STEP)));
    return { i, name: rankName(i), low: BASE + i * STEP, high: BASE + (i + 1) * STEP };
  }
  function rankName(i) { return i < 25 ? `${25 - i} 级` : `${i - 24} 段`; }
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const yesterday = () => { const d = new Date(Date.now() - DAY); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

  function userId() {
    try { const u = JSON.parse(localStorage.getItem('weiqi-coach-users') || 'null'); return (u && u.current) || 'default'; } catch (e) { return 'default'; }
  }

  class Growth {
    constructor(game) {
      this.game = game;
      this.key = `growth:${game}:${userId()}`;
      this.s = {
        rating: 650, stable: 0, games: 0, wins: 0, losses: 0, streak: 0, best: 650,
        history: [], pz: { rating: 700, n: 0, ok: 0 },
        weak: [], review: [], daily: { day: '', done: { review: 0, puzzles: 0, game: 0 } }, days: 0, lastDay: '',
        log: [],
      };
      try {
        const d = JSON.parse(localStorage.getItem(this.key) || 'null');
        if (d) Object.assign(this.s, d);
      } catch (e) { /* 忽略 */ }
      this.s.stable = Math.max(this.s.stable, 0);
      this.rollDay();
    }

    save() { try { localStorage.setItem(this.key, JSON.stringify(this.s)); } catch (e) { /* 忽略 */ } }

    get rank() { return { ...rankOf(this.s.rating), i: this.s.stable, name: rankName(this.s.stable), low: BASE + this.s.stable * STEP, high: BASE + (this.s.stable + 1) * STEP }; }
    get provisional() { return this.s.games < 10; }

    k() { return this.s.games < 10 ? 60 : this.s.games < 30 ? 40 : 24; }

    /** 记录一盘计分对局。result：1 赢，0 输，0.5 和。返回变化说明。 */
    recordGame({ opp, oppName, result, note }) {
      const s = this.s, before = s.rating, rank0 = s.stable;
      const E = 1 / (1 + Math.pow(10, (opp - before) / 400));
      let delta = Math.round(this.k() * (result - E));
      if (result === 1 && delta < 1) delta = 1;
      if (result === 0 && delta > -1) delta = -1;
      s.rating = Math.max(100, before + delta);
      s.games++;
      if (result === 1) { s.wins++; s.streak = s.streak > 0 ? s.streak + 1 : 1; } else if (result === 0) { s.losses++; s.streak = s.streak < 0 ? s.streak - 1 : -1; } else s.streak = 0;
      const msgs = [];
      // 级位阶段：三连胜（对手不比自己弱）直接升一级
      if (result === 1 && s.streak >= 3 && s.stable < 24 && opp >= before - 60 && rankOf(s.rating).i <= s.stable) {
        s.rating = Math.max(s.rating, BASE + (s.stable + 1) * STEP);
        msgs.push('三连胜，直接升一级！');
        s.streak = 0;
      }
      const now = rankOf(s.rating).i;
      let promoted = false, demoted = false;
      if (now > s.stable) { s.stable = now; promoted = true; } else if (s.rating < BASE + s.stable * STEP - 50) { s.stable = Math.max(0, now); demoted = true; }
      if (!promoted && !demoted && s.rating < BASE + s.stable * STEP) msgs.push(`已进入降级保护：再低 ${Math.max(1, BASE + s.stable * STEP - 50 - s.rating)} 分会降到 ${rankName(Math.max(0, s.stable - 1))}。`);
      s.best = Math.max(s.best, s.rating);
      s.history.push({ t: Date.now(), r: s.rating });
      if (s.history.length > 300) s.history.shift();
      s.log.unshift({ t: Date.now(), oppName, opp, result, delta: s.rating - before, note: note || '' });
      s.log = s.log.slice(0, 60);
      this.s.daily.done.game++;
      this.checkDay();
      this.save();
      return {
        before, after: s.rating, delta: s.rating - before, promoted, demoted,
        rankBefore: rankName(rank0), rankAfter: rankName(s.stable), msgs, provisional: s.games <= 10,
      };
    }

    /** 做题：diff 为题目难度分；fresh 为今天第一次做这题（计入每日训练） */
    recordPuzzle(diff, ok, fresh) {
      const z = this.s.pz, E = 1 / (1 + Math.pow(10, (diff - z.rating) / 400)), K = z.n < 20 ? 40 : 20;
      const delta = Math.round(K * ((ok ? 1 : 0) - E));
      z.rating = Math.max(100, z.rating + delta);
      z.n++;
      if (ok) z.ok++;
      if (ok && fresh) this.s.daily.done.puzzles++;
      this.checkDay();
      this.save();
      return delta;
    }

    // ---------- 弱点 ----------
    addWeak(cats) {
      for (const c of cats) this.s.weak.push({ c, t: Date.now() });
      this.s.weak = this.s.weak.slice(-300);
      this.save();
    }
    topWeak(n) {
      const cnt = {};
      // 最近的错误权重大一些
      const now = Date.now();
      for (const w of this.s.weak) cnt[w.c] = (cnt[w.c] || 0) + (now - w.t < 14 * DAY ? 1 : 0.4);
      return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, n).map(([c, v]) => ({ c, v: Math.round(v * 10) / 10 }));
    }

    // ---------- 错题本 ----------
    addReview(item) {
      const r = this.s.review;
      const old = r.find(x => x.id === item.id);
      if (old) { old.box = 0; old.due = Date.now() + (item.now ? 0 : DAY); } else r.push({ ...item, box: 0, due: Date.now() + (item.now ? 0 : DAY), added: Date.now() });
      if (r.length > 200) r.splice(0, r.length - 200);
      this.save();
    }
    dueReviews() { const now = Date.now(); return this.s.review.filter(x => x.due <= now).sort((a, b) => a.due - b.due); }
    reviewResult(id, ok) {
      const r = this.s.review, x = r.find(y => y.id === id);
      if (!x) return null;
      if (ok) {
        x.box++;
        if (x.box >= BOX_DAYS.length) r.splice(r.indexOf(x), 1); else x.due = Date.now() + BOX_DAYS[x.box] * DAY;
      } else { x.box = 0; x.due = Date.now() + DAY; }
      this.s.daily.done.review++;
      this.checkDay();
      this.save();
      return ok ? (x.box >= BOX_DAYS.length ? '这道题已经掌握，移出错题本。' : `答对了，${BOX_DAYS[Math.min(x.box, BOX_DAYS.length - 1)]} 天后再复习一次。`) : '还没掌握，明天再练一次。';
    }

    // ---------- 每日训练 ----------
    rollDay() {
      const d = today();
      if (this.s.daily.day !== d) this.s.daily = { day: d, done: { review: 0, puzzles: 0, game: 0 }, counted: false };
    }
    plan() {
      this.rollDay();
      const due = this.dueReviews().length, done = this.s.daily.done;
      return { review: Math.min(5, due + done.review), puzzles: 3, game: 1, done };
    }
    checkDay() {
      this.rollDay();
      const p = this.plan(), d = this.s.daily;
      const complete = d.done.review >= p.review && d.done.puzzles >= p.puzzles && d.done.game >= p.game;
      if (complete && !d.counted) {
        d.counted = true;
        this.s.days = this.s.lastDay === yesterday() ? this.s.days + 1 : 1;
        this.s.lastDay = d.day;
        this.justCompleted = true;
      }
    }

    // ---------- 显示 ----------
    chart() {
      const h = this.s.history.slice(-60);
      if (h.length < 2) return '<p class="note">下几盘计分对局后，这里会显示你的等级分曲线。</p>';
      const rs = h.map(x => x.r), lo = Math.min(...rs) - 20, hi = Math.max(...rs) + 20, W = 300, H = 90;
      const pts = rs.map((r, i) => `${(i / (rs.length - 1) * W).toFixed(1)},${(H - (r - lo) / (hi - lo) * H).toFixed(1)}`).join(' ');
      let grid = '';
      for (let v = Math.ceil(lo / STEP) * STEP; v <= hi; v += STEP) {
        const y = (H - (v - lo) / (hi - lo) * H).toFixed(1);
        grid += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" class="g-grid"/><text x="2" y="${y}" class="g-lbl">${rankOf(v).name}</text>`;
      }
      return `<svg viewBox="0 0 ${W} ${H}" class="g-chart" preserveAspectRatio="none">${grid}<polyline points="${pts}" class="g-line"/></svg>`;
    }

    rankCard() {
      const s = this.s, rk = this.rank, into = Math.max(0, Math.min(1, (s.rating - rk.low) / STEP));
      const streak = s.streak >= 2 ? `<span class="g-tag good">${s.streak} 连胜</span>` : s.streak <= -2 ? `<span class="g-tag bad">${-s.streak} 连败</span>` : '';
      return `<div class="g-rank"><div class="g-big">${rk.name}</div><div><b>等级分 ${s.rating}</b>${this.provisional ? `<span class="g-tag">定级中 ${s.games}/10</span>` : ''}${streak}
        <div class="g-bar"><div style="width:${Math.round(into * 100)}%"></div></div>
        <div class="note">距 ${rankName(Math.min(MAX_I, s.stable + 1))} 还差 ${Math.max(0, rk.high - s.rating)} 分 · 计分对局 ${s.games} 盘（${s.wins} 胜 ${s.losses} 负）· 最高 ${s.best}</div>
        <div class="note">练习积分 ${s.pz.rating}（做题 ${s.pz.n} 道，对 ${s.pz.ok} 道）${s.days ? ` · 连续训练 ${s.days} 天` : ''}</div></div></div>`;
    }

    planHtml() {
      const p = this.plan(), d = p.done;
      const row = (ok, text, btn, act) => `<li class="${ok ? 'done' : ''}">${ok ? '✓' : '○'} ${text}${!ok && btn ? ` <button class="small" data-g="${act}">${btn}</button>` : ''}</li>`;
      return `<ul class="g-plan">
        ${row(d.review >= p.review, `复习错题 ${Math.min(d.review, p.review)} / ${p.review}${p.review === 0 ? '（今天没有到期的错题）' : ''}`, '开始复习', 'review')}
        ${row(d.puzzles >= p.puzzles, `新题 ${Math.min(d.puzzles, p.puzzles)} / ${p.puzzles}`, '去做题', 'puzzle')}
        ${row(d.game >= p.game, `计分对局 ${Math.min(d.game, p.game)} / ${p.game}`, '开始对局', 'game')}
      </ul>`;
    }

    logHtml() {
      const l = this.s.log.slice(0, 8);
      if (!l.length) return '';
      return `<ul class="g-log">${l.map(x => `<li>${new Date(x.t).toLocaleDateString('zh-CN')} 对 ${x.oppName}：${x.result === 1 ? '胜' : x.result === 0 ? '负' : '和'} <b class="${x.delta >= 0 ? 'up' : 'down'}">${x.delta >= 0 ? '+' : ''}${x.delta}</b>${x.note ? `（${x.note}）` : ''}</li>`).join('')}</ul>`;
    }
  }

  const RULES_HTML = `<ul class="g-rules">
    <li><b>等级</b>：25 级 → 1 级 → 1 段 → 9 段，等级分每 100 分一级。新手从 25 级开始。</li>
    <li><b>计分对局</b>：和 AI 下、选“计分”的对局才加减分。AI 每档难度有固定的等级分；赢比你强的 AI 加分多，输给比你弱的 AI 扣分多。</li>
    <li><b>定级赛</b>：前 10 盘分数变化大（最多 ±60），帮你尽快找到自己的水平；之后变化变小。</li>
    <li><b>升级</b>：等级分到了就升；级位阶段对同级或更强的 AI 三连胜，直接升一级。</li>
    <li><b>降级保护</b>：跌破本级门槛后还有 50 分保护，再跌才降级。</li>
    <li><b>不计分</b>：用了悔棋、提示，或者开了“让棋”的对局，自动改为不计分；真人对战不计分。</li>
    <li><b>逃跑判负</b>：计分对局下了 10 手以上中途开新局，算输。</li>
    <li><b>练习积分</b>：做题单独计分，题目越难加分越多。做错的题和对局里的大失误会进入错题本，隔 1、3、7、15、30 天复习，连续答对 5 次就算掌握。</li>
  </ul>`;

  root.Growth = Growth;
  root.GrowthUtil = { rankOf, rankName, RULES_HTML };
})(typeof window !== 'undefined' ? window : globalThis);
