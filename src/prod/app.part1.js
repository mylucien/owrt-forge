/* ============================================================
   固件工坊 owrt-forge · 前端
   纯原生 JS，无构建依赖；由 tools 注入 Worker 的 APP_JS
   ============================================================ */

/* ---------------- 图标 ---------------- */
const P = {
  layers: '<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 17 9 4.5 9-4.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  pulse: '<path d="M3 12h3.5l2.5-7 4 14 2.5-7H21"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h5M13 17h7"/><circle cx="15" cy="7" r="2"/><circle cx="11" cy="17" r="2"/>',
  check: '<path d="m4 12.5 5 5L20 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  play: '<path d="M7 4.5v15l13-7.5-13-7.5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 10 2.5 2L7 14M12.5 14H16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2.5 2.5 0 0 0-2.5 2.5V12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  trash: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  box: '<path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
  save: '<path d="M5 4h11l3 3v13H5V4Z"/><path d="M8 4v5h7"/><path d="M8 15h8"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 3-3 3.5-6 4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  zap: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
  filter: '<path d="M4 5h16l-6.5 7.5V19l-3 1.5v-8L4 5Z"/>',
  logout: '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M18 12H9m9 0-3-3m3 3-3 3"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6v.01M4 12v.01M4 18v.01"/>',
  edit: '<path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  rocket: '<path d="M5 15c-1 2-1 5-1 5s3 0 5-1"/><path d="M9 15 5 11c0-6 5-8 12-8 0 7-2 12-8 12Z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  git: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 2.8-2.6 3.6-6 3.8"/>',
};
function ic(n, cls) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') + '>' + (P[n] || '') + '</svg>';
}

/* ---------------- API ---------------- */
const api = {
  async _req(method, path, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const resp = await fetch(path, opt);
    let data = null;
    try { data = await resp.json(); } catch (e) { /* 空响应 */ }
    if (!resp.ok) {
      const msg = (data && data.error) || ('请求失败 (' + resp.status + ')');
      const e = new Error(msg); e.status = resp.status; throw e;
    }
    return data;
  },
  get(p) { return this._req('GET', p); },
  post(p, b) { return this._req('POST', p, b === undefined ? {} : b); },
  put(p, b) { return this._req('PUT', p, b === undefined ? {} : b); },
  patch(p, b) { return this._req('PATCH', p, b); },
  del(p) { return this._req('DELETE', p); },
  login(pw) { return this.post('/api/login', { password: pw }); },
  logout() { return this.post('/api/logout'); },
  setupStatus() { return this.get('/api/setup/status'); },
  setupInit(pw, pw2) { return this.post('/api/setup/init', { password: pw, confirm_password: pw2 }); },
  setupWizard(body) { return this.post('/api/setup/wizard', body); },
  settings() { return this.get('/api/settings'); },
  resetToken() { return this.post('/api/settings/report-token/reset'); },
  resetSettings(scope) { return this.post('/api/settings/reset', { scope }); },
  templates() { return this.get('/api/templates'); },
  template(id) { return this.get('/api/templates/' + id); },
  createTemplate(b) { return this.post('/api/templates', b); },
  updateTemplate(id, b) { return this.put('/api/templates/' + id, b); },
  deleteTemplate(id) { return this.del('/api/templates/' + id); },
  history(id) { return this.get('/api/templates/' + id + '/dotconfig/history'); },
  historyVersion(id, vid) { return this.get('/api/templates/' + id + '/dotconfig/history/' + vid); },
  importTemplate(b) { return this.post('/api/templates/import', b); },
  uploadDotconfig(id, b) { return this.post('/api/templates/' + id + '/dotconfig/upload', b); },
  setCurrentDotconfig(id, vid) { return this.put('/api/templates/' + id + '/dotconfig/current', { version_id: vid }); },
  patchLabel(id, vid, label) { return this.patch('/api/templates/' + id + '/dotconfig/history/' + vid, { label: label }); },
  deleteVersion(id, vid) { return this.del('/api/templates/' + id + '/dotconfig/history/' + vid); },
  setSchedule(id, b) { return this.put('/api/templates/' + id + '/schedule', b); },
  builds() { return this.get('/api/builds'); },
  build(id) { return this.get('/api/builds/' + id); },
  caches() { return this.get('/api/caches'); },
  trigger(id) { return this.post('/api/trigger', { template_id: id }); },
  cancel(id) { return this.post('/api/builds/' + id + '/cancel'); },
  setCachePublish(id, enabled) { return this.post('/api/builds/' + id + '/cache-publish', { enabled: enabled }); },
  catalog(force) { return this.get('/api/catalog' + (force ? '?refresh=1' : '')); },
  projects() { return this.get('/api/projects'); },
  addProject(b) { return this.post('/api/projects', b); },
  delProject(id) { return this.del('/api/projects/' + id); },
  platforms(pid, force) { return this.get('/api/platforms?project=' + encodeURIComponent(pid) + (force ? '&refresh=1' : '')); },
  platform(pid, target, force) { return this.get('/api/platform?project=' + encodeURIComponent(pid) + '&target=' + encodeURIComponent(target) + (force ? '&refresh=1' : '')); },
  customPlugins() { return this.get('/api/custom-plugins'); },
  detectPlugin(b) { return this.post('/api/custom-plugins/detect', b); },
  addCustomPlugin(b) { return this.post('/api/custom-plugins', b); },
  delCustomPlugin(id) { return this.del('/api/custom-plugins/' + encodeURIComponent(id)); },
};

