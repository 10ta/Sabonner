-- 赛段、赛事 slug、两队国家代码和队徽；每日预报的置顶消息

ALTER TABLE matches ADD COLUMN stage TEXT;            -- "decider / 3rd place"
ALTER TABLE matches ADD COLUMN tournament_slug TEXT;
ALTER TABLE matches ADD COLUMN team1_cc TEXT;          -- ISO 3166 两位代码，如 RU / FR
ALTER TABLE matches ADD COLUMN team2_cc TEXT;
ALTER TABLE matches ADD COLUMN team1_logo TEXT;
ALTER TABLE matches ADD COLUMN team2_logo TEXT;

-- 每个聊天当前置顶的日报
CREATE TABLE IF NOT EXISTS pins (
  chat_id    INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  day        TEXT NOT NULL
);

-- 订阅队伍也记下国旗和队徽
ALTER TABLE sub_teams ADD COLUMN cc TEXT;
ALTER TABLE sub_teams ADD COLUMN logo TEXT;

-- 发件队列附加信息（每日预报记日期，用于置顶）
ALTER TABLE outbox ADD COLUMN meta TEXT;
