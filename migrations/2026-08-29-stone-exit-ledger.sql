-- ============================================================
-- 2026-08-29 石头出口 + Change Ledger（更新整体框架·外部审核稿 §5 #1 / grok 收嘴 P0）
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
--
-- 做什么：
--   1. change_ledger 身份变更账本：每次石头变化（rewrite / retire / dormant / revive）
--      都留一条账（版本 / 变的是什么 / 为什么 / 支持证据 / 冲突证据 / 什么没变）。
--      没有账本，生长就是单向的——「旧人格永不退役」防不住。
--   2. settings 加 claim_dormant_days：active 主张久未验证 → dormant 的间隔（默认 30 天）。
--      dormant ≠ 证伪：只是休息，停止参与升级/审计，他再确认就从新计时复活。
-- ============================================================

-- ---------- 1. 石头变更账本 ----------
CREATE TABLE IF NOT EXISTS change_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL DEFAULT 0,              -- 对应 stone_rings.version（同一环）；0 = 不在任何环上的状态迁移
  kind text NOT NULL DEFAULT 'rewrite',        -- rewrite（他重写了石头）/ retire（主动放下，≠证伪）/ dormant（久未验证，机械）/ revive（复活）
  subject text,                                -- 变的是谁：石头全文快照（rewrite）或某条主张原文（retire/dormant/revive）
  claim_id uuid,                               -- 若与某条 personality_claim 相关，记它的 id
  reason text,                                 -- 为什么（rewrite=三问② why；retire=他说的理由）
  evidence text,                               -- 支持证据（rewrite=三问① changed / diff；retire=引用的原文）
  counter text,                                -- 冲突证据（反证/冲突卡原文）
  unchanged text,                              -- 什么没变（rewrite=三问③）
  occurred_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_change_ledger_version ON change_ledger(version);
CREATE INDEX IF NOT EXISTS idx_change_ledger_kind ON change_ledger(kind);
COMMENT ON TABLE change_ledger IS '石头变更账本：没有账本的生长是单向的（grok：防不住旧人格永远不退役）';

-- ---------- 2. 可调参数 ----------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS claim_dormant_days integer DEFAULT 30;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS mirror_sweep_hours integer DEFAULT 24;

-- 验证：
--   SELECT kind, version, left(subject, 30), occurred_at FROM change_ledger ORDER BY occurred_at DESC LIMIT 10;
--   SELECT claim, state, last_confirmed_at FROM personality_claim WHERE state='dormant' OR state='released' ORDER BY updated_at DESC LIMIT 10;
