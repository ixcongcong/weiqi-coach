/* 左上角“三条线”菜单：在围棋、中国象棋、国际象棋之间切换。围棋、象棋页面共用。 */
(function () {
  'use strict';
  const GAMES = [
    { id: 'go', name: '围棋', url: 'index.html', note: '对战 · 《弈》课程 · 棋谱 · 练习' },
    { id: 'xiangqi', name: '中国象棋', url: 'cc.html?g=xiangqi', note: '规则入门 · 杀法 · 开局 · 对战' },
    { id: 'chess', name: '国际象棋', url: 'cc.html?g=chess', note: '规则入门 · 战术 · 名局 · 对战' },
  ];
  const cur = document.documentElement.dataset.game || 'go';
  const top = document.getElementById('top');
  if (!top) return;
  const btn = document.createElement('button');
  btn.id = 'btnMenu';
  btn.className = 'small';
  btn.setAttribute('aria-label', '菜单');
  btn.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  top.insertBefore(btn, top.firstChild);
  const shade = document.createElement('div');
  shade.id = 'menuShade';
  shade.hidden = true;
  shade.innerHTML = `<nav id="menuPanel" aria-label="切换棋类">
    <div class="menu-title">弈 · 棋类</div>
    ${GAMES.map(g => `<a href="${g.url}" class="menu-item${g.id === cur ? ' on' : ''}"><b>${g.name}</b><span>${g.note}</span></a>`).join('')}
    <p class="note">每种棋的学习进度、对局都分开保存在这台设备上。</p>
  </nav>`;
  document.body.appendChild(shade);
  const open = v => { shade.hidden = !v; };
  btn.addEventListener('click', () => open(true));
  shade.addEventListener('click', e => { if (e.target === shade) open(false); });
  shade.addEventListener('click', e => {
    const a = e.target.closest('a.menu-item');
    if (a && a.classList.contains('on')) { e.preventDefault(); open(false); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
})();
