-- ============================================================
-- dyad：domain 字段（me / we）——「我们之间」的形成通道
-- 2026-08-30 · 对应 docs/dyad-design.md（定稿：宪法家锁 A = claim 带 domain）
-- 效果：personality_claim 加 domain；mirror_cards 加 domain + speaker（双证机械输入）
--   去重键从 claim_norm 放宽到 (domain, claim_norm)（me/we 不互相验证，可并存同文）
-- 执行：PG_CONN_STRING="..." node scripts/run-dyad-domain-migration.cjs
-- ============================================================

ALTER TABLE personality_claim ADD COLUMN IF NOT EXISTS domain text DEFAULT 'me';
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS domain text DEFAULT 'me';
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS speaker text;   -- 'user'=她 / 'assistant'=沈晏，机械标注（双证输入）

-- me/we 隔离：去重键按 domain 分开（原 claim_norm 唯一 → (domain, claim_norm) 唯一）
DROP INDEX IF EXISTS idx_personality_claim_norm;
CREATE UNIQUE INDEX IF NOT EXISTS idx_personality_claim_domain_norm ON personality_claim(domain, claim_norm);
CREATE INDEX IF NOT EXISTS idx_personality_claim_domain ON personality_claim(domain);
CREATE INDEX IF NOT EXISTS idx_mirror_cards_domain ON mirror_cards(domain);

-- 验证：
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='personality_claim' AND column_name='domain';
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='mirror_cards' AND column_name IN ('domain','speaker');
--   SELECT indexname FROM pg_indexes WHERE tablename='personality_claim';
