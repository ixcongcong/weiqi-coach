#!/usr/bin/env node
'use strict';

// Run the real page controller in a VM: only browser presentation, workers and
// clocks are replaced. Async responses deliberately arrive after cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const appSource = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const startup = appSource.indexOf('// ---------------- 启动 ----------------');
assert.ok(startup > 0, 'controller startup boundary must be present');

function element(id = '') {
  const listeners = new Map();
  const target = {
    id, listeners, children: [], dataset: {}, style: {}, hidden: false,
    disabled: false, checked: false, value: '', textContent: '', open: false,
    clientWidth: 393, clientHeight: 600,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ target: this, ...event });
    },
    appendChild(child) { this.children.push(child); return child; },
    showModal() { this.open = true; }, close() { this.open = false; },
    getContext() { return {}; },
    querySelector() { return this.form || (this.form = element(`${id}-form`)); },
    querySelectorAll() { return []; },
    setPointerCapture() {}, scrollIntoView() {}, remove() {},
  };
  Object.defineProperty(target, 'innerHTML', {
    get() { return this.html || ''; },
    set(html) { this.html = html; this.children = []; },
  });
  return new Proxy(target, {
    get(obj, key) {
      if (!(key in obj) && typeof key === 'string') obj[key] = element(`${id}-${key}`);
      return obj[key];
    },
  });
}

