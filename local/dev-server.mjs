/**
 * ============================================================================
 *  卡密资源分发系统 v1.0.4 —— 沙盒本地运行适配器（node + node:sqlite）
 * ============================================================================
 *  作用：在沙盒 / 本地环境用 Node 直接跑起与 Cloudflare Pages 完全相同的
 *  functions/api/[[path]].js 业务代码，方便发布前自测：
 *    · D1   → node:sqlite（DatabaseSync）适配层，接口与 D1 一致；
 *             数据库文件由 .env 的 DATABASE_URI（如 file:./prisma/cards-download.db）指定
 *    · R2   → 本地目录 local/r2data/ 适配层
 *    · .env → 等价于 Pages「运行环境变量」：ADMIN_SECRET / JWT_SECRET / ISSUE_APIKEY 等
 *             （线上请到 Cloudflare Pages 控制台配置 Secret，.env 只影响沙盒）
 *
 *  运行：node local/dev-server.mjs          （前台）
 *        node local/daemon.mjs              （双 fork + setsid 孤儿进程持久化）
 *  默认端口 3000，可用 .env 的 PORT 覆盖。
 * ============================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const R2_DIR = path.join(ROOT, 'local', 'r2data');

// ---------------------------------------------------------------------------
// .env 加载：KEY=VALUE 逐行解析；已存在的环境变量优先（不覆盖）
// ---------------------------------------------------------------------------
function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  for (const [k, v] of Object.entries(out)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return out;
}
loadEnv(path.join(ROOT, '.env'));

// SQLite 数据库文件：.env 的 DATABASE_URI（Prisma 风格 file: URI），
// 如 DATABASE_URI=file:./prisma/cards-download.db；未配置时退回旧默认 local/data/cards.db
function resolveDbFile() {
  const uri = String(process.env.DATABASE_URI || '').trim();
  if (uri) {
    const p = uri.startsWith('file:') ? uri.slice(5) : uri;
    return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  }
  return path.join(ROOT, 'local', 'data', 'cards.db');
}
const DB_FILE = resolveDbFile();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const ISSUE_APIKEY = process.env.ISSUE_APIKEY || '';

// ---------------------------------------------------------------------------
// D1 适配层：node:sqlite 实现与 Cloudflare D1 相同的 prepare/bind/all/first/run/batch
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const sqlite = new DatabaseSync(DB_FILE);
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA busy_timeout = 5000;');

const normParam = (v) => (v === undefined ? null : v);

function makeBound(stmt, params) {
  return {
    async all() {
      return { results: stmt.all(...params) ?? [], success: true, meta: {} };
    },
    async first(col) {
      const row = stmt.get(...params);
      if (row == null) return null;
      return col != null ? row[col] : row;
    },
    async run() {
      const r = stmt.run(...params);
      return {
        success: true,
        meta: {
          changes: Number(r.changes ?? 0),
          last_row_id: Number(r.lastInsertRowid ?? 0),
        },
      };
    },
  };
}

const DATABASE = {
  prepare(sql) {
    // 惰性编译：node:sqlite 在 prepare 阶段就会校验表/列存在性，
    // 而 D1 是执行阶段才校验。像「同批先建表后建索引」的场景必须
    // 延迟到真正执行时才编译，才能与 D1 行为一致。
    let stmt = null;
    const get = () => (stmt ?? (stmt = sqlite.prepare(sql)));
    return {
      bind(...args) {
        return makeBound(get(), args.map(normParam));
      },
      async all() {
        return { results: get().all() ?? [], success: true, meta: {} };
      },
      async first(col) {
        const row = get().get();
        if (row == null) return null;
        return col != null ? row[col] : row;
      },
      async run() {
        const r = get().run();
        return {
          success: true,
          meta: {
            changes: Number(r.changes ?? 0),
            last_row_id: Number(r.lastInsertRowid ?? 0),
          },
        };
      },
    };
  },
  async batch(statements) {
    const out = [];
    sqlite.exec('BEGIN');
    try {
      for (const st of statements) {
        out.push(await st.run());
      }
      sqlite.exec('COMMIT');
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// R2 适配层：local/r2data/ 目录模拟存储桶
// ---------------------------------------------------------------------------
fs.mkdirSync(R2_DIR, { recursive: true });

const LOCAL_MIME = {
  ps1: 'text/plain; charset=utf-8',
  bat: 'text/plain; charset=utf-8',
  cmd: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  json: 'application/json; charset=utf-8',
};

function r2Path(key) {
  const clean = String(key)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
  return path.join(R2_DIR, clean);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value));
}

const BUCKET = {
  async put(key, value) {
    const buf = toBuffer(value);
    const p = r2Path(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return { key, size: buf.length };
  },
  async get(key) {
    const p = r2Path(key);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    const ext = String(key).split('.').pop().toLowerCase();
    const ctype = LOCAL_MIME[ext] || 'application/octet-stream';
    return {
      size: buf.length,
      body: new Uint8Array(buf),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      text: async () => buf.toString('utf8'),
      httpMetadata: { contentType: ctype },
      writeHttpMetadata(headers) {
        headers.set('Content-Type', ctype);
      },
    };
  },
  async head(key) {
    const p = r2Path(key);
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    return { size: st.size, key };
  },
  async delete(key) {
    try {
      fs.rmSync(r2Path(key), { force: true });
    } catch {}
  },
};

// ---------------------------------------------------------------------------
// 注入给业务代码的 env（等价于 Pages 绑定 + 运行环境 Secret）
// ---------------------------------------------------------------------------
const env = {
  DATABASE,
  BUCKET,
  ADMIN_SECRET,
  JWT_SECRET,
  ISSUE_APIKEY,
};

// ---------------------------------------------------------------------------
// 载入与线上一模一样的业务处理函数
// ---------------------------------------------------------------------------
const handlerUrl = pathToFileURL(path.join(ROOT, 'functions', 'api', '[[path]].js')).href;
const { onRequest } = await import(handlerUrl);

// ---------------------------------------------------------------------------
// HTTP 服务：/api/* 走业务代码，其余按 Pages 静态资源规则服务 public/
// ---------------------------------------------------------------------------
const STATIC_TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html'; // 与 Pages 优雅 URL 行为一致
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // /api/* 走业务路由；/s/* 加密分享路由同样进入 functions 路由器
    const isApi = u.pathname === '/api' || u.pathname.startsWith('/api/');
    const isShare = u.pathname === '/s' || u.pathname.startsWith('/s/');

    if (isApi || isShare) {
      const body = await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'content-length') continue;
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v != null) headers.set(k, v);
      }
      if (!headers.has('x-forwarded-for')) {
        headers.set('x-forwarded-for', req.socket.remoteAddress || '127.0.0.1');
      }
      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD' && body) {
        init.body = body;
      }
      const webReq = new Request(u.origin + u.pathname + u.search, init);
      const pathParts = isShare
        ? u.pathname.split('/').filter(Boolean) // ['s', '<token>']
        : u.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
      const webRes = await onRequest({ request: webReq, env, params: { path: pathParts } });
      const outBuf = Buffer.from(await webRes.arrayBuffer());
      const outHeaders = {};
      webRes.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(webRes.status, outHeaders);
      res.end(req.method === 'HEAD' ? undefined : outBuf);
      log(req.method, u.pathname, webRes.status, Date.now() - started);
      return;
    }

    serveStatic(u.pathname, res);
    log(req.method, u.pathname, 200, Date.now() - started);
  } catch (e) {
    console.error('[cards-dev] 请求处理失败:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, error: '本地服务器错误: ' + String(e?.message || e) }));
  }
});

function log(method, p, status, ms) {
  console.log(`[cards-dev] ${method} ${p} → ${status} (${ms}ms)`);
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[cards-dev] 端口 ${PORT} 已被占用。如旧实例未退出：pkill -f dev-server.mjs`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('══════════════════════════════════════════════════');
  console.log('  卡密资源分发系统 v1.0.4 · 沙盒本地服务已启动');
  console.log(`  提取页   http://127.0.0.1:${PORT}/`);
  console.log(`  管理面板 http://127.0.0.1:${PORT}/admin`);
  console.log(`  健康检查 http://127.0.0.1:${PORT}/api/health`);
  console.log(`  D1 适配  node:sqlite → ${DB_FILE}`);
  console.log(`  R2 适配  本地目录   → ${R2_DIR}`);
  console.log(`  ADMIN_SECRET ${ADMIN_SECRET ? '已从 .env 加载 ✓' : '未配置 ✗（提取页可用，管理面板不可登录）'}`);
  console.log(`  JWT_SECRET   ${JWT_SECRET ? '已配置 ✓（/s/ 加密分享可用）' : '未配置（退回用 ADMIN_SECRET 派生）'}`);
  console.log('══════════════════════════════════════════════════');
});
