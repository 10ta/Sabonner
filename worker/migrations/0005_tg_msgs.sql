-- 发出的消息记录，用于自动删除（Telegram 只允许 bot 删除 48 小时内发出的消息，更早的记录没用，清理时删掉）
--   tag: pre（30 分钟提醒） live（直播卡片） map（地图结束） daily（每日预报）
CREATE TABLE IF NOT EXISTS tg_msgs (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  tag        TEXT NOT NULL,
  match_id   INTEGER,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- 发件队列里的消息类型（pre / map / end），发出后据此记录或触发删除
ALTER TABLE outbox ADD COLUMN tag TEXT;
