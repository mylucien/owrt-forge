// ============================================================
// OpenWrt 自动编译系统 — Cloudflare Worker
// 单文件部署版本：直接粘贴到 Cloudflare Worker 在线编辑器即可
//
// 部署前需要：
// 1. 创建 D1 数据库，执行下方 system_config 建表 SQL（以及原有 templates /
//    builds / dotconfig_history 表，见设计文档）
// 2. 在 Worker 设置中绑定 D1 数据库，变量名必须为 DB
// 3. 配置唯一一个 Secret：
//    MASTER_KEY — 任意长随机字符串，用于加密 D1 中的敏感配置，并派生 session 签名密钥。
//    登录密码、GitHub 仓库/Token、Worker URL、REPORT_TOKEN 等全部通过网页"系统初始化"
//    与"部署向导"在线填写并加密存入 D1，不再需要在 Cloudflare 里逐项配置 Secret/变量。
// 4. 如需定时编译，在 wrangler.toml 或 Worker 设置中配置 Cron Triggers
//
// system_config 建表 SQL：
//   CREATE TABLE IF NOT EXISTS system_config (
//     key   TEXT PRIMARY KEY,
//     value TEXT NOT NULL
//   );
// ============================================================

// ============================================================
// 基础工具函数
// ============================================================
function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    });
  }
  
  function err(message, status = 400) {
    return json({ error: message }, status);
  }
  
  function uuid() {
    return crypto.randomUUID();
  }
  
  function now() {
    return Date.now();
  }
  
  // 简单的 cookie 解析
  function parseCookies(request) {
    const header = request.headers.get('Cookie') || '';
    const out = {};
    header.split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
    return out;
  }
  
  // HMAC-SHA256 签名 session token，避免引入额外依赖，不需要存储 session 到 D1
  async function hmacSign(value, secret) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  
  async function createSessionToken(env) {
    const issuedAt = now();
    const payload = `session:${issuedAt}`;
    const secret = await deriveSessionSecret(env);
    const sig = await hmacSign(payload, secret);
    return `${payload}:${sig}`;
  }
  
  async function verifySessionToken(token, env) {
    if (!token) return false;
    // 修复：用 lastIndexOf 拆出最后一个冒号之前/后的部分，
    // 避免未来 payload 格式含冒号时 split(':') 产生超过 3 段静默失败
    const lastColon = token.lastIndexOf(':');
    if (lastColon === -1) return false;
    const sig = token.slice(lastColon + 1);
    const payload = token.slice(0, lastColon);
  
    const firstColon = payload.indexOf(':');
    if (firstColon === -1) return false;
    const tag = payload.slice(0, firstColon);
    const issuedAtStr = payload.slice(firstColon + 1);
  
    if (tag !== 'session') return false;
    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt)) return false;
  
    // session 有效期 30 天
    const MAX_AGE = 30 * 24 * 3600 * 1000;
    if (now() - issuedAt > MAX_AGE) return false;
  
    // payload already declared above; equivalent to tag + ":" + issuedAtStr
    const secret = await deriveSessionSecret(env);
    const expected = await hmacSign(payload, secret);
    return timingSafeEqual(expected, sig);
  }
  
  function timingSafeEqual(a, b) {
    // 修复问题7：不提前因长度不同而返回，避免时序侧信道泄漏密码长度
    const maxLen = Math.max(a.length, b.length);
    let result = a.length ^ b.length;
    for (let i = 0; i < maxLen; i++) {
      result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return result === 0;
  }
  
  const SESSION_COOKIE_NAME = 'owrt_session';
  
  function sessionCookieHeader(token, maxAgeSeconds) {
    // Secure 在本地 http 发发可能失效，但 Worker 部署都是 https，所以始终带 Secure
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  }
  
  function clearSessionCookieHeader() {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }
  
  async function requireSession(request, env) {
    const cookies = parseCookies(request);
    const token = cookies[SESSION_COOKIE_NAME];
    const ok = await verifySessionToken(token, env);
    return ok;
  }
  
  async function requireReportToken(request, env) {
    const token = request.headers.get('X-Report-Token');
    if (!token) return false;
    const reportToken = await getConfig(env, 'report_token').catch(() => null);
    if (!reportToken) return false;
    return timingSafeEqual(token, reportToken);
  }
  
  function safeJsonParse(str, fallback) {
    if (str === null || str === undefined) return fallback;
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }
  
  // ============================================================
  // 加密工具：基于 MASTER_KEY 派生 AES-GCM 密钥，加解密敏感配置
  // ============================================================
  let _cachedAesKey = null;
  let _cachedAesKeySource = null;
  
  async function deriveAesKey(env) {
    if (!env.MASTER_KEY) {
      throw new Error('服务器未配置 MASTER_KEY');
    }
    // 模块级缓存：同一 Worker 实例内复用，避免每次加解密都重新派生
    if (_cachedAesKey && _cachedAesKeySource === env.MASTER_KEY) return _cachedAesKey;
    const keyMaterial = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.MASTER_KEY));
    const aesKey = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    _cachedAesKey = aesKey;
    _cachedAesKeySource = env.MASTER_KEY;
    return aesKey;
  }
  
  function bufToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  
  function base64ToBuf(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  
  // 加密后格式：base64(iv) + ":" + base64(ciphertext)
  async function encryptValue(plainText, env) {
    const key = await deriveAesKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plainText)
    );
    return `${bufToBase64(iv)}:${bufToBase64(cipherBuf)}`;
  }
  
  async function decryptValue(stored, env) {
    const idx = stored.indexOf(':');
    if (idx === -1) throw new Error('密文格式错误');
    const iv = base64ToBuf(stored.slice(0, idx));
    const cipherBuf = base64ToBuf(stored.slice(idx + 1));
    const key = await deriveAesKey(env);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf);
    return new TextDecoder().decode(plainBuf);
  }
  
  // SESSION_SECRET 不再单独存储，由 MASTER_KEY 实时派生（纯内存运算，零 D1 查询）
  async function deriveSessionSecret(env) {
    if (!env.MASTER_KEY) return 'fallback-secret';
    return hmacSign('session-secret', env.MASTER_KEY);
  }
  
  // ============================================================
  // system_config 存取层：除 login_password_hash 外，其余均加密存储
  // ============================================================
  const PLAINTEXT_CONFIG_KEYS = new Set(['login_password_hash']);
  const ENCRYPTED_CONFIG_KEYS = ['github_repo', 'github_token', 'report_token', 'worker_url'];
  
  async function getConfigRaw(env, key) {
    const row = await env.DB.prepare('SELECT value FROM system_config WHERE key = ?').bind(key).first();
    return row ? row.value : null;
  }
  
  async function getConfig(env, key) {
    const raw = await getConfigRaw(env, key);
    if (raw === null) return null;
    if (PLAINTEXT_CONFIG_KEYS.has(key)) return raw;
    return decryptValue(raw, env);
  }
  
  async function setConfig(env, key, value) {
    const stored = PLAINTEXT_CONFIG_KEYS.has(key) ? value : await encryptValue(value, env);
    await env.DB.prepare(
      `INSERT INTO system_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
      .bind(key, stored)
      .run();
  }
  
  async function deleteConfig(env, key) {
    await env.DB.prepare('DELETE FROM system_config WHERE key = ?').bind(key).run();
  }
  
  async function deleteConfigKeys(env, keys) {
    for (const k of keys) await deleteConfig(env, k);
  }
  
  // 系统状态：未初始化（无密码）/ 待向导（密码已设但 GitHub 配置未完成）/ 就绪
  async function getSystemStatus(env) {
    const hasPassword = (await getConfigRaw(env, 'login_password_hash')) !== null;
    if (!hasPassword) return 'uninitialized';
    const hasGithub = (await getConfigRaw(env, 'github_repo')) !== null
      && (await getConfigRaw(env, 'github_token')) !== null;
    if (!hasGithub) return 'wizard';
    return 'ready';
  }
  
  // PBKDF2 密码哈希：格式 base64(salt) + ":" + base64(hash)
  const PBKDF2_ITERATIONS = 100000;
  
  async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const hashBuf = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      256
    );
    return `${bufToBase64(salt)}:${bufToBase64(hashBuf)}`;
  }
  
  async function verifyPassword(password, stored) {
    const idx = stored.indexOf(':');
    if (idx === -1) return false;
    const salt = base64ToBuf(stored.slice(0, idx));
    const expectedHashB64 = stored.slice(idx + 1);
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const hashBuf = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      256
    );
    return timingSafeEqual(bufToBase64(hashBuf), expectedHashB64);
  }
  
  function randomToken(byteLen = 24) {
    const arr = crypto.getRandomValues(new Uint8Array(byteLen));
    return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  
  // ============================================================
  // 模板 API：CRUD
  // ============================================================
  function serializeTemplate(row) {
    if (!row) return null;
    return {
      ...row,
      plugins: safeJsonParse(row.plugins, []),
      schedule_enabled: !!row.schedule_enabled,
    };
  }
  
  async function handleListTemplates(request, env) {
    const { results } = await env.DB.prepare(
      `SELECT id, name, repo_url, branch, target, plugins, dotconfig_version_id, schedule_cron, schedule_enabled, schedule_dotconfig_version_id, created_at, updated_at FROM templates ORDER BY updated_at DESC`
    ).all();
    return json({ templates: results.map(serializeTemplate) });
  }
  
  async function handleGetTemplate(request, env, id) {
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!row) return err('模板不存在', 404);
    return json({ template: serializeTemplate(row) });
  }
  
  async function handleCreateTemplate(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !body.name || !body.repo_url || !body.branch || !body.target) {
      return err('缺少必填字段：name / repo_url / branch / target');
    }
    const id = uuid();
    const ts = now();
    const plugins = JSON.stringify(Array.isArray(body.plugins) ? body.plugins : []);
  
    await env.DB.prepare(
      `INSERT INTO templates (id, name, repo_url, branch, target, plugins, diy_script_1, diy_script_2, dotconfig_version_id, schedule_cron, schedule_enabled, schedule_dotconfig_version_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        id,
        body.name,
        body.repo_url,
        body.branch,
        body.target,
        plugins,
        body.diy_script_1 || '',
        body.diy_script_2 || '',
        null,
        body.schedule_cron || null,
        0,
        null,
        ts,
        ts
      )
      .run();
  
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    return json({ template: serializeTemplate(row) }, 201);
  }
  
  async function handleUpdateTemplate(request, env, id) {
    const existing = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!existing) return err('模板不存在', 404);
  
    const body = await request.json().catch(() => null);
    if (!body) return err('请求体格式错误');
  
    const name = body.name ?? existing.name;
    const repo_url = body.repo_url ?? existing.repo_url;
    const branch = body.branch ?? existing.branch;
    const target = body.target ?? existing.target;
    const plugins = body.plugins !== undefined ? JSON.stringify(body.plugins) : existing.plugins;
    const diy_script_1 = body.diy_script_1 !== undefined ? body.diy_script_1 : existing.diy_script_1;
    const diy_script_2 = body.diy_script_2 !== undefined ? body.diy_script_2 : existing.diy_script_2;
  
    const ts = now();
    await env.DB.prepare(
      `UPDATE templates SET name=?, repo_url=?, branch=?, target=?, plugins=?, diy_script_1=?, diy_script_2=?, updated_at=? WHERE id=?`
    )
      .bind(name, repo_url, branch, target, plugins, diy_script_1, diy_script_2, ts, id)
      .run();
  
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    return json({ template: serializeTemplate(row) });
  }
  
  async function handleDeleteTemplate(request, env, id) {
    const existing = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(id).first();
    if (!existing) return err('模板不存在', 404);
  
    await env.DB.prepare('DELETE FROM builds WHERE template_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM dotconfig_history WHERE template_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  
    return json({ ok: true });
  }
  
  // ============================================================
  // .config 版本历史 API
  // ============================================================
  const MAX_DOTCONFIG_SIZE = 2 * 1024 * 1024; // 2MB
  const MAX_HISTORY_PER_TEMPLATE = 10;
  
  async function handleListDotconfigHistory(request, env, templateId) {
    const tpl = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(templateId).first();
    if (!tpl) return err('模板不存在', 404);
  
    const { results } = await env.DB.prepare(
      `SELECT id, template_id, source, build_id, label, created_at FROM dotconfig_history WHERE template_id = ? ORDER BY created_at DESC`
    )
      .bind(templateId)
      .all();
    return json({ history: results });
  }
  
  async function handleGetDotconfigVersion(request, env, templateId, versionId) {
    const row = await env.DB.prepare(
      'SELECT * FROM dotconfig_history WHERE template_id = ? AND id = ?'
    )
      .bind(templateId, versionId)
      .first();
    if (!row) return err('版本不存在', 404);
    return json({ version: row });
  }
  
  async function pruneDotconfigHistory(env, templateId) {
    // 保留最近 MAX_HISTORY_PER_TEMPLATE 条
    // 修复问题6：同时豁免 dotconfig_version_id（当前版本）和 schedule_dotconfig_version_id（定时版本），
    // 防止当前版本在超出 10 条限制后被意外清理
    // 注意：D1 基于 SQLite 3.x，带 ORDER BY 的子查询 LIMIT 受支持，但偶遇兼容问题可改为
    // 先 SELECT id 再在应用层取前 N 条构造 NOT IN 列表
    await env.DB.prepare(
      `DELETE FROM dotconfig_history WHERE template_id = ? AND id NOT IN (
        SELECT id FROM dotconfig_history WHERE template_id = ? ORDER BY created_at DESC LIMIT ?
      ) AND id != COALESCE((SELECT schedule_dotconfig_version_id FROM templates WHERE id = ?), '')
      AND id != COALESCE((SELECT dotconfig_version_id FROM templates WHERE id = ?), '')`
    )
      .bind(templateId, templateId, MAX_HISTORY_PER_TEMPLATE, templateId, templateId)
      .run();
  }
  
  async function handleUploadDotconfig(request, env, templateId) {
    const tpl = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(templateId).first();
    if (!tpl) return err('模板不存在', 404);
  
    const body = await request.json().catch(() => null);
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return err('content 不能为空');
    }
    if (body.content.length > MAX_DOTCONFIG_SIZE) {
      return err('content 超过 2MB 限制', 413);
    }
  
    const versionId = uuid();
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO dotconfig_history (id, template_id, content, source, build_id, label, created_at) VALUES (?, ?, ?, 'manual_upload', NULL, ?, ?)`
    )
      .bind(versionId, templateId, body.content, body.label || null, ts)
      .run();
  
    await env.DB.prepare('UPDATE templates SET dotconfig_version_id=?, updated_at=? WHERE id=?')
      .bind(versionId, ts, templateId)
      .run();
  
    await pruneDotconfigHistory(env, templateId);
  
    return json({ ok: true, version_id: versionId }, 201);
  }
  
  async function handleSetCurrentDotconfig(request, env, templateId) {
    const tpl = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(templateId).first();
    if (!tpl) return err('模板不存在', 404);
  
    const body = await request.json().catch(() => null);
    if (!body || !body.version_id) return err('缺少 version_id');
  
    const version = await env.DB.prepare(
      'SELECT id FROM dotconfig_history WHERE id = ? AND template_id = ?'
    )
      .bind(body.version_id, templateId)
      .first();
    if (!version) return err('指定版本不存在', 404);
  
    await env.DB.prepare('UPDATE templates SET dotconfig_version_id=?, updated_at=? WHERE id=?')
      .bind(body.version_id, now(), templateId)
      .run();
  
    return json({ ok: true });
  }
  
  async function handlePatchDotconfigLabel(request, env, templateId, versionId) {
    const version = await env.DB.prepare(
      'SELECT id FROM dotconfig_history WHERE id = ? AND template_id = ?'
    )
      .bind(versionId, templateId)
      .first();
    if (!version) return err('版本不存在', 404);
  
    const body = await request.json().catch(() => null);
    if (!body || typeof body.label !== 'string') return err('缺少 label 字段');
  
    await env.DB.prepare('UPDATE dotconfig_history SET label=? WHERE id=?').bind(body.label, versionId).run();
    return json({ ok: true });
  }
  
  async function handleDeleteDotconfigVersion(request, env, templateId, versionId) {
    const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first();
    if (!tpl) return err('模板不存在', 404);
  
    const version = await env.DB.prepare(
      'SELECT id FROM dotconfig_history WHERE id = ? AND template_id = ?'
    )
      .bind(versionId, templateId)
      .first();
    if (!version) return err('版本不存在', 404);
  
    if (tpl.dotconfig_version_id === versionId) {
      return err('该版本已设为当前版本，请先切换引用再删除', 409);
    }
    if (tpl.schedule_dotconfig_version_id === versionId) {
      return err('该版本已被定时任务引用，请先切换引用再删除', 409);
    }
  
    await env.DB.prepare('DELETE FROM dotconfig_history WHERE id = ?').bind(versionId).run();
    return json({ ok: true });
  }
  
  // ============================================================
  // 定时任务设置 API
  // ============================================================
  async function handleSetSchedule(request, env, templateId) {
    const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first();
    if (!tpl) return err('模板不存在', 404);
  
    const body = await request.json().catch(() => null);
    if (!body) return err('请求体格式错误');
  
    const enabled = body.enabled ? 1 : 0;
    const cron = body.cron !== undefined ? body.cron : tpl.schedule_cron;
    const versionId = body.dotconfig_version_id !== undefined && body.dotconfig_version_id !== null ? body.dotconfig_version_id : tpl.schedule_dotconfig_version_id;
  
    if (enabled && !versionId) {
      return err('定时编译必须选择一个 .config 版本，否则无法启用');
    }
  
    if (versionId) {
      const version = await env.DB.prepare(
        'SELECT id FROM dotconfig_history WHERE id = ? AND template_id = ?'
      )
        .bind(versionId, templateId)
        .first();
      if (!version) return err('指定的 .config 版本不存在', 404);
    }
  
    if (enabled && !cron) {
      return err('启用定时编译必须提供 cron 表达式');
    }
  
    await env.DB.prepare(
      `UPDATE templates SET schedule_cron=?, schedule_enabled=?, schedule_dotconfig_version_id=?, updated_at=? WHERE id=?`
    )
      .bind(cron || null, enabled, versionId || null, now(), templateId)
      .run();
  
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first();
    return json({ template: serializeTemplate(row) });
  }
  
  // ============================================================
  // 模板导出 / 导入
  // ============================================================
  const EXPORT_VERSION = 1;
  
  async function handleExportTemplate(request, env, templateId, url) {
    const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first();
    if (!tpl) return err('模板不存在', 404);
  
    const versionIdParam = url.searchParams.get('version_id');
    let versionRow = null;
    if (versionIdParam) {
      versionRow = await env.DB.prepare(
        'SELECT * FROM dotconfig_history WHERE id = ? AND template_id = ?'
      )
        .bind(versionIdParam, templateId)
        .first();
      if (!versionRow) return err('指定版本不存在', 404);
    } else if (tpl.dotconfig_version_id) {
      versionRow = await env.DB.prepare('SELECT * FROM dotconfig_history WHERE id = ?')
        .bind(tpl.dotconfig_version_id)
        .first();
    }
  
    const exportObj = {
      export_version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      template: {
        name: tpl.name,
        repo_url: tpl.repo_url,
        branch: tpl.branch,
        target: tpl.target,
        plugins: safeJsonParse(tpl.plugins, []),
        diy_script_1: tpl.diy_script_1 || '',
        diy_script_2: tpl.diy_script_2 || '',
      },
      dotconfig: versionRow ? { content: versionRow.content, label: versionRow.label || null } : null,
    };
  
    const filename = `${tpl.name}.openwrt-template.json`;
    return new Response(JSON.stringify(exportObj, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  }
  
  async function handleImportTemplate(request, env) {
    const body = await request.json().catch(() => null);
    if (!body) return err('请求体格式错误');
    if (body.export_version !== EXPORT_VERSION) {
      return err(`不支持的 export_version: ${body.export_version}`, 400);
    }
  
    const t = body.template;
    if (!t || !t.name || !t.repo_url || !t.branch || !t.target) {
      return err('template 字段缺失或不完整');
    }
  
    // 重名检测：依次尝试 "名称"、"名称(导入)"、"名称(导入2)"...
    let finalName = t.name;
    {
      let candidate = finalName;
      let suffix = 0;
      while (true) {
        const dup = await env.DB.prepare('SELECT id FROM templates WHERE name = ?').bind(candidate).first();
        if (!dup) {
          finalName = candidate;
          break;
        }
        suffix += 1;
        candidate = suffix === 1 ? `${t.name}(导入)` : `${t.name}(导入${suffix})`;
      }
    }
  
    const templateId = uuid();
    const ts = now();
    const plugins = JSON.stringify(Array.isArray(t.plugins) ? t.plugins : []);
  
    await env.DB.prepare(
      `INSERT INTO templates (id, name, repo_url, branch, target, plugins, diy_script_1, diy_script_2, dotconfig_version_id, schedule_cron, schedule_enabled, schedule_dotconfig_version_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        templateId,
        finalName,
        t.repo_url,
        t.branch,
        t.target,
        plugins,
        t.diy_script_1 || '',
        t.diy_script_2 || '',
        null,
        null,
        0,
        null,
        ts,
        ts
      )
      .run();
  
    if (body.dotconfig && typeof body.dotconfig.content === 'string' && body.dotconfig.content.trim()) {
      if (body.dotconfig.content.length > MAX_DOTCONFIG_SIZE) {
        return err('dotconfig.content 超过 2MB 限制', 413);
      }
      const versionId = uuid();
      await env.DB.prepare(
        `INSERT INTO dotconfig_history (id, template_id, content, source, build_id, label, created_at) VALUES (?, ?, ?, 'imported', NULL, ?, ?)`
      )
        .bind(versionId, templateId, body.dotconfig.content, body.dotconfig.label || null, ts)
        .run();
  
      await env.DB.prepare('UPDATE templates SET dotconfig_version_id=?, updated_at=? WHERE id=?')
        .bind(versionId, ts, templateId)
        .run();
    }
  
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first();
    return json({ template: serializeTemplate(row) }, 201);
  }
  
  // ============================================================
  // 编译触发 + builds 列表 + workflow 上报
  // ============================================================
  const ACTIVE_STATUSES = ['pending', 'running', 'menuconfig', 'compiling'];
  
  async function hasActiveBuild(env) {
    // Note: soft guard only -- D1 lacks SELECT FOR UPDATE, so two concurrent
    // requests may both pass. Acceptable for low-frequency personal use.
    // Inline zombie cleanup: mark builds stuck in active states beyond the
    // workflow timeout (6 h = timeout-minutes: 360) as failed.
    // This handles silent GitHub Actions failures (syntax errors, runner
    // unavailability, queue timeouts) that would otherwise block all future
    // triggers forever via hasActiveBuild.
    const STUCK_TIMEOUT_MS = 6 * 60 * 60 * 1000; // keep in sync with timeout-minutes in yml
    const cutoff = Date.now() - STUCK_TIMEOUT_MS;
    const activePlaceholders = ACTIVE_STATUSES.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE builds SET status='failed', updated_at=? WHERE status IN (${activePlaceholders}) AND created_at < ?`
    ).bind(Date.now(), ...ACTIVE_STATUSES, cutoff).run();
  
    const row = await env.DB.prepare(
      `SELECT id FROM builds WHERE status IN (${activePlaceholders}) LIMIT 1`
    )
      .bind(...ACTIVE_STATUSES)
      .first();
    return !!row;
  }
  
  async function dispatchGithubWorkflow(env, buildId) {
    const githubRepo = await getConfig(env, 'github_repo');
    const githubToken = await getConfig(env, 'github_token');
    const workerUrl = await getConfig(env, 'worker_url');
    if (!githubRepo || !githubToken || !workerUrl) {
      throw new Error('GitHub / Worker URL 配置未完成，请先在"部署向导"中填写');
    }
    const resp = await fetch(`https://api.github.com/repos/${githubRepo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'openwrt-auto-build-worker',
      },
      // worker_url 一并下发：workflow 第一步要去拉取 config.json 之前，
      // 还没有任何途径读到 D1 里的配置，所以必须通过 client_payload 直接带上，
      // 后续步骤再统一从 config.json 的 worker_url 字段读取，两者保持一致。
      body: JSON.stringify({
        event_type: 'build-openwrt',
        client_payload: { build_id: buildId, worker_url: workerUrl },
      }),
    });
  
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`GitHub dispatch 失败: ${resp.status} ${text}`);
    }
  }
  
  async function handleTrigger(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !body.template_id) return err('缺少 template_id');
  
    const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(body.template_id).first();
    if (!tpl) return err('模板不存在', 404);
  
    if (await hasActiveBuild(env)) {
      return err('已有任务在执行中，请等待完成后再触发', 409);
    }
  
    // 底稿版本：可为空（从零开始）
    let dotconfigVersionId = body.dotconfig_version_id || null;
    let dotconfigSnapshot = null;
    if (dotconfigVersionId) {
      const version = await env.DB.prepare(
        'SELECT * FROM dotconfig_history WHERE id = ? AND template_id = ?'
      )
        .bind(dotconfigVersionId, body.template_id)
        .first();
      if (!version) return err('指定的 .config 底稿版本不存在', 404);
      dotconfigSnapshot = version.content;
    }
  
    const buildId = uuid();
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO builds (id, template_id, repo_url, branch, target, plugins, diy_script_1, diy_script_2, dotconfig_version_id, dotconfig_snapshot, dotconfig_result, trigger_type, schedule_cron, status, web_url, download_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'manual',NULL,'pending',NULL,NULL,?,?)`
    )
      .bind(
        buildId,
        tpl.id,
        tpl.repo_url,
        tpl.branch,
        tpl.target,
        tpl.plugins,
        tpl.diy_script_1,
        tpl.diy_script_2,
        dotconfigVersionId,
        dotconfigSnapshot,
        ts,
        ts
      )
      .run();
  
    try {
      await dispatchGithubWorkflow(env, buildId);
    } catch (e) {
      await env.DB.prepare('UPDATE builds SET status=?, updated_at=? WHERE id=?')
        .bind('failed', now(), buildId)
        .run();
      return err(`触发失败: ${e.message}`, 502);
    }
  
    return json({ ok: true, build_id: buildId }, 201);
  }
  
  function serializeBuild(row) {
    if (!row) return null;
    return { ...row, plugins: safeJsonParse(row.plugins, []) };
  }
  
  async function handleListBuilds(request, env, url) {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const { results } = await env.DB.prepare(
      `SELECT id, template_id, repo_url, branch, target, dotconfig_version_id, trigger_type, schedule_cron, status, web_url, download_url, created_at, updated_at FROM builds ORDER BY created_at DESC LIMIT ?`
    )
      .bind(limit)
      .all();
    return json({ builds: results });
  }
  
  async function handleGetBuild(request, env, id) {
    const row = await env.DB.prepare('SELECT * FROM builds WHERE id = ?').bind(id).first();
    if (!row) return err('编译记录不存在', 404);
    return json({ build: serializeBuild(row) });
  }
  
  // workflow 专用：拉取完整配置（REPORT_TOKEN 鉴权）
  async function handleWorkflowGetConfig(request, env, buildId) {
    const row = await env.DB.prepare('SELECT * FROM builds WHERE id = ?').bind(buildId).first();
    if (!row) return err('build 不存在', 404);
  
    const workerUrl = await getConfig(env, 'worker_url').catch(() => null);
  
    return json({
      build_id: row.id,
      template_id: row.template_id,
      repo_url: row.repo_url,
      branch: row.branch,
      target: row.target,
      plugins: safeJsonParse(row.plugins, []),
      diy_script_1: row.diy_script_1 || '',
      diy_script_2: row.diy_script_2 || '',
      dotconfig_snapshot: row.dotconfig_snapshot || '',
      trigger_type: row.trigger_type || 'manual',
      worker_url: workerUrl || '',
    });
  }
  
  // workflow 专用：上报状态
  const VALID_BUILD_STATUSES = [
    'pending', 'running', 'menuconfig', 'compiling', 'success', 'failed', 'cancelled',
  ];
  // workflow 只能上报这些状态（不允许上报 'pending'，避免 hasActiveBuild 误判）
  const WORKFLOW_REPORTABLE_STATUSES = [
    'running', 'menuconfig', 'compiling', 'success', 'failed', 'cancelled',
  ];
  
  async function handleWorkflowReport(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !body.build_id || !body.status) {
      return err('缺少 build_id 或 status');
    }
    if (!WORKFLOW_REPORTABLE_STATUSES.includes(body.status)) {
      return err(`未知 status: ${body.status}`);
    }
  
    const row = await env.DB.prepare('SELECT id FROM builds WHERE id = ?').bind(body.build_id).first();
    if (!row) return err('build 不存在', 404);
  
    const fields = ['status=?'];
    const values = [body.status];
    if (body.web_url !== undefined) {
      fields.push('web_url=?');
      values.push(body.web_url);
    }
    if (body.download_url !== undefined) {
      fields.push('download_url=?');
      values.push(body.download_url);
    }
    fields.push('updated_at=?');
    values.push(now());
    values.push(body.build_id);
  
    await env.DB.prepare(`UPDATE builds SET ${fields.join(', ')} WHERE id=?`)
      .bind(...values)
      .run();
  
    return json({ ok: true });
  }
  
  // workflow 专用：推送 menuconfig 结果，写入版本历史（设计文档 9.2 节）
  async function handleWorkflowReportDotconfig(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !body.build_id || typeof body.content !== 'string') {
      return err('缺少 build_id 或 content');
    }
    if (!body.content.trim()) {
      return err('content 不能为空');
    }
    if (body.content.length > MAX_DOTCONFIG_SIZE) {
      return err('content 超过 2MB 限制', 413);
    }
  
    const build = await env.DB.prepare('SELECT * FROM builds WHERE id = ?').bind(body.build_id).first();
    if (!build) return err('build 不存在', 404);
  
    // 修复问题3：始终从 build 记录中读取 template_id，忽略上报体中的值，防止被篡改
    const templateId = build.template_id;
    const versionId = uuid();
    const ts = now();
  
    // 修复：优先更新 builds.dotconfig_result，这是 workflow 最关心的状态。
    // D1 不支持跨表事务，若后续操作失败，至少 build 记录里有完整的最终配置可追溯。
    await env.DB.prepare('UPDATE builds SET dotconfig_result=?, updated_at=? WHERE id=?')
      .bind(body.content, ts, body.build_id)
      .run();
  
    await env.DB.prepare(
      `INSERT INTO dotconfig_history (id, template_id, content, source, build_id, created_at) VALUES (?, ?, ?, 'menuconfig_push', ?, ?)`
    )
      .bind(versionId, templateId, body.content, body.build_id, ts)
      .run();
  
    if (templateId) {
      await env.DB.prepare('UPDATE templates SET dotconfig_version_id=?, updated_at=? WHERE id=?')
        .bind(versionId, ts, templateId)
        .run();
    }
  
    if (templateId) {
      await pruneDotconfigHistory(env, templateId);
    }
  
    return json({ ok: true, version_id: versionId });
  }
  
  // ============================================================
  // 定时任务 scheduled handler（设计文档 7.3 节）
  // ============================================================
  async function runScheduledBuilds(env, cronString) {
    const { results } = await env.DB.prepare(
      `SELECT t.*, h.content AS dotconfig_content FROM templates t JOIN dotconfig_history h ON h.id = t.schedule_dotconfig_version_id WHERE t.schedule_enabled = 1 AND t.schedule_cron = ? AND t.schedule_dotconfig_version_id IS NOT NULL`
    )
      .bind(cronString)
      .all();
  
    for (const template of results) {
      if (await hasActiveBuild(env)) {
        console.log(`跳过模板 ${template.name}：已有任务在执行中`);
        continue;
      }
  
      const buildId = uuid();
      const ts = now();
      await env.DB.prepare(
        `INSERT INTO builds (id, template_id, repo_url, branch, target, plugins, diy_script_1, diy_script_2, dotconfig_version_id, dotconfig_snapshot, dotconfig_result, trigger_type, schedule_cron, status, web_url, download_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'scheduled',?,'pending',NULL,NULL,?,?)`
      )
        .bind(
          buildId,
          template.id,
          template.repo_url,
          template.branch,
          template.target,
          template.plugins,
          template.diy_script_1,
          template.diy_script_2,
          template.schedule_dotconfig_version_id,
          template.dotconfig_content,
          cronString,
          ts,
          ts
        )
        .run();
  
      try {
        await dispatchGithubWorkflow(env, buildId);
      } catch (e) {
        console.log(`模板 ${template.name} 定时触发 dispatch 失败: ${e.message}`);
        await env.DB.prepare('UPDATE builds SET status=?, updated_at=? WHERE id=?')
          .bind('failed', now(), buildId)
          .run();
      }
    }
  }
  
  // ============================================================
  // 登录接口
  // ============================================================
  async function handleLogin(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.password !== 'string') {
      return err('缺少 password 字段');
    }
    const hash = await getConfigRaw(env, 'login_password_hash');
    if (!hash) {
      return err('系统尚未初始化，请先完成初始化设置', 412);
    }
    const ok = await verifyPassword(body.password, hash);
    if (!ok) {
      return err('密码错误', 401);
    }
  
    const token = await createSessionToken(env);
    const maxAge = 30 * 24 * 3600;
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(token, maxAge) });
  }
  
  async function handleLogout(request, env) {
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
  }
  
  // ============================================================
  // 系统初始化 / 部署向导 / 设置 API
  // ============================================================
  
  // 无需鉴权：返回当前系统状态，前端据此决定跳转到 /setup、/wizard 还是正常页面
  async function handleSetupStatus(request, env) {
    const status = await getSystemStatus(env);
    return json({ status });
  }
  
  // 无需鉴权（仅限未初始化状态）：首次设置登录密码
  async function handleSetupInit(request, env) {
    const status = await getSystemStatus(env);
    if (status !== 'uninitialized') {
      return err('系统已初始化，无法重复执行', 409);
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body.password !== 'string' || body.password.length < 6) {
      return err('密码至少需要 6 位');
    }
    if (body.password !== body.confirm_password) {
      return err('两次输入的密码不一致');
    }
    const hash = await hashPassword(body.password);
    await setConfig(env, 'login_password_hash', hash);
  
    const token = await createSessionToken(env);
    const maxAge = 30 * 24 * 3600;
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(token, maxAge) });
  }
  
  // 需登录：填写 Worker URL / GitHub 仓库 / GitHub PAT，生成 REPORT_TOKEN
  async function handleSetupWizard(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !body.github_repo) {
      return err('缺少必填字段：github_repo');
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(body.github_repo)) {
      return err('github_repo 格式应为 owner/repo');
    }
  
    const workerUrl = (body.worker_url || '').trim().replace(/\/+$/, '');
    if (!workerUrl) return err('缺少必填字段：worker_url');
  
    let githubToken = (body.github_token || '').trim();
    if (!githubToken) {
      if (!body.keep_existing_token) return err('缺少必填字段：github_token');
      githubToken = await getConfig(env, 'github_token').catch(() => null);
      if (!githubToken) return err('未找到已保存的 GitHub PAT，请重新填写');
    }
  
    await setConfig(env, 'github_repo', body.github_repo.trim());
    await setConfig(env, 'github_token', githubToken);
    await setConfig(env, 'worker_url', workerUrl);
  
    // REPORT_TOKEN：重新进入向导（重新配置）时，若已存在则保留，除非显式要求重置
    let reportToken = await getConfig(env, 'report_token').catch(() => null);
    if (!reportToken || body.regenerate_report_token) {
      reportToken = randomToken(24);
      await setConfig(env, 'report_token', reportToken);
    }
  
    return json({ ok: true, report_token: reportToken }, 201);
  }
  
  // 需登录：脱敏展示当前配置
  async function handleGetSettings(request, env) {
    const status = await getSystemStatus(env);
    const githubRepo = await getConfig(env, 'github_repo').catch(() => null);
    const workerUrl = await getConfig(env, 'worker_url').catch(() => null);
    const githubToken = await getConfig(env, 'github_token').catch(() => null);
  
    return json({
      status,
      github_repo: githubRepo || '',
      worker_url: workerUrl || '',
      github_token_masked: githubToken ? `${githubToken.slice(0, 4)}${'*'.repeat(Math.max(githubToken.length - 4, 4))}` : '',
    });
  }
  
  // 需登录：重置 REPORT_TOKEN（轮换，旧值立即失效，需要重新去 GitHub 更新 Secret）
  async function handleResetReportToken(request, env) {
    const reportToken = randomToken(24);
    await setConfig(env, 'report_token', reportToken);
    return json({ ok: true, report_token: reportToken });
  }
  
  // 需登录：重置配置
  // scope = 'github'：清空 github_repo / github_token / worker_url / report_token，回到向导页，保留密码
  // scope = 'all'：清空全部 system_config，回到系统初始化页
  async function handleSettingsReset(request, env) {
    const body = await request.json().catch(() => null);
    const scope = body && body.scope === 'all' ? 'all' : 'github';
  
    if (scope === 'all') {
      await env.DB.prepare('DELETE FROM system_config').run();
      return json({ ok: true, scope: 'all' }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
    }
  
    await deleteConfigKeys(env, ['github_repo', 'github_token', 'worker_url', 'report_token']);
    return json({ ok: true, scope: 'github' });
  }
  
  const APP_CSS = `:root {
    --bg: #f8fafc;
    --panel: #ffffff;
    --panel-raised: #f1f5f9;
    --border: #e2e8f0;
    --border-soft: #eef2f7;
    --text: #0f172a;
    --text-dim: #475569;
    --text-faint: #94a3b8;
    --accent: #2563eb;
    --accent-dim: #1d4ed8;
    --accent-bg: rgba(37, 99, 235, 0.08);
    --ok: #16a34a;
    --ok-bg: rgba(22, 163, 74, 0.1);
    --bad: #dc2626;
    --bad-bg: rgba(220, 38, 38, 0.1);
    --run: #2563eb;
    --run-bg: rgba(37, 99, 235, 0.1);
    --warn: #d97706;
    --warn-bg: rgba(217, 119, 6, 0.1);
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --font-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, "Courier New", monospace;
    --radius: 8px;
    --radius-lg: 12px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font-ui); font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  #app { min-height: 100vh; display: flex; flex-direction: column; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font-family: inherit; font-size: 13px; cursor: pointer; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: var(--radius); padding: 7px 14px; transition: background .12s, border-color .12s, color .12s; }
  button:hover { border-color: #cbd5e1; background: var(--panel-raised); }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover { background: var(--accent-dim); border-color: var(--accent-dim); }
  button.danger { color: var(--bad); border-color: rgba(220,38,38,.35); }
  button.danger:hover { background: var(--bad-bg); border-color: var(--bad); }
  button.ghost { background: transparent; border-color: transparent; color: var(--text-dim); padding: 6px 10px; }
  button.ghost:hover { background: var(--panel-raised); color: var(--text); }
  button.small { padding: 4px 10px; font-size: 12px; }
  input, select, textarea { font-family: inherit; font-size: 13px; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius); padding: 8px 10px; width: 100%; }
  textarea { font-family: var(--font-mono); font-size: 12.5px; resize: vertical; line-height: 1.5; }
  input::placeholder, textarea::placeholder { color: var(--text-faint); }
  label { display: block; font-size: 12.5px; color: var(--text-dim); margin-bottom: 6px; font-weight: 500; }
  .field { margin-bottom: 16px; }
  .field-row { display: flex; gap: 12px; }
  .field-row > .field { flex: 1; }
  .hint { font-size: 12px; color: var(--text-faint); margin-top: 5px; }
  code, .mono { font-family: var(--font-mono); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px 20px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 100px; letter-spacing: .02em; white-space: nowrap; }
  .badge.ok { background: var(--ok-bg); color: var(--ok); }
  .badge.bad { background: var(--bad-bg); color: var(--bad); }
  .badge.run { background: var(--run-bg); color: var(--run); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .badge.dim { background: var(--border-soft); color: var(--text-dim); }
  .scrollbar-thin::-webkit-scrollbar { width: 8px; height: 8px; }
  .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
  .scrollbar-thin::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast-wrap { position: fixed; top: 16px; right: 16px; z-index: 999; display: flex; flex-direction: column; gap: 8px; }
  .toast { background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius); padding: 10px 14px; font-size: 13px; min-width: 220px; max-width: 360px; box-shadow: 0 4px 12px rgba(0,0,0,.08); animation: toast-in .15s ease-out; }
  .toast.error { border-left-color: var(--bad); }
  .toast.success { border-left-color: var(--ok); }
  @keyframes toast-in { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: var(--accent); } .toast { animation: none; } }
  
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 0 24px; height: 56px; border-bottom: 1px solid var(--border); background: var(--panel); flex-shrink: 0; }
  .topbar .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
  .topbar .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
  .topbar nav { display: flex; gap: 4px; }
  .topbar nav button { background: transparent; border-color: transparent; color: var(--text-dim); padding: 7px 14px; font-size: 13px; }
  .topbar nav button.active { background: var(--panel-raised); color: var(--text); border-color: var(--border); }
  .topbar .right { display: flex; align-items: center; gap: 10px; }
  .content { flex: 1; max-width: 1080px; width: 100%; margin: 0 auto; padding: 28px 24px 60px; }
  .page-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
  .page-head h1 { font-size: 19px; margin: 0; font-weight: 700; letter-spacing: -.01em; }
  .page-head .sub { color: var(--text-dim); font-size: 13px; margin-top: 4px; }
  .page-head .actions { display: flex; gap: 8px; }
  
  .login-screen { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 28px; }
  .login-card { width: 320px; }
  .login-card .brand-mark { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 22px; }
  .login-card .brand-mark .glyph { width: 40px; height: 40px; border-radius: 10px; background: var(--accent-bg); border: 1px solid rgba(37,99,235,.3); display: flex; align-items: center; justify-content: center; color: var(--accent); font-weight: 800; font-size: 16px; }
  .login-card .brand-mark .title { font-weight: 700; font-size: 15px; }
  .login-card .brand-mark .desc { color: var(--text-faint); font-size: 12px; text-align: center; }
  .login-card form { display: flex; flex-direction: column; gap: 14px; }
  .login-card .error-msg { color: var(--bad); font-size: 12.5px; }
  
  /* 设置下拉菜单 */
  .settings-dropdown { position: relative; }
  .settings-dropdown .menu { position: absolute; top: calc(100% + 6px); right: 0; min-width: 200px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: 0 10px 25px rgba(0,0,0,.12); padding: 6px; z-index: 400; display: none; }
  .settings-dropdown .menu.open { display: block; }
  .settings-dropdown .menu button { display: block; width: 100%; text-align: left; background: transparent; border: none; padding: 9px 10px; font-size: 13px; color: var(--text); border-radius: 8px; cursor: pointer; }
  .settings-dropdown .menu button:hover { background: var(--panel-raised); }
  .settings-dropdown .menu button.danger { color: var(--bad); }
  .settings-dropdown .menu .sep { height: 1px; background: var(--border); margin: 6px 2px; }
  .settings-dropdown .menu .menu-label { padding: 6px 10px 2px; font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: .03em; }
  
  /* 初始化 / 部署向导页 */
  .setup-card { width: 420px; }
  .setup-card.wide { width: 480px; }
  .setup-card .hint { color: var(--text-faint); font-size: 12px; margin-top: -4px; margin-bottom: 6px; }
  .setup-card .token-box { background: var(--panel-raised); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; font-family: monospace; font-size: 13px; word-break: break-all; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .setup-card .token-box code { flex: 1; word-break: break-all; }
  .setup-card .step-banner { background: var(--accent-bg); border: 1px solid rgba(37,99,235,.25); color: var(--accent-dim); border-radius: 10px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 16px; }
  
  .empty-state { text-align: center; padding: 56px 20px; color: var(--text-faint); border: 1px dashed var(--border); border-radius: var(--radius-lg); }
  .empty-state .glyph { font-size: 26px; margin-bottom: 10px; opacity: .6; }
  .empty-state .msg { font-size: 13.5px; color: var(--text-dim); }
  .empty-state .sub { font-size: 12.5px; margin-top: 4px; }
  
  .template-grid { display: flex; flex-direction: column; gap: 10px; }
  .template-row { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); cursor: pointer; transition: border-color .12s, background .12s; }
  .template-row:hover { border-color: #cbd5e1; background: var(--panel-raised); }
  .template-row .main { flex: 1; min-width: 0; }
  .template-row .name { font-weight: 600; font-size: 14px; margin-bottom: 3px; }
  .template-row .meta { font-size: 12px; color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .template-row .tags { display: flex; gap: 6px; flex-shrink: 0; }
  .template-row .chevron { color: var(--text-faint); flex-shrink: 0; }
  
  .timeline { display: flex; align-items: center; gap: 0; }
  .timeline .seg { display: flex; align-items: center; }
  .timeline .step { width: 9px; height: 9px; border-radius: 50%; background: var(--border); border: 1px solid var(--border); flex-shrink: 0; position: relative; }
  .timeline .step.done { background: var(--ok); border-color: var(--ok); }
  .timeline .step.current { background: var(--run); border-color: var(--run); box-shadow: 0 0 0 3px var(--run-bg); }
  .timeline .step.failed { background: var(--bad); border-color: var(--bad); }
  .timeline .step.skip { background: transparent; border: 1px dashed var(--border-soft); }
  .timeline .bar { width: 20px; height: 1px; background: var(--border); flex-shrink: 0; }
  .timeline .bar.done { background: var(--ok); }
  .timeline-labels { display: flex; gap: 0; font-size: 10px; color: var(--text-faint); margin-top: 6px; font-family: var(--font-mono); }
  .timeline-labels span { width: 29px; text-align: center; flex-shrink: 0; }
  .timeline-labels span:first-child { width: 9px; margin-right: 10px; }
  
  .build-row { padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 10px; }
  .build-row .top-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .build-row .left-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .build-row .tpl-name { font-weight: 600; font-size: 13.5px; }
  .build-row .time { font-size: 12px; color: var(--text-faint); font-family: var(--font-mono); }
  .build-row .links { display: flex; gap: 14px; font-size: 12.5px; margin-top: 8px; }
  
  .detail-back { margin-bottom: 14px; }
  .section { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; margin-bottom: 18px; }
  .section > h2 { font-size: 13px; font-weight: 700; margin: 0 0 16px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; justify-content: space-between; }
  .section > h2 .actions { display: flex; gap: 8px; text-transform: none; letter-spacing: 0; }
  
  .version-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .version-table th { text-align: left; font-size: 11.5px; color: var(--text-faint); font-weight: 600; padding: 0 10px 8px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid var(--border); }
  .version-table td { padding: 10px 10px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
  .version-table tr:last-child td { border-bottom: none; }
  .version-table .label-cell { display: flex; align-items: center; gap: 6px; }
  .version-table .label-text { color: var(--text-dim); }
  .version-table .label-edit-btn { opacity: 0; transition: opacity .12s; }
  .version-table tr:hover .label-edit-btn { opacity: 1; }
  .version-table .ref-tag { font-size: 10.5px; padding: 1px 7px; border-radius: 100px; font-weight: 600; background: var(--accent-bg); color: var(--accent); margin-left: 6px; }
  .version-table .ref-tag.sched { background: var(--warn-bg); color: var(--warn); }
  .version-table .ops { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .version-table .source-tag { font-size: 12px; color: var(--text-faint); font-family: var(--font-mono); }
  
  .schedule-form { display: flex; flex-direction: column; gap: 14px; }
  .schedule-toggle-row { display: flex; align-items: center; gap: 10px; }
  .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .switch .track { position: absolute; inset: 0; background: var(--border); border-radius: 100px; transition: background .15s; cursor: pointer; }
  .switch .track::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--text-dim); border-radius: 50%; transition: transform .15s, background .15s; }
  .switch input:checked + .track { background: var(--accent-bg); border: 1px solid var(--accent); }
  .switch input:checked + .track::before { transform: translateX(16px); background: var(--accent); }
  .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  
  .cron-presets { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .cron-presets button { font-size: 12px; padding: 4px 10px; }
  
  .warn-line { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: var(--warn); background: var(--warn-bg); border: 1px solid rgba(217,119,6,.3); border-radius: var(--radius); padding: 9px 12px; }
  
  .plugin-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
  .plugin-item { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; background: var(--bg); }
  .plugin-item .row1 { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .plugin-item .row1 input[type=text] { flex: 1; }
  .plugin-item .sparse-row { display: flex; gap: 10px; align-items: center; }
  .plugin-item .sparse-row label.inline { display: flex; align-items: center; gap: 6px; margin: 0; white-space: nowrap; }
  .plugin-item .sparse-row input[type=checkbox] { width: auto; }
  .plugin-item .sub-fields { display: flex; gap: 10px; margin-top: 8px; }
  .plugin-item .remove-btn { flex-shrink: 0; }
  
  .trigger-panel { display: flex; flex-direction: column; gap: 16px; }
  .radio-option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
  .radio-option.selected { border-color: var(--accent); background: var(--accent-bg); }
  .radio-option input[type=radio] { margin-top: 2px; width: auto; }
  .radio-option .opt-body { flex: 1; }
  .radio-option .opt-title { font-size: 13px; font-weight: 500; }
  .radio-option select { margin-top: 8px; }
  
  .code-view { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-all; color: var(--text-dim); }
  
  .modal-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.4); display: flex; align-items: center; justify-content: center; z-index: 500; padding: 20px; }
  .modal-box { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); width: 100%; max-width: 640px; max-height: 86vh; display: flex; flex-direction: column; box-shadow: 0 10px 25px rgba(0,0,0,.1); }
  .modal-box .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .modal-box .modal-head h3 { margin: 0; font-size: 14.5px; font-weight: 700; }
  .modal-box .modal-body { padding: 20px; overflow: auto; flex: 1; }
  .modal-box .modal-foot { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; flex-shrink: 0; }
  
  .terminal-frame-wrap { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; background: #000; }
  .terminal-frame-wrap iframe { width: 100%; height: 520px; border: none; display: block; }
  .terminal-bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: var(--panel-raised); border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-dim); }
  
  @media (max-width: 720px) {
    .content { padding: 18px 14px 50px; }
    .field-row { flex-direction: column; }
    .topbar { padding: 0 14px; }
    .topbar .brand span.label { display: none; }
  }`;
  
  const APP_JS = `
  const api = {
    async _req(method, path, body) {
      const opt = { method, headers: {}, credentials: 'same-origin' };
      if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      const resp = await fetch(path, opt);
      let data = null;
      try { data = await resp.json(); } catch {}
      if (!resp.ok) {
        const msg = (data && data.error) || \`请求失败 (\${resp.status})\`;
        const e = new Error(msg); e.status = resp.status; throw e;
      }
      return data;
    },
    get(p) { return this._req('GET', p); },
    post(p, b) { return this._req('POST', p, b ?? {}); },
    put(p, b) { return this._req('PUT', p, b ?? {}); },
    patch(p, b) { return this._req('PATCH', p, b ?? {}); },
    del(p) { return this._req('DELETE', p); },
    login(password) { return this.post('/api/login', { password }); },
    logout() { return this.post('/api/logout'); },
    setupStatus() { return this.get('/api/setup/status'); },
    setupInit(password, confirmPassword) { return this.post('/api/setup/init', { password, confirm_password: confirmPassword }); },
    setupWizard(body) { return this.post('/api/setup/wizard', body); },
    getSettings() { return this.get('/api/settings'); },
    resetReportToken() { return this.post('/api/settings/report-token/reset'); },
    settingsReset(scope) { return this.post('/api/settings/reset', { scope }); },
    listTemplates() { return this.get('/api/templates'); },
    getTemplate(id) { return this.get(\`/api/templates/\${id}\`); },
    createTemplate(body) { return this.post('/api/templates', body); },
    updateTemplate(id, body) { return this.put(\`/api/templates/\${id}\`, body); },
    deleteTemplate(id) { return this.del(\`/api/templates/\${id}\`); },
    listHistory(tplId) { return this.get(\`/api/templates/\${tplId}/dotconfig/history\`); },
    getHistoryVersion(tplId, vid) { return this.get(\`/api/templates/\${tplId}/dotconfig/history/\${vid}\`); },
    uploadDotconfig(tplId, body) { return this.post(\`/api/templates/\${tplId}/dotconfig/upload\`, body); },
    setCurrentDotconfig(tplId, versionId) { return this.put(\`/api/templates/\${tplId}/dotconfig/current\`, { version_id: versionId }); },
    patchLabel(tplId, vid, label) { return this.patch(\`/api/templates/\${tplId}/dotconfig/history/\${vid}\`, { label }); },
    deleteVersion(tplId, vid) { return this.del(\`/api/templates/\${tplId}/dotconfig/history/\${vid}\`); },
    setSchedule(tplId, body) { return this.put(\`/api/templates/\${tplId}/schedule\`, body); },
    importTemplate(body) { return this.post('/api/templates/import', body); },
    trigger(body) { return this.post('/api/trigger', body); },
    listBuilds() { return this.get('/api/builds'); },
    getBuild(id) { return this.get(\`/api/builds/\${id}\`); },
  };
  
  const store = { authed: false, systemStatus: 'ready', route: { name: 'templates', params: {} }, templates: [], builds: [], pollTimer: null };
  
  function parseHash() {
    const h = location.hash.replace(/^#\\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'template' && parts[1]) return { name: 'template-detail', params: { id: parts[1] } };
    if (parts[0] === 'trigger' && parts[1]) return { name: 'trigger', params: { id: parts[1] } };
    if (parts[0] === 'builds') return { name: 'builds', params: {} };
    return { name: 'templates', params: {} };
  }
  
  function navigate(hash) { location.hash = hash; }
  window.addEventListener('hashchange', () => { store.route = parseHash(); render(); });
  
  function toast(message, type = 'info') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = \`toast \${type}\`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 250); }, 3200);
  }
  
  function reportApiError(e, fallback) { toast(e?.message || fallback || '操作失败', 'error'); }
  
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  
  function fmtTime(ts) {\n  if (!ts) return '—';\n  const d = new Date(Number(ts));\n  const pad = (n) => String(n).padStart(2, '0');\n  return \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}\`;\n}
  
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function qs(root, sel) { return root.querySelector(sel); }
  function qsa(root, sel) { return Array.from(root.querySelectorAll(sel)); }
  
  const SOURCE_LABELS = { manual_upload: '手动上传', menuconfig_push: 'menuconfig推送', imported: '导入' };
  const STATUS_LABELS = { pending: '排队中', running: '准备中', menuconfig: '配置中', compiling: '编译中', success: '成功', failed: '失败', cancelled: '已取消' };
  
  function statusBadgeClass(status) {
    if (status === 'success') return 'ok';
    if (status === 'failed' || status === 'cancelled') return 'bad';
    if (status === 'menuconfig') return 'warn';
    if (status === 'pending') return 'dim';
    return 'run';
  }
  
  function renderTimeline(build) {
    const isManual = build.trigger_type !== 'scheduled';
    const steps = isManual ? ['pending', 'running', 'menuconfig', 'compiling', 'done'] : ['pending', 'running', 'compiling', 'done'];
    const order = isManual ? ['pending', 'running', 'menuconfig', 'compiling', 'success'] : ['pending', 'running', 'compiling', 'success'];
    const failed = build.status === 'failed' || build.status === 'cancelled';
    const curIdx = failed ? order.length - 1 : order.indexOf(build.status);
    let html = '<div class="timeline">';
    steps.forEach((stepKey, i) => {
      const isDoneStep = stepKey === 'done';
      const stepOrderIdx = isDoneStep ? order.length - 1 : i;
      let cls = '';
      if (isDoneStep) { if (build.status === 'success') cls = 'done'; else if (failed) cls = 'failed'; else cls = ''; }
      else if (stepOrderIdx < curIdx) cls = 'done';
      else if (stepOrderIdx === curIdx && !failed) cls = 'current';
      else if (failed && stepOrderIdx === curIdx) cls = 'failed';
      html += \`<span class="step \${cls}" title="\${escapeHtml(isDoneStep ? (build.status === 'success' ? '成功' : (failed ? STATUS_LABELS[build.status] : '完成')) : STATUS_LABELS[stepKey])}"></span>\`;
      if (i < steps.length - 1) { const barDone = stepOrderIdx < curIdx; html += \`<span class="bar \${barDone ? 'done' : ''}"></span>\`; }
    });
    html += '</div>';
    return html;
  }
  
  function renderLogin() {
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div class="login-screen">
      <div class="card login-card">
        <div class="brand-mark">
          <div class="glyph">OW</div>
          <div class="title">OpenWrt 自动编译</div>
          <div class="desc">通过密码登录后台，管理编译模板与触发任务</div>
        </div>
        <form id="login-form">
          <div class="field">
            <label for="pw">访问密码</label>
            <input type="password" id="pw" name="pw" autocomplete="current-password" autofocus required />
          </div>
          <div class="error-msg" id="login-err" style="display:none;"></div>
          <button type="submit" class="primary" id="login-btn">登录</button>
        </form>
      </div>
    </div>\`;
    const form = qs(app, '#login-form');
    const errBox = qs(app, '#login-err');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pw = qs(app, '#pw').value;
      const btn = qs(app, '#login-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 登录中...';
      errBox.style.display = 'none';
      try {
        await api.login(pw);
        store.authed = true;
        try {
          const { status } = await api.setupStatus();
          store.systemStatus = status;
        } catch { store.systemStatus = 'ready'; }
        if (store.systemStatus === 'ready') {
          navigate('#/templates');
          await bootAfterLogin();
        } else {
          render();
        }
      } catch (e) {
        errBox.textContent = e.message || '登录失败';
        errBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '登录';
      }
    });
  }
  
  // 系统初始化页：首次访问，无密码时展示
  function renderSetupInit() {
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div class="login-screen">
      <div class="card login-card setup-card">
        <div class="brand-mark">
          <div class="glyph">OW</div>
          <div class="title">OpenWrt 编译系统 · 初始化</div>
          <div class="desc">检测到系统尚未设置登录密码，请先完成初始化</div>
        </div>
        <form id="setup-init-form">
          <div class="field">
            <label for="setup-pw">设置登录密码</label>
            <input type="password" id="setup-pw" minlength="6" autocomplete="new-password" autofocus required />
          </div>
          <div class="field">
            <label for="setup-pw2">确认密码</label>
            <input type="password" id="setup-pw2" minlength="6" autocomplete="new-password" required />
          </div>
          <div class="hint">密码至少 6 位，仅用于登录本系统的网页后台</div>
          <div class="error-msg" id="setup-init-err" style="display:none;"></div>
          <button type="submit" class="primary" id="setup-init-btn">初始化系统</button>
        </form>
      </div>
    </div>\`;
    const form = qs(app, '#setup-init-form');
    const errBox = qs(app, '#setup-init-err');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pw = qs(app, '#setup-pw').value;
      const pw2 = qs(app, '#setup-pw2').value;
      const btn = qs(app, '#setup-init-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 初始化中...';
      errBox.style.display = 'none';
      try {
        await api.setupInit(pw, pw2);
        store.authed = true;
        store.systemStatus = 'wizard';
        render();
      } catch (e) {
        errBox.textContent = e.message || '初始化失败';
        errBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '初始化系统';
      }
    });
  }
  
  // 部署向导页：登录后若 GitHub 配置未完成，自动展示
  function renderSetupWizard(opts) {
    const isReconfigure = !!(opts && opts.reconfigure);
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div class="login-screen">
      <div class="card login-card setup-card wide">
        <div class="brand-mark">
          <div class="glyph">OW</div>
          <div class="title">部署向导</div>
          <div class="desc">填写 Worker 与 GitHub 信息，完成最后一步配置</div>
        </div>
        <form id="wizard-form">
          <div class="field">
            <label for="wz-worker-url">Worker URL</label>
            <input type="url" id="wz-worker-url" placeholder="https://xxx.workers.dev" required />
            <div class="hint">默认填入当前网址，如有多个路由入口可自行修改</div>
          </div>
          <div class="field">
            <label for="wz-repo">GitHub 仓库</label>
            <input type="text" id="wz-repo" placeholder="owner/repo" required />
          </div>
          <div class="field">
            <label for="wz-token">GitHub PAT</label>
            <input type="password" id="wz-token" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off" required />
            <div class="hint">需具备目标仓库的 repo 权限，用于触发 repository_dispatch\${isReconfigure ? '。留空表示沿用原有 Token' : ''}</div>
          </div>
          <div class="error-msg" id="wizard-err" style="display:none;"></div>
          <button type="submit" class="primary" id="wizard-btn">保存并生成 REPORT_TOKEN</button>
          \${isReconfigure ? '<button type="button" class="ghost" id="wizard-cancel-btn" style="width:100%; margin-top:8px;">取消，返回主界面</button>' : ''}
        </form>
        <div id="wizard-result" style="display:none; margin-top:18px;">
          <div class="step-banner">✅ 生成成功！请前往 GitHub → Settings → Secrets → Actions，添加一条 <code>REPORT_TOKEN</code>，值见下方（退出本次设置后将不再显示明文，请立即复制）</div>
          <div class="token-box">
            <code id="wizard-token"></code>
            <button type="button" class="ghost small" id="wizard-copy-btn">复制</button>
          </div>
          <button type="button" class="primary" id="wizard-done-btn" style="width:100%; margin-top:16px;">完成，进入主界面</button>
        </div>
      </div>
    </div>\`;
    const wEl = qs(app, '#wz-worker-url');
    wEl.value = location.origin;
    if (isReconfigure) {
      api.getSettings().then((s) => {
        if (s.worker_url) wEl.value = s.worker_url;
        if (s.github_repo) qs(app, '#wz-repo').value = s.github_repo;
      }).catch(() => {});
      qs(app, '#wizard-cancel-btn')?.addEventListener('click', async () => {
        navigate('#/templates');
        await bootAfterLogin();
      });
    }
    const form = qs(app, '#wizard-form');
    const errBox = qs(app, '#wizard-err');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = qs(app, '#wizard-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 保存中...';
      errBox.style.display = 'none';
      try {
        const tokenInput = qs(app, '#wz-token').value.trim();
        if (!tokenInput && !isReconfigure) throw new Error('请填写 GitHub PAT');
        const { report_token } = await api.setupWizard({
          worker_url: qs(app, '#wz-worker-url').value.trim(),
          github_repo: qs(app, '#wz-repo').value.trim(),
          github_token: tokenInput,
          keep_existing_token: isReconfigure && !tokenInput,
        });
        form.style.display = 'none';
        const resultBox = qs(app, '#wizard-result');
        resultBox.style.display = 'block';
        qs(app, '#wizard-token').textContent = report_token;
        qs(app, '#wizard-copy-btn').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(report_token); toast('已复制'); } catch {}
        });
        qs(app, '#wizard-done-btn').addEventListener('click', async () => {
          store.systemStatus = 'ready';
          navigate('#/templates');
          await bootAfterLogin();
        });
      } catch (e) {
        errBox.textContent = e.message || '保存失败';
        errBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '保存并生成 REPORT_TOKEN';
      }
    });
  }
  
  function renderTopbar(activeName) {
    return \`
    <div class="topbar">
      <div class="brand"><span class="dot"></span><span class="label">OpenWrt 自动编译</span></div>
      <nav>
        <button data-nav="#/templates" class="\${activeName === 'templates' || activeName === 'template-detail' || activeName === 'trigger' ? 'active' : ''}">模板</button>
        <button data-nav="#/builds" class="\${activeName === 'builds' ? 'active' : ''}">编译记录</button>
      </nav>
      <div class="right">
        <button class="ghost small" id="import-tpl-btn">导入模板</button>
        <div class="settings-dropdown">
          <button class="ghost small" id="settings-btn">⚙️ ▾</button>
          <div class="menu" id="settings-menu">
            <button id="menu-reconfigure-github">重新配置 GitHub 连接</button>
            <button id="menu-reset-report-token">重置 REPORT_TOKEN</button>
            <div class="sep"></div>
            <div class="menu-label">危险区域</div>
            <button class="danger" id="menu-reset-all">重置所有配置</button>
            <div class="sep"></div>
            <button id="menu-logout">退出登录</button>
          </div>
        </div>
      </div>
    </div>\`;
  }
  
  function bindTopbar(root) {
    qsa(root, '[data-nav]').forEach((b) => { b.addEventListener('click', () => navigate(b.dataset.nav)); });
    qs(root, '#import-tpl-btn')?.addEventListener('click', openImportModal);
  
    const settingsBtn = qs(root, '#settings-btn');
    const menu = qs(root, '#settings-menu');
    if (settingsBtn && menu) {
      settingsBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.classList.toggle('open');
      });
      document.addEventListener('click', () => menu.classList.remove('open'), { once: true });
    }
  
    qs(root, '#menu-logout')?.addEventListener('click', async () => {
      try { await api.logout(); } catch {}
      store.authed = false;
      store.systemStatus = 'ready';
      renderLogin();
    });
  
    qs(root, '#menu-reconfigure-github')?.addEventListener('click', () => {
      renderSetupWizard({ reconfigure: true });
    });
  
    qs(root, '#menu-reset-report-token')?.addEventListener('click', async () => {
      if (!confirm('重置后旧的 REPORT_TOKEN 将立即失效，需要重新前往 GitHub 更新 Secret，确认继续？')) return;
      try {
        const { report_token } = await api.resetReportToken();
        showReportTokenModal(report_token);
      } catch (e) {
        reportApiError(e, '重置失败');
      }
    });
  
    qs(root, '#menu-reset-all')?.addEventListener('click', async () => {
      if (!confirm('这将清空全部配置（包括登录密码），系统会回到初始化状态，确认继续？')) return;
      try {
        await api.settingsReset('all');
        store.authed = false;
        store.systemStatus = 'uninitialized';
        render();
      } catch (e) {
        reportApiError(e, '重置失败');
      }
    });
  }
  
  function showReportTokenModal(token) {
    const overlay = el(\`
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:480px;">
        <div class="modal-head"><h3>新的 REPORT_TOKEN</h3><button class="ghost small" id="rt-close-btn">关闭</button></div>
        <div class="modal-body">
          <div class="step-banner">请前往 GitHub → Settings → Secrets → Actions，更新 <code>REPORT_TOKEN</code> 的值为下方内容。关闭本窗口后将不再显示明文。</div>
          <div class="token-box">
            <code id="rt-token-text">\${escapeHtml(token)}</code>
            <button type="button" class="ghost small" id="rt-copy-btn">复制</button>
          </div>
        </div>
      </div>
    </div>\`);
    document.body.appendChild(overlay);
    qs(overlay, '#rt-close-btn').addEventListener('click', () => overlay.remove());
    qs(overlay, '#rt-copy-btn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(token); toast('已复制'); } catch {}
    });
  }
  
  async function renderTemplatesPage() {
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div id="toast-wrap" class="toast-wrap"></div>
    \${renderTopbar('templates')}
    <div class="content">
      <div class="page-head">
        <div>
          <h1>编译模板</h1>
          <div class="sub">每个模板对应一套源码、插件与 .config 配置</div>
        </div>
        <div class="actions">
          <button class="primary" id="new-tpl-btn">+ 新建模板</button>
        </div>
      </div>
      <div id="tpl-list-area"><div style="text-align:center;padding:40px;"><span class="spinner"></span></div></div>
    </div>\`;
    bindTopbar(app);
    qs(app, '#new-tpl-btn').addEventListener('click', () => openTemplateEditModal(null));
    try {
      const { templates } = await api.listTemplates();
      store.templates = templates;
      renderTemplateList(templates);
    } catch (e) {
      qs(app, '#tpl-list-area').innerHTML = \`<div class="empty-state"><div class="msg">加载失败：\${escapeHtml(e.message)}</div></div>\`;
    }
  }
  
  function renderTemplateList(templates) {
    const area = document.getElementById('tpl-list-area');
    if (!area) return;
    if (!templates.length) {
      area.innerHTML = \`
      <div class="empty-state">
        <div class="glyph">∅</div>
        <div class="msg">还没有任何编译模板</div>
        <div class="sub">点击右上角"新建模板"开始，或导入已有的模板文件</div>
      </div>\`;
      return;
    }
    area.innerHTML = \`<div class="template-grid">\${templates.map(templateRowHtml).join('')}</div>\`;
    qsa(area, '.template-row').forEach((row) => {
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-stop]')) return;
        navigate(\`#/template/\${row.dataset.id}\`);
      });
    });
  }
  
  function templateRowHtml(t) {
    const pluginCount = (t.plugins || []).length;
    const schedTag = t.schedule_enabled ? \`<span class="badge warn">定时 \${escapeHtml(t.schedule_cron || '')}</span>\` : \`<span class="badge dim">未定时</span>\`;
    return \`
    <div class="template-row" data-id="\${t.id}">
      <div class="main">
        <div class="name">\${escapeHtml(t.name)}</div>
        <div class="meta">\${escapeHtml(t.target)} · \${escapeHtml(t.branch)} · \${pluginCount} 个插件</div>
      </div>
      <div class="tags">\${schedTag}</div>
      <div class="chevron">›</div>
    </div>\`;
  }
  
  function openModal(html, { onMount } = {}) {
    const overlay = el(\`<div class="modal-overlay">\${html}</div>\`);
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) closeModal(overlay); });
    const onKey = (ev) => { if (ev.key === 'Escape') closeModal(overlay); };
    document.addEventListener('keydown', onKey);
    overlay._onKey = onKey;
    if (onMount) onMount(overlay);
    return overlay;
  }
  
  function closeModal(overlay) {
    if (!overlay) return;
    document.removeEventListener('keydown', overlay._onKey);
    overlay.remove();
  }
  
  function pluginItemHtml(p = {}, idx) {
    const sparse = !!p.sparse;
    return \`
    <div class="plugin-item" data-idx="\${idx}">
      <div class="row1">
        <input type="text" class="p-name" placeholder="插件名" value="\${escapeHtml(p.name || '')}" />
        <button type="button" class="ghost small remove-btn" data-remove>删除</button>
      </div>
      <input type="text" class="p-url" placeholder="git_url，例如 https://github.com/xxx/yyy" value="\${escapeHtml(p.git_url || '')}" style="margin-bottom:8px;" />
      <div class="sparse-row">
        <label class="inline"><input type="checkbox" class="p-sparse" \${sparse ? 'checked' : ''}/> 稀疏克隆</label>
      </div>
      <div class="sub-fields" style="display:\${sparse ? 'flex' : 'none'};">
        <input type="text" class="p-branch" placeholder="branch" value="\${escapeHtml(p.branch || '')}" />
        <input type="text" class="p-dirs" placeholder="子目录，逗号分隔" value="\${escapeHtml((p.dirs || []).join(','))}" />
      </div>
    </div>\`;
  }
  
  function bindPluginList(container) {
    function rebind() {
      qsa(container, '.plugin-item').forEach((item) => {
        const sparseBox = qs(item, '.p-sparse');
        const subFields = qs(item, '.sub-fields');
        sparseBox.onchange = () => { subFields.style.display = sparseBox.checked ? 'flex' : 'none'; };
        qs(item, '[data-remove]').onclick = () => { item.remove(); };
      });
    }
    rebind();
    return rebind;
  }
  
  function readPluginsFromContainer(container) {
    return qsa(container, '.plugin-item').map((item) => {
      const name = qs(item, '.p-name').value.trim();
      const git_url = qs(item, '.p-url').value.trim();
      const sparse = qs(item, '.p-sparse').checked;
      const plugin = { name, git_url, sparse };
      if (sparse) {
        plugin.branch = qs(item, '.p-branch').value.trim();
        plugin.dirs = qs(item, '.p-dirs').value.split(',').map((s) => s.trim()).filter(Boolean);
      }
      return plugin;
    }).filter((p) => p.name && p.git_url);
  }
  
  function openTemplateEditModal(tpl) {
    const isEdit = !!tpl;
    const overlay = openModal(\`
    <div class="modal-box">
      <div class="modal-head">
        <h3>\${isEdit ? '编辑模板' : '新建模板'}</h3>
        <button class="ghost small" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>模板名称</label>
          <input type="text" id="f-name" value="\${escapeHtml(tpl?.name || '')}" placeholder="例如：小米 AX3600 · 翻墙版" />
        </div>
        <div class="field">
          <label>源码仓库 repo_url</label>
          <input type="text" id="f-repo" value="\${escapeHtml(tpl?.repo_url || '')}" placeholder="https://github.com/coolsnowwolf/lede" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>分支 branch</label>
            <input type="text" id="f-branch" value="\${escapeHtml(tpl?.branch || 'master')}" />
          </div>
          <div class="field">
            <label>目标平台 target</label>
            <input type="text" id="f-target" value="\${escapeHtml(tpl?.target || '')}" placeholder="mediatek/mt7986a" />
          </div>
        </div>
        <div class="field">
          <label>插件列表</label>
          <div class="plugin-list" id="plugin-list"></div>
          <button type="button" class="small" id="add-plugin-btn">+ 添加插件</button>
        </div>
        <div class="field">
          <label>自定义脚本 (feeds update 之前执行)</label>
          <textarea id="f-script1" rows="5" placeholder="#!/bin/bash">\${escapeHtml(tpl?.diy_script_1 || '')}</textarea>
        </div>
        <div class="field">
          <label>自定义脚本② (feeds install 之后执行)</label>
          <textarea id="f-script2" rows="5" placeholder="#!/bin/bash">\${escapeHtml(tpl?.diy_script_2 || '')}</textarea>
        </div>
      </div>
      <div class="modal-foot">
        <button data-close>取消</button>
        <button class="primary" id="save-tpl-btn">\${isEdit ? '保存更改' : '创建模板'}</button>
      </div>
    </div>\`, {
      onMount(root) {
        const list = qs(root, '#plugin-list');
        const plugins = tpl?.plugins || [];
        list.innerHTML = plugins.map((p, i) => pluginItemHtml(p, i)).join('');
        let rebind = bindPluginList(list);
        qs(root, '#add-plugin-btn').addEventListener('click', () => {
          list.insertAdjacentHTML('beforeend', pluginItemHtml({}, list.children.length));
          rebind = bindPluginList(list);
        });
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        qs(root, '#save-tpl-btn').addEventListener('click', async () => {
          const body = {
            name: qs(root, '#f-name').value.trim(),
            repo_url: qs(root, '#f-repo').value.trim(),
            branch: qs(root, '#f-branch').value.trim(),
            target: qs(root, '#f-target').value.trim(),
            plugins: readPluginsFromContainer(list),
            diy_script_1: qs(root, '#f-script1').value,
            diy_script_2: qs(root, '#f-script2').value,
          };
          if (!body.name || !body.repo_url || !body.branch || !body.target) {
            toast('请填写名称 / 仓库 / 分支 / 目标平台', 'error'); return;
          }
          const btn = qs(root, '#save-tpl-btn');
          btn.disabled = true;
          try {
            if (isEdit) {
              await api.updateTemplate(tpl.id, body);
              toast('模板已更新', 'success');
            } else {
              const res = await api.createTemplate(body);
              toast('模板已创建', 'success');
              closeModal(root);
              navigate(\`#/template/\${res.template.id}\`);
              return;
            }
            closeModal(root);
            if (store.route.name === 'template-detail') renderTemplateDetailPage(store.route.params.id);
            else renderTemplatesPage();
          } catch (e) {
            reportApiError(e, '保存失败');
            btn.disabled = false;
          }
        });
      }
    });
    return overlay;
  }
  
  function openImportModal() {
    const overlay = openModal(\`
    <div class="modal-box" style="max-width:480px;">
      <div class="modal-head">
        <h3>导入模板</h3>
        <button class="ghost small" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>选择 .openwrt-template.json 文件</label>
          <input type="file" id="import-file" accept=".json,application/json" />
        </div>
        <div class="hint">导入后将新建一个模板，若与现有模板重名会自动加 "(导入)"后缀</div>
        <div id="import-err" class="error-msg" style="display:none; margin-top:10px;"></div>
      </div>
      <div class="modal-foot">
        <button data-close>取消</button>
        <button class="primary" id="do-import-btn" disabled>导入</button>
      </div>
    </div>\`, {
      onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        const fileInput = qs(root, '#import-file');
        const importBtn = qs(root, '#do-import-btn');
        const errBox = qs(root, '#import-err');
        let parsed = null;
        fileInput.addEventListener('change', async () => {
          errBox.style.display = 'none';
          importBtn.disabled = true;
          parsed = null;
          const file = fileInput.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            parsed = JSON.parse(text);
            if (parsed.export_version !== 1) throw new Error(\`不支持的 export_version: \${parsed.export_version}\`);
            importBtn.disabled = false;
          } catch (e) {
            errBox.textContent = \`文件解析失败：\${e.message}\`;
            errBox.style.display = 'block';
          }
        });
        importBtn.addEventListener('click', async () => {
          if (!parsed) return;
          importBtn.disabled = true;
          importBtn.innerHTML = '<span class="spinner"></span> 导入中...';
          try {
            const res = await api.importTemplate(parsed);
            toast('模板导入成功', 'success');
            closeModal(root);
            navigate(\`#/template/\${res.template.id}\`);
          } catch (e) {
            errBox.textContent = e.message || '导入失败';
            errBox.style.display = 'block';
            importBtn.disabled = false;
            importBtn.textContent = '导入';
          }
        });
      }
    });
    return overlay;
  }
  
  async function renderTemplateDetailPage(id) {
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div id="toast-wrap" class="toast-wrap"></div>
    \${renderTopbar('template-detail')}
    <div class="content">
      <div class="detail-back"><button class="ghost small" id="back-btn">‹ 返回模板列表</button></div>
      <div id="detail-area"><div style="text-align:center;padding:40px;"><span class="spinner"></span></div></div>
    </div>\`;
    bindTopbar(app);
    qs(app, '#back-btn').addEventListener('click', () => navigate('#/templates'));
    let tpl, history;
    try {
      [{ template: tpl }, { history }] = await Promise.all([api.getTemplate(id), api.listHistory(id)]);
    } catch (e) {
      qs(app, '#detail-area').innerHTML = \`<div class="empty-state"><div class="msg">加载失败：\${escapeHtml(e.message)}</div></div>\`;
      return;
    }
    renderTemplateDetailBody(tpl, history);
  }
  
  function renderTemplateDetailBody(tpl, history) {
    const area = document.getElementById('detail-area');
    area.innerHTML = \`
    <div class="page-head">
      <div>
        <h1>\${escapeHtml(tpl.name)}</h1>
        <div class="sub mono">\${escapeHtml(tpl.repo_url)} @ \${escapeHtml(tpl.branch)} · \${escapeHtml(tpl.target)}</div>
      </div>
      <div class="actions">
        <button id="edit-tpl-btn">编辑模板</button>
        <button class="primary" id="goto-trigger-btn">触发编译</button>
      </div>
    </div>
    <div class="section">
      <h2>
        <span>.config 版本历史</span>
        <span class="actions">
          <button class="small" id="export-tpl-btn">导出模板</button>
          <button class="small" id="upload-cfg-btn">上传新版本</button>
        </span>
      </h2>
      <div id="version-history-area"></div>
    </div>
    <div class="section">
      <h2><span>定时编译</span></h2>
      <div id="schedule-area"></div>
    </div>
    <div class="section">
      <h2><span>插件 (\${(tpl.plugins || []).length})</span></h2>
      <div id="plugin-readonly-area"></div>
    </div>
    <div class="section">
      <h2><span>危险操作</span></h2>
      <button class="danger" id="delete-tpl-btn">删除该模板</button>
    </div>\`;
  
    qs(area, '#edit-tpl-btn').addEventListener('click', () => openTemplateEditModal(tpl));
    qs(area, '#goto-trigger-btn').addEventListener('click', () => navigate(\`#/trigger/\${tpl.id}\`));
    qs(area, '#export-tpl-btn').addEventListener('click', () => exportTemplate(tpl));
    qs(area, '#upload-cfg-btn').addEventListener('click', () => openUploadConfigModal(tpl));
    qs(area, '#delete-tpl-btn').addEventListener('click', () => confirmDeleteTemplate(tpl));
    renderVersionHistory(tpl, history);
    renderScheduleSection(tpl, history);
    renderPluginReadonly(tpl);
  }
  
  function renderPluginReadonly(tpl) {
    const wrap = document.getElementById('plugin-readonly-area');
    const plugins = tpl.plugins || [];
    if (!plugins.length) { wrap.innerHTML = \`<div class="hint">未配置插件</div>\`; return; }
    wrap.innerHTML = plugins.map((p) => \`
      <div class="hint mono" style="margin-bottom:4px;">
        \${escapeHtml(p.name)} — \${escapeHtml(p.git_url)}\${p.sparse ? \` (稀疏: \${escapeHtml((p.dirs || []).join(', '))} @ \${escapeHtml(p.branch || '')})\` : ''}
      </div>\`).join('');
  }
  
  async function exportTemplate(tpl) {
    try {
      const resp = await fetch(\`/api/templates/\${tpl.id}/export\`, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error(\`导出失败 (\${resp.status})\`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`\${tpl.name}.openwrt-template.json\`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('已导出模板文件', 'success');
    } catch (e) { reportApiError(e, '导出失败'); }
  }
  
  function confirmDeleteTemplate(tpl) {
    const overlay = openModal(\`
    <div class="modal-box" style="max-width:420px;">
      <div class="modal-head"><h3>删除模板</h3><button class="ghost small" data-close>✕</button></div>
      <div class="modal-body">
        <p>确定删除模板「\${escapeHtml(tpl.name)}」？关联的所有 .config 历史版本也会被一并删除，此操作不可恢复。</p>
      </div>
      <div class="modal-foot">
        <button data-close>取消</button>
        <button class="danger" id="confirm-del-btn">确定删除</button>
      </div>
    </div>\`, {
      onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        qs(root, '#confirm-del-btn').addEventListener('click', async () => {
          try {
            await api.deleteTemplate(tpl.id);
            toast('模板已删除', 'success');
            closeModal(root);
            navigate('#/templates');
          } catch (e) { reportApiError(e, '删除失败'); }
        });
      }
    });
  }
  
  function renderVersionHistory(tpl, history) {
    const wrap = document.getElementById('version-history-area');
    if (!history.length) {
      wrap.innerHTML = \`
      <div class="empty-state">
        <div class="msg">暂无 .config 版本</div>
        <div class="sub">上传一份 .config，或先触发一次手动编译并在 menuconfig 中保存退出</div>
      </div>\`;
      return;
    }
    const rows = history.map((v, idx) => {
      const isCurrent = tpl.dotconfig_version_id === v.id;
      const isSched = tpl.schedule_dotconfig_version_id === v.id;
      const refTags = \`\${isCurrent ? '<span class="ref-tag">当前</span>' : ''}\${isSched ? '<span class="ref-tag sched">定时</span>' : ''}\`;
      const canDelete = !isCurrent && !isSched;
      return \`
      <tr data-vid="\${v.id}">
        <td>\${history.length - idx}</td>
        <td class="source-tag">\${SOURCE_LABELS[v.source] || v.source}</td>
        <td class="mono" style="font-size:12px;color:var(--text-faint);">\${fmtTime(v.created_at)}</td>
        <td>
          <div class="label-cell">
            <span class="label-text" data-label-text>\${escapeHtml(v.label || '—')}</span>
            <button class="ghost small label-edit-btn" data-edit-label title="编辑备注">✎</button>
          </div>
        </td>
        <td>\${refTags || ''}</td>
        <td>
          <div class="ops">
            <button class="ghost small" data-view>查看</button>
            <button class="ghost small" data-download>下载</button>
            \${isCurrent ? '' : '<button class="small" data-set-current>设为当前</button>'}
            \${isSched ? '' : '<button class="small" data-set-sched>设为定时用</button>'}
            <button class="ghost small danger" data-delete \${canDelete ? '' : 'disabled title="请先切换引用再删除"'}>删除</button>
          </div>
        </td>
      </tr>\`;
    }).join('');
    wrap.innerHTML = \`
    <div style="overflow-x:auto;">
      <table class="version-table">
        <thead>
          <tr><th>#</th><th>来源</th><th>时间</th><th>备注</th><th>引用</th><th style="text-align:right;">操作</th></tr>
        </thead>
        <tbody>\${rows}</tbody>
      </table>
    </div>\`;
    qsa(wrap, 'tr[data-vid]').forEach((row) => {
      const vid = row.dataset.vid;
      const versionMeta = history.find((h) => h.id === vid);
      qs(row, '[data-view]').addEventListener('click', () => viewVersionContent(tpl.id, vid, versionMeta));
      qs(row, '[data-download]').addEventListener('click', () => downloadVersionContent(tpl.id, vid));
      qs(row, '[data-edit-label]').addEventListener('click', () => editVersionLabel(tpl.id, vid, row, versionMeta));
      const setCurBtn = qs(row, '[data-set-current]');
      if (setCurBtn) setCurBtn.addEventListener('click', async () => {
        try { await api.setCurrentDotconfig(tpl.id, vid); toast('已设为当前版本', 'success'); refreshTemplateDetail(tpl.id); } catch (e) { reportApiError(e, '设置失败'); }
      });
      const setSchedBtn = qs(row, '[data-set-sched]');
      if (setSchedBtn) setSchedBtn.addEventListener('click', async () => {
        try { await api.setSchedule(tpl.id, { dotconfig_version_id: vid, enabled: tpl.schedule_enabled, cron: tpl.schedule_cron }); toast('已设为定时任务使用版本', 'success'); refreshTemplateDetail(tpl.id); } catch (e) { reportApiError(e, '设置失败'); }
      });
      const delBtn = qs(row, '[data-delete]');
      if (delBtn && !delBtn.disabled) delBtn.addEventListener('click', () => confirmDeleteVersion(tpl.id, vid));
    });
  }
  
  async function refreshTemplateDetail(tplId) {
    try {
      const [{ template }, { history }] = await Promise.all([api.getTemplate(tplId), api.listHistory(tplId)]);
      renderTemplateDetailBody(template, history);
    } catch (e) { reportApiError(e, '刷新失败'); }
  }
  
  async function viewVersionContent(tplId, vid, meta) {
    const overlay = openModal(\`
    <div class="modal-box" style="max-width:700px;">
      <div class="modal-head"><h3>.config 内容\${meta?.label ? ' — ' + escapeHtml(meta.label) : ''}</h3><button class="ghost small" data-close>✕</button></div>
      <div class="modal-body"><div class="code-view" id="cfg-view">加载中...</div></div>
      <div class="modal-foot"><button data-close>关闭</button></div>
    </div>\`, {
      async onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        try {
          const { version } = await api.getHistoryVersion(tplId, vid);
          qs(root, '#cfg-view').textContent = version.content;
        } catch (e) { qs(root, '#cfg-view').textContent = \`加载失败：\${e.message}\`; }
      }
    });
    return overlay;
  }
  
  async function downloadVersionContent(tplId, vid) {
    try {
      const { version } = await api.getHistoryVersion(tplId, vid);
      const blob = new Blob([version.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '.config';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { reportApiError(e, '下载失败'); }
  }
  
  function editVersionLabel(tplId, vid, row, meta) {
    const cell = qs(row, '[data-edit-label]').closest('.label-cell');
    const current = meta?.label || '';
    cell.innerHTML = \`
    <input type="text" class="label-input" value="\${escapeHtml(current)}" style="font-size:12.5px;padding:4px 8px;" />
    <button class="ghost small" data-save-label>保存</button>\`;
    const input = qs(cell, '.label-input');
    input.focus();
    const save = async () => {
      try { await api.patchLabel(tplId, vid, input.value.trim()); toast('备注已更新', 'success'); refreshTemplateDetail(tplId); } catch (e) { reportApiError(e, '更新失败'); }
    };
    qs(cell, '[data-save-label]').addEventListener('click', save);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
  }
  
  function confirmDeleteVersion(tplId, vid) {
    const overlay = openModal(\`
    <div class="modal-box" style="max-width:400px;">
      <div class="modal-head"><h3>删除版本</h3><button class="ghost small" data-close>✕</button></div>
      <div class="modal-body"><p>确定删除该 .config 历史版本？此操作不可恢复。</p></div>
      <div class="modal-foot">
        <button data-close>取消</button>
        <button class="danger" id="confirm-del-v-btn">确定删除</button>
      </div>
    </div>\`, {
      onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        qs(root, '#confirm-del-v-btn').addEventListener('click', async () => {
          try { await api.deleteVersion(tplId, vid); toast('版本已删除', 'success'); closeModal(root); refreshTemplateDetail(tplId); } catch (e) { reportApiError(e, '删除失败'); }
        });
      }
    });
  }
  
  function openUploadConfigModal(tpl) {
    const overlay = openModal(\`
    <div class="modal-box" style="max-width:640px;">
      <div class="modal-head"><h3>上传新 .config 版本</h3><button class="ghost small" data-close>✕</button></div>
      <div class="modal-body">
        <div class="field">
          <label>选择文件（可选，也可直接粘贴到下方文本框）</label>
          <input type="file" id="cfg-file" accept=".config,text/plain" />
        </div>
        <div class="field">
          <label>.config 内容</label>
          <textarea id="cfg-content" rows="12" placeholder="CONFIG_TARGET_xxx=y ..."></textarea>
        </div>
        <div class="field">
          <label>备注（可选）</label>
          <input type="text" id="cfg-label" placeholder="例如：稳定版" />
        </div>
      </div>
      <div class="modal-foot">
        <button data-close>取消</button>
        <button class="primary" id="do-upload-btn">上传</button>
      </div>
    </div>\`, {
      onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        qs(root, '#cfg-file').addEventListener('change', async (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          qs(root, '#cfg-content').value = await file.text();
        });
        qs(root, '#do-upload-btn').addEventListener('click', async () => {
          const content = qs(root, '#cfg-content').value;
          if (!content.trim()) { toast('内容不能为空', 'error'); return; }
          const btn = qs(root, '#do-upload-btn');
          btn.disabled = true;
          try {
            await api.uploadDotconfig(tpl.id, { content, label: qs(root, '#cfg-label').value.trim() || undefined });
            toast('上传成功', 'success');
            closeModal(root);
            refreshTemplateDetail(tpl.id);
          } catch (e) { reportApiError(e, '上传失败'); btn.disabled = false; }
        });
      }
    });
    return overlay;
  }
  
  const CRON_PRESETS = [
    { label: '每天凌晨 2 点 UTC)', cron: '0 2 * * *' },
    { label: '每天中午 12 点 UTC)', cron: '0 12 * * *' },
    { label: '每周六 14 点 UTC)', cron: '0 14 * * 6' },
  ];
  
  function renderScheduleSection(tpl, history) {
    const wrap = document.getElementById('schedule-area');
    const enabled = !!tpl.schedule_enabled;
    const versionOptions = history.map((v) => {
      const tagBits = [];
      if (tpl.dotconfig_version_id === v.id) tagBits.push('当前');
      if (tpl.schedule_dotconfig_version_id === v.id) tagBits.push('定时');
      const label = \`\${SOURCE_LABELS[v.source] || v.source} \${fmtTime(v.created_at)}\${v.label ? ' "' + v.label + '"' : ''}\${tagBits.length ? ' (' + tagBits.join('/') + ')' : ''}\`;
      const selected = v.id === tpl.schedule_dotconfig_version_id ? 'selected' : '';
      return \`<option value="\${v.id}" \${selected}>\${escapeHtml(label)}</option>\`;
    }).join('');
    wrap.innerHTML = \`
    <div class="schedule-form">
      <div class="schedule-toggle-row">
        <div class="switch">
          <input type="checkbox" id="sched-enabled" \${enabled ? 'checked' : ''} />
          <label for="sched-enabled" class="track"></label>
        </div>
        <span>启用定时编译</span>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Cron 表达式</label>
        <input type="text" id="sched-cron" value="\${escapeHtml(tpl.schedule_cron || '')}" placeholder="0 2 * * *" />
        <div class="cron-presets">
          \${CRON_PRESETS.map((p) => \`<button type="button" class="ghost" data-cron="\${p.cron}">\${p.label}</button>\`).join('')}
        </div>
        <div class="hint">Cloudflare 免费计划最多 3 个 cron 槽位；实际触发有约 30 秒抖动</div>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>使用版本</label>
        \${history.length ? \`<select id="sched-version"><option value="">— 未选择 —</option>\${versionOptions}</select>\` : \`<div class="hint">该模板暂无任何 .config 版本，请先上传一份才能启用定时编译</div>\`}
      </div>
      <div class="warn-line">⚠️ 定时编译必须选择一个 .config 版本，否则无法保存启用状态</div>
      <div>
        <button class="primary" id="save-sched-btn">保存定时设置</button>
      </div>
    </div>\`;
    qsa(wrap, '[data-cron]').forEach((b) => { b.addEventListener('click', () => { qs(wrap, '#sched-cron').value = b.dataset.cron; }); });
    qs(wrap, '#save-sched-btn').addEventListener('click', async () => {
      const enabledNow = qs(wrap, '#sched-enabled').checked;
      const cron = qs(wrap, '#sched-cron').value.trim();
      const versionSelect = qs(wrap, '#sched-version');
      const versionId = versionSelect ? versionSelect.value || undefined : undefined;
      if (enabledNow && !versionId) { toast('定时编译必须选择一个 .config 版本', 'error'); return; }
      if (enabledNow && !cron) { toast('请填写 cron 表达式', 'error'); return; }
      const btn = qs(wrap, '#save-sched-btn');
      btn.disabled = true;
      try {
        await api.setSchedule(tpl.id, { enabled: enabledNow, cron: cron || null, dotconfig_version_id: versionId });
        toast('定时设置已保存', 'success');
        refreshTemplateDetail(tpl.id);
      } catch (e) { reportApiError(e, '保存失败'); btn.disabled = false; }
    });
  }
  
  async function renderTriggerPage(tplId) {
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div id="toast-wrap" class="toast-wrap"></div>
    \${renderTopbar('trigger')}
    <div class="content">
      <div class="detail-back"><button class="ghost small" id="back-btn">‹ 返回模板详情</button></div>
      <div id="trigger-area"><div style="text-align:center;padding:40px;"><span class="spinner"></span></div></div>
    </div>\`;
    bindTopbar(app);
    qs(app, '#back-btn').addEventListener('click', () => navigate(\`#/template/\${tplId}\`));
    let tpl, history;
    try {
      [{ template: tpl }, { history }] = await Promise.all([api.getTemplate(tplId), api.listHistory(tplId)]);
    } catch (e) {
      qs(app, '#trigger-area').innerHTML = \`<div class="empty-state"><div class="msg">加载失败：\${escapeHtml(e.message)}</div></div>\`;
      return;
    }
    renderTriggerForm(tpl, history);

    // 页面刷新后自动恢复轮询：检查该模板是否有进行中的 build
    try {
      const { builds } = await api.listBuilds();
      const active = builds.find((b) =>
        b.template_id === tplId &&
        ['pending', 'running', 'menuconfig', 'compiling'].includes(b.status)
      );
      if (active) startBuildWatch(active.id);
    } catch {}
  }
  
  function renderTriggerForm(tpl, history) {
    const area = document.getElementById('trigger-area');
    const versionOptions = history.map((v) => {
      const tagBits = [];
      if (tpl.dotconfig_version_id === v.id) tagBits.push('当前');
      if (tpl.schedule_dotconfig_version_id === v.id) tagBits.push('定时');
      const label = \`\${SOURCE_LABELS[v.source] || v.source} \${fmtTime(v.created_at)}\${v.label ? ' "' + v.label + '"' : ''}\${tagBits.length ? ' (' + tagBits.join('/') + ')' : ''}\`;
      return \`<option value="\${v.id}">\${escapeHtml(label)}</option>\`;
    }).join('');
    const defaultVersion = tpl.dotconfig_version_id || '';
    area.innerHTML = \`
    <div class="page-head">
      <div>
        <h1>触发编译 — \${escapeHtml(tpl.name)}</h1>
        <div class="sub">手动触发将进入网页终端做 menuconfig 配置，保存退出后自动编译</div>
      </div>
    </div>
    <div class="section trigger-panel">
      <h2><span>menuconfig 底稿（可选）</span></h2>
      <label class="radio-option \${!history.length ? 'selected' : ''}" data-radio-wrap>
        <input type="radio" name="dotconfig-mode" value="none" \${!history.length ? 'checked' : ''} />
        <div class="opt-body">
          <div class="opt-title">无（从零开始，menuconfig 全部默认值）</div>
        </div>
      </label>
      <label class="radio-option \${history.length ? 'selected' : ''}" data-radio-wrap>
        <input type="radio" name="dotconfig-mode" value="history" \${history.length ? 'checked' : ''} \${!history.length ? 'disabled' : ''} />
        <div class="opt-body">
          <div class="opt-title">使用历史版本：</div>
          \${history.length ? \`<select id="version-select">\${versionOptions}</select>\` : \`<div class="hint">该模板暂无历史版本</div>\`}
        </div>
      </label>
      <div>
        <button class="primary" id="do-trigger-btn">触发编译</button>
      </div>
    </div>
    <div id="trigger-result-area"></div>\`;
    if (defaultVersion) {
      const sel = qs(area, '#version-select');
      if (sel) sel.value = defaultVersion;
    }
    qsa(area, '[data-radio-wrap]').forEach((wrap) => {
      const radio = qs(wrap, 'input[type=radio]');
      radio.addEventListener('change', () => {
        qsa(area, '[data-radio-wrap]').forEach((w) => w.classList.remove('selected'));
        if (radio.checked) wrap.classList.add('selected');
      });
    });
    qs(area, '#do-trigger-btn').addEventListener('click', async () => {
      const mode = area.querySelector('input[name=dotconfig-mode]:checked')?.value;
      const versionId = mode === 'history' ? qs(area, '#version-select')?.value : null;
      const btn = qs(area, '#do-trigger-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 触发中...';
      try {
        const res = await api.trigger({ template_id: tpl.id, dotconfig_version_id: versionId || undefined });
        toast('已触发编译任务', 'success');
        startBuildWatch(res.build_id);
      } catch (e) { reportApiError(e, '触发失败'); btn.disabled = false; btn.textContent = '触发编译'; }
    });
  }
  
  function startBuildWatch(buildId) {
    const resultArea = document.getElementById('trigger-result-area');
    if (!resultArea) return;
    if (store.pollTimer) { clearInterval(store.pollTimer); store.pollTimer = null; }
    async function tick() {
      let build;
      try { const res = await api.getBuild(buildId); build = res.build; } catch (e) { return; }
      renderBuildWatchCard(resultArea, build);
      if (['success', 'failed', 'cancelled'].includes(build.status)) { clearInterval(store.pollTimer); store.pollTimer = null; }
    }
    tick();
    store.pollTimer = setInterval(tick, 5000);
  }
  
  function renderBuildWatchCard(container, build) {
    const showTerminal = build.status === 'menuconfig' && build.web_url;
    container.innerHTML = \`
    <div class="section">
      <h2><span>编译状态</span><span class="badge \${statusBadgeClass(build.status)}">\${STATUS_LABELS[build.status] || build.status}</span></h2>
      \${renderTimeline(build)}
      <div class="timeline-labels">
        \${(build.trigger_type === 'scheduled' ? ['排队', '准备', '编译', '完成'] : ['排队', '准备', '配置', '编译', '完成']).map((l) => \`<span>\${l}</span>\`).join('')}
      </div>
      \${showTerminal ? \`
      <div style="margin-top:18px;padding:20px;background:var(--panel-raised);border:1px solid var(--border);border-radius:var(--radius-lg);text-align:center;">
        <div style="font-size:13px;color:var(--text-dim);margin-bottom:14px;">
          menuconfig 终端已就绪，在 ncurses 界面完成配置后保存退出，自动推送并开始编译
        </div>
        <a href="\${escapeHtml(build.web_url)}" target="_blank" rel="noopener">
          <button class="primary" style="font-size:14px;padding:10px 28px;">🖥️ 打开 menuconfig 终端</button>
        </a>
        <div class="hint" style="margin-top:10px;">将在新窗口打开，可随时关闭后重新点击进入</div>
      </div>\` : ''}
      \${build.status === 'success' && build.download_url ? \`<div class="links"><a href="\${escapeHtml(build.download_url)}" target="_blank" rel="noopener">下载编译产物 →</a></div>\` : ''}
      \${build.status === 'failed' ? \`<div class="hint" style="color:var(--bad);margin-top:10px;">编译失败，可在编译记录中查看详情</div>\` : ''}
    </div>\`;
  }
  
  async function renderBuildsPage() {
    const app = document.getElementById('app');
    app.innerHTML = \`
    <div id="toast-wrap" class="toast-wrap"></div>
    \${renderTopbar('builds')}
    <div class="content">
      <div class="page-head">
        <div>
          <h1>编译记录</h1>
          <div class="sub">最近的手动与定时编译任务</div>
        </div>
        <div class="actions"><button class="ghost small" id="refresh-builds-btn">刷新</button></div>
      </div>
      <div id="builds-list-area"><div style="text-align:center;padding:40px;"><span class="spinner"></span></div></div>
    </div>\`;
    bindTopbar(app);
    qs(app, '#refresh-builds-btn').addEventListener('click', loadBuildsList);
    await loadBuildsList();
  }
  
  async function loadBuildsList() {
    const area = document.getElementById('builds-list-area');
    if (!area) return;
    try {
      const { builds } = await api.listBuilds();
      store.builds = builds;
      renderBuildsList(builds);
    } catch (e) {
      area.innerHTML = \`<div class="empty-state"><div class="msg">加载失败：\${escapeHtml(e.message)}</div></div>\`;
    }
  }
  
  function renderBuildsList(builds) {
    const area = document.getElementById('builds-list-area');
    if (!builds.length) {
      area.innerHTML = \`
      <div class="empty-state">
        <div class="glyph">∅</div>
        <div class="msg">还没有任何编译记录</div>
        <div class="sub">前往某个模板触发一次编译试试</div>
      </div>\`;
      return;
    }
    const tplNameOf = (id) => (store.templates.find((t) => t.id === id) || {}).name || id || '—';
    area.innerHTML = builds.map((b) => \`
    <div class="build-row">
      <div class="top-line">
        <div class="left-info">
          <span class="tpl-name">\${escapeHtml(tplNameOf(b.template_id))}</span>
          <span class="badge dim">\${b.trigger_type === 'scheduled' ? '定时' : '手动'}</span>
          <span class="badge \${statusBadgeClass(b.status)}">\${STATUS_LABELS[b.status] || b.status}</span>
        </div>
        <span class="time">\${fmtTime(b.created_at)}</span>
      </div>
      \${renderTimeline(b)}
      <div class="links">
        \${b.web_url ? \`<a href="\${escapeHtml(b.web_url)}" target="_blank" rel="noopener">打开网页终端 →</a>\` : ''}
        \${b.download_url ? \`<a href="\${escapeHtml(b.download_url)}" target="_blank" rel="noopener">下载产物 →</a>\` : ''}
      </div>
    </div>\`).join('');
  }
  
  async function bootAfterLogin() {
    try { const { templates } = await api.listTemplates(); store.templates = templates; } catch {}
    render();
  }
  
  function render() {
    if (store.systemStatus === 'uninitialized') { renderSetupInit(); return; }
    if (!store.authed) { renderLogin(); return; }
    if (store.systemStatus === 'wizard') { renderSetupWizard(); return; }
    if (store.pollTimer) { clearInterval(store.pollTimer); store.pollTimer = null; }
    const { name, params } = store.route;
    if (name === 'template-detail') renderTemplateDetailPage(params.id);
    else if (name === 'trigger') renderTriggerPage(params.id);
    else if (name === 'builds') renderBuildsPage();
    else renderTemplatesPage();
  }
  
  async function boot() {
    store.route = parseHash();
    try {
      const { status } = await api.setupStatus();
      store.systemStatus = status;
    } catch {
      store.systemStatus = 'ready';
    }
    if (store.systemStatus === 'uninitialized') { render(); return; }
    // 修复：去掉冗余的双重赋值，任何错误（包括 401）都先展示登录页，避免卡死在白屏
    try {
      await api.listTemplates();
      store.authed = true;
    } catch {
      store.authed = false;
    }
    render();
  }
  
  boot();
  `;
  
  // ============================================================
  // 前端 HTML 页面（CSS / JS 内嵌 APP_CSS / APP_JS 常量）
  // ============================================================
  function renderIndexHtml() {
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenWrt 自动编译</title>
    <style>${APP_CSS}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>${APP_JS}</script>
  </body>
  </html>`;
  }
  
  // ============================================================
  // 主路由分发
  // ============================================================
  async function handleApiRequest(request, env, url) {
    const path = url.pathname;
    const method = request.method;
  
    // 无需鉴权
    if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/api/setup/status' && method === 'GET') return handleSetupStatus(request, env);
    if (path === '/api/setup/init' && method === 'POST') return handleSetupInit(request, env);
  
    // workflow 专用接口（REPORT_TOKEN 鉴权）
    if (path === '/api/report' && method === 'POST') {
      if (!(await requireReportToken(request, env))) return err('unauthorized', 401);
      return handleWorkflowReport(request, env);
    }
    if (path === '/api/report/dotconfig' && method === 'POST') {
      if (!(await requireReportToken(request, env))) return err('unauthorized', 401);
      return handleWorkflowReportDotconfig(request, env);
    }
    {
      const m = path.match(/^\/api\/builds\/([^/]+)\/config$/);
      if (m && method === 'GET') {
        if (!(await requireReportToken(request, env))) return err('unauthorized', 401);
        return handleWorkflowGetConfig(request, env, decodeURIComponent(m[1]));
      }
    }
  
    // 以下接口需要 session 鉴权
    const authed = await requireSession(request, env);
    if (!authed) return err('unauthorized，请先登录', 401);
  
    if (path === '/api/logout' && method === 'POST') return handleLogout(request, env);
    if (path === '/api/setup/wizard' && method === 'POST') return handleSetupWizard(request, env);
    if (path === '/api/settings' && method === 'GET') return handleGetSettings(request, env);
    if (path === '/api/settings/reset' && method === 'POST') return handleSettingsReset(request, env);
    if (path === '/api/settings/report-token/reset' && method === 'POST') return handleResetReportToken(request, env);
    if (path === '/api/templates' && method === 'GET') return handleListTemplates(request, env);
    if (path === '/api/templates' && method === 'POST') return handleCreateTemplate(request, env);
    if (path === '/api/templates/import' && method === 'POST') return handleImportTemplate(request, env);
    {
      const m = path.match(/^\/api\/templates\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'GET') return handleGetTemplate(request, env, id);
        if (method === 'PUT') return handleUpdateTemplate(request, env, id);
        if (method === 'DELETE') return handleDeleteTemplate(request, env, id);
      }
    }
    {
      const m = path.match(/^\/api\/templates\/([^/]+)\/export$/);
      if (m && method === 'GET') return handleExportTemplate(request, env, decodeURIComponent(m[1]), url);
    }
    {
      const m = path.match(/^\/api\/templates\/([^/]+)\/dotconfig\/history$/);
      if (m && method === 'GET') return handleListDotconfigHistory(request, env, decodeURIComponent(m[1]));
    }
    {
      const m = path.match(/^\/api\/templates\/([^/]+)\/dotconfig\/history\/([^/]+)$/);
      if (m) {
        const tplId = decodeURIComponent(m[1]);
        const vid = decodeURIComponent(m[2]);
        if (method === 'GET') return handleGetDotconfigVersion(request, env, tplId, vid);
        if (method === 'PATCH') return handlePatchDotconfigLabel(request, env, tplId, vid);
        if (method === 'DELETE') return handleDeleteDotconfigVersion(request, env, tplId, vid);
      }
    }
    {
      const m = path.match(/^\/api\/templates\/([^/]+)\/dotconfig\/upload$/);
      if (m && method === 'POST') return handleUploadDotconfig(request, env, decodeURIComponent(m[1]));
    }
    {
      const m = path.match(/^\/api\/templates\/([^/]+)\/dotconfig\/current$/);
      if (m && method === 'PUT') return handleSetCurrentDotconfig(request, env, decodeURIComponent(m[1]));
    }
    {
      const m = path.match(/^\/api\/templates\/([^/]+)\/schedule$/);
      if (m && method === 'PUT') return handleSetSchedule(request, env, decodeURIComponent(m[1]));
    }
    if (path === '/api/trigger' && method === 'POST') return handleTrigger(request, env);
    if (path === '/api/builds' && method === 'GET') return handleListBuilds(request, env, url);
    {
      const m = path.match(/^\/api\/builds\/([^/]+)$/);
      if (m && method === 'GET') return handleGetBuild(request, env, decodeURIComponent(m[1]));
    }
  
    return err('not found', 404);
  }
  
  export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        try {
          return await handleApiRequest(request, env, url);
        } catch (e) {
          return err(`服务器内部错误: ${e.message}`, 500);
        }
      }
      // 其他路径都返回前端单页应用（由前端 hash 路由处理具体页面）
      return new Response(renderIndexHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async scheduled(event, env, ctx) {
      ctx.waitUntil(runScheduledBuilds(env, event.cron));
    },
  };
