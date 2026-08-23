-- ============================================================
-- 第⑥阶段：念头池接通（池→河→石头）· 2026-08-23
-- 对应 docs/want-phase6-thought-ledger.md
-- 效果：thought_pool 加指纹（反复被点判定）+ 毕业血缘（池→河）
-- ============================================================

-- fingerprint: 核心词指纹（去停用词后首 4 字）——同指纹念头反复入池 = 反复被点 → 升执念
ALTER TABLE thought_pool ADD COLUMN IF NOT EXISTS fingerprint text;

-- desire_id: 毕业进河后的血缘（settled 念头指向写下的想要）——「这条执念沉成了哪条想要」
ALTER TABLE thought_pool ADD COLUMN IF NOT EXISTS desire_id uuid;

-- 验证：SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'thought_pool' AND column_name IN ('fingerprint','desire_id');
