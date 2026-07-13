/**
 * One-off read-only diagnostic: why do bot-booked zooms not reach Fireberry?
 * Traces the chain: bot book_meeting → mooz-webhook → handoff webhook → Make → Fireberry.
 *   bun run scripts/admin/zoom-handoff-diag.ts
 */
const projectRef = process.env.SUPABASE_PROJECT_REF;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!projectRef || !accessToken) {
  console.error("✗ Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN");
  process.exit(1);
}
async function q(label: string, sql: string) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    },
  );
  const body = await res.json();
  console.log(`\n=== ${label} ===`);
  console.log(res.ok ? JSON.stringify(body, null, 2) : "ERROR: " + JSON.stringify(body));
}
const queries: [string, string][] = [
  [
    "conversations tagged zoom_scheduled (last 30d) by zoom_booked_by",
    `select zoom_booked_by, count(*) n, max(zoom_scheduled_at) latest
     from conversations
     where current_tag='zoom_scheduled' and zoom_scheduled_at > now() - interval '30 days'
     group by zoom_booked_by order by n desc;`,
  ],
  [
    "did Mooz ever call mooz-webhook? mooz_webhook_events (last 30d)",
    `select event, count(*) n, min(received_at) earliest, max(received_at) latest
     from mooz_webhook_events
     where received_at > now() - interval '30 days'
     group by event order by n desc;`,
  ],
  [
    "error_logs from mooz-webhook + handoff (last 30d)",
    `select error_type, count(*) n, max(created_at) latest
     from error_logs
     where created_at > now() - interval '30 days'
       and (source='mooz-webhook' or error_type like '%handoff%' or error_type like '%mooz%')
     group by error_type order by n desc;`,
  ],
  [
    "recent bot-booked zooms — was a Mooz event ever recorded for them?",
    `select c.id, c.lead_phone, c.zoom_booked_by, c.zoom_scheduled_at,
            (select count(*) from mooz_webhook_events e where e.received_at >= c.zoom_scheduled_at - interval '1 day') as mooz_events_near
     from conversations c
     where c.current_tag='zoom_scheduled' and c.zoom_scheduled_at > now() - interval '30 days'
     order by c.zoom_scheduled_at desc limit 20;`,
  ],
  [
    "raw recent mooz-webhook/handoff error_log messages",
    `select error_type, left(coalesce(message,''),240) msg, created_at
     from error_logs
     where created_at > now() - interval '30 days'
       and (source='mooz-webhook' or error_type like '%handoff%' or error_type like '%mooz%')
     order by created_at desc limit 25;`,
  ],
];
for (const [label, sql] of queries) await q(label, sql);
