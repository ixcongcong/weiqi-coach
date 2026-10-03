/* 三种棋共用的显示设置：只改变画面尺寸，不改变棋局或 AI。 */
(function (root) {
  'use strict';
  const mounted = new WeakMap();
  const clampPercent = value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(50, Math.min(200, Math.round(number / 10) * 10)) : 100;
  };
  const clampBoardPixels = value => value == null ? null : Number.isFinite(Number(value)) ? Math.max(96, Math.min(2400, Math.round(Number(value)))) : null;
  const validPane = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  function mount(canvas, { key, onChange = () => {} } = {}) {
    if (mounted.has(canvas)) return mounted.get(canvas);
    const wrap = canvas.parentElement, storageKey = `weiqi-board-view:${key || 'go'}`;
    let percent = 100, textPercent = 100, boardPixels = null;
    const panes = { portrait: null, landscape: null };
    try {
      const saved = JSON.parse(root.localStorage.getItem(storageKey) || 'null');
      if (saved && typeof saved.percent === 'number') percent = clampPercent(saved.percent);
      if (saved && [100, 125, 150].includes(saved.textPercent)) textPercent = saved.textPercent;
      if (saved && typeof saved.boardPixels === 'number') boardPixels = clampBoardPixels(saved.boardPixels);
      if (saved?.panes) for (const direction of Object.keys(panes)) panes[direction] = validPane(saved.panes[direction]);
    } catch (e) { /* 使用默认大小。 */ }
    const create = (tag, id, text) => {
      const node = document.createElement(tag);
      if (id) node.id = id;
      if (text) node.textContent = text;
      return node;
    };
    const viewport = create('div'); viewport.className = 'board-viewport'; viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', '棋盘视图，放大后可滚动查看');
    const stage = create('div'); stage.className = 'board-stage';
    wrap.insertBefore(viewport, canvas); viewport.appendChild(stage); stage.appendChild(canvas);
    const controls = create('div'); controls.className = 'board-display-controls';
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', '棋盘和讲解显示大小');
    const label = create('label', '', '棋盘宽度'); label.htmlFor = 'boardPixelsInput';
    const button = (id, text, ariaLabel) => {
      const el = create('button', id, text); el.type = 'button'; el.className = 'small';
      el.setAttribute('aria-label', ariaLabel); return el;
    };
    const less = button('boardZoomOut', '−', '缩小棋盘');
    const range = create('input', 'boardZoom'); range.type = 'range'; range.min = '96'; range.max = '2400'; range.step = '1';
    range.setAttribute('aria-label', '棋盘宽度，像素');
    const pixelInput = create('input', 'boardPixelsInput'); pixelInput.type = 'number'; pixelInput.min = '96'; pixelInput.max = '2400'; pixelInput.step = '1';
    pixelInput.setAttribute('aria-label', '自由设置棋盘宽度，像素');
    const more = button('boardZoomIn', '+', '放大棋盘');
    const value = create('output', 'boardZoomValue'); value.htmlFor = 'boardZoom';
    const reset = button('boardZoomFit', '适应屏幕', '棋盘恢复为适应屏幕');
    const resetPanes = button('boardLayoutReset', '默认布局', '恢复默认棋盘和讲解区域大小');
    const text = button('boardTextZoom', '', '放大讲解文字');
    text.title = '讲解文字大小：100%、125%、150%循环切换';
    const toggle = button('boardDisplayToggle', '', '展开显示调节');
    const panel = create('div', 'boardDisplayPanel'); panel.className = 'board-display-panel';
    toggle.setAttribute('aria-controls', panel.id);
    let controlsExpanded = false;
    try { controlsExpanded = root.localStorage.getItem(`${storageKey}:controls`) === 'expanded'; } catch (e) { /* 默认收起。 */ }
    function updateControls() {
      panel.hidden = !controlsExpanded;
      controls.hidden = !controlsExpanded;
      toggle.textContent = controlsExpanded ? '收起调节 ▴' : '显示调节 ▾';
      toggle.setAttribute('aria-expanded', String(controlsExpanded));
      toggle.setAttribute('aria-label', controlsExpanded ? '收起棋盘和文字显示调节' : '展开棋盘和文字显示调节');
    }
    for (const el of [label, less, range, pixelInput, more, value, reset, text, resetPanes]) panel.appendChild(el);
    const help = document.getElementById('btnHelp');
    if (help?.parentElement) help.parentElement.insertBefore(toggle, help.nextSibling);
    else wrap.appendChild(toggle);
    controls.appendChild(panel); updateControls();
    wrap.appendChild(controls);
    toggle.addEventListener('click', () => {
      controlsExpanded = !controlsExpanded; updateControls();
      try { root.localStorage.setItem(`${storageKey}:controls`, controlsExpanded ? 'expanded' : 'collapsed'); } catch (e) { /* 棋局不受影响。 */ }
      applyPane(); onChange();
    });
    const app = document.getElementById('app'), side = document.getElementById('side'), top = document.getElementById('top');
    const direction = () => root.innerWidth >= root.innerHeight ? 'landscape' : 'portrait';
    const controlsHeight = () => controls.hidden ? 0 : (controls.offsetHeight || 44);
    let actualWidth = 0, overflowing = percent > 100;
    let divider = null;
    if (app && side) {
      app.classList.add('board-layout-resizable');
      document.documentElement.classList.add('board-layout-page');
      divider = create('div', 'boardPaneDivider'); divider.className = 'board-pane-divider'; divider.tabIndex = 0;
      divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', '拖动调整棋盘和 AI 解答区域大小');
      divider.title = '拖动自由调整：解答区域变大，棋盘自动变小。也可用方向键调整，双击恢复默认。';
      const handle = create('span'); handle.className = 'board-pane-handle'; handle.setAttribute('aria-hidden', 'true'); divider.appendChild(handle);
      app.insertBefore(divider, side);
    }
    function paneBounds() {
      const landscape = direction() === 'landscape';
      const style = app && root.getComputedStyle ? root.getComputedStyle(app) : {};
      const padding = names => names.reduce((sum, name) => sum + (parseFloat(style[name]) || 0), 0);
      const length = Math.max(0, landscape
        ? (app?.clientWidth || root.innerWidth) - padding(['paddingLeft', 'paddingRight']) - 8
        : (app?.clientHeight || root.innerHeight) - padding(['paddingTop', 'paddingBottom']) - (top?.offsetHeight || 0) - 8);
      const boardMinimum = Math.min(landscape ? 128 : controlsHeight() + 108, Math.max(1, length - 40));
      const max = Math.max(1, length - boardMinimum), min = Math.min(landscape ? 200 : 160, max);
      return { min, max, length };
    }
    function applyPane() {
      if (!divider) return;
      const axis = direction(), bounds = paneBounds(), preferred = panes[axis];
      const defaultSize = axis === 'landscape' ? Math.min(460, (app.clientWidth || root.innerWidth) * 0.36) : Math.min(340, (app.clientHeight || root.innerHeight) * 0.32);
      // The default needs the same bounds as a dragged pane, particularly in
      // very short windows where fixed minimums could hide the controls.
      const current = Math.round(Math.max(bounds.min, Math.min(bounds.max, preferred ?? defaultSize)));
      app.style.setProperty('--coach-pane-size', `${current}px`);
      divider.setAttribute('aria-orientation', axis === 'landscape' ? 'vertical' : 'horizontal');
      divider.setAttribute('aria-valuemin', String(Math.round(bounds.min))); divider.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
      const displayed = current;
      divider.setAttribute('aria-valuenow', String(Math.round(displayed)));
      divider.setAttribute('aria-valuetext', `AI 解答区域${axis === 'landscape' ? '宽' : '高'} ${Math.round(displayed)} 像素`);
    }
    function persist() {
      try { root.localStorage.setItem(storageKey, JSON.stringify({ percent, textPercent, boardPixels, panes })); } catch (e) { /* 棋局不受显示设置影响。 */ }
    }
    function update() {
      const width = actualWidth || boardPixels || 0;
      range.value = String(width); range.setAttribute('aria-valuetext', `${Math.round(width)} 像素`);
      pixelInput.value = width ? String(Math.round(width)) : ''; value.textContent = width ? `${Math.round(width)} px` : '自动';
      less.disabled = width > 0 && width <= 96; more.disabled = width >= 2400;
      text.textContent = `文字 ${textPercent}%`; text.setAttribute('aria-label', `讲解文字 ${textPercent}%，点击切换大小`);
      document.documentElement.style.setProperty('--coach-scale', String(textPercent / 100));
      wrap.classList.toggle('board-enlarged', overflowing);
    }
    function setPercent(next) {
      const clamped = clampPercent(next); if (clamped === percent) return;
      percent = clamped; update(); persist(); onChange();
    }
    function setBoardPixels(next, { linkPane = false } = {}) {
      boardPixels = clampBoardPixels(next); percent = 100;
      if (linkPane && boardPixels != null && divider) {
        const axis = direction(), bounds = paneBounds();
        const aspect = previousWidth ? previousHeight / previousWidth : 1;
        const boardLength = axis === 'landscape' ? boardPixels + 14 : boardPixels * aspect + controlsHeight() + 14;
        panes[axis] = Math.round(Math.max(bounds.min, Math.min(bounds.max, bounds.length - boardLength)));
        applyPane();
      }
      overflowing = boardPixels != null && boardPixels > available().width;
      update(); persist(); onChange();
    }
    function setPanePixels(next) {
      const axis = direction(), bounds = paneBounds();
      panes[axis] = next == null || !Number.isFinite(Number(next)) ? null : Math.round(Math.max(bounds.min, Math.min(bounds.max, Number(next))));
      // A moved partition means "fit this new space", not a panned fixed-size board.
      boardPixels = null; percent = 100; overflowing = false;
      applyPane(); update(); persist(); onChange();
    }
    function resetLayout() {
      panes.portrait = panes.landscape = null; boardPixels = null; percent = 100; overflowing = false;
      applyPane(); update(); persist(); onChange();
    }
    range.addEventListener('input', () => setBoardPixels(range.value, { linkPane: true }));
    pixelInput.addEventListener('change', () => setBoardPixels(pixelInput.value === '' ? null : pixelInput.value, { linkPane: true }));
    pixelInput.addEventListener('keydown', event => { if (event.key === 'Enter') { setBoardPixels(pixelInput.value === '' ? null : pixelInput.value, { linkPane: true }); event.preventDefault(); } });
    less.addEventListener('click', () => setBoardPixels((actualWidth || boardPixels || available().width) - 20, { linkPane: true }));
    more.addEventListener('click', () => setBoardPixels((actualWidth || boardPixels || available().width) + 20, { linkPane: true }));
    reset.addEventListener('click', () => setBoardPixels(null)); resetPanes.addEventListener('click', resetLayout);
    text.addEventListener('click', () => { textPercent = textPercent === 100 ? 125 : textPercent === 125 ? 150 : 100; update(); persist(); });
    // Native scrolling cancels pointers; reject drags/pinches even if a browser
    // sends pointerup, so moving the enlarged view never becomes a chess move.
    let gesture = null, lastTap = null, multiple = false;
    const pointers = new Set();
    canvas.addEventListener('pointerdown', event => {
      pointers.add(event.pointerId); multiple = pointers.size > 1; lastTap = null;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: multiple,
        mouse: event.pointerType === 'mouse', left: viewport.scrollLeft, top: viewport.scrollTop };
      if (gesture.mouse && overflowing && canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
    }, true);
    canvas.addEventListener('pointermove', event => {
      if (gesture && gesture.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) gesture.moved = true;
      if (gesture && gesture.id === event.pointerId && gesture.mouse && gesture.moved && overflowing) {
        viewport.scrollLeft = gesture.left - (event.clientX - gesture.x);
        viewport.scrollTop = gesture.top - (event.clientY - gesture.y);
        event.preventDefault();
      }
    }, true);
    canvas.addEventListener('pointerup', event => {
      lastTap = { event, ok: Boolean(gesture && gesture.id === event.pointerId && !gesture.moved && !multiple && pointers.size === 1 &&
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8 && (event.button === undefined || event.button === 0)) };
      pointers.delete(event.pointerId); gesture = null; if (!pointers.size) multiple = false;
    }, true);
    canvas.addEventListener('pointercancel', event => { pointers.delete(event.pointerId); gesture = lastTap = null; if (!pointers.size) multiple = false; }, true);
    let currentPortraitRatio = 0.62;
    function available({ portraitRatio = currentPortraitRatio } = {}) {
      currentPortraitRatio = portraitRatio;
      // client* rounds fractional grid sizes. Leave two extra pixels so a
      // subpixel overflow cannot create scrollbars and shrink a fitted board.
      const width = Math.max(1, Math.floor(wrap.clientWidth - 14));
      const height = divider || root.innerWidth >= root.innerHeight ? Math.max(1, Math.floor(wrap.clientHeight - controlsHeight() - 14)) : Math.max(100, Math.floor(root.innerHeight * portraitRatio));
      return { width, height };
    }
    let previousWidth = 0, previousHeight = 0;
    function resized(width, height) {
      const room = available(), landscape = root.innerWidth >= root.innerHeight;
      const visibleHeight = divider || landscape ? room.height : Math.min(height, room.height);
      const oldCenterX = viewport.scrollLeft + viewport.clientWidth / 2, oldCenterY = viewport.scrollTop + viewport.clientHeight / 2;
      viewport.style.height = `${Math.floor(visibleHeight)}px`;
      stage.style.width = `${Math.ceil(Math.max(room.width, width))}px`; stage.style.height = `${Math.ceil(Math.max(visibleHeight, height))}px`;
      viewport.scrollLeft = width > room.width ? Math.max(0, previousWidth ? oldCenterX * width / previousWidth - viewport.clientWidth / 2 : (width - room.width) / 2) : 0;
      viewport.scrollTop = height > visibleHeight ? Math.max(0, previousHeight ? oldCenterY * height / previousHeight - viewport.clientHeight / 2 : (height - visibleHeight) / 2) : 0;
      previousWidth = width; previousHeight = height;
      actualWidth = width; overflowing = width > room.width || height > visibleHeight; update(); applyPane();
    }
    if (divider) {
      let resizing = null;
      divider.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        divider.focus?.();
        const axis = direction(), rect = side.getBoundingClientRect();
        resizing = { id: event.pointerId, axis, start: axis === 'landscape' ? event.clientX : event.clientY,
          size: axis === 'landscape' ? rect.width : rect.height };
        divider.setPointerCapture?.(event.pointerId); app.classList.add('board-pane-resizing'); event.preventDefault();
      });
      divider.addEventListener('pointermove', event => {
        if (!resizing || event.pointerId !== resizing.id) return;
        if (direction() !== resizing.axis) { resizing = null; app.classList.remove('board-pane-resizing'); return; }
        const coordinate = resizing.axis === 'landscape' ? event.clientX : event.clientY;
        setPanePixels(resizing.size - (coordinate - resizing.start)); event.preventDefault();
      });
      const endResize = event => { if (resizing && event.pointerId === resizing.id) { resizing = null; app.classList.remove('board-pane-resizing'); } };
      divider.addEventListener('pointerup', endResize); divider.addEventListener('pointercancel', endResize);
      divider.addEventListener('lostpointercapture', endResize);
      divider.addEventListener('dblclick', resetLayout);
      divider.addEventListener('keydown', event => {
        const axis = direction(), rect = side.getBoundingClientRect(), current = axis === 'landscape' ? rect.width : rect.height;
        const step = event.shiftKey ? 50 : 10, smaller = axis === 'landscape' ? 'ArrowRight' : 'ArrowDown', larger = axis === 'landscape' ? 'ArrowLeft' : 'ArrowUp';
        if (event.key === larger) setPanePixels(current + step);
        else if (event.key === smaller) setPanePixels(current - step);
        else if (event.key === 'Home') setPanePixels(null);
        else return;
        event.preventDefault();
      });
      root.addEventListener('resize', () => { applyPane(); onChange(); });
      root.visualViewport?.addEventListener('resize', () => { applyPane(); onChange(); });
      if (root.ResizeObserver && root.requestAnimationFrame) {
        let pending = false;
        const observer = new root.ResizeObserver(() => {
          if (pending) return; pending = true;
          root.requestAnimationFrame(() => { pending = false; applyPane(); onChange(); });
        });
        observer.observe(wrap); observer.observe(controls); if (top) observer.observe(top);
      }
    }
    applyPane(); update();
    const api = { get scale() { return percent / 100; }, get percent() { return percent; }, setPercent,
      get boardPixels() { return boardPixels; }, get panePixels() { return panes[direction()]; }, setBoardPixels, setPanePixels, resetLayout,
      widthFor: autoWidth => boardPixels ?? autoWidth * percent / 100, available, resized,
      isTap: event => Boolean(lastTap && lastTap.event === event && lastTap.ok) };
    mounted.set(canvas, api); return api;
  }
  root.BoardView = { mount };
})(window);
