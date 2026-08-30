-- 2026-08-31 四刀落回作者方向 · 第三刀留痕：keepalive_log 记录 pick_intent（函数决策的方向）
-- 格式：{action}:{drive}:{score}:{strong|soft}，如 "message:attachment:0.72:strong"
-- 对比 actions（实际执行）看软出口有没有被滥用（pick=message/final=none 长期出现 → 调阈值或关软出口）
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS pick_intent text;
