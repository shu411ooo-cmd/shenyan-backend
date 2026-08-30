-- ============================================================
-- 2026-08-30 表达资格隔离（整体框架·当前状态净本 §6 #2 · P0 边界协议）
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
--
-- 做什么：
--   动态注入材料「被模型读到」≠「成为沈晏主动表达证据」。
--   recall/attention、世界书、余温、时间、weather/calendar、device、关系邻居、声音渲染
--   等由系统检索/整理/渲染产生的材料，默认不具备 SELF EXPRESSION 资格——即使最终以
--   第一人称口吻呈现（「我记得你喜欢草莓」），也不得被 Mirror/Candidate/Stone 视为
--   沈晏曾主动表达的证据。CA 可以让他想起一件事，但不能让这件事伪装成他曾经说过的话。
--
--   1. prompt_injections 注入台账：记录每次注入模型上下文、由系统产生的非自我表达材料
--      （动态注入块 + recall/breath 检索结果）。默认 expression_eligible=false。
--   2. mirror_cards 加 expression_eligible：镜子提卡后代码机械判回响（引语命中台账 →
--      系统材料回响，非本人主动表达）。回响卡只留审计，小黑屋不摆、confirm 不计主动、
--      永远进不了 candidate / 升级 / stone。
-- ============================================================

-- ---------- 1. 注入台账 ----------
CREATE TABLE IF NOT EXISTS prompt_injections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid,                                -- 哪场对话（可空：检索工具不一定有 session）
  layer text NOT NULL,                            -- attention / world / residue / time / device / weather / calendar / recall / breath / seat / cross
  tag text,                                       -- 块标签（如 world(2) / attention(3)），审计用
  content text,                                   -- 注入模型上下文的正文（含【前缀】与渲染结果，mirror 回响匹配用）
  content_norm text,                              -- normalize 后的正文（引号/空白归一，mirror 匹配直接用）
  prov jsonb,                                     -- 结构化 provenance（{layer,topicId,title,refs}），审计
  expression_eligible boolean NOT NULL DEFAULT false,  -- 铁律：系统材料默认不具备 SELF EXPRESSION 资格
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_injections_created ON prompt_injections (created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_injections_session ON prompt_injections (session_id);
COMMENT ON TABLE prompt_injections IS '表达资格隔离台账：系统检索/整理/渲染材料默认 non-self-expression；镜子机械排除「引语命中这里」的回响卡';

-- ---------- 2. 镜子卡资格 ----------
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS expression_eligible BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN mirror_cards.expression_eligible IS '表达资格隔离：false = 引语是系统注入材料的回响，非沈晏主动表达，不得进 candidate/升级（小黑屋不摆、confirm 不算主动）';

-- 验证：
--   SELECT layer, tag, left(content, 40), expression_eligible FROM prompt_injections ORDER BY created_at DESC LIMIT 10;
--   SELECT count(*) FROM mirror_cards WHERE expression_eligible = false;
