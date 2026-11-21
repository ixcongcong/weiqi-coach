#!/usr/bin/env node
'use strict';

// 语音播报：在假的浏览器环境里跑 web/voice.js，检查念出来的内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const require = createRequire(import.meta.url);
const Go = require(path.join(web, 'engine.js'));
const source = fs.readFileSync(path.join(web, 'voice.js'), 'utf8');

/** 在假的浏览器里加载 voice.js；返回念过的句子、localStorage 里的东西。 */
function loadVoice(store = new Map()) {
  const spoken = [];
  const synth = {
    getVoices: () => [{ lang: 'en-US', name: 'Sam' }, { lang: 'zh-CN', name: 'Ting-Ting', localService: true }],
    speak(utterance) {
      spoken.push(utterance.text);
      if (utterance.onend) setTimeout(utterance.onend, 0);
    },
    cancel() {},
    addEventListener() {},
  };
  const context = {
    window: { speechSynthesis: synth },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    document: { getElementById: () => null, addEventListener() {}, readyState: 'complete', visibilityState: 'visible' },
    navigator: {},
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance(text) { this.text = text; },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context);
  return { Voice: context.window.Voice, spoken, store };
}

const board = new Go.Board(9);
const C5 = board.pt(2, 4);        // 从左数第 3 列、从下数第 5 行
const TOP_LEFT = board.pt(8, 0);  // 左上角

test('默认设置：中文行列、双方都念、默认关着', () => {
  const { Voice } = loadVoice();
  assert.equal(Voice.settings.style, 'zh');
  assert.equal(Voice.settings.scope, 'all');
  assert.equal(Voice.on, false);
  assert.equal(Voice.available, true);
});

test('关着的时候一句都不念', () => {
  const { Voice, spoken } = loadVoice();
  assert.equal(Voice.move('黑棋', board, C5, 0), '');
  assert.deepEqual(spoken, []);
});

test('念法：第 N 列第 M 行，左上角也数得对', () => {
  const { Voice, spoken } = loadVoice();
  Voice.set('on', true);
  assert.equal(Voice.move('黑棋', board, C5, 0), '黑棋，第 3 列，第 5 行');
  assert.deepEqual(spoken, ['黑棋，第 3 列，第 5 行']);
  assert.equal(Voice.coord(board, TOP_LEFT), '第 9 列，第 9 行');
});

test('念法：和屏幕一样的棋盘坐标，跳过 I', () => {
  const { Voice } = loadVoice();
  Voice.set('style', 'letters');
  assert.equal(Voice.coord(board, C5), 'C5');
  assert.equal(Voice.coord(board, TOP_LEFT), 'J9');
});

test('吃子会多念一句', () => {
  const { Voice } = loadVoice();
  Voice.set('on', true);
  assert.equal(Voice.move('白棋', board, C5, 1), '白棋，第 3 列，第 5 行，吃掉 1 子');
  assert.equal(Voice.move('白棋', board, C5, 3), '白棋，第 3 列，第 5 行，吃掉 3 子');
});

test('轮到你了、终局、试听都会念', () => {
  const { Voice, spoken } = loadVoice();
  Voice.set('on', true);
  Voice.turn();
  Voice.result('对局结束，你赢了');
  Voice.test();
  assert.equal(spoken[0], '轮到你了');
  assert.equal(spoken[1], '对局结束，你赢了');
  assert.match(spoken[2], /语音正常/);
});

test('设置存在本机，下次打开还在', () => {
  const { Voice, store } = loadVoice();
  Voice.set('on', true);
  Voice.set('rate', 1.3);
  const again = loadVoice(store);
  assert.equal(again.Voice.on, true);
  assert.equal(again.Voice.settings.rate, 1.3);
});

test('关掉时立刻停声，之后不再念', () => {
  const { Voice, spoken } = loadVoice();
  Voice.set('on', true);
  Voice.say('黑棋，第 3 列，第 5 行');
  Voice.set('on', false);
  assert.equal(Voice.say('白棋，第 4 列，第 4 行'), false);
  assert.equal(spoken.length, 1);
});

// 截图里那种点评：总评 + 几条原因 + 更好的点
function sampleComment() {
  return {
    j: 0, who: '你', name: 'D7', q: { label: '缓手' }, pts: 5, wrBefore: 0.36, wrAfter: 0.27,
    reasons: [
      '占角（小目）：金角银边草肚皮——角上用最少的棋子就能围到地，布局要先占空角。',
      '这手棋让形势亏了约 5 目。',
      '这手之后更可能变成你地盘的点：B9、C9、D9、D7（共 4 个，点“在棋盘上看”）。',
      '这手之后，你落后约 1.5 目（按数子、含贴目）。',
    ],
    best: { name: 'E6', wr: 0.36, reasons: ['占据中央：9 路棋盘很小，中央的棋子能同时照顾四个角。'] },
  };
}

test('讲解「全部」：点评、原因、更好的点都念出来', () => {
  const { Voice } = loadVoice();
  Voice.set('on', true);
  const text = Voice.commentText(sampleComment(), '第 4 列，第 3 行', '第 5 列，第 4 行', 'full');
  assert.match(text, /^第 1 手，你下 第 4 列，第 3 行，缓手。/, '先说第几手、谁下的、下在哪');
  assert.match(text, /金角银边草肚皮/, '念出原因');
  assert.match(text, /B9、C9、D9、D7/, '念出可能成地盘的点');
  assert.doesNotMatch(text, /在棋盘上看/, '去掉只给屏幕看的提示');
  assert.match(text, /更好的点是 第 5 列，第 4 行/, '念出更好的点');
  assert.match(text, /占据中央/, '念出更好的点的原因');
  assert.equal((text.match(/亏了约 5 目/g) || []).length, 1, '同一句亏损不重复念');
});

test('讲解「简短」：只念总评、亏几目和更好的点', () => {
  const { Voice } = loadVoice();
  Voice.set('on', true);
  const text = Voice.commentText(sampleComment(), '第 4 列，第 3 行', '第 5 列，第 4 行', 'brief');
  assert.match(text, /第 1 手，你下 第 4 列，第 3 行，缓手/);
  assert.match(text, /亏了约 5 目/);
  assert.match(text, /更好的点是 第 5 列，第 4 行/);
  assert.doesNotMatch(text, /金角银边草肚皮/, '简短模式不念长原因');
  assert.ok(text.length < 60, '简短模式要短');
});

test('讲解会排队念出来；关掉讲解就不念', () => {
  const { Voice, spoken } = loadVoice();
  Voice.set('on', true);
  Voice.comment(sampleComment(), '第 4 列，第 3 行', '第 5 列，第 4 行');
  assert.match(spoken[0] || '', /第 1 手，你下 第 4 列，第 3 行，缓手/, '接在落子后面念');
  Voice.set('comment', 'off');
  const before = spoken.length;
  assert.equal(Voice.comment(sampleComment(), 'D7', ''), '');
  assert.equal(spoken.length, before, '关掉之后不再念');
});
