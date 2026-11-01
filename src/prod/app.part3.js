/* ============================================================
   插件商店 / 编译记录 / 设置 / 启动
   ============================================================ */

/* ---------------- 目录 ---------------- */
async function ensureCatalog(force) {
  if (S.loaded && !force) return;
  applyCatalog(await api.catalog(force));
}
function applyCatalog(d) {
  S.catalog = (d.plugins || []).filter(function (p) { return !p.hidden; });
  S.kw = {};
  (d.categories || []).forEach(function (c) { S.kw[c.id] = c.keywords || ''; });
  S.cats = ['全部'].concat((d.categories || []).slice().sort(function (a, b) { return a.order - b.order; }).map(function (c) { return c.id; })
    .filter(function (c) { return S.catalog.some(function (p) { return p.cat === c; }); }));
  S.stale.forEach(function (p) {
    if (!pluginById(p.id)) S.catalog.push(p);
    if (S.cats.indexOf(p.cat) < 0) S.cats.push(p.cat);
  });
  S.meta = '目录更新于 ' + (d.updated || '未知') + ' · ' + (d.source === 'remote' ? '来自仓库 catalog.json' : '内置目录') + ' · ' + S.catalog.length + ' 个插件';
  S.loaded = true;
}
function synthPlugin(id, plugins) {
  let origin = { type: 'builtin' };
  (plugins || []).forEach(function (p) {
    if (p.feed) return;
    const dirs = p.dirs || [];
    if (p.sparse && dirs.some(function (d) { return d.split('/').pop() === id; })) {
      origin = { type: 'git', name: id, url: p.git_url, branch: p.branch || '', sparse: true, dirs: dirs.filter(function (d) { return d.split('/').pop() === id; }) };
    } else if (!p.sparse && p.name === id) {
      origin = { type: 'git', name: id, url: p.git_url, branch: p.branch || '', sparse: false, dirs: [] };
    }
  });
  return {
    id: id, name: id, desc: origin.type === 'builtin' ? '目录里已经没有这一项，仍会按包名尝试启用。' : '模板里保存的第三方插件，不在当前目录里。',
    cat: '自定义', kind: 'app', origin: origin, deps: [], requires: [], size_mb: null, rec: false, tut: '', tags: [], hidden: false,
    custom: origin.type !== 'builtin', stale: true,
  };
}
function pluginOrigin(p) {
  const o = p.origin || { type: 'builtin' };
  if (o.type === 'git') return { name: o.name, git_url: o.url, sparse: !!o.sparse, branch: o.branch || '', dirs: o.dirs || [] };
  if (o.type === 'feed') return { name: o.name, feed: o.line };
  return null;
}
function mergePlugins(list) {
  const out = [], idx = {};
  list.forEach(function (p) {
    const o = pluginOrigin(p);
    if (!o) return;
    if (o.feed) { if (!idx['f|' + o.feed]) { idx['f|' + o.feed] = o; out.push(o); } return; }
    if (o.sparse) {
      const k = 's|' + o.git_url + '|' + o.branch;
      if (idx[k]) o.dirs.forEach(function (d) { if (idx[k].dirs.indexOf(d) < 0) idx[k].dirs.push(d); });
      else { o.dirs = o.dirs.slice(); idx[k] = o; out.push(o); }
      return;
    }
    if (!idx['g|' + o.git_url + '|' + o.name]) { idx['g|' + o.git_url + '|' + o.name] = o; out.push(o); }
  });
  return out;
}
function selectedPlugins() {
  return Array.from(S.sel).map(function (id) { return pluginById(id); }).filter(Boolean);
}
function projectNow() { return S.projects[S.pi] || S.projects[0]; }
function targetStr() { return S.target && S.sub ? S.target + '/' + S.sub : ''; }
function subsNow() { return S.cur.id === S.target ? S.cur.subs : []; }
function curSub() { return subsNow().filter(function (x) { return x.id === S.sub; })[0]; }
function devicesNow() { const x = curSub(); return x ? x.devices : []; }

function storeReset() {
  S.sel = new Set();
  S.target = 'x86'; S.sub = '64'; S.profile = 'generic'; S.devQ = '';
  S.editId = null; S.tplName = ''; S.nameDirty = false; S.stale = [];
  S.q = ''; S.cat = '全部'; S.only = false; S.limit = 48;
}
async function enterEdit(id) {
  const t = (await api.template(id)).template;
  storeReset();
  S.editId = t.id; S.tplName = t.name; S.nameDirty = true;
  let i = S.projects.findIndex(function (p) { return t.project_id && p.id === t.project_id; });
  if (i < 0) i = S.projects.findIndex(function (p) { return p.repo_url === t.repo_url && p.branch === t.branch; });
  if (i < 0) {
    toast('这个模板用的源码项目已不在列表里', '请重新选择源码、平台和机型', 'err');
    S.target = ''; S.sub = ''; S.profile = '';
  } else {
    S.pi = i;
    const tp = String(t.target || '').split('/');
    S.target = tp[0] || ''; S.sub = tp[1] || ''; S.profile = t.profile || '';
  }
  const ids = (t.selection && t.selection.length) ? t.selection : (t.packages || []).filter(function (x) { return !!pluginById(x); });
  S.sel = new Set(ids);
  ids.forEach(function (x) {
    if (!pluginById(x)) {
      const p = synthPlugin(x, t.plugins);
      S.stale.push(p); S.catalog.push(p);
      if (S.cats.indexOf(p.cat) < 0) S.cats.push(p.cat);
    }
  });
}

