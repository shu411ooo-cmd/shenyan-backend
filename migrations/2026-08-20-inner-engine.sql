-- 内在引擎 v1（设计 docs/desire-wake-engine-design.md §5 最小闭环第①阶段）
-- ① 念头池：独立表，Thought = {text, drive_key, strength, born_at, fed_count}
--   闪念衰减（读取时按 age 投影）、反复被点升执念（fed_count++/strength 增）、
--   执念反哺驱动条、fed_count 到了却出池（status=settled）。
--   念头池 ≠ Ombre：这是「在转什么」的动力引擎，不是「记得什么」的记忆存储。
-- ② keepalive_log 加快照列：一次唤醒时的驱动条/念头池快照（面板画「当时内在状态」时间线用）。

CREATE TABLE IF NOT EXISTS thought_pool (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL,              -- 念头属于哪个会话（沈晏的意识线）
  text        text NOT NULL,              -- 念头内容（她的话 / 没说完的事 / 自己的碎语）
  drive_key   text NOT NULL DEFAULT 'curiosity',  -- attachment | reflection | fatigue | curiosity
  strength    float NOT NULL DEFAULT 0.3, -- 0~1，闪念弱、执念强
  born_at     timestamptz NOT NULL DEFAULT now(),
  fed_count   int NOT NULL DEFAULT 1,     -- 被点次数：反复被点 → 升执念
  updated_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'active'  -- active | settled（了却/毕业出池）
);

CREATE INDEX IF NOT EXISTS idx_thought_pool_active
  ON thought_pool (session_id, status, strength DESC);

-- 唤醒主记录加内在状态快照（读时若列不存在则跳过，不阻塞唤醒）
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS drive_snapshot jsonb;
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS thought_snapshot jsonb;
