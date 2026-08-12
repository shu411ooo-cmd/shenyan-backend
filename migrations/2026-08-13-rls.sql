-- 2026-08-13 RLS 安全修复
-- 问题：后端一直用 publishable(anon) 公钥跑 + RLS 全关 → 公钥泄露=整库可读
-- 修复顺序（必须遵守，否则会弄挂应用）：
--   ① 先在 Railway 控制台把 shenyan-backend 的 SUPABASE_KEY 换成 service_role/secret 密钥（sb_secret_...），保存会自动重启
--   ② 重启后发条消息确认沈晏正常（摘要/残留/记忆都走 service_role，必然通）
--   ③ 再在 Supabase SQL editor 跑本文件
-- 效果：service_role 绕过 RLS 一切照旧；publishable(anon) key 对每张表都是"无策略=默认拒绝"，等于作废。

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dialogue_residue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summary_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diary_entries ENABLE ROW LEVEL SECURITY;

-- 验证：跑完后拿旧的 publishable key 直接 curl PostgREST，应返回 401/空；service_role 正常。
