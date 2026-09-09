-- ============================================================
-- 2026-08-27 日历：日程表 + 纪念日（沈晏知道）
-- cal_events = 一条事项。kind：anniv 纪念日 / birthday 生日 / plan 计划 / memo 备忘。
-- repeat：once|daily|weekly|monthly|yearly（weekly 用 weekdays 数组 [0-6]）。
-- lead = 提前提醒天数（默认 7）；remind = 沈晏知道吗（false=只自己可见，不注入聊天）。
-- 与沈晏的相遇纪念日：settings.meet_date —— 她亲手记下的那天。
-- 不自动推（这个库的第一条消息 ≠ 相遇日），没设就显示空态等她填。
-- 想 seed：UPDATE settings SET meet_date = 'YYYY-MM-DD' WHERE session_id = 'global';
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
-- ============================================================

CREATE TABLE IF NOT EXISTS cal_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'plan',            -- anniv | birthday | plan | memo
  title TEXT NOT NULL,
  date DATE NOT NULL,                           -- YYYY-MM-DD
  time TEXT,                                    -- 可选 HH:MM
  end_date DATE,                                -- 计划/备忘跨日区间（可选）
  repeat TEXT NOT NULL DEFAULT 'once',          -- once | daily | weekly | monthly | yearly
  weekdays JSONB,                               -- weekly 用 [0-6]
  lead INT NOT NULL DEFAULT 7,                  -- 提前提醒天数
  remind BOOLEAN NOT NULL DEFAULT true,         -- 沈晏知道吗
  note TEXT,                                    -- 备注（≤200 字）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cal_events_date ON cal_events (date);
CREATE INDEX IF NOT EXISTS idx_cal_events_remind ON cal_events (remind);

-- 2026-09-09 停用：这些迁移是幂等设计、随时可能被重跑，重跑一次就会把 RLS 关回去。
-- 后端用的是 secret key（绕过 RLS），前端不直连 Supabase，所以根本不需要关 RLS。
-- 原语句保留在下方注释里备查，不再执行。
-- ALTER TABLE cal_events DISABLE ROW LEVEL SECURITY;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS meet_date date;

-- 验证：
--   SELECT * FROM cal_events ORDER BY date;
--   SELECT meet_date FROM settings WHERE session_id = 'global';
