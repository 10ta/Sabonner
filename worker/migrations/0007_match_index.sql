-- 直播轮询、赛前提醒、网页赛程都按「状态 + 开赛时间」查。以前只有状态的索引，
-- 「未开始」的比赛要整批读出来再按时间筛（D1 按读到的行数计费）；换成组合索引后只读时间窗口里的几行。
-- 只按状态查的语句也能用组合索引的前半段，所以旧索引删掉（索引越少，每次写比赛越省写入额度）
CREATE INDEX IF NOT EXISTS idx_matches_status_start ON matches(status, start_ts);
DROP INDEX IF EXISTS idx_matches_status;
