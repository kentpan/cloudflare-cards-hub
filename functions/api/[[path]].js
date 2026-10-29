/**
 * ============================================================================
 *  卡密资源分发系统 v1.0.3 —— Cloudflare Pages Functions（路由模式）
 * ============================================================================
 *  · 只有 /api/* 与 /s/* 请求进入 Functions（免费 10 万次/天），
 *    public/ 下静态页面由 Pages CDN 直接服务，完全免费、不限量。
 *  · /s/<token> 加密分享路由由 functions/s/[[path]].js 薄包装进入本路由器。
 *
 *  绑定要求（Pages 项目 → Settings → Bindings）:
 *    - D1  数据库   → 变量名 DATABASE （必需）
 *    - R2  存储桶   → 变量名 BUCKET   （资源上传必需）
 *    - Secret 变量 → ADMIN_SECRET    （管理面板登录密钥，Pages 控制台配置）
 *    - Secret 变量 → JWT_SECRET      （可选；/s/ 加密分享链接的加解密密钥，
 *                                     未配置时自动退回用 ADMIN_SECRET 派生）
 *    - Secret 变量 → ISSUE_APIKEY    （可选；兼容旧版单密钥，新版请在管理面板
 *                                     「APIKEY 管理」创建多把可区分调用方的 key）
 *
 *  ── 公开接口 ─────────────────────────────────────────────────────────────
 *    GET  /api/health                 健康自检（D1 / R2 绑定状态）
 *    GET  /api/public/config          提取页初始化配置
 *    POST /api/issue                  发卡接口（Xianyu 等系统对接）
 *                                       Authorization: Bearer <apikey>
 *                                       body: { title, price, script_id!, max_uses?, expires_hours? }
 *                                       → 返回 /s/ 加密提取页链接（自带卡密免输入）或 /s/ 加密直接命令；未指定 script_id → 404
 *    POST /api/redeem                 核销卡密（key=手动输入 或 s=加密链接 token）
 *                                       → 返回 /s/ 加密命令 / 加密下载地址
 *    GET  /api/file/<path>            R2 资源代理下载（未配 CDN 域名时的兜底）
 *    GET  /s/<token>                  加密分享路由：提取页 token → 整页；
 *                                       下载 token → 校验卡密后下发 / 302 外链
 *
 *  ── 管理接口（Authorization: Bearer <登录token>）─────────────────────────
 *    GET  /api/admin/bootstrap        是否已配置 ADMIN_SECRET
 *    POST /api/admin/login            ADMIN_SECRET 登录 → 24h token
 *    GET  /api/admin/overview         概览统计 + 绑定自检
 *    GET  /api/admin/stats?days=30    图表数据（chart.js）
 *    GET  /api/admin/scripts          资源列表（分页/搜索）
 *    POST /api/admin/scripts          上传资源（multipart → R2，D1 只存 path；任意类型 ≤100MB）
 *    PUT  /api/admin/scripts/:id      改名 / 启停 / 替换文件 / 改外链
 *    DEL  /api/admin/scripts/:id      删除资源（连带 R2 对象）
 *    POST /api/admin/decode           解密 /s/ 分享链接（管理面板工具）
 *    GET  /api/admin/cards            卡密列表（分页/搜索/筛选）
 *    POST /api/admin/cards            批量生成卡密
 *    POST /api/admin/card-action      批量作废/恢复/删除
 *    GET  /api/admin/orders           订单列表（分页/搜索）
 *    GET  /api/admin/settings         读取配置
 *    POST /api/admin/settings         保存配置
 *
 *  ── APIKEY 管理（v1.0.2 新增，区分调用方 / 有效期 / 限速 / 调用统计）────
 *    GET  /api/admin/apikeys          APIKEY 列表（分页/搜索，默认脱敏显示）
 *    POST /api/admin/apikeys          创建 APIKEY（仅创建响应中返回完整 key）
 *    GET  /api/admin/apikeys/:id      查看完整密钥（脱敏后需要复制/查看时用）
 *    PUT  /api/admin/apikeys/:id      改名 / 启停 / 改限速 / 改有效期
 *    DEL  /api/admin/apikeys/:id      删除 APIKEY（连带调用日志）
 *    GET  /api/admin/apikeys/:id/stats?days=7   单个 key 调用统计（chart.js）
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const VERSION = '1.0.3';

// 卡密：8 位大小写英文 + 数字混合（区分大小写）
const CARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CARD_LEN = 8;

const PBKDF2_ITERATIONS = 100000;

const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 单个资源上限 100 MB（源码/软件包/压缩包/文档/图片等任意类型）

// 限流（每 isolate 内存级，尽力而为）
const RATE_LIMITS = {
  login: { per: 60_000, max: 10 },
  issue: { per: 60_000, max: 60 },
  redeem: { per: 60_000, max: 30 },
  file: { per: 60_000, max: 120 },
};

const SESSION_TTL_MS = 24 * 3600 * 1000;                // 登录 token 有效期 24h

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
  });
}
function fail(error, status = 400) {
  return json({ ok: false, error }, status);
}
function ok(data) {
  return json({ ok: true, data });
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 常量时间字符串比较（不依赖平台私有 API，Workers/Node 通用）
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a || ''));
  const eb = new TextEncoder().encode(String(b || ''));
  const n = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < n; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

// PBKDF2-SHA256 摘要: pbkdf2$<iter>$<saltB64>$<hashB64>
async function pbkdf2Hash(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}
async function pbkdf2Verify(secret, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = base64ToBytes(saltB64);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parseInt(iterStr, 10) || PBKDF2_ITERATIONS },
      key,
      256
    );
    const expect = base64ToBytes(hashB64);
    const got = new Uint8Array(bits);
    if (expect.length !== got.length) return false;
    let diff = 0;
    for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ got[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// 卡密：8 位随机（大小写英文 + 数字）
function newCardKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(CARD_LEN));
  let s = '';
  for (let i = 0; i < CARD_LEN; i++) s += CARD_ALPHABET[bytes[i] % CARD_ALPHABET.length];
  return s;
}
function normalizeCardKey(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9]{8}$/.test(s) ? s : null;
}

function clientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    '0.0.0.0'
  );
}

// ---------------------------------------------------------------------------
// 内存限流（每 isolate 独立，零依赖兜底）
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimited(kind, ip) {
  const conf = RATE_LIMITS[kind];
  if (!conf) return false;
  const now = Date.now();
  const key = `${kind}:${ip}`;
  const entry = rateBuckets.get(key);
  if (!entry || now - entry.start > conf.per) {
    rateBuckets.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return entry.count > conf.max;
}

// ---------------------------------------------------------------------------
// D1 建表（幂等，首次请求自动执行）
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'ps1',
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_key TEXT NOT NULL UNIQUE,
  script_id INTEGER,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  first_used_at INTEGER,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid',
  source TEXT NOT NULL DEFAULT 'api',
  apikey_id INTEGER,
  apikey_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS apikeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  expires_at INTEGER,                      -- 毫秒时间戳，NULL = 永久
  rate_limit INTEGER NOT NULL DEFAULT 30,  -- 窗口内最大调用次数
  rate_window INTEGER NOT NULL DEFAULT 60, -- 限速窗口（秒）
  calls INTEGER NOT NULL DEFAULT 0,        -- 累计成功调用
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS apikey_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apikey_id INTEGER NOT NULL DEFAULT 0,    -- 0 = 旧版单密钥 / 未识别 key
  ok INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 200,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_apikey_logs_time ON apikey_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_apikey_logs_key ON apikey_logs(apikey_id, created_at);
`;

// v1.0.1 → v1.0.2 增量迁移：旧库的 orders 表补 APIKEY 来源列（已存在时忽略报错）
const MIGRATION_SQL = [
  'ALTER TABLE orders ADD COLUMN apikey_id INTEGER',
  "ALTER TABLE orders ADD COLUMN apikey_name TEXT NOT NULL DEFAULT ''",
];

let schemaReady = null;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DATABASE.batch(
    SCHEMA_SQL.split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((sql) => env.DATABASE.prepare(sql))
  );
  for (const sql of MIGRATION_SQL) {
    await env.DATABASE.prepare(sql).run().catch(() => {}); // 列已存在 = 正常
  }
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 加密分享链接（v1.0.3）：JWT_SECRET（未配置则退回 ADMIN_SECRET）派生 AES-256-GCM 密钥
// token = base64url(iv + ciphertext(JSON payload))，统一挂在 /s/<token> 路径下；
// payload: { t:'p', k:卡密 } 提取页 | { t:'f', p:路径或外链, n:文件名, k:卡密 } 下载
// ---------------------------------------------------------------------------
function b64urlFromBytes(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return base64ToBytes(t);
}
function shareSecretReady(env) {
  return !!(env && (env.JWT_SECRET || env.ADMIN_SECRET));
}
async function shareCryptoKey(env) {
  const secret = String((env && (env.JWT_SECRET || env.ADMIN_SECRET)) || '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function shareSeal(env, payload) {
  if (!shareSecretReady(env)) return null;
  try {
    const key = await shareCryptoKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(payload));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return b64urlFromBytes(out);
  } catch {
    return null;
  }
}
async function shareOpen(env, token) {
  try {
    const raw = b64urlToBytes(String(token || '').trim());
    if (raw.length <= 13) return null;
    const key = await shareCryptoKey(env);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) },
      key,
      raw.slice(12)
    );
    const obj = JSON.parse(new TextDecoder().decode(pt));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// settings 读写
// ---------------------------------------------------------------------------
async function getSettings(env, keys) {
  const placeholders = keys.map(() => '?').join(',');
  const { results } = await env.DATABASE.prepare(
    `SELECT k, v FROM settings WHERE k IN (${placeholders})`
  )
    .bind(...keys)
    .all();
  const map = {};
  for (const row of results) map[row.k] = row.v;
  return map;
}
async function setSetting(env, k, v) {
  await env.DATABASE.prepare(
    'INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  )
    .bind(k, String(v))
    .run();
}
async function delSetting(env, k) {
  await env.DATABASE.prepare('DELETE FROM settings WHERE k = ?').bind(k).run();
}
async function addLog(env, action, detail, ip) {
  await env.DATABASE.prepare(
    'INSERT INTO logs(action, detail, ip, created_at) VALUES(?, ?, ?, ?)'
  )
    .bind(action, detail || '', ip || '', Date.now())
    .run();
}

// 发卡 APIKEY（旧版兼容）：环境变量 ISSUE_APIKEY 优先，否则用 D1 自动生成的
async function resolveApikey(env) {
  if (env.ISSUE_APIKEY) return { key: env.ISSUE_APIKEY, from: 'env' };
  const s = await getSettings(env, ['apikey']);
  if (s.apikey) return { key: s.apikey, from: 'db' };
  const generated = hex(crypto.getRandomValues(new Uint8Array(24)));
  await setSetting(env, 'apikey', generated);
  return { key: generated, from: 'db' };
}

// ---------------------------------------------------------------------------
// APIKEY 管理（v1.0.2）：多把 key 区分调用方 / 有效期 / 限速 / 调用统计
// ---------------------------------------------------------------------------
function maskApiKey(key) {
  const s = String(key || '');
  if (s.length <= 12) return s.slice(0, 4) + '****';
  return s.slice(0, 7) + '••••••' + s.slice(-4);
}
function newApiKey() {
  return 'ak-' + hex(crypto.getRandomValues(new Uint8Array(15)));
}
const isExternalPath = (p) => /^https?:\/\//i.test(String(p || ''));

async function logApikeyCall(env, apikeyId, okFlag, status) {
  await env.DATABASE.prepare(
    'INSERT INTO apikey_logs(apikey_id, ok, status, created_at) VALUES(?,?,?,?)'
  )
    .bind(apikeyId || 0, okFlag ? 1 : 0, status || 200, Date.now())
    .run();
}

// /api/issue 鉴权：优先匹配管理面板创建的 APIKEY，兼容旧版单密钥
async function authenticateIssueKey(env, token) {
  const now = Date.now();
  const row = await env.DATABASE.prepare('SELECT * FROM apikeys WHERE key = ?')
    .bind(token)
    .first();
  if (row) {
    if (row.status !== 'active') {
      await logApikeyCall(env, row.id, false, 403);
      return { ok: false, error: 'APIKEY 已停用，请到管理面板启用或换用新 key', status: 403 };
    }
    if (row.expires_at && row.expires_at < now) {
      await logApikeyCall(env, row.id, false, 403);
      return { ok: false, error: 'APIKEY 已过期，请联系管理员续期或换用新 key', status: 403 };
    }
    // 限速：统计窗口内的非 429 请求（429 本身不计入，避免被永久卡死）
    const used = (
      await env.DATABASE.prepare(
        'SELECT COUNT(*) n FROM apikey_logs WHERE apikey_id = ? AND status != 429 AND created_at >= ?'
      )
        .bind(row.id, now - row.rate_window * 1000)
        .first()
    ).n;
    if (used >= row.rate_limit) {
      await logApikeyCall(env, row.id, false, 429);
      return {
        ok: false,
        error: `触发限速：该 APIKEY 限制 ${row.rate_limit} 次 / ${row.rate_window}s，请稍后再试`,
        status: 429,
      };
    }
    await env.DATABASE.prepare('UPDATE apikeys SET calls = calls + 1, last_used_at = ? WHERE id = ?')
      .bind(now, row.id)
      .run();
    await logApikeyCall(env, row.id, true, 200);
    return { ok: true, id: row.id, name: row.name };
  }
  // 旧版兼容：环境变量 ISSUE_APIKEY / 后台单 key
  const { key: legacy } = await resolveApikey(env);
  if (legacy && safeEqual(token, legacy)) {
    await logApikeyCall(env, 0, true, 200);
    return { ok: true, id: 0, name: '默认密钥' };
  }
  await logApikeyCall(env, 0, false, 401);
  return { ok: false, error: 'apikey 无效', status: 401 };
}

// ---------------------------------------------------------------------------
// 管理员鉴权：ADMIN_SECRET 来自 Pages 环境变量(Secrets)，登录换 24h token
// ---------------------------------------------------------------------------
async function adminLogin(request, env) {
  await ensureSchema(env);
  if (!env.ADMIN_SECRET) {
    return fail('未配置 ADMIN_SECRET：请到 Cloudflare Pages 控制台 → Settings → Environment variables 添加 Secret 后重试', 500);
  }
  if (rateLimited('login', clientIP(request))) return fail('尝试过于频繁，请稍后再试', 429);
  const body = await request.json().catch(() => ({}));
  if (!body.admin_secret || !safeEqual(body.admin_secret, env.ADMIN_SECRET)) {
    await addLog(env, 'login_fail', '', clientIP(request));
    return fail('ADMIN_SECRET 错误', 401);
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + SESSION_TTL_MS;
  // 单活动会话：新登录会使旧 token 失效
  await setSetting(env, 'admin_session', JSON.stringify({ token, exp: expiresAt }));
  await addLog(env, 'login_ok', '', clientIP(request));
  return ok({ token, expires_at: expiresAt });
}

async function requireAdmin(request, env) {
  await ensureSchema(env);
  if (!env.ADMIN_SECRET) return { error: fail('未配置 ADMIN_SECRET（Pages 环境变量）', 500) };
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { error: fail('未登录', 401) };
  const s = await getSettings(env, ['admin_session']);
  if (!s.admin_session) return { error: fail('会话已失效，请重新登录', 401) };
  try {
    const sess = JSON.parse(s.admin_session);
    if (!sess.token || sess.exp < Date.now()) return { error: fail('会话已过期，请重新登录', 401) };
    if (!safeEqual(token, sess.token)) return { error: fail('会话无效', 401) };
  } catch {
    return { error: fail('会话无效', 401) };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 交付渲染
// ---------------------------------------------------------------------------
function siteBase(request, env, s) {
  // 站点自定义域名支持多个（;分隔）：请求来自其中之一时优先用请求域名，否则取第一个
  const list = String((s && s.site_url) || '')
    .split(';')
    .map((x) => x.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!list.length) return new URL(request.url).origin;
  try {
    const origin = new URL(request.url).origin;
    if (list.includes(origin)) return origin;
  } catch {}
  return list[0];
}
function downloadBase(request, env, s) {
  const cdn = String((s && s.r2_cdn_base) || '').trim().replace(/\/+$/, '');
  return cdn || `${new URL(request.url).origin}/api/file`;
}

// 依据资源与模板生成命令与下载地址（v1.0.3：分享/下载统一走 /s/<加密token>）
// 模板变量: {url}=加密下载直链 {key}=卡密 {page}=提取页链接 {name}=资源名 {filename}=文件名
async function renderDelivery(request, env, s, script, cardKey, pageUrl) {
  const base = downloadBase(request, env, s);
  const rawUrl = isExternalPath(script.path) ? script.path : `${base}/${script.path}`;
  let url = rawUrl;
  if (shareSecretReady(env)) {
    const tok = await shareSeal(env, { t: 'f', p: script.path, n: script.filename, k: cardKey || '' });
    if (tok) url = `${siteBase(request, env, s)}/s/${tok}`;
  }
  const tpl = String(s.command_template || '').trim();
  const fill = (t) =>
    t
      .replaceAll('{url}', url)
      .replaceAll('{key}', cardKey || '')
      .replaceAll('{page}', pageUrl || '')
      .replaceAll('{name}', script.name)
      .replaceAll('{filename}', script.filename);
  let command;
  if (tpl) {
    command = fill(tpl);
  } else if (script.type === 'ps1') {
    command = `irm ${url} | iex`;
  } else {
    command = `curl -L -o "${script.filename}" "${url}"`;
  }
  return { url, raw_url: rawUrl, command };
}

// ---------------------------------------------------------------------------
// 静态工具
// ---------------------------------------------------------------------------
// 任意类型资源：type = 扩展名（≤10 位字母数字），无扩展名或异常 → 'file'
function fileTypeFromFilename(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'file';
}
function safeFilename(name) {
  const cleaned = String(name || 'script')
    .replace(/[\r\n]+/g, '')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .slice(-80);
  return cleaned || 'script';
}

// ---------------------------------------------------------------------------
// 公开接口处理器
// ---------------------------------------------------------------------------

// GET /api/health
async function handleHealth(request, env) {
  let dbOk = false;
  try {
    await env.DATABASE.prepare('SELECT 1').first();
    dbOk = true;
  } catch {}
  return ok({
    version: VERSION,
    db: dbOk ? 'up' : 'down',
    r2: !!env.BUCKET,
    admin_secret: !!env.ADMIN_SECRET,
    time: Date.now(),
  });
}

// GET /api/public/config —— 提取页初始化
async function handlePublicConfig(request, env) {
  await ensureSchema(env);
  const s = await getSettings(env, ['site_title', 'share_pwd', 'delivery_mode']);
  return ok({
    site_title: s.site_title || '卡密提取',
    share_required: !!s.share_pwd,
    delivery_mode: s.delivery_mode || 'link',
  });
}

// POST /api/issue —— 发卡接口（对接咸鱼等自动发货系统）
async function handleIssue(request, env) {
  await ensureSchema(env);
  const ip = clientIP(request);
  if (rateLimited('issue', ip)) return fail('请求过于频繁', 429);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return fail('缺少 Authorization: Bearer <apikey>', 401);
  const keyAuth = await authenticateIssueKey(env, token);
  if (!keyAuth.ok) return fail(keyAuth.error, keyAuth.status);

  const body = await request.json().catch(() => null);
  if (!body) return fail('请求体必须是 JSON');
  const title = String(body.title || '').trim();
  const price = Number(body.price);
  if (!title) return fail('缺少参数: title（商品名称）');
  if (!Number.isFinite(price) || price < 0) return fail('缺少参数: price（交易金额，数字）');

  const s = await getSettings(env, ['delivery_mode', 'r2_cdn_base', 'command_template', 'site_url']);
  const scriptId = parseInt(body.script_id, 10) || 0;
  let script = null;
  if (scriptId) {
    script = await env.DATABASE.prepare(
      "SELECT id, name, filename, path, type FROM scripts WHERE id = ? AND status = 'active'"
    )
      .bind(scriptId)
      .first();
  }
  // v1.0.3：不再提供“默认脚本”兜底，未指定 / 无效 script_id 直接 404
  if (!script) {
    return fail('未找到可用资源：请携带有效的 script_id（卖家后台 → 资源管理查看）', 404);
  }

  const maxUses = Math.max(1, Math.min(999, parseInt(body.max_uses, 10) || 1));
  const expiresHours = Math.max(0, Math.min(8760, parseFloat(body.expires_hours) || 0));
  const now = Date.now();
  const expiresAt = expiresHours > 0 ? now + expiresHours * 3600 * 1000 : null;

  // 发货时才生成 8 位卡密（唯一约束冲突自动重试）
  let cardKey = null;
  for (let i = 0; i < 5; i++) {
    const candidate = newCardKey();
    try {
      await env.DATABASE.prepare(
        'INSERT INTO cards(card_key, script_id, max_uses, expires_at, note, status, created_at) VALUES(?,?,?,?,?,?,?)'
      )
        .bind(candidate, scriptId, maxUses, expiresAt, `API发卡: ${title}`.slice(0, 200), 'active', now)
        .run();
      cardKey = candidate;
      break;
    } catch (e) {
      if (!String(e?.message || '').includes('UNIQUE')) throw e;
    }
  }
  if (!cardKey) return fail('卡密生成失败，请重试', 500);

  await env.DATABASE.prepare(
    'INSERT INTO orders(card_key, title, price, status, source, apikey_id, apikey_name, created_at) VALUES(?,?,?,?,?,?,?,?)'
  )
    .bind(cardKey, title, price, 'paid', 'api', keyAuth.id || 0, keyAuth.name || '', now)
    .run();
  await addLog(
    env,
    'issue',
    JSON.stringify({ key: cardKey, title, price, script_id: scriptId, apikey: keyAuth.name || '' }),
    ip
  );

  const deliveryMode = body.deliver || s.delivery_mode || 'link';
  // 提取页链接（v1.0.3：/s/<token> 自带卡密，买家免输入提取码）
  const siteBaseStr = siteBase(request, env, s);
  const pageTok = await shareSeal(env, { t: 'p', k: cardKey });
  const pageUrl = pageTok
    ? `${siteBaseStr}/s/${pageTok}`
    : `${siteBaseStr}/?key=${encodeURIComponent(cardKey)}`;
  const data = {
    key: cardKey,
    title,
    price,
    url: pageUrl,
    expires_at: expiresAt,
    max_uses: maxUses,
    script: script.name,
  };
  if (deliveryMode === 'command' || deliveryMode === 'both') {
    const d = await renderDelivery(request, env, s, script, cardKey, pageUrl);
    data.command = d.command;
    data.download_url = d.url;
  }
  if (deliveryMode === 'command') {
    delete data.url;
  }
  return ok(data);
}

// POST /api/redeem —— 核销卡密
async function handleRedeem(request, env) {
  await ensureSchema(env);
  const ip = clientIP(request);
  if (rateLimited('redeem', ip)) return fail('尝试过于频繁，请稍后再试', 429);

  const body = await request.json().catch(() => ({}));
  // v1.0.3：支持 /s/<token> 加密链接直达（token 自带卡密，免输入提取码）
  let cardKey = normalizeCardKey(body.key);
  let viaToken = false;
  if (!cardKey && body.s) {
    const payload = await shareOpen(env, String(body.s));
    if (payload && payload.t === 'p' && payload.k) {
      cardKey = normalizeCardKey(payload.k);
      viaToken = true;
    }
    if (!cardKey) return fail('分享链接无效或已过期', 404);
  }
  if (!cardKey) return fail('卡密格式错误（8 位英文数字）');

  const card = await env.DATABASE.prepare('SELECT * FROM cards WHERE card_key = ?')
    .bind(cardKey)
    .first();
  if (!card) return fail('卡密不存在', 404);
  if (card.status === 'revoked') return fail('卡密已被作废', 403);
  if (card.expires_at && card.expires_at < Date.now()) return fail('卡密已过期', 403);
  if (card.used_count >= card.max_uses) return fail('卡密使用次数已用完', 403);

  // 提取码（后台设置后强制）
  const s = await getSettings(env, ['share_pwd', 'r2_cdn_base', 'command_template', 'site_url', 'delivery_mode']);
  if (s.share_pwd && !viaToken) {
    const pwd = String(body.pwd || '');
    if (!pwd) return fail('请输入提取码', 401);
    if (!(await pbkdf2Verify(pwd, s.share_pwd))) return fail('提取码错误', 403);
  }

  if (!card.script_id) return fail('该卡密未绑定资源，请联系卖家', 410);
  const script = await env.DATABASE.prepare('SELECT * FROM scripts WHERE id = ?').bind(card.script_id).first();
  if (!script || script.status !== 'active') return fail('资源已下架，请联系卖家', 410);

  const firstUse = card.used_count === 0;
  const now = Date.now();
  await env.DATABASE.prepare(
    'UPDATE cards SET used_count = used_count + 1, first_used_at = ?, last_used_at = ? WHERE id = ?'
  )
    .bind(firstUse ? now : card.first_used_at, now, card.id)
    .run();
  if (firstUse) {
    await env.DATABASE.prepare("UPDATE orders SET status = 'used' WHERE card_key = ? AND status = 'paid'")
      .bind(cardKey)
      .run();
  }
  await addLog(
    env,
    'redeem',
    JSON.stringify({ key: cardKey, script_id: script.id, script_name: script.name, via: viaToken ? 's_token' : 'key' }),
    ip
  );

  const d = await renderDelivery(request, env, s, script, cardKey);
  return ok({
    name: script.name,
    type: script.type,
    filename: script.filename,
    command: d.command,
    download_url: d.url,
    used_count: card.used_count + 1,
    max_uses: card.max_uses,
    remaining: Math.max(0, card.max_uses - card.used_count - 1),
    expires_at: card.expires_at,
  });
}

// ---------------------------------------------------------------------------
// 资源下发（v1.0.3）：/api/file/<path> 直链兜底 与 /s/<token> 加密分享共用
// ---------------------------------------------------------------------------
const MIME = {
  ps1: 'text/plain; charset=utf-8',
  bat: 'text/plain; charset=utf-8',
  cmd: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  iso: 'application/x-iso9660-image',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
  apk: 'application/vnd.android.package-archive',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// R2 对象下发（含 {{GH_PROXY}} 注入；非文本类型带附件下载头）
async function serveObject(request, env, path, filename) {
  if (!env.BUCKET) return fail('R2 未绑定', 501);
  if (!path || path.includes('..')) return fail('路径无效', 400);
  const object = await env.BUCKET.get(path);
  if (!object) return fail('文件不存在', 404);
  const ext = path.split('.').pop().toLowerCase();
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') object.writeHttpMetadata(headers);
  headers.set('Content-Type', MIME[ext] || object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=60');
  headers.set('Access-Control-Allow-Origin', '*');
  // 非内联类型 → 附件下载，文件名用加密 token 里带的原始文件名
  if (filename && !['ps1', 'bat', 'cmd', 'txt', 'json', 'csv', 'md', 'html'].includes(ext)) {
    const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
    headers.set(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(filename))}`
    );
  }
  // 文本资源下发：把 {{GH_PROXY}} 占位符替换为管理面板「系统设置 → GitHub 下载代理」配置值
  if (['ps1', 'bat', 'cmd', 'txt'].includes(ext) && (object.size ?? 0) <= 2 * 1024 * 1024) {
    try {
      let text = await object.text();
      if (text.includes('{{GH_PROXY}}')) {
        const s = await getSettings(env, ['gh_proxy_base']);
        const proxy = String(s.gh_proxy_base || '').trim().replace(/\/+$/, '');
        text = text.replaceAll('{{GH_PROXY}}', proxy);
      }
      headers.set('Content-Length', String(new TextEncoder().encode(text).byteLength));
      return new Response(text, { status: 200, headers });
    } catch {
      // 读取/替换失败 → 回退为流式原样返回
    }
  }
  return new Response(object.body, { status: 200, headers });
}

// GET /api/file/<path> —— R2 资源代理下载（未配置 CDN 域名时的兜底）
async function handleFile(request, env, pathParts) {
  if (!env.BUCKET) return fail('R2 未绑定', 501);
  if (rateLimited('file', clientIP(request))) return fail('请求过于频繁', 429);
  let path = '';
  try {
    path = (pathParts || []).map(decodeURIComponent).join('/');
  } catch {
    return fail('路径无效', 400);
  }
  return serveObject(request, env, path, '');
}

// 提取页整页（Pages 走 ASSETS 绑定；本地 dev 回源取 /）
async function serveIndexHtml(request, env) {
  try {
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return await env.ASSETS.fetch(new URL('/', request.url));
    }
    return await fetch(new URL('/', request.url));
  } catch {
    return fail('提取页加载失败', 500);
  }
}

// GET /s/<token> —— 加密分享路由（v1.0.3）
//   t='p' → 自带卡密的提取页（前端 JS 用 token 自动核销，买家零输入）
//   t='f' → 自带卡密的下载直链：校验卡密状态后下发 R2 对象或 302 到外链
async function handleShare(request, env, pathParts) {
  await ensureSchema(env);
  const token = String((pathParts || [])[0] || '');
  if (!token) return serveIndexHtml(request, env);
  const payload = await shareOpen(env, token);
  if (!payload) return fail('分享链接无效或已过期', 404);

  if (payload.t === 'p') {
    return serveIndexHtml(request, env);
  }

  if (payload.t === 'f') {
    if (rateLimited('file', clientIP(request))) return fail('请求过于频繁，请稍后再试', 429);
    // 链接自带卡密：作废/过期即失效（次数在提取页核销时计数，下载不重复扣）
    if (payload.k) {
      const card = await env.DATABASE.prepare('SELECT * FROM cards WHERE card_key = ?')
        .bind(payload.k)
        .first();
      if (!card) return fail('卡密不存在，资源已失效', 404);
      if (card.status === 'revoked') return fail('卡密已被作废，资源已失效', 403);
      if (card.expires_at && card.expires_at < Date.now()) return fail('卡密已过期，资源已失效', 403);
    }
    const target = String(payload.p || '');
    if (!target) return fail('分享链接无效', 404);
    await addLog(env, 'share_download', JSON.stringify({ key: payload.k || '', target }), clientIP(request));
    if (isExternalPath(target)) {
      return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
    }
    return serveObject(request, env, target, String(payload.n || ''));
  }

  return fail('分享链接无效', 404);
}

// POST /api/admin/decode —— 管理面板「分享链接解密」工具
async function handleAdminDecode(request, env) {
  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const input = String(body.input || '').trim();
  if (!input) return fail('请输入 /s/ 加密分享链接或 token');
  const m = input.match(/\/s\/([A-Za-z0-9_-]+)/);
  const token = m ? m[1] : input;
  const payload = await shareOpen(env, token);
  if (!payload) {
    return fail('解密失败：链接无效，或当前 JWT_SECRET / ADMIN_SECRET 与签发时不一致', 400);
  }
  const s = await getSettings(env, ['r2_cdn_base', 'site_url']);
  let real_url = '';
  if (payload.t === 'f') {
    const p = String(payload.p || '');
    real_url = isExternalPath(p) ? p : `${downloadBase(request, env, s)}/${p}`;
  } else if (payload.t === 'p') {
    real_url = `${siteBase(request, env, s)}/?key=${encodeURIComponent(payload.k || '')}`;
  }
  return ok({
    type: payload.t || '',
    key: payload.k || '',
    path: payload.p || '',
    filename: payload.n || '',
    expires_at: payload.e || null,
    token,
    real_url,
  });
}

// ---------------------------------------------------------------------------
// 管理接口处理器（均需 Bearer token）
// ---------------------------------------------------------------------------

// GET /api/admin/bootstrap
async function handleBootstrap(request, env) {
  let dbOk = false;
  try {
    await env.DATABASE.prepare('SELECT 1').first();
    dbOk = true;
  } catch {}
  return ok({
    version: VERSION,
    db: dbOk ? 'up' : 'down',
    admin_secret_configured: !!env.ADMIN_SECRET,
    r2: !!env.BUCKET,
  });
}

// GET /api/admin/overview
async function handleOverview(request, env) {
  await ensureSchema(env);
  const one = async (sql, ...binds) => (await env.DATABASE.prepare(sql).bind(...binds).first()) || {};
  // 上海时间（UTC+8）当天 0 点对应的 UTC 时间戳
  const SHANGHAI_OFFSET = 8 * 3600 * 1000;
  const dayStart = Math.floor((Date.now() + SHANGHAI_OFFSET) / 86400000) * 86400000 - SHANGHAI_OFFSET;

  const [cardsTotal, cardsActive, cardsExhausted, ordersSum, todayIssued, todayRedeem, todayAmount, apikeysTotal, apikeysActive, todayCalls] =
    await Promise.all([
      one('SELECT COUNT(*) n FROM cards'),
      one("SELECT COUNT(*) n FROM cards WHERE status='active' AND used_count < max_uses AND (expires_at IS NULL OR expires_at > ?)", Date.now()),
      one('SELECT COUNT(*) n FROM cards WHERE used_count >= max_uses'),
      one("SELECT COALESCE(SUM(price),0) a, COUNT(*) n FROM orders WHERE source='api' AND status IN ('paid','used')"),
      one('SELECT COUNT(*) n FROM cards WHERE created_at >= ?', dayStart),
      one("SELECT COUNT(*) n FROM logs WHERE action='redeem' AND created_at >= ?", dayStart),
      one("SELECT COALESCE(SUM(price),0) a FROM orders WHERE source='api' AND status IN ('paid','used') AND created_at >= ?", dayStart),
      one('SELECT COUNT(*) n FROM apikeys'),
      one("SELECT COUNT(*) n FROM apikeys WHERE status='active' AND (expires_at IS NULL OR expires_at > ?)", Date.now()),
      one('SELECT COUNT(*) n FROM apikey_logs WHERE ok = 1 AND created_at >= ?', dayStart),
    ]);

  return ok({
    version: VERSION,
    bindings: {
      db: !!env.DATABASE,
      r2: !!env.BUCKET,
      admin_secret: !!env.ADMIN_SECRET,
      issue_apikey_env: !!env.ISSUE_APIKEY,
    },
    cards: {
      total: cardsTotal.n || 0,
      available: cardsActive.n || 0,
      exhausted: cardsExhausted.n || 0,
    },
    orders: { total: ordersSum.n || 0, amount: ordersSum.a || 0 },
    apikeys: { total: apikeysTotal.n || 0, active: apikeysActive.n || 0 },
    today: {
      issued: todayIssued.n || 0,
      redeemed: todayRedeem.n || 0,
      amount: todayAmount.a || 0,
      calls: todayCalls.n || 0,
    },
  });
}

// GET /api/admin/stats?days=30 —— chart.js 数据
async function handleStats(request, env, url) {
  await ensureSchema(env);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days'), 10) || 30));
  const since = Date.now() - days * 86400 * 1000;

  // 按 UTC+8 自然日聚合（strftime %m-%d 与下方补齐的标签格式一致）
  const [issuedRows, redeemRows, amountRows, scriptRows, callRows] = await Promise.all([
    env.DATABASE.prepare(
      `SELECT strftime('%m-%d', created_at/1000, 'unixepoch', '+8 hours') d, COUNT(*) n
       FROM cards WHERE created_at >= ? GROUP BY d ORDER BY d`
    )
      .bind(since)
      .all(),
    env.DATABASE.prepare(
      `SELECT strftime('%m-%d', created_at/1000, 'unixepoch', '+8 hours') d, COUNT(*) n
       FROM logs WHERE action='redeem' AND created_at >= ? GROUP BY d ORDER BY d`
    )
      .bind(since)
      .all(),
    env.DATABASE.prepare(
      `SELECT strftime('%m-%d', created_at/1000, 'unixepoch', '+8 hours') d, COUNT(*) n, COALESCE(SUM(price),0) a
       FROM orders WHERE source='api' AND status IN ('paid','used') AND created_at >= ?
       GROUP BY d ORDER BY d`
    )
      .bind(since)
      .all(),
    env.DATABASE.prepare(
      `SELECT COALESCE(json_extract(detail, '$.script_name'), '未知') name, COUNT(*) n
       FROM logs WHERE action='redeem' GROUP BY name ORDER BY n DESC LIMIT 8`
    ).all(),
    env.DATABASE.prepare(
      `SELECT strftime('%m-%d', created_at/1000, 'unixepoch', '+8 hours') d, COUNT(*) n
       FROM apikey_logs WHERE ok = 1 AND created_at >= ? GROUP BY d ORDER BY d`
    )
      .bind(since)
      .all(),
  ]);

  // 补齐连续日期
  const dayLabels = [];
  const issuedMap = new Map(issuedRows.results.map((r) => [r.d, r.n]));
  const redeemMap = new Map(redeemRows.results.map((r) => [r.d, r.n]));
  const amountMap = new Map(amountRows.results.map((r) => [r.d, r]));
  const callMap = new Map(callRows.results.map((r) => [r.d, r.n]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000 + 8 * 3600 * 1000)
      .toISOString()
      .slice(5, 10);
    dayLabels.push(d);
  }
  const issuedArr = dayLabels.map((d) => issuedMap.get(d) || 0);
  const redeemArr = dayLabels.map((d) => redeemMap.get(d) || 0);
  const amountArr = dayLabels.map((d) => Number((amountMap.get(d)?.a || 0).toFixed(2)));
  const callArr = dayLabels.map((d) => callMap.get(d) || 0);

  return ok({
    days,
    labels: dayLabels,
    issued: issuedArr,
    redeemed: redeemArr,
    amount: amountArr,
    apikey_calls: callArr,
    script_usage: scriptRows.results.map((r) => ({ name: r.name, count: r.n })),
  });
}

// GET /api/admin/scripts?page=1&size=20&q=
async function handleScriptsList(request, env, url) {
  await ensureSchema(env);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const size = Math.max(1, Math.min(100, parseInt(url.searchParams.get('size'), 10) || 20));
  const q = (url.searchParams.get('q') || '').trim();
  const where = q ? 'WHERE name LIKE ? OR filename LIKE ?' : '';
  const like = `%${q}%`;
  const bind = q ? [like, like] : [];

  const total = (await env.DATABASE.prepare(`SELECT COUNT(*) n FROM scripts ${where}`).bind(...bind).first()).n;
  const { results } = await env.DATABASE.prepare(
    `SELECT id, name, filename, path, type, size, status, created_at, updated_at
     FROM scripts ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  )
    .bind(...bind, size, (page - 1) * size)
    .all();
  // 每个资源关联的卡密数
  const counts = await env.DATABASE.prepare(
    'SELECT script_id, COUNT(*) n FROM cards GROUP BY script_id'
  ).all();
  const countMap = new Map(counts.results.map((r) => [r.script_id, r.n]));
  return ok({
    list: results.map((r) => ({ ...r, card_count: countMap.get(r.id) || 0 })),
    total,
    page,
    size,
  });
}

// POST /api/admin/scripts —— multipart 上传（file + name）或 JSON 外链资源（{url, name}）
async function handleScriptUpload(request, env) {
  await ensureSchema(env);
  const ctype = request.headers.get('Content-Type') || '';

  // 外链资源：path 直接存完整 URL（可配合配套的 gh-proxy Worker 加速 GitHub 下载）
  if (ctype.includes('application/json')) {
    const body = await request.json().catch(() => null);
    if (!body) return fail('请求体必须是 JSON');
    const extUrl = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(extUrl) || extUrl.length > 600) {
      return fail('外部链接必须以 http(s):// 开头且不超过 600 字符');
    }
    const rawName = safeFilename(
      decodeURIComponent((extUrl.split('?')[0].split('#')[0].split('/').pop() || 'file'))
    );
    const type = fileTypeFromFilename(rawName);
    const name = String(body.name || '').trim() || rawName;
    const now = Date.now();
    const r = await env.DATABASE.prepare(
      'INSERT INTO scripts(name, filename, path, type, size, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)'
    )
      .bind(name, rawName, extUrl, type, 0, 'active', now, now)
      .run();
    await addLog(env, 'script_external', JSON.stringify({ id: r.meta?.last_row_id, url: extUrl }), clientIP(request));
    return ok({ id: r.meta?.last_row_id, path: extUrl, size: 0, type, external: true });
  }

  if (!env.BUCKET) return fail('R2 未绑定：请到 Pages 控制台为项目绑定 R2 存储桶（变量名 BUCKET）', 501);

  const form = await request.formData().catch(() => null);
  if (!form) return fail('必须是 multipart/form-data');
  const file = form.get('file');
  if (!(file && typeof file === 'object' && 'arrayBuffer' in file)) return fail('缺少文件字段 file');
  // v1.0.3：任意类型资源，≤100MB；未输入名称时直接用上传文件的文件名
  if (file.size > MAX_FILE_BYTES) return fail(`文件过大（上限 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB）`);
  const name = String(form.get('name') || '').trim() || file.name;

  const buf = await file.arrayBuffer();
  const filename = safeFilename(file.name);
  const type = fileTypeFromFilename(file.name);
  const path = `files/${Date.now()}-${hex(crypto.getRandomValues(new Uint8Array(4)))}-${filename}`;
  await env.BUCKET.put(path, buf);

  const now = Date.now();
  const r = await env.DATABASE.prepare(
    'INSERT INTO scripts(name, filename, path, type, size, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)'
  )
    .bind(name, filename, path, type, buf.byteLength, 'active', now, now)
    .run();
  await addLog(env, 'script_upload', JSON.stringify({ id: r.meta?.last_row_id, path }), clientIP(request));
  return ok({ id: r.meta?.last_row_id, path, size: buf.byteLength, type });
}

// PUT /api/admin/scripts/:id —— JSON{name?, status?, url?} 或 multipart(file) 替换文件
async function handleScriptUpdate(request, env, id) {
  await ensureSchema(env);
  const script = await env.DATABASE.prepare('SELECT * FROM scripts WHERE id = ?').bind(id).first();
  if (!script) return fail('资源不存在', 404);
  const now = Date.now();
  const ctype = request.headers.get('Content-Type') || '';

  if (ctype.includes('multipart/form-data')) {
    if (!env.BUCKET) return fail('R2 未绑定', 501);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file && typeof file === 'object' && 'arrayBuffer' in file)) return fail('缺少文件字段 file');
    if (file.size > MAX_FILE_BYTES) return fail(`文件过大（上限 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB）`);
    const buf = await file.arrayBuffer();
    const filename = safeFilename(file.name);
    const type = fileTypeFromFilename(file.name);
    const newPath = `files/${Date.now()}-${hex(crypto.getRandomValues(new Uint8Array(4)))}-${filename}`;
    await env.BUCKET.put(newPath, buf);
    await env.DATABASE.prepare(
      'UPDATE scripts SET filename = ?, path = ?, type = ?, size = ?, updated_at = ? WHERE id = ?'
    )
      .bind(filename, newPath, type, buf.byteLength, now, id)
      .run();
    await env.BUCKET.delete(script.path).catch(() => {});
  } else {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name ?? '').trim();
    const status = body.status;
    const extUrl = String(body.url ?? '').trim();
    if (!name && !status && !extUrl) return fail('没有可更新字段');
    if (status && !['active', 'disabled'].includes(status)) return fail('status 只能是 active / disabled');
    if (extUrl) {
      if (!/^https?:\/\//i.test(extUrl) || extUrl.length > 600) {
        return fail('外部链接必须以 http(s):// 开头且不超过 600 字符');
      }
      const rawName = safeFilename(
        decodeURIComponent((extUrl.split('?')[0].split('#')[0].split('/').pop() || 'file'))
      );
      const type = fileTypeFromFilename(rawName);
      // 若原来是 R2 对象，顺带清理旧文件
      if (!isExternalPath(script.path) && env.BUCKET) {
        await env.BUCKET.delete(script.path).catch(() => {});
      }
      await env.DATABASE.prepare(
        'UPDATE scripts SET filename = ?, path = ?, type = ?, size = 0, updated_at = ? WHERE id = ?'
      )
        .bind(rawName, extUrl, type, now, id)
        .run();
    }
    if (name || status) {
      await env.DATABASE.prepare(
        'UPDATE scripts SET name = COALESCE(?, name), status = COALESCE(?, status), updated_at = ? WHERE id = ?'
      )
        .bind(name || null, status || null, now, id)
        .run();
    }
  }
  return ok({ id });
}

// DELETE /api/admin/scripts/:id
async function handleScriptDelete(request, env, id) {
  await ensureSchema(env);
  const script = await env.DATABASE.prepare('SELECT * FROM scripts WHERE id = ?').bind(id).first();
  if (!script) return fail('资源不存在', 404);
  await env.DATABASE.prepare('DELETE FROM scripts WHERE id = ?').bind(id).run();
  // 引用该资源的卡密解绑
  await env.DATABASE.prepare('UPDATE cards SET script_id = NULL WHERE script_id = ?').bind(id).run();
  // 外链资源无 R2 对象，跳过删除
  if (!isExternalPath(script.path) && env.BUCKET) {
    await env.BUCKET.delete(script.path).catch(() => {});
  }
  await addLog(env, 'script_delete', JSON.stringify({ id, path: script.path }), clientIP(request));
  return ok({ id });
}

// GET /api/admin/cards?page=1&size=20&q=&status=
async function handleCardsList(request, env, url) {
  await ensureSchema(env);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const size = Math.max(1, Math.min(100, parseInt(url.searchParams.get('size'), 10) || 20));
  const q = (url.searchParams.get('q') || '').trim();
  const status = url.searchParams.get('status') || '';
  const conds = [];
  const binds = [];
  if (q) {
    conds.push('(c.card_key LIKE ? OR o.title LIKE ? OR c.note LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (status === 'revoked') conds.push("c.status = 'revoked'");
  else if (status === 'exhausted') conds.push('c.used_count >= c.max_uses');
  else if (status === 'active') conds.push("c.status = 'active' AND c.used_count < c.max_uses");
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const total = (
    await env.DATABASE.prepare(
      `SELECT COUNT(*) n FROM cards c LEFT JOIN orders o ON o.card_key = c.card_key AND o.source='api' ${where}`
    )
      .bind(...binds)
      .first()
  ).n;
  const { results } = await env.DATABASE.prepare(
    `SELECT c.id, c.card_key, c.script_id, c.max_uses, c.used_count, c.expires_at, c.note,
            c.status, c.created_at, c.first_used_at, c.last_used_at,
            s.name AS script_name,
            o.title AS order_title, o.price AS order_price, o.status AS order_status
     FROM cards c
     LEFT JOIN scripts s ON s.id = c.script_id
     LEFT JOIN orders o ON o.card_key = c.card_key AND o.source = 'api'
     ${where}
     ORDER BY c.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, size, (page - 1) * size)
    .all();
  return ok({ list: results, total, page, size });
}

// POST /api/admin/cards —— 批量生成
async function handleCardsCreate(request, env) {
  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const scriptId = parseInt(body.script_id, 10) || 0;
  const count = Math.max(1, Math.min(200, parseInt(body.count, 10) || 1));
  const maxUses = Math.max(1, Math.min(999, parseInt(body.max_uses, 10) || 1));
  const expiresHours = Math.max(0, Math.min(8760, parseFloat(body.expires_hours) || 0));
  const note = String(body.note || '').slice(0, 200);
  const title = String(body.title || '后台生成').slice(0, 120);
  const price = Number(body.price) || 0;

  const script = await env.DATABASE.prepare('SELECT id FROM scripts WHERE id = ?')
    .bind(scriptId)
    .first();
  if (!script) return fail('请选择要绑定的资源');

  const now = Date.now();
  const expiresAt = expiresHours > 0 ? now + expiresHours * 3600 * 1000 : null;
  const keys = [];
  for (let i = 0; i < count; i++) {
    let cardKey = null;
    for (let t = 0; t < 5; t++) {
      const candidate = newCardKey();
      try {
        await env.DATABASE.prepare(
          'INSERT INTO cards(card_key, script_id, max_uses, expires_at, note, status, created_at) VALUES(?,?,?,?,?,?,?)'
        )
          .bind(candidate, scriptId, maxUses, expiresAt, note, 'active', now)
          .run();
        cardKey = candidate;
        break;
      } catch (e) {
        if (!String(e?.message || '').includes('UNIQUE')) throw e;
      }
    }
    if (!cardKey) return fail('卡密生成失败，请重试', 500);
    keys.push(cardKey);
  }
  // 手动生成也入订单（source=manual，金额按填写，默认 0，不计入 API 交易统计）
  if (price > 0 || title !== '后台生成') {
    for (const k of keys) {
      await env.DATABASE.prepare(
        'INSERT INTO orders(card_key, title, price, status, source, created_at) VALUES(?,?,?,?,?,?)'
      )
        .bind(k, title, price, 'paid', 'manual', now)
        .run();
    }
  }
  await addLog(env, 'cards_create', JSON.stringify({ count, script_id: scriptId }), clientIP(request));
  return ok({ keys, count: keys.length });
}

// POST /api/admin/card-action —— {ids:[], action: revoke|restore|delete}
async function handleCardAction(request, env) {
  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
  const action = body.action;
  if (!ids.length) return fail('缺少 ids');
  const marks = ids.map(() => '?').join(',');
  if (action === 'revoke') {
    await env.DATABASE.prepare(`UPDATE cards SET status = 'revoked' WHERE id IN (${marks})`).bind(...ids).run();
  } else if (action === 'restore') {
    await env.DATABASE.prepare(`UPDATE cards SET status = 'active' WHERE id IN (${marks})`).bind(...ids).run();
  } else if (action === 'delete') {
    const rows = await env.DATABASE.prepare(`SELECT card_key FROM cards WHERE id IN (${marks})`).bind(...ids).all();
    await env.DATABASE.prepare(`DELETE FROM cards WHERE id IN (${marks})`).bind(...ids).run();
    const keyMarks = rows.results.map(() => '?').join(',');
    if (keyMarks) {
      await env.DATABASE.prepare(`DELETE FROM orders WHERE card_key IN (${keyMarks})`)
        .bind(...rows.results.map((r) => r.card_key))
        .run();
    }
  } else {
    return fail('未知操作');
  }
  await addLog(env, `card_${action}`, JSON.stringify({ ids }), clientIP(request));
  return ok({ ids, action });
}

// GET /api/admin/orders?page=1&size=20&q=
async function handleOrdersList(request, env, url) {
  await ensureSchema(env);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const size = Math.max(1, Math.min(100, parseInt(url.searchParams.get('size'), 10) || 20));
  const q = (url.searchParams.get('q') || '').trim();
  const source = url.searchParams.get('source') || '';
  const conds = [];
  const binds = [];
  if (q) {
    conds.push('(title LIKE ? OR card_key LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like);
  }
  if (source) {
    conds.push('source = ?');
    binds.push(source);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (await env.DATABASE.prepare(`SELECT COUNT(*) n FROM orders ${where}`).bind(...binds).first()).n;
  const { results } = await env.DATABASE.prepare(
    `SELECT id, card_key, title, price, status, source, apikey_id, apikey_name, created_at
     FROM orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, size, (page - 1) * size)
    .all();
  return ok({ list: results, total, page, size });
}

// GET /api/admin/settings
async function handleSettingsGet(request, env) {
  await ensureSchema(env);
  const s = await getSettings(env, [
    'site_title',
    'site_url',
    'delivery_mode',
    'command_template',
    'r2_cdn_base',
    'gh_proxy_base',
    'share_pwd',
    'apikey',
  ]);
  const { key: apikey, from } = await resolveApikey(env);
  const scripts = await env.DATABASE.prepare('SELECT id, name FROM scripts ORDER BY id DESC').all();
  return ok({
    site_title: s.site_title || '',
    site_url: s.site_url || '',
    delivery_mode: s.delivery_mode || 'link',
    command_template: s.command_template || '',
    r2_cdn_base: s.r2_cdn_base || '',
    gh_proxy_base: s.gh_proxy_base || '',
    share_pwd_set: !!s.share_pwd,
    apikey,
    apikey_source: from,
    scripts: scripts.results,
    admin_secret_env: !!env.ADMIN_SECRET,
  });
}

// POST /api/admin/settings —— 部分更新
async function handleSettingsPost(request, env) {
  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const updates = [];

  if (body.site_title !== undefined) updates.push(['site_title', String(body.site_title).slice(0, 60)]);
  if (body.site_url !== undefined) {
    // v1.0.3：站点域名支持绑定多个，; 分隔
    const list = String(body.site_url)
      .split(';')
      .map((x) => x.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    if (list.length > 10) return fail('站点域名最多 10 个');
    for (const u of list) {
      if (!/^https?:\/\//.test(u)) return fail('站点域名必须以 http(s):// 开头（多个用 ; 分隔）');
    }
    updates.push(['site_url', list.join(';')]);
  }
  if (body.delivery_mode !== undefined) {
    if (!['link', 'command', 'both'].includes(body.delivery_mode)) return fail('delivery_mode 无效');
    updates.push(['delivery_mode', body.delivery_mode]);
  }
  if (body.command_template !== undefined) updates.push(['command_template', String(body.command_template).slice(0, 500)]);
  if (body.r2_cdn_base !== undefined) {
    const u = String(body.r2_cdn_base).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//.test(u)) return fail('R2 CDN 域名必须以 http(s):// 开头');
    updates.push(['r2_cdn_base', u]);
  }
  if (body.gh_proxy_base !== undefined) {
    const u = String(body.gh_proxy_base).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//.test(u)) return fail('GitHub 下载代理必须以 http(s):// 开头');
    updates.push(['gh_proxy_base', u]);
  }
  if (body.share_pwd !== undefined) {
    const pwd = String(body.share_pwd);
    if (pwd === 'CLEAR' || pwd === '') {
      await delSetting(env, 'share_pwd');
    } else {
      updates.push(['share_pwd', await pbkdf2Hash(pwd)]);
    }
  }
  if (body.regenerate_apikey) {
    if ((await resolveApikey(env)).from === 'env') return fail('apikey 由环境变量 ISSUE_APIKEY 指定，无法在此重置');
    updates.push(['apikey', hex(crypto.getRandomValues(new Uint8Array(24)))]);
  }

  for (const [k, v] of updates) await setSetting(env, k, v);
  await addLog(env, 'settings_update', JSON.stringify(updates.map(([k]) => k)), clientIP(request));
  return handleSettingsGet(request, env);
}

// ---------------------------------------------------------------------------
// APIKEY 管理接口（v1.0.2）
// ---------------------------------------------------------------------------

// GET /api/admin/apikeys?page=1&size=20&q= —— 列表（key 默认脱敏）
async function handleApikeysList(request, env, url) {
  await ensureSchema(env);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const size = Math.max(1, Math.min(100, parseInt(url.searchParams.get('size'), 10) || 20));
  const q = (url.searchParams.get('q') || '').trim();
  const where = q ? 'WHERE name LIKE ?' : '';
  const like = `%${q}%`;
  const binds = q ? [like] : [];

  const total = (await env.DATABASE.prepare(`SELECT COUNT(*) n FROM apikeys ${where}`).bind(...binds).first()).n;
  const { results } = await env.DATABASE.prepare(
    `SELECT id, name, key, status, expires_at, rate_limit, rate_window, calls, created_at, last_used_at
     FROM apikeys ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, size, (page - 1) * size)
    .all();

  const orderStats = await env.DATABASE.prepare(
    'SELECT apikey_id, COUNT(*) n, COALESCE(SUM(price),0) a FROM orders GROUP BY apikey_id'
  ).all();
  const orderMap = new Map(orderStats.results.map((r) => [r.apikey_id, r]));

  const now = Date.now();
  return ok({
    list: results.map((r) => ({
      ...r,
      key: maskApiKey(r.key),
      masked: true,
      expired: !!(r.expires_at && r.expires_at < now),
      order_count: orderMap.get(r.id)?.n || 0,
      order_amount: orderMap.get(r.id)?.a || 0,
    })),
    total,
    page,
    size,
  });
}

// POST /api/admin/apikeys —— {name, expires_days, rate_limit, rate_window}
async function handleApikeyCreate(request, env) {
  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) return fail('请填写 APIKEY 名称（用于区分调用方来源）');
  const expiresDays = Math.max(0, Math.min(3650, parseFloat(body.expires_days) || 0));
  const rateLimit = Math.max(1, Math.min(100000, parseInt(body.rate_limit, 10) || 30));
  const rateWindow = Math.max(1, Math.min(86400, parseInt(body.rate_window, 10) || 60));
  const now = Date.now();
  const expiresAt = expiresDays > 0 ? now + expiresDays * 86400000 : null;

  let key = '';
  let newId = 0;
  for (let i = 0; i < 5; i++) {
    const candidate = newApiKey();
    try {
      const r = await env.DATABASE.prepare(
        'INSERT INTO apikeys(name, key, status, expires_at, rate_limit, rate_window, calls, created_at) VALUES(?,?,?,?,?,?,0,?)'
      )
        .bind(name, candidate, 'active', expiresAt, rateLimit, rateWindow, now)
        .run();
      key = candidate;
      newId = r.meta?.last_row_id || 0;
      break;
    } catch (e) {
      if (!String(e?.message || '').includes('UNIQUE')) throw e;
    }
  }
  if (!key) return fail('生成失败，请重试', 500);
  await addLog(env, 'apikey_create', JSON.stringify({ id: newId, name }), clientIP(request));
  return ok({ id: newId, name, key, expires_at: expiresAt, rate_limit: rateLimit, rate_window: rateWindow });
}

// GET /api/admin/apikeys/:id —— 查看完整密钥
async function handleApikeyGet(request, env, id) {
  await ensureSchema(env);
  const row = await env.DATABASE.prepare(
    'SELECT id, name, key, status, expires_at, rate_limit, rate_window, calls, created_at, last_used_at FROM apikeys WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!row) return fail('APIKEY 不存在', 404);
  return ok(row);
}

// PUT /api/admin/apikeys/:id —— {name?, status?, rate_limit?, rate_window?, expires_days?}
async function handleApikeyUpdate(request, env, id) {
  await ensureSchema(env);
  const row = await env.DATABASE.prepare('SELECT id FROM apikeys WHERE id = ?').bind(id).first();
  if (!row) return fail('APIKEY 不存在', 404);
  const body = await request.json().catch(() => ({}));
  const sets = [];
  const binds = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 40);
    if (!name) return fail('名称不能为空');
    sets.push('name = ?');
    binds.push(name);
  }
  if (body.status !== undefined) {
    if (!['active', 'disabled'].includes(body.status)) return fail('status 只能是 active / disabled');
    sets.push('status = ?');
    binds.push(body.status);
  }
  if (body.rate_limit !== undefined) {
    sets.push('rate_limit = ?');
    binds.push(Math.max(1, Math.min(100000, parseInt(body.rate_limit, 10) || 30)));
  }
  if (body.rate_window !== undefined) {
    sets.push('rate_window = ?');
    binds.push(Math.max(1, Math.min(86400, parseInt(body.rate_window, 10) || 60)));
  }
  if (body.expires_days !== undefined) {
    const d = Math.max(0, Math.min(3650, parseFloat(body.expires_days) || 0));
    sets.push('expires_at = ?');
    binds.push(d > 0 ? Date.now() + d * 86400000 : null);
  }
  if (!sets.length) return fail('没有可更新字段');
  await env.DATABASE.prepare(`UPDATE apikeys SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  await addLog(env, 'apikey_update', JSON.stringify({ id }), clientIP(request));
  return ok({ id });
}

// DELETE /api/admin/apikeys/:id —— 删除 key 及其调用日志
async function handleApikeyDelete(request, env, id) {
  await ensureSchema(env);
  const row = await env.DATABASE.prepare('SELECT id, name FROM apikeys WHERE id = ?').bind(id).first();
  if (!row) return fail('APIKEY 不存在', 404);
  await env.DATABASE.prepare('DELETE FROM apikeys WHERE id = ?').bind(id).run();
  await env.DATABASE.prepare('DELETE FROM apikey_logs WHERE apikey_id = ?').bind(id).run();
  await addLog(env, 'apikey_delete', JSON.stringify({ id, name: row.name }), clientIP(request));
  return ok({ id });
}

// GET /api/admin/apikeys/:id/stats?days=7 —— 单 key 调用统计
async function handleApikeyStats(request, env, url, id) {
  await ensureSchema(env);
  const row = await env.DATABASE.prepare('SELECT * FROM apikeys WHERE id = ?').bind(id).first();
  if (!row) return fail('APIKEY 不存在', 404);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days'), 10) || 7));
  const since = Date.now() - days * 86400 * 1000;

  const [logRows, orderRow] = await Promise.all([
    env.DATABASE.prepare(
      `SELECT strftime('%m-%d', created_at/1000, 'unixepoch', '+8 hours') d, ok, COUNT(*) n
       FROM apikey_logs WHERE apikey_id = ? AND created_at >= ? GROUP BY d, ok`
    )
      .bind(id, since)
      .all(),
    env.DATABASE.prepare('SELECT COUNT(*) n, COALESCE(SUM(price),0) a FROM orders WHERE apikey_id = ?')
      .bind(id)
      .first(),
  ]);

  const labels = [];
  const okMap = new Map();
  const failMap = new Map();
  for (const r of logRows.results) {
    if (r.ok) okMap.set(r.d, r.n);
    else failMap.set(r.d, r.n);
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000 + 8 * 3600 * 1000).toISOString().slice(5, 10);
    labels.push(d);
  }
  const okDaily = labels.map((d) => okMap.get(d) || 0);
  const failDaily = labels.map((d) => failMap.get(d) || 0);
  const okSum = okDaily.reduce((a, b) => a + b, 0);
  const failSum = failDaily.reduce((a, b) => a + b, 0);

  return ok({
    key: {
      id: row.id,
      name: row.name,
      key: row.key,
      status: row.status,
      expires_at: row.expires_at,
      rate_limit: row.rate_limit,
      rate_window: row.rate_window,
      calls: row.calls,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    },
    totals: { ok: okSum, fail: failSum, orders: orderRow.n || 0, revenue: orderRow.a || 0 },
    days,
    labels,
    ok_daily: okDaily,
    fail_daily: failDaily,
  });
}

// ---------------------------------------------------------------------------
// 主路由
// ---------------------------------------------------------------------------
export async function onRequest(context) {
  const { request, env, params } = context;
  const pathParts = params.path || [];
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (!env || !env.DATABASE) {
    return fail('D1 未绑定：请到 Pages 控制台为项目绑定 D1 数据库（变量名 DATABASE）', 500);
  }

  try {
    // ---- 公开 ----
    if (pathParts[0] === 'health' && method === 'GET') return handleHealth(request, env);

    if (pathParts[0] === 'public' && pathParts[1] === 'config' && method === 'GET') {
      return handlePublicConfig(request, env);
    }

    if (pathParts[0] === 'file' && method === 'GET') return handleFile(request, env, pathParts.slice(1));

    if (pathParts[0] === 's') return handleShare(request, env, pathParts.slice(1));

    if (pathParts[0] === 'issue' && method === 'POST') return handleIssue(request, env);
    if (pathParts[0] === 'redeem' && method === 'POST') return handleRedeem(request, env);

    // ---- 管理 ----
    if (pathParts[0] === 'admin') {
      const sub = pathParts.slice(1);

      if (sub[0] === 'bootstrap' && method === 'GET') return handleBootstrap(request, env);
      if (sub[0] === 'login' && method === 'POST') return adminLogin(request, env);

      const auth = await requireAdmin(request, env);
      if (auth.error) return auth.error;

      if (sub[0] === 'overview' && method === 'GET') return handleOverview(request, env);
      if (sub[0] === 'stats' && method === 'GET') return handleStats(request, env, new URL(request.url));

      if (sub[0] === 'scripts' && method === 'GET') return handleScriptsList(request, env, new URL(request.url));
      if (sub[0] === 'scripts' && method === 'POST') return handleScriptUpload(request, env);
      if (sub[0] === 'scripts' && sub[1] && method === 'PUT') return handleScriptUpdate(request, env, Number(sub[1]));
      if (sub[0] === 'scripts' && sub[1] && method === 'DELETE') return handleScriptDelete(request, env, Number(sub[1]));

      if (sub[0] === 'cards' && method === 'GET') return handleCardsList(request, env, new URL(request.url));
      if (sub[0] === 'cards' && method === 'POST') return handleCardsCreate(request, env);
      if (sub[0] === 'card-action' && method === 'POST') return handleCardAction(request, env);

      if (sub[0] === 'orders' && method === 'GET') return handleOrdersList(request, env, new URL(request.url));

      if (sub[0] === 'apikeys' && method === 'GET' && !sub[1]) return handleApikeysList(request, env, new URL(request.url));
      if (sub[0] === 'apikeys' && method === 'POST' && !sub[1]) return handleApikeyCreate(request, env);
      if (sub[0] === 'apikeys' && sub[1] && sub[2] === 'stats' && method === 'GET')
        return handleApikeyStats(request, env, new URL(request.url), Number(sub[1]));
      if (sub[0] === 'apikeys' && sub[1] && method === 'GET') return handleApikeyGet(request, env, Number(sub[1]));
      if (sub[0] === 'apikeys' && sub[1] && method === 'PUT') return handleApikeyUpdate(request, env, Number(sub[1]));
      if (sub[0] === 'apikeys' && sub[1] && method === 'DELETE') return handleApikeyDelete(request, env, Number(sub[1]));

      if (sub[0] === 'decode' && method === 'POST') return handleAdminDecode(request, env);
      if (sub[0] === 'settings' && method === 'GET') return handleSettingsGet(request, env);
      if (sub[0] === 'settings' && method === 'POST') return handleSettingsPost(request, env);

      return fail('接口不存在', 404);
    }

    return fail('接口不存在', 404);
  } catch (e) {
    console.error('API Error:', e);
    return fail(`服务器错误: ${String(e?.message || e).slice(0, 200)}`, 500);
  }
}