/* ---------------- 状态 ---------------- */
const S = {
  authed: false,
  status: 'ready',
  route: { name: 'templates', params: {} },
  theme: 'light',
  templates: [],
  builds: [],
  catalog: [],
  cats: ['全部'],
  kw: {},
  meta: '',
  loaded: false,
  projects: [],
  pi: 0,
  target: 'x86',
  sub: '64',
  profile: 'generic',
  plat: { status: 'none', list: [], err: '', fetched: '' },
  cur: { id: '', subs: [], status: 'none', err: '', fetched: '' },
  sel: new Set(['luci-app-store']),
  cat: '全部',
  q: '',
  only: false,
  limit: 48,
  devQ: '',
  editId: null,
  tplName: '',
  nameDirty: false,
  stale: [],
  busy: false,
  seq: 0,
  bfilter: 'all',
  poll: null,
  tick: 0,
};

const SOURCE_LABELS = { manual_upload: '手动上传', menuconfig_push: 'menuconfig 推送', imported: '导入' };
const ST = {
  queued: { cls: 'warn', t: '排队等待' },
  pending: { cls: 'warn', t: '排队中' },
  running: { cls: 'run', t: '准备中' },
  menuconfig: { cls: 'run', t: '配置中' },
  compiling: { cls: 'run', t: '编译中' },
  success: { cls: 'ok', t: '成功' },
  failed: { cls: 'bad', t: '失败' },
  cancelled: { cls: 'plain', t: '已取消' },
  never: { cls: 'plain', t: '未编译' },
};
const ACTIVE = ['queued', 'pending', 'running', 'menuconfig', 'compiling'];
const CRON_PRESETS = [
  { label: '每天 02:00 UTC', cron: '0 2 * * *' },
  { label: '每天 12:00 UTC', cron: '0 12 * * *' },
  { label: '每周六 14:00 UTC', cron: '0 14 * * 6' },
];
const PRESETS = {
  '旁路由': ['luci-app-store', 'luci-app-passwall', 'luci-app-smartdns', 'luci-app-ttyd'],
  '家庭全能': ['luci-app-store', 'luci-app-openclash', 'luci-app-adblock-fast', 'luci-app-samba4', 'luci-app-qbittorrent', 'luci-app-ddns-go', 'luci-app-upnp', 'luci-theme-argon'],
  '极简': ['luci-app-store', 'luci-theme-argon', 'luci-app-ttyd'],
};
const CAT_COLORS = {
  '代理': ['#3b5bdb', '#eef1ff', '#93a7ff'],
  'DNS 与广告': ['#0b7285', '#e6f6fa', '#5fd0e3'],
  '网络': ['#1861b8', '#e8f1fd', '#74b3f7'],
  'VPN 与穿透': ['#5f3dc4', '#f0ecfe', '#b3a0ff'],
  '服务': ['#495468', '#eef0f6', '#a9b4c8'],
  '存储': ['#a8620a', '#fdf2e2', '#e8b871'],
  '下载': ['#c2410c', '#fdefe7', '#f79c72'],
  '容器': ['#1c5bd6', '#e7f1fe', '#79a8ff'],
  '监控': ['#0f8a5f', '#e6f7ef', '#54d3a3'],
  '多媒体': ['#a61e6b', '#fdecf4', '#f28cc4'],
  '系统': ['#0b6e68', '#e6f5f4', '#5cd0c8'],
  '协议': ['#556b2f', '#f0f5e7', '#a9c37a'],
  '主题': ['#a61232', '#fdebed', '#f58fa0'],
  '自定义': ['#6b4fbb', '#f2eefc', '#b9a6f2'],
};

