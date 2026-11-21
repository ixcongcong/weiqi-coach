/* 语音播报：把每一手棋念出来，方便在真实棋盘上对着下棋 —— 手机放在旁边当“嘴”，眼睛不用盯着屏幕。
 * 只用浏览器自带的语音合成（安卓 Chrome、iOS Safari、电脑浏览器都支持），完全离线，不联网、不花钱。 */
(function () {
  'use strict';
  const KEY = 'weiqi-voice';
  const DEFAULTS = {
    on: false,        // 开关
    style: 'zh',      // zh：第 3 列、第 5 行；letters：和屏幕上一样的坐标 D4
    scope: 'all',     // all：双方都念；ai：只念 AI 的
    rate: 1,          // 语速
    turn: true,       // AI 下完提醒“轮到你了”
    wake: true,       // 开着语音时让屏幕常亮
    comment: 'full',  // off：不念讲解；full：点评、原因、更好的点都念；brief：总评 + 亏几目 + 更好的点
  };

  let s = load();
  const synth = (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null;
  const listeners = [];
  let voice = null, queue = [], busy = false, wakeLock = null, watchdog = 0;

  function load() {
    let v = {};
    try { v = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) || '{}') || {}; } catch (e) { v = {}; }
    const out = Object.assign({}, DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) if (v[k] !== undefined) out[k] = v[k];
    return out;
  }
  function store() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ } }
  function emit() { for (const f of listeners) { try { f(s); } catch (e) { /* 忽略 */ } } }

  // ---------------- 坐标 ----------------
  /** 棋盘点 → 人话。zh：从左数第几列、从下数第几行（真棋盘上最好数）；letters：和屏幕上一样，例如 D4。 */
  function coord(b, p) {
    if (s.style === 'letters') return b.name(p);
    return '第 ' + (b.x(p) + 1) + ' 列，第 ' + (b.n - b.y(p)) + ' 行';
  }

  // ---------------- 讲解（点评）念出来 ----------------
  /** 去掉只给屏幕看的提示（“点‘在棋盘上看’”之类）。 */
  function forSpeech(text) {
    return String(text || '')
      .replace(/（[^）]*在棋盘上看[^）]*）/g, '')
      .replace(/点[“"]在棋盘上看[”"]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[。！；]+$/, '');
  }

  /** 点评 → 播报稿。mode：brief 只要总评和更好的点；full 把原因都念出来。 */
  function commentText(cm, at, bestAt, mode) {
    if (!cm) return '';
    const full = mode === 'full';
    const out = [];
    const label = cm.q && cm.q.label ? '，' + cm.q.label : '';
    out.push('第 ' + ((cm.j | 0) + 1) + ' 手，' + (cm.who || '') + '下 ' + (at || cm.name || '') + label);
    const seen = new Set();
    const push = text => {
      const clean = forSpeech(text);
      const key = clean.replace(/[，。、；：\s]/g, '');
      if (!clean || seen.has(key)) return;
      seen.add(key);
      out.push(clean);
    };
    const reasons = (cm.reasons || []).slice();
    if (cm.simple) {
      reasons.forEach(push);
      return out.join('。') + '。';
    }
    if (cm.pts !== null && cm.pts !== undefined && cm.pts >= 1) push('这手棋让形势亏了约 ' + Math.round(cm.pts * 2) / 2 + ' 目');
    if (full) {
      reasons.forEach(push);
    } else if (!out.length || out.length === 1) {
      push(reasons[0]);
    }
    if (cm.best && (bestAt || cm.best.name)) {
      const better = '更好的点是 ' + (bestAt || cm.best.name);
      push(better);
      if (full && Array.isArray(cm.best.reasons)) cm.best.reasons.forEach(push);
    }
    return out.join('。') + '。';
  }

  // ---------------- 语音合成 ----------------
  /** 挑一个中文声音：优先 zh-CN，其次 zh-Hans，再其次任何 zh；都没装就用系统默认。 */
  function pickVoice() {
    if (!synth || !synth.getVoices) return;
    const list = synth.getVoices() || [];
    if (!list.length) return;
    const zh = list.filter(v => /^zh/i.test(v.lang || ''));
    const score = v => (/^zh[-_]CN/i.test(v.lang || '') ? 4 : /^zh[-_]Hans/i.test(v.lang || '') ? 3 : /^zh/i.test(v.lang || '') ? 2 : 0) + (v.localService ? 1 : 0);
    voice = (zh.length ? zh : list).slice().sort((a, b) => score(b) - score(a))[0] || null;
  }
  if (synth) {
    pickVoice();
    if (synth.addEventListener) synth.addEventListener('voiceschanged', pickVoice);
    else synth.onvoiceschanged = pickVoice;
  }

  /** 从队列里念下一条；一条念完再念下一条，避免声音叠在一起。 */
  function pump() {
    if (busy || !queue.length || !synth) return;
    busy = true;
    clearTimeout(watchdog);
    const job = queue.shift();
    const u = new SpeechSynthesisUtterance(job.text);
    u.lang = 'zh-CN';
    if (voice) u.voice = voice;
    u.rate = Math.max(0.6, Math.min(1.6, +s.rate || 1));
    u.pitch = 1;
    u.volume = 1;
    const done = () => { if (!busy) return; busy = false; clearTimeout(watchdog); pump(); };
    u.onend = done;
    u.onerror = done;
    // 有的浏览器被打断时不触发 onend，留个看门狗，别让队列卡死
    watchdog = setTimeout(done, 12000);
    try { synth.speak(u); } catch (e) { done(); }
  }

  /** 直接念（不看开关，内部用）。interrupt !== false 时打断正在念的内容。 */
  function speakNow(text, interrupt) {
    if (!synth || !text) return false;
    if (interrupt !== false) {
      queue = [];
      try { synth.cancel(); } catch (e) { /* 忽略 */ }
      busy = false;
    }
    queue.push({ text: String(text) });
    pump();
    return true;
  }

  /** 对外：开关关着就什么都不做。 */
  function say(text, opt) {
    if (!s.on) return false;
    return speakNow(text, !opt || opt.interrupt !== false);
  }

  // ---------------- 屏幕常亮（真棋盘上摆子时手机别锁屏） ----------------
  function applyWake() {
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    const want = !!s.on && !!s.wake && typeof document !== 'undefined' && document.visibilityState === 'visible';
    if (want && !wakeLock) {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLock = lock;
        lock.addEventListener('release', () => { wakeLock = null; });
      }).catch(() => { wakeLock = null; });
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      try { lock.release(); } catch (e) { /* 忽略 */ }
    }
  }

  const api = {
    get settings() { return s; },
    get on() { return !!s.on; },
    get available() { return !!synth; },
    coord,
    say,
    speakNow,
    /** 念一手棋：称呼 + 坐标 +（吃了几子）。 */
    move(who, board, p, caps, opt) {
      if (!s.on) return '';
      const text = who + '，' + coord(board, p) + (caps > 1 ? '，吃掉 ' + caps + ' 子' : caps === 1 ? '，吃掉 1 子' : '');
      say(text, opt);
      return text;
    },
    /** 把一条点评念出来：cm 是点评对象，at 是这手的念法，bestAt 是“更好的点”的念法。 */
    comment(cm, at, bestAt) {
      if (!s.on || s.comment === 'off' || !cm) return '';
      const text = commentText(cm, at, bestAt, s.comment);
      if (text) say(text, { interrupt: false });
      return text;
    },
    commentText,
    /** AI 下完提醒轮到你了（不打断上一句）。 */
    turn(text) { if (s.on) say(text || '轮到你了', { interrupt: false }); },
    /** 终局。 */
    result(text) { if (s.on) say(text || '对局结束'); },
    cancel() {
      queue = [];
      busy = false;
      try { if (synth) synth.cancel(); } catch (e) { /* 忽略 */ }
    },
    set(key, val) {
      if (!(key in DEFAULTS)) return;
      s[key] = val;
      if (key === 'on' && !s.on) api.cancel();
      store();
      emit();
      if (key === 'on' || key === 'wake') applyWake();
    },
    toggle(on) { api.set('on', on === undefined ? !s.on : !!on); },
    /** 试听一句，用当前的念法和语速。 */
    test() {
      const sample = { n: 9, x: () => 2, y: () => 4, name: () => 'C5' };
      speakNow('语音正常。黑棋，' + coord(sample, 0));
    },
  };

  // ---------------- 界面 ----------------
  function bindUI() {
    const $ = id => document.getElementById(id);
    const chk = $('chkVoice');
    if (!chk) return;
    const cfg = $('btnVoiceCfg'), dlg = $('dlgVoice');

    const sync = () => {
      chk.checked = !!s.on;
      if (cfg) cfg.hidden = !s.on;
    };
    listeners.push(sync);
    sync();
    applyWake();

    chk.addEventListener('change', () => {
      api.set('on', chk.checked);
      // 顺便“预热”一次：iOS / 安卓上，用户点过之后才允许出声
      if (s.on) speakNow('语音已开启', true);
    });

    if (!dlg) return;
    const st = $('voiceStyle'), sc = $('voiceScope'), rt = $('voiceRate'), rtText = $('voiceRateText');
    const tn = $('voiceTurn'), wk = $('voiceWake'), status = $('voiceStatus');
    const cmSel = $('voiceComment');

    if (cfg) cfg.addEventListener('click', () => {
      st.value = s.style;
      sc.value = s.scope;
      rt.value = String(s.rate);
      rtText.textContent = (+s.rate).toFixed(1) + ' 倍';
      tn.checked = !!s.turn;
      wk.checked = !!s.wake;
      if (cmSel) cmSel.value = s.comment;
      status.textContent = synth ? '' : '这个浏览器不支持语音合成，换用 Chrome 或 Safari 试试。';
      dlg.showModal();
    });
    st.addEventListener('change', () => { api.set('style', st.value); api.test(); });
    sc.addEventListener('change', () => api.set('scope', sc.value));
    rt.addEventListener('input', () => {
      rtText.textContent = (+rt.value).toFixed(1) + ' 倍';
      api.set('rate', +rt.value);
    });
    tn.addEventListener('change', () => api.set('turn', tn.checked));
    if (cmSel) cmSel.addEventListener('change', () => api.set('comment', cmSel.value));
    wk.addEventListener('change', () => api.set('wake', wk.checked));
    $('btnVoiceTest').addEventListener('click', () => api.test());

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') applyWake();
    });
  }

  if (typeof window !== 'undefined') window.Voice = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
    else bindUI();
  }
})();
