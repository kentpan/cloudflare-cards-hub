-- ============================================================
-- 卡密资源分发系统 v1.0.4 —— D1 建表脚本（可选）
-- 本文件随包放在 prisma/ 目录下；沙盒本地 SQLite 数据库文件路径
-- 由 .env 的 DATABASE_URI 指定（默认 file:./prisma/cards-download.db）。
-- 线上 D1 建表以系统自动幂等建表为准，手动执行本文件仅提前初始化，两者等价。
-- 系统在首次收到 API 请求时会自动执行等价的幂等建表 + 增量迁移，
-- 手动执行本文件只是提前初始化，两者完全等价。
-- ============================================================

CREATE TABLE IF NOT EXISTS scripts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,               -- 管理名称
  filename   TEXT NOT NULL,               -- 原始文件名
  path       TEXT NOT NULL,               -- R2 对象路径（外链资源 = 完整 URL）
  type       TEXT NOT NULL DEFAULT 'ps1', -- 扩展名（ps1/zip/exe/… 任意类型）
  size       INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_key      TEXT NOT NULL UNIQUE,     -- 8 位大小写英文 + 数字
  script_id     INTEGER,                  -- 绑定资源（资源删除后置 NULL）
  max_uses      INTEGER NOT NULL DEFAULT 1,
  used_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,                  -- 毫秒时间戳，NULL = 永久
  note          TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active', -- active | revoked
  created_at    INTEGER NOT NULL,
  first_used_at INTEGER,
  last_used_at  INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_key    TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',   -- 商品名称（咸鱼对接 title）
  price       REAL NOT NULL DEFAULT 0,    -- 交易金额
  status      TEXT NOT NULL DEFAULT 'paid', -- paid | used | refunded
  source      TEXT NOT NULL DEFAULT 'api',  -- api | manual
  apikey_id   INTEGER,                    -- 发卡调用的 APIKEY（v1.0.2）
  apikey_name TEXT NOT NULL DEFAULT '',   -- APIKEY 名称快照（调用方来源）
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apikeys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,             -- 调用方名称（如：咸鱼主号）
  key          TEXT NOT NULL UNIQUE,      -- ak- 前缀 + 30 位十六进制
  status       TEXT NOT NULL DEFAULT 'active', -- active | disabled
  expires_at   INTEGER,                   -- 毫秒时间戳，NULL = 永久
  rate_limit   INTEGER NOT NULL DEFAULT 30, -- 窗口内最大调用次数
  rate_window  INTEGER NOT NULL DEFAULT 60, -- 限速窗口（秒）
  calls        INTEGER NOT NULL DEFAULT 0,  -- 累计成功调用
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS apikey_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  apikey_id  INTEGER NOT NULL DEFAULT 0,  -- 0 = 旧版单密钥 / 未识别 key
  ok         INTEGER NOT NULL DEFAULT 1,
  status     INTEGER NOT NULL DEFAULT 200,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,               -- issue / redeem / login_ok / ...
  detail     TEXT DEFAULT '',
  ip         TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_apikey_logs_time ON apikey_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_apikey_logs_key ON apikey_logs(apikey_id, created_at);