/* ---------------- 工具 ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isDark = () => S.theme === 'dark';
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtRel(ts) {
  if (!ts) return '—';
  const m = Math.floor((Date.now() - Number(ts)) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  if (m < 1440) return Math.floor(m / 60) + ' 小时前';
  return fmtTime(ts);
}
function fmtDur(a, b) {
  if (!a || !b) return '—';
  const s = Math.max(0, Math.round((Number(b) - Number(a)) / 1000));
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分 ' + pad2(s % 60) + ' 秒';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (!n) return '—';
  return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB';
}
function catTriple(cat) { return CAT_COLORS[cat] || ['#4b5468', '#eef0f6', '#a9b4c8']; }
function catStyle(cat) {
  const c = catTriple(cat);
  return 'background:' + (isDark() ? c[2] + '26' : c[1]) + ';color:' + (isDark() ? c[2] : c[0]);
}
function catFg(cat) { return isDark() ? catTriple(cat)[2] : catTriple(cat)[0]; }
function pluginById(id) { for (let i = 0; i < S.catalog.length; i++) if (S.catalog[i].id === id) return S.catalog[i]; return null; }
function tplById(id) { for (let i = 0; i < S.templates.length; i++) if (S.templates[i].id === id) return S.templates[i]; return null; }
function activeBuilds() { return S.builds.filter((b) => ACTIVE.indexOf(b.status) >= 0); }
function lastBuildOf(tplId) { for (let i = 0; i < S.builds.length; i++) if (S.builds[i].template_id === tplId) return S.builds[i]; return null; }
function nav(hash) { if (location.hash === hash) { S.route = parseHash(); render(); } else location.hash = hash; }

function toast(title, sub, kind) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const g = kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check';
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'err' ? 'err' : kind === 'info' ? 'info' : '');
  el.innerHTML = '<span class="g">' + ic(g) + '</span><div><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>';
  wrap.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(function () { el.remove(); }, 220);
  }, 3600);
}
function fail(e, fallback) { toast((e && e.message) || fallback || '操作失败', '', 'err'); }

/* ---------------- 弹窗 ---------------- */
function openModal(html, opt) {
  opt = opt || {};
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) closeModal(overlay); });
  const onKey = function (ev) { if (ev.key === 'Escape') closeModal(overlay); };
  document.addEventListener('keydown', onKey);
  overlay._key = onKey;
  $$('[data-close]', overlay).forEach(function (b) { b.addEventListener('click', function () { closeModal(overlay); }); });
  if (opt.onMount) opt.onMount(overlay);
  return overlay;
}
function closeModal(overlay) {
  if (!overlay) return;
  document.removeEventListener('keydown', overlay._key);
  overlay.remove();
}
function confirmBox(o) {
  return new Promise(function (resolve) {
    const overlay = openModal(
      '<div class="modal" style="max-width:430px">' +
        '<div class="modal-head"><h3>' + esc(o.title) + '</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
        '<div class="modal-body"><p style="margin:0;font-size:13px;line-height:1.65;color:var(--ink-2)">' + esc(o.body) + '</p>' +
        (o.hint ? '<div class="note">' + ic('alert') + '<span>' + esc(o.hint) + '</span></div>' : '') + '</div>' +
        '<div class="modal-foot"><button data-close>取消</button><button class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" id="cf-ok">' + esc(o.ok || '确定') + '</button></div>' +
      '</div>'
    );
    $('#cf-ok', overlay).addEventListener('click', function () { closeModal(overlay); resolve(true); });
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) resolve(false); });
    $$('[data-close]', overlay).forEach(function (b) { b.addEventListener('click', function () { resolve(false); }); });
    document.addEventListener('keydown', function k(ev) {
      if (!document.body.contains(overlay)) { document.removeEventListener('keydown', k); return; }
      if (ev.key === 'Escape') { resolve(false); document.removeEventListener('keydown', k); }
    });
  });
}