/* ---------------- 商店页 ---------------- */
async function viewStore(tplId) {
  const view = $('#view');
  view.innerHTML = '<div class="loading">' + ic('refresh') + '<span>读取插件目录…</span></div>';
  try {
    await ensureCatalog(false);
    const pj = await api.projects();
    S.projects = pj.projects || [];
    if (S.pi >= S.projects.length) S.pi = 0;
    if (tplId) { if (S.editId !== tplId) await enterEdit(tplId); }
    else if (S.editId) storeReset();
  } catch (e) {
    view.innerHTML = '<div class="empty"><div class="g">' + ic('alert') + '</div><div class="m">加载失败</div><div class="s">' + esc(e.message) + '</div></div>';
    return;
  }
  if (S.route.name !== 'store') return;

  const editing = !!S.editId;
  view.innerHTML =
    '<header class="page-head"><div>' +
      (editing ? '<div class="crumbs" style="margin-bottom:8px"><a href="#/template/' + S.editId + '">' + ic('right') + '返回模板</a></div>' : '') +
      '<div class="eyebrow">STORE <b>/</b> ' + (editing ? 'EDIT' : 'SELECT') + '</div>' +
      '<h1>' + (editing ? '编辑机型和插件' : '插件商店') + '</h1>' +
      '<div class="sub">' + (editing ? '改完点右侧「保存到模板」，回到模板页确认后再编译。' : '先定源码和机型，再勾选要编进固件的插件。清单里没有的，可以直接贴 GitHub 地址加进来。') + '</div>' +
    '</div><div class="actions">' +
      '<button class="btn btn-ghost" id="stRefresh">' + ic('refresh') + '刷新目录</button>' +
      '<span class="tag" id="stMeta">' + esc(S.meta) + '</span>' +
    '</div></header>' +
    '<div class="steps fade-up">' +
      '<div class="step" id="step1"><span class="n">1</span>选择机型</div><span class="step-line"></span>' +
      '<div class="step" id="step2"><span class="n">2</span>勾选插件</div><span class="step-line"></span>' +
      '<div class="step" id="step3"><span class="n">3</span>确认并生成</div>' +
    '</div>' +
    '<div class="store-top">' +
      '<div class="field"><label>源码项目</label><select class="select" id="stSrc"></select></div>' +
      '<div class="field"><label>平台</label><select class="select" id="stTgt"></select></div>' +
      '<div class="field"><label>子平台</label><select class="select" id="stSub"></select></div>' +
      '<div class="field"><label>机型</label><select class="select" id="stDev"></select>' +
        '<input class="input" id="stDevQ" type="search" autocomplete="off" placeholder="筛选机型，如 RAX3000M" style="margin-top:6px" /></div>' +
    '</div>' +
    '<div class="hint st-hint" id="stHint"></div>' +
    '<div class="store-layout">' +
      '<section>' +
        '<div class="filter-bar">' +
          '<div class="search">' + ic('search') + '<input class="input" id="stQ" type="search" placeholder="搜索插件名称、包名或说明…" value="' + esc(S.q) + '" /></div>' +
          '<button class="btn" id="stCustom">' + ic('plus') + '自定义插件</button>' +
          '<button class="btn btn-ghost" id="stOnly">' + ic('filter') + '只看已选</button>' +
        '</div>' +
        '<div class="cats" id="stCats"></div>' +
        '<div class="plugins stagger" id="stGrid"></div>' +
        '<div style="text-align:center;margin:14px" id="stMore"></div>' +
      '</section>' +
      '<aside class="basket"><div class="card basket-inner" id="stBasket"></div></aside>' +
    '</div>';

  $('#stRefresh').addEventListener('click', async function (ev) {
    ev.currentTarget.disabled = true;
    try {
      S.loaded = false;
      await ensureCatalog(true);
      $('#stMeta').textContent = S.meta;
      drawCats(); drawGrid(); drawBasket();
      toast('目录已刷新');
    } catch (e) { fail(e, '刷新失败'); }
    ev.currentTarget.disabled = false;
  });
  $('#stCustom').addEventListener('click', customPluginModal);
  $('#stOnly').addEventListener('click', function () { S.only = !S.only; S.limit = 48; drawCats(); drawGrid(); });
  $('#stQ').addEventListener('input', function (ev) { S.q = ev.target.value.trim().toLowerCase(); S.limit = 48; drawGrid(); });
  $('#stDevQ').addEventListener('input', function (ev) { S.devQ = ev.target.value; drawSelects(); });
  $('#stSrc').addEventListener('change', function (ev) {
    if (ev.target.value === 'new') { ev.target.value = String(S.pi); projectModal(); return; }
    S.pi = +ev.target.value;
    loadPlatforms(false);
  });
  $('#stTgt').addEventListener('change', function (ev) {
    S.target = ev.target.value; S.sub = ''; S.profile = ''; S.devQ = '';
    $('#stDevQ').value = '';
    if (S.target) loadPlatform(S.target, false);
    else { S.cur = { id: '', subs: [], status: 'none', err: '', fetched: '' }; drawSelects(); drawHint(); drawBasket(); }
  });
  $('#stSub').addEventListener('change', function (ev) {
    S.sub = ev.target.value; S.profile = ''; S.devQ = '';
    $('#stDevQ').value = '';
    drawSelects(); drawBasket();
  });
  $('#stDev').addEventListener('change', function (ev) { S.profile = ev.target.value; drawSelects(); drawBasket(); });

  drawProjects();
  drawSelects(); drawHint(); drawCats(); drawGrid(); drawBasket();
  loadPlatforms(false);
}

