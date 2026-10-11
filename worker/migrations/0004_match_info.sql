-- 星级、两队世界排名、AI 预测、赛事奖金 / 线下线上 / HLTV 赛事页

ALTER TABLE matches ADD COLUMN stars INTEGER;            -- bo3 的比赛星级 0–5
ALTER TABLE matches ADD COLUMN team1_rank INTEGER;       -- bo3 世界排名
ALTER TABLE matches ADD COLUMN team2_rank INTEGER;
ALTER TABLE matches ADD COLUMN ai_winner_id INTEGER;     -- AI 预测胜者的队伍 id
ALTER TABLE matches ADD COLUMN ai_s1 INTEGER;            -- AI 预测比分
ALTER TABLE matches ADD COLUMN ai_s2 INTEGER;
ALTER TABLE matches ADD COLUMN prize INTEGER;            -- 赛事总奖金（美元）
ALTER TABLE matches ADD COLUMN event_type TEXT;          -- lan / online
ALTER TABLE matches ADD COLUMN tournament_hltv TEXT;     -- HLTV 赛事页

-- 赛事信息缓存（线下 / 线上和 HLTV 链接要单独查赛事接口，一天刷新一次）
CREATE TABLE IF NOT EXISTS tournaments (
  id         INTEGER PRIMARY KEY,
  prize      INTEGER,
  event_type TEXT,
  hltv_url   TEXT,
  updated_at INTEGER
);
