/**
 * Seed the dashboard with realistic-looking test data so screens
 * (`/`, `/leads`, `/conversations`, `/analytics`) aren't empty while we
 * wait for the n8n + WhatsApp BSP integration.
 *
 * Targets only the bootstrap agent (`affiliate_marketing`) and uses a
 * sentinel `lead_phone` prefix (`+97255500000…`) so `seed:clear` can
 * remove every row this script created without touching real data.
 *
 * Run with:
 *   bun run seed:test     # idempotent: drops existing seeded rows first
 *   bun run seed:clear    # remove only the seeded rows
 *
 * Goes through the Supabase Management API (no service_role key in
 * code, no Docker).
 */

const SEED_PHONE_PREFIX = "+972555000";

interface SeedConversation {
  /** Last 4 digits to append to SEED_PHONE_PREFIX (so phones are deterministic). */
  phoneSuffix: string;
  lead_name: string;
  funnel_stage: "cold" | "mid" | "done";
  current_tag:
    | "not_hotlist"
    | "hotlist"
    | "hotlist_plus"
    | "questionnaire"
    | "zoom_scheduled"
    | "ghosted"
    | "requires_human";
  status: "active" | "paused" | "completed" | "opted_out";
  primary_objection?:
    | "action"
    | "trust"
    | "belonging"
    | "timing"
    | "money"
    | "analytical"
    | "negative"
    | "unknown";
  ai_provider_used?: "claude" | "gpt" | "manual";
  experiment_variant?: string;
  zoom_scheduled?: boolean;
  /** Hours ago — last_interaction_at = now() - this. */
  hoursAgo: number;
  quality_score?: number;
  q1_age?: number;
  q2_motivation?: string;
  q3_dream_change?: string;
  q4_blocker?: string;
  q5_urgency?: string;
  q6_investment?: string;
  red_flags?: string[];
  conversation_summary?: string;
  notes_for_advisor?: string;
  messages: Array<{ direction: "inbound" | "outbound"; content: string; minutesAgo: number }>;
}

