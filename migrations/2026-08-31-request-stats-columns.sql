-- 2026-08-31 request_stats 诊断列补建（前端「命中缓存不更新」根因修复）
-- 背景：commit 6e26306（2026-08-30 21:32）给 server.js 的 recordRequestStat INSERT 加了
--   live_anchor_turn / live_collapsed / live_tokens_est 三列，但只写了 sessions 迁移
--   （2026-08-30-live-anchor.sql），没给 request_stats 建列。
--   PostgREST 对 INSERT 里未知列整行 400 → 08-30 部署后每条 request_stats 插入都失败
--   （代码 catch 后只打 warn）→ Usage 页数字冻结，命中率永远不动。
-- 本迁移把 recordRequestStat 引用的全部诊断列幂等补齐（已存在的列 IF NOT EXISTS 跳过）。
-- 执行：程芥跑（PG_CONN_STRING 在她手里）；跑完即生效，无需重启。
-- 未跑期间：server.js 已加「降级记基础行」兜底，核心 token 计数照记，诊断列宁丢。

ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS history_turns int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS frozen_turns int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS summary_present boolean;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS summary_from text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS summary_to text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS middle_raw_turns int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS live_turns int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS messages_sent int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS estimated_tokens int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS trimmed_turns int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS frozen_prefix_hash text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS summary_hash text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS live_hash text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS live_anchor_turn int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS live_collapsed boolean;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS live_tokens_est int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS resume_gap_min int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS residue_injected boolean;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS residue_text text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS memory_degraded text;
