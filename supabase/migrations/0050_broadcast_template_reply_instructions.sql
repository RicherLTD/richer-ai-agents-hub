-- 0050_broadcast_template_reply_instructions.sql
--
-- Per-template guidance for the bot when a lead replies to a broadcast.
-- broadcastRewarmBlock.ts renders it under "## How to handle this lead" as the
-- operator's guidance for that specific message, on top of the generic
-- re-warm rules every broadcast reply already gets. NULL = generic rules only.
--
-- Additive and idempotent. Also seeds the two follow-up templates registered
-- on 2026-10-22 (folo_up1 / folo_up1_affiliate); a missing row is a no-op.

alter table public.broadcast_templates
  add column if not exists reply_instructions text;

update public.broadcast_templates
set reply_instructions = $w$ההודעה שאלה אם זה עדיין רלוונטי לו או שהוא כבר ירד מזה — התשובה שלו היא נקודת הפתיחה.
אם ענה שכן, זה עדיין מעניין אותו: שמח בפשטות, ושאל מה השתנה אצלו מאז או למה זה רלוונטי דווקא עכשיו. משם חמם מחדש — מה הוא רוצה לשנות היום, ומה עוצר אותו היום. אם אתה יודע משהו ממה שסיפר בעבר, הזכר אותו בעדינות כשאלה ("פעם קודמת סיפרת ש... זה עדיין ככה?"), לא כעובדה.
אם ענה שירד מזה: אל תיפרד ואל תנסה לשכנע. שאל בסקרנות אמיתית מה גרם לו לרדת מזה, ועבוד עם הסיבה שהוא נותן. רק סירוב ברור וחוזר הוא "לא".
אם ענה "כן, אבל..." — התייחס קודם ל"אבל".$w$
where name in ('folo_up1', 'folo_up1_affiliate')
  and reply_instructions is null;