const SEED: SeedConversation[] = [
  {
    phoneSuffix: "0001",
    lead_name: "דנה לוי",
    funnel_stage: "done",
    current_tag: "zoom_scheduled",
    status: "active",
    ai_provider_used: "claude",
    experiment_variant: "A",
    zoom_scheduled: true,
    hoursAgo: 2,
    quality_score: 92,
    q1_age: 34,
    q2_motivation: "מחפשת הכנסה נוספת מהבית",
    q3_dream_change: "פחות שעות במשרד",
    q4_blocker: "פחד מהתחלה חדשה",
    q5_urgency: "תוך כמה חודשים",
    q6_investment: "עד 5,000 ש״ח",
    conversation_summary: "אם שלושה, מנהלת חשבונות במשרה מלאה. רוצה לבנות עתודת הכנסה נוספת. דחיפות בינונית, פתוחה לזום.",
    notes_for_advisor: "לחזק תזמון: אמרה 'תוך כמה חודשים' — לתאם זום קרוב.",
    messages: [
      { direction: "inbound", content: "היי, השארתי פרטים על תכנית השותפים", minutesAgo: 240 },
      { direction: "outbound", content: "היי דנה, נעים מאוד 😊 ספרי לי מה משך אותך לתכנית?", minutesAgo: 235 },
      { direction: "inbound", content: "אני אמא לשלושה, מחפשת משהו גמיש מהבית", minutesAgo: 230 },
      { direction: "outbound", content: "מובן לחלוטין. כמה זמן את חושבת על שינוי כזה?", minutesAgo: 220 },
      { direction: "inbound", content: "כבר שנה. אני פשוט לא יודעת מאיפה להתחיל", minutesAgo: 215 },
      { direction: "outbound", content: "אנחנו פה בדיוק בשביל זה. רוצה לתאם זום קצר עם יועץ לימודים? יש לי מחר 18:00 או חמישי 11:00", minutesAgo: 130 },
      { direction: "inbound", content: "מחר 18:00 מצויין", minutesAgo: 125 },
      { direction: "outbound", content: "מעולה! שלחתי לך הזמנה במייל. נדבר מחר 🙏", minutesAgo: 120 },
    ],
  },
  {
    phoneSuffix: "0002",
    lead_name: "אבי כהן",
    funnel_stage: "mid",
    current_tag: "hotlist_plus",
    status: "active",
    ai_provider_used: "claude",
    experiment_variant: "B",
    hoursAgo: 6,
    quality_score: 85,
    q1_age: 41,
    q2_motivation: "מתעניין בערוץ הכנסה דיגיטלי",
    q5_urgency: "במהלך השנה הקרובה",
    primary_objection: "trust",
    conversation_summary: "גבר 41, עובד בהייטק, סקרן אבל זהיר. שאל הרבה שאלות עומק לפני שהשאיר פרטים אישיים.",
    messages: [
      { direction: "inbound", content: "שלום, מה זאת התכנית בעצם?", minutesAgo: 360 },
      { direction: "outbound", content: "היי אבי, התכנית מלמדת איך לבנות מקור הכנסה דיגיטלי. ספר לי קצת — מה מושך אותך?", minutesAgo: 355 },
      { direction: "inbound", content: "אני בהייטק, חושב על Plan B", minutesAgo: 350 },
      { direction: "outbound", content: "Plan B חכם. עד כמה את/ה רואה את זה בלוז שלך?", minutesAgo: 340 },
      { direction: "inbound", content: "במהלך השנה. אבל אני לא מהר לקפוץ למים. רוצה להבין דיוק מה מקבלים", minutesAgo: 320 },
      { direction: "outbound", content: "הגיוני. הדרך הכי טובה לקבל תמונה מלאה היא בזום עם יועץ. נטו 20 דקות, בלי לחץ. נתאם?", minutesAgo: 30 },
    ],
  },
  {
    phoneSuffix: "0003",
    lead_name: "מירי שטרן",
    funnel_stage: "mid",
    current_tag: "hotlist",
    status: "active",
    ai_provider_used: "claude",
    experiment_variant: "A",
    hoursAgo: 18,
    quality_score: 76,
    q1_age: 28,
    q2_motivation: "רוצה משהו משלה",
    q4_blocker: "אין הון התחלתי",
    primary_objection: "money",
    conversation_summary: "צעירה, מוטיבציה גבוהה, חוששת מההשקעה הראשונית.",
    messages: [
      { direction: "inbound", content: "אהלן! אפשר לקבל פרטים?", minutesAgo: 1080 },
      { direction: "outbound", content: "היי מירי 🙋‍♀️ ברור. מה מעניין אותך לדעת קודם?", minutesAgo: 1075 },
      { direction: "inbound", content: "כמה זה עולה?", minutesAgo: 1070 },
      { direction: "outbound", content: "המחיר משתנה לפי התאמה אישית — היועץ מסביר את זה בדיוק בזום של 20 דק'. רוצה לתאם?", minutesAgo: 1060 },
      { direction: "inbound", content: "כן בא לי, אבל לא עכשיו. אני אחזור אליך מחר", minutesAgo: 1040 },
    ],
  },
  {
    phoneSuffix: "0004",
    lead_name: "יונתן ברק",
    funnel_stage: "cold",
    current_tag: "ghosted",
    status: "paused",
    ai_provider_used: "claude",
    experiment_variant: "A",
    hoursAgo: 96,
    quality_score: 35,
    primary_objection: "timing",
    messages: [
      { direction: "inbound", content: "שלחת לי SMS, מה זה?", minutesAgo: 5800 },
      { direction: "outbound", content: "היי יונתן, השארת פרטים בפרסומת של תכנית שיווק שותפים. רוצה לדבר?", minutesAgo: 5795 },
      { direction: "inbound", content: "אולי בהמשך, עסוק עכשיו", minutesAgo: 5780 },
      { direction: "outbound", content: "בכיף. אחזור אליך עוד שבוע ✌️", minutesAgo: 5770 },
    ],
  },
  {
    phoneSuffix: "0005",
    lead_name: "תמר אבני",
    funnel_stage: "done",
    current_tag: "zoom_scheduled",
    status: "active",
    ai_provider_used: "gpt",
    experiment_variant: "B",
    zoom_scheduled: true,
    hoursAgo: 24,
    quality_score: 88,
    q1_age: 37,
    q2_motivation: "להפסיק לעבוד אצל בוס",
    q3_dream_change: "עצמאות כלכלית",
    q4_blocker: "פחד מסיכון",
    q5_urgency: "בחצי שנה",
    q6_investment: "עד 8,000 ש״ח",
    conversation_summary: "מורה, רוצה להחליף קריירה. השקעה גבוהה, מוטיבציה חזקה.",
    messages: [
      { direction: "inbound", content: "היי, השארתי פרטים", minutesAgo: 1500 },
      { direction: "outbound", content: "היי תמר! מה התחום שאת בו היום?", minutesAgo: 1495 },
      { direction: "inbound", content: "הוראה. רוצה לעזוב כבר 7 שנים", minutesAgo: 1490 },
      { direction: "outbound", content: "וואו, זה הרבה זמן לדחות חלום. מה לדעתך עוצר אותך?", minutesAgo: 1480 },
      { direction: "inbound", content: "שכר קבוע, פחד לאבד אותו", minutesAgo: 1470 },
      { direction: "outbound", content: "הגיוני לחלוטין. הדרך שלנו בנויה במיוחד לאנשים עם משכורת קבועה. רוצה לתאם זום ולשמוע איך?", minutesAgo: 1465 },
      { direction: "inbound", content: "כן! מתי אפשר?", minutesAgo: 1450 },
      { direction: "outbound", content: "יש לי מחרתיים 19:00. עובד?", minutesAgo: 1445 },
      { direction: "inbound", content: "מצוין", minutesAgo: 1440 },
    ],
  },
  {
    phoneSuffix: "0006",
    lead_name: "רן ברנע",
    funnel_stage: "cold",
    current_tag: "not_hotlist",
    status: "active",
    ai_provider_used: "claude",
    experiment_variant: "A",
    hoursAgo: 72,
    quality_score: 45,
    primary_objection: "negative",
    notes_for_advisor: "ביטל מספר פעמים תיאומים בעבר במערכת.",
    messages: [
      { direction: "inbound", content: "אני רוצה רק לקבל מידע, בלי לחץ", minutesAgo: 4320 },
      { direction: "outbound", content: "ברור, אין לחץ. ספר לי מה מעניין אותך", minutesAgo: 4315 },
      { direction: "inbound", content: "כמה הקורס", minutesAgo: 4300 },
      { direction: "outbound", content: "המחיר משתנה. נדבר על זה בזום? יש לי השבוע", minutesAgo: 4280 },
    ],
  },
  {
    phoneSuffix: "0007",
    lead_name: "נועה גרין",
    funnel_stage: "mid",
    current_tag: "questionnaire",
    status: "active",
    ai_provider_used: "claude",
    experiment_variant: "B",
    hoursAgo: 4,
    quality_score: 70,
    q1_age: 31,
    q2_motivation: "להיות אמא בבית עם פרנסה",
    primary_objection: "action",
    messages: [
      { direction: "inbound", content: "היי השארתי פרטים", minutesAgo: 240 },
      { direction: "outbound", content: "היי נועה! ספרי לי קצת על עצמך — בן/בת כמה את ומה הסיבה שהשארת פרטים?", minutesAgo: 235 },
      { direction: "inbound", content: "31, רוצה להיות עם הילד יותר", minutesAgo: 230 },
      { direction: "outbound", content: "מבינה לחלוטין. מה הכי מעכב אותך לעבור למצב כזה?", minutesAgo: 225 },
      { direction: "inbound", content: "חוסר בטחון איך מתחילים", minutesAgo: 220 },
    ],
  },
  {
    phoneSuffix: "0008",
    lead_name: "אורי שמש",
    funnel_stage: "done",
    current_tag: "opted_out",
    status: "opted_out",
    ai_provider_used: "claude",
    hoursAgo: 168,
    quality_score: 10,
    primary_objection: "negative",
    notes_for_advisor: "ביקש להפסיק. סגור — לא לפנות שוב.",
    messages: [
      { direction: "inbound", content: "מי זה?", minutesAgo: 10100 },
      { direction: "outbound", content: "היי אורי, השארת פרטים בפרסומת של תכנית שיווק שותפים", minutesAgo: 10095 },
      { direction: "inbound", content: "תורידו אותי מהרשימה", minutesAgo: 10090 },
      { direction: "outbound", content: "ברור, מסירים אותך מהרשימה. שיהיה יום נעים", minutesAgo: 10085 },
    ],
  },
];

