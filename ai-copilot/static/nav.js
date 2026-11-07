/* 左侧菜单栏：统一各页面的导航，按角色隐藏入口。
   页面只需 <body class="app-shell">，再引入 nav.css + nav.js。
   登录页 / 移动端 H5 不加 app-shell，保持原样。 */
(function () {
  'use strict';

  // 中文产品名。改名只动这里（浏览器标题在各自页面的 <title> 里）。
  var BRAND = '智单';
  var TAGLINE = '托书 · 发票 · 对账 · 结算';
  var LOGO_CHAR = '智';

  var GROUPS = [
    {
      title: '工作台',
      items: [{ href: '/', label: '托书录入' }]
    },
    {
      title: '单证',
      items: [
        { href: '/invoice', label: '发票识别' },
        { href: '/batch', label: '批量导入' },
        { href: '/history', label: '确认历史', roles: ['admin'] }
      ]
    },
    {
      title: '对账与结算',
      items: [
        { href: '/reconcile', label: '自动对账' },
        { href: '/pilot', label: '对账复核' },
        { href: '/threeway', label: '三单匹配' },
        { href: '/settlement', label: '外协结算' },
        { href: '/fees', label: '异常费用', roles: ['admin', 'finance'] }
      ]
    },
    {
      title: '应收',
      items: [{ href: '/aging', label: '账龄催收' }]
    },
    {
      title: '数据与设置',
      items: [
        { href: '/learn', label: '学习队列', roles: ['admin', 'operator', 'finance'] },
        { href: '/settings', label: '阈值配置', roles: ['admin'] },
        { href: '/users', label: '用户管理', roles: ['admin'] },
        { href: '/report', label: '运行月报' },
        { href: '/demo', label: '一键演示' }
      ]
    }
  ];

  function normPath(p) {
    p = (p || '/').split('?')[0].split('#')[0];
    p = p.replace(/\/index\.html$/, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildNav() {
    var here = normPath(location.pathname);

    var aside = el('aside');
    aside.id = 'appnav';
    aside.setAttribute('aria-label', '主导航');

    var brand = el('div', 'brand');
    brand.appendChild(el('div', 'logo', LOGO_CHAR));
    var brandText = el('div');
    brandText.appendChild(el('b', null, BRAND));
    brandText.appendChild(el('span', null, TAGLINE));
    brand.appendChild(brandText);
    aside.appendChild(brand);

    var menu = el('nav', 'menu');
    var linksByHref = {};

    GROUPS.forEach(function (group) {
      var box = el('div', 'grp');
      box.appendChild(el('h4', null, group.title));
      group.items.forEach(function (item) {
        var a = el('a', 'item');
        a.href = item.href;
        a.textContent = item.label;
        if (item.roles) a.dataset.roles = item.roles.join(',');
        if (here === item.href) {
          a.classList.add('on');
          a.setAttribute('aria-current', 'page');
        }
        box.appendChild(a);
        linksByHref[item.href] = a;
      });
      menu.appendChild(box);
    });
    aside.appendChild(menu);

    // 底部：演示环境说明 + 当前用户（首页头部已有用户信息，不重复）
    var foot = el('div', 'foot');
    foot.id = 'navFoot';
    foot.appendChild(el('div', null, '演示环境 · 数据为合成样本'));
    if (here !== '/') {
      var me = el('div', 'me');
      me.id = 'navMe';
      me.style.display = 'none';
      foot.appendChild(me);
      var out = el('a', null, '退出登录');
      out.href = '#';
      out.id = 'navLogout';
      out.style.display = 'none';
      out.addEventListener('click', function (e) {
        e.preventDefault();
        fetch('/api/auth/logout', { method: 'POST' }).finally(function () {
          location.href = '/login';
        });
      });
      foot.appendChild(out);
    }
    aside.appendChild(foot);

    document.body.insertBefore(aside, document.body.firstChild);

    // 窄屏抽屉
    var mask = el('div');
    mask.id = 'navMask';
    mask.addEventListener('click', function () {
      document.body.classList.remove('nav-open');
    });
    document.body.appendChild(mask);

    var toggle = el('button');
    toggle.id = 'navToggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '展开菜单');
    toggle.textContent = '☰';
    toggle.addEventListener('click', function () {
      document.body.classList.toggle('nav-open');
    });
    document.body.appendChild(toggle);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.body.classList.remove('nav-open');
    });

    return linksByHref;
  }

  function applyRole(linksByHref, me) {
    if (!me || !me.role) return;
    Object.keys(linksByHref).forEach(function (href) {
      var a = linksByHref[href];
      var roles = a.dataset.roles;
      if (!roles) return;
      if (roles.split(',').indexOf(me.role) < 0) a.style.display = 'none';
    });
    // 整组都被隐藏时，连组标题一起收起来
    Array.prototype.forEach.call(document.querySelectorAll('#appnav .grp'), function (g) {
      var visible = g.querySelectorAll('a.item:not([style*="display: none"])').length;
      if (!visible) g.style.display = 'none';
    });
    var me2 = document.getElementById('navMe');
    var out = document.getElementById('navLogout');
    if (me2) {
      me2.textContent = me.name || me.email || '';
      var sub = el('span', null, me.role_label || me.role);
      me2.appendChild(sub);
      me2.style.display = '';
    }
    if (out) out.style.display = '';
  }

  function init() {
    if (!document.body.classList.contains('app-shell')) return;
    var links = buildNav();
    fetch('/api/me', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (me) {
        applyRole(links, me);
      })
      .catch(function () {
        /* 取不到角色时不隐藏，交给服务端鉴权 */
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
