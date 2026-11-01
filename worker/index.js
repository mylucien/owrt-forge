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
//
// 取消编译功能需要 builds 表新增一列（已有部署执行一次即可，新部署建表时直接加上）：
//   ALTER TABLE builds ADD COLUMN github_run_id TEXT;
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
  // ---------- ccache 缓存：发布到编译仓库的 Release（cache-<build_id>），下次编译可恢复 ----------
  const CACHE_KEEP = 2;                          // 只保留最新 2 份；scripts/cache.sh 里的 KEEP 要和这里一致
  const CACHE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const CACHE_TAG_RE = /^cache-[A-Za-z0-9_-]{8,64}$/;

  // 把「使用缓存」选项解析成要恢复的缓存 Release tag；没有可用缓存返回 null（编译照常进行，只是不用缓存）
  async function resolveCacheFrom(env, target, want) {
    if (!want) return null;
    if (want === 'latest') {
      const r = await env.DB.prepare('SELECT cache_tag FROM builds WHERE cache_tag IS NOT NULL AND target = ? ORDER BY cache_at DESC LIMIT 1').bind(target || '').first();
      return r ? r.cache_tag : null;
    }
    if (!CACHE_ID_RE.test(String(want))) return null;
    const r = await env.DB.prepare('SELECT cache_tag FROM builds WHERE id = ? AND cache_tag IS NOT NULL').bind(String(want)).first();
    return r ? r.cache_tag : null;
  }

  function serializeTemplate(row) {
    if (!row) return null;
    return {
      ...row,
      plugins: safeJsonParse(row.plugins, []),
      schedule_enabled: !!row.schedule_enabled,
      packages: safeJsonParse(row.packages, []),
      selection: safeJsonParse(row.selection, []),
      menuconfig: !!row.menuconfig,
      cache_use: row.cache_use || '',
      cache_publish: !!row.cache_publish,
    };
  }
  
  async function handleListTemplates(request, env) {
    const { results } = await env.DB.prepare(
      `SELECT id, name, repo_url, branch, target, plugins, profile, packages, selection, project_id, menuconfig, pin_dotconfig_version_id, dotconfig_version_id, schedule_cron, schedule_enabled, schedule_dotconfig_version_id, cache_use, cache_publish, created_at, updated_at FROM templates ORDER BY updated_at DESC`
    ).all();
    return json({ templates: results.map(serializeTemplate) });
  }
  
  async function handleGetTemplate(request, env, id) {
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!row) return err('模板不存在', 404);
    return json({ template: serializeTemplate(row) });
  }
  
  // ---------- 第三方插件 / 选择清单校验：这些内容最终会被 git clone 和写进 .config ----------
  const GIT_URL_RE = /^(https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/%+@-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/+-]+)$/;
  const GIT_DIR_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._+\/-]+$/;
  const FEED_LINE_RE = /^src-(git|git-full|link) [A-Za-z0-9_.-]+ https:\/\/\S+$/;
  function sanitizePlugins(list) {
    if (!Array.isArray(list)) return { error: 'plugins 必须是数组' };
    if (list.length > 60) return { error: '第三方插件最多 60 项' };
    const out = [];
    for (const p of list) {
      if (!p || typeof p !== 'object') return { error: 'plugins 里有无效项' };
      const name = String(p.name || '');
      if (!PKG_RE.test(name)) return { error: `插件目录名非法：${name.slice(0, 60)}` };
      if (p.feed) {
        if (!FEED_LINE_RE.test(String(p.feed))) return { error: `feed 行格式非法：${name}` };
        out.push({ name, feed: String(p.feed) });
        continue;
      }
      const git_url = String(p.git_url || '');
      if (git_url.length > 300 || !GIT_URL_RE.test(git_url)) return { error: `插件仓库地址非法（仅支持 https 或 git@ 地址）：${git_url.slice(0, 80)}` };
      const branch = String(p.branch || '');
      if (branch && (!BRANCH_RE.test(branch) || branch.length > 100)) return { error: `插件分支名非法：${name}` };
      const item = { name, git_url };
      if (branch) item.branch = branch;
      if (p.sparse) {
        const dirs = Array.isArray(p.dirs) ? p.dirs.map(String) : [];
        if (!dirs.length || dirs.length > 30 || dirs.some((d) => d.length > 200 || !GIT_DIR_RE.test(d))) return { error: `插件子目录非法：${name}` };
        item.sparse = true;
        item.dirs = dirs;
      } else {
        item.sparse = false;
      }
      out.push(item);
    }
    return { plugins: out };
  }
  function sanitizeIds(list, max) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const x of list) if (typeof x === 'string' && PKG_RE.test(x) && !out.includes(x)) out.push(x);
    return out.slice(0, max);
  }

  async function handleCreateTemplate(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !body.name || !body.repo_url || !body.branch || !body.target) {
      return err('缺少必填字段：name / repo_url / branch / target');
    }
    const sp = sanitizePlugins(body.plugins === undefined ? [] : body.plugins);
    if (sp.error) return err(sp.error);
    const id = uuid();
    const ts = now();
    const profile = (body.profile && PKG_RE.test(body.profile)) ? body.profile : null;
    const projectId = (body.project_id && PROJECT_ID_RE.test(body.project_id)) ? body.project_id : null;

    await env.DB.prepare(
      `INSERT INTO templates (id, name, repo_url, branch, target, plugins, diy_script_1, diy_script_2, dotconfig_version_id, schedule_cron, schedule_enabled, schedule_dotconfig_version_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, String(body.name).trim().slice(0, 80), body.repo_url, body.branch, body.target, JSON.stringify(sp.plugins),
        body.diy_script_1 || '', body.diy_script_2 || '', null, body.schedule_cron || null, 0, null, ts, ts)
      .run();

    await env.DB.prepare('UPDATE templates SET packages=?, profile=?, selection=?, project_id=?, menuconfig=? WHERE id=?')
      .bind(JSON.stringify(sanitizeIds(body.packages, 800)), profile, JSON.stringify(sanitizeIds(body.selection, 400)), projectId, body.menuconfig ? 1 : 0, id).run();
    const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    return json({ template: serializeTemplate(row) }, 201);
  }

  async function handleUpdateTemplate(request, env, id) {
    const existing = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!existing) return err('模板不存在', 404);

    const body = await request.json().catch(() => null);
    if (!body) return err('请求体格式错误');

    const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : existing.name;
    if (!name) return err('模板名称不能为空');
    const repo_url = body.repo_url ?? existing.repo_url;
    const branch = body.branch ?? existing.branch;
    const target = body.target ?? existing.target;
    let plugins = existing.plugins;
    if (body.plugins !== undefined) {
      const sp = sanitizePlugins(body.plugins);
      if (sp.error) return err(sp.error);
      plugins = JSON.stringify(sp.plugins);
    }
    const diy_script_1 = body.diy_script_1 !== undefined ? body.diy_script_1 : existing.diy_script_1;
    const diy_script_2 = body.diy_script_2 !== undefined ? body.diy_script_2 : existing.diy_script_2;
    const packages = body.packages !== undefined ? JSON.stringify(sanitizeIds(body.packages, 800)) : (existing.packages || '[]');
    const selection = body.selection !== undefined ? JSON.stringify(sanitizeIds(body.selection, 400)) : (existing.selection || '[]');
    const profile = body.profile !== undefined ? ((body.profile && PKG_RE.test(body.profile)) ? body.profile : null) : (existing.profile || null);
    const projectId = body.project_id !== undefined ? ((body.project_id && PROJECT_ID_RE.test(body.project_id)) ? body.project_id : null) : (existing.project_id || null);
    const menuconfig = body.menuconfig !== undefined ? (body.menuconfig ? 1 : 0) : (existing.menuconfig ? 1 : 0);

    let cacheUse = existing.cache_use || '';
    if (body.cache_use !== undefined) {
      const v = String(body.cache_use || '');
      if (v && v !== 'latest' && !CACHE_ID_RE.test(v)) return err('缓存选项格式错误');
      cacheUse = v;
    }
    const cachePublish = body.cache_publish !== undefined ? (body.cache_publish ? 1 : 0) : (existing.cache_publish ? 1 : 0);

    // 配置底稿：null = 不固定（每次按清单重新生成）；填版本 id = 固定为该版本。手动编译和定时编译共用这一个设置
    let pin = existing.pin_dotconfig_version_id || null;
    let schedVersion = existing.schedule_dotconfig_version_id || null;
    if (body.pin_dotconfig_version_id !== undefined) {
      if (body.pin_dotconfig_version_id) {
        const v = await env.DB.prepare('SELECT id FROM dotconfig_history WHERE id = ? AND template_id = ?').bind(body.pin_dotconfig_version_id, id).first();
        if (!v) return err('指定的 .config 版本不存在', 404);
        pin = v.id;
      } else {
        pin = null;
      }
      schedVersion = pin;
    }

    await env.DB.prepare(
      `UPDATE templates SET name=?, repo_url=?, branch=?, target=?, plugins=?, diy_script_1=?, diy_script_2=?, packages=?, selection=?, profile=?, project_id=?, menuconfig=?, pin_dotconfig_version_id=?, schedule_dotconfig_version_id=?, cache_use=?, cache_publish=?, updated_at=? WHERE id=?`
    )
      .bind(name, repo_url, branch, target, plugins, diy_script_1, diy_script_2, packages, selection, profile, projectId, menuconfig, pin, schedVersion, cacheUse || null, cachePublish, now(), id)
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
      AND id != COALESCE((SELECT dotconfig_version_id FROM templates WHERE id = ?), '')
      AND id != COALESCE((SELECT pin_dotconfig_version_id FROM templates WHERE id = ?), '')`
    )
      .bind(templateId, templateId, MAX_HISTORY_PER_TEMPLATE, templateId, templateId, templateId)
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
    if (tpl.schedule_dotconfig_version_id === versionId || tpl.pin_dotconfig_version_id === versionId) {
      return err('该版本已固定为配置底稿，请先取消固定再删除', 409);
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
    if (enabled && !versionId && !tpl.pin_dotconfig_version_id) {
      const hasList = safeJsonParse(tpl.packages, []).length > 0 || !!tpl.profile;
      if (!hasList) return err('这个模板还没有插件清单或机型，也没有固定的 .config，无法定时编译');
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
        packages: safeJsonParse(tpl.packages, []),
        profile: tpl.profile || '',
        selection: safeJsonParse(tpl.selection, []),
        project_id: tpl.project_id || '',
        menuconfig: !!tpl.menuconfig,
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
    const sp = sanitizePlugins(Array.isArray(t.plugins) ? t.plugins : []);
    if (sp.error) return err(sp.error);
    const plugins = JSON.stringify(sp.plugins);
  
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
  
    await env.DB.prepare('UPDATE templates SET packages=?, profile=?, selection=?, project_id=?, menuconfig=? WHERE id=?')
      .bind(JSON.stringify(sanitizeIds(t.packages, 800)), (t.profile && PKG_RE.test(t.profile)) ? t.profile : null,
        JSON.stringify(sanitizeIds(t.selection, 400)), (t.project_id && PROJECT_ID_RE.test(t.project_id)) ? t.project_id : null, t.menuconfig ? 1 : 0, templateId).run();

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
  const STATUS_LABELS_BACKEND = { pending: '排队中', running: '准备中', menuconfig: '配置中', compiling: '编译中', success: '成功', failed: '失败', cancelled: '已取消' };
  
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
  
    // 配置底稿：请求里明确给了就用请求的（空字符串 = 不固定）；否则只用模板上「固定」的版本。
    // 不再自动沿用「当前版本」，否则旧选择里已经去掉的插件会残留。
    const fromBody = body.dotconfig_version_id !== undefined;
    let dotconfigVersionId = fromBody ? (body.dotconfig_version_id || null) : (tpl.pin_dotconfig_version_id || null);
    let dotconfigSnapshot = null;
    if (dotconfigVersionId) {
      const version = await env.DB.prepare(
        'SELECT * FROM dotconfig_history WHERE id = ? AND template_id = ?'
      )
        .bind(dotconfigVersionId, body.template_id)
        .first();
      if (!version) return err(fromBody ? '指定的 .config 底稿版本不存在' : '模板固定的 .config 版本已不存在，请在模板页重新选择', fromBody ? 404 : 409);
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
  
    const packages = (Array.isArray(body.packages) ? body.packages : safeJsonParse(tpl.packages, [])).filter((p) => typeof p === 'string' && PKG_RE.test(p));
    const profile = body.profile || tpl.profile || null;
    const askMenuconfig = body.menuconfig !== undefined ? !!body.menuconfig : !!tpl.menuconfig;
    // 没有清单、没有机型、也没有固定底稿的旧模板，只能靠 menuconfig 选设备
    const wantMenuconfig = askMenuconfig ? 1 : ((packages.length || profile || dotconfigSnapshot) ? 0 : 1);
    if (profile && !PKG_RE.test(profile)) {
      await env.DB.prepare("UPDATE builds SET status='failed', fail_reason=?, updated_at=? WHERE id=?").bind('机型 profile 格式非法', now(), buildId).run();
      return err('机型 profile 格式非法', 400);
    }
    const cacheFrom = await resolveCacheFrom(env, tpl.target, body.cache_use !== undefined ? body.cache_use : tpl.cache_use);
    const cachePublish = body.cache_publish !== undefined ? !!body.cache_publish : !!tpl.cache_publish;
    await env.DB.prepare('UPDATE builds SET packages=?, profile=?, menuconfig=?, cache_from=?, cache_publish=?, use_ccache=? WHERE id=?')
      .bind(JSON.stringify(packages), profile, wantMenuconfig, cacheFrom, cachePublish ? 1 : 0, (cacheFrom || cachePublish) ? 1 : 0, buildId).run();

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
    // 终端地址含密码：只在 menuconfig 阶段下发，结束后不再返回
    const { results } = await env.DB.prepare(
      `SELECT id, template_id, repo_url, branch, target, profile, dotconfig_version_id, trigger_type, schedule_cron, status,
              CASE WHEN status='menuconfig' THEN web_url END AS web_url,
              download_url, fail_reason, log_tail, created_at, updated_at,
              use_ccache, cache_publish, cache_from, cache_tag, cache_size,
              (dotconfig_snapshot IS NOT NULL AND dotconfig_snapshot != '') AS has_snapshot,
              (dotconfig_result IS NOT NULL AND dotconfig_result != '') AS has_result
       FROM builds ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    return json({ builds: results });
  }

  async function handleGetBuild(request, env, id) {
    const row = await env.DB.prepare('SELECT * FROM builds WHERE id = ?').bind(id).first();
    if (!row) return err('编译记录不存在', 404);
    return json({ build: serializeBuild(row) });
  }
  
  // 需登录：手动取消一个进行中的编译任务
  async function handleCancelBuild(request, env, id) {
    const row = await env.DB.prepare('SELECT * FROM builds WHERE id = ?').bind(id).first();
    if (!row) return err('编译记录不存在', 404);
  
    if (![...ACTIVE_STATUSES, 'queued'].includes(row.status)) {
      return err(`当前状态为「${STATUS_LABELS_BACKEND[row.status] || row.status}」，无需取消`, 409);
    }
  
    // 先尝试真正取消 GitHub Actions 那边的 workflow run，再无论成败都把 D1 状态标记为 cancelled，
    // 保证用户至少能解开"同时只能跑一个任务"的并发锁，不会因为 GitHub 那边调用失败就卡死在原状态。
    let githubCancelError = null;
    if (row.github_run_id) {
      try {
        await cancelGithubWorkflowRun(env, row.github_run_id);
      } catch (e) {
        githubCancelError = e.message;
      }
    } else {
      githubCancelError = 'workflow 尚未上报 run_id（可能还在排队阶段），仅在本系统中标记为已取消，GitHub Actions 那边的任务请手动去仓库的 Actions 页面取消';
    }
  
    await env.DB.prepare('UPDATE builds SET status=?, web_url=NULL, updated_at=? WHERE id=?')
      .bind('cancelled', now(), id)
      .run();
  
    await dispatchNextQueued(env).catch(() => {});
    return json({ ok: true, github_cancel_warning: githubCancelError || undefined });
  }
  
  async function cancelGithubWorkflowRun(env, runId) {
    const githubRepo = await getConfig(env, 'github_repo');
    const githubToken = await getConfig(env, 'github_token');
    if (!githubRepo || !githubToken) {
      throw new Error('GitHub 配置未完成');
    }
    const resp = await fetch(`https://api.github.com/repos/${githubRepo}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openwrt-auto-build-worker',
      },
    });
    // 202 = 已接受取消请求；404/409 通常是 run 已经结束或已经在取消中，不视为失败
    if (!resp.ok && resp.status !== 404 && resp.status !== 409) {
      const text = await resp.text().catch(() => '');
      throw new Error(`GitHub 取消请求失败: ${resp.status} ${text}`);
    }
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
      packages: safeJsonParse(row.packages, []),
      profile: row.profile || '',
      menuconfig: row.menuconfig !== 0,
      use_ccache: row.use_ccache === 1,
      cache_from: (row.cache_from && CACHE_TAG_RE.test(row.cache_from)) ? row.cache_from : '',
      cache_publish: row.cache_publish === 1,
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
    if (!body || !body.build_id || !body.status) return err('缺少 build_id 或 status');
    if (!WORKFLOW_REPORTABLE_STATUSES.includes(body.status)) return err(`未知 status: ${body.status}`);

    const row = await env.DB.prepare('SELECT status FROM builds WHERE id = ?').bind(body.build_id).first();
    if (!row) return err('build 不存在', 404);
    const TERMINAL = ['success', 'failed', 'cancelled'];
    // 状态机：终态不可被覆盖（修复：用户取消后被 always() 步骤改写成 failed）
    if (TERMINAL.includes(row.status)) return json({ ok: true, ignored: true });

    const fields = ['status=?'];
    const values = [body.status];
    if (body.web_url !== undefined) { fields.push('web_url=?'); values.push(body.web_url); }
    else if (TERMINAL.includes(body.status)) fields.push('web_url=NULL');
    if (body.download_url !== undefined) { fields.push('download_url=?'); values.push(body.download_url); }
    if (body.github_run_id !== undefined) { fields.push('github_run_id=?'); values.push(String(body.github_run_id)); }
    if (body.reason) { fields.push('fail_reason=?'); values.push(String(body.reason).slice(0, 500)); }
    if (body.log_tail) { fields.push('log_tail=?'); values.push(String(body.log_tail).slice(0, 8000)); }
    fields.push('updated_at=?');
    values.push(now());
    values.push(body.build_id);

    await env.DB.prepare(`UPDATE builds SET ${fields.join(', ')} WHERE id=?`).bind(...values).run();
    if (TERMINAL.includes(body.status)) await dispatchNextQueued(env).catch(() => {});
    return json({ ok: true });
  }

  // workflow 专用：上报已发布的 ccache 缓存
  async function handleWorkflowReportCache(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !CACHE_ID_RE.test(String(body.build_id || ''))) return err('缺少 build_id');
    const tag = String(body.tag || '');
    if (!CACHE_TAG_RE.test(tag)) return err('tag 格式错误');
    const size = Math.max(0, Math.floor(Number(body.size) || 0));
    const row = await env.DB.prepare('SELECT id FROM builds WHERE id = ?').bind(body.build_id).first();
    if (!row) return err('build 不存在', 404);
    await env.DB.prepare('UPDATE builds SET cache_tag=?, cache_size=?, cache_at=? WHERE id=?').bind(tag, size, now(), body.build_id).run();
    // 只保留最新 CACHE_KEEP 份记录（编译仓库里对应的 Release 由 scripts/cache.sh 同步清理）
    await env.DB.prepare('UPDATE builds SET cache_tag=NULL, cache_size=NULL WHERE cache_tag IS NOT NULL AND id NOT IN (SELECT id FROM builds WHERE cache_tag IS NOT NULL ORDER BY cache_at DESC LIMIT ?)').bind(CACHE_KEEP).run();
    return json({ ok: true });
  }

  async function handleListCaches(request, env) {
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.template_id, b.target, b.profile, b.cache_tag, b.cache_size, b.cache_at, t.name AS template_name
       FROM builds b LEFT JOIN templates t ON t.id = b.template_id
       WHERE b.cache_tag IS NOT NULL ORDER BY b.cache_at DESC LIMIT 10`
    ).all();
    return json({ caches: results });
  }

  // 编译途中切换「完成后发布缓存」。缓存只存在于编译机上，编译结束后就没有了，所以只能在编译结束前设置
  async function handleSetBuildCachePublish(request, env, id) {
    const body = await request.json().catch(() => null);
    if (!body) return err('请求体格式错误');
    const row = await env.DB.prepare('SELECT status, use_ccache FROM builds WHERE id = ?').bind(id).first();
    if (!row) return err('编译记录不存在', 404);
    if (['success', 'failed', 'cancelled'].includes(row.status)) return err('这次编译已经结束，缓存随编译机一起销毁了，无法再发布。想要缓存请在下次编译前勾选「编译完成后发布缓存」', 409);
    if (!row.use_ccache) return err('这次编译没有启用 ccache，没有缓存可发布。请在模板的编译选项里选择使用缓存或勾选发布缓存后重新编译', 409);
    await env.DB.prepare('UPDATE builds SET cache_publish=?, updated_at=? WHERE id=?').bind(body.enabled ? 1 : 0, now(), id).run();
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
      `SELECT t.*, h.id AS pinned_vid, h.content AS dotconfig_content FROM templates t LEFT JOIN dotconfig_history h ON h.id = COALESCE(t.pin_dotconfig_version_id, t.schedule_dotconfig_version_id) WHERE t.schedule_enabled = 1 AND t.schedule_cron = ?`
    )
      .bind(cronString)
      .all();
  
    for (const template of results) {
      // 没有固定底稿时按「机型 + 插件清单」每次重新生成；两样都没有就没东西可编译
      const hasList = safeJsonParse(template.packages, []).length > 0 || !!template.profile;
      if (!template.dotconfig_content && !hasList) { console.log(`模板 ${template.name} 没有插件清单也没有固定配置，已跳过定时编译`); continue; }
      const busy = await hasActiveBuild(env);
  
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
          template.dotconfig_content ? template.pinned_vid : null,
          template.dotconfig_content || null,
          cronString,
          ts,
          ts
        )
        .run();
  
      const cacheFrom = await resolveCacheFrom(env, template.target, template.cache_use);
      const cachePublish = !!template.cache_publish;
      await env.DB.prepare('UPDATE builds SET packages=?, profile=?, menuconfig=0, cache_from=?, cache_publish=?, use_ccache=? WHERE id=?').bind(template.packages || '[]', template.profile || null, cacheFrom, cachePublish ? 1 : 0, (cacheFrom || cachePublish) ? 1 : 0, buildId).run();
      if (busy) { await env.DB.prepare("UPDATE builds SET status='queued' WHERE id=?").bind(buildId).run(); continue; }

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
  

  // ============================================================
  // 插件目录（商店数据）与自动建表迁移
  // ============================================================
  // 内置回退目录：由 tools/build_worker.py 从根目录 catalog.json 写入，Worker 平时优先在线读取仓库里的 catalog.json
  const STORE_FALLBACK = /*CATALOG:BEGIN*/{"schema":1,"updated":"2026-10-19","upstream":{"repo":"https://github.com/immortalwrt/luci","branch":"openwrt-24.10","commit":"80ed8a44f244627c5a9f808d09f4c3d8f985b764"},"categories":[{"id":"代理","order":1,"keywords":"科学 上网 翻墙 梯子 分流 订阅 节点"},{"id":"DNS 与广告","order":2,"keywords":"去广告 屏蔽 广告 解析 防污染"},{"id":"网络","order":3,"keywords":"路由 拨号 负载 限速 唤醒 校园网"},{"id":"VPN 与穿透","order":4,"keywords":"内网穿透 远程 异地组网 回家 vpn"},{"id":"服务","order":5,"keywords":""},{"id":"存储","order":6,"keywords":"网盘 共享 文件 硬盘 nas ftp"},{"id":"下载","order":7,"keywords":"下载 磁力 bt 种子"},{"id":"容器","order":8,"keywords":"虚拟化 docker 容器"},{"id":"监控","order":9,"keywords":"监控 流量 统计 状态 温度"},{"id":"多媒体","order":10,"keywords":"音乐 影音 投屏"},{"id":"系统","order":11,"keywords":"重启 终端 权限 定时 屏幕"},{"id":"协议","order":12,"keywords":"接口 协议 拨号 隧道"},{"id":"主题","order":13,"keywords":"主题 界面 皮肤 外观"},{"id":"其它","order":14,"keywords":""}],"sources":[{"id":"immortalwrt-24.10","name":"ImmortalWrt","repo_url":"https://github.com/immortalwrt/immortalwrt","branch":"openwrt-24.10"},{"id":"immortalwrt-23.05","name":"ImmortalWrt","repo_url":"https://github.com/immortalwrt/immortalwrt","branch":"openwrt-23.05"},{"id":"immortalwrt-master","name":"ImmortalWrt","repo_url":"https://github.com/immortalwrt/immortalwrt","branch":"master"},{"id":"openwrt-24.10","name":"OpenWrt 官方","repo_url":"https://github.com/openwrt/openwrt","branch":"openwrt-24.10"},{"id":"lede-master","name":"LEDE","repo_url":"https://github.com/coolsnowwolf/lede","branch":"master"}],"plugins":[{"id":"luci-app-homeproxy","name":"HomeProxy","desc":"基于 sing-box 的轻量代理，界面简洁。","desc_en":"The modern ImmortalWrt proxy platform for ARM64/AMD64","cat":"代理","kind":"app","origin":{"type":"builtin"},"deps":["sing-box","firewall4","kmod-nft-tproxy","ucode-mod-digest"],"requires":[],"size_mb":3.5,"rec":false,"tut":"在「服务 → HomeProxy」导入节点即可。","tags":[],"hidden":false},{"id":"luci-app-openclash","name":"openclash","desc":"兼容 Clash 配置的代理客户端，内核体积较大。","desc_en":"","cat":"代理","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":9,"rec":false,"tut":"上传配置文件或订阅地址，并下载内核。","tags":[],"hidden":false},{"id":"luci-app-passwall","name":"passwall","desc":"多节点、分流规则完整的代理工具。","desc_en":"LuCI support for PassWall","cat":"代理","kind":"app","origin":{"type":"builtin"},"deps":["coreutils","coreutils-base64","coreutils-nohup","curl","chinadns-ng","dns2socks","ip-full","libuci-lua","lua","luci-lib-jsonc","microsocks","resolveip","tcping","unzip","ipt2socks","kmod-nft-socket","kmod-nft-tproxy","kmod-nft-nat","PACKAGE_$(PKG_NAME)_INCLUDE_Brook:brook","PACKAGE_$(PKG_NAME)_INCLUDE_Haproxy:haproxy","PACKAGE_$(PKG_NAME)_INCLUDE_Hysteria:hysteria","PACKAGE_$(PKG_NAME)_INCLUDE_NaiveProxy:naiveproxy","PACKAGE_$(PKG_NAME)_INCLUDE_Shadowsocks_Rust_Client:shadowsocks-rust-sslocal","PACKAGE_$(PKG_NAME)_INCLUDE_Shadowsocks_Rust_Server:shadowsocks-rust-ssserver","PACKAGE_$(PKG_NAME)_INCLUDE_Shadow_TLS:shadow-tls","PACKAGE_$(PKG_NAME)_INCLUDE_Simple_Obfs:simple-obfs-client","PACKAGE_$(PKG_NAME)_INCLUDE_SingBox:sing-box","PACKAGE_$(PKG_NAME)_INCLUDE_tuic_client:tuic-client","PACKAGE_$(PKG_NAME)_INCLUDE_V2ray_Geodata:v2ray-geoip","PACKAGE_$(PKG_NAME)_INCLUDE_V2ray_Geodata:v2ray-geosite","PACKAGE_$(PKG_NAME)_INCLUDE_V2ray_Geoview:geoview","PACKAGE_$(PKG_NAME)_INCLUDE_V2ray_Plugin:v2ray-plugin","PACKAGE_$(PKG_NAME)_INCLUDE_Xray:xray-core","PACKAGE_$(PKG_NAME)_INCLUDE_Xray_Plugin:xray-plugin"],"requires":[],"size_mb":1.8,"rec":false,"tut":"装好后先添加订阅，再选择分流模式。","tags":[],"hidden":false},{"id":"luci-app-privoxy","name":"privoxy","desc":"LuCI Support for Privoxy WEB proxy","desc_en":"LuCI Support for Privoxy WEB proxy","cat":"代理","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-ipkg","privoxy"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-v2raya","name":"v2rayA","desc":"LuCI support for v2rayA","desc_en":"LuCI support for v2rayA","cat":"代理","kind":"app","origin":{"type":"builtin"},"deps":["v2raya"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-adblock","name":"Adblock","desc":"LuCI support for Adblock","desc_en":"LuCI support for Adblock","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["adblock"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-adblock-fast","name":"AdBlock Fast","desc":"AdBlock-Fast Web UI","desc_en":"AdBlock-Fast Web UI","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["adblock-fast","rpcd-mod-ucode"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-arpbind","name":"IP/MAC绑定","desc":"LuCI support for ARP binding","desc_en":"LuCI support for ARP binding","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["ip"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-banip","name":"banIP","desc":"LuCI support for banIP","desc_en":"LuCI support for banIP","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["banip"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ddns","name":"动态 DNS","desc":"LuCI Support for Dynamic DNS Client (ddns-scripts)","desc_en":"LuCI Support for Dynamic DNS Client (ddns-scripts)","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["ddns-scripts"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ddns-go","name":"DDNS-Go","desc":"自动把公网 IP 解析到你的域名。","desc_en":"LuCI support for DDNS-Go","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["ddns-go"],"requires":[],"size_mb":3,"rec":false,"tut":"打开 9876 端口，填写服务商密钥。","tags":[],"hidden":false},{"id":"luci-app-https-dns-proxy","name":"HTTPS DNS 代理","desc":"DNS Over HTTPS Proxy Web UI","desc_en":"DNS Over HTTPS Proxy Web UI","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["https-dns-proxy"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-smartdns","name":"SmartDNS","desc":"多上游并发解析，选最快的结果。","desc_en":"LuCI for smartdns","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["smartdns"],"requires":[],"size_mb":1.2,"rec":false,"tut":"勾选「重定向 53 端口」即可生效。","tags":[],"hidden":false},{"id":"luci-app-unbound","name":"unbound","desc":"Unbound Recursive DNS Resolver Configuration","desc_en":"Unbound Recursive DNS Resolver Configuration","cat":"DNS 与广告","kind":"app","origin":{"type":"builtin"},"deps":["unbound-daemon"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-3ginfo-lite","name":"模块","desc":"LuCI JS Support for 3ginfo-lite","desc_en":"LuCI JS Support for 3ginfo-lite","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["sms-tool","comgt","kmod-usb-serial-option"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-appfilter","name":"appfilter","desc":"LuCI support for OAF","desc_en":"LuCI support for OAF","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["appfilter"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-bcp38","name":"BCP38","desc":"BCP38 LuCI interface","desc_en":"BCP38 LuCI interface","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["bcp38"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-bmx7","name":"bmx7","desc":"LuCI support for BMX7","desc_en":"LuCI support for BMX7","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-json","bmx7","bmx7-json"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-cd8021x","name":"Content-Type: text/plain; charset=UTF-8\\n","desc":"a wired IEEE 802.1x client for Luci","desc_en":"a wired IEEE 802.1x client for Luci","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["wpad"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dawn","name":"DAWN","desc":"LuCI support for DAWN","desc_en":"LuCI support for DAWN","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["dawn"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dcwapd","name":"双通道 WiFi","desc":"Dual Channel Wi-Fi AP Daemon configuration module","desc_en":"Dual Channel Wi-Fi AP Daemon configuration module","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["dcwapd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-eoip","name":"EoIP 隧道","desc":"LuCI Support for EoIP","desc_en":"LuCI Support for EoIP","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["eoip"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-eqos","name":"网速控制","desc":"LuCI support for Easy QoS","desc_en":"LuCI support for Easy QoS","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["tc","kmod-sched-core","kmod-ifb"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-haproxy-tcp","name":"haproxy-tcp","desc":"luci for haproxy and shadowsocks","desc_en":"luci for haproxy and shadowsocks","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["haproxy"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-lorawan-basicstation","name":"LoRaWAN Basicstation","desc":"LuCI Support for LoRaWAN basicstation","desc_en":"LuCI Support for LoRaWAN basicstation","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["basicstation"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-modemband","name":"Modem","desc":"LuCI JS Support for modemband application","desc_en":"LuCI JS Support for modemband application","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["modemband"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-mwan3","name":"MultiWAN 管理器","desc":"多条宽带叠加或互为备份。","desc_en":"LuCI support for the MWAN3 MultiWAN Manager","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["mwan3"],"requires":[],"size_mb":0.2,"rec":false,"tut":"先添加接口，再设置成员和策略。","tags":[],"hidden":false},{"id":"luci-app-nft-qos","name":"nft-qos","desc":"QoS over Nftables","desc_en":"QoS over Nftables","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["nft-qos"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-njitclient","name":"njitclient","desc":"NJIT 802.1X Client for LuCI","desc_en":"NJIT 802.1X Client for LuCI","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["njit8021xclient"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-olsr","name":"OLSR IPv4","desc":"OLSR configuration and status module","desc_en":"OLSR configuration and status module","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["olsrd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-olsr-services","name":"olsr-services","desc":"Show services announced with the nameservice plugin","desc_en":"Show services announced with the nameservice plugin","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["luci-app-olsr","olsrd","olsrd-mod-nameservice"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-olsr-viz","name":"olsr-viz","desc":"OLSR Visualisation","desc_en":"OLSR Visualisation","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["luci-app-olsr","olsrd","olsrd-mod-txtinfo"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-pppoe-relay","name":"pppoe-relay","desc":"LuCI support for PPPoE Relay","desc_en":"LuCI support for PPPoE Relay","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["rp-pppoe-common","rp-pppoe-relay"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-pppoe-server","name":"pppoe-server","desc":"LuCI support for PPPoE Server","desc_en":"LuCI support for PPPoE Server","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["rp-pppoe-common","rp-pppoe-server"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-qos","name":"QoS","desc":"Quality of Service configuration module","desc_en":"Quality of Service configuration module","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["qos-scripts"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-rp-pppoe-server","name":"RP PPPoE 服务器","desc":"Roaring Penguin PPPoE Server","desc_en":"Roaring Penguin PPPoE Server","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["rp-pppoe-server"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-scutclient","name":"scutclient","desc":"LuCI Support for scutclient","desc_en":"LuCI Support for scutclient","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["scutclient"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-siitwizard","name":"SIIT 4over6 assistant","desc":"SIIT IPv4-over-IPv6 configuration wizard","desc_en":"SIIT IPv4-over-IPv6 configuration wizard","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["kmod-siit"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-sms-tool-js","name":"sms-tool-js","desc":"LuCI JS Support for sms-tool","desc_en":"LuCI JS Support for sms-tool","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["sms-tool","kmod-usb-serial","kmod-usb-serial-option","comgt"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-socat","name":"Socat 端口转发","desc":"功能较全的 TCP/UDP 转发工具（作者自维护仓库）。","desc_en":"","cat":"网络","kind":"app","origin":{"type":"git","name":"luci-app-socat","url":"https://github.com/mylucien/luci-app-socat","branch":"","sparse":false,"dirs":[]},"deps":["socat"],"requires":[],"size_mb":0.1,"rec":false,"tut":"在「网络 → Socat」添加规则。","tags":[],"hidden":false},{"id":"luci-app-sqm","name":"SQM 队列管理","desc":"LuCI Support for SQM Scripts","desc_en":"LuCI Support for SQM Scripts","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["sqm-scripts"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-syncdial","name":"syncdial","desc":"Virtual WAN config generator","desc_en":"Virtual WAN config generator","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["kmod-macvlan","luci-app-mwan3"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-timewol","name":"timewol","desc":"LuCI support for Timewol","desc_en":"LuCI support for Timewol","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ua2f","name":"UA2F","desc":"LuCI support for ua2f","desc_en":"LuCI support for ua2f","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["ua2f"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-usteer","name":"Usteer","desc":"LuCI usteer app for js based luci","desc_en":"LuCI usteer app for js based luci","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["usteer"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-vlmcsd","name":"Vlmcsd KMS 服务器","desc":"LuCI support for Vlmcsd KMS Server","desc_en":"LuCI support for Vlmcsd KMS Server","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["vlmcsd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-wifischedule","name":"wifi定时","desc":"Turns WiFi on and off according to a schedule","desc_en":"Turns WiFi on and off according to a schedule","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["wifischedule"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-wol","name":"网络唤醒","desc":"LuCI Support for Wake-on-LAN","desc_en":"LuCI Support for Wake-on-LAN","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["etherwake"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-xlnetacc","name":"xlnetacc","desc":"LuCI Support for XLNetAcc","desc_en":"LuCI Support for XLNetAcc","cat":"网络","kind":"app","origin":{"type":"builtin"},"deps":["jshn","wget-ssl","openssl-util"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-cloudflared","name":"Cloudflare 零信任隧道","desc":"LuCI for Cloudflared","desc_en":"LuCI for Cloudflared","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["cloudflared"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-frpc","name":"frp 客户端","desc":"LuCI Support for frp client","desc_en":"LuCI Support for frp client","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["frpc"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-frps","name":"frp 服务器","desc":"LuCI Support for frp server","desc_en":"LuCI Support for frp server","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["frps"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ipsec-vpnd","name":"IPSec VPN 服务器","desc":"LuCI support for IPSec VPN Server (IKEv1 with PSK and Xauth)","desc_en":"LuCI support for IPSec VPN Server (IKEv1 with PSK and Xauth)","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["strongswan","strongswan-minimal","strongswan-mod-xauth-generic","strongswan-mod-kernel-libipsec","kmod-tun"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-libreswan","name":"Libreswan IPSec","desc":"Luci Application for IPSec VPN (Libreswan)","desc_en":"Luci Application for IPSec VPN (Libreswan)","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["libreswan"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-n2n","name":"n2n","desc":"n2n VPN Configuration module","desc_en":"n2n VPN Configuration module","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["n2n"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ngrokc","name":"Content-Type: text/plain; charset=UTF-8\\n","desc":"LuCI support for ngrokc.","desc_en":"LuCI support for ngrokc.","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["ngrokc"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-nps","name":"nps","desc":"LuCI for Nps","desc_en":"LuCI for Nps","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["wget-ssl","npc"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ocserv","name":"ocserv","desc":"LuCI Support for OpenConnect VPN","desc_en":"LuCI Support for OpenConnect VPN","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["ocserv","certtool"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-openvpn","name":"openvpn","desc":"LuCI Support for OpenVPN","desc_en":"LuCI Support for OpenVPN","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-openvpn-server","name":"openvpn-server","desc":"LuCI support for OpenVPN Server","desc_en":"LuCI support for OpenVPN Server","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["openvpn-openssl","openvpn-easy-rsa","kmod-tun"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-softethervpn","name":"softethervpn","desc":"LuCI support for SoftEtherVPN","desc_en":"LuCI support for SoftEtherVPN","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["zlib","libpthread","librt","libreadline","libncurses","libiconv-full","kmod-tun","libopenssl","softethervpn5-bridge","softethervpn5-client","softethervpn5-server"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-strongswan-swanctl","name":"strongSwan IPsec","desc":"LuCI support for strongSwan via swanctl","desc_en":"LuCI support for strongSwan via swanctl","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["strongswan-swanctl","swanmon"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-xfrpc","name":"反向代理","desc":"LuCI Support for xfrpc","desc_en":"LuCI Support for xfrpc","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["xfrpc"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-zerotier","name":"ZeroTier","desc":"LuCI for Zerotier","desc_en":"LuCI for Zerotier","cat":"VPN 与穿透","kind":"app","origin":{"type":"builtin"},"deps":["zerotier"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-3cat","name":"3cat","desc":"LuCI support for simple port forwarding via 3proxy","desc_en":"LuCI support for simple port forwarding via 3proxy","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["3proxy-mod-tcppm","3proxy-mod-udppm"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-acme","name":"ACME 证书","desc":"ACME package - LuCI interface","desc_en":"ACME package - LuCI interface","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["acme"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-antiblock","name":"AntiBlock","desc":"AntiBlock Web UI","desc_en":"AntiBlock Web UI","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["antiblock"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-apinger","name":"Apinger","desc":"LuCI support for the Apinger","desc_en":"LuCI support for the Apinger","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["apinger","apinger-rrd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-bitsrunlogin-go","name":"深澜登录器","desc":"LuCI app for BitSrunLoginGo (Bit Srun auto login tool)","desc_en":"LuCI app for BitSrunLoginGo (Bit Srun auto login tool)","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["bitsrunlogin-go"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-chrony","name":"Chrony","desc":"LuCI support for chrony","desc_en":"LuCI support for chrony","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["chrony-nts"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-clamav","name":"ClamAV","desc":"ClamAV LuCI interface","desc_en":"ClamAV LuCI interface","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["clamav"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-coovachilli","name":"CoovaChilli 网页认证","desc":"LuCI Support for Coova Chilli","desc_en":"LuCI Support for Coova Chilli","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["coova-chilli"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dae","name":"dae","desc":"LuCI app for dae","desc_en":"LuCI app for dae","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["dae","dae-geoip","dae-geosite"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-daed","name":"daed","desc":"LuCI app for dae dashboard","desc_en":"LuCI app for dae dashboard","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["daed","daed-geoip","daed-geosite"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dufs","name":"Dufs","desc":"LuCI support for dufs","desc_en":"LuCI support for dufs","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["dufs"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dump1090","name":"dump1090","desc":"LuCI Support for dump1090","desc_en":"LuCI Support for dump1090","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["dump1090"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dynapoint","name":"动态点","desc":"LuCI Support for DynaPoint","desc_en":"LuCI Support for DynaPoint","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-ipkg","dynapoint"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-email","name":"电子邮件服务器","desc":"LuCI app for email server configuration (EmailRelay)","desc_en":"LuCI app for email server configuration (EmailRelay)","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["emailrelay"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-filebrowser-go","name":"FileBrowser","desc":"LuCI app for FileBrowser","desc_en":"LuCI app for FileBrowser","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["filebrowser"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-fwknopd","name":"Firewall Knock 守护进程","desc":"Fwknopd config - web config for the firewall knock daemon","desc_en":"Fwknopd config - web config for the firewall knock daemon","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["fwknopd","qrencode"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-gost","name":"GOST","desc":"LuCI support for GOST","desc_en":"LuCI support for GOST","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["gost"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-irqbalance","name":"irqbalance","desc":"LuCI support for irqbalance","desc_en":"LuCI support for irqbalance","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["irqbalance"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-keepalived","name":"VRRP","desc":"LuCI support for the Keepalived","desc_en":"LuCI support for the Keepalived","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["keepalived","keepalived-sync"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-lldpd","name":"LLDP","desc":"LuCI support for LLDP daemon","desc_en":"LuCI support for LLDP daemon","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["lldpd","rpcd-mod-ucode"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-microsocks","name":"MicroSocks","desc":"LuCI support for MicroSocks","desc_en":"LuCI support for MicroSocks","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["microsocks"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-mosquitto","name":"Mosquitto","desc":"Mosquitto LuCI interface","desc_en":"Mosquitto LuCI interface","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["mosquitto"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-msd_lite","name":"组播转换","desc":"LuCI support for Multi stream daemon lite","desc_en":"LuCI support for Multi stream daemon lite","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["msd_lite"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-natmap","name":"NATMap","desc":"LuCI Support for natmap","desc_en":"LuCI Support for natmap","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["natmap"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-nextdns","name":"NextDNS","desc":"LuCI support for NextDNS","desc_en":"LuCI support for NextDNS","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["nextdns"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-nut","name":"网络 UPS 工具","desc":"Network UPS Tools Configuration","desc_en":"Network UPS Tools Configuration","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["nut","nut-upsmon","nut-server","nut-upsc","nut-web-cgi","nut-upscmd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-omcproxy","name":"组播代理","desc":"LuCI support for omcproxy","desc_en":"LuCI support for omcproxy","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["omcproxy"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-openwisp","name":"OpenWISP","desc":"LuCI support for OpenWISP","desc_en":"LuCI support for OpenWISP","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["openwisp-config"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-pagekitec","name":"PageKite出版商","desc":"LuCI Support for PageKite","desc_en":"LuCI Support for PageKite","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["pagekitec"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-pbr","name":"策略路由","desc":"Policy Based Routing Service Web UI","desc_en":"Policy Based Routing Service Web UI","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["jsonfilter","pbr"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-radicale3","name":"Radicale3","desc":"Radicale v3 CalDAV/CardDAV Server","desc_en":"Radicale v3 CalDAV/CardDAV Server","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["radicale3","rpcd-mod-rad3-enc"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-rtp2httpd","name":"rtp2httpd","desc":"LuCI support for rtp2httpd","desc_en":"LuCI support for rtp2httpd","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["rtp2httpd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-rustdesk-server","name":"RustDesk 服务器","desc":"LuCI support for RustDesk Server","desc_en":"LuCI support for RustDesk Server","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["rustdesk-server"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ser2net","name":"串口命令转发(ser2net)","desc":"LuCI Support for ser2net","desc_en":"LuCI Support for ser2net","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["ser2net"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-snmpd","name":"SNMPD","desc":"Net-SNMP LuCI interface","desc_en":"Net-SNMP LuCI interface","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["snmpd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-spotifyd","name":"Spotifyd","desc":"LuCI support for spotifyd","desc_en":"LuCI support for spotifyd","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["spotifyd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-squid","name":"Squid","desc":"Squid LuCI Interface","desc_en":"Squid LuCI Interface","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["squid"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-sshtunnel","name":"SSH 隧道","desc":"LuCI support for SSH Tunnels (sshtunnel package)","desc_en":"LuCI support for SSH Tunnels (sshtunnel package)","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["sshtunnel"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-sysuh3c","name":"SYSU H3C 客户端","desc":"LuCI support for SYSU H3C 802.1X Client","desc_en":"LuCI support for SYSU H3C 802.1X Client","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["sysuh3c"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-tinyproxy","name":"Tinyproxy 服务器","desc":"Tinyproxy - HTTP(S)-Proxy configuration","desc_en":"Tinyproxy - HTTP(S)-Proxy configuration","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["tinyproxy"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-tor","name":"Tor onion 路由","desc":"LuCI app to configure Tor","desc_en":"LuCI app to configure Tor","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["tor","tor-hs"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-travelmate","name":"Travelmate","desc":"LuCI support for Travelmate","desc_en":"LuCI support for Travelmate","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-uqr","travelmate"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-udpxy","name":"udpxy","desc":"LuCI Support for udpxy","desc_en":"LuCI Support for udpxy","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["udpxy"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-wechatpush","name":"微信推送","desc":"LuCI support for wechatpush","desc_en":"LuCI support for wechatpush","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["iputils-arping","curl","jq","bash","PACKAGE_WECHATPUSH_Enable_Local_Disk_Information_Detection:lsblk","PACKAGE_WECHATPUSH_Enable_Local_Disk_Information_Detection:smartmontools","PACKAGE_WECHATPUSH_Enable_Local_Disk_Information_Detection:smartmontools-drivedb","PACKAGE_WECHATPUSH_Enable_Host_Information_Detection:openssh-client","PACKAGE_WECHATPUSH_Enable_Host_Information_Detection:openssh-keygen"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-xinetd","name":"Xinetd","desc":"LuCI Support for xinetd","desc_en":"LuCI Support for xinetd","cat":"服务","kind":"app","origin":{"type":"builtin"},"deps":["xinetd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-cifs-mount","name":"挂载 SMB 网络共享","desc":"LuCI for SMB/CIFS Mount","desc_en":"LuCI for SMB/CIFS Mount","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["kmod-fs-cifs"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-diskman","name":"diskman","desc":"Disk Manager interface for LuCI","desc_en":"Disk Manager interface for LuCI","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["blkid","e2fsprogs","parted","smartmontools","dosfstools","kmod-fs-msdos","kmod-fs-ntfs3","kmod-fs-exfat","exfat-mkfs","exfat-fsck","kmod-nls-cp932","kmod-nls-cp936","kmod-nls-cp950","PACKAGE_$(PKG_NAME)_INCLUDE_btrfs_progs:btrfs-progs","PACKAGE_$(PKG_NAME)_INCLUDE_lsblk:lsblk","PACKAGE_$(PKG_NAME)_INCLUDE_mdadm:mdadm","PACKAGE_$(PKG_NAME)_INCLUDE_kmod_md_raid456:mdadm","PACKAGE_$(PKG_NAME)_INCLUDE_kmod_md_raid456:kmod-md-raid456","PACKAGE_$(PKG_NAME)_INCLUDE_kmod_md_linears:mdadm","PACKAGE_$(PKG_NAME)_INCLUDE_kmod_md_linears:kmod-md-linear"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-hd-idle","name":"硬盘休眠","desc":"Hard Disk Idle Spin-Down module","desc_en":"Hard Disk Idle Spin-Down module","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["hd-idle","lsblk"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ksmbd","name":"网络共享","desc":"Network Shares - Ksmbd the SMB kernel fileserver","desc_en":"Network Shares - Ksmbd the SMB kernel fileserver","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["ksmbd-server"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-minidlna","name":"miniDLNA","desc":"LuCI Support for miniDLNA","desc_en":"LuCI Support for miniDLNA","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["minidlna"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-mjpg-streamer","name":"MJPG-streamer(网络摄像机串流)","desc":"MJPG-Streamer service configuration module","desc_en":"MJPG-Streamer service configuration module","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["mjpg-streamer"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-nfs","name":"nfs","desc":"LuCI support for nfs","desc_en":"LuCI support for nfs","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["nfs-utils","nfs-kernel-server","nfs-kernel-server-utils","mount-utils"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-openlist","name":"OpenList","desc":"把多个网盘聚合成统一的文件目录。","desc_en":"LuCI app for OpenList","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["openlist"],"requires":[],"size_mb":12,"rec":false,"tut":"首次启动后在日志里查看管理员密码。","tags":[],"hidden":false},{"id":"luci-app-p910nd","name":"p910nd - 打印服务器","desc":"p910nd - Printer server module","desc_en":"p910nd - Printer server module","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["p910nd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ps3netsrv","name":"ps3netsrv","desc":"Luci for PS3NETSRV","desc_en":"Luci for PS3NETSRV","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["ps3netsrv"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-rclone","name":"rclone","desc":"LuCI support for Rclone","desc_en":"LuCI support for Rclone","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["rclone-config","PACKAGE_$(PKG_NAME)_INCLUDE_rclone-webui:rclone-webui-react","PACKAGE_$(PKG_NAME)_INCLUDE_rclone-ng:rclone-ng"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-samba4","name":"网络共享","desc":"局域网内共享硬盘文件夹。","desc_en":"Network Shares - Samba 4 SMB/CIFS fileserver","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["samba4-server"],"requires":[],"size_mb":2.5,"rec":false,"tut":"先挂载硬盘，再添加共享目录。","tags":[],"hidden":false},{"id":"luci-app-syncthing","name":"syncthing","desc":"LuCI support for syncthing","desc_en":"LuCI support for syncthing","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["syncthing"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-usb-printer","name":"usb-printer","desc":"USB Printer Share via TCP/IP","desc_en":"USB Printer Share via TCP/IP","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["p910nd","kmod-usb-printer"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-vsftpd","name":"vsftpd","desc":"LuCI support for VSFTPD","desc_en":"LuCI support for VSFTPD","cat":"存储","kind":"app","origin":{"type":"builtin"},"deps":["vsftpd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-amule","name":"amule","desc":"LuCI support for Amule","desc_en":"LuCI support for Amule","cat":"下载","kind":"app","origin":{"type":"builtin"},"deps":["amule"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-aria2","name":"Aria2","desc":"轻量多线程下载，可配合网页界面。","desc_en":"LuCI Support for Aria2","cat":"下载","kind":"app","origin":{"type":"builtin"},"deps":["aria2","ariang"],"requires":[],"size_mb":1.5,"rec":false,"tut":"设置下载目录后即可使用。","tags":[],"hidden":false},{"id":"luci-app-qbittorrent","name":"qBittorrent","desc":"功能完整的 BT 下载客户端。","desc_en":"LuCI app for qBittorrent","cat":"下载","kind":"app","origin":{"type":"builtin"},"deps":["qbittorrent-enhanced-edition"],"requires":[],"size_mb":6,"rec":false,"tut":"默认端口 8080，请修改初始密码。","tags":[],"hidden":false},{"id":"luci-app-transmission","name":"Transmission","desc":"LuCI Support for Transmission","desc_en":"LuCI Support for Transmission","cat":"下载","kind":"app","origin":{"type":"builtin"},"deps":["transmission-cli","transmission-daemon","transmission-remote","transmission-web-control"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-docker","name":"docker","desc":"Luci for Docker-CE","desc_en":"Luci for Docker-CE","cat":"容器","kind":"app","origin":{"type":"builtin"},"deps":["docker","dockerd","e2fsprogs","fdisk"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-dockerman","name":"dockerman","desc":"运行容器，体积和内存占用都较大。","desc_en":"LuCI Support for docker","cat":"容器","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-docker","luci-lib-ip","docker","dockerd","docker-compose","ttyd"],"requires":[],"size_mb":30,"rec":false,"tut":"需要外接存储，空间小的设备不建议。","tags":[],"hidden":false},{"id":"luci-app-lxc","name":"lxc","desc":"LXC management Web UI","desc_en":"LXC management Web UI","cat":"容器","kind":"app","origin":{"type":"builtin"},"deps":["lxc","lxc-attach","lxc-console","lxc-create","liblxc","rpcd-mod-lxc","getopt","!LXC_BUSYBOX_OPTIONS:tar"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-babeld","name":"Babeld","desc":"LuCI support for babeld","desc_en":"LuCI support for babeld","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["babeld"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-cpulimit","name":"cpulimit","desc":"cpulimit configuration module","desc_en":"cpulimit configuration module","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["cpulimit"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-cshark","name":"cshark","desc":"Cloudshark capture tool Web UI","desc_en":"Cloudshark capture tool Web UI","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["cshark"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-netdata","name":"Netdata","desc":"实时查看 CPU、流量、温度曲线。","desc_en":"LuCI support for Netdata","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["netdata"],"requires":[],"size_mb":5,"rec":false,"tut":"打开 19999 端口查看仪表盘。","tags":[],"hidden":false},{"id":"luci-app-nlbwmon","name":"带宽监控","desc":"Netlink based bandwidth accounting","desc_en":"Netlink based bandwidth accounting","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-chartjs","nlbwmon"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-softether","name":"SoftEther Status","desc":"Softether management application","desc_en":"Softether management application","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["softethervpn5-client"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-statistics","name":"statistics","desc":"LuCI Statistics Application","desc_en":"LuCI Statistics Application","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["collectd","rrdtool1","collectd-mod-rrdtool","collectd-mod-iwinfo","collectd-mod-cpu","collectd-mod-memory","collectd-mod-interface","collectd-mod-load","collectd-mod-network"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-vnstat2","name":"流量监控器","desc":"LuCI Support for vnStat 2","desc_en":"LuCI Support for vnStat 2","cat":"监控","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-jsonc","vnstat2","vnstati2"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-airplay2","name":"airplay2","desc":"Luci for Apple Airplay2 Receiver","desc_en":"Luci for Apple Airplay2 Receiver","cat":"多媒体","kind":"app","origin":{"type":"builtin"},"deps":["alsa-utils","shairport-sync-openssl"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-music-remote-center","name":"music-remote-center","desc":"Luci for Music Remote Center","desc_en":"Luci for Music Remote Center","cat":"多媒体","kind":"app","origin":{"type":"builtin"},"deps":["alsa-utils","owntone"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-oscam","name":"Content-Type: text/plain; charset=UTF-8\\n","desc":"LuCI Support for oscam","desc_en":"LuCI Support for oscam","cat":"多媒体","kind":"app","origin":{"type":"builtin"},"deps":["oscam"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-unblockneteasemusic","name":"解除网易云音乐播放限制","desc":"解除网易云音乐的播放限制。","desc_en":"LuCI support for UnblockNeteaseMusic (JavaScript)","cat":"多媒体","kind":"app","origin":{"type":"builtin"},"deps":["dnsmasq-full","firewall4","node"],"requires":[],"size_mb":2.8,"rec":false,"tut":"启用后按说明设置设备代理。","tags":[],"hidden":false},{"id":"luci-app-upnp","name":"UPnP IGD 和 PCP","desc":"让下载、游戏程序自动开放端口。","desc_en":"UPnP IGD & PCP/NAT-PMP configuration module","cat":"多媒体","kind":"app","origin":{"type":"builtin"},"deps":["miniupnpd","rpcd-mod-ucode"],"requires":[],"size_mb":0.1,"rec":false,"tut":"勾选启用即可，注意安全风险。","tags":[],"hidden":false},{"id":"luci-app-acl","name":"ACL 设置","desc":"LuCI account management module","desc_en":"LuCI account management module","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-advanced-reboot","name":"高级重启","desc":"Advanced Linksys Reboot Web UI","desc_en":"Advanced Linksys Reboot Web UI","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["jshn"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-argon-config","name":"Argon 主题设置","desc":"LuCI for Argon theme configuration","desc_en":"LuCI for Argon theme configuration","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["luci-theme-argon"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-attendedsysupgrade","name":"值守式系统升级","desc":"LuCI support for attended sysupgrades","desc_en":"LuCI support for attended sysupgrades","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["attendedsysupgrade-common","cgi-io"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-autoreboot","name":"定时重启","desc":"按计划自动重启，保持稳定。","desc_en":"LuCI support for Scheduled Reboot","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":0.05,"rec":false,"tut":"设置每天或每周的重启时间。","tags":[],"hidden":false},{"id":"luci-app-commands","name":"自定义命令","desc":"LuCI Shell Command Module","desc_en":"LuCI Shell Command Module","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-cpufreq","name":"CPU 性能优化调节","desc":"LuCI for CPU Freq Setting","desc_en":"LuCI for CPU Freq Setting","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["cpufreq"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-crowdsec-firewall-bouncer","name":"crowdsec-firewall-bouncer","desc":"CrowdSec firewall bouncer LuCI interface","desc_en":"CrowdSec firewall bouncer LuCI interface","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["crowdsec-firewall-bouncer"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-example","name":"example","desc":"LuCI example app for js based luci","desc_en":"LuCI example app for js based luci","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-filebrowser","name":"文件浏览器","desc":"LuCI File Browser module","desc_en":"LuCI File Browser module","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-filemanager","name":"文件管理器","desc":"LuCI File Manager module","desc_en":"LuCI File Manager module","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-firewall","name":"防火墙","desc":"Firewall and port forwarding application","desc_en":"Firewall and port forwarding application","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["uci-firewall"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-k3screenctrl","name":"Content-Type: text/plain; charset=UTF-8\\n","desc":"LuCI Support for k3screenctrl","desc_en":"LuCI Support for k3screenctrl","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["phicomm-k3screenctrl"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ledtrig-rssi","name":"ledtrig-rssi","desc":"LuCI Support for ledtrigger rssi","desc_en":"LuCI Support for ledtrigger rssi","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["rssileds"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ledtrig-switch","name":"ledtrig-switch","desc":"LuCI Support for ledtrigger switch","desc_en":"LuCI Support for ledtrigger switch","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ledtrig-usbport","name":"ledtrig-usbport","desc":"LuCI Support for ledtrigger usbport","desc_en":"LuCI Support for ledtrigger usbport","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["kmod-usb-ledtrig-usbport"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ltqtapi","name":"ltqtapi","desc":"LuCI Support for Lantiq Devices","desc_en":"LuCI Support for Lantiq Devices","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-oled","name":"Content-Type: text/plain; charset=UTF-8","desc":"","desc_en":"","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["i2c-tools","libconfig"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-package-manager","name":"软件包","desc":"Package management application","desc_en":"Package management application","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-ramfree","name":"释放内存","desc":"LuCI support for RAM free","desc_en":"LuCI support for RAM free","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-splash","name":"splash","desc":"Freifunk DHCP-Splash application","desc_en":"Freifunk DHCP-Splash application","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["luci-lib-nixio","luci-lib-iptparser","luci-lua-runtime","tc","kmod-sched","iptables-mod-nat-extra","iptables-mod-ipopt"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-store","name":"iStore 软件中心","desc":"固件只带基础功能，装机后在路由器里按需安装更多插件，大幅减小固件。","desc_en":"","cat":"系统","kind":"app","origin":{"type":"feed","name":"istore","line":"src-git istore https://github.com/linkease/istore;main"},"deps":[],"requires":["luci-compat"],"size_mb":0.6,"rec":true,"tut":"进入「系统 → 软件中心」，每个应用都附带教程。","tags":[],"hidden":false},{"id":"luci-app-ttyd","name":"终端","desc":"在浏览器里直接打开路由器命令行。","desc_en":"ttyd - Command-line tool for sharing terminal over the web","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["ttyd"],"requires":[],"size_mb":0.3,"rec":false,"tut":"进入「系统 → 终端」。","tags":[],"hidden":false},{"id":"luci-app-uhttpd","name":"uHTTPd","desc":"uHTTPd Webserver Configuration","desc_en":"uHTTPd Webserver Configuration","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["uhttpd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-app-watchcat","name":"Watchcat","desc":"LuCI Support for Watchcat","desc_en":"LuCI Support for Watchcat","cat":"系统","kind":"app","origin":{"type":"builtin"},"deps":["watchcat"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-3g","name":"3g","desc":"Support for 3G","desc_en":"Support for 3G","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["comgt"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-autoip","name":"autoip","desc":"Support for Avahi IPv4LL configuration","desc_en":"Support for Avahi IPv4LL configuration","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["avahi-autoipd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-batman-adv","name":"batman-adv","desc":"Support for the batman-adv protocol","desc_en":"Support for the batman-adv protocol","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["kmod-batman-adv"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-external","name":"external","desc":"Support for externally managed protocol","desc_en":"Support for externally managed protocol","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["external-protocol"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-gre","name":"gre","desc":"Support for GRE tunnels (RFC2784)","desc_en":"Support for GRE tunnels (RFC2784)","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["gre"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-hnet","name":"hnet","desc":"Support for hnet","desc_en":"Support for hnet","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-ipip","name":"ipip","desc":"Support for IPIP tunnels (IPv4-in-IPv4 RFC2003)","desc_en":"Support for IPIP tunnels (IPv4-in-IPv4 RFC2003)","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["ipip"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-ipv6","name":"ipv6","desc":"Support for DHCPv6/6in4/6to4/6rd/DS-Lite/IPIP6","desc_en":"Support for DHCPv6/6in4/6to4/6rd/DS-Lite/IPIP6","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-mbim","name":"mbim","desc":"Support for MBIM","desc_en":"Support for MBIM","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["umbim"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-minieap","name":"Content-Type: text/plain; charset=UTF-8","desc":"LuCI support for MiniEAP","desc_en":"LuCI support for MiniEAP","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["minieap"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-modemmanager","name":"Cellular Network","desc":"Support for ModemManager","desc_en":"Support for ModemManager","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["modemmanager"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-ncm","name":"ncm","desc":"Support for NCM","desc_en":"Support for NCM","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["comgt-ncm"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-nebula","name":"nebula","desc":"Support for Nebula","desc_en":"Support for Nebula","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["nebula","nebula-proto"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-openconnect","name":"openconnect","desc":"Support for OpenConnect VPN","desc_en":"Support for OpenConnect VPN","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["openconnect"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-openfortivpn","name":"openfortivpn","desc":"Support for OpenFortivpn","desc_en":"Support for OpenFortivpn","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["openfortivpn"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-ppp","name":"ppp","desc":"Support for PPP/PPPoE/PPPoA/PPtP","desc_en":"Support for PPP/PPPoE/PPPoA/PPtP","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-pppossh","name":"pppossh","desc":"Support for pppossh","desc_en":"Support for pppossh","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["pppossh"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-qmi","name":"qmi","desc":"Support for QMI","desc_en":"Support for QMI","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["uqmi"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-quectel","name":"quectel","desc":"Support for Quectel WWAN modules","desc_en":"Support for Quectel WWAN modules","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["quectel-cm"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-relay","name":"relay","desc":"Support for relayd pseudo bridges","desc_en":"Support for relayd pseudo bridges","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["relayd"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-sstp","name":"sstp","desc":"Support for SSTP","desc_en":"Support for SSTP","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["sstp-client"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-unet","name":"unet","desc":"Support for unetd VPN","desc_en":"Support for unetd VPN","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["unetd","unet-cli"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-vpnc","name":"vpnc","desc":"Support for VPNC VPN","desc_en":"Support for VPNC VPN","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["vpnc"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-vti","name":"vti","desc":"Support for VTI interfaces","desc_en":"Support for VTI interfaces","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["vti"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-vxlan","name":"vxlan","desc":"Support for Virtual eXtensible Local Area Network (VXLAN, RFC7348)","desc_en":"Support for Virtual eXtensible Local Area Network (VXLAN, RFC7348)","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["vxlan","ip-bridge"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-wireguard","name":"WireGuard","desc":"在外也能安全回家访问内网。","desc_en":"Support for WireGuard VPN","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["wireguard-tools","ucode","luci-lib-uqr","resolveip"],"requires":[],"size_mb":0.1,"rec":false,"tut":"「网络 → 接口」新增 WireGuard 协议。","tags":[],"hidden":false},{"id":"luci-proto-xfrm","name":"xfrm","desc":"Support for XFRM interfaces","desc_en":"Support for XFRM interfaces","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["xfrm"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-proto-yggdrasil","name":"yggdrasil","desc":"Support for Yggdrasil Network","desc_en":"Support for Yggdrasil Network","cat":"协议","kind":"proto","origin":{"type":"builtin"},"deps":["yggdrasil"],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-theme-argon","name":"argon","desc":"清爽的深浅色自适应界面。","desc_en":"Argon Theme","cat":"主题","kind":"theme","origin":{"type":"builtin"},"deps":["wget","jsonfilter"],"requires":[],"size_mb":0.6,"rec":false,"tut":"在「系统 → 主题」切换。","tags":[],"hidden":false},{"id":"luci-theme-bootstrap","name":"bootstrap","desc":"Bootstrap Theme (default)","desc_en":"Bootstrap Theme (default)","cat":"主题","kind":"theme","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-theme-material","name":"material","desc":"Material Theme","desc_en":"Material Theme","cat":"主题","kind":"theme","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-theme-openwrt","name":"openwrt","desc":"LuCI OpenWrt.org theme","desc_en":"LuCI OpenWrt.org theme","cat":"主题","kind":"theme","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false},{"id":"luci-theme-openwrt-2020","name":"openwrt-2020","desc":"LuCI modern OpenWrt theme","desc_en":"LuCI modern OpenWrt theme","cat":"主题","kind":"theme","origin":{"type":"builtin"},"deps":[],"requires":[],"size_mb":null,"rec":false,"tut":"","tags":[],"hidden":false}]}/*CATALOG:END*/;

  let _schemaOk = false;
  async function ensureSchema(env) {
    if (_schemaOk) return;
    const ddl = [
      `CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT, repo_url TEXT, branch TEXT, target TEXT, plugins TEXT, diy_script_1 TEXT, diy_script_2 TEXT, dotconfig_version_id TEXT, schedule_cron TEXT, schedule_enabled INTEGER DEFAULT 0, schedule_dotconfig_version_id TEXT, created_at INTEGER, updated_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS dotconfig_history (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, build_id TEXT, label TEXT, created_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, template_id TEXT, repo_url TEXT, branch TEXT, target TEXT, plugins TEXT, diy_script_1 TEXT, diy_script_2 TEXT, dotconfig_version_id TEXT, dotconfig_snapshot TEXT, dotconfig_result TEXT, trigger_type TEXT DEFAULT 'manual', schedule_cron TEXT, status TEXT, web_url TEXT, download_url TEXT, github_run_id TEXT, created_at INTEGER, updated_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS cache_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)`,
    ];
    const alters = [
      'ALTER TABLE templates ADD COLUMN profile TEXT',
      'ALTER TABLE templates ADD COLUMN selection TEXT',
      'ALTER TABLE templates ADD COLUMN project_id TEXT',
      'ALTER TABLE templates ADD COLUMN menuconfig INTEGER DEFAULT 0',
      'ALTER TABLE templates ADD COLUMN pin_dotconfig_version_id TEXT',
      'UPDATE templates SET pin_dotconfig_version_id = schedule_dotconfig_version_id WHERE pin_dotconfig_version_id IS NULL AND schedule_dotconfig_version_id IS NOT NULL',
      "ALTER TABLE templates ADD COLUMN packages TEXT DEFAULT '[]'",
      'ALTER TABLE builds ADD COLUMN profile TEXT',
      "ALTER TABLE builds ADD COLUMN packages TEXT DEFAULT '[]'",
      'ALTER TABLE builds ADD COLUMN menuconfig INTEGER DEFAULT 1',
      'ALTER TABLE builds ADD COLUMN fail_reason TEXT',
      'ALTER TABLE builds ADD COLUMN log_tail TEXT',
      'ALTER TABLE builds ADD COLUMN github_run_id TEXT',
      // ccache 缓存：use_ccache=本次编译是否启用；cache_from=要恢复的缓存 Release tag；cache_publish=完成后是否发布；cache_tag/size/at=本次已发布的缓存
      'ALTER TABLE builds ADD COLUMN use_ccache INTEGER DEFAULT 0',
      'ALTER TABLE builds ADD COLUMN cache_publish INTEGER DEFAULT 0',
      'ALTER TABLE builds ADD COLUMN cache_from TEXT',
      'ALTER TABLE builds ADD COLUMN cache_tag TEXT',
      'ALTER TABLE builds ADD COLUMN cache_size INTEGER',
      'ALTER TABLE builds ADD COLUMN cache_at INTEGER',
      'ALTER TABLE templates ADD COLUMN cache_use TEXT',
      'ALTER TABLE templates ADD COLUMN cache_publish INTEGER DEFAULT 0',
    ];
    for (const q of ddl) await env.DB.prepare(q).run();
    for (const q of alters) { try { await env.DB.prepare(q).run(); } catch (e) { /* 列已存在 */ } }
    _schemaOk = true;
  }

  const PKG_RE = /^[A-Za-z0-9_.+-]+$/;  // 清单会被写进 .config，必须校验

  // ---------- 项目（源码）与机型：Worker 运行时直接从源码仓库读取 ----------
  const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
  const SEG_RE = /^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/;   // 平台 / 子平台目录名，不允许以 . 开头
  const TARGET_RE = /^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\/[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/;
  const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;
  const SRC_CACHE_TTL = 7 * 24 * 3600 * 1000;

  function parseGithubUrl(u) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u || '');
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  async function cacheGet(env, key) {
    const r = await env.DB.prepare('SELECT value, expires FROM cache_kv WHERE key = ?').bind(key).first();
    if (!r || r.expires < Date.now()) return null;
    try { return JSON.parse(r.value); } catch (e) { return null; }
  }
  async function cacheSet(env, key, val) {
    await env.DB.prepare('INSERT INTO cache_kv (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires')
      .bind(key, JSON.stringify(val), Date.now() + SRC_CACHE_TTL).run();
  }

  // 目录列表走 GitHub contents API。无令牌时每个 IP 每小时只有 60 次且是共享出口，所以带上部署时配置的 token
  async function ghList(env, gh, branch, path) {
    const token = await getConfig(env, 'github_token');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openwrt-auto-build-worker' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
    const r = await fetch(url, { headers });
    if (r.status === 404) throw new Error(`仓库里没有 ${path}，请确认仓库地址和分支正确、仓库是公开的，并且是 OpenWrt 系源码`);
    if (r.status === 403 || r.status === 429) throw new Error('GitHub API 请求受限，请稍后再试（已配置 token 时一般不会出现）');
    if (!r.ok) throw new Error(`GitHub API 错误 ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`${path} 不是目录`);
    return j.map((e) => ({ name: String(e.name), type: String(e.type) }));
  }
  async function rawText(gh, branch, path) {
    const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${enc(branch)}/${enc(path)}`);
    return r.ok ? await r.text() : '';
  }

  // ---- 解析 target/linux/<平台>/image/*.mk 里的 define Device/<id> 与 TARGET_DEVICES ----
  function mkVar(text, name) {
    const m = new RegExp('^' + name + '\\s*:?=\\s*(.*)$', 'm').exec(text);
    return m ? m[1].trim() : '';
  }
  function cleanVal(s) { return s.replace(/\$\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(); }
  function matchSubtargets(stem, subs) {
    if (subs.includes(stem)) return [stem];
    const pre = stem.split(/[-_.]/)[0];
    if (subs.includes(pre)) return [pre];
    return subs.slice();
  }
  function parseDevices(files, subs) {
    const raw = {}, local = {};   // local：按文件区分，同名机型在不同文件里可能有不同定义（如 x86 的 generic）
    for (const f of files) {
      const t = f.text.replace(/\\\n/g, ' ');
      const re = /^define Device\/(\S+)\n([\s\S]*?)^endef/gm;
      let m;
      while ((m = re.exec(t))) { raw[m[1]] = m[2]; (local[f.name] = local[f.name] || {})[m[1]] = m[2]; }
    }
    const memo = {};
    const resolve = (id, ctx, depth) => {
      const mkey = ctx + '|' + id;
      if (memo[mkey]) return memo[mkey];
      const body = (local[ctx] && local[ctx][id] !== undefined) ? local[ctx][id] : (raw[id] || '');
      const d = {};
      if (depth < 8) {
        const pr = /\$\((?:call )?Device\/([^\s)]+)/g;
        let pm;
        while ((pm = pr.exec(body))) {
          if (pm[1] !== id && raw[pm[1]] !== undefined) {
            const pd = resolve(pm[1], ctx, depth + 1);
            for (const k of Object.keys(pd)) if (pd[k]) d[k] = pd[k];
          }
        }
      }
      const vr = /^\s*(DEVICE_(?:VENDOR|MODEL|VARIANT|ALT\d+_VENDOR|ALT\d+_MODEL|ALT\d+_VARIANT))\s*:?=\s*(.*)$/gm;
      let vm;
      while ((vm = vr.exec(body))) d[vm[1]] = cleanVal(vm[2]);
      memo[mkey] = d;
      return d;
    };
    const names = (d, fallback) => {
      const main = [d.DEVICE_VENDOR, d.DEVICE_MODEL, d.DEVICE_VARIANT].filter(Boolean).join(' ') || fallback;
      const alts = [];
      for (const k of Object.keys(d).sort()) {
        const mm = /^DEVICE_ALT(\d+)_MODEL$/.exec(k);
        if (mm && d[k]) {
          const a = [d['DEVICE_ALT' + mm[1] + '_VENDOR'], d[k], d['DEVICE_ALT' + mm[1] + '_VARIANT']].filter(Boolean).join(' ');
          if (a && a !== main) alts.push(a);
        }
      }
      return [main, alts];
    };
    const per = {};
    for (const s of subs) per[s] = {};
    for (const f of files) {
      const stem = f.name.replace(/\.mk$/, '');
      const ids = [];
      const tr = /^TARGET_DEVICES\s*\+?=\s*(.*)$/gm;
      let tm;
      const joined = f.text.replace(/\\\n/g, ' ');
      while ((tm = tr.exec(joined))) for (const x of tm[1].split(/\s+/)) if (/^[A-Za-z0-9_.+-]+$/.test(x)) ids.push(x);
      for (const s of matchSubtargets(stem, subs)) {
        for (const id of ids) {
          const [name, alt] = names(resolve(id, f.name, 0), id);
          per[s][id] = { id, name: name.slice(0, 120), alt: alt.slice(0, 6).map((a) => a.slice(0, 120)) };
        }
      }
    }
    return per;
  }

  async function allProjects(env) {
    const cat = await loadCatalog(env, false);
    const built = cat.sources.map((s) => ({ id: s.id, name: `${s.name} · ${s.branch}`, repo_url: s.repo_url, branch: s.branch, builtin: true }));
    const custom = (await getCustomProjects(env)).map((p) => ({ ...p, builtin: false }));
    return built.concat(custom);
  }
  async function getCustomProjects(env) {
    const raw = await getConfig(env, 'custom_projects');
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  async function projectIdFor(url, branch) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url + '#' + branch));
    return 'custom-' + Array.from(new Uint8Array(buf)).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function handleListProjects(env) {
    return json({ projects: await allProjects(env) });
  }

  async function handleCreateProject(request, env) {
    const body = await request.json().catch(() => null);
    if (!body) return err('请求格式错误');
    const name = String(body.name || '').trim().slice(0, 40);
    const repo_url = String(body.repo_url || '').trim().replace(/\/+$/, '');
    const branch = String(body.branch || '').trim();
    if (!name) return err('请填写项目名称');
    const gh = parseGithubUrl(repo_url);
    if (!gh || repo_url.length > 200) return err('仓库地址格式应为 https://github.com/用户/仓库（目前仅支持 GitHub 仓库）');
    if (!BRANCH_RE.test(branch) || branch.length > 100) return err('分支名只能包含字母、数字和 . _ / -');
    try { await ghList(env, gh, branch, 'target/linux'); } catch (e) { return err(e.message); }
    const list = await getCustomProjects(env);
    const id = await projectIdFor(repo_url, branch);
    if (!list.find((p) => p.id === id)) {
      if (list.length >= 20) return err('自定义项目最多 20 个');
      list.push({ id, name, repo_url, branch, created_at: now() });
      await setConfig(env, 'custom_projects', JSON.stringify(list));
    }
    return json({ project: { ...list.find((p) => p.id === id), builtin: false } }, 201);
  }

  async function handleDeleteProject(env, id) {
    const list = await getCustomProjects(env);
    if (!list.find((p) => p.id === id)) return err('只能删除自定义项目', 404);
    await setConfig(env, 'custom_projects', JSON.stringify(list.filter((p) => p.id !== id)));
    return json({ ok: true });
  }

  async function projectSource(env, pid) {
    if (!PROJECT_ID_RE.test(pid || '')) return { error: err('project 参数非法') };
    const proj = (await allProjects(env)).find((p) => p.id === pid);
    if (!proj) return { error: err('项目不存在', 404) };
    const gh = parseGithubUrl(proj.repo_url);
    if (!gh) return { error: err('目前仅支持从 GitHub 仓库读取平台和机型，请手动填写') };
    return { proj, gh, tag: `${gh.owner}/${gh.repo}@${proj.branch}` };
  }

  // 平台列表：读取 target/linux 目录（1 次 API 调用，缓存 7 天）
  async function handlePlatforms(env, url) {
    const ps = await projectSource(env, url.searchParams.get('project'));
    if (ps.error) return ps.error;
    const force = url.searchParams.get('refresh') === '1';
    const key = `plat:${ps.tag}`;
    if (!force) { const c = await cacheGet(env, key); if (c) return json({ ...c, source: 'cache' }); }
    let entries;
    try { entries = await ghList(env, ps.gh, ps.proj.branch, 'target/linux'); } catch (e) { return err(e.message, 502); }
    const platforms = entries.filter((e) => e.type === 'dir' && e.name !== 'generic' && SEG_RE.test(e.name)).map((e) => ({ id: e.name }));
    if (!platforms.length) return err('没有找到任何平台，请确认这是 OpenWrt 系源码仓库', 404);
    const data = { project: ps.proj.id, platforms, fetched_at: new Date().toISOString().slice(0, 10) };
    await cacheSet(env, key, data);
    return json({ ...data, source: 'github' });
  }

  // 单个平台：子平台 + 各子平台的机型（读取该平台的 Makefile、image 目录下的 *.mk，缓存 7 天）
  async function handlePlatform(env, url) {
    const ps = await projectSource(env, url.searchParams.get('project'));
    if (ps.error) return ps.error;
    const target = url.searchParams.get('target') || '';
    if (!SEG_RE.test(target)) return err('target 参数非法');
    const force = url.searchParams.get('refresh') === '1';
    const key = `dev:${ps.tag}:${target}`;
    if (!force) { const c = await cacheGet(env, key); if (c) return json({ ...c, source: 'cache' }); }
    const br = ps.proj.branch, base = `target/linux/${target}`;
    const mk = await rawText(ps.gh, br, `${base}/Makefile`);
    if (!mkVar(mk, 'BOARD')) return err(`${target} 不是有效的平台`, 404);
    const subs = (mkVar(mk, 'SUBTARGETS').split(/\s+/).filter((s) => SEG_RE.test(s)));
    if (!subs.length) subs.push('generic');
    let listing;
    try { listing = await ghList(env, ps.gh, br, `${base}/image`); } catch (e) { return err(e.message, 502); }
    const names = listing.filter((e) => e.type === 'file' && (e.name === 'Makefile' || /^[A-Za-z0-9_.+-]+\.mk$/.test(e.name))).map((e) => e.name).slice(0, 45);
    const files = await Promise.all(names.map(async (n) => ({ name: n, text: await rawText(ps.gh, br, `${base}/image/${n}`) })));
    const subMk = await Promise.all(subs.slice(0, 10).map((s) => rawText(ps.gh, br, `${base}/${s}/target.mk`)));
    const per = parseDevices(files, subs);
    const subtargets = [];
    subs.forEach((s, i) => {
      const devices = Object.values(per[s]).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      if (!devices.length) return;
      const st = subMk[i] || '';
      const board = cleanVal(mkVar(st, 'BOARDNAME') || mkVar(mk, 'BOARDNAME') || s);
      const arch = [mkVar(st, 'ARCH') || mkVar(mk, 'ARCH'), mkVar(st, 'CPU_TYPE') || mkVar(mk, 'CPU_TYPE')].filter(Boolean).join('/');
      subtargets.push({ id: s, name: board.slice(0, 120), arch: arch.slice(0, 60), devices });
    });
    if (!subtargets.length) return err(`${target} 下没有解析到机型`, 404);
    const data = { project: ps.proj.id, id: target, name: cleanVal(mkVar(mk, 'BOARDNAME')).slice(0, 120), subtargets, fetched_at: new Date().toISOString().slice(0, 10) };
    await cacheSet(env, key, data);
    return json({ ...data, source: 'github' });
  }

  // ---------- 自定义插件：用户填写插件仓库地址，保存后和目录里的插件一起出现在商店 ----------
  const CUSTOM_PLUGIN_MAX = 40;
  async function getCustomPlugins(env) {
    const raw = await getConfig(env, 'custom_plugins');
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  async function ghJson(env, path) {
    const token = await getConfig(env, 'github_token');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openwrt-auto-build-worker' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch('https://api.github.com' + path, { headers });
    if (r.status === 404) throw new Error('仓库或分支不存在（需要是公开仓库）');
    if (r.status === 403 || r.status === 429) throw new Error('GitHub API 请求受限，请稍后再试');
    if (!r.ok) throw new Error(`GitHub API 错误 ${r.status}`);
    return r.json();
  }
  function cleanRepoUrl(u) { return String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/, ''); }
  function httpsRepoOk(u) { return u.length <= 300 && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/%+@-]+$/.test(u); }

  // 从 Makefile 文本里取出它定义的包名：BuildPackage 的字面量、PKG_NAME；都没有（luci 应用）就用目录名。
  // 包名以 Makefile 为准，不是目录名：CONFIG_PACKAGE_<包名> 才是 .config 里要启用的符号。
  function makefilePkgNames(text, dirBase) {
    const names = [], t = text || '';
    const add = (n) => { if (n && PKG_RE.test(n) && !names.includes(n)) names.push(n); };
    const pkg = cleanVal(mkVar(t, 'PKG_NAME'));
    for (const m of t.matchAll(/call\s+BuildPackage,\s*([A-Za-z0-9_.+-]+)/g)) add(m[1]);
    if (/call\s+BuildPackage,\s*\$\(PKG_NAME\)/.test(t)) add(pkg);
    if (!names.length) add(pkg);
    if (!names.length) add(dirBase);
    return names;
  }
  function pickPrimary(names, dirBase) {
    const id = names.includes(dirBase) ? dirBase : names[0];
    return { id, requires: names.filter((n) => n !== id) };
  }

  // 自动识别：根目录有 Makefile → 整个仓库就是一个包；否则列出 3 层以内带 Makefile 的子目录，让用户勾选。
  // 包名都读自 Makefile（一个目录里定义了多个包时，其余的作为自动依赖一起启用）
  async function handleDetectCustomPlugin(request, env) {
    const body = await request.json().catch(() => null);
    if (!body) return err('请求格式错误');
    const repo_url = cleanRepoUrl(body.repo_url);
    if (!httpsRepoOk(repo_url)) return err('仓库地址格式应为 https://github.com/用户/仓库');
    const gh = parseGithubUrl(repo_url);
    if (!gh) return json({ detected: false, reason: '目前只能自动识别 GitHub 仓库，请手动填写包名' });
    let branch = String(body.branch || '').trim();
    if (branch && (!BRANCH_RE.test(branch) || branch.length > 100)) return err('分支名只能包含字母、数字和 . _ / -');
    try {
      if (!branch) branch = String((await ghJson(env, `/repos/${gh.owner}/${gh.repo}`)).default_branch || '');
      if (!branch) return err('读取不到默认分支，请手动填写分支');
      const tree = await ghJson(env, `/repos/${gh.owner}/${gh.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const dirs = (tree.tree || []).filter((e) => e.type === 'blob' && /(^|\/)Makefile$/.test(e.path)).map((e) => e.path.replace(/\/?Makefile$/, ''));
      const root = dirs.includes('');
      let primary = { id: PKG_RE.test(gh.repo) ? gh.repo : 'plugin', requires: [] };
      if (root) primary = pickPrimary(makefilePkgNames(await rawText(gh, branch, 'Makefile'), primary.id), primary.id);
      let candidates = dirs.filter((p) => p && p.split('/').length <= 3 && GIT_DIR_RE.test(p)).slice(0, 300)
        .map((p) => ({ path: p, base: p.split('/').pop() })).filter((c) => PKG_RE.test(c.base));
      // 读取前 30 个目录的 Makefile 得到真实包名（并行；加上前面 2~3 次请求，仍在 Worker 50 个子请求的限制内）
      const texts = root ? [] : await Promise.all(candidates.slice(0, 30).map((c) => rawText(gh, branch, c.path + '/Makefile').catch(() => '')));
      candidates = candidates.map((c, i) => {
        const pk = pickPrimary(makefilePkgNames(texts[i], c.base), c.base);
        return { path: c.path, id: pk.id, requires: pk.requires };
      });
      return json({ detected: true, branch, repo: gh.repo, root, pkg_name: primary.id, requires: primary.requires, candidates, truncated: !!tree.truncated });
    } catch (e) { return err(e.message, 502); }
  }

  async function handleListCustomPlugins(env) {
    return json({ plugins: await getCustomPlugins(env) });
  }

  async function handleCreateCustomPlugin(request, env) {
    const body = await request.json().catch(() => null);
    if (!body) return err('请求格式错误');
    const repo_url = cleanRepoUrl(body.repo_url);
    if (!httpsRepoOk(repo_url)) return err('仓库地址格式应为 https://github.com/用户/仓库（仅支持 https）');
    const branch = String(body.branch || '').trim();
    if (branch && (!BRANCH_RE.test(branch) || branch.length > 100)) return err('分支名只能包含字母、数字和 . _ / -');
    const requires = sanitizeIds(body.requires, 20);
    const desc = String(body.desc || '').trim().slice(0, 200);
    // 两种形态：整个仓库是一个包（id）；或者仓库里的若干子目录各是一个包（dirs）
    const items = [];
    if (Array.isArray(body.dirs) && body.dirs.length) {
      if (body.dirs.length > 20) return err('一次最多添加 20 个子目录');
      for (const raw of body.dirs) {
        const d = String(typeof raw === 'string' ? raw : (raw && raw.path) || '');
        if (!GIT_DIR_RE.test(d) || d.length > 200) return err(`子目录非法：${d.slice(0, 60)}`);
        const base = d.split('/').pop();
        if (!PKG_RE.test(base)) return err(`子目录名非法：${base.slice(0, 60)}`);
        const id = (raw && typeof raw === 'object' && raw.id) ? String(raw.id) : base;   // 包名以 Makefile 为准，可以和目录名不同
        if (!PKG_RE.test(id)) return err(`包名非法：${id.slice(0, 60)}`);
        const own = (raw && typeof raw === 'object') ? sanitizeIds(raw.requires, 20) : [];
        items.push({ id, own, origin: { type: 'git', name: base, url: repo_url, branch, sparse: true, dirs: [d] } });
      }
    } else {
      const id = String(body.id || '').trim();
      if (!PKG_RE.test(id)) return err('请填写包名（只能包含字母、数字和 . _ + -）');
      items.push({ id, origin: { type: 'git', name: id, url: repo_url, branch, sparse: false, dirs: [] } });
    }
    const cat = await loadCatalog(env, false);
    const taken = new Set(cat.plugins.map((p) => p.id));
    const list = await getCustomPlugins(env);
    const added = [];
    for (const it of items) {
      if (taken.has(it.id)) return err(`${it.id} 已经在插件目录里了，不需要自定义添加`);
      const dupIdx = list.findIndex((p) => p.id === it.id);
      const entry = {
        id: it.id,
        name: items.length === 1 && body.name ? String(body.name).trim().slice(0, 40) || it.id : it.id,
        desc: desc || `自定义插件，来自 ${repo_url.replace('https://', '')}`,
        desc_en: '', cat: '自定义', kind: 'app', origin: it.origin,
        deps: [], requires: Array.from(new Set(requires.concat(it.own || []))).filter((x) => x !== it.id), size_mb: null, rec: false, tut: '', tags: [], hidden: false, custom: true, created_at: now(),
      };
      if (dupIdx >= 0) list[dupIdx] = entry; else list.push(entry);
      added.push(entry);
    }
    if (list.length > CUSTOM_PLUGIN_MAX) return err(`自定义插件最多 ${CUSTOM_PLUGIN_MAX} 个，请先删除不用的`);
    await setConfig(env, 'custom_plugins', JSON.stringify(list));
    return json({ plugins: added }, 201);
  }

  async function handleDeleteCustomPlugin(env, id) {
    const list = await getCustomPlugins(env);
    if (!list.find((p) => p.id === id)) return err('自定义插件不存在', 404);
    await setConfig(env, 'custom_plugins', JSON.stringify(list.filter((p) => p.id !== id)));
    return json({ ok: true });
  }

  async function handleCatalog(env, url) {
    const cat = await loadCatalog(env, url.searchParams.get('refresh') === '1');
    const custom = await getCustomPlugins(env);
    if (!custom.length) return json(cat);
    const have = new Set(cat.plugins.map((p) => p.id));
    const extra = custom.filter((p) => !have.has(p.id));
    return json({
      ...cat,
      categories: cat.categories.concat([{ id: '自定义', order: 99, keywords: '自定义 第三方 自己的' }]),
      plugins: cat.plugins.concat(extra),
    });
  }

  // 校验目录：内容最终会进入编译配置，来自网络的数据必须过滤
  function sanitizeCatalog(raw) {
    if (!raw || raw.schema !== 1 || !Array.isArray(raw.plugins) || !Array.isArray(raw.categories)) return null;
    const httpsUrl = (u) => typeof u === 'string' && /^https:\/\/\S+$/.test(u);
    const cats = new Set(raw.categories.map((c) => c.id));
    const sources = (raw.sources || []).filter((s) => s && PROJECT_ID_RE.test(s.id || '') && httpsUrl(s.repo_url) && typeof s.branch === 'string' && s.branch);
    const plugins = raw.plugins.filter((p) => {
      if (!p || typeof p.id !== 'string' || !PKG_RE.test(p.id) || !cats.has(p.cat)) return false;
      if (['app', 'theme', 'proto'].indexOf(p.kind) < 0) return false;
      if (!Array.isArray(p.deps)) p.deps = [];
      if (!Array.isArray(p.requires) || p.requires.some((r) => !PKG_RE.test(r))) { if (Array.isArray(p.requires)) return false; p.requires = []; }
      const o = p.origin || { type: 'builtin' };
      if (o.type === 'builtin') return true;
      if (o.type === 'git') return httpsUrl(o.url) && typeof o.name === 'string' && PKG_RE.test(o.name);
      if (o.type === 'feed') return typeof o.name === 'string' && PKG_RE.test(o.name) && /^src-(git|git-full|link) [A-Za-z0-9_.-]+ https:\/\/\S+$/.test(o.line || '');
      return false;
    });
    if (!plugins.length || !sources.length) return null;
    return { ...raw, sources, plugins };
  }
  let _catCache = { at: 0, data: null };
  async function loadCatalog(env, force) {
    if (!force && _catCache.data && Date.now() - _catCache.at < 300000) return _catCache.data;
    let out = null;
    try {
      const repo = await getConfig(env, 'github_repo');
      if (repo) {
        const r = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/catalog.json`, { cf: { cacheTtl: force ? 0 : 300, cacheEverything: !force } });
        if (r.ok) { const c = sanitizeCatalog(await r.json()); if (c) out = { ...c, source: 'remote' }; }
      }
    } catch (e) { /* 读取失败时使用内置目录 */ }
    if (!out) out = { ...sanitizeCatalog(JSON.parse(JSON.stringify(STORE_FALLBACK))), source: 'embedded' };
    _catCache = { at: Date.now(), data: out };
    return out;
  }

  // 构建结束后，拉起排队中的下一个任务
  async function dispatchNextQueued(env) {
    if (await hasActiveBuild(env)) return;
    const next = await env.DB.prepare("SELECT id FROM builds WHERE status='queued' ORDER BY created_at LIMIT 1").first();
    if (!next) return;
    await env.DB.prepare("UPDATE builds SET status='pending', updated_at=? WHERE id=?").bind(now(), next.id).run();
    try { await dispatchGithubWorkflow(env, next.id); }
    catch (e) { await env.DB.prepare("UPDATE builds SET status='failed', fail_reason=?, updated_at=? WHERE id=?").bind('触发失败: ' + e.message, now(), next.id).run(); }
  }

  const APP_CSS = `
/* ============================================================
   固件工坊 · UI 改版 Demo
   Design tokens + components
   ============================================================ */

:root {
  --bg: #f5f6fb;
  --surface: #ffffff;
  --surface-2: #f8f9fc;
  --surface-3: #eef0f7;
  --line: #e7e9f1;
  --line-2: #dcdfeb;
  --ink: #111527;
  --ink-2: #4b5468;
  --ink-3: #8d95a8;
  --brand: #4c6ef5;
  --brand-2: #3b5bdb;
  --brand-soft: #eef1ff;
  --brand-line: #ccd6ff;
  --ok: #0f8a5f;
  --ok-soft: #e7f7f0;
  --warn: #a8630a;
  --warn-soft: #fff4e4;
  --bad: #c92a3e;
  --bad-soft: #fdebed;
  --r-sm: 8px;
  --r: 12px;
  --r-lg: 16px;
  --r-xl: 20px;
  --sh-1: 0 1px 2px rgba(17, 21, 39, .05);
  --sh-2: 0 8px 24px -12px rgba(17, 21, 39, .18);
  --sh-3: 0 24px 48px -24px rgba(17, 21, 39, .3);
  --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, "JetBrains Mono", "SFMono-Regular", "Cascadia Code", Consolas, monospace;
  --side-w: 238px;
}

body[data-theme="dark"] {
  --bg: #0c0e15;
  --surface: #141824;
  --surface-2: #181d2a;
  --surface-3: #1f2534;
  --line: #242a39;
  --line-2: #2e3546;
  --ink: #eef1f8;
  --ink-2: #a6afc2;
  --ink-3: #6d768b;
  --brand: #7d95ff;
  --brand-2: #6a84f5;
  --brand-soft: rgba(125, 149, 255, .14);
  --brand-line: rgba(125, 149, 255, .3);
  --ok: #3ecf8e;
  --ok-soft: rgba(62, 207, 142, .12);
  --warn: #f0b45c;
  --warn-soft: rgba(240, 180, 92, .12);
  --bad: #ff7b8a;
  --bad-soft: rgba(255, 123, 138, .12);
  --sh-1: 0 1px 2px rgba(0, 0, 0, .3);
  --sh-2: 0 10px 30px -14px rgba(0, 0, 0, .7);
  --sh-3: 0 28px 60px -28px rgba(0, 0, 0, .8);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "cv11", "ss01";
}
a { color: var(--brand); text-decoration: none; }
button, input, select, textarea { font-family: inherit; }
code, .mono { font-family: var(--mono); }
svg { width: 14px; height: 14px; flex: 0 0 auto; }
.tag svg { width: 11px; height: 11px; }
.pill svg { width: 11px; height: 11px; }
.sum svg { width: 13px; height: 13px; }
::selection { background: var(--brand-soft); color: var(--brand-2); }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 6px; }

/* ---------------- 布局 ---------------- */
.app { display: flex; min-height: 100vh; }

.side {
  width: var(--side-w);
  flex: 0 0 var(--side-w);
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 18px 14px 14px;
  background: linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%);
  border-right: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 20px; }
.brand-mark {
  width: 34px; height: 34px; border-radius: 10px;
  display: grid; place-items: center; color: #fff;
  background: linear-gradient(145deg, #6b8cff, #3b5bdb);
  box-shadow: 0 4px 12px -3px rgba(59, 91, 219, .55), inset 0 1px 0 rgba(255, 255, 255, .25);
}
.brand-mark svg { width: 19px; height: 19px; }
.brand-txt { display: flex; flex-direction: column; line-height: 1.2; }
.brand-txt b { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.brand-txt small { font-family: var(--mono); font-size: 10px; color: var(--ink-3); letter-spacing: .04em; }

.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-label {
  font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--ink-3); padding: 14px 10px 6px;
}
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 10px;
  color: var(--ink-2); font-size: 13.5px; font-weight: 500;
  cursor: pointer; border: 1px solid transparent; position: relative;
  transition: background .16s, color .16s, border-color .16s;
}
.nav-item svg { width: 17px; height: 17px; stroke-width: 1.7; opacity: .85; }
.nav-item:hover { background: var(--surface-3); color: var(--ink); }
.nav-item.active {
  background: var(--surface); color: var(--brand-2);
  border-color: var(--line); font-weight: 600;
  box-shadow: var(--sh-1);
}
body[data-theme="dark"] .nav-item.active { color: var(--brand); }
.nav-item.active svg { opacity: 1; color: var(--brand); }
.nav-item.active::before {
  content: ""; position: absolute; left: -14px; top: 9px; bottom: 9px;
  width: 3px; border-radius: 0 3px 3px 0; background: var(--brand);
}
.nav-badge {
  margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 99px; background: var(--brand); color: #fff;
  font-family: var(--mono); font-size: 10.5px; font-weight: 600;
  display: grid; place-items: center;
}
.nav-badge[hidden] { display: none; }
.spinner-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft); animation: pulse 1.4s ease-in-out infinite;
}

