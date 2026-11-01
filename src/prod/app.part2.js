/* ============================================================
   编译记录卡片 / 模板页 / 模板详情
   ============================================================ */

function pillOf(status) {
  const st = ST[status] || ST.never;
  return '<span class="pill ' + st.cls + '">' + st.t + '</span>';
}
function buildMeta(b) {
  const bits = [];
  bits.push('<span class="mono">' + esc(b.target || '—') + (b.profile ? ' / ' + esc(b.profile) : '') + '</span>');
  bits.push('<span>' + (b.trigger_type === 'scheduled' ? '定时' : '手动') + '</span>');
  if (b.status === 'success' || b.status === 'failed' || b.status === 'cancelled') bits.push('<span>' + fmtDur(b.created_at, b.updated_at) + '</span>');
  if (b.cache_from) bits.push('<span class="tag-inline">' + ic('zap') + '用了缓存</span>');
  if (b.cache_tag) bits.push('<span class="tag-inline">' + ic('save') + '已存缓存 ' + fmtSize(b.cache_size) + '</span>');
  return '<div class="build-meta">' + bits.join('<span class="sep">·</span>') + '</div>';
}
function buildTime(b) {
  const isAct = ACTIVE.indexOf(b.status) >= 0;
  if (isAct) {
    const m = Math.max(1, Math.floor((Date.now() - Number(b.created_at)) / 60000));
    return '已用 ' + m + ' 分';
  }
  return fmtTime(b.created_at);
}
function buildCard(b, compact) {
  const tpl = tplById(b.template_id);
  const name = tpl ? tpl.name : '已删除的模板';
  const isAct = ACTIVE.indexOf(b.status) >= 0;
  const failed = b.status === 'failed';
  const detail = [b.log_tail].filter(Boolean).join('\n');
  const steps = ['排队', '准备', '编译', '完成'];
  let idx = 0;
  if (b.status === 'queued') idx = 0;
  else if (b.status === 'pending') idx = 0;
  else if (b.status === 'running') idx = 1;
  else if (b.status === 'menuconfig' || b.status === 'compiling') idx = 2;
  else if (b.status === 'success') idx = 4;
  const tl = steps.map(function (s, i) {
    const done = i < idx;
    const cur = i === idx && isAct;
    const dot = done ? 'done' : cur ? 'cur' : '';
    return '<span class="tl-step"><span class="tl-dot ' + dot + '" title="' + s + '"></span>' + (i < steps.length - 1 ? '<span class="tl-bar ' + (done ? 'done' : '') + '"></span>' : '') + '</span>';
  }).join('');

  const links = [];
  if (b.web_url) links.push('<a href="' + esc(b.web_url) + '" target="_blank" rel="noopener">' + ic('terminal') + '打开网页终端</a>');
  if (b.download_url) links.push('<a href="' + esc(b.download_url) + '" target="_blank" rel="noopener">' + ic('download') + '下载产物</a>');
  if (b.has_snapshot) links.push('<button class="lnk" data-bact="cfg" data-id="' + b.id + '" data-kind="snapshot">' + ic('list') + '查看底稿</button>');
  if (b.has_result) links.push('<button class="lnk" data-bact="cfg" data-id="' + b.id + '" data-kind="result">' + ic('list') + '查看最终配置</button>');
  if (isAct && b.use_ccache) links.push('<button class="lnk" data-bact="pub" data-id="' + b.id + '" data-on="' + (b.cache_publish ? '1' : '0') + '">' + ic('save') + (b.cache_publish ? '完成后发布缓存 ✓' : '完成后发布缓存') + '</button>');

  return '<div class="build' + (compact ? ' compact' : '') + '" data-build="' + b.id + '">' +
    '<div class="build-top">' +
      pillOf(b.status) +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="tm">' + esc(buildTime(b)) + '</span>' +
      (compact ? '' : '<span class="right">' +
        (isAct ? '<button class="btn btn-sm btn-ghost" data-bact="cancel" data-id="' + b.id + '">' + ic('stop') + '取消</button>' : '') +
      '</span>') +
    '</div>' +
    buildMeta(b) +
    (isAct ? '<div class="progress"><span class="bar"><i class="indet"></i></span><span class="pct">…</span></div><div class="timeline">' + tl + '</div>' : (b.status === 'success' ? '<div class="timeline">' + tl + '</div>' : '')) +
    (failed && b.fail_reason ? '<div class="fail-line">' + ic('alert') + '<span>' + esc(b.fail_reason) + '</span></div>' : '') +
    (detail ? '<details class="fail-detail"><summary>' + ic('right') + (failed ? '详细日志与处理建议' : '构建说明') + '</summary><pre>' + esc(detail) + '</pre></details>' : '') +
    (links.length && !compact ? '<div class="build-links">' + links.join('') + '</div>' : '') +
  '</div>';
}

/* ---------------- 模板页 ---------------- */
async function viewTemplates() {
  const view = $('#view');
  view.innerHTML = '<header class="page-head"><div><div class="eyebrow">WORKSPACE <b>/</b> TEMPLATES</div><h1>模板</h1>' +
    '<div class="sub">一个模板就是一套「机型 + 插件清单 + 编译选项」，下次想再编一份，点一下就好。</div></div>' +
    '<div class="actions"><button class="btn" id="btnImport">' + ic('save') + '导入模板</button>' +
    '<button class="btn btn-primary" id="btnNew">' + ic('plus') + '新建模板</button></div></header>' +
    '<div id="tplArea"><div class="loading">' + ic('refresh') + '<span>读取模板…</span></div></div>';
  $('#btnNew').addEventListener('click', function () { nav('#/store'); });
  $('#btnImport').addEventListener('click', openImportModal);

  try {
    const r = await api.templates();
    S.templates = r.templates || [];
  } catch (e) {
    $('#tplArea').innerHTML = '<div class="empty"><div class="g">' + ic('alert') + '</div><div class="m">模板读取失败</div><div class="s">' + esc(e.message) + '</div></div>';
    return;
  }
  if (S.route.name !== 'templates') return;
  drawTemplates();
}

