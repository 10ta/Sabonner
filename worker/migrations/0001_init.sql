-- Sabonner D1 表结构
-- 初始表结构（npx wrangler d1 migrations apply sabonner --remote 自动执行）

-- 杂项键值（上次刷新时间等）
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 订阅：队伍（bo3 team id）
CREATE TABLE IF NOT EXISTS sub_teams (
  team_id  INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  slug     TEXT,
  added_at INTEGER
);

-- 订阅：tier（s / a / b / c）
CREATE TABLE IF NOT EXISTS sub_tiers (
  tier TEXT PRIMARY KEY
);

-- 订阅：斗鱼房间
CREATE TABLE IF NOT EXISTS streamers (
  room_id    TEXT PRIMARY KEY,
  owner      TEXT,
  title      TEXT,
  live       INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER,
  added_at   INTEGER
);

-- TG 用户：owner 不在此表，由 OWNER_ID 决定
-- status: pending / approved / denied
CREATE TABLE IF NOT EXISTS users (
  tg_id      INTEGER PRIMARY KEY,
  name       TEXT,
  username   TEXT,
  status     TEXT NOT NULL,
  created_at INTEGER
);

-- 跟踪中的比赛（命中订阅的才会存）
CREATE TABLE IF NOT EXISTS matches (
  id         INTEGER PRIMARY KEY,
  slug       TEXT,
  team1_id   INTEGER,
  team2_id   INTEGER,
  team1      TEXT,
  team2      TEXT,
  tournament TEXT,
  tier       TEXT,
  bo         INTEGER,
  start_ts   INTEGER,           -- 秒
  status     TEXT,              -- upcoming / current / finished / ...
  s1         INTEGER DEFAULT 0, -- 大比分
  s2         INTEGER DEFAULT 0,
  winner_id  INTEGER,
  maps       TEXT,              -- JSON：[{n, map, status, w, l, wn}]
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_matches_start ON matches(start_ts);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

-- 已发送事件（去重）
CREATE TABLE IF NOT EXISTS sent (
  key TEXT PRIMARY KEY,
  at  INTEGER
);

-- 每场直播在每个聊天里的"可编辑比分消息"
CREATE TABLE IF NOT EXISTS live_msgs (
  match_id   INTEGER,
  chat_id    INTEGER,
  message_id INTEGER,
  PRIMARY KEY (match_id, chat_id)
);

-- 发件队列：超出本次调用子请求预算的消息留到下一分钟
-- kind: send / live_open / live_edit
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  match_id   INTEGER,
  created_at INTEGER,
  tries      INTEGER NOT NULL DEFAULT 0
);
