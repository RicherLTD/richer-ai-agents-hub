/**
 * One-off production health check — read-only.
 * Runs a set of diagnostic SELECT queries via the Supabase Management API.
 *
 *   bun run scripts/admin/health-check.ts
 */

const projectRef = process.env.SUPABASE_PROJECT_REF;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

if (!projectRef || !accessToken) {
  console.error("✗ Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN in .env.local");
  process.exit(1);
}

async function q(label: string, sql: string) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const body = await res.json();
  console.log(`\n=== ${label} ===`);
  if (!res.ok) {
    console.log("ERROR:", JSON.stringify(body));
    return;
  }
  console.log(JSON.stringify(body, null, 2));
}

const queries: [string, string][] = [
  [
    "scheduled_messages — status breakdown (last 7d)",
    `select status, count(*) as n,
            min(scheduled_for) as earliest, max(scheduled_for) as latest
     from scheduled_messages
     where created_at > now() - interval '7 days'
     group by status order by n desc;`,
  ],
  [
    "scheduled_messages — PENDING that are already overdue (should be ~0)",
    `select id, agent_id, lead_phone, template_name, scheduled_for, claimed_by_cron_id, created_at
     from scheduled_messages
     where sent_at is null
       and scheduled_for < now() - interval '5 minutes'
     order by scheduled_for asc limit 25;`,
  ],
  [
    "scheduled_messages — recent SENT (last 24h)",
    `select id, template_name, lead_phone, scheduled_for, sent_at
     from scheduled_messages
     where sent_at > now() - interval '24 hours'
     order by sent_at desc limit 25;`,
  ],
  [
    "failed_messages (DLQ) — last 7d by type",
    `select message_type, count(*) as n, max(created_at) as latest
     from failed_messages
     where created_at > now() - interval '7 days'
     group by message_type order by n desc;`,
  ],
  [
    "failed_messages (DLQ) — recent rows",
    `select id, message_type, retry_count, left(coalesce(error_message,''),200) as err, created_at
     from failed_messages
     where created_at > now() - interval '7 days'
     order by created_at desc limit 25;`,
  ],
  [
    "error_logs — last 7d by type",
    `select error_type, count(*) as n, max(created_at) as latest
     from error_logs
     where created_at > now() - interval '7 days'
     group by error_type order by n desc;`,
  ],
  [
    "error_logs — recent rows",
    `select id, error_type, left(coalesce(message,''),200) as msg, created_at
     from error_logs
     where created_at > now() - interval '7 days'
     order by created_at desc limit 25;`,
  ],
  [
    "agents — config sanity (paused / quiet hours / template / mooz)",
    `select id, name, is_paused, quiet_hours_start_il, quiet_hours_end_il,
            first_touch_template_name, first_touch_delay_minutes,
            meeting_check_enabled, operator_alert_phones
     from agents order by name;`,
  ],
];

for (const [label, sql] of queries) {
  await q(label, sql);
}
