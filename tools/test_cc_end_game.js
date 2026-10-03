#!/usr/bin/env node
'use strict';

// Execute the production controllers and rules. Only browser presentation,
// workers and clocks are replaced, so canceled replies can arrive deliberately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const source = fs.readFileSync(path.join(web, 'cc/app.js'), 'utf8');
const startup = source.indexOf('// ---------------- 启动 ----------------');
assert.ok(startup > 0);

function element(id = '') {
  const listeners = new Map();
  const obj = {
    id, listeners, dataset: {}, style: {}, hidden: false, disabled: false,
    checked: false, value: '', textContent: '', innerHTML: '', open: false,
    returnValue: '', clientWidth: 393, clientHeight: 600,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map(fn => fn({ target: this, ...event })));
    },
    querySelector() { return this.form || (this.form = element(`${id}-form`)); },
    showModal() { this.open = true; },
    close(value = '') {
      this.returnValue = value;
      this.open = false;
      this.dispatch('close');
      if (typeof this.onclose === 'function') this.onclose();
    },
    getContext() { return {}; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
  };
  return new Proxy(obj, { get(target, key) {
    if (!(key in target) && typeof key === 'string') target[key] = element(`${id}-${key}`);
    return target[key];
  } });
}

function harness(game, storage = new Map()) {
  const elements = new Map(), workers = [], timers = new Map();
  let timerId = 0;
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  class Worker {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(msg) { this.messages.push(msg); }
    terminate() { this.terminated = true; }
  }
  const ctx = vm.createContext({
    console, Worker,
    navigator: {}, location: { protocol: 'http:', search: '' },
    innerWidth: 393, innerHeight: 852,
    document: {
      documentElement: { dataset: { game } },
      getElementById: get, addEventListener() {},
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++timerId; }, clearInterval() {},
    addEventListener() {},
  });
  ctx.window = ctx;
  for (const file of ['growth.js', 'cc/chess.js', 'cc/xiangqi.js']) {
    vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), ctx, { filename: file });
  }
  vm.runInContext(source.slice(0, startup), ctx, { filename: 'cc/app.js' });
  vm.runInContext(`
    draw = () => {};
    layout = () => {};
    globalThis.controller = {
      S, R, GROW, eng, canvas, geom, boardView, load, save, render,
      endCurrentGame, newGame, undo, advance, aiMove, getAnalysis,
      playUserMove, playPos, canHumanMove, finishGame, growthOnEnd,
      setMode, gameList, askPromo,
      get gen() { return gen; }, get aiBusy() { return aiBusy; },
      set aiBusy(value) { aiBusy = value; },
      get hint() { return hint; }, set hint(value) { hint = value; },
      get view() { return view; }, set view(value) { view = value; },
      get sel() { return sel; }, set sel(value) { sel = value; },
      get analyses() { return A; },
    };
  `, ctx);
  const c = ctx.controller;
  c.load();
  c.S.prefs.coach = false;
  c.S.prefs.threat = false;
  return { c, ctx, storage, workers, timers, get,
    runTimers(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms === ms) { timers.delete(id); t.fn(); }
      }
    },
  };
}

const data = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function seed(h, count = 12, opp = 'ai') {
  const { c } = h;
  Object.assign(c.S.play, { moves: [], human: 0, opp, rated: true, unrated: '', done: false, result: null });
  const p = c.R.fromFEN(c.S.play.fen);
  for (let i = 0; i < count; i++) {
    const m = c.R.legalMoves(p).find(m => {
      c.R.make(p, m);
      const ended = c.R.result(p);
      c.R.unmake(p);
      return !ended;
    });
    assert.notEqual(m, undefined, 'fixture must remain playable');
    c.S.play.moves.push(c.R.uci(m));
    c.R.make(p, m);
  }
  return data(c.S.play.moves);
}

function assertEnded(h, moves) {
  assert.deepEqual(data(h.c.S.play.result), { text: '本局已结束（未计胜负）', winner: null, abandoned: true });
  assert.deepEqual(data(h.c.S.play.moves), moves);
  assert.equal(h.c.canHumanMove(), false);
  assert.equal(h.c.aiBusy, false);
}