function drawTemplates() {
  const area = $('#tplArea');
  if (!area) return;
  const now = Date.now();
  const recent = S.builds.filter(function (b) { return now - Number(b.created_at) < 7 * 864e5; });
  const done = recent.filter(function (b) { return b.status === 'success' || b.status === 'failed'; });
  const ok = recent.filter(function (b) { return b.status === 'success'; });
  const rate = done.length ? Math.round((ok.length / done.length) * 100) : null;
  const durs = ok.map(function (b) { return Number(b.updated_at) - Number(b.created_at); }).filter(function (n) { return n > 0; });
  const avg = durs.length ? Math.round(durs.reduce(function (a, b) { return a + b; }, 0) / durs.length / 60000) : null;
  const act = activeBuilds().length;
  const plats = {};
  S.templates.forEach(function (t) { plats[String(t.target || '').split('/')[0]] = 1; });

  const stats = '<div class="stats fade-up">' +
    statCard('TEMPLATES', S.templates.length, '个', '覆盖 ' + Object.keys(plats).filter(Boolean).length + ' 个平台家族') +
    statCard('BUILDING', act, '个', act ? '队列占用中' : '队列空闲') +
    statCard('SUCCESS · 7D', ok.length, '次', rate === null ? '最近没有完成的编译' : '<b class="' + (rate < 60 ? 'bad' : '') + '">' + rate + '%</b> 成功率') +
    statCard('AVG TIME', avg === null ? '—' : avg, avg === null ? '' : '分', '最近 7 次成功编译的平均耗时') +
  '</div>';

  if (!S.templates.length) {
    area.innerHTML = stats + '<div class="empty" style="margin-top:16px"><div class="g">' + ic('layers') + '</div>' +
      '<div class="m">还没有任何模板</div><div class="s">去插件商店选好机型和插件，点「生成模板」就能得到第一个</div>' +
      '<button class="btn btn-primary" style="margin-top:16px" id="emptyNew">' + ic('plus') + '新建模板</button></div>';
    const b = $('#emptyNew'); if (b) b.addEventListener('click', function () { nav('#/store'); });
    return;
  }

  const cards = S.templates.map(function (t) {
    const live = S.builds.filter(function (b) { return b.template_id === t.id && ACTIVE.indexOf(b.status) >= 0; })[0];
    const last = live || lastBuildOf(t.id);
    const st = last ? (ST[last.status] || ST.never) : ST.never;
    const ids = (t.selection && t.selection.length) ? t.selection : (t.packages || []);
    const shown = ids.slice(0, 4);
    const chips = shown.map(function (id) {
      const p = pluginById(id);
      return '<span class="chip"><span class="dot" style="background:' + catFg(p ? p.cat : '自定义') + '"></span>' + esc(p ? p.name : id) + '</span>';
    }).join('');
    return '<article class="tpl" data-tpl="' + t.id + '">' +
      '<div class="tpl-top"><div style="min-width:0">' +
        '<div class="tpl-name">' + esc(t.name) + '</div>' +
        '<div class="tpl-dev">' + esc(t.target || '未选平台') + (t.profile ? ' <i>/</i> ' + esc(t.profile) : '') + (t.branch ? ' <i>@</i> ' + esc(t.branch) : '') + '</div>' +
      '</div><span class="pill ' + st.cls + '">' + (live ? '编译中' : st.t) + '</span></div>' +
      '<div class="tpl-chips">' + (chips || '<span class="chip">未选插件</span>') +
        (ids.length > 4 ? '<span class="chip">+' + (ids.length - 4) + '</span>' : '') + '</div>' +
      '<div class="tpl-foot">' +
        '<span class="last">' + ic('clock') + (last ? (live ? '进行中 · ' + buildTime(live) : fmtRel(last.created_at)) : '尚未编译') + '</span>' +
        (t.schedule_enabled ? '<span class="tag">' + ic('refresh') + esc(t.schedule_cron || '定时') + '</span>' : '') +
        (t.pin_dotconfig_version_id ? '<span class="tag">' + ic('lock') + '固定配置</span>' : '') +
        '<span class="spacer"></span>' +
        '<button class="btn btn-sm btn-soft" data-tpl-build="' + t.id + '">' + ic('play') + '编译</button>' +
      '</div></article>';
  }).join('');

  const recentList = S.builds.slice(0, 4).map(function (b) { return buildCard(b, true); }).join('');
  area.innerHTML = stats +
    '<div class="tpl-grid stagger">' + cards + '</div>' +
    '<button class="tpl-new" id="tplNew2"><span class="circle">' + ic('plus') + '</span><span>新建模板</span><small>去插件商店选机型和插件</small></button>' +
    '<section class="card" style="margin-top:22px">' +
      '<div class="card-head"><div><h2>最近编译</h2><div class="sub">所有模板的最新任务</div></div>' +
      '<div class="right"><button class="btn btn-sm btn-ghost" data-nav2="builds">查看全部' + ic('right') + '</button></div></div>' +
      '<div style="padding:12px 12px 4px">' + (recentList || '<div class="basket-empty">还没有编译记录</div>') + '</div>' +
    '</section>';

  $('#tplNew2').addEventListener('click', function () { nav('#/store'); });
  const more = $('[data-nav2]', area); if (more) more.addEventListener('click', function () { nav('#/builds'); });
  $$('[data-tpl]', area).forEach(function (card) {
    card.addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-tpl-build]');
      if (b) { ev.stopPropagation(); triggerBuild(b.dataset.tplBuild, b); return; }
      nav('#/template/' + card.dataset.tpl);
    });
  });
  drawQueue();
}
function statCard(k, v, unit, desc) {
  return '<div class="stat"><div class="stat-k">' + k + '</div><div class="stat-v">' + v + (unit ? '<small>' + unit + '</small>' : '') + '</div><div class="stat-d">' + desc + '</div></div>';
}

