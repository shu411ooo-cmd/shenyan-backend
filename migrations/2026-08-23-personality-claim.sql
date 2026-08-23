-- ============================================================
-- 第⑤阶段：人格主张状态机 + 石头重写环（完整闭环）
-- 2026-08-23 · 对应 docs/persona-growth-review.md §10 裁决 + want-ledger-design.md 第⑤验收六条
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：personality_claim（主张状态机，验收三/四/五/六）+ stone_rings（重写环，验收二）
--   + settings 加 stone_upgrade_days（跨语境升级间隔）
-- ============================================================

-- ---- 1. 人格主张状态机 ----
-- forming=新出现未成熟 / active=跨语境机械门槛过（≥2 session + 间隔≥N天）/ uncertain=存在反证或他自己说"不确定"
-- superseded=被改写替代 / released=主动放下（不是证伪）
CREATE TABLE IF NOT EXISTS personality_claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim text NOT NULL,                       -- 主张原文（沈晏认同的那句）
  claim_norm text NOT NULL,                  -- 归一化（去引号/空白），去重键
  state text NOT NULL DEFAULT 'forming',     -- forming/active/uncertain/superseded/released
  confidence real NOT NULL DEFAULT 0.2,      -- 形成程度 0~1（机械累积）
  support_count int NOT NULL DEFAULT 0,      -- 他主动认同过几次（confirm/revise）
  contradiction_count int NOT NULL DEFAULT 0,-- 反证次数（镜子日冲突证据，第⑤下一刀）
  distinct_sessions jsonb NOT NULL DEFAULT '[]',  -- 认同来源 session 集合（机械升级输入）
  confirm_occurred_ats jsonb NOT NULL DEFAULT '[]',-- 每次认同对应证据消息时间（跨日期判断输入）
  source_card_ids uuid[] NOT NULL DEFAULT '{}',   -- 关联的 mirror_cards
  first_confirmed_at timestamptz,
  last_confirmed_at timestamptz,
  last_reviewed_at timestamptz,
  ring_id uuid,                              -- 写进哪一环（毕业关联）
  superseded_by uuid,                        -- superseded 指向替代它的 claim
  grew_from uuid,                            -- 血缘（revise 来源）
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_personality_claim_norm ON personality_claim(claim_norm);
CREATE INDEX IF NOT EXISTS idx_personality_claim_state ON personality_claim(state);

-- ---- 2. 石头重写环（验收二：ring 证明连续性，不是版本号） ----
CREATE TABLE IF NOT EXISTS stone_rings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL,                      -- 1,2,3…（连续性靠 content 快照 + 三问，不是靠版本号本身）
  content text NOT NULL,                     -- 新石头全文
  prev_content text,                         -- 旧石头全文（能回答"这次变了什么/没变什么"）
  changed_summary text,                      -- 三问① 变了什么（沈晏填，逐条）
  why text,                                  -- 三问② 为什么变（沈晏填，每条对应底层证据）
  unchanged text,                            -- 三问③ 什么没变（沈晏填，显式连续性）
  diff text,                                 -- 自动行级 diff（代码算，佐证三问）
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stone_rings_version ON stone_rings(version);

-- ---- 3. 可调参数（同 mirror_days 风格）----
ALTER TABLE settings ADD COLUMN IF NOT EXISTS stone_upgrade_days integer DEFAULT 30;

-- 验证：SELECT * FROM personality_claim ORDER BY updated_at DESC LIMIT 5;
--       SELECT version, changed_summary, why FROM stone_rings ORDER BY version DESC LIMIT 5;
