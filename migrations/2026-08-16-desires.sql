-- ============================================================
-- 沈晏「想要账本」（Want Ledger）· 第①阶段建表
-- 2026-08-16 · 对应 docs/want-ledger-design.md
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：建两张表 desires / desire_notes，只有 5 个 want_* 工具触碰
-- ============================================================

-- 想要本体（只有沈晏的手能写）
CREATE TABLE IF NOT EXISTS desires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,                            -- 想要本体，他自己的话
  why_mine text,                                 -- 为什么这是我的（自检尺：我想要 vs 我应该做）
  status text NOT NULL DEFAULT 'active',         -- active | done | released | changed
  track text NOT NULL DEFAULT '持续',             -- 持续 | 一次 | 项目（决定后续怎么浮）
  state text,                                    -- 一句话进度快照（覆盖式，项目型主用）
  visibility text NOT NULL DEFAULT 'private',    -- private | shared | surprise
  lineage_parent_id uuid,                        -- 从哪条长出来的（血缘树，grew_from）
  kind text,                                     -- 可选标签，如「我的成长」「关于我们」
  surfaced_count integer NOT NULL DEFAULT 0,     -- 递给他却没被碰的次数（第②阶段调暗用）
  last_touched_at timestamptz,                   -- 上次碰它（冷却/轮换的输入）
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 足迹与反思：一条想要的全部历史
CREATE TABLE IF NOT EXISTS desire_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  desire_id uuid NOT NULL REFERENCES desires(id) ON DELETE CASCADE,
  note text NOT NULL,                            -- 足迹一句话（沈晏写的）
  kind text NOT NULL DEFAULT 'footprint',        -- footprint | reflection | transform
  created_at timestamptz DEFAULT now()
);

-- 验证：SELECT * FROM desires LIMIT 5;