async function triggerBuild(id, btn) {
  const t = tplById(id);
  const ok = await confirmBox({
    title: '开始编译',
    body: (t ? '「' + t.name + '」' : '该模板') + ' 会立刻提交到 GitHub Actions，一般 40 分钟到 1 小时出结果。',
    ok: '开始编译',
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await api.trigger(id);
    toast('已提交编译任务', '可以在编译记录里看进度', 'info');
    await refreshBuilds();
    nav('#/builds');
  } catch (e) {
    fail(e, '提交失败');
    if (btn) btn.disabled = false;
  }
}

/* ---------------- 模板详情 ---------------- */
function tplConfigLines(tpl) {
  const lines = [];
  const tp = String(tpl.target || '').split('/');
  if (tpl.profile && tp.length === 2) {
    lines.push('CONFIG_TARGET_' + tp[0] + '=y');
    lines.push('CONFIG_TARGET_' + tp[0] + '_' + tp[1] + '=y');
    lines.push('CONFIG_TARGET_' + tp[0] + '_' + tp[1] + '_DEVICE_' + tpl.profile + '=y');
  }
  (tpl.packages || []).forEach(function (p) { lines.push('CONFIG_PACKAGE_' + p + '=y'); });
  return lines.join('\n');
}
function composeFromSelection(ids, tpl) {
  const S2 = ids.map(function (id) { return pluginById(id) || synthPlugin(id, tpl.plugins); });
  const pk = {};
  S2.forEach(function (p) { pk[p.id] = 1; (p.requires || []).forEach(function (r) { pk[r] = 1; }); });
  return { selection: ids, packages: Object.keys(pk), plugins: mergePlugins(S2) };
}

async function viewDetail(id) {
  const view = $('#view');
  view.innerHTML = '<div class="crumbs"><a href="#/templates">模板</a>' + ic('right') + '<span>加载中…</span></div>' +
    '<div class="loading">' + ic('refresh') + '<span>读取模板…</span></div>';
  let tpl, history, caches;
  try {
    const r = await Promise.all([api.template(id), api.history(id), api.caches().catch(function () { return { caches: [] }; })]);
    tpl = r[0].template;
    history = r[1].history || [];
    caches = r[2].caches || [];
  } catch (e) {
    view.innerHTML = '<div class="empty"><div class="g">' + ic('alert') + '</div><div class="m">模板读取失败</div><div class="s">' + esc(e.message) + '</div>' +
      '<button class="btn" style="margin-top:16px" id="backTpl">返回模板列表</button></div>';
    const b = $('#backTpl'); if (b) b.addEventListener('click', function () { nav('#/templates'); });
    return;
  }
  try { await ensureCatalog(false); } catch (e) { /* 目录不可用时仍显示包名 */ }
  if (S.route.name !== 'template' || S.route.params.id !== id) return;
  renderDetail(tpl, history, caches);
}

function renderDetail(tpl, history, caches) {
  const view = $('#view');
  const ids = (tpl.selection && tpl.selection.length) ? tpl.selection : null;
  const total = (tpl.packages || []).length;
  const live = S.builds.filter(function (b) { return b.template_id === tpl.id && ACTIVE.indexOf(b.status) >= 0; })[0];
  const pinned = tpl.pin_dotconfig_version_id ? history.filter(function (h) { return h.id === tpl.pin_dotconfig_version_id; })[0] : null;
  const cacheLabel = !tpl.cache_use ? '未使用缓存' : tpl.cache_use === 'latest' ? '同平台最新缓存' : '指定的缓存';

  view.innerHTML =
    '<div class="crumbs"><a href="#/templates">模板</a>' + ic('right') + '<span>' + esc(tpl.name) + '</span></div>' +
    '<header class="hero fade-up">' +
      '<div class="hero-main">' +
        '<div class="eyebrow">TEMPLATE <b>/</b> ' + esc(tpl.id.slice(0, 8)) + '</div>' +
        '<h1>' + esc(tpl.name) + '</h1>' +
        '<div class="meta">' +
          '<span class="tag">' + ic('branch') + esc(tpl.branch || '—') + '</span>' +
          '<span class="tag">' + esc(tpl.target || '未选平台') + (tpl.profile ? ' / ' + esc(tpl.profile) : '') + '</span>' +
          '<span class="tag">' + ic('box') + (ids ? ids.length : total) + ' 个插件</span>' +
          (tpl.menuconfig ? '<span class="tag">' + ic('terminal') + 'menuconfig</span>' : '') +
          (tpl.schedule_enabled ? '<span class="tag">' + ic('clock') + '定时 ' + esc(tpl.schedule_cron || '') + '</span>' : '') +
          (tpl.pin_dotconfig_version_id ? '<span class="tag">' + ic('lock') + '固定底稿</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="hero-actions">' +
        '<button class="btn" id="editInfo">' + ic('edit') + '名称与脚本</button>' +
        '<button class="btn" id="editStore">' + ic('grid') + '编辑机型和插件</button>' +
        '<button class="btn btn-primary btn-lg" id="goBuild">' + ic('play') + (live ? '再编译一次' : '编译') + '</button>' +
      '</div>' +
      '<div class="kv">' +
        kv('源码仓库', esc(String(tpl.repo_url || '').replace('https://github.com/', '')), 'mono') +
        kv('平台 / 机型', esc((tpl.target || '—') + (tpl.profile ? ' / ' + tpl.profile : '')), 'mono') +
        kv('编译缓存', cacheLabel) +
        kv('配置底稿', pinned ? '固定于 ' + fmtTime(pinned.created_at) : '跟随清单') +
        kv('定时编译', tpl.schedule_enabled ? esc(tpl.schedule_cron || '已开启') : '未开启') +
      '</div>' +
    '</header>' +
    '<div class="detail-grid">' +
      '<div class="stack">' +

        '<section class="card" id="manifestCard"><div class="card-head"><div><h2>固件清单</h2>' +
          '<div class="sub">' + (ids ? ids.length + ' 个插件，共 ' + total + ' 个包（含自动依赖）' : '这个模板没有记录插件选择') + '</div></div>' +
          '<div class="right"><button class="btn btn-sm btn-ghost" id="addPlugin">' + ic('plus') + '添加</button></div></div>' +
          '<div class="card-pad" id="manifestBody"></div></section>' +

        '<section class="card" id="optCard"><div class="card-head"><div><h2>编译选项</h2><div class="sub">影响下一次编译，保存后立即生效</div></div></div>' +
          '<div class="card-pad" id="optBody"></div></section>' +

        '<section class="card" id="schedCard"><div class="card-head"><div><h2>定时编译</h2><div class="sub">到点自动按当前模板编一份</div></div>' +
          (tpl.schedule_enabled ? '<span class="pill ok">已开启</span>' : '<span class="pill plain">未开启</span>') + '</div>' +
          '<div class="card-pad" id="schedBody"></div></section>' +

        '<section class="card" id="historyCard"><div class="card-head"><div><h2>.config 版本历史</h2><div class="sub">menuconfig 保存的结果和手动上传的配置都留在这里</div></div>' +
          '<div class="right"><button class="btn btn-sm" id="uploadCfg">' + ic('plus') + '上传新版本</button></div></div>' +
          '<div id="historyBody"></div></section>' +

      '</div>' +
      '<aside class="side-col">' +
        '<section class="card"><div class="card-head"><div><h2>下一次编译</h2></div></div>' +
          '<div class="card-pad" id="nextBody"></div></section>' +
        '<section class="card"><div class="card-head"><div><h2>编译记录</h2><div class="sub">最近 5 次</div></div>' +
          '<div class="right"><button class="btn btn-sm btn-ghost" id="allBuilds">全部' + ic('right') + '</button></div></div>' +
          '<div style="padding:10px 10px 4px" id="tplBuilds"></div></section>' +
        '<section class="card"><div class="card-head"><div><h2>模板</h2></div></div>' +
          '<div class="card-pad" style="display:flex;flex-direction:column;gap:8px">' +
            '<button class="btn btn-block" id="exportTpl">' + ic('download') + '导出模板文件</button>' +
            '<button class="btn btn-block btn-danger" id="delTpl">' + ic('trash') + '删除这个模板</button>' +
          '</div></section>' +
      '</aside>' +
    '</div>';

  $('#editInfo').addEventListener('click', function () { openInfoModal(tpl); });
  $('#editStore').addEventListener('click', function () { nav('#/store/' + tpl.id); });
  $('#addPlugin').addEventListener('click', function () { nav('#/store/' + tpl.id); });
  $('#goBuild').addEventListener('click', function (ev) {
    const b = ev.currentTarget;
    b.disabled = true;
    api.trigger(tpl.id).then(function () {
      toast('已提交编译任务', '可以在编译记录里看进度', 'info');
      return refreshBuilds();
    }).then(function () { nav('#/builds'); }).catch(function (e) { fail(e, '提交失败'); b.disabled = false; });
  });
  $('#allBuilds').addEventListener('click', function () { nav('#/builds'); });
  $('#exportTpl').addEventListener('click', function () { exportTemplate(tpl); });
  $('#delTpl').addEventListener('click', function () { delTemplate(tpl); });
  $('#uploadCfg').addEventListener('click', function () { openUploadConfig(tpl); });

  drawManifest(tpl);
  drawOptions(tpl, history, caches);
  drawSchedule(tpl, history);
  drawHistory(tpl, history);
  drawNext(tpl, pinned);
  drawTplBuilds(tpl);
}
function kv(k, v, cls) {
  return '<div><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + (cls === 'mono' ? v : esc(v)) + '</div></div>';
}

function drawManifest(tpl) {
  const box = $('#manifestBody');
  if (!box) return;
  const ids = (tpl.selection && tpl.selection.length) ? tpl.selection : null;
  let h = '';
  if (ids) {
    h += '<div class="chip-box">' + ids.map(function (id) {
      const p = pluginById(id);
      const cat = p ? p.cat : '自定义';
      return '<span class="chip" style="border-color:' + catFg(cat) + '33"><span class="dot" style="background:' + catFg(cat) + '"></span>' +
        esc(p ? p.name : id) + (p && p.custom ? ' <small>自定义</small>' : '') + (!p ? ' <small>目录已无</small>' : '') +
        '<button class="x" data-rmplugin="' + esc(id) + '" title="移除">' + ic('x') + '</button></span>';
    }).join('') + '</div>';
    h += '<div class="hint" style="margin-top:10px">移除后会自动重算包清单，点 × 立即保存。要加插件请点右上角「添加」。</div>';
  } else if ((tpl.packages || []).length) {
    h += '<div class="hint">这个模板是旧版本创建的，没有记录插件选择。点「编辑机型和插件」重新选一次并保存，就能在这里管理。</div>';
    h += '<div class="code" style="margin-top:10px;white-space:pre-wrap">' + esc((tpl.packages || []).join(', ')) + '</div>';
  } else {
    h += '<div class="hint">还没有插件清单。</div>';
  }
  if ((tpl.plugins || []).length) {
    h += '<div class="src-list"><div class="hint">第三方来源（' + tpl.plugins.length + '）</div>' + tpl.plugins.map(function (p) {
      const where = p.feed ? p.feed : (p.git_url || '') + (p.sparse ? ' · ' + (p.dirs || []).join(', ') : '');
      return '<div class="src-row">' + ic('git') + '<code>' + esc(p.name) + '</code><span>' + esc(where) + '</span>' + (p.branch ? '<span class="tag">' + esc(p.branch) + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  h += '<details class="fold" style="margin-top:12px"><summary>' + ic('right') + '查看将写入的配置行</summary>' +
    '<pre class="code">' + esc(tplConfigLines(tpl)) + '</pre>' +
    '<div class="hint">编译时先生成该机型的默认配置，再合并这些行并校验是否全部生效；有没生效的会直接失败并指出是哪几项。</div></details>';
  box.innerHTML = h;
  $$('[data-rmplugin]', box).forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!tpl.selection) return;
      const next = tpl.selection.filter(function (x) { return x !== b.dataset.rmplugin; });
      try {
        await api.updateTemplate(tpl.id, composeFromSelection(next, tpl));
        toast('已移除', '包清单已重新计算', 'info');
        viewDetail(tpl.id);
      } catch (e) { fail(e, '移除失败'); }
    });
  });
}

function drawOptions(tpl, history, caches) {
  const box = $('#optBody');
  if (!box) return;
  const pin = tpl.pin_dotconfig_version_id || '';
  box.innerHTML =
    optRow('编译前进入 menuconfig', '默认不需要。只有要改内核或驱动时才开；定时编译不会进入 menuconfig。',
      '<label class="switch"><input type="checkbox" id="optMenu"' + (tpl.menuconfig ? ' checked' : '') + '><span class="track"></span></label>') +
    optRow('配置底稿', '固定后编译直接使用该 .config，不再叠加机型和插件清单。menuconfig 保存的配置不会自动固定，要沿用请在这里选。',
      '<select class="select" id="optPin"><option value="">不固定（推荐）· 每次按清单生成</option>' +
      history.map(function (v) {
        const label = (SOURCE_LABELS[v.source] || v.source) + ' · ' + fmtTime(v.created_at) + (v.label ? ' · ' + v.label : '');
        return '<option value="' + v.id + '"' + (v.id === pin ? ' selected' : '') + '>固定为：' + esc(label) + '</option>';
      }).join('') + '</select>') +
    optRow('编译缓存 ccache', '缓存只存在于编译机上，必须在编译开始前选好；第一次发布缓存的那次编译不会更快。',
      '<select class="select" id="optCache"><option value="">不使用缓存</option><option value="latest"' + (tpl.cache_use === 'latest' ? ' selected' : '') + '>同平台最新缓存</option>' +
      (caches || []).map(function (c) {
        return '<option value="' + c.id + '"' + (tpl.cache_use === c.id ? ' selected' : '') + '>指定：' + esc(fmtTime(c.cache_at) + ' · ' + (c.template_name || '已删除的模板') + ' · ' + fmtSize(c.cache_size)) + '</option>';
      }).join('') +
      (tpl.cache_use && tpl.cache_use !== 'latest' && !(caches || []).some(function (c) { return c.id === tpl.cache_use; }) ?
        '<option value="' + esc(tpl.cache_use) + '" selected>指定的缓存已被清理（不使用）</option>' : '') +
      '</select>') +
    optRow('编译完成后发布缓存', '把这次的 ccache 打包发到编译仓库的 Release，下次编同机型可直接复用。最多保留 2 份。',
      '<label class="switch"><input type="checkbox" id="optPub"' + (tpl.cache_publish ? ' checked' : '') + '><span class="track"></span></label>');

  $('#optMenu').addEventListener('change', async function (e) {
    try { await api.updateTemplate(tpl.id, { menuconfig: e.target.checked }); toast(e.target.checked ? '编译时将进入 menuconfig' : '编译时不进入 menuconfig', '', 'info'); }
    catch (err) { fail(err, '保存失败'); e.target.checked = !e.target.checked; }
  });
  $('#optPin').addEventListener('change', async function (e) {
    try { await api.updateTemplate(tpl.id, { pin_dotconfig_version_id: e.target.value }); toast(e.target.value ? '已固定配置底稿' : '已取消固定'); viewDetail(tpl.id); }
    catch (err) { fail(err, '保存失败'); }
  });
  $('#optCache').addEventListener('change', async function (e) {
    try { await api.updateTemplate(tpl.id, { cache_use: e.target.value }); toast(e.target.value ? '下次编译将使用缓存' : '下次编译不使用缓存', '', 'info'); }
    catch (err) { fail(err, '保存失败'); }
  });
  $('#optPub').addEventListener('change', async function (e) {
    try { await api.updateTemplate(tpl.id, { cache_publish: e.target.checked }); toast(e.target.checked ? '编译完成后将发布缓存' : '编译完成后不发布缓存', '', 'info'); }
    catch (err) { fail(err, '保存失败'); e.target.checked = !e.target.checked; }
  });
}
function optRow(title, desc, control) {
  return '<div class="opt-row"><div><div class="t">' + title + '</div><div class="d">' + desc + '</div></div><div class="c">' + control + '</div></div>';
}

function drawSchedule(tpl, history) {
  const box = $('#schedBody');
  if (!box) return;
  const pinned = !!tpl.pin_dotconfig_version_id;
  box.innerHTML =
    '<div class="sched-row">' +
      '<label class="switch"><input type="checkbox" id="schOn"' + (tpl.schedule_enabled ? ' checked' : '') + '><span class="track"></span></label>' +
      '<span class="sched-label">启用定时编译</span>' +
      '<input class="input mono" id="schCron" value="' + esc(tpl.schedule_cron || '') + '" placeholder="0 2 * * *" style="max-width:180px" />' +
      '<button class="btn btn-sm" id="schSave">保存</button>' +
    '</div>' +
    '<div class="cron-presets">' + CRON_PRESETS.map(function (p) { return '<button class="cat" data-cron="' + p.cron + '">' + p.label + '</button>'; }).join('') + '</div>' +
    '<div class="hint">' + (pinned ? '当前固定了配置底稿，定时编译直接使用该版本。' : '当前没有固定底稿，每次定时编译都按机型和插件清单重新生成配置。') +
    'Cloudflare 免费计划最多 3 个 cron 槽位，实际触发有约 30 秒抖动。</div>';
  $$('[data-cron]', box).forEach(function (b) { b.addEventListener('click', function () { $('#schCron').value = b.dataset.cron; }); });
  $('#schSave').addEventListener('click', async function (ev) {
    const on = $('#schOn').checked, cron = $('#schCron').value.trim();
    if (on && !cron) { toast('请填写 cron 表达式', '', 'err'); return; }
    ev.currentTarget.disabled = true;
    try { await api.setSchedule(tpl.id, { enabled: on, cron: cron || null }); toast('定时设置已保存'); viewDetail(tpl.id); }
    catch (e) { fail(e, '保存失败'); ev.currentTarget.disabled = false; }
  });
}

function drawNext(tpl, pinned) {
  const box = $('#nextBody');
  if (!box) return;
  box.innerHTML =
    '<div class="next-row"><span class="k">触发方式</span><span class="v">' + (tpl.schedule_enabled ? '手动 / 定时' : '仅手动') + '</span></div>' +
    '<div class="next-row"><span class="k">配置来源</span><span class="v">' + (pinned ? '固定底稿 ' + fmtTime(pinned.created_at) : '按机型与插件生成') + '</span></div>' +
    '<div class="next-row"><span class="k">缓存</span><span class="v">' + (!tpl.cache_use ? '不使用' : tpl.cache_use === 'latest' ? '同平台最新' : '指定缓存') + '</span></div>' +
    '<div class="next-row"><span class="k">发布缓存</span><span class="v">' + (tpl.cache_publish ? '是' : '否') + '</span></div>' +
    '<div class="next-row"><span class="k">menuconfig</span><span class="v">' + (tpl.menuconfig ? '编译前进入' : '跳过') + '</span></div>' +
    '<div class="next-note">' + ic('info') + '<span>同一时间只跑一个任务，已有任务在执行时新任务会排队。</span></div>';
}

function drawTplBuilds(tpl) {
  const box = $('#tplBuilds');
  if (!box) return;
  const list = S.builds.filter(function (b) { return b.template_id === tpl.id; }).slice(0, 5);
  box.innerHTML = list.length ? list.map(function (b) { return buildCard(b, true); }).join('') : '<div class="basket-empty">这个模板还没有编译过</div>';
}

function drawHistory(tpl, history) {
  const box = $('#historyBody');
  if (!box) return;
  if (!history.length) {
    box.innerHTML = '<div class="card-pad"><div class="empty" style="padding:30px 16px"><div class="g">' + ic('list') + '</div>' +
      '<div class="m">暂无 .config 版本</div><div class="s">编译时进 menuconfig 保存退出，或手动上传一份</div></div></div>';
    return;
  }
  const rows = history.map(function (v, i) {
    const isCur = tpl.dotconfig_version_id === v.id;
    const isPin = tpl.pin_dotconfig_version_id === v.id;
    return '<tr data-vid="' + v.id + '">' +
      '<td class="mono dim">' + (history.length - i) + '</td>' +
      '<td><span class="tag">' + esc(SOURCE_LABELS[v.source] || v.source) + '</span></td>' +
      '<td class="mono dim" style="white-space:nowrap">' + fmtTime(v.created_at) + '</td>' +
      '<td><div class="label-cell"><span class="label-text">' + esc(v.label || '—') + '</span><button class="icon-btn" data-vact="label" title="编辑备注">' + ic('edit') + '</button></div></td>' +
      '<td>' + (isCur ? '<span class="ref-tag">当前</span>' : '') + (isPin ? '<span class="ref-tag sched">固定</span>' : '') + '</td>' +
      '<td><div class="row-ops">' +
        '<button class="lnk" data-vact="view">查看</button>' +
        (isCur ? '' : '<button class="lnk" data-vact="current">设为当前</button>') +
        (isPin ? '<button class="lnk" data-vact="unpin">取消固定</button>' : '<button class="lnk" data-vact="pin">固定底稿</button>') +
        '<button class="lnk danger" data-vact="del"' + (!isCur && !isPin ? '' : ' disabled title="请先取消引用"') + '>删除</button>' +
      '</div></td></tr>';
  }).join('');
  box.innerHTML = '<div style="overflow-x:auto"><table class="vtable"><thead><tr><th>#</th><th>来源</th><th>时间</th><th>备注</th><th>引用</th><th style="text-align:right">操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

  $$('tr[data-vid]', box).forEach(function (row) {
    const vid = row.dataset.vid;
    const meta = history.filter(function (h) { return h.id === vid; })[0];
    $$('[data-vact]', row).forEach(function (btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', async function () {
        const act = btn.dataset.vact;
        if (act === 'view') return openVersionView(tpl.id, vid, meta);
        if (act === 'download') return downloadVersion(tpl.id, vid);
        if (act === 'label') return editLabel(tpl.id, vid, row, meta);
        if (act === 'current') { try { await api.setCurrentDotconfig(tpl.id, vid); toast('已设为当前版本'); viewDetail(tpl.id); } catch (e) { fail(e, '设置失败'); } return; }
        if (act === 'pin') { try { await api.updateTemplate(tpl.id, { pin_dotconfig_version_id: vid }); toast('已固定为配置底稿'); viewDetail(tpl.id); } catch (e) { fail(e, '设置失败'); } return; }
        if (act === 'unpin') { try { await api.updateTemplate(tpl.id, { pin_dotconfig_version_id: '' }); toast('已取消固定'); viewDetail(tpl.id); } catch (e) { fail(e, '设置失败'); } return; }
        if (act === 'del') {
          const ok = await confirmBox({ title: '删除版本', body: '确定删除这份 .config 历史版本？此操作不可恢复。', ok: '删除', danger: true });
          if (!ok) return;
          try { await api.deleteVersion(tpl.id, vid); toast('版本已删除'); viewDetail(tpl.id); } catch (e) { fail(e, '删除失败'); }
        }
      });
    });
  });
}

