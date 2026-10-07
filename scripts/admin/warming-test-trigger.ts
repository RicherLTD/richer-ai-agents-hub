/**
 * Live-test one CRM-warming status on a TEST phone, without Fireberry / n8n.
 *
 * Reproduces exactly what crm-status-webhook does for a status event (warming
 * context on the conversation + one queued opener), then forces the opener to
 * send now (the per-status delay is skipped). The dispatcher cron sends it
 * within ~1 minute; reply from the test phone and the agent answers with that
 * status's warming block injected.
 *
 * Usage:
 *   bun run scripts/admin/warming-test-trigger.ts <phone> <status_sub> [agent_name]
 *   bun run scripts/admin/warming-test-trigger.ts 0525563338 22
 *
 * Safety: refuses any phone not listed in WARMING_TEST_PHONES (comma-separated,
 * 05X or 972 format) — this script sends a real WhatsApp template, so it must
 * never point at a real lead. The conversation must already exist: send any
 * message from the test phone to the bot number once to create it.
 *
 * Required env (.env.local — Bun loads it automatically):
 *   SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN, WARMING_TEST_PHONES
 *
 * Side effects on the TEST conversation only: status→active, clears
 * current_tag / zoom state / lead_memory.red_flags (a requires_human tag would
 * make the dispatcher cancel the opener), cancels older pending warming rows.
 */

const projectRef = process.env.SUPABASE_PROJECT_REF;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!projectRef || !accessToken) {
  console.error("✗ Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN — set them in .env.local.");
  process.exit(1);
}

function canonicalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  return digits;
}

const [phoneArg, statusArg, agentArg] = process.argv.slice(2);
const statusSub = Number(statusArg);
if (!phoneArg || !Number.isInteger(statusSub)) {
  console.error("Usage: bun run scripts/admin/warming-test-trigger.ts <phone> <status_sub> [agent_name]");
  process.exit(1);
}
const phone = canonicalPhone(phoneArg);
const agentName = agentArg ?? "affiliate_marketing";

const allowed = (process.env.WARMING_TEST_PHONES ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map(canonicalPhone);
if (!allowed.includes(phone)) {
  console.error(`✗ ${phone} is not in WARMING_TEST_PHONES. This script sends a real template — test phones only.`);
  process.exit(1);
}

// Inputs are validated above (canonical digits, integer, fixed agent slug), so
// interpolating them into SQL is safe here.
if (!/^[A-Za-z_]+$/.test(agentName)) {
  console.error("✗ agent_name must be a plain slug");
  process.exit(1);
}

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T[];
}

const [rule] = await q<{
  agent_id: string;
  status_label: string;
  objection_key: string;
  is_active: boolean;
  tmpl: string | null;
  lang: string;
}>(`select a.id agent_id, r.status_label, r.objection_key, r.is_active,
           a.warming_template_name tmpl, a.warming_template_language lang
    from crm_status_rules r join agents a on a.id = r.agent_id
    where a.name = '${agentName}' and r.status_sub = ${statusSub}`);
if (!rule) {
  console.error(`✗ no crm_status_rules row for ${agentName} / status ${statusSub}`);
  process.exit(1);
}
if (!rule.is_active) {
  console.error(`✗ status ${statusSub} is disabled (is_active=false) — not a warming status`);
  process.exit(1);
}
if (!rule.tmpl) {
  console.error(`✗ agent ${agentName} has no warming_template_name`);
  process.exit(1);
}

const [conv] = await q<{ id: string }>(
  `select id from conversations where agent_id = '${rule.agent_id}' and lead_phone = '${phone}'`,
);
if (!conv) {
  console.error(`✗ no conversation for ${phone} on ${agentName}. Send any message to the bot from that phone first.`);
  process.exit(1);
}

const [tpl] = await q<{ vc: number }>(
  `select coalesce(variable_count, 0) vc from broadcast_templates
   where agent_id = '${rule.agent_id}' and name = '${rule.tmpl}' and language = '${rule.lang}'`,
);
const variables = (tpl?.vc ?? 0) > 0 ? `'["בדיקה"]'::jsonb` : `'[]'::jsonb`;

await q(`update conversations set
  status = 'active', current_tag = null, zoom_scheduled_at = null, zoom_booked_by = null,
  crm_warming_status = 'warming', crm_status_sub = ${statusSub}, crm_status_main = 1,
  crm_warming_reason = $lbl$${rule.status_label}$lbl$, crm_rep_note = null,
  crm_status_event_at = now(), crm_last_warmed_at = null
  where id = '${conv.id}'`);
await q(`update lead_memory set red_flags = '{}'::text[] where conversation_id = '${conv.id}'`);
await q(`update scheduled_messages set status = 'cancelled', last_error = 'test_reset'
  where conversation_id = '${conv.id}' and kind = 'warming' and status = 'pending'`);
await q(`insert into scheduled_messages
  (agent_id, conversation_id, lead_phone, lead_name, template_name, template_language,
   template_variables, scheduled_for, status, kind)
  values ('${rule.agent_id}', '${conv.id}', '${phone}', null, '${rule.tmpl}', '${rule.lang}',
          ${variables}, now(), 'pending', 'warming')`);

console.log(
  `✓ status ${statusSub} (${rule.status_label} / ${rule.objection_key}) armed on ${phone}. ` +
    `Opener ${rule.tmpl} goes out within ~1 min — then reply from the test phone.`,
);
