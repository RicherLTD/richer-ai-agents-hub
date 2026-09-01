-- 0048_warming_config_affiliate.sql
--
-- CRM-warming per-status CONFIG for the affiliate_marketing agent, agreed in the
-- objection-handling workshop (docs/superpowers/plans/...-crm-warming-objection).
--
-- Scope: affiliate_marketing ONLY. Other agents (digital_marketing, Leon_Richi)
-- keep their seeded defaults from 0046/0047.
--
-- This is PURE CONFIG. It does NOT enable warming (agents.crm_warming_enabled)
-- and does NOT wire any lead flow. Nothing reaches a real lead from this file.
--
-- Idempotent: re-running sets the same values.

-- 1) Disable statuses that are dead or not warming-relevant for this product:
--    3  = "אין-מענה 2"        — Izak: don't touch this stage at all
--    5  = "אין-מענה 4"        — Izak: don't send
--    16 = "אורך הקורס"        — nobody actually raises this objection
--    19 = "תכנים חסרים"       — lead understood in the call and wasn't interested
update public.crm_status_rules r
set is_active = false
from public.agents a
where r.agent_id = a.id
  and a.name = 'affiliate_marketing'
  and r.status_sub in (3, 5, 16, 19);

-- 2) Custom send delays (hours) agreed per status. Values not listed here
--    (e.g. 14 "מחיר" = current 360h, and the no-answer openers 2/6/7) are left
--    untouched pending explicit confirmation.
update public.crm_status_rules r
set delay_hours = v.delay_hours
from public.agents a,
     (values
        (26, 96),   -- דחוי מימון (סורב הלוואה): 4 ימים לקירור הסירוב
        (54, 0),    -- אין כסף: מיידי (אין רגע-סירוב)
        (80, 168),  -- "לא בשבילי" (התנגדות ערך): 7 ימים
        (51, 48),   -- חשב שחינם: יומיים
        (18, 0),    -- אמון במוצר: מיידי
        (58, 0),    -- אמון בחברה: מיידי
        (59, 0),    -- ביקורות שליליות: מיידי
        (55, 24),   -- ניסיון שלילי: 24 שעות
        (60, 1),    -- אין זמן: שעה
        (72, 0),    -- מנתק מנומס: מיידי
        (73, 0),    -- ניתק בפתיח: מיידי
        (77, 0),    -- לא מתחבר לתחום: מיידי
        (15, 0),    -- מתחרים: מיידי
        (56, 48),   -- אמונה עצמית: 48 שעות
        (20, 0),    -- חוסר כימיה: מיידי
        (76, 720),  -- בן/בת זוג (הוריד עסקה): 30 יום
        (50, 48),   -- מסרב לפרט: יומיים
        (21, 0),    -- מסנן (בורח מהמוכר): מיידי
        (23, 0),    -- לא רציני: מיידי
        (24, 0),    -- אחר: מיידי
        (52, 48),   -- אנטיגוניזם למשפך: 48 שעות (קירור רגשות)
        (91, 24),   -- הבריז מזום: 24 שעות
        (47, 0),    -- ל״ב אחר: מיידי
        (22, 720)   -- פוטנציאל עתידי: 30 יום
     ) as v(status_sub, delay_hours)
where r.agent_id = a.id
  and a.name = 'affiliate_marketing'
  and r.status_sub = v.status_sub;
