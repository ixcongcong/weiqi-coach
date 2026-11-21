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
