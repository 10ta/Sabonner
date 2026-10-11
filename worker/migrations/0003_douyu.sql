-- 斗鱼改用手机站接口后多出的信息：头像、分类、本场开播时间（用于判断是不是同一场直播）
ALTER TABLE streamers ADD COLUMN avatar TEXT;
ALTER TABLE streamers ADD COLUMN category TEXT;
ALTER TABLE streamers ADD COLUMN show_time INTEGER;