.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; }
.queue {
  border: 1px solid var(--line); border-radius: var(--r); overflow: hidden;
  background: var(--surface); box-shadow: var(--sh-1); cursor: pointer;
}
.queue:hover { border-color: var(--brand-line); }
.queue-head {
  display: flex; align-items: center; gap: 7px; padding: 9px 11px 7px;
  font-size: 11px; font-family: var(--mono); letter-spacing: .06em;
  text-transform: uppercase; color: var(--ink-3);
}
.queue-body { padding: 0 11px 10px; }
.queue-name { font-size: 12.5px; font-weight: 600; margin-bottom: 2px; }
.queue-sub { font-size: 11.5px; color: var(--ink-3); font-family: var(--mono); margin-bottom: 8px; }
.queue-bar { height: 4px; border-radius: 99px; background: var(--surface-3); overflow: hidden; }
.queue-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #6b8cff, #3b5bdb); transition: width .5s ease; }
.side-actions { display: flex; gap: 6px; }
.side-actions .btn { flex: 1; justify-content: center; }

.main { flex: 1; min-width: 0; }
.main-inner { max-width: 1180px; margin: 0 auto; padding: 26px 34px 72px; }

/* ---------------- 基础元素 ---------------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 13px; border-radius: 10px; cursor: pointer;
  font-size: 13px; font-weight: 550; line-height: 1.2; white-space: nowrap;
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--line-2); box-shadow: var(--sh-1);
  transition: background .16s, border-color .16s, color .16s, transform .12s, box-shadow .16s;
}
.btn svg { width: 15px; height: 15px; stroke-width: 1.8; }
.btn:hover { background: var(--surface-3); border-color: var(--line-2); }
.btn:active { transform: translateY(1px); }
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.btn-primary {
  background: linear-gradient(180deg, #5a7bff, #3b5bdb);
  color: #fff; border-color: #3550c9;
  box-shadow: 0 1px 2px rgba(49, 76, 190, .4), 0 8px 18px -10px rgba(59, 91, 219, .9), inset 0 1px 0 rgba(255, 255, 255, .22);
}
.btn-primary:hover { background: linear-gradient(180deg, #6684ff, #3f5fe0); border-color: #3550c9; }
.btn-soft { background: var(--brand-soft); color: var(--brand-2); border-color: transparent; box-shadow: none; }
body[data-theme="dark"] .btn-soft { color: var(--brand); }
.btn-soft:hover { background: var(--brand-soft); border-color: var(--brand-line); }
.btn-ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--ink-2); }
.btn-ghost:hover { background: var(--surface-3); color: var(--ink); }
.btn-danger { color: var(--bad); border-color: var(--line-2); }
.btn-danger:hover { background: var(--bad-soft); border-color: var(--bad); }
.btn-sm { padding: 5px 9px; font-size: 12px; border-radius: 8px; }
.btn-sm svg { width: 13px; height: 13px; }
.btn-icon { width: 34px; height: 34px; padding: 0; }
.btn-lg { padding: 11px 18px; font-size: 14px; border-radius: 11px; }
.btn-block { width: 100%; }

.pill {
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 9px; border-radius: 99px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .01em; white-space: nowrap;
  background: var(--surface-3); color: var(--ink-2);
}
.pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .85; }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.bad { background: var(--bad-soft); color: var(--bad); }
.pill.run { background: var(--brand-soft); color: var(--brand-2); }
body[data-theme="dark"] .pill.run { color: var(--brand); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.run::before { animation: pulse 1.4s ease-in-out infinite; }
.pill.plain::before { display: none; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.75); } }

.tag {
  display: inline-flex; align-items: center; gap: 4px; height: 21px; padding: 0 7px;
  border-radius: 6px; background: var(--surface-3); color: var(--ink-2);
  font-family: var(--mono); font-size: 11px; white-space: nowrap;
}

.input, .select {
  width: 100%; padding: 8px 11px; border-radius: 9px;
  border: 1px solid var(--line-2); background: var(--surface); color: var(--ink);
  font-size: 13px; transition: border-color .16s, box-shadow .16s;
}
.input::placeholder { color: var(--ink-3); }
.input:focus, .select:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.select {
  appearance: none;
  background-image: url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238d95a8' stroke-width='2.4' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; padding-right: 30px;
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { font-size: 12px; font-weight: 600; color: var(--ink-2); letter-spacing: .01em; }
.field .hint { font-size: 11.5px; color: var(--ink-3); line-height: 1.5; }

.switch { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; user-select: none; }
.switch input { position: absolute; opacity: 0; pointer-events: none; }
.switch .track {
  width: 36px; height: 21px; border-radius: 99px; background: var(--surface-3);
  border: 1px solid var(--line-2); position: relative; transition: background .18s, border-color .18s;
  flex: 0 0 auto;
}
.switch .track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px;
  border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px rgba(17, 21, 39, .25);
  transition: transform .18s;
}
.switch input:checked + .track { background: var(--brand); border-color: var(--brand); }
.switch input:checked + .track::after { transform: translateX(15px); }
.switch input:focus-visible + .track { box-shadow: 0 0 0 3px var(--brand-soft); }

.seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--surface-3); border-radius: 10px; border: 1px solid var(--line); }
.seg button {
  border: 0; background: transparent; color: var(--ink-2); cursor: pointer;
  padding: 5px 11px; border-radius: 7px; font-size: 12.5px; font-weight: 550;
  transition: background .16s, color .16s, box-shadow .16s;
}
.seg button:hover { color: var(--ink); }
.seg button.on { background: var(--surface); color: var(--ink); box-shadow: var(--sh-1); }

/* ---------------- 页头 ---------------- */
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 22px; flex-wrap: wrap; }
.eyebrow {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em;
  text-transform: uppercase; color: var(--ink-3); display: flex; align-items: center; gap: 8px;
}
.eyebrow b { color: var(--brand); font-weight: 600; }
.page-head h1 { margin: 6px 0 0; font-size: 23px; font-weight: 650; letter-spacing: -.025em; line-height: 1.25; }
.page-head .sub { color: var(--ink-2); font-size: 13px; margin-top: 5px; max-width: 62ch; }
.page-head .actions { display: flex; gap: 8px; align-items: center; }