function harness(storage = new Map()) {
  const elements = new Map(), timers = new Map(), workers = [];
  let timerId = 0;
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  class MockWorker {
    constructor(url) { this.url = url; this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(msg) { this.messages.push(msg); }
    terminate() { this.terminated = true; }
  }
  const ctx = vm.createContext({
    console, Blob, Float32Array, Uint8Array, Int32Array, AbortController,
    navigator: { hardwareConcurrency: 2, userAgent: 'controller-test' },
    location: { protocol: 'http:', hostname: 'localhost' },
    innerWidth: 393, innerHeight: 852,
    URL: { createObjectURL() { return 'blob:controller-test'; }, revokeObjectURL() {} },
    Worker: MockWorker,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    document: {
      documentElement: { dataset: {} },
      getElementById: getElement,
      createElement: tag => element(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++timerId; }, clearInterval() {},
    addEventListener() {},
    fetch() { throw new Error('Unexpected network request in controller regression'); },
  });
  ctx.window = ctx;
  ctx.self = ctx;
  for (const name of ['engine.js', 'growth.js']) {
    vm.runInContext(fs.readFileSync(path.join(web, name), 'utf8'), ctx, { filename: name });
  }
  vm.runInContext(appSource.slice(0, startup), ctx, { filename: 'app.js' });
  vm.runInContext(`
    drawBoard = () => {};
    layout = () => {};
    globalThis.controller = {
      S, T, Q, GROW, pool, nn, home,
      load, loadRecords, save, recordGame, recordToGame, rebuild,
      endCurrentGame, newGame, undo, humanPass, playMove, canHumanMove,
      aiTurn, captureTurn, step, advance, startScoring, growthOnEnd,
      enterReview, exitReview, render, resign, checkCaptureWin,
      get records() { return RECORDS; },
      get board() { return S.board; },
    };
  `, ctx);
  const c = ctx.controller;
  c.loadRecords();
  c.load();
  c.S.prefs.coach = false;
  c.S.prefs.helper = false;
  c.S.prefs.engine = 'mcts';
  c.S.prefs.home = false;
  return {
    ...c, c, ctx, storage, elements, workers, timers, getElement,
    runTimers(ms) {
      const due = [...timers].filter(([, t]) => t.ms === ms);
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
    },
  };
}

function seed(h, count = 3, opts = {}) {
  const { S } = h.c;
  Object.assign(S.game, { rated: true, growthDone: false, unrated: '', ...opts });
  const b = new h.ctx.Go.Board(S.game.size);
  S.history = [];
  for (let i = 0; i < count; i++) {
    const move = b.pt(i % 9, Math.floor(i / 9));
    assert.equal(b.play(move), true, 'fixture moves must be legal');
    S.history.push(move);
  }
  h.c.rebuild();
  return S;
}

function analysis(h, move, overrides = {}) {
  return {
    cands: [{ move, visits: 500, wr: 0.5 }], own: new Float32Array(h.c.S.board.size),
    score: 0, wr: 0.5, playouts: 500, toPlay: h.c.S.board.toPlay, ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function data(value) { return JSON.parse(JSON.stringify(value)); }

function assertEnded(h, history) {
  assert.deepEqual(data(h.c.S.result), { text: '本局已结束（未计胜负）', winner: null, abandoned: true });
  assert.deepEqual(data(h.c.S.history), history);
  assert.equal(h.c.S.aiThinking, false);
  assert.equal(h.c.S.scoringBusy, false);
  assert.equal(h.c.S.scoring, null);
  assert.equal(h.c.canHumanMove(), false);
}

test('one click immediately ends a rated game, clears pending moves and archives without rating a loss', () => {
  const h = harness(), S = seed(h, 12);
  const history = data(S.history), growth = data(h.c.GROW.s), gen = S.gen;
  S.aiThinking = true;
  S.ghost = S.pendingTap = S.board.pt(8, 8);
  S.hint = { loading: true };
  S.view = 2;
  h.getElement('btnEnd').dispatch('click');
  assertEnded(h, history);
  assert.ok(S.gen > gen);
  assert.ok(h.workers[0].terminated, 'current search worker must be terminated');
  assert.equal(S.ghost, h.ctx.Go.NONE);
  assert.equal(S.pendingTap, h.ctx.Go.NONE);
  assert.equal(S.hint, null);
  assert.equal(S.view, null);
  assert.deepEqual(data(h.c.GROW.s), growth);
  assert.equal(h.c.records.length, 1);
  const rec = h.c.records[0];
  assert.equal(rec.won, null);
  assert.equal(rec.winner, 0);
  assert.equal(rec.abandoned, true);
  assert.equal(rec.moveCount, history.length);
  assert.equal(rec.result, S.result.text);
  assert.match(h.c.recordToGame(rec).title, /结束|未计胜负/);
  assert.doesNotMatch(h.c.recordToGame(rec).title, /· (?:输|赢|黑胜|白胜)$/);
});

test('repeat clicks and direct undo/pass/move calls cannot reopen an ended game or duplicate its record', () => {
  const h = harness(), S = seed(h);
  h.c.endCurrentGame();
  const history = data(S.history), recordId = h.c.records[0].id;
  h.c.endCurrentGame();
  h.c.undo();
  h.c.humanPass();
  assert.equal(h.c.playMove(S.board.pt(8, 8), true), false);
  assertEnded(h, history);
  assert.equal(h.c.records.length, 1);
  assert.equal(h.c.records[0].id, recordId);
  h.c.render();
  assert.equal(h.getElement('btnEnd').disabled, true);
  assert.equal(h.getElement('btnUndo').disabled, true);
  assert.equal(h.getElement('btnReview').disabled, false);
});

test('abandoning an empty game is terminal and does not create a win/loss or rating event', () => {
  const h = harness(), growth = data(h.c.GROW.s);
  h.c.endCurrentGame();
  assertEnded(h, []);
  assert.deepEqual(data(h.c.GROW.s), growth);
});

test('late AI search completion cannot place a stone after ending', async () => {
  const h = harness(), S = seed(h, 1), pending = deferred();
  S.prefs.level = 1;
  S.analyses[1] = analysis(h, S.board.pt(3, 3));
  h.c.pool.search = () => pending.promise;
  const work = h.c.aiTurn(S.gen, S.history.length);
  await flush();
  assert.equal(S.aiThinking, true);
  h.c.endCurrentGame();
  const history = data(S.history);
  pending.resolve(analysis(h, S.board.pt(3, 3)));
  await work;
  assertEnded(h, history);
  assert.equal(h.c.records.length, 1);
});

test('late AI from a stopped game cannot place a stone in a newly started game', async () => {
  const h = harness(), S = seed(h, 1), pending = deferred();
  S.prefs.level = 1;
  S.analyses[1] = analysis(h, S.board.pt(3, 3));
  h.c.pool.search = () => pending.promise;
  const work = h.c.aiTurn(S.gen, S.history.length);
  await flush();
  h.c.endCurrentGame();
  const rec = data(h.c.records[0]);
  h.c.pool.analyze = () => Promise.resolve(analysis(h, S.board.pt(3, 3)));
  h.c.newGame({ opp: 'human', rule: 'normal' });
  pending.resolve(analysis(h, S.board.pt(3, 3)));
  await work;
  await flush();
  assert.equal(S.result, null);
  assert.equal(S.history.length, 0);
  assert.equal(S.aiThinking, false);
  assert.equal(S.scoring, null);
  assert.deepEqual(data(h.c.records[0]), rec);
});

test('late position analysis cannot cache or restart AI after ending', async () => {
  const h = harness(), S = seed(h, 1), pending = deferred();
  h.c.pool.analyze = () => pending.promise;
  const work = h.c.step();
  await flush();
  h.c.endCurrentGame();
  const history = data(S.history);
  pending.resolve(analysis(h, S.board.pt(3, 3)));
  await work;
  assertEnded(h, history);
  assert.equal(S.analyses[1], undefined);
});

test('AI delayed resign result cannot replace the manual end result', async () => {
  const h = harness(), S = seed(h, 1);
  S.board.moveCount = 60;
  S.analyses[1] = analysis(h, S.board.pt(3, 3), { wr: 0.001 });
  const work = h.c.aiTurn(S.gen, S.history.length);
  await flush();
  assert.ok([...h.timers.values()].some(t => t.ms > 0 && t.ms <= 350), 'AI delay should be pending');
  h.c.endCurrentGame();
  const history = data(S.history);
  for (const ms of [...h.timers.values()].filter(t => t.ms > 0 && t.ms <= 350).map(t => t.ms)) h.runTimers(ms);
  await work;
  assertEnded(h, history);
  assert.equal(h.c.records[0].won, null);
});

test('pending ownership calculation cannot finish scoring after ending', async () => {
  const h = harness(), S = seed(h, 2), pending = deferred();
  h.c.pool.ownership = () => pending.promise;
  const work = h.c.startScoring();
  assert.equal(S.scoringBusy, true);
  h.c.endCurrentGame();
  const history = data(S.history), growth = data(h.c.GROW.s);
  pending.resolve({ own: new Float32Array(S.board.size), score: 0 });
  await work;
  assertEnded(h, history);
  assert.deepEqual(data(h.c.GROW.s), growth);
  assert.equal(h.c.records.length, 1);
});

test('delayed capture AI is cancelled when the current game ends', async () => {
  const h = harness(), S = seed(h, 1, { rule: 'capture' });
  const work = h.c.captureTurn(S.gen);
  h.c.endCurrentGame();
  const history = data(S.history);
  h.runTimers(450);
  await work;
  assertEnded(h, history);
});

test('ending persists across controller reload and retains the archived record', () => {
  const h = harness(), S = seed(h);
  h.c.endCurrentGame();
  const history = data(S.history), rec = data(h.c.records[0]);
  const reloaded = harness(h.storage);
  assertEnded(reloaded, history);
  assert.equal(reloaded.c.records.length, 1);
  assert.deepEqual(data(reloaded.c.records[0]), rec);
  assert.equal(reloaded.c.S.game.recId, rec.id, 'saved game and archived record must retain one identity');
  reloaded.c.recordGame();
  assert.equal(reloaded.c.records.length, 1, 'resaving after reload must update the same record');
  assert.equal(reloaded.c.GROW.s.games, h.c.GROW.s.games);
});

test('a delayed confirmation from an earlier resign dialog cannot overwrite the ended game', () => {
  const h = harness(), S = seed(h);
  h.c.resign();
  const confirm = h.getElement('msgMenu').children.find(b => b.textContent === '认输');
  assert.ok(confirm);
  confirm.dispatch('click');
  h.c.endCurrentGame();
  const history = data(S.history), growth = data(h.c.GROW.s);
  h.runTimers(0);
  assertEnded(h, history);
  assert.deepEqual(data(h.c.GROW.s), growth);
  assert.equal(h.c.records.length, 1);
  assert.equal(h.c.records[0].won, null);
});

test('review remains available, and new game starts clean without rating the stopped game', async () => {
  const h = harness(), S = seed(h, 12), growth = data(h.c.GROW.s);
  h.c.endCurrentGame();
  const rec = data(h.c.records[0]);
  S.analyses[0] = analysis(h, S.board.pt(8, 8));
  h.c.enterReview(0);
  assert.equal(S.view, 0);
  assert.equal(S.result.abandoned, true);
  h.c.exitReview();
  h.c.newGame({ opp: 'human', rule: 'normal' });
  await flush();
  assert.equal(S.result, null);
  assert.equal(S.history.length, 0);
  assert.equal(S.game.recId, null);
  assert.equal(S.scoring, null);
  assert.equal(h.c.canHumanMove(), true);
  assert.deepEqual(data(h.c.GROW.s), growth);
  assert.deepEqual(data(h.c.records[0]), rec);
});

test('human-versus-human game can end without awarding either side a win', () => {
  const h = harness(), S = seed(h, 2, { opp: 'human' });
  h.c.endCurrentGame();
  assertEnded(h, data(S.history));
  assert.equal(h.c.records[0].won, null);
  assert.equal(h.c.records[0].winner, 0);
  assert.equal(h.c.records[0].opp, 'human');
});

test('13- and 19-line boards preserve their full replay and correct no-result archive', () => {
  for (const size of [13, 19]) {
    const h = harness(), S = seed(h, 3, { size });
    const history = data(S.history);
    h.c.endCurrentGame();
    assertEnded(h, history);
    const record = h.c.records[0];
    assert.equal(record.size, size);
    assert.equal(record.moveCount, history.length);
    assert.equal(record.won, null);
    assert.equal(record.winner, 0);
    assert.equal(record.abandoned, true);
    assert.equal(h.c.recordToGame(record).moves.length, history.length * 2);
  }
});
