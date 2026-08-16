-- 对话直发：keepalive 留言直接合并进 messages 对话流（她回来在对话里看到，不再走信箱 UI）。
-- source：区分「唤醒独白」(keepalive) 与普通对话消息；未来前端可据此给「趁你不在留的」加标注。
-- merged：标记该留言是否已合并进 messages——未合并的（部署前的旧留言 / 合并失败）继续走动态区注入兜底，不丢。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS merged boolean DEFAULT false;
