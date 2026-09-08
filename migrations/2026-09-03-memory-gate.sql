-- ============================================================
-- 记忆写入 Gatekeeper 判官开关（2026-09-03 落地）
-- 作用：记忆写入的单步分类调用之前加一道便宜判官——「这一窗有没有值得长期记忆的信息」。
--       判官说没有 → 直接跳过主分类（省掉读全表 topic + 带 30 条主题列表的大 prompt 分类调用）。
--       默认开启；server.js 读不到该列时同样默认开启（可先跑代码后跑迁移）。
--       判官本身调用失败 → fail-open 继续走主分类（主分类自带 should_write 门槛，安全网不丢）。
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run（幂等，可重复跑）
-- ============================================================

ALTER TABLE settings ADD COLUMN IF NOT EXISTS memory_gate_enabled boolean DEFAULT true;  -- true=写入流程先过判官；false=跳过判官直接单步分类