function requireEnv(): { projectRef: string; accessToken: string } {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!projectRef) throw new Error("Missing SUPABASE_PROJECT_REF");
  if (!accessToken) throw new Error("Missing SUPABASE_ACCESS_TOKEN");
  return { projectRef, accessToken };
}

async function runSql(query: string): Promise<unknown> {
  const { projectRef, accessToken } = requireEnv();
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase Management API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function escape(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteOrNull(value: string | undefined | null): string {
  if (value === undefined || value === null) return "NULL";
  return `'${escape(value)}'`;
}

function numberOrNull(value: number | undefined | null): string {
  if (value === undefined || value === null) return "NULL";
  return value.toString();
}

function arrayOrNull(value: string[] | undefined | null): string {
  if (!value || value.length === 0) return "NULL";
  return `ARRAY[${value.map((v) => `'${escape(v)}'`).join(",")}]::text[]`;
}

function buildClearSql(agentId: string): string {
  return [
    "BEGIN;",
    `DELETE FROM public.messages WHERE conversation_id IN (SELECT id FROM public.conversations WHERE agent_id = '${agentId}' AND lead_phone LIKE '${SEED_PHONE_PREFIX}%');`,
    `DELETE FROM public.lead_memory WHERE conversation_id IN (SELECT id FROM public.conversations WHERE agent_id = '${agentId}' AND lead_phone LIKE '${SEED_PHONE_PREFIX}%');`,
    `DELETE FROM public.conversations WHERE agent_id = '${agentId}' AND lead_phone LIKE '${SEED_PHONE_PREFIX}%';`,
    "COMMIT;",
  ].join("\n");
}

function buildSeedSql(agentId: string, now: Date): string {
  const lines: string[] = ["BEGIN;"];

  for (const c of SEED) {
    const phone = `${SEED_PHONE_PREFIX}${c.phoneSuffix}`;
    const lastInteraction = new Date(now.getTime() - c.hoursAgo * 3600 * 1000).toISOString();
    const created = new Date(now.getTime() - c.hoursAgo * 3600 * 1000 - 30 * 60 * 1000).toISOString();
    const zoomScheduledAt = c.zoom_scheduled
      ? new Date(now.getTime() + 24 * 3600 * 1000).toISOString()
      : null;

    lines.push(
      `WITH new_conv AS (` +
        `INSERT INTO public.conversations ` +
        `(agent_id, lead_phone, lead_name, funnel_stage, current_tag, status, ` +
        `primary_objection, ai_provider_used, experiment_variant, last_interaction_at, ` +
        `created_at, quality_score, zoom_scheduled_at) ` +
        `VALUES (` +
        `'${agentId}', '${phone}', ${quoteOrNull(c.lead_name)}, ` +
        `${quoteOrNull(c.funnel_stage)}, ${quoteOrNull(c.current_tag)}, ${quoteOrNull(c.status)}, ` +
        `${quoteOrNull(c.primary_objection)}, ${quoteOrNull(c.ai_provider_used)}, ${quoteOrNull(c.experiment_variant)}, ` +
        `'${lastInteraction}', '${created}', ${numberOrNull(c.quality_score)}, ${quoteOrNull(zoomScheduledAt)}) ` +
        `RETURNING id) ` +
        `INSERT INTO public.lead_memory ` +
        `(conversation_id, q1_age, q2_motivation, q3_dream_change, q4_blocker, q5_urgency, q6_investment, ` +
        `conversation_summary, notes_for_advisor, red_flags, created_at, updated_at) ` +
        `SELECT id, ${numberOrNull(c.q1_age)}, ${quoteOrNull(c.q2_motivation)}, ${quoteOrNull(c.q3_dream_change)}, ` +
        `${quoteOrNull(c.q4_blocker)}, ${quoteOrNull(c.q5_urgency)}, ${quoteOrNull(c.q6_investment)}, ` +
        `${quoteOrNull(c.conversation_summary)}, ${quoteOrNull(c.notes_for_advisor)}, ` +
        `${arrayOrNull(c.red_flags)}, '${created}', '${lastInteraction}' FROM new_conv;`,
    );

    for (const m of c.messages) {
      const ts = new Date(now.getTime() - m.minutesAgo * 60 * 1000).toISOString();
      lines.push(
        `INSERT INTO public.messages (conversation_id, direction, message_type, content, timestamp) ` +
          `SELECT id, '${m.direction}', 'text', '${escape(m.content)}', '${ts}' ` +
          `FROM public.conversations WHERE agent_id = '${agentId}' AND lead_phone = '${phone}';`,
      );
    }
  }

  lines.push("COMMIT;");
  return lines.join("\n");
}

interface AgentRow {
  id: string;
  name: string;
}

async function findAgent(): Promise<AgentRow> {
  const result = (await runSql(
    `SELECT id, name FROM public.agents WHERE name = 'affiliate_marketing'`,
  )) as AgentRow[];
  if (result.length === 0) {
    throw new Error("Bootstrap agent 'affiliate_marketing' not found.");
  }
  return result[0];
}

async function seed() {
  const agent = await findAgent();
  console.log(`→ Wiping previously-seeded rows for ${agent.name}…`);
  await runSql(buildClearSql(agent.id));
  console.log(`→ Inserting ${SEED.length} seeded conversations…`);
  await runSql(buildSeedSql(agent.id, new Date()));
  console.log(`✓ Done. Seeded phone prefix: ${SEED_PHONE_PREFIX}`);
}

async function clear() {
  const agent = await findAgent();
  console.log(`→ Removing seeded rows for ${agent.name}…`);
  await runSql(buildClearSql(agent.id));
  console.log("✓ Cleared.");
}

if (import.meta.main) {
  const mode = process.argv[2];
  const action = mode === "clear" ? clear : seed;
  action().catch((err) => {
    console.error("✗ Failed:", err);
    process.exit(1);
  });
}

export { SEED, SEED_PHONE_PREFIX };