.crumbs { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-3); margin-bottom: 12px; }
.crumbs a { color: var(--ink-2); }
.crumbs svg { width: 12px; height: 12px; }

/* ---------------- 卡片 ---------------- */
.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-lg); box-shadow: var(--sh-1);
}
.card-pad { padding: 18px 20px; }
.card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 15px 18px; border-bottom: 1px solid var(--line);
}
.card-head h2 { margin: 0; font-size: 13.5px; font-weight: 650; letter-spacing: -.01em; }
.card-head .sub { font-size: 11.5px; color: var(--ink-3); margin-top: 2px; }
.card-head .right { display: flex; align-items: center; gap: 8px; }

/* ---------------- 统计条 ---------------- */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
.stat {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  padding: 13px 15px; box-shadow: var(--sh-1); position: relative; overflow: hidden;
}
.stat-k { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.stat-v { font-size: 21px; font-weight: 650; letter-spacing: -.03em; margin-top: 4px; display: flex; align-items: baseline; gap: 5px; }
.stat-v small { font-size: 11.5px; font-weight: 500; color: var(--ink-3); letter-spacing: 0; }
.stat-d { font-size: 11.5px; color: var(--ink-3); margin-top: 2px; }
.stat-d b { color: var(--ok); font-weight: 600; }
.stat-d b.bad { color: var(--bad); }

/* ---------------- 模板卡片 ---------------- */
.tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.tpl {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 16px 17px 14px; box-shadow: var(--sh-1); cursor: pointer;
  transition: border-color .16s, box-shadow .18s, transform .18s;
  display: flex; flex-direction: column; gap: 11px; position: relative; overflow: hidden;
}
.tpl::after {
  content: ""; position: absolute; inset: 0 0 auto; height: 2px;
  background: linear-gradient(90deg, var(--brand), #a78bfa);
  opacity: 0; transition: opacity .2s;
}
.tpl:hover { border-color: var(--brand-line); box-shadow: var(--sh-2); transform: translateY(-2px); }
.tpl:hover::after { opacity: 1; }
.tpl-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.tpl-name { font-size: 15px; font-weight: 650; letter-spacing: -.015em; }
.tpl-dev { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); margin-top: 3px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tpl-dev i { font-style: normal; opacity: .45; }
.tpl-chips { display: flex; flex-wrap: wrap; gap: 5px; min-height: 21px; }
.tpl-foot {
  display: flex; align-items: center; gap: 10px; padding-top: 11px;
  border-top: 1px solid var(--line); margin-top: auto;
}
.tpl-foot .last { font-size: 11.5px; color: var(--ink-3); display: flex; align-items: center; gap: 5px; }
.tpl-foot .spacer { margin-left: auto; }

.tpl-new {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  margin-top: 14px; padding: 15px; border: 1px dashed var(--line-2); border-radius: var(--r-lg);
  background: transparent; cursor: pointer; color: var(--ink-3); font-size: 13px; font-weight: 550;
  transition: all .18s; width: 100%; font-family: inherit;
}
.tpl-new:hover { border-color: var(--brand); color: var(--brand-2); background: var(--brand-soft); }
.tpl-new .circle {
  width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
  background: var(--surface); border: 1px solid var(--line); box-shadow: var(--sh-1);
}
.tpl-new .circle svg { width: 14px; height: 14px; }
.tpl-new small { font-size: 11.5px; opacity: .8; font-weight: 400; }

/* 插件 chip */
.chip {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
  border-radius: 7px; background: var(--surface-2); border: 1px solid var(--line);
  font-size: 11.5px; color: var(--ink-2); white-space: nowrap;
}
.chip .dot { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 5px; margin-right: 1px; }
.chip .x { border: 0; background: none; padding: 0 0 0 2px; cursor: pointer; color: var(--ink-3); display: grid; place-items: center; }
.chip .x:hover { color: var(--bad); }
.chip svg { width: 10px; height: 10px; }

/* ---------------- 步骤条 ---------------- */
.steps { display: flex; align-items: center; gap: 0; margin-bottom: 18px; }
.step { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--ink-3); }
.step .n {
  width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  font-family: var(--mono); font-size: 10.5px; font-weight: 600;
  border: 1px solid var(--line-2); background: var(--surface); color: var(--ink-3);
}
.step.on { color: var(--ink); font-weight: 600; }
.step.on .n { background: var(--brand); border-color: var(--brand); color: #fff; box-shadow: 0 0 0 3px var(--brand-soft); }
.step.done .n { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.step-line { width: 34px; height: 1px; background: var(--line-2); margin: 0 12px; }

/* ---------------- 商店 ---------------- */
.store-top {
  display: grid; grid-template-columns: 1fr 1fr 1fr 1.2fr; gap: 12px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 15px 16px; box-shadow: var(--sh-1); margin-bottom: 16px;
}
.store-layout { display: grid; grid-template-columns: minmax(0, 1fr) 316px; gap: 18px; align-items: start; }
.filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.search { position: relative; flex: 1; min-width: 180px; }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ink-3); }
.search .input { padding-left: 31px; }
.cats { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 12px; }
.cat {
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 99px;
  font-size: 12px; font-weight: 550; color: var(--ink-2); cursor: pointer;
  background: var(--surface); border: 1px solid var(--line); transition: all .16s;
}
.cat:hover { border-color: var(--line-2); background: var(--surface-3); }
.cat .n { font-family: var(--mono); font-size: 10px; color: var(--ink-3); }
.cat.on { background: var(--ink); border-color: var(--ink); color: var(--surface); }
body[data-theme="dark"] .cat.on { background: var(--brand); border-color: var(--brand); color: #0c0e15; }
.cat.on .n { color: inherit; opacity: .6; }

.plugins { display: grid; grid-template-columns: repeat(auto-fill, minmax(238px, 1fr)); gap: 10px; }
.plugin {
  position: relative; display: flex; gap: 11px; padding: 12px 13px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  cursor: pointer; transition: border-color .16s, box-shadow .16s, background .16s, transform .14s;
  box-shadow: var(--sh-1);
}
.plugin:hover { border-color: var(--brand-line); box-shadow: var(--sh-2); transform: translateY(-1px); }
.plugin.on { border-color: var(--brand); background: linear-gradient(180deg, var(--brand-soft), var(--surface) 70%); box-shadow: 0 0 0 3px var(--brand-soft); }
.plugin .tile {
  width: 34px; height: 34px; flex: 0 0 34px; border-radius: 9px;
  display: grid; place-items: center; font-weight: 700; font-size: 14px;
  letter-spacing: -.02em;
}
.plugin .body { min-width: 0; flex: 1; }
.plugin .nm { font-size: 13px; font-weight: 600; letter-spacing: -.01em; display: flex; align-items: center; gap: 5px; }
.plugin .nm .rec { color: var(--brand); display: inline-flex; }
.plugin .nm .rec svg { width: 11px; height: 11px; }
.plugin .pk { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.plugin .ds { font-size: 11.5px; color: var(--ink-2); line-height: 1.45; margin-top: 5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.plugin .meta { display: flex; gap: 8px; align-items: center; margin-top: 7px; font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); }
.plugin .tick {
  position: absolute; top: 9px; right: 9px; width: 17px; height: 17px; border-radius: 50%;
  border: 1.5px solid var(--line-2); display: grid; place-items: center; color: transparent;
  background: var(--surface); transition: all .16s;
}
.plugin .tick svg { width: 10px; height: 10px; stroke-width: 3; }
.plugin.on .tick { background: var(--brand); border-color: var(--brand); color: #fff; }

/* 已选清单 */
.basket { position: sticky; top: 20px; display: flex; flex-direction: column; gap: 12px; }
.basket-inner { display: flex; flex-direction: column; }
.basket-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; }
.basket-head h2 { margin: 0; font-size: 13.5px; font-weight: 650; display: flex; align-items: center; gap: 7px; }
.basket-head .cnt {
  font-family: var(--mono); font-size: 10.5px; background: var(--brand-soft); color: var(--brand-2);
  padding: 2px 6px; border-radius: 99px; font-weight: 600;
}
body[data-theme="dark"] .basket-head .cnt { color: var(--brand); }
.basket-list { padding: 0 10px; max-height: 232px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.basket-list::-webkit-scrollbar { width: 8px; }
.basket-list::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 99px; }
.bi { display: flex; align-items: center; gap: 8px; padding: 6px 7px; border-radius: 8px; font-size: 12.5px; }
.bi:hover { background: var(--surface-2); }
.bi .tile-s { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; font-weight: 700; flex: 0 0 20px; }
.bi .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bi .x { margin-left: auto; border: 0; background: none; color: var(--ink-3); cursor: pointer; display: grid; place-items: center; padding: 2px; border-radius: 4px; }
.bi .x:hover { color: var(--bad); background: var(--bad-soft); }
.bi .x svg { width: 12px; height: 12px; }
.basket-empty { padding: 26px 16px; text-align: center; color: var(--ink-3); font-size: 12.5px; }
.basket-body { padding: 12px 16px 16px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 11px; }
.sum { display: flex; align-items: baseline; justify-content: space-between; font-size: 12.5px; color: var(--ink-2); }
.sum b { font-family: var(--mono); font-size: 13px; color: var(--ink); }
.meter { height: 5px; border-radius: 99px; background: var(--surface-3); overflow: hidden; }
.meter i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #6b8cff, #3b5bdb); transition: width .35s; }
.meter.warn i { background: linear-gradient(90deg, #f5b544, #e08a10); }
.meter-hint { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink-3); font-family: var(--mono); }
.note {
  display: flex; gap: 8px; padding: 9px 11px; border-radius: 9px;
  background: var(--warn-soft); color: var(--warn); font-size: 11.5px; line-height: 1.5;
  border: 1px solid transparent;
}
.note svg { width: 13px; height: 13px; flex: 0 0 13px; margin-top: 1px; }

/* ---------------- 详情 ---------------- */
.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 18px; align-items: start; }
.hero {
  background: linear-gradient(135deg, var(--surface) 40%, var(--brand-soft));
  border: 1px solid var(--line); border-radius: var(--r-lg); padding: 20px 22px;
  box-shadow: var(--sh-1); margin-bottom: 16px; position: relative; overflow: hidden;
}
.hero::after {
  content: ""; position: absolute; right: -60px; top: -80px; width: 240px; height: 240px;
  border-radius: 50%; background: radial-gradient(circle, rgba(76, 110, 245, .16), transparent 65%);
}
.hero h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -.025em; }
.hero .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 14px; margin-top: 16px; position: relative; }
.kv .k { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.kv .v { font-size: 13px; font-weight: 550; margin-top: 2px; }
.kv .v.mono { font-family: var(--mono); font-size: 12px; font-weight: 500; }

.opt-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.opt-row:last-child { border-bottom: 0; padding-bottom: 2px; }
.opt-row .t { font-size: 13px; font-weight: 600; }
.opt-row .d { font-size: 11.5px; color: var(--ink-3); margin-top: 2px; max-width: 46ch; line-height: 1.5; }
.opt-row .c { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.opt-row .c .select { width: auto; min-width: 156px; }

.chip-box { display: flex; flex-wrap: wrap; gap: 6px; }

/* ---------------- 构建记录 ---------------- */
.build {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  padding: 13px 15px; margin-bottom: 9px; box-shadow: var(--sh-1);
  transition: border-color .16s, box-shadow .16s;
}
.build:hover { border-color: var(--line-2); box-shadow: var(--sh-2); }
.build-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.build-top .nm { font-size: 13.5px; font-weight: 600; }
.build-top .tm { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.build-top .right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.build-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 7px; font-size: 11.5px; color: var(--ink-3); }
.build-meta .sep { opacity: .4; }
.progress { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
.progress .bar { flex: 1; height: 6px; border-radius: 99px; background: var(--surface-3); overflow: hidden; position: relative; }
.progress .bar i {
  display: block; height: 100%; border-radius: 99px;
  background: linear-gradient(90deg, #6b8cff, #3b5bdb);
  background-size: 200% 100%; animation: slide 2s linear infinite; transition: width .5s;
}
@keyframes slide { from { background-position: 0 0; } to { background-position: -200% 0; } }
.progress .pct { font-family: var(--mono); font-size: 11px; color: var(--ink-2); width: 34px; text-align: right; }
.fail-line {
  margin-top: 9px; display: flex; align-items: flex-start; gap: 7px;
  font-size: 12.5px; color: var(--bad); background: var(--bad-soft);
  border-radius: 8px; padding: 8px 10px; line-height: 1.5;
}
.fail-line svg { width: 14px; height: 14px; flex: 0 0 14px; margin-top: 1px; }
.fail-detail { margin-top: 8px; }
.fail-detail > summary {
  cursor: pointer; font-size: 12px; color: var(--ink-2); list-style: none;
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 0;
}
.fail-detail > summary::-webkit-details-marker { display: none; }
.fail-detail > summary svg { width: 12px; height: 12px; transition: transform .15s; }
.fail-detail[open] > summary svg { transform: rotate(90deg); }
.fail-detail pre {
  margin: 6px 0 0; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 8px; font-family: var(--mono); font-size: 11.5px; line-height: 1.65;
  color: var(--ink-2); white-space: pre-wrap; word-break: break-word; max-height: 190px; overflow: auto;
}
.build-links { display: flex; gap: 12px; margin-top: 9px; flex-wrap: wrap; }
.build-links a { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
.build-links a svg { width: 12px; height: 12px; }

.build.compact { padding: 10px 12px; margin-bottom: 8px; }
.build.compact .build-top { gap: 7px; }
.build.compact .build-top .nm { font-size: 12.5px; }
.build.compact .build-top .tm { font-size: 10.5px; }
.build.compact .build-meta { margin-top: 4px; font-size: 10.5px; gap: 5px; }
.build.compact .timeline { margin-top: 7px; }
.build.compact .build-links { display: none; }
.build.compact .progress { margin-top: 7px; }
.timeline { display: flex; align-items: center; gap: 0; margin-top: 10px; }
.tl-step { display: flex; align-items: center; gap: 0; }
.tl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-2); flex: 0 0 7px; }
.tl-dot.done { background: var(--ok); }
.tl-dot.cur { background: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.tl-dot.bad { background: var(--bad); }
.tl-bar { width: 26px; height: 1px; background: var(--line-2); }
.tl-bar.done { background: var(--ok); }

/* ---------------- 空状态 / 其他 ---------------- */
.empty { text-align: center; padding: 54px 20px; border: 1px dashed var(--line-2); border-radius: var(--r-lg); color: var(--ink-3); background: var(--surface); }
.empty .g { width: 46px; height: 46px; border-radius: 13px; background: var(--surface-3); display: grid; place-items: center; margin: 0 auto 12px; color: var(--ink-3); }
.empty .g svg { width: 22px; height: 22px; }
.empty .m { font-size: 13.5px; color: var(--ink-2); font-weight: 600; }
.empty .s { font-size: 12px; margin-top: 4px; }

.code {
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px;
  padding: 12px 14px; font-family: var(--mono); font-size: 11.5px; line-height: 1.7;
  color: var(--ink-2); max-height: 300px; overflow: auto; white-space: pre;
}
.code .c { color: var(--ink-3); }
.code .v { color: var(--brand-2); }
body[data-theme="dark"] .code .v { color: var(--brand); }

.kbd { font-family: var(--mono); font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: var(--surface-3); border: 1px solid var(--line); color: var(--ink-2); }

/* ---------------- Toast / Modal ---------------- */
.toasts { position: fixed; right: 22px; bottom: 22px; display: flex; flex-direction: column; gap: 9px; z-index: 90; }
.toast {
  display: flex; align-items: flex-start; gap: 9px; min-width: 240px; max-width: 360px;
  padding: 11px 13px; border-radius: 11px; background: var(--surface);
  border: 1px solid var(--line); box-shadow: var(--sh-3);
  font-size: 12.5px; animation: toast-in .22s cubic-bezier(.2, .8, .3, 1);
}
.toast .g { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 18px; background: var(--ok-soft); color: var(--ok); margin-top: 1px; }
.toast .g svg { width: 11px; height: 11px; stroke-width: 3; }
.toast.err .g { background: var(--bad-soft); color: var(--bad); }
.toast.info .g { background: var(--brand-soft); color: var(--brand-2); }
.toast b { display: block; font-size: 12.5px; margin-bottom: 1px; }
.toast span { color: var(--ink-3); font-size: 11.5px; }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }

.overlay { position: fixed; inset: 0; background: rgba(12, 16, 30, .42); backdrop-filter: blur(3px); display: grid; place-items: center; z-index: 100; padding: 20px; animation: fade .16s; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.modal {
  width: 100%; max-width: 520px; background: var(--surface); border-radius: var(--r-lg);
  border: 1px solid var(--line); box-shadow: var(--sh-3); animation: pop .2s cubic-bezier(.2, .8, .3, 1);
  max-height: 88vh; display: flex; flex-direction: column;
}
@keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--line); }
.modal-head h3 { margin: 0; font-size: 14.5px; font-weight: 650; }
.modal-body { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.modal-foot { padding: 13px 18px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 8px; }

/* ---------------- 动画 / 响应式 ---------------- */
.fade-up { animation: up .28s cubic-bezier(.2, .8, .3, 1) both; }
@keyframes up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.stagger > * { animation: up .3s cubic-bezier(.2, .8, .3, 1) both; }
.stagger > *:nth-child(1) { animation-delay: .01s; }
.stagger > *:nth-child(2) { animation-delay: .03s; }
.stagger > *:nth-child(3) { animation-delay: .05s; }
.stagger > *:nth-child(4) { animation-delay: .07s; }
.stagger > *:nth-child(5) { animation-delay: .09s; }
.stagger > *:nth-child(6) { animation-delay: .11s; }
.stagger > *:nth-child(n+7) { animation-delay: .13s; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
@media (max-width: 1080px) {
  .store-layout, .detail-grid { grid-template-columns: 1fr; }
  .basket { position: static; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .store-top { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 860px) {
  .app { flex-direction: column; }
  .side {
    width: 100%; flex: none; height: auto; position: sticky; top: 0; z-index: 40;
    flex-direction: row; align-items: center; padding: 10px 12px; gap: 10px;
    border-right: 0; border-bottom: 1px solid var(--line);
  }
  .brand { padding: 0; }
  .brand-txt small { display: none; }
  .nav { flex-direction: row; gap: 2px; margin-left: auto; }
  .nav-label, .side-foot { display: none; }
  .nav-item { padding: 7px 9px; font-size: 12.5px; }
  .nav-item.active::before { display: none; }
  .nav-item span.t { display: none; }
  .main-inner { padding: 18px 14px 60px; }
  .page-head h1 { font-size: 20px; }
  .store-top { grid-template-columns: 1fr; }
  .plugins { grid-template-columns: 1fr; }
}

/* ============================================================
   生产版补充样式（登录、表格、设置、细节）
   ============================================================ */

.hint { font-size: 11.5px; color: var(--ink-3); line-height: 1.6; }
.dim { color: var(--ink-3); }
.mono { font-family: var(--mono); }

/* 载入 */
.loading { display: flex; align-items: center; justify-content: center; gap: 9px; padding: 46px 0; color: var(--ink-3); font-size: 13px; }
.loading svg { width: 16px; height: 16px; animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255, 255, 255, .35); border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; margin-right: 6px; vertical-align: -2px; }

/* ---------------- 登录 / 初始化 ---------------- */
.auth {
  min-height: 100vh; display: grid; place-items: center; padding: 26px;
  background:
    radial-gradient(900px 500px at 15% 10%, var(--brand-soft), transparent 60%),
    radial-gradient(700px 420px at 90% 90%, rgba(167, 139, 250, .14), transparent 60%),
    var(--bg);
}
.auth-card {
  width: min(880px, 100%); display: grid; grid-template-columns: 380px minmax(0, 1fr);
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-xl);
  box-shadow: var(--sh-3); overflow: hidden;
}
.auth-art {
  position: relative; overflow: hidden; padding: 34px 32px;
  background: linear-gradient(155deg, #3b5bdb 0%, #5568e8 55%, #7d6cf0 100%);
  color: #fff; display: flex; flex-direction: column;
}
.auth-art::after {
  content: ""; position: absolute; right: -70px; bottom: -90px; width: 260px; height: 260px;
  border-radius: 50%; background: radial-gradient(circle, rgba(255, 255, 255, .22), transparent 62%);
}
.auth-logo {
  width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center;
  background: rgba(255, 255, 255, .18); border: 1px solid rgba(255, 255, 255, .28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .3);
}
.auth-logo svg { width: 22px; height: 22px; }
.auth-art-t { font-size: 21px; font-weight: 650; letter-spacing: -.02em; margin-top: 20px; }
.auth-art-s { font-family: var(--mono); font-size: 11px; opacity: .78; margin-top: 4px; letter-spacing: .02em; }
.auth-points { list-style: none; margin: 26px 0 0; padding: 0; display: flex; flex-direction: column; gap: 12px; position: relative; z-index: 1; }
.auth-points li { display: flex; gap: 9px; font-size: 12.5px; line-height: 1.5; opacity: .92; }
.auth-points svg { width: 14px; height: 14px; flex: 0 0 14px; margin-top: 2px; opacity: .9; }
.auth-form { padding: 36px 34px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.auth-form h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -.025em; }
.auth-sub { margin: -4px 0 8px; font-size: 12.5px; color: var(--ink-3); line-height: 1.6; }
.auth-form form { display: flex; flex-direction: column; gap: 13px; }
.auth-err {
  font-size: 12px; color: var(--bad); background: var(--bad-soft);
  border-radius: 8px; padding: 8px 10px; line-height: 1.5;
}
.auth-foot { font-size: 11.5px; color: var(--ink-3); text-align: center; line-height: 1.6; }
.auth-done { display: flex; flex-direction: column; gap: 12px; }
.auth-done h2 { margin: 0; font-size: 18px; font-weight: 650; }
.auth-ok {
  width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
  background: var(--ok-soft); color: var(--ok);
}
.auth-ok svg { width: 20px; height: 20px; stroke-width: 2.6; }
.token-box {
  display: flex; gap: 8px; align-items: center; padding: 10px 12px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px;
}
.token-box code { flex: 1; min-width: 0; font-family: var(--mono); font-size: 11.5px; word-break: break-all; color: var(--ink); }

/* ---------------- 商店补充 ---------------- */
.st-hint { margin: -6px 0 14px; }
.plugin { position: relative; }
.plugin .corner-tag {
  position: absolute; top: 10px; right: 30px; font-size: 9.5px; letter-spacing: .04em;
  padding: 1px 5px; border-radius: 4px; background: var(--surface-3); color: var(--ink-3);
  font-family: var(--mono); text-transform: uppercase;
}
.plugin .corner-tag.warn { background: var(--warn-soft); color: var(--warn); }
.note.ok { background: var(--ok-soft); color: var(--ok); }
.note.info { background: var(--brand-soft); color: var(--brand-2); }
body[data-theme="dark"] .note.info { color: var(--brand); }
.basket .field > label { font-size: 11.5px; }

.cand-box {
  max-height: 220px; overflow: auto; border: 1px solid var(--line); border-radius: 10px;
  padding: 6px 10px; display: flex; flex-direction: column;
}
.cand { display: flex; gap: 8px; padding: 4px 0; font-size: 12.5px; align-items: flex-start; line-height: 1.45; }
.cand input { width: auto; margin-top: 3px; }

.src-list { margin-top: 14px; display: flex; flex-direction: column; gap: 2px; }
.src-row {
  display: flex; gap: 8px; align-items: center; font-size: 11.5px; color: var(--ink-2);
  padding: 6px 0; border-bottom: 1px dashed var(--line);
}
.src-row:last-child { border-bottom: 0; }
.src-row svg { width: 12px; height: 12px; color: var(--ink-3); flex: 0 0 12px; }
.src-row code { font-family: var(--mono); font-size: 11px; color: var(--ink); }
.src-row > span { color: var(--ink-3); word-break: break-all; flex: 1; min-width: 0; }

/* ---------------- 详情 ---------------- */
.hero { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 18px; align-items: flex-start; }
.hero-main { min-width: 0; flex: 1 1 320px; position: relative; z-index: 1; }
.hero-actions { display: flex; gap: 8px; flex-wrap: wrap; position: relative; z-index: 1; }
.hero .kv { width: 100%; flex: 0 0 100%; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
.stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.side-col { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 20px; }

.opt-row { align-items: center; }
.opt-row .c .switch { margin: 0; }
.sched-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sched-label { font-size: 13px; font-weight: 600; margin-right: 2px; }
.cron-presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 10px; }
.cron-presets .cat:hover { border-color: var(--brand); color: var(--brand-2); }

.next-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 12px; border-bottom: 1px dashed var(--line); }
.next-row:last-of-type { border-bottom: 0; }
.next-row .k { color: var(--ink-3); flex: 0 0 auto; }
.next-row .v { font-weight: 550; text-align: right; }
.next-note { display: flex; gap: 7px; margin-top: 10px; font-size: 11.5px; color: var(--ink-3); line-height: 1.5; }
.next-note svg { width: 13px; height: 13px; flex: 0 0 13px; margin-top: 1px; }

.fold > summary { cursor: pointer; list-style: none; font-size: 12px; color: var(--ink-2); display: inline-flex; align-items: center; gap: 5px; padding: 2px 0; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary svg { width: 12px; height: 12px; transition: transform .15s; }
.fold[open] > summary svg { transform: rotate(90deg); }
.fold pre { margin: 8px 0 0; }

/* ---------------- 版本表 ---------------- */
.vtable { width: 100%; border-collapse: collapse; font-size: 12px; }
.vtable th {
  text-align: left; font-weight: 600; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--ink-3); padding: 10px 12px; border-bottom: 1px solid var(--line);
  background: var(--surface-2); white-space: nowrap;
}
.vtable td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.vtable tr:last-child td { border-bottom: 0; }
.vtable tbody tr:hover td { background: var(--surface-2); }
.ref-tag { display: inline-flex; padding: 1px 6px; border-radius: 5px; font-size: 10.5px; background: var(--surface-3); color: var(--ink-2); margin-right: 4px; white-space: nowrap; }
.ref-tag.sched { background: var(--brand-soft); color: var(--brand-2); }
body[data-theme="dark"] .ref-tag.sched { color: var(--brand); }
.label-cell { display: flex; align-items: center; gap: 6px; }
.label-cell .label-text { color: var(--ink-2); }
.icon-btn { border: 0; background: none; color: var(--ink-3); cursor: pointer; padding: 2px; border-radius: 4px; display: grid; place-items: center; }
.icon-btn:hover { color: var(--brand); background: var(--brand-soft); }
.icon-btn svg { width: 12px; height: 12px; }
.row-ops { display: flex; gap: 9px; justify-content: flex-end; flex-wrap: wrap; }

.lnk {
  background: none; border: 0; padding: 0; cursor: pointer; font-size: 12px; font-family: inherit;
  color: var(--ink-2); display: inline-flex; align-items: center; gap: 4px; text-decoration: none;
}
.lnk:hover { color: var(--brand); text-decoration: underline; }
.lnk svg { width: 12px; height: 12px; }
.lnk.danger { color: var(--bad); }
.lnk[disabled] { opacity: .4; cursor: not-allowed; text-decoration: none; }
.build-links { align-items: center; gap: 14px; }

/* ---------------- 记录页 ---------------- */
.seg button .n { font-family: var(--mono); font-size: 10px; opacity: .55; margin-left: 2px; }
.seg button.on .n { opacity: .8; }
.progress .bar i.indet { width: 100% !important; opacity: .9; }
.build-meta .tag-inline { display: inline-flex; align-items: center; gap: 3px; }
.build-meta .tag-inline svg { width: 11px; height: 11px; opacity: .65; }

/* ---------------- 设置 ---------------- */
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.dl { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--line); font-size: 12px; }
.dl:last-of-type { border-bottom: 0; }
.dl .k { color: var(--ink-3); flex: 0 0 88px; }
.dl .v { color: var(--ink); word-break: break-all; font-weight: 500; }
.danger-card { border-color: rgba(201, 42, 62, .22); }
.danger-card .card-head h2 { color: var(--bad); }

@media (max-width: 900px) {
  .settings-grid { grid-template-columns: 1fr; }
  .auth-card { grid-template-columns: 1fr; }
  .auth-art { padding: 24px 24px 22px; }
  .auth-points { display: none; }
  .auth-form { padding: 26px 22px 30px; }
  .side-col { position: static; }
}
@media (max-width: 860px) {
  .hero { flex-direction: column; }
  .hero-actions { width: 100%; }
  .hero-actions .btn { flex: 1; justify-content: center; }
  .opt-row { flex-direction: column; align-items: flex-start; gap: 8px; }
  .opt-row .c { width: 100%; }
  .opt-row .c .select { width: 100%; }
  .row-ops { justify-content: flex-start; }
  .auth { padding: 14px; }
  .auth-art { display: none; }
  .auth-card { grid-template-columns: 1fr; }
}

/* 卡片细节 */
.tpl-foot { flex-wrap: wrap; row-gap: 8px; }
.tpl-dev { overflow-wrap: anywhere; }
.tpl-chips .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

/* 表格不出卡片 */
.stack > .card, .settings-grid > .card { min-width: 0; }
.card > div[style*="overflow-x"] { border-radius: 0 0 var(--r-lg) var(--r-lg); }
.vtable { min-width: 560px; }
.vtable td .row-ops { gap: 7px; }
.vtable .label-cell .label-text { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }

/* 移动端保留主题/退出按钮 */
@media (max-width: 860px) {
  .side-foot { display: flex; flex-direction: row; margin: 0 0 0 6px; }
  .side-foot .queue { display: none; }
  .side-actions { gap: 4px; }
  .side-actions .btn { padding: 6px 8px; }
  .side-actions .btn span { display: none; }
  .nav { margin-left: auto; }
}
  `;

  const APP_JS = `
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
  const h = location.hash.replace(/^#\\/?/, '');
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
  const detail = [b.log_tail].filter(Boolean).join('\\n');
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
  return lines.join('\\n');
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
  if (dd.length && S.profile && /^(mediatek\\/mt7621|ath79|ramips)/.test(targetStr())) warns.push('小内存机型上跑容器容易 OOM，确认内存足够再加。');
  return warns;
}
function configPreview() {
  const lines = [];
  if (S.profile && /^[^/]+\\/[^/]+$/.test(targetStr())) {
    const m = targetStr().split('/');
    lines.push('CONFIG_TARGET_' + m[0] + '=y', 'CONFIG_TARGET_' + m[0] + '_' + m[1] + '=y', 'CONFIG_TARGET_' + m[0] + '_' + m[1] + '_DEVICE_' + S.profile + '=y');
  }
  selectedPlugins().forEach(function (p) {
    lines.push('CONFIG_PACKAGE_' + p.id + '=y');
    (p.requires || []).forEach(function (r) { lines.push('CONFIG_PACKAGE_' + r + '=y'); });
  });
  return lines.join('\\n');
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
  if (!/^[^/]+\\/[^/]+$/.test(target)) { toast('请先选择平台和子平台', '', 'err'); return; }
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
    <title>固件工坊 · OpenWrt 编译台</title>
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
    await ensureSchema(env);
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
    if (path === '/api/report/cache' && method === 'POST') {
      if (!(await requireReportToken(request, env))) return err('unauthorized', 401);
      return handleWorkflowReportCache(request, env);
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
    if (path === '/api/projects' && method === 'GET') return handleListProjects(env);
    if (path === '/api/projects' && method === 'POST') return handleCreateProject(request, env);
    const pjm = path.match(/^\/api\/projects\/([a-z0-9._-]+)$/);
    if (pjm && method === 'DELETE') return handleDeleteProject(env, pjm[1]);
    if (path === '/api/platforms' && method === 'GET') return handlePlatforms(env, url);
    if (path === '/api/platform' && method === 'GET') return handlePlatform(env, url);
    if (path === '/api/catalog' && method === 'GET') return handleCatalog(env, url);
    if (path === '/api/custom-plugins' && method === 'GET') return handleListCustomPlugins(env);
    if (path === '/api/custom-plugins' && method === 'POST') return handleCreateCustomPlugin(request, env);
    if (path === '/api/custom-plugins/detect' && method === 'POST') return handleDetectCustomPlugin(request, env);
    const cpm = path.match(/^\/api\/custom-plugins\/([A-Za-z0-9_.+-]+)$/);
    if (cpm && method === 'DELETE') return handleDeleteCustomPlugin(env, cpm[1]);
    if (path === '/api/caches' && method === 'GET') return handleListCaches(request, env);
    if (path === '/api/trigger' && method === 'POST') return handleTrigger(request, env);
    if (path === '/api/builds' && method === 'GET') return handleListBuilds(request, env, url);
    {
      const m = path.match(/^\/api\/builds\/([^/]+)$/);
      if (m && method === 'GET') return handleGetBuild(request, env, decodeURIComponent(m[1]));
    }
    {
      const m = path.match(/^\/api\/builds\/([^/]+)\/cancel$/);
      if (m && method === 'POST') return handleCancelBuild(request, env, decodeURIComponent(m[1]));
    }
    {
      const m = path.match(/^\/api\/builds\/([^/]+)\/cache-publish$/);
      if (m && method === 'POST') return handleSetBuildCachePublish(request, env, decodeURIComponent(m[1]));
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
      ctx.waitUntil(ensureSchema(env).then(() => runScheduledBuilds(env, event.cron)));
    },
  };