function drawProjects() {
  const sel = $('#stSrc');
  if (!sel) return;
  sel.innerHTML = S.projects.map(function (p, i) {
    return '<option value="' + i + '"' + (i === S.pi ? ' selected' : '') + '>' + esc((p.builtin ? '' : '★ ') + p.name + ' · ' + p.branch) + '</option>';
  }).join('') + '<option value="new">＋ 添加 / 管理自定义项目…</option>';
}
async function loadPlatforms(force) {
  const p = projectNow(), seq = ++S.seq;
  if (!p) return;
  S.plat = { status: 'loading', list: [], err: '', fetched: '' };
  S.cur = { id: '', subs: [], status: 'none', err: '', fetched: '' };
  drawSelects(); drawHint();
  try {
    const d = await api.platforms(p.id, force);
    if (seq !== S.seq) return;
    S.plat = { status: 'ready', list: d.platforms || [], err: '', fetched: d.fetched_at || '' };
  } catch (e) {
    if (seq !== S.seq) return;
    S.plat = { status: 'error', list: [], err: e.message || '读取失败', fetched: '' };
  }
  if (S.plat.status === 'ready' && !S.plat.list.some(function (x) { return x.id === S.target; })) { S.target = ''; S.sub = ''; S.profile = ''; }
  drawSelects(); drawHint(); drawBasket();
  if (S.plat.status === 'ready' && S.target) loadPlatform(S.target, force);
}
async function loadPlatform(t, force) {
  const p = projectNow(), seq = ++S.seq;
  if (!p) return;
  S.cur = { id: t, subs: [], status: 'loading', err: '', fetched: '' };
  drawSelects(); drawHint();
  try {
    const d = await api.platform(p.id, t, force);
    if (seq !== S.seq) return;
    S.cur = { id: t, subs: d.subtargets || [], status: 'ready', err: '', fetched: d.fetched_at || '' };
    if (!S.sub) {
      const pick = (d.subtargets || []).filter(function (x) { return x.id === '64'; })[0] || (d.subtargets || [])[0];
      if (pick) {
        S.sub = pick.id; S.profile = '';
        const g = (pick.devices || []).filter(function (x) { return x.id === 'generic'; })[0];
        if (g) S.profile = g.id;
      }
    } else if (!curSub()) {
      toast('原来的子平台在当前源码里找不到', '请重新选择子平台和机型', 'err');
      S.sub = ''; S.profile = '';
    }
  } catch (e) {
    if (seq !== S.seq) return;
    S.cur = { id: t, subs: [], status: 'error', err: e.message || '读取失败', fetched: '' };
  }
  drawSelects(); drawHint(); drawBasket();
}
function opt(v, label, on) {
  return '<option value="' + esc(v) + '"' + (on ? ' selected' : '') + '>' + esc(label) + '</option>';
}
function drawSelects() {
  const a = $('#stTgt'), b = $('#stSub'), c = $('#stDev');
  if (!a || !b || !c) return;
  let h;
  if (S.plat.status === 'loading') h = opt('', '读取平台中…', true);
  else if (S.plat.status === 'error') h = opt('', '读取失败，点下方重试', true);
  else h = opt('', '— 请选择平台 —', !S.target) + S.plat.list.map(function (t) { return opt(t.id, t.id, t.id === S.target); }).join('');
  a.innerHTML = h; a.disabled = S.plat.status !== 'ready';

  const subs = subsNow();
  if (S.cur.status === 'loading') h = opt('', '读取机型中…', true);
  else if (!subs.length) h = opt('', S.target ? '（没有可选项）' : '— 先选平台 —', true);
  else h = opt('', '— 请选择子平台 —', !S.sub) + subs.map(function (x) {
    return opt(x.id, x.id + (x.name && x.name !== x.id ? ' · ' + x.name : '') + (x.arch ? ' · ' + x.arch : ''), x.id === S.sub);
  }).join('');
  b.innerHTML = h; b.disabled = !subs.length;

  const devs = devicesNow(), q = (S.devQ || '').trim().toLowerCase();
  const shown = devs.filter(function (d) {
    return !q || d.id === S.profile || (d.name + ' ' + d.id + ' ' + (d.alt || []).join(' ')).toLowerCase().indexOf(q) >= 0;
  });
  if (!devs.length) h = opt('', S.sub ? '（没有可选机型）' : '— 先选子平台 —', true);
  else {
    h = opt('', '— 选择机型（共 ' + devs.length + ' 个' + (q ? '，筛出 ' + shown.length + ' 个' : '') + '）—', !S.profile);
    if (S.profile && !devs.some(function (d) { return d.id === S.profile; })) h += opt(S.profile, S.profile + '（不在源码机型列表里）', true);
    h += shown.map(function (d) { return opt(d.id, d.name + (d.name !== d.id ? '  ·  ' + d.id : ''), d.id === S.profile); }).join('');
  }
  c.innerHTML = h; c.disabled = !devs.length;
  const q2 = $('#stDevQ'); if (q2) q2.disabled = !devs.length;

  const step1 = $('#step1'), step2 = $('#step2'), step3 = $('#step3');
  if (step1) {
    const devOk = !!(targetStr() && S.profile);
    step1.className = 'step ' + (devOk ? 'done' : 'on');
    step2.className = 'step ' + (!devOk ? '' : S.sel.size ? 'done' : 'on');
    step3.className = 'step ' + (devOk && S.sel.size ? 'on' : '');
  }
}
function drawHint() {
  const el = $('#stHint');
  if (!el) return;
  const p = projectNow();
  const btn = ' <button class="lnk" id="stRetry">重试</button>';
  if (S.plat.status === 'loading') { el.innerHTML = '正在从源码仓库读取平台列表…'; return; }
  if (S.plat.status === 'error') { el.innerHTML = esc('读取失败：' + S.plat.err + '。读取成功后才能选平台和机型。') + btn; bindRetry(); return; }
  if (S.cur.status === 'loading') { el.innerHTML = '正在读取 ' + esc(S.cur.id) + ' 的机型（实时解析源码，首次约几秒）…'; return; }
  if (S.cur.status === 'error') { el.innerHTML = esc('读取 ' + S.cur.id + ' 失败：' + S.cur.err) + btn; bindRetry(); return; }
  el.innerHTML = esc('平台和机型由 Worker 实时读取自 ' + String(p ? p.repo_url : '').replace('https://github.com/', '') + ' @ ' + (p ? p.branch : '') + '，结果缓存 7 天' + (S.cur.fetched ? '（' + S.cur.fetched + '）' : '')) + btn;
  bindRetry();
}
function bindRetry() {
  const b = $('#stRetry');
  if (!b) return;
  b.addEventListener('click', function () { if (S.plat.status === 'error') loadPlatforms(true); else loadPlatform(S.target, true); });
}

