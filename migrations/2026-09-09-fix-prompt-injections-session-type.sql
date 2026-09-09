-- ============================================================
-- 修 prompt_injections.session_id 类型错配（2026-09-09）
--
-- 病：2026-08-30 建表时把 session_id 写成了 uuid，但本系统的 sessions.id 是**整数**
--     （1, 2, 3…）。于是 logInjection 每次插入都被 Postgres 拒绝：
--       invalid input syntax for type uuid: "1"
--     而 logInjection 是 fire-and-forget、错误只 console.warn，所以从 08-30 部署
--     那天起**一行都没写进去过**，台账至今 0 行。
--
-- 后果（这才是重点）：表达资格隔离（净本 §6 P0 边界协议，文档自己标「风险最高」）
--     整条链路是空转的 ——
--       collectInjectionNormals() 读空表 → 恒返回 []
--       → isEchoOfInjection() 恒返回 false
--       → 镜子卡的 verified = !!hit && !echo 里 echo 永远是 false
--     线上实测：64 张镜子卡，expression_eligible=false 的 **0 张**。
--     也就是说「系统注入给他读的材料，不得被当作他主动说过的话」这条铁律，
--     从来没有拦下过任何一张卡。代码接线是对的，死在一个列类型上。
--
-- 类型选择：其余表的 session_id 多数是 text（thought_pool / dialogue_residue 等），
--     一处是 bigint。这里取 text，与多数一致，也兼容 logInjection 传进来的
--     JS 值（可能是 number 也可能是 string）。
--     表是空的，所以 USING 转换零风险。
--
-- 执行：Supabase Dashboard → SQL Editor → 粘贴 → Run（幂等，可重复跑）
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'prompt_injections'
      AND column_name = 'session_id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE prompt_injections
      ALTER COLUMN session_id TYPE text USING session_id::text;
    RAISE NOTICE 'prompt_injections.session_id: uuid → text 已转换';
  ELSE
    RAISE NOTICE 'prompt_injections.session_id 已经不是 uuid，跳过';
  END IF;
END $$;

-- 核对（跑完执行，应当返回 text）：
--   SELECT data_type FROM information_schema.columns
--    WHERE table_name='prompt_injections' AND column_name='session_id';
--
-- 之后验证台账真的开始进货（等她和沈晏说几句话再看）：
--   SELECT layer, tag, left(content,40), created_at
--     FROM prompt_injections ORDER BY created_at DESC LIMIT 10;
--
-- ⚠️ 无法追溯修复：台账没有历史，所以此前 64 张镜子卡（其中 44 张 verified）
--    当时都没被真正筛过。它们若已升进 personality_claim，无法事后分辨哪些是回响。
--    要不要重审石头，是程芥的决定。