function openVersionView(tplId, vid, meta) {
  openModal('<div class="modal" style="max-width:720px"><div class="modal-head"><h3>.config 内容' + (meta && meta.label ? ' · ' + esc(meta.label) : '') + '</h3>' +
    '<button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body"><pre class="code" id="verBody" style="max-height:56vh">读取中…</pre></div>' +
    '<div class="modal-foot"><button class="btn" data-close>关闭</button><button class="btn btn-primary" id="verDl">' + ic('download') + '下载</button></div></div>', {
    onMount: function (root) {
      api.historyVersion(tplId, vid).then(function (r) { $('#verBody', root).textContent = r.version.content; })
        .catch(function (e) { $('#verBody', root).textContent = '读取失败：' + e.message; });
      $('#verDl', root).addEventListener('click', function () { downloadVersion(tplId, vid); });
    },
  });
}
async function downloadVersion(tplId, vid) {
  try {
    const r = await api.historyVersion(tplId, vid);
    downloadBlob(new Blob([r.version.content], { type: 'text/plain' }), '.config');
  } catch (e) { fail(e, '下载失败'); }
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function editLabel(tplId, vid, row, meta) {
  const cell = $('.label-cell', row);
  if (!cell) return;
  cell.innerHTML = '<input class="input" style="padding:3px 7px;font-size:12px" value="' + esc(meta && meta.label ? meta.label : '') + '" />' +
    '<button class="btn btn-sm" data-save>保存</button>';
  const input = $('input', cell);
  input.focus();
  const save = async function () {
    try { await api.patchLabel(tplId, vid, input.value.trim()); toast('备注已更新'); viewDetail(tplId); }
    catch (e) { fail(e, '保存失败'); }
  };
  $('[data-save]', cell).addEventListener('click', save);
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') save(); });
}

function openUploadConfig(tpl) {
  openModal('<div class="modal" style="max-width:640px"><div class="modal-head"><h3>上传 .config 版本</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body">' +
      '<div class="field"><label>选择文件（也可以直接粘贴到下面）</label><input type="file" id="cfgFile" accept=".config,text/plain" /></div>' +
      '<div class="field"><label>.config 内容</label><textarea class="input mono" id="cfgText" rows="12" placeholder="CONFIG_TARGET_xxx=y"></textarea></div>' +
      '<div class="field"><label>备注（可选）</label><input class="input" id="cfgLabel" placeholder="例如：稳定版" /></div>' +
    '</div><div class="modal-foot"><button data-close>取消</button><button class="btn btn-primary" id="cfgUp">上传</button></div></div>', {
    onMount: function (root) {
      $('#cfgFile', root).addEventListener('change', async function (ev) {
        const f = ev.target.files[0];
        if (f) $('#cfgText', root).value = await f.text();
      });
      $('#cfgUp', root).addEventListener('click', async function (ev) {
        const content = $('#cfgText', root).value;
        if (!content.trim()) { toast('内容不能为空', '', 'err'); return; }
        ev.currentTarget.disabled = true;
        try {
          await api.uploadDotconfig(tpl.id, { content: content, label: $('#cfgLabel', root).value.trim() || undefined });
          toast('上传成功');
          closeModal(root);
          viewDetail(tpl.id);
        } catch (e) { fail(e, '上传失败'); ev.currentTarget.disabled = false; }
      });
    },
  });
}

function openInfoModal(tpl) {
  openModal('<div class="modal" style="max-width:600px"><div class="modal-head"><h3>名称与自定义脚本</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body">' +
      '<div class="field"><label>模板名称</label><input class="input" id="nmInput" maxlength="80" value="' + esc(tpl.name) + '" /></div>' +
      '<div class="field"><label>自定义脚本① · feeds update 之前</label><textarea class="input mono" id="sc1" rows="5" placeholder="#!/bin/bash">' + esc(tpl.diy_script_1 || '') + '</textarea></div>' +
      '<div class="field"><label>自定义脚本② · feeds install 之后</label><textarea class="input mono" id="sc2" rows="5" placeholder="#!/bin/bash">' + esc(tpl.diy_script_2 || '') + '</textarea></div>' +
      '<div class="hint">机型和插件请用「编辑机型和插件」回到商店修改。</div>' +
    '</div><div class="modal-foot"><button data-close>取消</button><button class="btn btn-primary" id="nmSave">保存更改</button></div></div>', {
    onMount: function (root) {
      $('#nmSave', root).addEventListener('click', async function (ev) {
        const name = $('#nmInput', root).value.trim();
        if (!name) { toast('请填写模板名称', '', 'err'); return; }
        ev.currentTarget.disabled = true;
        try {
          await api.updateTemplate(tpl.id, { name: name, diy_script_1: $('#sc1', root).value, diy_script_2: $('#sc2', root).value });
          toast('模板已更新');
          closeModal(root);
          viewDetail(tpl.id);
        } catch (e) { fail(e, '保存失败'); ev.currentTarget.disabled = false; }
      });
    },
  });
}

async function exportTemplate(tpl) {
  try {
    const resp = await fetch('/api/templates/' + tpl.id + '/export', { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('导出失败 (' + resp.status + ')');
    downloadBlob(await resp.blob(), tpl.name + '.openwrt-template.json');
    toast('已导出模板文件');
  } catch (e) { fail(e, '导出失败'); }
}
async function delTemplate(tpl) {
  const ok = await confirmBox({ title: '删除模板', body: '确定删除「' + tpl.name + '」？关联的 .config 历史版本会一并删除，无法恢复。', ok: '删除', danger: true });
  if (!ok) return;
  try { await api.deleteTemplate(tpl.id); toast('模板已删除'); nav('#/templates'); }
  catch (e) { fail(e, '删除失败'); }
}

function openImportModal() {
  openModal('<div class="modal" style="max-width:520px"><div class="modal-head"><h3>导入模板</h3><button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
    '<div class="modal-body"><div class="field"><label>选择 .openwrt-template.json</label><input type="file" id="impFile" accept=".json,application/json" /></div>' +
    '<div class="hint">导入会新建一个模板；与现有模板重名时自动加「(导入)」后缀。</div><div class="auth-err" id="impErr" hidden></div></div>' +
    '<div class="modal-foot"><button data-close>取消</button><button class="btn btn-primary" id="impGo" disabled>导入</button></div></div>', {
    onMount: function (root) {
      let parsed = null;
      const err = $('#impErr', root), go = $('#impGo', root);
      $('#impFile', root).addEventListener('change', async function (ev) {
        err.hidden = true; go.disabled = true; parsed = null;
        const f = ev.target.files[0];
        if (!f) return;
        try {
          parsed = JSON.parse(await f.text());
          if (parsed.export_version !== 1) throw new Error('不支持的 export_version: ' + parsed.export_version);
          go.disabled = false;
        } catch (e) { err.textContent = '文件解析失败：' + e.message; err.hidden = false; }
      });
      go.addEventListener('click', async function () {
        if (!parsed) return;
        go.disabled = true; go.textContent = '导入中…';
        try {
          const r = await api.importTemplate(parsed);
          toast('模板导入成功');
          closeModal(root);
          nav('#/template/' + r.template.id);
        } catch (e) { err.textContent = e.message || '导入失败'; err.hidden = false; go.disabled = false; go.textContent = '导入'; }
      });
    },
  });
}

/* ---------------- 编译记录操作（全局委托） ---------------- */
document.addEventListener('click', async function (ev) {
  const el = ev.target.closest ? ev.target.closest('[data-bact]') : null;
  if (!el) return;
  const id = el.dataset.id;
  const act = el.dataset.bact;
  if (act === 'cancel') {
    const ok = await confirmBox({ title: '取消编译', body: '取消后这次任务会标记为已取消，已经跑起来的 GitHub Actions 任务会一并取消。', ok: '取消任务', danger: true });
    if (!ok) return;
    try {
      const r = await api.cancel(id);
      if (r.github_cancel_warning) toast('已在本系统标记为取消', r.github_cancel_warning, 'err');
      else toast('已取消');
      await refreshBuilds();
      rerenderCurrent();
    } catch (e) { fail(e, '取消失败'); }
    return;
  }
  if (act === 'pub') {
    el.disabled = true;
    try {
      await api.setCachePublish(id, el.dataset.on !== '1');
      toast(el.dataset.on === '1' ? '已取消发布缓存' : '编译完成后将发布缓存');
      await refreshBuilds();
      rerenderCurrent();
    } catch (e) { fail(e, '设置失败'); el.disabled = false; }
    return;
  }
  if (act === 'cfg') {
    const kind = el.dataset.kind;
    openModal('<div class="modal" style="max-width:720px"><div class="modal-head"><h3>' + (kind === 'result' ? '最终配置（menuconfig 保存退出时推送）' : '触发时的配置底稿') + '</h3>' +
      '<button class="btn btn-sm btn-ghost" data-close>' + ic('x') + '</button></div>' +
      '<div class="modal-body"><pre class="code" id="bcfg" style="max-height:56vh">读取中…</pre></div>' +
      '<div class="modal-foot"><button class="btn" data-close>关闭</button></div></div>', {
      onMount: function (root) {
        api.build(id).then(function (r) {
          const text = kind === 'result' ? r.build.dotconfig_result : r.build.dotconfig_snapshot;
          $('#bcfg', root).textContent = text || '（这次编译没有记录配置）';
        }).catch(function (e) { $('#bcfg', root).textContent = '读取失败：' + e.message; });
      },
    });
  }
});