function drawCats() {
  const box = $('#stCats');
  if (!box) return;
  box.innerHTML = S.cats.map(function (c) {
    const n = c === '全部' ? S.catalog.length : S.catalog.filter(function (p) { return p.cat === c; }).length;
    return '<button class="cat' + (!S.only && c === S.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + ' <span class="n">' + n + '</span></button>';
  }).join('') + '<button class="cat' + (S.only ? ' on' : '') + '" data-cat="__only">只看已选 <span class="n">' + S.sel.size + '</span></button>';
  $$('[data-cat]', box).forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.cat === '__only') { S.only = true; }
      else { S.only = false; S.cat = b.dataset.cat; }
      S.limit = 48;
      drawCats(); drawGrid();
    });
  });
}
function filteredPlugins() {
  if (S.only) return S.catalog.filter(function (p) { return S.sel.has(p.id); });
  const q = S.q;
  return S.catalog.filter(function (p) {
    if (S.cat !== '全部' && p.cat !== S.cat) return false;
    if (!q) return true;
    const hay = (p.name + ' ' + p.desc + ' ' + p.id + ' ' + p.cat + ' ' + (S.kw[p.cat] || '') + ' ' + (p.tags || []).join(' ')).toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}
function drawGrid() {
  const box = $('#stGrid');
  if (!box) return;
  const list = filteredPlugins();
  box.innerHTML = list.length ? list.slice(0, S.limit).map(function (p) {
    const on = S.sel.has(p.id);
    const cat = p.cat;
    return '<article class="plugin' + (on ? ' on' : '') + '" data-plugin="' + esc(p.id) + '">' +
      '<span class="tile" style="' + catStyle(cat) + '">' + esc((p.name || p.id).charAt(0).toUpperCase()) + '</span>' +
      '<div class="body">' +
        '<div class="nm">' + esc(p.name) + (p.rec ? '<span class="rec" title="推荐">' + ic('spark') + '</span>' : '') + '</div>' +
        '<div class="pk">' + esc(p.id) + '</div>' +
        '<div class="ds">' + esc(p.desc) + '</div>' +
        '<div class="meta"><span>' + (p.size_mb ? '≈ ' + p.size_mb + ' MB' : '体积未知') + '</span><span>·</span><span>' + (p.deps || []).length + ' 个依赖</span>' +
          '<button class="lnk" data-info="' + esc(p.id) + '" style="margin-left:auto">详情</button></div>' +
      '</div>' +
      '<span class="tick">' + ic('check') + '</span>' +
      (p.stale ? '<span class="corner-tag warn">目录已无</span>' : (p.custom ? '<span class="corner-tag">自定义</span>' : ((p.origin && p.origin.type !== 'builtin') ? '<span class="corner-tag">第三方</span>' : ''))) +
    '</article>';
  }).join('') : '<div class="empty" style="grid-column:1/-1"><div class="g">' + ic('search') + '</div><div class="m">没有匹配的插件</div><div class="s">换个关键词，或把仓库地址贴进「自定义插件」</div></div>';
  $$('[data-plugin]', box).forEach(function (card) {
    card.addEventListener('click', function (ev) {
      const info = ev.target.closest('[data-info]');
      if (info) { ev.stopPropagation(); pluginDetail(info.dataset.info); return; }
      togglePlugin(card.dataset.plugin);
    });
  });
  const more = $('#stMore');
  if (more) more.innerHTML = list.length > S.limit ? '<button class="btn" id="stMoreBtn">显示更多（还有 ' + (list.length - S.limit) + ' 个）</button>' : '';
  const mb = $('#stMoreBtn');
  if (mb) mb.addEventListener('click', function () { S.limit += 48; drawGrid(); });
}
function togglePlugin(id) {
  if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  drawGrid(); drawBasket();
  const cats = $('#stCats');
  if (cats) { const n = $('[data-cat="__only"] .n', cats); if (n) n.textContent = S.sel.size; }
  drawSelects();
}
function basketWarnings() {
  const S2 = selectedPlugins(), warns = [];
  const px = S2.filter(function (p) { return p.cat === '代理'; });
  if (px.length > 1) warns.push('选了 ' + px.length + ' 个代理插件，通常只需要一个，同时启用容易冲突。');
  if (!targetStr()) warns.push('还没选平台和子平台。');
  else if (!S.profile) warns.push('还没选机型。');
  if (S.profile && curSub() && !devicesNow().some(function (d) { return d.id === S.profile; })) warns.push('这个机型不在所选子平台的源码列表里，建议重新选择。');
  const stale = S2.filter(function (p) { return p.stale; }).length;
  if (stale) warns.push(stale + ' 个插件已不在目录里，会按原包名尝试启用，编译前会校验是否生效。');
  const dd = S2.filter(function (p) { return p.cat === '容器'; });
  if (dd.length && S.profile && /^(mediatek\/mt7621|ath79|ramips)/.test(targetStr())) warns.push('小内存机型上跑容器容易 OOM，确认内存足够再加。');
  return warns;
}
function configPreview() {
  const lines = [];
  if (S.profile && /^[^/]+\/[^/]+$/.test(targetStr())) {
    const m = targetStr().split('/');
    lines.push('CONFIG_TARGET_' + m[0] + '=y', 'CONFIG_TARGET_' + m[0] + '_' + m[1] + '=y', 'CONFIG_TARGET_' + m[0] + '_' + m[1] + '_DEVICE_' + S.profile + '=y');
  }
  selectedPlugins().forEach(function (p) {
    lines.push('CONFIG_PACKAGE_' + p.id + '=y');
    (p.requires || []).forEach(function (r) { lines.push('CONFIG_PACKAGE_' + r + '=y'); });
  });
  return lines.join('\n');
}
function autoName() {
  const p = projectNow();
  return '商店 · ' + (p ? p.name : '') + ' · ' + (targetStr() || '未选平台') + ' · ' + (S.profile || '未选机型');
}
function drawBasket() {
  const box = $('#stBasket');
  if (!box) return;
  const S2 = selectedPlugins();
  const mb = 7 + S2.reduce(function (a, p) { return a + (p.size_mb || 0); }, 0);
  const deps = {};
  S2.forEach(function (p) { (p.deps || []).forEach(function (d) { deps[d] = 1; }); });
  const budget = 120;
  const pct = Math.min(100, (mb / budget) * 100);
  const warns = basketWarnings();
  const name = S.nameDirty ? S.tplName : autoName();
  const d = devicesNow().filter(function (x) { return x.id === S.profile; })[0];

  box.innerHTML =
    '<div class="basket-head"><h2>' + ic('box') + '已选清单 <span class="cnt">' + S2.length + '</span></h2>' +
      (S2.length ? '<button class="btn btn-sm btn-ghost" id="stClear">清空</button>' : '') + '</div>' +
    '<div class="basket-list">' + (S2.length ? S2.map(function (p) {
      return '<div class="bi"><span class="tile-s" style="' + catStyle(p.cat) + '">' + esc((p.name || p.id).charAt(0).toUpperCase()) + '</span>' +
        '<span class="t">' + esc(p.name) + '</span><button class="x" data-rm="' + esc(p.id) + '" title="移除">' + ic('x') + '</button></div>';
    }).join('') : '<div class="basket-empty">还没有选插件<br /><span style="font-size:11.5px">从左边点几项开始</span></div>') + '</div>' +
    '<div class="basket-body">' +
      '<div class="sum"><span>已知体积合计</span><b>≈ ' + mb.toFixed(1) + ' MB</b></div>' +
      '<div><div class="meter' + (pct > 55 ? ' warn' : '') + '"><i style="width:' + pct + '%"></i></div>' +
        '<div class="meter-hint"><span>0</span><span>常见系统分区 ' + budget + ' MB</span></div></div>' +
      '<div class="sum" style="font-size:11.5px"><span>' + S2.length + ' 个插件 · ' + Object.keys(deps).length + ' 个自动依赖</span><span class="mono">' + (targetStr() || '—') + '</span></div>' +
      (warns.length ? warns.map(function (w) { return '<div class="note">' + ic('alert') + '<span>' + esc(w) + '</span></div>'; }).join('') : '') +
      (d ? '<div class="note ok">' + ic('check') + '<span>已选 ' + esc(d.name) + '</span></div>' : '') +
      '<div class="field" style="gap:5px"><label>模板名称</label><input class="input" id="stName" maxlength="80" value="' + esc(name) + '" /></div>' +
      '<details class="fold"><summary>' + ic('right') + '查看将写入的配置行</summary><pre class="code">' + esc(configPreview()) + '</pre></details>' +
      '<button class="btn btn-primary btn-lg btn-block" id="stGo"' + (S.busy ? ' disabled' : '') + '>' + ic('rocket') + (S.busy ? '保存中…' : (S.editId ? '保存到模板' : '生成模板')) + '</button>' +
      '<div class="hint" style="text-align:center">不会立即编译，下一页确认后再点编译</div>' +
    '</div>';

  const clear = $('#stClear');
  if (clear) clear.addEventListener('click', function () { S.sel.clear(); drawGrid(); drawBasket(); drawSelects(); });
  $$('[data-rm]', box).forEach(function (b) {
    b.addEventListener('click', function () { S.sel.delete(b.dataset.rm); drawGrid(); drawBasket(); drawSelects(); });
  });
  $('#stName').addEventListener('input', function (ev) { S.tplName = ev.target.value; S.nameDirty = true; });
  $('#stGo').addEventListener('click', storeSave);
}

async function storeSave() {
  if (S.busy) return;
  const proj = projectNow();
  const target = targetStr(), profile = (S.profile || '').trim();
  if (!/^[^/]+\/[^/]+$/.test(target)) { toast('请先选择平台和子平台', '', 'err'); return; }
  if (!profile) { toast('请选择机型', '', 'err'); return; }
  let name = (S.nameDirty ? S.tplName : autoName()).trim();
  if (!name) { toast('请填写模板名称', '', 'err'); return; }
  const ids = Array.from(S.sel);
  const composed = composeFromSelection(ids, { plugins: [] });
  S.busy = true; drawBasket();
  try {
    const body = {
      name: name, repo_url: proj.repo_url, branch: proj.branch, target: target, profile: profile, project_id: proj.id,
      plugins: composed.plugins, packages: composed.packages, selection: composed.selection,
    };
    let id = S.editId;
    if (id) {
      await api.updateTemplate(id, body);
    } else {
      const lt = await api.templates();
      const base = name;
      let n = 1;
      while (lt.templates.some(function (x) { return x.name === name; })) { n++; name = base + ' (' + n + ')'; }
      body.name = name;
      id = (await api.createTemplate(body)).template.id;
    }
    const wasEdit = !!S.editId;
    S.busy = false;
    storeReset();
    toast(wasEdit ? '已保存到模板' : '模板已生成', wasEdit ? '' : '确认无误后再点编译', 'info');
    nav('#/template/' + id);
  } catch (e) {
    S.busy = false;
    fail(e, '保存失败');
    drawBasket();
  }
}

function pluginDetail(id) {
  const p = pluginById(id);
  if (!p) return;
  const on = S.sel.has(id), o = pluginOrigin(p);
  openModal('<div class="modal" style="max-width:520px"><div class="modal-head"><div style="min-width:0">' +
    '<h3>' + esc(p.name) + '</h3><div class="mono dim" style="font-size:11.5px;margin-top:2px">' + esc(p.id) + '</div></div>' +
    '<button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body">' +
      '<div style="display:flex;gap:10px;align-items:center"><span class="tile" style="' + catStyle(p.cat) + ';width:40px;height:40px;border-radius:11px;display:grid;place-items:center;font-weight:700">' + esc(p.name.charAt(0).toUpperCase()) + '</span>' +
      '<div><div class="tag">' + esc(p.cat) + '</div></div></div>' +
      '<p style="margin:0;font-size:13px;line-height:1.7;color:var(--ink-2)">' + esc(p.desc) + '</p>' +
      (p.tut ? '<div class="note info">' + ic('info') + '<span>' + esc(p.tut) + '</span></div>' : '') +
      '<div class="dl"><span class="k">依赖</span><span class="v mono">' + (p.deps && p.deps.length ? esc(p.deps.join('、')) : '无') + '</span></div>' +
      '<div class="dl"><span class="k">额外包</span><span class="v mono">' + (p.requires && p.requires.length ? esc(p.requires.join('、')) : '无') + '</span></div>' +
      '<div class="dl"><span class="k">体积</span><span class="v mono">' + (p.size_mb ? '≈ ' + p.size_mb + ' MB' : '未知') + '</span></div>' +
      '<div class="dl"><span class="k">来源</span><span class="v mono" style="word-break:break-all">' + (o ? esc(o.git_url || o.feed) : '源码内置') + '</span></div>' +
    '</div>' +
    '<div class="modal-foot">' + (p.custom && !p.stale ? '<button class="btn btn-danger" id="pDel" style="margin-right:auto">删除这个插件</button>' : '') +
    '<button data-close>关闭</button><button class="btn btn-primary" id="pAdd">' + (on ? '从固件移除' : '添加到固件') + '</button></div></div>', {
    onMount: function (root) {
      $('#pAdd', root).addEventListener('click', function () { togglePlugin(id); closeModal(root); });
      const del = $('#pDel', root);
      if (del) del.addEventListener('click', async function () {
        try { await api.delCustomPlugin(id); S.sel.delete(id); await ensureCatalog(true); S.loaded = true; drawCats(); drawGrid(); drawBasket(); closeModal(root); toast('已删除'); }
        catch (e) { fail(e, '删除失败'); }
      });
    },
  });
}

function customPluginModal() {
  const listHTML = function () {
    const c = S.catalog.filter(function (p) { return p.custom && !p.stale; });
    return c.length ? c.map(function (p) {
      const o = p.origin || {};
      return '<div class="src-row"><code>' + esc(p.name) + '</code><span>' + esc((o.url || '') + (o.sparse && o.dirs ? ' · ' + o.dirs.join(', ') : '')) + '</span>' +
        '<button class="lnk danger" data-cpdel="' + esc(p.id) + '">删除</button></div>';
    }).join('') : '<div class="hint">还没有自定义插件</div>';
  };
  const overlay = openModal('<div class="modal" style="max-width:600px"><div class="modal-head"><h3>自定义插件</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body">' +
      '<div class="hint">填插件源码的 GitHub 仓库地址，识别后加入商店。整个仓库是一个包、或者仓库里有多个包都可以。</div>' +
      '<div class="note">' + ic('shield') + '<span>编译时会执行这个仓库里的代码，请只添加你信任的仓库。</span></div>' +
      '<div class="field"><label>已添加</label><div id="cpList">' + listHTML() + '</div></div>' +
      '<div class="field"><label>仓库地址</label><input class="input mono" id="cpUrl" placeholder="https://github.com/用户/仓库" /></div>' +
      '<div class="field"><label>分支（留空用默认分支）</label><input class="input mono" id="cpBranch" /></div>' +
      '<div><button class="btn btn-primary" id="cpDetect">识别</button></div>' +
      '<div id="cpRes"></div>' +
    '</div><div class="modal-foot"><button data-close>关闭</button></div></div>');

  const res = $('#cpRes', overlay);
  let det = null;
  const manualForm = function (note) {
    res.innerHTML = (note ? '<div class="note">' + ic('info') + '<span>' + esc(note) + '</span></div>' : '') +
      '<div class="field"><label>包名</label><input class="input mono" id="cpId" placeholder="luci-app-xxx" /></div>' +
      '<div class="field"><label>显示名称</label><input class="input" id="cpName" /></div>' +
      '<div class="field"><label>简介</label><input class="input" id="cpDesc" /></div>' +
      '<div class="field"><label>额外需要的包（逗号分隔）</label><input class="input mono" id="cpReq" placeholder="例如 video-support" /></div>' +
      '<button class="btn btn-primary" id="cpAddOne">添加</button>';
  };
  const reload = async function (r) {
    await ensureCatalog(true);
    S.loaded = true;
    (r.plugins || []).forEach(function (p) { S.sel.add(p.id); });
    S.cat = '自定义'; S.only = false; S.q = ''; S.limit = 48;
    const q = $('#stQ'); if (q) q.value = '';
    drawCats(); drawGrid(); drawBasket();
    $('#cpList', overlay).innerHTML = listHTML();
    res.innerHTML = '';
    toast('已添加 ' + (r.plugins || []).length + ' 个插件', '并加入已选清单');
  };

  $('#cpDetect', overlay).addEventListener('click', async function (ev) {
    const url = $('#cpUrl', overlay).value.trim();
    if (!url) { toast('请填写仓库地址', '', 'err'); return; }
    ev.currentTarget.disabled = true;
    res.innerHTML = '<div class="loading" style="padding:16px">' + ic('refresh') + '<span>正在识别…</span></div>';
    try {
      det = await api.detectPlugin({ repo_url: url, branch: $('#cpBranch', overlay).value.trim() });
      if (!det.detected) { manualForm(det.reason); return; }
      if (det.root) {
        manualForm('识别为单个插件包（包名读自 Makefile，可以改）。');
        $('#cpId', overlay).value = det.pkg_name || '';
        $('#cpReq', overlay).value = (det.requires || []).join(', ');
      } else if ((det.candidates || []).length) {
        res.innerHTML = '<div class="hint">仓库里有多个包，勾选要添加的：</div>' +
          '<input class="input" id="cpFilter" placeholder="筛选" />' +
          '<div class="cand-box" id="cpCands">' + det.candidates.map(function (c) {
            const base = c.path.split('/').pop();
            return '<label class="cand"><input type="checkbox" data-path="' + esc(c.path) + '" /><span>' + esc(c.path) +
              (c.id !== base ? ' <b>→ ' + esc(c.id) + '</b>' : '') +
              ((c.requires || []).length ? ' <small>（同时包含 ' + esc((c.requires || []).join(', ')) + '）</small>' : '') + '</span></label>';
          }).join('') + '</div>' +
          '<div class="field"><label>所选插件都需要的包（可选）</label><input class="input mono" id="cpReqDirs" placeholder="例如 video-support" /></div>' +
          '<button class="btn btn-primary" id="cpAddDirs">添加所选</button>';
        $('#cpFilter', overlay).addEventListener('input', function (e) {
          const q = e.target.value.toLowerCase();
          $$('.cand', overlay).forEach(function (l) { l.style.display = !q || l.textContent.toLowerCase().indexOf(q) >= 0 ? 'flex' : 'none'; });
        });
      } else {
        manualForm('仓库里没找到 Makefile。如果确定是 OpenWrt 软件包仓库，可以手动填包名。');
      }
    } catch (e) { res.innerHTML = ''; fail(e, '识别失败'); }
    ev.currentTarget.disabled = false;
  });

  overlay.addEventListener('click', async function (ev) {
    const t = ev.target.closest('button');
    if (!t) return;
    try {
      if (t.id === 'cpAddOne') {
        const body = {
          repo_url: $('#cpUrl', overlay).value.trim(), branch: (det && det.branch) || $('#cpBranch', overlay).value.trim(),
          id: $('#cpId', overlay).value.trim(), name: $('#cpName', overlay).value.trim(), desc: $('#cpDesc', overlay).value.trim(),
          requires: $('#cpReq', overlay).value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
        };
        await reload(await api.addCustomPlugin(body));
      } else if (t.id === 'cpAddDirs') {
        const dirs = $$('#cpCands input:checked', overlay).map(function (x) {
          const c = (det.candidates || []).filter(function (y) { return y.path === x.dataset.path; })[0];
          return { path: x.dataset.path, id: c ? c.id : '', requires: c ? c.requires : [] };
        });
        if (!dirs.length) { toast('请先勾选要添加的包', '', 'err'); return; }
        await reload(await api.addCustomPlugin({
          repo_url: $('#cpUrl', overlay).value.trim(), branch: (det && det.branch) || $('#cpBranch', overlay).value.trim(),
          dirs: dirs, requires: $('#cpReqDirs', overlay).value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
        }));
      } else if (t.dataset.cpdel) {
        await api.delCustomPlugin(t.dataset.cpdel);
        S.sel.delete(t.dataset.cpdel);
        await ensureCatalog(true); S.loaded = true;
        drawCats(); drawGrid(); drawBasket();
        $('#cpList', overlay).innerHTML = listHTML();
      }
    } catch (e) { fail(e, '操作失败'); }
  });
}

function projectModal() {
  const rows = function () {
    const c = S.projects.filter(function (p) { return !p.builtin; });
    return c.length ? c.map(function (p) {
      return '<div class="src-row"><code>' + esc(p.name) + '</code><span>' + esc(p.repo_url + ' @ ' + p.branch) + '</span>' +
        '<button class="lnk danger" data-pjdel="' + esc(p.id) + '">删除</button></div>';
    }).join('') : '<div class="hint">还没有自定义项目</div>';
  };
  const overlay = openModal('<div class="modal" style="max-width:560px"><div class="modal-head"><h3>自定义源码项目</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body">' +
      '<div class="hint">填 OpenWrt / ImmortalWrt / LEDE 或其它 OpenWrt 系源码仓库，平台和机型会直接从源码读取。</div>' +
      '<div class="field"><label>项目名称</label><input class="input" id="pjName" placeholder="如 我的 ImmortalWrt" /></div>' +
      '<div class="field"><label>仓库地址</label><input class="input mono" id="pjUrl" placeholder="https://github.com/用户/仓库" /></div>' +
      '<div class="field"><label>分支</label><input class="input mono" id="pjBranch" value="master" /></div>' +
      '<button class="btn btn-primary" id="pjAdd">添加</button>' +
      '<div class="field" style="margin-top:4px"><label>已添加</label><div id="pjList">' + rows() + '</div></div>' +
    '</div><div class="modal-foot"><button data-close>关闭</button></div></div>');
  const refresh = async function () {
    S.projects = (await api.projects()).projects || [];
    drawProjects();
    $('#pjList', overlay).innerHTML = rows();
  };
  $('#pjAdd', overlay).addEventListener('click', async function (ev) {
    ev.currentTarget.disabled = true;
    try {
      const r = await api.addProject({ name: $('#pjName', overlay).value.trim(), repo_url: $('#pjUrl', overlay).value.trim(), branch: $('#pjBranch', overlay).value.trim() });
      await refresh();
      S.pi = Math.max(0, S.projects.findIndex(function (p) { return p.id === r.project.id; }));
      drawProjects();
      closeModal(overlay);
      toast('已添加项目', '正在读取平台列表', 'info');
      S.target = ''; S.sub = ''; S.profile = '';
      loadPlatforms(true);
    } catch (e) { fail(e, '添加失败'); ev.currentTarget.disabled = false; }
  });
  overlay.addEventListener('click', async function (ev) {
    const t = ev.target.closest('[data-pjdel]');
    if (!t) return;
    try {
      await api.delProject(t.dataset.pjdel);
      await refresh();
      S.pi = 0; drawProjects(); loadPlatforms(true);
    } catch (e) { fail(e, '删除失败'); }
  });
}

/* ---------------- 编译记录页 ---------------- */
async function viewBuilds() {
  const view = $('#view');
  view.innerHTML = '<header class="page-head"><div><div class="eyebrow">WORKSPACE <b>/</b> BUILDS</div><h1>编译记录</h1>' +
    '<div class="sub">手动和定时任务都在这里，失败的会直接给出原因。</div></div>' +
    '<div class="actions"><button class="btn" id="bRefresh">' + ic('refresh') + '刷新</button></div></header>' +
    '<div id="bArea"><div class="loading">' + ic('refresh') + '<span>读取记录…</span></div></div>';
  $('#bRefresh').addEventListener('click', async function (ev) {
    ev.currentTarget.disabled = true;
    await refreshBuilds().catch(function () { });
    drawBuildsList();
    ev.currentTarget.disabled = false;
  });
  try { await refreshBuilds(); } catch (e) {
    $('#bArea').innerHTML = '<div class="empty"><div class="g">' + ic('alert') + '</div><div class="m">读取失败</div><div class="s">' + esc(e.message) + '</div></div>';
    return;
  }
  if (S.route.name !== 'builds') return;
  drawBuildsList();
}
function drawBuildsList() {
  const area = $('#bArea');
  if (!area) return;
  const counts = { all: S.builds.length, active: 0, success: 0, failed: 0 };
  S.builds.forEach(function (b) {
    if (ACTIVE.indexOf(b.status) >= 0) counts.active++;
    else if (b.status === 'success') counts.success++;
    else if (b.status === 'failed') counts.failed++;
  });
  const segs = [['all', '全部', counts.all], ['active', '进行中', counts.active], ['success', '成功', counts.success], ['failed', '失败', counts.failed]];
  const list = S.builds.filter(function (b) {
    if (S.bfilter === 'active') return ACTIVE.indexOf(b.status) >= 0;
    if (S.bfilter === 'success') return b.status === 'success';
    if (S.bfilter === 'failed') return b.status === 'failed';
    return true;
  });
  area.innerHTML = '<div class="filter-bar" style="margin-bottom:14px"><div class="seg">' +
    segs.map(function (s) { return '<button class="' + (S.bfilter === s[0] ? 'on' : '') + '" data-bf="' + s[0] + '">' + s[1] + ' <span class="n">' + s[2] + '</span></button>'; }).join('') +
    '</div><span class="hint" style="margin-left:auto">最多显示最近 50 条</span></div>' +
    (list.length ? list.map(function (b) { return buildCard(b, false); }).join('')
      : '<div class="empty"><div class="g">' + ic('pulse') + '</div><div class="m">' + (S.builds.length ? '没有符合条件的记录' : '还没有任何编译记录') + '</div>' +
        '<div class="s">' + (S.builds.length ? '换个筛选条件试试' : '去模板页点一次「编译」') + '</div></div>');
  $$('[data-bf]', area).forEach(function (b) {
    b.addEventListener('click', function () { S.bfilter = b.dataset.bf; drawBuildsList(); });
  });
}
async function refreshBuilds() {
  const r = await api.builds();
  S.builds = r.builds || [];
  drawQueue();
  const badge = $('.nav-badge');
  const n = activeBuilds().length;
  if (badge) { badge.textContent = n; badge.hidden = !n; }
  else if (n) {
    const item = $('[data-nav="builds"]');
    if (item) item.insertAdjacentHTML('beforeend', '<span class="nav-badge">' + n + '</span>');
  }
}
function rerenderCurrent() {
  const r = S.route;
  if (r.name === 'templates') drawTemplates();
  else if (r.name === 'builds') drawBuildsList();
  else if (r.name === 'template') {
    const box = $('#tplBuilds');
    if (box) { const t = tplById(r.params.id); if (t) drawTplBuilds(t); }
  }
}
function startPoll() {
  stopPoll();
  S.poll = setInterval(async function () {
    if (document.hidden || !S.authed) return;
    const had = activeBuilds().length;
    try {
      await refreshBuilds();
      if (had || activeBuilds().length) rerenderCurrent();
    } catch (e) { /* 网络抖动时静默 */ }
  }, 12000);
}
function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }

/* ---------------- 设置页 ---------------- */
async function viewSettings() {
  const view = $('#view');
  view.innerHTML = '<header class="page-head"><div><div class="eyebrow">SYSTEM <b>/</b> SETTINGS</div><h1>设置</h1>' +
    '<div class="sub">GitHub 连接、凭据轮换和一些不可逆操作。</div></div></header><div id="setArea"><div class="loading">' + ic('refresh') + '<span>读取配置…</span></div></div>';
  let s;
  try { s = await api.settings(); }
  catch (e) {
    $('#setArea').innerHTML = '<div class="empty"><div class="g">' + ic('alert') + '</div><div class="m">读取失败</div><div class="s">' + esc(e.message) + '</div></div>';
    return;
  }
  if (S.route.name !== 'settings') return;
  $('#setArea').innerHTML = '<div class="settings-grid">' +
    '<section class="card"><div class="card-head"><div><h2>GitHub 连接</h2><div class="sub">Worker 通过它触发 Actions</div></div>' +
      '<span class="pill ok">已连接</span></div><div class="card-pad">' +
      '<div class="dl"><span class="k">编译仓库</span><span class="v mono">' + esc(s.github_repo || '—') + '</span></div>' +
      '<div class="dl"><span class="k">Worker URL</span><span class="v mono">' + esc(s.worker_url || location.origin) + '</span></div>' +
      '<div class="dl"><span class="k">GitHub Token</span><span class="v mono">' + esc(s.github_token_masked || '—') + '</span></div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
        '<button class="btn" id="setReconf">' + ic('edit') + '重新配置</button>' +
        '<button class="btn" id="setToken">' + ic('refresh') + '重置 REPORT_TOKEN</button>' +
      '</div>' +
      '<div class="hint" style="margin-top:10px">重置 REPORT_TOKEN 后旧的立即失效，需要去 GitHub 仓库 Secrets 里更新。</div>' +
    '</div></section>' +
    '<section class="card"><div class="card-head"><div><h2>外观</h2><div class="sub">偏好保存在本地浏览器</div></div></div><div class="card-pad">' +
      '<div class="opt-row" style="padding-top:0"><div><div class="t">深色模式</div><div class="d">夜间看编译日志更舒服。</div></div>' +
        '<div class="c"><label class="switch"><input type="checkbox" id="setDark"' + (isDark() ? ' checked' : '') + '><span class="track"></span></label></div></div>' +
      '<div class="opt-row"><div><div class="t">当前版本</div><div class="d">固件工坊 owrt-forge · Worker + D1 + GitHub Actions</div></div>' +
        '<div class="c"><span class="tag">单页应用</span></div></div>' +
    '</div></section>' +
    '<section class="card"><div class="card-head"><div><h2>帮助</h2></div></div><div class="card-pad">' +
      '<div class="hint">• 同一时间只跑一个编译任务，新任务会排队。<br />' +
      '• 定时编译不会进入 menuconfig，会按模板里的机型和插件清单重新生成配置。<br />' +
      '• 自定义插件会执行对应仓库的代码，只添加你信任的来源。<br />' +
      '• ccache 存在编译仓库的 Release 里，公开仓库任何人都能下载。</div>' +
    '</div></section>' +
    '<section class="card danger-card"><div class="card-head"><div><h2>危险区域</h2><div class="sub">操作不可撤销</div></div></div><div class="card-pad">' +
      '<div class="opt-row" style="padding-top:0"><div><div class="t">重置所有配置</div><div class="d">清空 GitHub 连接和登录密码，系统回到初始化状态。</div></div>' +
      '<div class="c"><button class="btn btn-danger" id="setResetAll">重置</button></div></div>' +
    '</div></section>' +
  '</div>';

  $('#setReconf').addEventListener('click', function () { renderAuth('wizard', { reconfigure: true }); });
  $('#setToken').addEventListener('click', async function () {
    const ok = await confirmBox({ title: '重置 REPORT_TOKEN', body: '旧的 REPORT_TOKEN 会立即失效，需要马上去 GitHub 仓库更新 Secret，否则编译结果无法回传。', ok: '重置', danger: true });
    if (!ok) return;
    try {
      const r = await api.resetToken();
      openModal('<div class="modal"><div class="modal-head"><h3>新的 REPORT_TOKEN</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
        '<div class="modal-body"><div class="note">' + ic('alert') + '<span>去 GitHub → Settings → Secrets → Actions，把 <code>REPORT_TOKEN</code> 更新成下面这串。关掉窗口后不再显示明文。</span></div>' +
        '<div class="token-box"><code>' + esc(r.report_token) + '</code><button class="btn btn-sm" id="tkCopy">' + ic('copy') + '复制</button></div></div>' +
        '<div class="modal-foot"><button class="btn btn-primary" data-close>我知道了</button></div></div>', {
        onMount: function (root) { $('#tkCopy', root).addEventListener('click', function () { copyText(r.report_token); }); },
      });
    } catch (e) { fail(e, '重置失败'); }
  });
  $('#setDark').addEventListener('change', toggleTheme);
  $('#setResetAll').addEventListener('click', async function () {
    const ok = await confirmBox({ title: '重置所有配置', body: '这会清空 GitHub 连接、REPORT_TOKEN 和登录密码，系统回到初始化状态。模板和编译记录不会删除。', ok: '确认重置', danger: true });
    if (!ok) return;
    try {
      await api.resetSettings('all');
      S.authed = false; S.status = 'uninitialized';
      stopPoll();
      renderAuth('init');
    } catch (e) { fail(e, '重置失败'); }
  });
}

/* ---------------- 渲染与启动 ---------------- */
function render() {
  if (S.status === 'uninitialized') { renderAuth('init'); return; }
  if (!S.authed) { renderAuth('login'); return; }
  if (S.status === 'wizard') { renderAuth('wizard'); return; }
  const r = S.route;
  const active = r.name === 'template' ? 'template' : r.name;
  mountShell(active);
  if (r.name === 'template') viewDetail(r.params.id);
  else if (r.name === 'store') viewStore(r.params.tpl);
  else if (r.name === 'builds') viewBuilds();
  else if (r.name === 'settings') viewSettings();
  else viewTemplates();
}
async function bootData() {
  try {
    const r = await api.templates();
    S.templates = r.templates || [];
  } catch (e) { /* 首次可能未登录 */ }
  try { await refreshBuilds(); } catch (e) { /* 忽略 */ }
  render();
  startPoll();
}

(function boot() {
  try { const t = localStorage.getItem('owf-theme'); if (t === 'dark' || t === 'light') S.theme = t; } catch (e) { /* 忽略 */ }
  applyTheme();
  if (!document.getElementById('toasts')) {
    const w = document.createElement('div');
    w.className = 'toasts';
    w.id = 'toasts';
    document.body.appendChild(w);
  }
  S.route = parseHash();
  window.addEventListener('hashchange', function () {
    const next = parseHash();
    if (next.name === S.route.name && next.params.id === S.route.params.id && next.params.tpl === S.route.params.tpl) return;
    S.route = next;
    render();
  });

  api.setupStatus().then(function (r) {
    S.status = r.status;
    if (S.status === 'uninitialized') { renderAuth('init'); return; }
    return api.templates().then(function () { S.authed = true; }).catch(function () { S.authed = false; });
  }, function () {
    S.status = 'ready';
  }).then(function () {
    if (S.status === 'uninitialized') return;
    if (!S.authed) { renderAuth('login'); return; }
    if (S.status === 'wizard') { renderAuth('wizard'); return; }
    bootData();
  });
})();
