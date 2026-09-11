-- 2026-09-11 desire-drive-category.sql
-- 目的：让「执念毕业进河」的驱动维标签与手动分类 kind 彻底分离，消灭同一字段两套语义的错位。
--
-- 背景（净本 §2.1 kind 词表漂移）：
--   手动 want_add 的 kind = 自由文本/分类标签（模型填，本就不该与驱动维混）
--   自动 graduateThoughts 的 kind = 驱动维中文词（「关于我们」「我的沉淀」「想去看看」）
--   两者塞进同一个 desires.kind，未来按 kind 过滤/统计会静默错位。
--
-- 方案：不动 desires.kind（保持「分类标签」语义、兼容存量），新增
--   desires.drive_category —— 仅由「执念毕业（graduateThoughts）」写入，
--   填驱动维映射出的固定中文类目；愿意用则读这列，绝不与 kind 混读。
--
-- RLS：加列不影响现有策略（列级权限未定义，沿用表级）。

-- —— 新增驱动维标签列（idempotent）——
ALTER TABLE public.desires
  ADD COLUMN IF NOT EXISTS drive_category text;

COMMENT ON COLUMN public.desires.drive_category IS
  '执念毕业（graduateThoughts）按驱动维写入的固定中文类目：关于我们 / 我的沉淀 / 想去看看。与 kind（手动分类标签）语义分离，避免两套值域混放。';

-- 可选：按驱动维统计时建索引（存量小表可省，留有注释作参考）
-- CREATE INDEX IF NOT EXISTS idx_desires_drive_category ON public.desires(drive_category);

-- —— 校验 ——
-- SELECT drive_category, count(*) FROM public.desires GROUP BY drive_category;