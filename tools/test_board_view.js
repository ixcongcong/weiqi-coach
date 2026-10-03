#!/usr/bin/env node
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const plain = value => JSON.parse(JSON.stringify(value));

// Read the real mapping functions rather than duplicating their formulas here.
function sourceBetween(file, start, end) {
  const text = fs.readFileSync(path.join(web, file), 'utf8');
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${file} coordinate-function boundary`);
  return text.slice(from, to);
}

function boardHarness({ key = 'go', width = 393, height = 852, stored = new Map(), rejectStorage = false, aspect = 1 } = {}) {
  const elements = new Map(), windowEvents = new Map();
  let focused = null;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.listeners = new Map();
      this.attributes = {};
      this.dataset = {};
      this.style = {
        setProperty(name, value) { this[name] = String(value); },
        getPropertyValue(name) { return this[name] || ''; },
        removeProperty(name) { const old = this[name]; delete this[name]; return old || ''; },
      };
      this.clientWidth = 381;
      this.clientHeight = 500;
      this.offsetHeight = 56;
      this.scrollLeft = this.scrollTop = 0;
      this.value = '';
      this.textContent = '';
      this.disabled = false;
      this.className = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => {
          const add = force === undefined ? !this.classList.contains(name) : force;
          if (add) this.classList.add(name); else this.classList.remove(name);
          return add;
        },
      };
    }
    set id(id) { this._id = id; elements.set(id, this); }
    get id() { return this._id || ''; }
    get parentNode() { return this.parentElement; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      this.children.push(child); child.parentElement = this;
      return child;
    }
    append(...children) { for (const child of children) this.appendChild(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; return child; }
    insertBefore(child, next) {
      if (child.parentElement) child.parentElement.removeChild(child);
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this;
      return child;
    }
    replaceChild(next, old) { this.insertBefore(next, old); this.removeChild(old); return old; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, fn, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ fn, capture: options === true || options?.capture === true });
    }
    dispatch(type, options = {}) {
      const event = { type, target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
      for (const { fn } of [...(this.listeners.get(type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) fn(event);
      return event;
    }
    click() { return this.dispatch('click'); }
    focus() { focused = this; }
    setPointerCapture(pointerId) { (this.pointerCaptures ||= []).push(pointerId); }
    releasePointerCapture(pointerId) { (this.pointerReleases ||= []).push(pointerId); }
    hasPointerCapture(pointerId) { return (this.pointerCaptures || []).includes(pointerId) && !(this.pointerReleases || []).includes(pointerId); }
    scrollTo({ left = 0, top = 0 } = {}) { this.scrollLeft = left; this.scrollTop = top; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    querySelector(selector) {
      const match = child => selector.startsWith('#') ? child.id === selector.slice(1) : selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase();
      for (const child of this.children) { if (match(child)) return child; const descendant = child.querySelector(selector); if (descendant) return descendant; }
      return null;
    }
  }
  const wrap = new Element('section'); wrap.id = 'boardWrap'; wrap.clientWidth = width - 12;
  const canvas = new Element('canvas'); canvas.id = 'board'; wrap.appendChild(canvas);
  const root = new Element('html');
  const app = new Element('main'); app.id = 'app'; app.clientWidth = width; app.clientHeight = height;
  const top = new Element('header'); top.id = 'top'; top.clientWidth = width; top.clientHeight = top.offsetHeight = 56;
  const help = new Element('button'); help.id = 'btnHelp'; top.appendChild(help);
  const side = new Element('aside'); side.id = 'side'; side.clientWidth = 340; side.clientHeight = 280;
  app.append(top, wrap, side); root.append(app);
  // A real grid updates the pane rectangle synchronously when its CSS size
  // changes. Keep that geometry live so a second drag/key starts from the new
  // displayed boundary rather than from stale mock dimensions.
  const paneSize = fallback => {
    const property = app.style.getPropertyValue('--coach-pane-size');
    const pixels = /^([\d.]+)px$/.exec(property);
    if (pixels) return Number(pixels[1]);
    if (property.includes('36vw')) return Math.max(200, Math.min(460, app.clientWidth * 0.36));
    if (property.includes('32dvh')) return Math.max(160, Math.min(340, app.clientHeight * 0.32));
    return fallback;
  };
  Object.defineProperty(side, 'clientWidth', { configurable: true,
    get: () => app.clientWidth >= app.clientHeight ? paneSize(340) : app.clientWidth });
  Object.defineProperty(side, 'clientHeight', { configurable: true,
    get: () => app.clientWidth < app.clientHeight ? paneSize(280) : app.clientHeight });
  const doc = {
    documentElement: root,
    get activeElement() { return focused; },
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    querySelector: selector => root.querySelector(selector),
  };
  let changed = 0;
  const ctx = vm.createContext({
    console, document: doc, innerWidth: width, innerHeight: height,
    localStorage: {
      getItem(k) { if (rejectStorage) throw new Error('Storage blocked'); return stored.get(k) ?? null; },
      setItem(k, value) { if (rejectStorage) throw new Error('Storage blocked'); stored.set(k, String(value)); },
      removeItem(k) { if (rejectStorage) throw new Error('Storage blocked'); stored.delete(k); },
    },
    addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(fn); },
    removeEventListener(type, fn) { windowEvents.set(type, (windowEvents.get(type) || []).filter(listener => listener !== fn)); },
    getComputedStyle: el => ({ width: `${el.clientWidth}px`, height: `${el.clientHeight}px`, paddingLeft: '6px', paddingRight: '6px', paddingTop: '6px', paddingBottom: '6px' }),
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(web, 'board-view.js'), 'utf8'), ctx, { filename: 'board-view.js' });
  let view;
  view = ctx.BoardView.mount(canvas, { key, onChange: () => {
    changed++;
    // The applications redraw the canvas synchronously on a display change.
    // Model that integration here so +/- begins at the actual last width.
    if (view) {
      const room = view.available(), px = view.widthFor?.(Math.min(room.width, room.height)) ?? Math.min(room.width, room.height) * view.scale;
      view.resized(px, px * aspect);
    }
  } });
  const resize = (nextWidth, nextHeight) => {
    ctx.innerWidth = app.clientWidth = top.clientWidth = nextWidth;
    ctx.innerHeight = app.clientHeight = nextHeight;
    for (const listener of windowEvents.get('resize') || []) listener({ type: 'resize' });
  };
  return { view, canvas, wrap, app, top, side, root, ctx, stored, elements, resize,
    changed: () => changed, get: id => elements.get(id) };
}

test('display controls default collapsed, toggle accessibly and remember state for each game', () => {
  for (const key of ['go', 'cc-chess', 'cc-xiangqi']) {
    const stored = new Map(), h = boardHarness({ key, stored });
    const panel = h.get('boardDisplayPanel'), toggle = h.get('boardDisplayToggle');
    assert.equal(panel.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), panel.id);
    assert.equal(h.get('btnHelp').nextSibling, toggle, 'display toggle follows help in the header');
    assert.equal(h.wrap.querySelector('.board-display-controls').hidden, true);
    toggle.click();
    assert.equal(panel.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(h.changed() > 0);
    assert.equal(boardHarness({ key, stored }).get('boardDisplayPanel').hidden, false);
    toggle.click();
    assert.equal(boardHarness({ key, stored }).get('boardDisplayPanel').hidden, true);
    assert.equal(h.view.boardPixels, null);
    assert.equal(boardHarness({ key, rejectStorage: true }).get('boardDisplayPanel').hidden, true);
  }
});

test('collapsed controls return measured space without losing the divider or board settings', () => {
  const h = boardHarness();
  const controls = h.wrap.querySelector('.board-display-controls');
  controls.offsetHeight = 28;
  const collapsedRoom = h.view.available().height;
  h.get('boardDisplayToggle').click(); controls.offsetHeight = 100;
  assert.equal(h.view.available().height, collapsedRoom - 100);
  h.view.setBoardPixels(500);
  h.get('boardDisplayToggle').click(); controls.offsetHeight = 28;
  assert.equal(h.view.boardPixels, 500);
  assert.equal(h.view.available().height, collapsedRoom);
  assert.ok(h.get('boardPaneDivider'));
});

test('board size controls use freely adjustable pixels, apply slider/buttons/input and reset to fit', () => {
  const h = boardHarness(), slider = h.get('boardZoom');
  h.view.resized(350, 350);
  assert.equal(Number(slider.min), 96);
  assert.equal(Number(slider.max), 2400);
  assert.equal(Number(slider.step), 1);
  assert.match(slider.getAttribute('aria-label') || '', /棋盘.*(?:大小|缩放|宽度)/);
  assert.equal(h.view.percent, 100);
  h.get('boardZoomIn').click();
  assert.equal(h.view.boardPixels, 370);
  h.get('boardZoomOut').click();
  assert.equal(h.view.boardPixels, 350);
  slider.value = '367'; slider.dispatch('input');
  assert.equal(h.view.boardPixels, 367);
  assert.equal(h.view.widthFor(350), 367);
  h.view.resized(367, 367);
  assert.match(h.get('boardZoomValue').textContent, /367\s*px/);
  const input = h.get('boardPixelsInput');
  assert.equal(input.type, 'number');
  assert.equal(Number(input.step), 1);
  input.value = '419'; input.dispatch('input'); input.dispatch('change');
  assert.equal(h.view.boardPixels, 419, 'manual width must not snap to a percentage increment');
  h.get('boardZoomFit').click();
  assert.equal(h.view.boardPixels, null);
  assert.equal(h.view.percent, 100);
  assert.ok(h.changed() >= 4, 'size changes should redraw the actual canvas');
  h.view.setBoardPixels(3000);
  assert.equal(h.view.boardPixels, 2400);
  assert.equal(h.get('boardZoomIn').disabled, true);
  h.view.setBoardPixels(1);
  assert.equal(h.view.boardPixels, 96);
  assert.equal(h.get('boardZoomOut').disabled, true);
});

test('display settings survive reload, are isolated by game, and never rewrite match state', () => {
  const stored = new Map([['weiqi-save', '{"moves":[1,2,3],"aiThinking":true}']]);
  const savedGame = stored.get('weiqi-save');
  const go = boardHarness({ stored, key: 'go' }); go.view.setPercent(170);
  go.get('boardTextZoom').click();
  const chess = boardHarness({ stored, key: 'cc-chess' }); chess.view.setPercent(120);
  const xiangqi = boardHarness({ stored, key: 'cc-xiangqi' }); xiangqi.view.setPercent(200);
  assert.equal(boardHarness({ stored, key: 'go' }).view.percent, 170);
  assert.equal(boardHarness({ stored, key: 'cc-chess' }).view.percent, 120);
  assert.equal(boardHarness({ stored, key: 'cc-xiangqi' }).view.percent, 200);
  assert.equal(stored.get('weiqi-save'), savedGame);
  assert.deepEqual(plain(JSON.parse(stored.get('weiqi-board-view:go'))), {
    percent: 170, textPercent: 125, boardPixels: null, panes: { portrait: null, landscape: null },
  });
});

test('portrait and landscape viewport dimensions stay bounded even for oversized boards', () => {
  const p = boardHarness({ width: 393, height: 852 });
  const portrait = p.view.available({ portraitRatio: 0.62 });
  assert.ok(portrait.width > 0 && portrait.width <= p.wrap.clientWidth);
  assert.ok(portrait.height > 0 && portrait.height <= 852 * 0.62);
  p.view.setPercent(200); p.view.resized(740, 740);
  const viewport = p.wrap.querySelector('.board-viewport'), stage = p.wrap.querySelector('.board-stage');
  assert.ok(viewport && stage && canvasParentContains(stage, p.canvas));
  assert.ok(parseFloat(viewport.style.maxHeight || viewport.style.height) <= 852 * 0.64);
  assert.ok(parseFloat(stage.style.width) >= 740, 'the scrollable stage must retain the whole enlarged board width');
  assert.ok(parseFloat(stage.style.height) >= 740, 'the scrollable stage must retain the whole enlarged board height');
  const l = boardHarness({ width: 1024, height: 768 });
  l.wrap.clientWidth = 550; l.wrap.clientHeight = 720;
  const landscape = l.view.available({ portraitRatio: 0.62 });
  assert.ok(landscape.width > 0 && landscape.width <= 550 - 12);
  assert.ok(landscape.height > 0 && landscape.height <= 720 - 12);
  l.view.resized(900, 1000);
  const lViewport = l.wrap.querySelector('.board-viewport');
  assert.ok(parseFloat(lViewport.style.maxHeight || lViewport.style.height) <= landscape.height);
});

function canvasParentContains(stage, canvas) {
  return canvas.parentElement === stage;
}

test('changing analysis text size cycles accessible labels and persists alongside board size', () => {
  const h = boardHarness(), button = h.get('boardTextZoom');
  const seen = [];
  for (let i = 0; i < 3; i++) { button.click(); seen.push(button.textContent); }
  assert.match(seen[0], /125%/);
  assert.match(seen[1], /150%/);
  assert.match(seen[2], /100%/);
  assert.match(button.getAttribute('aria-label') || button.title || button.textContent, /(?:讲解|文字)/);
  assert.equal(JSON.parse(h.stored.get('weiqi-board-view:go')).textPercent, 100);
});

test('blocked browser storage cannot prevent board display changes', () => {
  const h = boardHarness({ rejectStorage: true });
  h.view.setPercent(200);
  assert.equal(h.view.percent, 200);
  h.get('boardTextZoom').click();
  assert.match(h.get('boardTextZoom').textContent, /125%/);
});

test('corrupt and obsolete display preferences recover to usable zoom controls', () => {
  for (const value of ['not json', 'null', '{"percent":"broken","textPercent":999}', '{}']) {
    const stored = new Map([['weiqi-board-view:go', value]]);
    const h = boardHarness({ stored });
    assert.equal(h.view.percent, 100, value);
    assert.match(h.get('boardTextZoom').textContent, /100%/, value);
    h.view.setPercent(140);
    assert.deepEqual(plain(JSON.parse(stored.get('weiqi-board-view:go'))), {
      percent: 140, textPercent: 100, boardPixels: null, panes: { portrait: null, landscape: null },
    });
  }
});

test('dragging, pointer cancellation and another pointer cannot accidentally place a move', () => {
  const h = boardHarness(); h.view.setPercent(200);
  h.canvas.dispatch('pointerdown', { pointerId: 7, clientX: 100, clientY: 150 });
  h.canvas.dispatch('pointermove', { pointerId: 7, clientX: 160, clientY: 210 });
  const dragged = h.canvas.dispatch('pointerup', { pointerId: 7, clientX: 160, clientY: 210 });
  assert.equal(h.view.isTap(dragged), false);
  h.canvas.dispatch('pointerdown', { pointerId: 8, clientX: 100, clientY: 150 });
  const tapped = h.canvas.dispatch('pointerup', { pointerId: 8, clientX: 103, clientY: 153 });
  assert.equal(h.view.isTap(tapped), true);
  h.canvas.dispatch('pointerdown', { pointerId: 9, clientX: 100, clientY: 150 });
  h.canvas.dispatch('pointercancel', { pointerId: 9, clientX: 100, clientY: 150 });
  const cancelled = h.canvas.dispatch('pointerup', { pointerId: 9, clientX: 100, clientY: 150 });
  assert.equal(h.view.isTap(cancelled), false);
  h.canvas.dispatch('pointerdown', { pointerId: 10, clientX: 100, clientY: 150 });
  const unrelated = h.canvas.dispatch('pointerup', { pointerId: 11, clientX: 100, clientY: 150 });
  assert.equal(h.view.isTap(unrelated), false);
});

test('a two-finger pinch and a drag returning to its origin remain non-moves, then a fresh tap works', () => {
  const h = boardHarness(); h.view.setPercent(200);
  const finger = (pointerId, clientX, clientY = 150) => ({ pointerId, clientX, clientY, pointerType: 'touch' });
  h.canvas.dispatch('pointerdown', finger(1, 100));
  h.canvas.dispatch('pointerdown', finger(2, 120));
  assert.equal(h.view.isTap(h.canvas.dispatch('pointerup', finger(2, 120))), false);
  assert.equal(h.view.isTap(h.canvas.dispatch('pointerup', finger(1, 100))), false);
  h.canvas.dispatch('pointerdown', finger(3, 100));
  h.canvas.dispatch('pointermove', finger(3, 140));
  h.canvas.dispatch('pointermove', finger(3, 100));
  assert.equal(h.view.isTap(h.canvas.dispatch('pointerup', finger(3, 100))), false);
  h.canvas.dispatch('pointerdown', finger(4, 100));
  assert.equal(h.view.isTap(h.canvas.dispatch('pointerup', finger(4, 100))), true);
});

test('desktop mouse drag pans an enlarged board without placing a move, and fit size does not force panning', () => {
  const h = boardHarness(); h.view.setPercent(200); h.view.resized(740, 740);
  const viewport = h.wrap.querySelector('.board-viewport');
  viewport.scrollLeft = 200; viewport.scrollTop = 150;
  const mouse = (pointerId, clientX, clientY) => ({ pointerId, clientX, clientY, pointerType: 'mouse', button: 0, buttons: 1 });
  h.canvas.dispatch('pointerdown', mouse(11, 250, 260));
  assert.deepEqual(h.canvas.pointerCaptures, [11]);
  let prevented = false;
  h.canvas.dispatch('pointermove', { ...mouse(11, 210, 210), preventDefault() { prevented = true; } });
  assert.equal(viewport.scrollLeft, 240);
  assert.equal(viewport.scrollTop, 200);
  assert.equal(prevented, true);
  const dragged = h.canvas.dispatch('pointerup', { ...mouse(11, 210, 210), buttons: 0 });
  assert.equal(h.view.isTap(dragged), false);
  h.view.setPercent(100); h.view.resized(350, 350);
  viewport.scrollLeft = 17; viewport.scrollTop = 19;
  h.canvas.dispatch('pointerdown', mouse(12, 250, 260));
  h.canvas.dispatch('pointermove', mouse(12, 210, 210));
  assert.equal(viewport.scrollLeft, 17);
  assert.equal(viewport.scrollTop, 19);
  assert.deepEqual(h.canvas.pointerCaptures, [11], '100% does not force pointer capture for panning');
  assert.equal(h.view.isTap(h.canvas.dispatch('pointerup', { ...mouse(12, 210, 210), buttons: 0 })), false);
});

test('resetting to a fitting board removes stale pan offsets and mounting twice does not duplicate controls', () => {
  const h = boardHarness(); h.view.setPercent(200); h.view.resized(740, 740);
  const viewport = h.wrap.querySelector('.board-viewport');
  viewport.scrollLeft = 200; viewport.scrollTop = 150;
  h.get('boardZoomFit').click(); h.view.resized(350, 350);
  assert.equal(viewport.scrollLeft, 0);
  assert.equal(viewport.scrollTop, 0);
  const again = h.ctx.BoardView.mount(h.canvas, { key: 'go', onChange() { throw new Error('duplicate mount must reuse original'); } });
  assert.equal(again, h.view);
  assert.equal(h.wrap.children.filter(child => child.classList.contains('board-display-controls')).length, 1);
  assert.equal(h.wrap.children.filter(child => child.classList.contains('board-viewport')).length, 1);
});

test('pixel sizes allow one-pixel precision, preserve the requested width and recover from invalid preferences', () => {
  const h = boardHarness();
  h.view.setBoardPixels(367);
  assert.equal(h.view.boardPixels, 367);
  assert.equal(h.view.widthFor(700), 367);
  h.view.setBoardPixels(368);
  assert.equal(h.view.widthFor(700), 368);
  assert.equal(boardHarness({ stored: h.stored }).view.boardPixels, 368);
  h.view.setBoardPixels(null);
  assert.equal(h.view.boardPixels, null);
  assert.equal(h.view.widthFor(287), 287);
  for (const raw of [
    '{"boardPixels":"oops","panes":null}',
    '{"boardPixels":null,"panes":{"portrait":"bad","landscape":null}}',
    '{"boardPixels":false,"panes":42}',
  ]) {
    const bad = boardHarness({ stored: new Map([['weiqi-board-view:go', raw]]) });
    assert.equal(bad.view.boardPixels, null, raw);
    assert.equal(bad.view.panePixels, null, raw);
    assert.equal(bad.view.widthFor(321), 321, raw);
    bad.view.setBoardPixels(371);
    assert.equal(bad.view.boardPixels, 371, 'corrupt preferences must not break subsequent sizing');
  }
});

test('typing a smaller board width enlarges the AI pane and typing a larger width shrinks it in either orientation', () => {
  for (const [width, height, aspect] of [[1200, 800, 1], [500, 1000, 1], [500, 1000, 1.125]]) {
    const h = boardHarness({ width, height, aspect });
    h.view.resized(407, 407 * aspect);
    const input = h.get('boardPixelsInput');
    const enterWidth = pixels => {
      input.value = String(pixels);
      input.dispatch('change');
      assert.equal(h.view.boardPixels, pixels, 'linked layout must retain the exact user-entered pixel width');
      assert.equal(h.view.widthFor(700), pixels);
      assert.equal(Number(input.value), pixels);
      return h.view.panePixels;
    };
    const initial = enterWidth(407);
    const smallerBoard = enterWidth(371);
    assert.ok(smallerBoard > initial, 'making the board smaller must give the freed space to the explanation');
    const scale = width >= height ? 1 : aspect;
    assert.ok(Math.abs(smallerBoard - initial - 36 * scale) <= 1, 'free pixel edits must transfer the corresponding rendered space');
    const largerBoard = enterWidth(419);
    assert.ok(largerBoard < smallerBoard, 'making the board larger must reduce the explanation pane');
    assert.ok(Math.abs(smallerBoard - largerBoard - 48 * scale) <= 1);
    const axis = width >= height ? 'landscape' : 'portrait';
    const saved = JSON.parse(h.stored.get('weiqi-board-view:go'));
    assert.equal(saved.boardPixels, 419);
    assert.equal(saved.panes[axis], largerBoard);
  }
});

test('a manually enlarged pixel board remains pannable at legacy 100% without placing a move', () => {
  const h = boardHarness(); h.view.setBoardPixels(740); h.view.resized(740, 740);
  assert.equal(h.view.percent, 100);
  const viewport = h.wrap.querySelector('.board-viewport');
  viewport.scrollLeft = 100; viewport.scrollTop = 150;
  const mouse = (clientX, clientY) => ({ pointerId: 41, clientX, clientY, pointerType: 'mouse', button: 0 });
  h.canvas.dispatch('pointerdown', mouse(200, 230));
  h.canvas.dispatch('pointermove', mouse(180, 190));
  assert.equal(viewport.scrollLeft, 120);
  assert.equal(viewport.scrollTop, 190);
  assert.equal(h.view.isTap(h.canvas.dispatch('pointerup', mouse(180, 190))), false);
});

test('an accessible draggable divider is mounted once between the board and the AI pane', () => {
  for (const [width, height, orientation] of [[393, 852, 'horizontal'], [1200, 800, 'vertical']]) {
    const h = boardHarness({ width, height });
    const divider = h.get('boardPaneDivider');
    assert.ok(divider, 'board and explanation need a draggable separator');
    assert.equal(divider.parentElement, h.app);
    assert.equal(divider.getAttribute('role'), 'separator');
    assert.equal(divider.getAttribute('aria-orientation'), orientation);
    assert.ok(Number(divider.tabIndex) >= 0, 'keyboard users must be able to focus the divider');
    assert.ok(h.app.children.indexOf(h.wrap) < h.app.children.indexOf(divider));
    assert.ok(h.app.children.indexOf(divider) < h.app.children.indexOf(h.side));
    assert.equal(h.ctx.BoardView.mount(h.canvas, { key: 'go' }), h.view);
    assert.equal(h.app.children.filter(child => child.id === 'boardPaneDivider').length, 1);
  }
});

function dragDivider(h, from, to, pointerId = 71) {
  const divider = h.get('boardPaneDivider');
  const point = ([clientX, clientY]) => ({ pointerId, pointerType: 'touch', clientX, clientY, button: 0 });
  divider.dispatch('pointerdown', point(from));
  divider.dispatch('pointermove', point(to));
  divider.dispatch('pointerup', point(to));
}

test('dragging left enlarges a landscape AI pane and automatically refits the board', () => {
  const stored = new Map([['weiqi-save', '{"moves":[4,7],"toMove":1}']]);
  const h = boardHarness({ width: 1200, height: 800, stored });
  const initialPane = h.side.clientWidth;
  h.view.setBoardPixels(647);
  h.view.setPercent(180);
  dragDivider(h, [800, 300], [713, 300]);
  assert.equal(h.view.panePixels, initialPane + 87);
  assert.equal(h.view.boardPixels, null, 'moving the divider must release fixed board size');
  assert.equal(h.view.percent, 100, 'the enlarged explanation must not leave a stale board zoom');
  assert.equal(h.view.widthFor(449), 449);
  const enlarged = h.view.panePixels;
  dragDivider(h, [713, 300], [743, 300], 72);
  assert.equal(h.view.panePixels, enlarged - 30);
  assert.equal(stored.get('weiqi-save'), '{"moves":[4,7],"toMove":1}');
});

test('dragging up enlarges a portrait AI pane and moving down gives room back to the board', () => {
  const h = boardHarness({ width: 393, height: 852 });
  const initialPane = h.side.clientHeight;
  h.view.setBoardPixels(407);
  dragDivider(h, [180, 520], [180, 463]);
  assert.equal(h.view.panePixels, Math.round(initialPane + 57));
  assert.equal(h.view.boardPixels, null);
  assert.equal(h.view.percent, 100);
  const enlarged = h.view.panePixels;
  dragDivider(h, [180, 463], [180, 491], 72);
  assert.equal(h.view.panePixels, enlarged - 28);
  assert.equal(h.view.widthFor(237), 237);
});

test('cancelled divider gestures cannot continue resizing from stale pointer events', () => {
  const h = boardHarness({ width: 1200, height: 800 });
  const divider = h.get('boardPaneDivider');
  const point = clientX => ({ pointerId: 88, pointerType: 'touch', clientX, clientY: 200, button: 0 });
  divider.dispatch('pointerdown', point(800));
  divider.dispatch('pointermove', point(780));
  divider.dispatch('pointercancel', point(780));
  const cancelledAt = h.view.panePixels;
  divider.dispatch('pointermove', point(650));
  divider.dispatch('pointerup', point(650));
  assert.equal(h.view.panePixels, cancelledAt);
  dragDivider(h, [780, 200], [760, 200], 89);
  assert.equal(h.view.panePixels, cancelledAt + 20, 'a new gesture should still work normally');
});

test('keyboard arrows resize the active pane in both orientations without changing the chess state', () => {
  for (const [width, height, grow, shrink] of [[1200, 800, 'ArrowLeft', 'ArrowRight'], [393, 852, 'ArrowUp', 'ArrowDown']]) {
    const h = boardHarness({ width, height });
    h.view.setPanePixels(300);
    const divider = h.get('boardPaneDivider');
    const growing = divider.dispatch('keydown', { key: grow });
    assert.ok(h.view.panePixels > 300, `${grow} should enlarge the explanation`);
    assert.equal(growing.defaultPrevented, true, 'arrow resizing must not also scroll the page');
    divider.dispatch('keydown', { key: shrink });
    assert.equal(h.view.panePixels, 300);
  }
});

test('pointer interaction focuses the divider even when default touch behavior is prevented, then keyboard resizing continues', () => {
  for (const [width, height, grow] of [[1200, 800, 'ArrowLeft'], [393, 852, 'ArrowUp']]) {
    for (const pointerType of ['mouse', 'touch']) {
      const h = boardHarness({ width, height });
      h.view.setPanePixels(300);
      const divider = h.get('boardPaneDivider');
      const pointer = { pointerId: 91, pointerType, clientX: 250, clientY: 300, button: 0 };
      const down = divider.dispatch('pointerdown', pointer);
      assert.equal(down.defaultPrevented, true, 'the resize gesture must not trigger native scrolling');
      assert.equal(h.ctx.document.activeElement, divider, `${pointerType} interaction must focus the separator explicitly`);
      divider.dispatch('pointerup', pointer);
      h.ctx.document.activeElement.dispatch('keydown', { key: grow });
      assert.equal(h.view.panePixels, 310, 'the focused separator must continue to handle keyboard resizing after a pointer gesture');
    }
  }
});

test('pane sizes are bounded to keep both board and explanation reachable', () => {
  for (const [width, height, min] of [[1200, 800, 200], [393, 852, 160]]) {
    const h = boardHarness({ width, height });
    const total = width >= height ? width : height - h.top.offsetHeight;
    h.view.setPanePixels(1);
    const small = parseFloat(h.app.style.getPropertyValue('--coach-pane-size'));
    assert.ok(Number.isFinite(small) && small >= min, `pane minimum ${min}`);
    h.view.setPanePixels(10000);
    const large = parseFloat(h.app.style.getPropertyValue('--coach-pane-size'));
    assert.ok(Number.isFinite(large) && large < total - 100, 'large AI pane must leave a usable board region');
    assert.ok(large >= small);
  }
});

test('default and reset layouts clamp the AI pane in a very short viewport without storing temporary limits or changing progress', () => {
  const stored = new Map([
    ['weiqi-games', '[{"moves":[2,4],"result":"finished"}]'],
    ['weiqi-save', '{"lesson":12,"moves":[8],"toMove":1}'],
  ]);
  const games = stored.get('weiqi-games'), progress = stored.get('weiqi-save');
  const h = boardHarness({ width: 250, height: 300, stored });
  const assertReachableDefault = () => {
    const divider = h.get('boardPaneDivider');
    const renderedPane = parseFloat(h.app.style.getPropertyValue('--coach-pane-size'));
    const maximum = Number(divider.getAttribute('aria-valuemax'));
    assert.ok(Number.isFinite(renderedPane) && renderedPane > 0);
    assert.ok(renderedPane <= maximum, 'default AI size must honor the same small-window bound as manual resizing');
    assert.ok(renderedPane < 160, 'a short screen must not retain an overflowing fixed 160px minimum');
    assert.equal(h.view.panePixels, null, 'the temporary default clamp must not become a saved user preference');
  };
  assertReachableDefault();
  assert.equal(stored.has('weiqi-board-view:go'), false, 'initial layout must not persist viewport-derived dimensions');
  h.get('boardTextZoom').click();
  h.view.setPanePixels(160); h.view.setBoardPixels(113);
  h.get('boardLayoutReset').click();
  assertReachableDefault();
  assert.equal(h.view.boardPixels, null);
  assert.match(h.get('boardTextZoom').textContent, /125%/);
  assert.deepEqual(plain(JSON.parse(stored.get('weiqi-board-view:go'))), {
    percent: 100, textPercent: 125, boardPixels: null, panes: { portrait: null, landscape: null },
  });
  assert.equal(stored.get('weiqi-games'), games);
  assert.equal(stored.get('weiqi-save'), progress);
});

test('pixel layout preferences are isolated by game and portrait/landscape and survive reload', () => {
  const stored = new Map([['weiqi-save', '{"lesson":17,"moves":[1,2]}']]);
  const saved = stored.get('weiqi-save');
  for (const [key, portrait, landscape, board] of [
    ['go', 267, 431, 367], ['cc-chess', 299, 463, 411], ['cc-xiangqi', 331, 495, 455],
  ]) {
    const h = boardHarness({ key, stored });
    h.view.setPanePixels(portrait);
    h.resize(1200, 800);
    assert.equal(h.view.panePixels, null, 'first rotation should use its own default');
    h.view.setPanePixels(landscape);
    h.view.setBoardPixels(board);
    const p = boardHarness({ key, stored, width: 393, height: 852 });
    const l = boardHarness({ key, stored, width: 1200, height: 800 });
    assert.equal(p.view.panePixels, portrait);
    assert.equal(l.view.panePixels, landscape);
    assert.equal(p.view.boardPixels, board);
    assert.equal(l.view.boardPixels, board);
    assert.deepEqual(plain(JSON.parse(stored.get(`weiqi-board-view:${key}`))).panes, { portrait, landscape });
  }
  assert.equal(stored.get('weiqi-save'), saved);
});

test('rotation and viewport shrink clamp displayed layout but retain the preferred pane size', () => {
  const h = boardHarness({ width: 1400, height: 800 });
  h.view.setPanePixels(777);
  h.resize(720, 500);
  const limited = parseFloat(h.app.style.getPropertyValue('--coach-pane-size'));
  assert.ok(limited < 777, 'smaller viewport must limit the rendered AI pane');
  assert.equal(h.view.panePixels, 777, 'temporary viewport limits must not destroy the saved preference');
  assert.equal(JSON.parse(h.stored.get('weiqi-board-view:go')).panes.landscape, 777);
  h.resize(393, 852);
  assert.equal(h.view.panePixels, null);
  assert.equal(h.get('boardPaneDivider').getAttribute('aria-orientation'), 'horizontal');
  h.view.setPanePixels(287);
  h.resize(1400, 800);
  assert.equal(h.view.panePixels, 777);
  assert.equal(parseFloat(h.app.style.getPropertyValue('--coach-pane-size')), 777);
  assert.equal(h.get('boardPaneDivider').getAttribute('aria-orientation'), 'vertical');
});

test('the board follows actual resized pane dimensions instead of an old portrait screen ratio', () => {
  for (const [width, height] of [[393, 852], [1200, 800]]) {
    const h = boardHarness({ width, height });
    h.get('boardDisplayToggle').click();
    h.view.setPanePixels(300);
    h.wrap.clientWidth = 251; h.wrap.clientHeight = 229;
    const room = h.view.available({ portraitRatio: 0.9 });
    assert.ok(room.width > 0 && room.width <= 239);
    assert.ok(room.height > 0 && room.height <= 229 - 56 - 12, 'controls occupy real space in either orientation');
    h.view.resized(600, 700);
    const viewport = h.wrap.querySelector('.board-viewport');
    assert.ok(parseFloat(viewport.style.height) <= room.height, 'the scroll view must stay inside the resized board pane');
    h.wrap.clientWidth = 321; h.wrap.clientHeight = 329;
    const more = h.view.available();
    assert.ok(more.width > room.width && more.height > room.height, 'giving space back should expand the available board room');
    assert.equal(h.view.boardPixels, null);
    assert.equal(h.view.widthFor(Math.min(more.width, more.height)), Math.min(more.width, more.height));
  }
});

test('divider is a one-pixel line with a wider invisible touch target in both orientations', () => {
  const css = fs.readFileSync(path.join(web, 'app.css'), 'utf8');
  assert.match(css, /\.board-pane-handle \{ width: 100%; height: 1px;/);
  assert.match(css, /\.board-pane-handle \{ width: 1px; height: 100%;/);
  assert.match(css, /\.board-pane-divider::before \{ content: ''; position: absolute; inset: -8px 0;/);
  assert.match(css, /\.board-pane-divider::before \{ inset: 0 -8px;/);
  assert.doesNotMatch(css, /\.board-pane-divider[^\n]*outline: 2px/);
});

test('reset layout clears both pane orientations and fixed board width but retains text size and match state', () => {
  const stored = new Map([['cc-chess-save', '{"moves":[1,2,3],"result":null}']]);
  const h = boardHarness({ key: 'cc-chess', stored });
  h.get('boardTextZoom').click(); h.get('boardTextZoom').click();
  h.view.setPanePixels(289); h.resize(1200, 800); h.view.setPanePixels(419);
  h.view.setBoardPixels(667);
  h.view.resetLayout();
  assert.equal(h.view.panePixels, null);
  assert.equal(h.view.boardPixels, null);
  assert.equal(h.view.percent, 100);
  assert.match(h.get('boardTextZoom').textContent, /150%/);
  const display = JSON.parse(stored.get('weiqi-board-view:cc-chess'));
  assert.deepEqual(plain(display), { percent: 100, textPercent: 150, boardPixels: null, panes: { portrait: null, landscape: null } });
  assert.equal(stored.get('cc-chess-save'), '{"moves":[1,2,3],"result":null}');
});

test('Go intersections stay under the pointer at every board size and zoom level, including a panned canvas', () => {
  const source = sourceBetween('app.js', 'function toPoint(e)', '\nfunction onBoardTap');
  for (const n of [9, 13, 19]) {
    for (const zoom of [0.5, 1, 2]) {
      const px = 360 * zoom, org = px * 0.055;
      const geom = { n, px, org, cell: (px - 2 * org) / (n - 1) };
      const rect = { left: -153, top: -76, width: px, height: px };
      const ctx = vm.createContext({ geom, NONE: -1, canvas: { getBoundingClientRect: () => rect } });
      vm.runInContext(source, ctx);
      for (const [x, y] of [[0, 0], [n - 1, n - 1], [Math.floor(n / 2), Math.floor(n / 2)]]) {
        const event = { clientX: rect.left + org + x * geom.cell, clientY: rect.top + org + y * geom.cell };
        assert.equal(ctx.toPoint(event), (y + 1) * (n + 2) + x + 1, `${n} road at ${zoom * 100}% (${x}, ${y})`);
      }
      assert.equal(ctx.toPoint({ clientX: rect.left + org - geom.cell, clientY: rect.top + org }), -1);
      assert.equal(ctx.toPoint({ clientX: rect.left + org, clientY: rect.top + org + n * geom.cell }), -1);
    }
  }
});

test('xiangqi and chess preserve square selection after zoom, panning and board flipping', () => {
  const source = sourceBetween('cc/app.js', 'function center(x, y)', '\nfunction drawChessBoard');
  for (const isChess of [false, true]) {
    const W = isChess ? 8 : 9, H = isChess ? 8 : 10;
    for (const flip of [false, true]) {
      for (const zoom of [0.5, 1, 2]) {
        const cell = 40 * zoom;
        const geom = { cell, ox: isChess ? 0 : cell * 0.9, oy: isChess ? 0 : cell * 0.9 };
        const ctx = vm.createContext({ geom, IS_CHESS: isChess, flipNow: flip, R: { W, H } });
        vm.runInContext(source, ctx);
        const rect = { left: -165, top: -70 };
        for (const [x, y] of [[0, 0], [W - 1, H - 1], [3, 4]]) {
          const [px, py] = ctx.center(x, y);
          const event = { clientX: rect.left + px, clientY: rect.top + py };
          assert.deepEqual(plain(ctx.cellAt(event.clientX - rect.left, event.clientY - rect.top)), [x, y], `${isChess ? 'chess' : 'xiangqi'} flip ${flip} zoom ${zoom}`);
        }
        assert.equal(ctx.cellAt(geom.ox - cell, geom.oy), null);
        assert.equal(ctx.cellAt(geom.ox, geom.oy + H * cell), null);
      }
    }
  }
});