for (const game of ['chess', 'xiangqi']) {
  test(`${game}: ending a rated game immediately archives without a rating or win/loss event`, async () => {
    const h = harness(game), moves = seed(h), growth = data(h.c.GROW.s), gen = h.c.gen;
    h.c.aiBusy = true; h.c.hint = 'pending'; h.c.sel = 3; h.c.view = 2;
    await h.get('btnEnd').dispatch('click');
    assertEnded(h, moves);
    assert.ok(h.c.gen > gen);
    assert.ok(h.workers[0].terminated);
    assert.equal(h.c.hint, null);
    assert.equal(h.c.view, null);
    assert.equal(h.c.sel, -1);
    assert.deepEqual(data(h.c.GROW.s), growth);
    assert.equal(h.c.S.records.length, 1);
    const record = h.c.S.records[0];
    assert.deepEqual(data(record.moves), moves);
    assert.equal(record.winner, null);
    assert.equal(record.abandoned, true);
    assert.match(record.result, /未计胜负/);
    assert.match(h.c.gameList()[0].title, /未计胜负/);
    assert.equal(h.get('btnEnd').disabled, true);
    assert.equal(h.get('btnUndo').disabled, true);
    assert.equal(h.get('btnResign').disabled, true);
  });

  test(`${game}: repeat end, undo, move and advance cannot reopen or duplicate the ended game`, async () => {
    const h = harness(game), moves = seed(h), growth = data(h.c.GROW.s);
    h.c.endCurrentGame();
    h.c.endCurrentGame(); h.c.undo(); h.c.playUserMove('a1a2');
    await h.c.advance();
    h.c.finishGame({ winner: 0, reason: 'stale win' });
    assert.equal(await h.c.getAnalysis(moves.length), null);
    assertEnded(h, moves);
    assert.equal(h.c.S.records.length, 1);
    assert.deepEqual(data(h.c.GROW.s), growth);
    assert.equal(h.workers.at(-1).messages.length, 0);
  });

  test(`${game}: ended game remains terminal after reload and mode switches, then new game resets cleanly`, async () => {
    const h = harness(game), moves = seed(h);
    h.c.endCurrentGame();
    const reloaded = harness(game, h.storage), growth = data(reloaded.c.GROW.s);
    reloaded.c.render();
    await reloaded.c.advance();
    assertEnded(reloaded, moves);
    reloaded.c.setMode('growth'); reloaded.c.setMode('play');
    await flush();
    assertEnded(reloaded, moves);
    assert.equal(reloaded.c.S.records.length, 1);
    reloaded.c.newGame({ opp: 'ai', human: 0 });
    assert.equal(reloaded.c.S.play.result, null);
    assert.equal(reloaded.c.S.play.moves.length, 0);
    assert.equal(reloaded.c.canHumanMove(), true);
    assert.equal(reloaded.c.S.records.length, 1);
    assert.deepEqual(data(reloaded.c.GROW.s), growth);
  });

  test(`${game}: empty and human-versus-human games end without invented wins, draws or losses`, () => {
    const empty = harness(game), growth = data(empty.c.GROW.s);
    empty.c.endCurrentGame();
    assertEnded(empty, []);
    assert.equal(empty.c.S.records.length, 0);
    assert.deepEqual(data(empty.c.GROW.s), growth);
    const h = harness(game), moves = seed(h, 3, 'human'), pvpGrowth = data(h.c.GROW.s);
    h.c.endCurrentGame();
    assertEnded(h, moves);
    assert.deepEqual(data(h.c.GROW.s), pvpGrowth);
    assert.equal(h.c.S.records[0].opp, 'human');
  });

  test(`${game}: late AI result and analysis cannot change an ended or replacement game`, async () => {
    const h = harness(game), moves = seed(h, 3), pending = [];
    h.c.eng.run = () => { const d = deferred(); pending.push(d); return d.promise; };
    const oldMove = h.c.R.uci(h.c.R.legalMoves(h.c.playPos())[0]);
    const oldAnalysis = h.c.getAnalysis(moves.length);
    const oldAI = h.c.aiMove(h.c.gen);
    h.c.endCurrentGame();
    h.c.newGame({ opp: 'human', human: 0 });
    for (const d of pending) d.resolve({ best: oldMove, depth: 5, score: 0, moves: [{ u: oldMove, s: 0 }] });
    assert.equal(await oldAnalysis, null);
    await oldAI;
    assert.equal(h.c.S.play.moves.length, 0);
    assert.equal(h.c.S.play.result, null);
    assert.equal(h.c.aiBusy, false);
    assert.equal(h.c.analyses.length, 0);
    assert.equal(h.c.S.records.length, 1);
  });

  test(`${game}: an AI move already waiting for animation delay stops at end`, async () => {
    const h = harness(game), moves = seed(h, 3);
    const p = h.c.playPos(), best = h.c.R.uci(h.c.R.legalMoves(p)[0]);
    h.c.eng.run = async () => ({ best, depth: 2, score: 0, moves: [{ u: best, s: 0 }] });
    const job = h.c.aiMove(h.c.gen);
    await flush();
    const delay = [...h.timers.values()].find(t => t.ms > 0 && t.ms <= 400);
    assert.ok(delay, 'fixture must reach the delayed AI move');
    h.c.endCurrentGame();
    delay.fn();
    await job;
    assertEnded(h, moves);
    assert.equal(h.c.S.records.length, 1);
  });

  test(`${game}: a stale resign confirmation cannot settle an ended or replacement game`, async () => {
    const h = harness(game), moves = seed(h), growth = data(h.c.GROW.s);
    await h.get('btnResign').dispatch('click');
    const confirm = h.get('dlgConfirm'), lateClose = confirm.onclose;
    h.c.endCurrentGame();
    assert.equal(confirm.open, false);
    confirm.returnValue = 'ok'; lateClose();
    assertEnded(h, moves);
    h.c.newGame({ opp: 'human', human: 0 });
    lateClose();
    assert.equal(h.c.S.play.result, null);
    assert.equal(h.c.S.records.length, 1);
    assert.deepEqual(data(h.c.GROW.s), growth);
  });
}

test('chess: an in-flight promotion cannot move after ending and starting a new game', async () => {
  const h = harness('chess');
  h.c.S.play.fen = '7k/P7/8/8/8/8/8/7K w - - 0 1';
  h.c.S.play.opp = 'human';
  Object.assign(h.c.geom, { cell: 40, ox: 0, oy: 0 });
  h.c.sel = 96; // a7, with legal promotions to a8.
  const pending = h.get('board').dispatch('pointerup', { clientX: 20, clientY: 20 });
  assert.equal(h.get('dlgPromo').open, true);
  h.c.endCurrentGame();
  h.c.newGame({ opp: 'human', human: 0 });
  h.get('dlgPromo').close('q');
  await pending;
  assert.equal(h.c.S.play.moves.length, 0);
  assert.equal(h.c.S.play.fen, h.c.R.START);
  assert.equal(h.c.S.play.result, null);
});
