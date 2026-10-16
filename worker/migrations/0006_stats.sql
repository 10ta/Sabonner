-- 赛后数据：每名选手的 K / D / A / ADR（bo3 解析完 demo 后才有，通常赛后几小时）
--   NULL 还没拿到；'[]' 超时放弃
ALTER TABLE matches ADD COLUMN stats TEXT;