/* ---------------- 路由 ---------------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const p = h.split('/').filter(Boolean);
  if (!p.length) return { name: 'templates', params: {} };
  if ((p[0] === 'template' || p[0] === 'trigger') && p[1]) return { name: 'template', params: { id: p[1] } };
  if (p[0] === 'store') return { name: 'store', params: { tpl: p[1] || '' } };
  if (p[0] === 'builds') return { name: 'builds', params: {} };
  if (p[0] === 'settings') return { name: 'settings', params: {} };
  if (p[0] === 'templates') return { name: 'templates', params: {} };
  return { name: 'templates', params: {} };
}

/* ---------------- 主题 ---------------- */
function applyTheme() {
  document.body.setAttribute('data-theme', S.theme);
}
function toggleTheme() {
  S.theme = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('owf-theme', S.theme); } catch (e) { /* 隐私模式 */ }
  applyTheme();
  document.querySelectorAll('[data-theme-label]').forEach(function (n) { n.textContent = isDark() ? '浅色' : '深色'; });
  document.querySelectorAll('[data-theme-icon]').forEach(function (n) { n.innerHTML = ic(isDark() ? 'sun' : 'moon'); });
  const btn = $('#themeBtn');
  if (btn) btn.innerHTML = ic(isDark() ? 'sun' : 'moon') + '<span data-theme-label>' + (isDark() ? '浅色' : '深色') + '</span>';
  const cur = S.route;
  if (cur.name === 'store' && $('#st-grid')) { drawGrid(); drawBasket(); }
}

/* ---------------- 骨架 ---------------- */
function shell(active) {
  const act = activeBuilds().length;
  return '<div class="app">' +
    '<aside class="side">' +
      '<div class="brand"><span class="brand-mark">' + ic('zap') + '</span><span class="brand-txt"><b>固件工坊</b><small>owrt-forge</small></span></div>' +
      '<nav class="nav">' +
        '<div class="nav-label">工作区</div>' +
        navItem('templates', '模板', 'layers', active === 'templates' || active === 'template') +
        navItem('store', '插件商店', 'grid', active === 'store') +
        navItem('builds', '编译记录', 'pulse', active === 'builds', act) +
        '<div class="nav-label">系统</div>' +
        navItem('settings', '设置', 'sliders', active === 'settings') +
      '</nav>' +
      '<div class="side-foot">' +
        '<div class="queue card" id="queueCard"></div>' +
        '<div class="side-actions">' +
          '<button class="btn btn-sm" id="themeBtn">' + ic(isDark() ? 'sun' : 'moon') + '<span data-theme-label>' + (isDark() ? '浅色' : '深色') + '</span></button>' +
          '<button class="btn btn-sm btn-icon" id="logoutBtn" title="退出登录">' + ic('logout') + '</button>' +
        '</div>' +
      '</div>' +
    '</aside>' +
    '<main class="main"><div class="main-inner" id="view"></div></main>' +
  '</div>';
}
function navItem(route, label, icon, on, badge) {
  return '<a class="nav-item' + (on ? ' active' : '') + '" data-nav="' + route + '" href="#/' + route + '">' +
    ic(icon) + '<span class="t">' + label + '</span>' +
    (badge ? '<span class="nav-badge">' + badge + '</span>' : '') + '</a>';
}
function drawQueue() {
  const box = $('#queueCard');
  if (!box) return;
  const list = activeBuilds();
  const b = list[0];
  if (b) {
    const t = tplById(b.template_id);
    const st = ST[b.status] || ST.pending;
    const mins = Math.max(1, Math.floor((Date.now() - Number(b.created_at)) / 60000));
    box.innerHTML = '<div class="queue-head"><span class="spinner-dot"></span>编译中' + (list.length > 1 ? ' · 排队 ' + (list.length - 1) : '') + '</div>' +
      '<div class="queue-body"><div class="queue-name">' + esc(t ? t.name : '已删除的模板') + '</div>' +
      '<div class="queue-sub">' + esc(st.t) + ' · 已用 ' + mins + ' 分</div>' +
      '<div class="queue-bar"><i style="width:' + (b.status === 'compiling' ? 72 : b.status === 'menuconfig' ? 45 : 22) + '%"></i></div></div>';
    box.onclick = function () { nav('#/builds'); };
    box.hidden = false;
    return;
  }
  const last = S.builds[0];
  box.hidden = false;
  if (!last) {
    box.innerHTML = '<div class="queue-head">空闲</div><div class="queue-body"><div class="queue-sub" style="margin:0">还没有编译记录</div></div>';
    box.onclick = function () { nav('#/builds'); };
    return;
  }
  const st = ST[last.status] || ST.never;
  const t = tplById(last.template_id);
  box.innerHTML = '<div class="queue-head">上一次编译</div><div class="queue-body">' +
    '<div class="queue-name">' + esc(t ? t.name : '已删除的模板') + '</div>' +
    '<div class="queue-sub" style="margin:0"><span class="pill ' + st.cls + '">' + st.t + '</span> ' + fmtRel(last.created_at) + '</div></div>';
  box.onclick = function () { nav('#/builds'); };
}
function mountShell(active) {
  const app = $('#app');
  app.innerHTML = shell(active);
  $$('[data-nav]').forEach(function (a) {
    a.addEventListener('click', function (ev) { ev.preventDefault(); nav(a.dataset.nav === 'store' ? '#/store' : '#/' + a.dataset.nav); });
  });
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#logoutBtn').addEventListener('click', doLogout);
  drawQueue();
}
async function doLogout() {
  const ok = await confirmBox({ title: '退出登录', body: '退出后需要重新输入访问密码。', ok: '退出' });
  if (!ok) return;
  try { await api.logout(); } catch (e) { /* 忽略 */ }
  S.authed = false;
  S.status = 'ready';
  stopPoll();
  renderAuth('login');
}

