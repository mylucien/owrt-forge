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
  }
  .st-bar { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1.6fr; gap: 12px; margin: 14px 0 18px; }
  .st-bar label { display: block; font-size: 13px; color: var(--text-dim); }
  .st-bar select, .st-bar input { width: 100%; margin-top: 4px; }
  .st-layout { display: grid; grid-template-columns: 1fr 320px; gap: 20px; align-items: start; padding-bottom: 70px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; background: var(--panel-raised); border: 1px solid var(--border); border-radius: 999px; font-size: 12.5px; }
  .chip small { color: var(--text-dim); }
  .chip button { border: 0; background: none; color: var(--text-dim); padding: 0 6px; cursor: pointer; }
  .st-tools { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 10px; }
  .st-tools input { flex: 1; min-width: 0; }
  .st-tools button { white-space: nowrap; }
  .st-chips, .st-presets { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; font-size: 13px; color: var(--text-dim); }
  .st-chips button[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .st-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .st-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg, 12px); padding: 14px; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
  .st-card:hover { border-color: var(--accent); }
  .st-top { display: flex; gap: 10px; align-items: center; }
  .st-tile { flex: none; width: 42px; height: 42px; border-radius: 11px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 17px; }
  .st-card h3 { margin: 0; font-size: 14px; }
  .st-card code { font-size: 11.5px; color: var(--text-dim); }
  .st-card p { margin: 0; font-size: 13px; color: var(--text-dim); min-height: 2.8em; }
  .st-foot { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); margin-top: auto; }
  .st-foot button { margin-left: auto; }
  .st-foot button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .st-basket { position: sticky; top: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .st-basket h2 { margin: 0; font-size: 15px; }
  .st-basket ul { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow: auto; }
  .st-basket li { display: flex; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .st-basket li button { margin-left: auto; border: 0; background: none; color: var(--text-dim); }
  .st-sum { display: flex; gap: 18px; font-size: 13px; color: var(--text-dim); }
  .st-sum b { color: var(--text); font-size: 16px; margin-right: 3px; }
  .st-warn { background: var(--panel-raised); border-left: 3px solid #d98a00; padding: 7px 10px; font-size: 12.5px; border-radius: 6px; }
  .st-opt { display: flex; gap: 8px; font-size: 13px; align-items: flex-start; }
  .st-opt small { display: block; color: var(--text-dim); }
  .st-basket textarea { width: 100%; height: 100px; font: 11.5px/1.5 var(--font-mono, monospace); }
  .st-field { position: relative; }
  .st-dd { position: absolute; left: 0; right: 0; top: 100%; z-index: 20; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; max-height: 280px; overflow: auto; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
  .st-opt-item { padding: 6px 10px; cursor: pointer; display: flex; flex-direction: column; }
  .st-opt-item:hover { background: var(--panel-raised); }
  .st-opt-item small { color: var(--text-dim); }
  .build-row .links { flex-wrap: wrap; }
  .fail-log { white-space: pre-wrap; font-size: 12px; background: var(--panel-raised); padding: 8px; border-radius: 6px; margin: 6px 0 0; max-height: 160px; overflow: auto; }
  @media (max-width: 900px) { .st-bar, .st-layout { grid-template-columns: 1fr; } .st-basket { position: static; } }
`;
  
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
    listCaches() { return this.get('/api/caches'); },
    setCachePublish(id, enabled) { return this.post(\`/api/builds/\${id}/cache-publish\`, { enabled }); },
    cancelBuild(id) { return this.post(\`/api/builds/\${id}/cancel\`); },
  };
  
  const store = { authed: false, systemStatus: 'ready', route: { name: 'templates', params: {} }, templates: [], builds: [], pollTimer: null };
  
  function parseHash() {
    const h = location.hash.replace(/^#\\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'template' && parts[1]) return { name: 'template-detail', params: { id: parts[1] } };
    if (parts[0] === 'trigger' && parts[1]) return { name: 'template-detail', params: { id: parts[1] } };
    if (parts[0] === 'store' && parts[1]) return { name: 'store', params: { tpl: parts[1] } };
    if (parts[0] === 'builds') return { name: 'builds', params: {} };
    if (parts[0] === 'templates') return { name: 'templates', params: {} };
    return { name: 'store', params: {} };
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
  const STATUS_LABELS = { queued: '排队等待', pending: '排队中', running: '准备中', menuconfig: '配置中', compiling: '编译中', success: '成功', failed: '失败', cancelled: '已取消' };
  const ACTIVE_BUILD_STATUSES = ['queued', 'pending', 'running', 'menuconfig', 'compiling'];
  
  // 取消编译：列表页和触发页的实时进度卡片共用这一个处理函数
  async function cancelBuildWithConfirm(buildId, onDone) {
    if (!confirm('确认要取消这个编译任务吗？已经跑起来的 GitHub Actions 任务会一并取消。')) return;
    try {
      const res = await api.cancelBuild(buildId);
      if (res.github_cancel_warning) {
        // 这条提示文字较长，用 alert 而不是会自动消失的 toast，确保用户能看完
        alert(\`已在本系统标记为取消，但：\n\n\${res.github_cancel_warning}\`);
      } else {
        toast('已取消', 'success');
      }
      if (onDone) await onDone();
    } catch (e) {
      reportApiError(e, '取消失败');
    }
  }
  
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
        <button data-nav="#/store" class="\${activeName === 'store' ? 'active' : ''}">插件商店</button>
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
          <div class="sub">每个模板是一套保存好的机型和插件清单，找到它点「编译」即可</div>
        </div>
        <div class="actions">
          <button class="primary" id="new-tpl-btn">+ 新建模板</button>
        </div>
      </div>
      <div id="tpl-list-area"><div style="text-align:center;padding:40px;"><span class="spinner"></span></div></div>
    </div>\`;
    bindTopbar(app);
    qs(app, '#new-tpl-btn').addEventListener('click', () => navigate('#/store'));
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
        <div class="sub">点击右上角"新建模板"，在插件商店里选好机型和插件，或导入已有的模板文件</div>
      </div>\`;
      return;
    }
    area.innerHTML = \`<div class="template-grid">\${templates.map(templateRowHtml).join('')}</div>\`;
    qsa(area, '.template-row').forEach((row) => {
      row.addEventListener('click', (ev) => {
        const bb = ev.target.closest('[data-build]');
        if (bb) { buildFromList(bb.dataset.build, bb); return; }
        if (ev.target.closest('[data-stop]')) return;
        navigate(\`#/template/\${row.dataset.id}\`);
      });
    });
  }
  
  async function buildFromList(id, btn) {
    const t = (store.templates || []).find((x) => x.id === id);
    if (!confirm('编译「' + (t ? t.name : '') + '」？')) return;
    btn.disabled = true;
    try { await api.trigger({ template_id: id }); toast('已提交编译任务', 'success'); navigate('#/builds'); }
    catch (e) { reportApiError(e, '提交失败'); btn.disabled = false; }
  }

  function templateRowHtml(t) {
    const n = (t.selection && t.selection.length) ? t.selection.length : (t.plugins || []).length;
    const schedTag = t.schedule_enabled ? \`<span class="badge warn">定时 \${escapeHtml(t.schedule_cron || '')}</span>\` : \`<span class="badge dim">未定时</span>\`;
    const pinTag = t.pin_dotconfig_version_id ? \`<span class="badge dim">固定配置</span>\` : '';
    return \`
    <div class="template-row" data-id="\${t.id}">
      <div class="main">
        <div class="name">\${escapeHtml(t.name)}</div>
        <div class="meta">\${escapeHtml(t.target)}\${t.profile ? ' · ' + escapeHtml(t.profile) : ''} · \${escapeHtml(t.branch)} · \${n} 个插件</div>
      </div>
      <div class="tags">\${pinTag}\${schedTag}<button class="small primary" data-stop data-build="\${t.id}">编译</button></div>
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
  
  function openTemplateEditModal(tpl) {
    const overlay = openModal(\`
    <div class="modal-box">
      <div class="modal-head">
        <h3>名称与自定义脚本</h3>
        <button class="ghost small" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>模板名称</label>
          <input type="text" id="f-name" maxlength="80" value="\${escapeHtml(tpl.name || '')}" />
        </div>
        <div class="field">
          <label>自定义脚本 (feeds update 之前执行)</label>
          <textarea id="f-script1" rows="5" placeholder="#!/bin/bash">\${escapeHtml(tpl.diy_script_1 || '')}</textarea>
        </div>
        <div class="field">
          <label>自定义脚本② (feeds install 之后执行)</label>
          <textarea id="f-script2" rows="5" placeholder="#!/bin/bash">\${escapeHtml(tpl.diy_script_2 || '')}</textarea>
        </div>
        <div class="hint">机型和插件请点「编辑机型和插件」回到商店修改。</div>
      </div>
      <div class="modal-foot">
        <button data-close>取消</button>
        <button class="primary" id="save-tpl-btn">保存更改</button>
      </div>
    </div>\`, {
      onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        qs(root, '#save-tpl-btn').addEventListener('click', async () => {
          const body = { name: qs(root, '#f-name').value.trim(), diy_script_1: qs(root, '#f-script1').value, diy_script_2: qs(root, '#f-script2').value };
          if (!body.name) { toast('请填写模板名称', 'error'); return; }
          const btn = qs(root, '#save-tpl-btn');
          btn.disabled = true;
          try {
            await api.updateTemplate(tpl.id, body);
            toast('模板已更新', 'success');
            closeModal(root);
            refreshTemplateDetail(tpl.id);
          } catch (e) { reportApiError(e, '保存失败'); btn.disabled = false; }
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
  
  function tplConfigLines(tpl) {
    const NL = String.fromCharCode(10), lines = [], tp = String(tpl.target || '').split('/');
    if (tpl.profile && tp.length === 2) lines.push('CONFIG_TARGET_' + tp[0] + '=y', 'CONFIG_TARGET_' + tp[0] + '_' + tp[1] + '=y', 'CONFIG_TARGET_' + tp[0] + '_' + tp[1] + '_DEVICE_' + tpl.profile + '=y');
    (tpl.packages || []).forEach((p) => { lines.push('CONFIG_PACKAGE_' + p + '=y'); });
    return lines.join(NL);
  }
  async function tplEnsureCatalog() { if (!STORE.loaded) storeApplyCatalog(await api.get('/api/catalog')); }
  // 由插件选择重新算出包清单和第三方来源（移除插件后用）
  function tplCompose(ids, tpl) {
    const S = ids.map((id) => storeBy(id) || storeSynth(id, tpl.plugins)), pk = new Set();
    S.forEach((p) => { pk.add(p.id); (p.requires || []).forEach((r) => { pk.add(r); }); });
    return { selection: ids, packages: Array.from(pk), plugins: storeMergePlugins(S) };
  }

  function renderTemplateDetailBody(tpl, history) {
    const area = document.getElementById('detail-area');
    area.innerHTML = '<div class="page-head"><div><h1>' + escapeHtml(tpl.name) + '</h1><div class="sub mono">' + escapeHtml(tpl.repo_url) + ' @ ' + escapeHtml(tpl.branch) + ' · ' + escapeHtml(tpl.target) + (tpl.profile ? ' · ' + escapeHtml(tpl.profile) : '') + '</div></div>'
      + '<div class="actions"><button id="edit-tpl-btn">名称与脚本</button><button id="edit-store-btn">编辑机型和插件</button><button class="primary" id="build-btn">编译</button></div></div>'
      + '<div class="section"><h2><span>固件清单</span></h2><div id="manifest-area"></div></div>'
      + '<div class="section"><h2><span>编译选项</span></h2><div id="options-area"></div></div>'
      + '<div class="section"><h2><span>定时编译</span></h2><div id="schedule-area"></div></div>'
      + '<div class="section"><h2><span>.config 版本历史</span><span class="actions"><button class="small" id="export-tpl-btn">导出模板</button><button class="small" id="upload-cfg-btn">上传新版本</button></span></h2><div id="version-history-area"></div></div>'
      + '<div class="section"><h2><span>危险操作</span></h2><button class="danger" id="delete-tpl-btn">删除该模板</button></div>';

    qs(area, '#edit-tpl-btn').addEventListener('click', () => openTemplateEditModal(tpl));
    qs(area, '#edit-store-btn').addEventListener('click', () => navigate('#/store/' + tpl.id));
    qs(area, '#export-tpl-btn').addEventListener('click', () => exportTemplate(tpl));
    qs(area, '#upload-cfg-btn').addEventListener('click', () => openUploadConfigModal(tpl));
    qs(area, '#delete-tpl-btn').addEventListener('click', () => confirmDeleteTemplate(tpl));
    qs(area, '#build-btn').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = '提交中…';
      try { await api.trigger({ template_id: tpl.id }); toast('已提交编译任务', 'success'); navigate('#/builds'); }
      catch (e) { reportApiError(e, '提交失败'); btn.disabled = false; btn.textContent = '编译'; }
    });
    renderManifest(tpl);
    renderOptions(tpl, history);
    renderVersionHistory(tpl, history);
    renderScheduleSection(tpl, history);
  }

  async function renderManifest(tpl) {
    const wrap = document.getElementById('manifest-area');
    try { await tplEnsureCatalog(); } catch (e) { /* 目录读取失败时仍显示包名 */ }
    const ids = (tpl.selection && tpl.selection.length) ? tpl.selection : null;
    let h = '<div class="hint">机型：<b>' + (tpl.profile ? escapeHtml(tpl.profile) : '未选择') + '</b> · 平台 ' + escapeHtml(tpl.target) + '</div>';
    if (ids) {
      h += '<div class="hint" style="margin:8px 0 4px">已选插件 ' + ids.length + ' 个（共 ' + (tpl.packages || []).length + ' 个包，含自动依赖）。移除插件在这里直接点 ×，要添加请点右上角「编辑机型和插件」。</div><div class="chip-row">'
        + ids.map((id) => { const p = storeBy(id); return '<span class="chip">' + escapeHtml(p ? p.name : id) + (p && p.custom ? ' <small>自定义</small>' : '') + (!p ? ' <small>目录已无</small>' : '') + '<button data-rm-plugin="' + escapeHtml(id) + '" aria-label="移除">×</button></span>'; }).join('') + '</div>';
    } else if ((tpl.packages || []).length) {
      h += '<div class="hint" style="margin:8px 0 4px">这个模板是旧版本创建的，没有记录插件选择。点右上角「编辑机型和插件」重新选一次并保存，就能在这里管理。当前包清单（' + tpl.packages.length + ' 个）：</div><div class="hint mono" style="word-break:break-all">' + escapeHtml(tpl.packages.join(', ')) + '</div>';
    } else {
      h += '<div class="hint" style="margin:8px 0 4px">还没有插件清单。点右上角「编辑机型和插件」去选择。</div>';
    }
    if ((tpl.plugins || []).length) {
      h += '<div class="hint" style="margin:10px 0 4px">第三方插件来源（' + tpl.plugins.length + '）：</div>' + tpl.plugins.map((p) => '<div class="hint mono" style="margin-bottom:3px">' + escapeHtml(p.name) + ' — ' + escapeHtml(p.feed || p.git_url || '') + (p.sparse ? ' (子目录: ' + escapeHtml((p.dirs || []).join(', ')) + (p.branch ? ' @ ' + escapeHtml(p.branch) : '') + ')' : (p.branch ? ' @ ' + escapeHtml(p.branch) : '')) + '</div>').join('');
    }
    h += '<details style="margin-top:10px"><summary class="hint">查看将写入的配置行</summary><textarea readonly style="width:100%;height:140px;font:11.5px/1.5 monospace;margin-top:6px">' + escapeHtml(tplConfigLines(tpl)) + '</textarea><div class="hint">编译时，源码会先生成这个机型的默认配置，再合并这些行，并检查是否都生效；有没生效的会直接失败，并告诉你是哪几个。</div></details>';
    wrap.innerHTML = h;
    qsa(wrap, '[data-rm-plugin]').forEach((b) => b.addEventListener('click', async () => {
      const next = ids.filter((x) => x !== b.dataset.rmPlugin);
      try { await api.updateTemplate(tpl.id, tplCompose(next, tpl)); toast('已移除', 'success'); refreshTemplateDetail(tpl.id); }
      catch (e) { reportApiError(e, '移除失败'); }
    }));
  }

  function renderOptions(tpl, history) {
    const wrap = document.getElementById('options-area');
    const pin = tpl.pin_dotconfig_version_id || '';
    const opts = '<option value="">不固定（推荐）：每次按上面的清单重新生成</option>' + history.map((v) => {
      const label = (SOURCE_LABELS[v.source] || v.source) + ' ' + fmtTime(v.created_at) + (v.label ? ' "' + v.label + '"' : '');
      return '<option value="' + v.id + '"' + (v.id === pin ? ' selected' : '') + '>固定为：' + escapeHtml(label) + '</option>';
    }).join('');
    wrap.innerHTML = '<label class="st-opt"><input type="checkbox" id="opt-mc"' + (tpl.menuconfig ? ' checked' : '') + '><span>编译前进入 menuconfig 微调<small>默认不需要，仅在要改内核或驱动时开启。定时编译不会进入 menuconfig。</small></span></label>'
      + '<div class="field" style="margin:14px 0 0"><label>配置底稿</label><select id="opt-pin">' + opts + '</select>'
      + '<div class="hint">固定后，编译直接使用该版本，不再叠加上面的机型和插件清单。menuconfig 里保存的配置不会自动固定，要沿用它请在这里选择对应版本。手动编译和定时编译共用这个设置。</div></div>';
    qs(wrap, '#opt-mc').addEventListener('change', async (e) => {
      try { await api.updateTemplate(tpl.id, { menuconfig: e.target.checked }); toast(e.target.checked ? '编译时将进入 menuconfig' : '编译时不进入 menuconfig', 'success'); }
      catch (err) { reportApiError(err, '保存失败'); e.target.checked = !e.target.checked; }
    });
    qs(wrap, '#opt-pin').addEventListener('change', async (e) => {
      try { await api.updateTemplate(tpl.id, { pin_dotconfig_version_id: e.target.value }); toast(e.target.value ? '已固定配置底稿' : '已取消固定', 'success'); refreshTemplateDetail(tpl.id); }
      catch (err) { reportApiError(err, '保存失败'); }
    });
    renderCacheOptions(wrap, tpl);
  }

  function renderCacheOptions(wrap, tpl) {
    const box = el('<div class="field" style="margin:14px 0 0"><label>编译缓存（ccache）</label>'
      + '<select id="opt-cache-use"><option value="">不使用缓存</option><option value="latest">使用同平台最新的缓存</option></select>'
      + '<label class="st-opt" style="margin-top:10px"><input type="checkbox" id="opt-cache-pub"' + (tpl.cache_publish ? ' checked' : '') + '><span>编译完成后发布缓存<small>把这次编译的 ccache 打包发布到编译仓库的 Release，下次编译可以选择使用。最多保留最新 2 份，体积以实际为准（一般不超过 2 GB）。</small></span></label>'
      + '<div class="hint">缓存只能加速重复的编译，机型或插件变化大时命中会变少；第一次发布缓存的那次编译不会更快，还会多花几分钟打包上传。缓存存放在你编译仓库的 Release 里，仓库是公开的话任何人都能下载。缓存只存在于编译机上，所以必须在编译开始前勾选，或在编译进行中点构建记录上的「完成后发布缓存」。</div></div>');
    wrap.appendChild(box);
    const sel = qs(box, '#opt-cache-use');
    sel.value = (tpl.cache_use === 'latest') ? 'latest' : '';
    api.listCaches().then(({ caches }) => {
      (caches || []).forEach((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = '指定：' + fmtTime(c.cache_at) + ' · ' + (c.template_name || '已删除的模板') + ' · ' + c.target + ' · ' + fmtCacheSize(c.cache_size);
        sel.appendChild(o);
      });
      if (tpl.cache_use && tpl.cache_use !== 'latest') {
        if (!(caches || []).some((c) => c.id === tpl.cache_use)) {
          const o = document.createElement('option');
          o.value = tpl.cache_use; o.textContent = '指定的缓存已被清理（编译时不使用缓存）';
          sel.appendChild(o);
        }
        sel.value = tpl.cache_use;
      }
    }).catch(() => {});
    sel.addEventListener('change', async (e) => {
      try { await api.updateTemplate(tpl.id, { cache_use: e.target.value }); toast(e.target.value ? '下次编译将使用缓存' : '下次编译不使用缓存', 'success'); }
      catch (err) { reportApiError(err, '保存失败'); }
    });
    qs(box, '#opt-cache-pub').addEventListener('change', async (e) => {
      try { await api.updateTemplate(tpl.id, { cache_publish: e.target.checked }); toast(e.target.checked ? '编译完成后将发布缓存' : '编译完成后不发布缓存', 'success'); }
      catch (err) { reportApiError(err, '保存失败'); e.target.checked = !e.target.checked; }
    });
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
      const isSched = tpl.pin_dotconfig_version_id === v.id;
      const refTags = \`\${isCurrent ? '<span class="ref-tag">当前</span>' : ''}\${isSched ? '<span class="ref-tag sched">固定</span>' : ''}\`;
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
            \${isSched ? '<button class="small" data-unpin>取消固定</button>' : '<button class="small" data-set-sched>固定为底稿</button>'}
            <button class="ghost small danger" data-delete \${canDelete ? '' : 'disabled title="请先切换或取消引用再删除"'}>删除</button>
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
        try { await api.updateTemplate(tpl.id, { pin_dotconfig_version_id: vid }); toast('已固定为配置底稿', 'success'); refreshTemplateDetail(tpl.id); } catch (e) { reportApiError(e, '设置失败'); }
      });
      const unpinBtn = qs(row, '[data-unpin]');
      if (unpinBtn) unpinBtn.addEventListener('click', async () => {
        try { await api.updateTemplate(tpl.id, { pin_dotconfig_version_id: '' }); toast('已取消固定', 'success'); refreshTemplateDetail(tpl.id); } catch (e) { reportApiError(e, '设置失败'); }
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
  
  function fmtCacheSize(n) {
    n = Number(n) || 0;
    return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB';
  }
  
  function renderCacheNote(b) {
    let h = '';
    if (b.cache_from) h += '<span class="badge dim">使用缓存</span>';
    if (b.cache_tag) h += '<span class="badge dim">已发布缓存 ' + fmtCacheSize(b.cache_size) + '</span>';
    if (ACTIVE_BUILD_STATUSES.includes(b.status) && b.use_ccache) {
      h += '<button class="ghost small cache-pub-btn" data-on="' + (b.cache_publish ? '1' : '0') + '" title="缓存只存在于编译机上，必须在编译结束前设置">' + (b.cache_publish ? '✓ 完成后发布缓存（点击取消）' : '完成后发布缓存') + '</button>';
    }
    return h;
  }
  
  function renderBuildNote(b) {
    const failed = b.status === 'failed';
    let html = '';
    if (failed && b.fail_reason) html += '<div class="hint" style="width:100%;color:var(--bad);">失败原因：' + escapeHtml(b.fail_reason) + '</div>';
    const detail = [failed ? '' : b.fail_reason, b.log_tail].filter(Boolean).join('\\n');
    if (detail) html += '<details style="width:100%"><summary class="hint">' + (failed ? '失败详情和处理建议' : '构建说明') + '</summary><pre class="fail-log">' + escapeHtml(detail) + '</pre></details>';
    return html;
  }
  
  async function viewBuildConfig(buildId, kind) {
    const title = kind === 'result' ? '最终配置（menuconfig 保存退出时推送的内容）' : '触发时的配置底稿（固定版本的内容）';
    return openModal('<div class="modal-box" style="max-width:700px;"><div class="modal-head"><h3>' + title + '</h3><button class="ghost small" data-close>✕</button></div><div class="modal-body"><div class="code-view" id="cfg-view">加载中...</div></div><div class="modal-foot"><button data-close>关闭</button></div></div>', {
      async onMount(root) {
        qsa(root, '[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(root)));
        try {
          const { build } = await api.getBuild(buildId);
          const text = kind === 'result' ? build.dotconfig_result : build.dotconfig_snapshot;
          qs(root, '#cfg-view').textContent = text || '（没有记录）';
        } catch (e) { qs(root, '#cfg-view').textContent = '加载失败：' + e.message; }
      }
    });
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
    const pinned = !!tpl.pin_dotconfig_version_id;
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
      <div class="hint">\${pinned ? '当前固定了配置底稿，定时编译直接使用该版本。' : '当前没有固定配置底稿，每次定时编译都会按上面的机型和插件清单重新生成配置。'}可在上面的「编译选项」里修改。</div>
      <div>
        <button class="primary" id="save-sched-btn">保存定时设置</button>
      </div>
    </div>\`;
    qsa(wrap, '[data-cron]').forEach((b) => { b.addEventListener('click', () => { qs(wrap, '#sched-cron').value = b.dataset.cron; }); });
    qs(wrap, '#save-sched-btn').addEventListener('click', async () => {
      const enabledNow = qs(wrap, '#sched-enabled').checked;
      const cron = qs(wrap, '#sched-cron').value.trim();
      if (enabledNow && !cron) { toast('请填写 cron 表达式', 'error'); return; }
      const btn = qs(wrap, '#save-sched-btn');
      btn.disabled = true;
      try {
        await api.setSchedule(tpl.id, { enabled: enabledNow, cron: cron || null });
        toast('定时设置已保存', 'success');
        refreshTemplateDetail(tpl.id);
      } catch (e) { reportApiError(e, '保存失败'); btn.disabled = false; }
    });
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
    <div class="build-row" data-build-id="\${escapeHtml(b.id)}">
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
        \${renderCacheNote(b)}
        \${renderBuildNote(b)}
        \${b.has_snapshot ? '<button class="ghost small view-cfg-btn" data-kind="snapshot">查看底稿</button>' : ''}
        \${b.has_result ? '<button class="ghost small view-cfg-btn" data-kind="result">查看最终配置</button>' : ''}
        \${ACTIVE_BUILD_STATUSES.includes(b.status) ? \`<button class="ghost small cancel-build-btn" style="color:var(--bad);margin-left:auto;">取消编译</button>\` : ''}
      </div>
    </div>\`).join('');
    qsa(area, '.cache-pub-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const buildId = btn.closest('[data-build-id]')?.dataset.buildId;
        if (!buildId) return;
        btn.disabled = true;
        try { await api.setCachePublish(buildId, btn.dataset.on !== '1'); toast(btn.dataset.on === '1' ? '已取消发布缓存' : '编译完成后将发布缓存', 'success'); loadBuildsList(); }
        catch (e) { reportApiError(e, '设置失败'); btn.disabled = false; }
      });
    });
    qsa(area, '.view-cfg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const buildId = btn.closest('[data-build-id]')?.dataset.buildId;
        if (buildId) viewBuildConfig(buildId, btn.dataset.kind);
      });
    });
    qsa(area, '.cancel-build-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const buildId = btn.closest('[data-build-id]')?.dataset.buildId;
        if (!buildId) return;
        cancelBuildWithConfirm(buildId, loadBuildsList);
      });
    });
  }
  
  const STORE = { loaded: false, catalog: [], projects: [], plat: { status: 'none', list: [], err: '', fetched: '' }, cur: { id: '', subs: [], status: 'none', err: '', fetched: '' }, sel: new Set(['luci-app-store']), cat: '全部', q: '', pi: 0, target: 'x86', sub: '64', profile: 'generic', devQ: '', editId: null, tplName: '', nameDirty: false, stale: [], busy: false, limit: 48, only: false, cats: ['全部'], kw: {}, meta: '', refresh: false, seq: 0 };
  const STORE_PRESETS = { '旁路由': ['luci-app-store', 'luci-app-passwall', 'luci-app-smartdns', 'luci-app-ttyd'], '家庭全能': ['luci-app-store', 'luci-app-openclash', 'luci-app-adblock-fast', 'luci-app-samba4', 'luci-app-qbittorrent', 'luci-app-ddns-go', 'luci-app-upnp', 'luci-theme-argon'], '极简': ['luci-app-store'] };
  const STORE_TARGET_RE = new RegExp('^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*/[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$');
  const STORE_PROFILE_RE = new RegExp('^[A-Za-z0-9_.+-]+$');
  function storeHue(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  function storeOrigin(p) {
    const o = p.origin || { type: 'builtin' };
    if (o.type === 'git') return { name: o.name, git_url: o.url, sparse: !!o.sparse, branch: o.branch || '', dirs: o.dirs || [] };
    if (o.type === 'feed') return { name: o.name, feed: o.line };
    return null;
  }
  function storeBy(id) { return STORE.catalog.find(function (p) { return p.id === id; }); }
  function storeSelected() { return Array.from(STORE.sel).map(storeBy).filter(Boolean); }
  function storeToggle(id) { if (STORE.sel.has(id)) STORE.sel.delete(id); else STORE.sel.add(id); storeDrawGrid(); storeDrawBasket(); }
  function storeProject() { return STORE.projects[STORE.pi] || STORE.projects[0]; }
  function storeTargetStr() { return STORE.target && STORE.sub ? STORE.target + '/' + STORE.sub : ''; }
  function storeSubs() { return STORE.cur.id === STORE.target ? STORE.cur.subs : []; }
  function storeCurSub() { return storeSubs().find(function (x) { return x.id === STORE.sub; }); }
  function storeDevices() { const x = storeCurSub(); return x ? x.devices : []; }
  function storeErr(e) { return (e && e.message) ? e.message : '读取失败'; }
  function storeOpt(v, label, sel) { return '<option value="' + escapeHtml(v) + '"' + (sel ? ' selected' : '') + '>' + escapeHtml(label) + '</option>'; }

  // 应用插件目录。编辑模板时，目录里已经没有的插件会作为「目录已无」条目保留，避免保存时被悄悄丢掉
  function storeApplyCatalog(d) {
    STORE.catalog = d.plugins.filter(function (p) { return !p.hidden; });
    STORE.kw = {}; d.categories.forEach(function (c) { STORE.kw[c.id] = c.keywords || ''; });
    STORE.cats = ['全部'].concat(d.categories.slice().sort(function (a, b) { return a.order - b.order; }).map(function (c) { return c.id; }).filter(function (c) { return STORE.catalog.some(function (p) { return p.cat === c; }); }));
    STORE.stale.forEach(function (p) { if (!storeBy(p.id)) STORE.catalog.push(p); if (STORE.cats.indexOf(p.cat) < 0) STORE.cats.push(p.cat); });
    STORE.meta = '目录更新于 ' + (d.updated || '未知') + '，' + (d.source === 'remote' ? '来自你的仓库 catalog.json' : '使用内置目录');
    STORE.loaded = true;
  }
  async function storeReloadCatalog() { storeApplyCatalog(await api.get('/api/catalog')); }

  function storeReset() {
    STORE.sel = new Set(['luci-app-store']); STORE.target = 'x86'; STORE.sub = '64'; STORE.profile = 'generic'; STORE.devQ = '';
    STORE.editId = null; STORE.tplName = ''; STORE.nameDirty = false; STORE.stale = [];
    STORE.q = ''; STORE.cat = '全部'; STORE.only = false; STORE.limit = 48;
  }

  function storeSynth(id, plugins) {
    let origin = { type: 'builtin' };
    (plugins || []).forEach(function (p) {
      if (p.feed) return;
      if (p.sparse && (p.dirs || []).some(function (d) { return d.split('/').pop() === id; })) origin = { type: 'git', name: id, url: p.git_url, branch: p.branch || '', sparse: true, dirs: (p.dirs || []).filter(function (d) { return d.split('/').pop() === id; }) };
      else if (!p.sparse && p.name === id) origin = { type: 'git', name: id, url: p.git_url, branch: p.branch || '', sparse: false, dirs: [] };
    });
    return { id: id, name: id, desc: origin.type === 'builtin' ? '插件目录里已经没有这一项，仍会按包名尝试启用。' : '模板里保存的第三方插件，不在当前目录里。', desc_en: '', cat: '自定义', kind: 'app', origin: origin, deps: [], requires: [], size_mb: null, rec: false, tut: '', tags: [], hidden: false, custom: origin.type !== 'builtin', stale: true };
  }

  // 编辑模板：把模板里保存的源码、平台、机型、插件选择回填到商店
  async function storeEnterEdit(id) {
    const t = (await api.getTemplate(id)).template;
    storeReset();
    STORE.editId = t.id; STORE.tplName = t.name; STORE.nameDirty = true;
    let i = STORE.projects.findIndex(function (p) { return t.project_id && p.id === t.project_id; });
    if (i < 0) i = STORE.projects.findIndex(function (p) { return p.repo_url === t.repo_url && p.branch === t.branch; });
    if (i < 0) {
      toast('这个模板用的源码项目已不在列表里，请重新选择源码、平台和机型', 'error');
      STORE.target = ''; STORE.sub = ''; STORE.profile = '';
    } else {
      STORE.pi = i;
      const tp = String(t.target || '').split('/');
      STORE.target = tp[0] || ''; STORE.sub = tp[1] || ''; STORE.profile = t.profile || '';
    }
    const ids = (t.selection && t.selection.length) ? t.selection : (t.packages || []).filter(function (x) { return !!storeBy(x); });
    STORE.sel = new Set(ids);
    STORE.stale = [];
    ids.forEach(function (x) { if (!storeBy(x)) { const p = storeSynth(x, t.plugins); STORE.stale.push(p); STORE.catalog.push(p); if (STORE.cats.indexOf(p.cat) < 0) STORE.cats.push(p.cat); } });
  }

  async function storeLoadProjects() {
    const pj = await api.get('/api/projects');
    STORE.projects = pj.projects;
    if (STORE.pi >= STORE.projects.length) STORE.pi = 0;
  }

  // 平台列表：Worker 实时从源码仓库的 target/linux 读取
  async function storeLoadPlatforms(force) {
    const p = storeProject(), seq = ++STORE.seq;
    STORE.plat = { status: 'loading', list: [], err: '', fetched: '' };
    STORE.cur = { id: '', subs: [], status: 'none', err: '', fetched: '' };
    storeDrawSelects(); storeDrawHint();
    try {
      const d = await api.get('/api/platforms?project=' + encodeURIComponent(p.id) + (force ? '&refresh=1' : ''));
      if (seq !== STORE.seq) return;
      STORE.plat = { status: 'ready', list: d.platforms, err: '', fetched: d.fetched_at || '' };
    } catch (e) {
      if (seq !== STORE.seq) return;
      STORE.plat = { status: 'error', list: [], err: storeErr(e), fetched: '' };
    }
    if (STORE.plat.status === 'ready' && !STORE.plat.list.some(function (x) { return x.id === STORE.target; })) { STORE.target = ''; STORE.sub = ''; STORE.profile = ''; }
    storeDrawSelects(); storeDrawHint(); storeDrawBasket();
    if (STORE.plat.status === 'ready' && STORE.target) storeLoadPlatform(STORE.target, force);
  }

  // 单个平台：子平台和机型（解析该平台 image 目录下的 *.mk）
  async function storeLoadPlatform(t, force) {
    const p = storeProject(), seq = ++STORE.seq;
    STORE.cur = { id: t, subs: [], status: 'loading', err: '', fetched: '' };
    storeDrawSelects(); storeDrawHint();
    try {
      const d = await api.get('/api/platform?project=' + encodeURIComponent(p.id) + '&target=' + encodeURIComponent(t) + (force ? '&refresh=1' : ''));
      if (seq !== STORE.seq) return;
      STORE.cur = { id: t, subs: d.subtargets, status: 'ready', err: '', fetched: d.fetched_at || '' };
      if (!STORE.sub) {
        const pick = d.subtargets.find(function (x) { return x.id === '64'; }) || d.subtargets[0];
        STORE.sub = pick.id; STORE.profile = '';
        const g = pick.devices.find(function (x) { return x.id === 'generic'; });
        if (g) STORE.profile = g.id;
      } else if (!storeCurSub()) {
        toast('原来的子平台 ' + STORE.sub + ' 在当前源码里找不到，请重新选择子平台和机型', 'error');
        STORE.sub = ''; STORE.profile = '';
      }
    } catch (e) {
      if (seq !== STORE.seq) return;
      STORE.cur = { id: t, subs: [], status: 'error', err: storeErr(e), fetched: '' };
    }
    storeDrawSelects(); storeDrawHint(); storeDrawBasket();
  }

  // 平台 / 子平台 / 机型只能从下拉框里选；机型很多，旁边的输入框只用来筛选选项
  function storeDrawSelects() {
    const a = document.getElementById('st-tgt'), b = document.getElementById('st-sub'), c = document.getElementById('st-dev');
    if (!a || !b || !c) return;
    let h;
    if (STORE.plat.status === 'loading') h = storeOpt('', '读取平台中…', true);
    else if (STORE.plat.status === 'error') h = storeOpt('', '读取失败，请点下方重试', true);
    else h = storeOpt('', '— 请选择平台 —', !STORE.target) + STORE.plat.list.map(function (t) { return storeOpt(t.id, t.id, t.id === STORE.target); }).join('');
    a.innerHTML = h; a.disabled = STORE.plat.status !== 'ready';
    const subs = storeSubs();
    if (STORE.cur.status === 'loading') h = storeOpt('', '读取机型中…', true);
    else if (!subs.length) h = storeOpt('', STORE.target ? '（没有可选项）' : '— 先选平台 —', true);
    else h = storeOpt('', '— 请选择子平台 —', !STORE.sub) + subs.map(function (x) { return storeOpt(x.id, x.id + (x.name && x.name !== x.id ? ' · ' + x.name : '') + (x.arch ? ' · ' + x.arch : ''), x.id === STORE.sub); }).join('');
    b.innerHTML = h; b.disabled = !subs.length;
    const devs = storeDevices(), q = (STORE.devQ || '').trim().toLowerCase();
    const shown = devs.filter(function (d) { return !q || d.id === STORE.profile || (d.name + ' ' + d.id + ' ' + (d.alt || []).join(' ')).toLowerCase().indexOf(q) >= 0; });
    if (!devs.length) h = storeOpt('', STORE.sub ? '（没有可选机型）' : '— 先选子平台 —', true);
    else {
      h = storeOpt('', '— 请选择机型（共 ' + devs.length + ' 个' + (q ? '，筛出 ' + shown.length + ' 个' : '') + '）—', !STORE.profile);
      if (STORE.profile && !devs.some(function (d) { return d.id === STORE.profile; })) h += storeOpt(STORE.profile, STORE.profile + '（不在源码机型列表里）', true);
      h += shown.map(function (d) { return storeOpt(d.id, d.name + (d.name !== d.id ? '  ·  ' + d.id : ''), d.id === STORE.profile); }).join('');
    }
    c.innerHTML = h; c.disabled = !devs.length;
    const q2 = document.getElementById('st-devq'); if (q2) q2.disabled = !devs.length;
  }
  function storeSyncInputs() { storeDrawSelects(); }

  function storeDrawHint() {
    const el = document.getElementById('st-devhint'); if (!el) return;
    const p = storeProject(), btn = ' <button class="ghost small" id="st-devrefresh">';
    if (STORE.plat.status === 'loading') { el.textContent = '正在从源码仓库读取平台列表…'; return; }
    if (STORE.plat.status === 'error') { el.innerHTML = escapeHtml('读取失败：' + STORE.plat.err + '。读取成功后才能选择平台和机型。') + btn + '重试</button>'; return; }
    if (STORE.cur.status === 'loading') { el.textContent = '正在读取 ' + STORE.cur.id + ' 的机型（实时解析源码，首次约几秒）…'; return; }
    if (STORE.cur.status === 'error') { el.innerHTML = escapeHtml('读取 ' + STORE.cur.id + ' 失败：' + STORE.cur.err) + btn + '重试</button>'; return; }
    if (STORE.plat.status === 'ready') el.innerHTML = escapeHtml('平台和机型由 Worker 实时读取自 ' + p.repo_url.replace('https://github.com/', '') + ' @ ' + p.branch + '，结果缓存 7 天' + (STORE.cur.fetched ? '（' + STORE.cur.fetched + '）' : '')) + btn + '刷新</button>';
  }

  // 自定义插件：填仓库地址 → 识别 → 添加后和目录里的插件一起出现在商店
  function storeCustomPluginModal() {
    function listHtml() {
      const c = STORE.catalog.filter(function (p) { return p.custom && !p.stale; });
      return c.length ? c.map(function (p) {
        const o = p.origin || {};
        return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)"><div style="flex:1;min-width:0"><b>' + escapeHtml(p.name) + '</b> <code class="hint">' + escapeHtml(p.id) + '</code><div class="hint" style="word-break:break-all">' + escapeHtml((o.url || '') + (o.sparse && o.dirs ? ' · ' + o.dirs.join(', ') : '')) + '</div></div><button class="ghost small" data-cpdel="' + escapeHtml(p.id) + '">删除</button></div>';
      }).join('') : '<div class="hint">还没有自定义插件</div>';
    }
    const m = el('<div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:50;padding:16px"><div style="background:var(--panel);border-radius:14px;padding:20px;width:min(560px,94vw);max-height:90vh;overflow:auto"><h2 style="margin:0 0 4px">添加 / 管理自定义插件</h2>'
      + '<div class="hint">填写插件源码的 GitHub 仓库地址，识别后添加到商店，勾选即可使用。整个仓库是一个包，或仓库里有多个包，都可以。</div>'
      + '<div class="st-warn" style="margin-top:8px">编译时会运行这个仓库里的代码，请只添加你信任的仓库。</div>'
      + '<h3 style="margin:14px 0 4px;font-size:14px">已添加的自定义插件（可删除）</h3><div id="cp-list">' + listHtml() + '</div>'
      + '<h3 style="margin:16px 0 0;font-size:14px">添加新的</h3>'
      + '<label style="display:block;margin-top:8px">仓库地址<input id="cp-url" placeholder="https://github.com/用户/仓库" style="width:100%"></label>'
      + '<label style="display:block;margin-top:8px">分支（留空使用默认分支）<input id="cp-branch" style="width:100%"></label>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="primary" id="cp-detect">识别</button></div>'
      + '<div id="cp-res" style="margin-top:10px"></div>'
      + '<div style="text-align:right;margin-top:14px"><button class="ghost" id="cp-close">关闭</button></div></div></div>');
    document.body.appendChild(m);
    const res = m.querySelector('#cp-res');
    let det = null;
    function manualForm(note) {
      res.innerHTML = (note ? '<div class="hint">' + escapeHtml(note) + '</div>' : '')
        + '<label style="display:block;margin-top:8px">包名（CONFIG_PACKAGE_ 后面的名字，如 luci-app-xxx）<input id="cp-id" style="width:100%"></label>'
        + '<label style="display:block;margin-top:8px">显示名称（可选）<input id="cp-name" style="width:100%"></label>'
        + '<label style="display:block;margin-top:8px">简介（可选）<input id="cp-desc" style="width:100%"></label>'
        + '<label style="display:block;margin-top:8px">额外需要的包（可选，逗号分隔，例如 video-support）<input id="cp-req" style="width:100%"></label>'
        + '<div style="text-align:right;margin-top:10px"><button class="primary" id="cp-add-one">添加</button></div>';
    }
    async function after(r) {
      await storeReloadCatalog();
      (r.plugins || []).forEach(function (p) { STORE.sel.add(p.id); });
      STORE.cat = '自定义'; STORE.only = false; STORE.q = ''; STORE.limit = 48;
      const qi = document.getElementById('st-q'); if (qi) qi.value = '';
      storeDrawGrid(); storeDrawBasket();
      m.querySelector('#cp-list').innerHTML = listHtml();
      res.innerHTML = '';
      toast('已添加 ' + (r.plugins || []).length + ' 个，并已加入已选', 'success');
    }
    m.querySelector('#cp-close').onclick = function () { m.remove(); };
    m.querySelector('#cp-detect').onclick = async function () {
      const url = m.querySelector('#cp-url').value.trim(), br = m.querySelector('#cp-branch').value.trim();
      if (!url) { toast('请填写仓库地址', 'error'); return; }
      res.innerHTML = '<div class="hint">正在识别…</div>';
      try {
        det = await api.post('/api/custom-plugins/detect', { repo_url: url, branch: br });
        if (!det.detected) { manualForm(det.reason); return; }
        if (det.root) {
          manualForm('识别为单个插件包（包名读自仓库根目录的 Makefile，可以改）。');
          m.querySelector('#cp-id').value = det.pkg_name;
          m.querySelector('#cp-req').value = (det.requires || []).join(', ');
        } else if (det.candidates.length) {
          res.innerHTML = '<div class="hint">这个仓库里有多个包，勾选要添加的（共 ' + det.candidates.length + ' 个' + (det.truncated ? '，仓库太大，列表可能不完整' : '') + '）：</div>'
            + '<input id="cp-filter" type="search" placeholder="筛选" style="width:100%;margin:6px 0">'
            + '<div id="cp-cands" style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:4px 8px">'
            + det.candidates.map(function (c) { const base = c.path.split('/').pop(); return '<label class="cp-cand" style="display:flex;gap:8px;padding:3px 0;font-size:13px"><input type="checkbox" data-path="' + escapeHtml(c.path) + '" style="width:auto"><span>' + escapeHtml(c.path) + (c.id !== base ? ' <b>→ 包名 ' + escapeHtml(c.id) + '</b>' : '') + ((c.requires || []).length ? ' <small>（同时包含 ' + escapeHtml(c.requires.join(', ')) + '）</small>' : '') + '</span></label>'; }).join('') + '</div>'
            + '<label style="display:block;margin-top:8px">所选插件都额外需要的包（可选，逗号分隔）<input id="cp-req-dirs" placeholder="例如 video-support" style="width:100%"></label>'
            + '<div class="hint">有的源码对某些包有额外要求（比如依赖 ffmpeg 的包要先启用 video-support），否则编译前校验会提示该包没生效，并告诉你该填什么。</div>'
            + '<div style="text-align:right;margin-top:10px"><button class="primary" id="cp-add-dirs">添加所选</button></div>';
          m.querySelector('#cp-filter').oninput = function (e) {
            const q = e.target.value.trim().toLowerCase();
            Array.prototype.forEach.call(m.querySelectorAll('.cp-cand'), function (l) { l.style.display = (!q || l.textContent.toLowerCase().indexOf(q) >= 0) ? 'flex' : 'none'; });
          };
        } else {
          manualForm('没有在仓库里找到 Makefile，它可能不是 OpenWrt 软件包仓库。如果确定是，可以手动填写包名。');
        }
      } catch (e) { res.innerHTML = ''; reportApiError(e, '识别失败'); }
    };
    m.addEventListener('click', async function (e) {
      const b = e.target; if (!b || !b.id && !(b.dataset && b.dataset.cpdel)) return;
      const url = m.querySelector('#cp-url').value.trim(), br = (det && det.branch) || m.querySelector('#cp-branch').value.trim();
      try {
        if (b.id === 'cp-add-one') {
          const body = { repo_url: url, branch: br, id: m.querySelector('#cp-id').value.trim(), name: m.querySelector('#cp-name').value.trim(), desc: m.querySelector('#cp-desc').value.trim(), requires: m.querySelector('#cp-req').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean) };
          await after(await api.post('/api/custom-plugins', body));
        } else if (b.id === 'cp-add-dirs') {
          const dirs = Array.prototype.map.call(m.querySelectorAll('#cp-cands input:checked'), function (x) { const c = det.candidates.find(function (y) { return y.path === x.dataset.path; }); return { path: x.dataset.path, id: c ? c.id : '', requires: c ? c.requires : [] }; });
          if (!dirs.length) { toast('请先勾选要添加的包', 'error'); return; }
          const rq = m.querySelector('#cp-req-dirs').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
          await after(await api.post('/api/custom-plugins', { repo_url: url, branch: br, dirs: dirs, requires: rq }));
        } else if (b.dataset && b.dataset.cpdel) {
          await api.del('/api/custom-plugins/' + encodeURIComponent(b.dataset.cpdel));
          STORE.sel.delete(b.dataset.cpdel);
          await storeReloadCatalog(); storeDrawGrid(); storeDrawBasket();
          m.querySelector('#cp-list').innerHTML = listHtml();
        }
      } catch (err) { reportApiError(err, '操作失败'); }
    });
  }

  async function renderStorePage(tplId) {
    const app = document.getElementById('app');
    app.innerHTML = '<div id="toast-wrap" class="toast-wrap"></div>' + renderTopbar('store') + '<div class="content"><div id="store-area"><div class="hint">加载中…</div></div></div>';
    bindTopbar(app);
    try {
      if (!STORE.loaded) {
        storeApplyCatalog(await api.get('/api/catalog' + (STORE.refresh ? '?refresh=1' : '')));
        STORE.refresh = false;
      }
      await storeLoadProjects();
      if (tplId) { if (STORE.editId !== tplId) await storeEnterEdit(tplId); }
      else if (STORE.editId) storeReset();
    } catch (e) {
      reportApiError(e, '加载失败');
      if (tplId) navigate('#/templates');
      return;
    }
    const editing = !!STORE.editId;
    const area = document.getElementById('store-area');
    area.innerHTML = (editing ? '<div class="detail-back"><button class="ghost small" id="st-back">‹ 返回模板</button></div>' : '')
      + '<div class="page-head"><div><h1>' + (editing ? '编辑模板的机型和插件' : '插件商店') + '</h1><div class="hint">' + (editing ? '改完点右侧「保存到模板」，回到模板页再确认和编译。' : '选好设备和插件，点「生成模板」，到模板页确认无误后再编译。') + '</div><div class="hint">' + escapeHtml(STORE.meta) + ' <button class="ghost small" id="st-refresh">刷新目录</button></div></div></div>'
      + '<div class="st-bar"><div class="st-field"><label>项目（源码）<select id="st-src"></select></label></div>'
      + '<div class="st-field"><label>平台<select id="st-tgt"></select></label></div>'
      + '<div class="st-field"><label>子平台<select id="st-sub"></select></label></div>'
      + '<div class="st-field"><label>机型<select id="st-dev"></select></label><input id="st-devq" type="search" autocomplete="off" placeholder="筛选机型，如 RAX3000M" style="margin-top:6px"><div class="hint" id="st-profhint"></div></div></div>'
      + '<div class="hint" id="st-devhint" style="margin:-8px 0 14px"></div>'
      + '<div class="st-layout"><div><div class="st-presets">一键方案：' + Object.keys(STORE_PRESETS).map(function (k) { return '<button class="ghost small" data-preset="' + k + '">' + k + '</button>'; }).join('') + '</div>'
      + '<div class="st-tools"><input id="st-q" type="search" placeholder="搜索插件，如 广告、下载、代理" value="' + escapeHtml(STORE.q) + '"><button class="ghost" id="st-addcp">＋ 添加 / 管理自定义插件</button></div>'
      + '<div class="st-chips" id="st-chips"></div><div class="st-grid" id="st-grid"></div><div style="text-align:center;margin:14px" id="st-more"></div></div><aside class="st-basket" id="st-basket"></aside></div>';
    storeDrawProjects();
    document.getElementById('st-src').onchange = function (e) {
      if (e.target.value === 'new') { e.target.value = String(STORE.pi); storeProjectModal(); return; }
      STORE.pi = +e.target.value; storeLoadPlatforms(false);
    };
    document.getElementById('st-tgt').onchange = function (e) {
      STORE.target = e.target.value; STORE.sub = ''; STORE.profile = ''; STORE.devQ = '';
      const q = document.getElementById('st-devq'); if (q) q.value = '';
      if (STORE.target) storeLoadPlatform(STORE.target, false);
      else { STORE.cur = { id: '', subs: [], status: 'none', err: '', fetched: '' }; storeDrawSelects(); storeDrawHint(); storeDrawBasket(); }
    };
    document.getElementById('st-sub').onchange = function (e) {
      STORE.sub = e.target.value; STORE.profile = ''; STORE.devQ = '';
      const q = document.getElementById('st-devq'); if (q) q.value = '';
      storeDrawSelects(); storeDrawBasket();
    };
    document.getElementById('st-dev').onchange = function (e) { STORE.profile = e.target.value; storeDrawSelects(); storeDrawBasket(); };
    document.getElementById('st-devq').oninput = function (e) { STORE.devQ = e.target.value; storeDrawSelects(); };
    document.getElementById('st-q').oninput = function (e) { STORE.q = e.target.value.trim().toLowerCase(); STORE.limit = 48; storeDrawGrid(); };
    area.addEventListener('click', function (e) {
      const t = e.target;
      if (t.dataset.preset) { STORE.sel = new Set(STORE_PRESETS[t.dataset.preset].filter(function (id) { return !!storeBy(id); })); storeDrawGrid(); storeDrawBasket(); return; }
      if (t.dataset.cat) { STORE.cat = t.dataset.cat; STORE.limit = 48; STORE.only = false; storeDrawGrid(); return; }
      if (t.dataset.only) { STORE.only = !STORE.only; STORE.limit = 48; storeDrawGrid(); return; }
      if (t.dataset.more) { STORE.limit += 48; storeDrawGrid(); return; }
      if (t.dataset.rm) { storeToggle(t.dataset.rm); return; }
      if (t.dataset.add) { storeToggle(t.dataset.add); return; }
      if (t.id === 'st-devrefresh') { storeLoadPlatforms(true); return; }
      if (t.id === 'st-refresh') { STORE.loaded = false; STORE.refresh = true; renderStorePage(tplId); return; }
      if (t.id === 'st-addcp') { storeCustomPluginModal(); return; }
      if (t.id === 'st-back') { storeReset(); navigate('#/template/' + tplId); return; }
      if (t.id === 'st-go') { storeSave(); return; }
      const c = t.closest ? t.closest('.st-card') : null;
      if (c) storeDetail(c.dataset.id);
    });
    storeDrawSelects(); storeDrawHint(); storeDrawGrid(); storeDrawBasket();
    storeLoadPlatforms(false);
  }

  function storeDrawProjects() {
    const sel = document.getElementById('st-src'); if (!sel) return;
    sel.innerHTML = STORE.projects.map(function (p, i) { return '<option value="' + i + '"' + (i === STORE.pi ? ' selected' : '') + '>' + escapeHtml((p.builtin ? '' : '★ ') + p.name) + '</option>'; }).join('') + '<option value="new">＋ 添加 / 管理自定义项目…</option>';
  }

  function storeProjectModal() {
    function rows() {
      const c = STORE.projects.filter(function (p) { return !p.builtin; });
      return c.length ? c.map(function (p) { return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)"><div style="flex:1;min-width:0"><b>' + escapeHtml(p.name) + '</b><div class="hint" style="word-break:break-all">' + escapeHtml(p.repo_url + ' @ ' + p.branch) + '</div></div><button class="ghost small" data-pr="del" data-id="' + p.id + '">删除</button></div>'; }).join('') : '<div class="hint">还没有自定义项目</div>';
    }
    const m = el('<div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:50;padding:16px"><div style="background:var(--panel);border-radius:14px;padding:20px;width:min(520px,94vw);max-height:90vh;overflow:auto"><h2 style="margin:0 0 4px">自定义项目</h2><div class="hint">填写你的 OpenWrt / ImmortalWrt / LEDE 或其它 OpenWrt 系源码的 GitHub 仓库和分支，添加时会立即检查，平台和机型直接从仓库源码读取。</div>'
      + '<label style="display:block;margin-top:12px">项目名称<input id="pj-name" placeholder="如 我的 ImmortalWrt" style="width:100%"></label>'
      + '<label style="display:block;margin-top:8px">仓库地址<input id="pj-url" placeholder="https://github.com/用户/仓库" style="width:100%"></label>'
      + '<label style="display:block;margin-top:8px">分支<input id="pj-branch" value="master" style="width:100%"></label>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="primary" id="pj-add">添加</button></div>'
      + '<h3 style="margin:16px 0 4px;font-size:14px">已添加</h3><div id="pj-list">' + rows() + '</div>'
      + '<div style="text-align:right;margin-top:14px"><button class="ghost" id="pj-close">关闭</button></div></div></div>');
    document.body.appendChild(m);
    async function refreshList() { await storeLoadProjects(); storeDrawProjects(); m.querySelector('#pj-list').innerHTML = rows(); }
    m.querySelector('#pj-close').onclick = function () { m.remove(); };
    m.querySelector('#pj-add').onclick = async function () {
      const body = { name: m.querySelector('#pj-name').value.trim(), repo_url: m.querySelector('#pj-url').value.trim(), branch: m.querySelector('#pj-branch').value.trim() };
      try {
        const r = await api.post('/api/projects', body);
        await refreshList();
        STORE.pi = Math.max(0, STORE.projects.findIndex(function (p) { return p.id === r.project.id; }));
        storeDrawProjects(); m.remove(); toast('已添加，正在读取平台列表', 'success');
        STORE.target = ''; STORE.sub = ''; STORE.profile = ''; STORE.devText = ''; storeSyncInputs(); storeLoadPlatforms(false);
      } catch (e) { reportApiError(e, '添加失败'); }
    };
    m.addEventListener('click', async function (e) {
      const b = e.target; if (!b.dataset || b.dataset.pr !== 'del') return;
      try { await api.del('/api/projects/' + b.dataset.id); await refreshList(); STORE.pi = 0; storeDrawProjects(); storeLoadPlatforms(false); }
      catch (err) { reportApiError(err, '删除失败'); }
    });
  }

  function storeDrawGrid() {
    document.getElementById('st-chips').innerHTML = STORE.cats.map(function (c) {
      const n = c === '全部' ? STORE.catalog.length : STORE.catalog.filter(function (p) { return p.cat === c; }).length;
      return '<button class="ghost small" data-cat="' + c + '" aria-pressed="' + (!STORE.only && c === STORE.cat) + '">' + c + ' ' + n + '</button>';
    }).join('') + '<button class="ghost small" data-only="1" aria-pressed="' + STORE.only + '">只看已选 ' + STORE.sel.size + '</button>';
    const L = STORE.catalog.filter(function (p) {
      if (STORE.only) return STORE.sel.has(p.id);
      return (STORE.cat === '全部' || p.cat === STORE.cat) && (p.name + ' ' + p.desc + ' ' + p.id + ' ' + p.cat + ' ' + (STORE.kw[p.cat] || '') + ' ' + (p.tags || []).join(' ')).toLowerCase().indexOf(STORE.q) >= 0;
    });
    document.getElementById('st-grid').innerHTML = L.length ? L.slice(0, STORE.limit).map(function (p) {
      const on = STORE.sel.has(p.id);
      return '<article class="st-card" data-id="' + p.id + '"><div class="st-top"><div class="st-tile" style="background:hsl(' + storeHue(p.id) + ' 52% 40%)">' + escapeHtml(p.name.charAt(0).toUpperCase()) + '</div><div><h3>' + escapeHtml(p.name) + '</h3><code>' + p.id + '</code></div></div>'
        + '<p>' + escapeHtml(p.desc) + '</p><div class="st-foot">' + (p.rec ? '<span class="badge dim">推荐内置</span>' : '') + (p.stale ? '<span class="badge warn">目录已无</span>' : (p.custom ? '<span class="badge dim">自定义</span>' : ((p.origin && p.origin.type !== 'builtin') ? '<span class="badge dim">第三方源</span>' : ''))) + '<span>' + (p.size_mb ? '约 ' + p.size_mb + ' MB' : '') + '</span>'
        + '<button class="small ' + (on ? 'on' : 'ghost') + '" data-add="' + p.id + '">' + (on ? '已添加' : '添加') + '</button></div></article>';
    }).join('') : '<div class="hint">没有匹配的插件，换个关键词或分类试试。</div>';
    document.getElementById('st-more').innerHTML = L.length > STORE.limit ? '<button class="ghost" data-more="1">显示更多（还有 ' + (L.length - STORE.limit) + ' 个）</button>' : '';
  }

  function storeConfigPreview() {
    const NL = String.fromCharCode(10), lines = [];
    if (STORE.profile && STORE_TARGET_RE.test(storeTargetStr())) { const m = storeTargetStr().split('/'); lines.push('CONFIG_TARGET_' + m[0] + '=y', 'CONFIG_TARGET_' + m[0] + '_' + m[1] + '=y', 'CONFIG_TARGET_' + m[0] + '_' + m[1] + '_DEVICE_' + STORE.profile + '=y'); }
    storeSelected().forEach(function (p) { lines.push('CONFIG_PACKAGE_' + p.id + '=y'); (p.requires || []).forEach(function (r) { lines.push('CONFIG_PACKAGE_' + r + '=y'); }); });
    return lines.join(NL);
  }

  function storeAutoName() {
    const proj = storeProject();
    return '商店 · ' + (proj ? proj.name : '') + ' · ' + (storeTargetStr() || '未选平台') + ' · ' + (STORE.profile || '未选机型');
  }

  function storeDrawBasket() {
    const box = document.getElementById('st-basket'); if (!box) return;
    const ph = document.getElementById('st-profhint');
    if (ph) ph.textContent = STORE.profile ? 'profile：' + STORE.profile : '';
    const S = storeSelected(), mb = 7 + S.reduce(function (a, p) { return a + (p.size_mb || 0); }, 0);
    const deps = new Set(); S.forEach(function (p) { (p.deps || []).forEach(function (d) { deps.add(d); }); });
    const px = S.filter(function (p) { return p.cat === '代理'; });
    const warns = [];
    if (px.length > 1) warns.push('已选 ' + px.length + ' 个代理插件，通常只需要一个，同时启用容易冲突。');
    if (!storeTargetStr() || !STORE_TARGET_RE.test(storeTargetStr())) warns.push('请先选择平台和子平台。');
    else if (!STORE.profile) warns.push('请选择机型。');
    if (STORE.profile && storeCurSub() && !storeDevices().some(function (d) { return d.id === STORE.profile; })) warns.push('这个机型不在所选子平台的源码列表里（模板里原有的值），建议重新选择。');
    if (STORE.profile && !STORE_PROFILE_RE.test(STORE.profile)) warns.push('机型 profile 只能包含字母、数字和 . _ + -');
    const nStale = S.filter(function (p) { return p.stale; }).length;
    if (nStale) warns.push(nStale + ' 个插件已不在目录里，会按原包名尝试启用，编译时校验是否生效。');
    const proj = storeProject();
    const nm = STORE.nameDirty ? STORE.tplName : storeAutoName();
    box.innerHTML = '<h2>固件清单</h2><div class="hint">' + escapeHtml((proj ? proj.name : '') + ' · ' + (storeTargetStr() || '未选平台') + ' · ' + (STORE.profile || '未选机型')) + '</div><ul>' + S.map(function (p) { return '<li>' + escapeHtml(p.name) + '<button data-rm="' + escapeHtml(p.id) + '" aria-label="移除">×</button></li>'; }).join('') + '</ul>'
      + '<div class="st-sum"><span><b>' + S.length + '</b>插件</span><span><b>' + deps.size + '</b>自动依赖</span><span><b>' + mb.toFixed(1) + '</b>已知体积 MB</span></div>' + warns.map(function (w) { return '<div class="st-warn">' + escapeHtml(w) + '</div>'; }).join('')
      + '<label class="hint" style="display:block">模板名称<input id="st-name" maxlength="80" value="' + escapeHtml(nm) + '" style="margin-top:4px"></label>'
      + '<details><summary class="hint">查看将写入的配置行</summary><textarea readonly>' + escapeHtml(storeConfigPreview()) + '</textarea></details>'
      + '<button class="primary" id="st-go"' + (STORE.busy ? ' disabled' : '') + '>' + (STORE.busy ? '保存中…' : (STORE.editId ? '保存到模板' : '生成模板')) + '</button>'
      + '<div class="hint">不会立即编译，下一页确认后再点编译。</div>';
    document.getElementById('st-name').oninput = function (e) { STORE.tplName = e.target.value; STORE.nameDirty = true; };
  }

  function storeDetail(id) {
    const p = storeBy(id); if (!p) return;
    const on = STORE.sel.has(id), o = storeOrigin(p);
    const m = el('<div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:50"><div style="background:var(--panel);border-radius:14px;padding:20px;width:min(460px,92vw)"><h2 style="margin:0">' + escapeHtml(p.name) + '</h2><code class="hint">' + p.id + '</code><p>' + escapeHtml(p.desc) + '</p>' + (p.tut ? '<p><b>使用提示：</b>' + escapeHtml(p.tut) + '</p>' : '') + '<p><b>依赖：</b>' + (p.deps.length ? escapeHtml(p.deps.join('、')) : '无') + '（由编译系统自动解决）</p>' + (o ? '<p><b>来源：</b>' + escapeHtml(o.git_url || o.feed) + '</p>' : '') + '<div style="display:flex;gap:8px;justify-content:flex-end">' + (p.custom && !p.stale ? '<button class="ghost" id="st-ddel" style="margin-right:auto">删除这个自定义插件</button>' : '') + '<button class="ghost" id="st-dx">关闭</button><button class="primary" id="st-da">' + (on ? '从固件移除' : '添加到固件') + '</button></div></div></div>');
    document.body.appendChild(m);
    m.querySelector('#st-dx').onclick = function () { m.remove(); };
    m.querySelector('#st-da').onclick = function () { storeToggle(id); m.remove(); };
    const del = m.querySelector('#st-ddel');
    if (del) del.onclick = async function () {
      if (!confirm('删除自定义插件「' + p.name + '」？已保存的模板不受影响。')) return;
      try {
        await api.del('/api/custom-plugins/' + encodeURIComponent(id));
        STORE.sel.delete(id); await storeReloadCatalog();
        if (STORE.cat !== '全部' && STORE.cats.indexOf(STORE.cat) < 0) STORE.cat = '全部';
        m.remove(); storeDrawGrid(); storeDrawBasket(); toast('已删除', 'success');
      } catch (e) { reportApiError(e, '删除失败'); }
    };
  }

  // 把所选插件的来源合并：同一个 feed 只写一次，同一个仓库的多个子目录合成一次稀疏克隆
  function storeMergePlugins(S) {
    const out = [], idx = {};
    S.forEach(function (p) {
      const o = storeOrigin(p); if (!o) return;
      if (o.feed) { const k = 'f|' + o.feed; if (!idx[k]) { idx[k] = o; out.push(o); } return; }
      if (o.sparse) {
        const k = 's|' + o.git_url + '|' + o.branch;
        if (idx[k]) { o.dirs.forEach(function (d) { if (idx[k].dirs.indexOf(d) < 0) idx[k].dirs.push(d); }); }
        else { o.dirs = o.dirs.slice(); idx[k] = o; out.push(o); }
        return;
      }
      const k = 'g|' + o.git_url + '|' + o.name;
      if (!idx[k]) { idx[k] = o; out.push(o); }
    });
    return out;
  }

  // 只保存模板，不触发编译；保存后跳到模板页确认
  async function storeSave() {
    if (STORE.busy) return;
    const proj = storeProject(), target = storeTargetStr(), profile = (STORE.profile || '').trim();
    if (!STORE_TARGET_RE.test(target)) { toast('请先选择平台和子平台', 'error'); return; }
    if (!profile) { toast('请选择机型', 'error'); return; }
    if (!STORE_PROFILE_RE.test(profile)) { toast('机型 profile 格式不正确', 'error'); return; }
    let name = (STORE.nameDirty ? STORE.tplName : storeAutoName()).trim();
    if (!name) { toast('请填写模板名称', 'error'); return; }
    const S = storeSelected(), pk = new Set();
    S.forEach(function (p) { pk.add(p.id); (p.requires || []).forEach(function (r) { pk.add(r); }); });
    const packages = Array.from(pk);
    const selection = S.map(function (p) { return p.id; });
    const plugins = storeMergePlugins(S);
    STORE.busy = true; storeDrawBasket();
    try {
      const body = { name: name, repo_url: proj.repo_url, branch: proj.branch, target: target, profile: profile, project_id: proj.id, plugins: plugins, packages: packages, selection: selection };
      let id = STORE.editId;
      if (id) { await api.updateTemplate(id, body); }
      else {
        const lt = await api.listTemplates(), base = name; let n = 1;
        while (lt.templates.some(function (x) { return x.name === name; })) { n++; name = base + ' (' + n + ')'; }
        body.name = name;
        id = (await api.createTemplate(body)).template.id;
      }
      const wasEdit = !!STORE.editId;
      STORE.busy = false; storeReset();
      toast(wasEdit ? '已保存到模板' : '模板已生成，请确认后再编译', 'success');
      navigate('#/template/' + id);
    } catch (e) { STORE.busy = false; reportApiError(e, '保存失败'); storeDrawBasket(); }
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
    else if (name === 'store') renderStorePage(params.tpl);
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
