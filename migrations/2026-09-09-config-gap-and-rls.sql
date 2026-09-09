-- ============================================================
-- 补齐静默失效的配置列 + desire_notes 开 RLS（2026-09-09）
--
-- 为什么需要这个文件：2026-09-09 对着线上 settings 表逐列核对，发现
-- 8 组配置读取里有 4 组是**静默失效**的 —— 代码照常跑、不报错、无日志，
-- 但配置全部退回硬编码默认。根因两条：
--
--   ① 2026-09-03 那两个迁移（attention-satisfy-tuning / memory-gate）从没跑过；
--   ② live_max_tokens 这一列**全仓没有任何迁移创建过**，代码却在读它。
--
-- 放大机制（这才是要命的地方）：PostgREST 的 .select('a, b, c') 只要有一个列
-- 不存在，**整条查询报错**，于是 `if (error) return DEFAULTS` 让该组**全部**
-- 配置一起退回默认 —— 包括那些明明存在、你可能已经调过的列。
-- 实例：getContextConfig 只缺 live_max_tokens 一列，却导致 frozen_rounds /
-- live_rounds / max_context_tokens 这三列存在的配置也一起被忽略。
-- getAttentionConfig 同理：缺 7 列，连带 attention_k / attention_budget_chars /
-- attention_concern_threshold 这三个已存在的一起失效。
--
-- 所有 DEFAULT 值与 server.js 里的硬编码默认对齐，所以跑完这个迁移
-- **行为不变**；变的是「从此以后调 settings 真的会生效」。
--
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run（幂等，可重复跑）
-- ============================================================

-- —— ① 上下文组装：唯一缺的一列（对齐 server.js getContextConfig 的 defaults）——
-- ⚠️ 注意：净本 §4 写的是「默认 20k」，代码里实际是 40000。以代码为准，
--    文档那处需要改（2026-09-09 已记，属文档欠账不是代码 bug）。
ALTER TABLE settings ADD COLUMN IF NOT EXISTS live_max_tokens integer DEFAULT 40000;

-- —— ② 注意力召回名额与回声压制（原 2026-09-03-attention-satisfy-tuning.sql，未跑过）——
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_recent_days      integer DEFAULT 7;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_recent_seats     integer DEFAULT 3;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_assoc_seats      integer DEFAULT 2;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_24h_hours   integer DEFAULT 24;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_24h_factor  real    DEFAULT 0.5;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_72h_hours   integer DEFAULT 72;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_72h_factor  real    DEFAULT 0.8;

-- —— ③ 驱动满足回落（同上，未跑过）——
ALTER TABLE settings ADD COLUMN IF NOT EXISTS satisfy_window_hours integer DEFAULT 6;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS satisfy_factor       real    DEFAULT 0.8;

-- —— ④ 记忆写入判官开关（原 2026-09-03-memory-gate.sql，未跑过）——
ALTER TABLE settings ADD COLUMN IF NOT EXISTS memory_gate_enabled boolean DEFAULT true;

-- ============================================================
-- ⑤ desire_notes 开 RLS（Supabase Security Advisor 唯一的 Error）
--
-- 安全性已核实：后端 SUPABASE_KEY 是 sb_secret_ 开头的 secret key（等同旧
-- service_role），**绕过 RLS**；前端不直连 Supabase，只走自己后端。
-- 所以开 RLS 对现有读写零影响，只是把「任何拿到 anon key 的人都能读」这个口堵上。
-- 不加任何 policy = 除 secret key 外一律拒绝，这正是我们要的。
-- ============================================================
ALTER TABLE desire_notes ENABLE ROW LEVEL SECURITY;

-- 核对（跑完可选执行，应当返回 rowsecurity = true）：
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'desire_notes';