/* ---------------- 登录 / 初始化 / 向导 ---------------- */
function authFrame(inner) {
  return '<div class="auth">' +
    '<div class="auth-card">' +
      '<div class="auth-art">' +
        '<div class="auth-logo">' + ic('zap') + '</div>' +
        '<div class="auth-art-t">固件工坊</div>' +
        '<div class="auth-art-s">owrt-forge · OpenWrt 云编译控制台</div>' +
        '<ul class="auth-points">' +
          '<li>' + ic('check') + '<span>插件商店式选型，改配置不用碰命令行</span></li>' +
          '<li>' + ic('check') + '<span>编译前校验机型与插件，失败原因直接说明白</span></li>' +
          '<li>' + ic('check') + '<span>ccache 缓存与定时编译，重复的活交给机器</span></li>' +
        '</ul>' +
      '</div>' +
      '<div class="auth-form">' + inner + '</div>' +
    '</div>' +
  '</div>';
}
function renderAuth(kind, opt) {
  opt = opt || {};
  const app = $('#app');
  if (kind === 'init') {
    app.innerHTML = authFrame(
      '<h1>初始化系统</h1><p class="auth-sub">还没有设置访问密码，先设置一个再开始。</p>' +
      '<form id="authForm"><div class="field"><label>访问密码</label><input class="input" type="password" id="pw" minlength="6" autocomplete="new-password" autofocus placeholder="至少 6 位" /></div>' +
      '<div class="field"><label>确认密码</label><input class="input" type="password" id="pw2" minlength="6" autocomplete="new-password" placeholder="再输一次" /></div>' +
      '<div class="auth-err" id="authErr" hidden></div>' +
      '<button class="btn btn-primary btn-lg btn-block" id="authBtn" type="submit">创建密码并继续</button></form>' +
      '<div class="auth-foot">密码只用于登录这个网页后台，保存在你自己的 D1 数据库里。</div>'
    );
    $('#authForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      const pw = $('#pw').value, pw2 = $('#pw2').value;
      const err = $('#authErr'), btn = $('#authBtn');
      err.hidden = true;
      if (pw !== pw2) { err.textContent = '两次输入的密码不一致'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = '创建中…';
      try {
        await api.setupInit(pw, pw2);
        S.authed = true; S.status = 'wizard';
        renderAuth('wizard');
      } catch (e) {
        err.textContent = e.message || '初始化失败'; err.hidden = false;
        btn.disabled = false; btn.textContent = '创建密码并继续';
      }
    });
    return;
  }
  if (kind === 'wizard') {
    app.innerHTML = authFrame(
      '<h1>连接 GitHub</h1><p class="auth-sub">最后一步：告诉 Worker 用哪个仓库跑编译。</p>' +
      '<form id="authForm">' +
        '<div class="field"><label>Worker URL</label><input class="input mono" type="url" id="wzUrl" required /></div>' +
        '<div class="field"><label>编译仓库</label><input class="input mono" type="text" id="wzRepo" placeholder="owner/repo" required /><div class="hint">放有 build-openwrt.yml 的那个公开仓库</div></div>' +
        '<div class="field"><label>GitHub Token</label><input class="input mono" type="password" id="wzToken" placeholder="ghp_…" autocomplete="off" required /><div class="hint">需要目标仓库的 repo 权限，用于触发 repository_dispatch</div></div>' +
        (opt.reconfigure ? '<div class="note">' + ic('info') + '<span>重新配置时 Token 可以留空，表示沿用已保存的那个。</span></div>' : '') +
        '<div class="auth-err" id="authErr" hidden></div>' +
        '<button class="btn btn-primary btn-lg btn-block" id="authBtn" type="submit">保存并生成 REPORT_TOKEN</button>' +
        (opt.reconfigure ? '<button class="btn btn-block" type="button" id="wzCancel" style="margin-top:8px">取消，返回</button>' : '') +
      '</form>' +
      '<div id="wzDone" hidden></div>'
    );
    $('#wzUrl').value = location.origin;
    if (opt.reconfigure) {
      api.settings().then(function (s) {
        if (s.worker_url) $('#wzUrl').value = s.worker_url;
        if (s.github_repo) $('#wzRepo').value = s.github_repo;
      }).catch(function () { });
      $('#wzCancel').addEventListener('click', function () { nav('#/templates'); bootData(); });
    }
    $('#authForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      const err = $('#authErr'), btn = $('#authBtn');
      err.hidden = true;
      const token = $('#wzToken').value.trim();
      if (!token && !opt.reconfigure) { err.textContent = '请填写 GitHub Token'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        const r = await api.setupWizard({
          worker_url: $('#wzUrl').value.trim(), github_repo: $('#wzRepo').value.trim(),
          github_token: token, keep_existing_token: !!opt.reconfigure && !token,
        });
        $('#authForm').hidden = true;
        const done = $('#wzDone');
        done.hidden = false;
        done.innerHTML = '<div class="auth-done"><div class="auth-ok">' + ic('check') + '</div><h2>还差一条 Secret</h2>' +
          '<p class="auth-sub">去 GitHub 仓库 → Settings → Secrets and variables → Actions，新建 <code>REPORT_TOKEN</code>，值就是下面这串。关掉页面后不再显示明文。</p>' +
          '<div class="token-box"><code id="wzTok">' + esc(r.report_token) + '</code><button class="btn btn-sm" id="wzCopy">' + ic('copy') + '复制</button></div>' +
          '<button class="btn btn-primary btn-lg btn-block" id="wzGo" style="margin-top:14px">已添加，进入控制台</button></div>';
        $('#wzCopy').addEventListener('click', function () { copyText(r.report_token); });
        $('#wzGo').addEventListener('click', function () { S.status = 'ready'; nav('#/templates'); bootData(); });
      } catch (e) {
        err.textContent = e.message || '保存失败'; err.hidden = false;
        btn.disabled = false; btn.textContent = '保存并生成 REPORT_TOKEN';
      }
    });
    return;
  }
  app.innerHTML = authFrame(
    '<h1>登录</h1><p class="auth-sub">输入访问密码进入控制台。</p>' +
    '<form id="authForm"><div class="field"><label>访问密码</label><input class="input" type="password" id="pw" autocomplete="current-password" autofocus required /></div>' +
    '<div class="auth-err" id="authErr" hidden></div>' +
    '<button class="btn btn-primary btn-lg btn-block" id="authBtn" type="submit">' + ic('lock') + '登录</button></form>' +
    '<div class="auth-foot">固件由 GitHub Actions 编译，Worker 只负责排队和记录。</div>'
  );
  $('#authForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const err = $('#authErr'), btn = $('#authBtn');
    err.hidden = true;
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>登录中…';
    try {
      await api.login($('#pw').value);
      S.authed = true;
      const st = await api.setupStatus().catch(function () { return { status: 'ready' }; });
      S.status = st.status;
      if (S.status === 'ready') { nav('#/templates'); bootData(); }
      else renderAuth('wizard');
    } catch (e) {
      err.textContent = e.message || '登录失败'; err.hidden = false;
      btn.disabled = false; btn.innerHTML = ic('lock') + '登录';
    }
  });
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('已复制到剪贴板'); }
  catch (e) { toast('复制失败，请手动选中', '', 'err'); }
}
