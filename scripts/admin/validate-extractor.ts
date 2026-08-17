/**
 * Validate the memory extractor against known-good historical data.
 *
 * WHY THIS EXISTS
 * The extractor was ~95% broken between roughly 2026-06-28 and 2026-07-29:
 * it received the agent's own alternating message array plus a bare `{`
 * assistant prefill, so Haiku answered as the bot ("{wait_for_response}")
 * instead of emitting JSON. 1,210 parse failures in 14 days. Despite that,
 * ~150 `lead_memory` rows DID get a real `q1_age` from the ~5% of calls
 * that happened to work.
 *
 * Those rows are free ground truth. This script re-runs the FIXED extractor
 * over exactly those conversations and diffs its output against what is
 * stored, so we can prove the fix before writing anything to 1,349 rows.
 *
 * SAFETY — this script is STRICTLY READ-ONLY.
 *   • It issues SELECTs only. There is no insert/update/upsert/delete here.
 *   • It calls `callMemoryExtractor`, the pure model call, NOT
 *     `runMemoryExtraction`. That matters: runMemoryExtraction writes
 *     lead_memory, recomputes tags and funnel_stage, and can FIRE THE
 *     HANDOFF WEBHOOK — which for a months-old lead would create a real
 *     Mooz booking and alert a real advisor.
 *   • It never posts to Langfuse, so validation runs cannot pollute
 *     production traces or scores.
 *
 * RUNTIME — Deno, not bun. It imports edge-function code that uses URL
 * imports, so it must run under the same runtime as production:
 *
 *   deno run --allow-env --allow-net scripts/admin/validate-extractor.ts
 *
 * Add --allow-write only if you pass --out (writing the JSON report).
 *
 * Required env (same names as everywhere else in the repo):
 *   VITE_SUPABASE_URL (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY   — read-only use here, but it bypasses RLS
 *   ANTHROPIC_API_KEY
 *
 * Flags:
 *   --limit N     how many known-good conversations to test (default 150)
 *   --agent SLUG  restrict to one agent (e.g. affiliate_marketing)
 *   --out FILE    also write the full JSON report to FILE
 *   --verbose     print every row, not just disagreements
 *
 * Exit code is 0 when the run completes, 1 on a configuration error. A poor
 * agreement rate is reported, not thrown — interpreting it is your job.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import {
  callMemoryExtractor,
  type ExtractedMemory,
  MEMORY_EXTRACTOR_MODEL,
} from "../../supabase/functions/_shared/extractMemory.ts";

// Mirrors the live agent loop: it passes the last 30 messages, oldest first.
const HISTORY_LIMIT = 30;

// Haiku 4.5 list pricing, USD per token. Only used for a rough cost line.
const HAIKU_INPUT_PER_TOKEN = 0.000001;
const HAIKU_OUTPUT_PER_TOKEN = 0.000005;

function arg(name: string): string | null {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}
const hasFlag = (name: string) => Deno.args.includes(`--${name}`);

const limit = Number(arg("limit") ?? "150");
const agentFilter = arg("agent");
const outFile = arg("out");
const verbose = hasFlag("verbose");

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

if (!supabaseUrl || !serviceKey) {
  console.error("✗ Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}
if (!anthropicKey) {
  console.error("✗ Missing ANTHROPIC_API_KEY");
  Deno.exit(1);
}
if (!Number.isFinite(limit) || limit < 1) {
  console.error("✗ --limit must be a positive number");
  Deno.exit(1);
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anthropic = new Anthropic({ apiKey: anthropicKey });

/** Fields compared exactly. These are structured, so a mismatch is a real
 *  disagreement rather than a wording difference. */
const EXACT_FIELDS = ["q1_age", "q7_email", "meeting_consented"] as const;
/** Free-text fields. Two extractions will almost never phrase these
 *  identically, so we compare PRESENCE (both said something / both said
 *  nothing) rather than pretending string equality means anything. */
const PRESENCE_FIELDS = [
  "q2_motivation",
  "q3_dream_change",
  "q4_blocker",
  "q5_urgency",
  "q6_investment",
  "conversation_summary",
  "primary_objection",
  "notes_for_advisor",
] as const;

interface StoredRow {
  conversation_id: string;
  q1_age: number | null;
  q2_motivation: string | null;
  q3_dream_change: string | null;
  q4_blocker: string | null;
  q5_urgency: string | null;
  q6_investment: string | null;
  q7_email: string | null;
  meeting_consented_at: string | null;
  conversation_summary: string | null;
  primary_objection: string | null;
  red_flags: string[] | null;
  notes_for_advisor: string | null;
  conversations: { agent_id: string; agents: { name: string } | null } | null;
}

interface RowReport {
  conversationId: string;
  agent: string;
  messages: number;
  extraction: "ok" | "failed";
  failureOutcome?: string;
  exact: Record<string, { stored: unknown; fresh: unknown; agree: boolean }>;
  presence: Record<string, { stored: boolean; fresh: boolean; agree: boolean }>;
  redFlagsStored: string[];
  redFlagsFresh: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

console.log(
  `→ Validating ${MEMORY_EXTRACTOR_MODEL} against up to ${limit} known-good conversations` +
    (agentFilter ? ` (agent=${agentFilter})` : "") + `\n  READ-ONLY: no writes, no handoffs, no Langfuse.\n`,
);

// 1. Ground truth: rows the OLD extractor managed to populate.
let query = admin
  .from("lead_memory")
  .select(
    "conversation_id, q1_age, q2_motivation, q3_dream_change, q4_blocker, q5_urgency, " +
      "q6_investment, q7_email, meeting_consented_at, conversation_summary, " +
      "primary_objection, red_flags, notes_for_advisor, " +
      "conversations!inner(agent_id, agents!inner(name))",
  )
  .not("q1_age", "is", null)
  .limit(limit);
if (agentFilter) query = query.eq("conversations.agents.name", agentFilter);

const { data: storedRows, error: storedErr } = await query;
if (storedErr) {
  console.error(`✗ Failed to load ground truth: ${storedErr.message}`);
  Deno.exit(1);
}
const rows = (storedRows ?? []) as unknown as StoredRow[];
if (rows.length === 0) {
  console.error("✗ No rows with a non-null q1_age found — nothing to validate against.");
  Deno.exit(1);
}
console.log(`  found ${rows.length} ground-truth conversations\n`);

// 2. Active memory_extractor prompt per agent (same lookup the live path uses).
const promptCache = new Map<string, string>();
async function activeExtractorPrompt(agentId: string): Promise<string | null> {
  const cached = promptCache.get(agentId);
  if (cached) return cached;
  const { data } = await admin
    .from("prompts")
    .select("content")
    .eq("agent_id", agentId)
    .eq("prompt_type", "memory_extractor")
    .eq("is_active", true)
    .maybeSingle();
  const content = (data?.content as string | undefined) ?? null;
  if (content) promptCache.set(agentId, content);
  return content;
}

/** Rebuild the message array the live extractor would have seen. */
async function loadHistory(
  conversationId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { data } = await admin
    .from("messages")
    .select("direction, content, timestamp")
    .eq("conversation_id", conversationId)
    .order("timestamp", { ascending: false })
    .limit(HISTORY_LIMIT);
  const ordered = (data ?? []).slice().reverse();
  return ordered
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
    .map((m) => ({
      role: (m.direction === "inbound" ? "user" : "assistant") as "user" | "assistant",
      content: (m.content as string).trim(),
    }));
}

const reports: RowReport[] = [];
let processed = 0;

for (const row of rows) {
  processed += 1;
  const agentId = row.conversations?.agent_id ?? "";
  const agentName = row.conversations?.agents?.name ?? "unknown";
  const systemPrompt = agentId ? await activeExtractorPrompt(agentId) : null;
  if (!systemPrompt) {
    console.log(`  [${processed}/${rows.length}] ${row.conversation_id} — SKIP (no active prompt)`);
    continue;
  }

  const history = await loadHistory(row.conversation_id);
  if (history.length === 0) {
    console.log(`  [${processed}/${rows.length}] ${row.conversation_id} — SKIP (no messages)`);
    continue;
  }

  const result = await callMemoryExtractor({ anthropic, systemPrompt, claudeMessages: history });

  const report: RowReport = {
    conversationId: row.conversation_id,
    agent: agentName,
    messages: history.length,
    extraction: result.ok ? "ok" : "failed",
    exact: {},
    presence: {},
    redFlagsStored: row.red_flags ?? [],
    redFlagsFresh: [],
    usage: result.usage,
  };

  if (!result.ok) {
    report.failureOutcome = `${result.outcome}: ${result.detail}`;
    reports.push(report);
    console.log(
      `  [${processed}/${rows.length}] ${row.conversation_id} — ✗ ${result.outcome}`,
    );
    continue;
  }

  const fresh: ExtractedMemory = result.memory;
  report.redFlagsFresh = fresh.red_flags;

  for (const field of EXACT_FIELDS) {
    // Stored consent is a timestamp; the extractor returns a boolean.
    const stored = field === "meeting_consented"
      ? row.meeting_consented_at !== null
      : row[field as "q1_age" | "q7_email"];
    const freshValue = fresh[field];
    const normalise = (v: unknown) => typeof v === "string" ? v.trim().toLowerCase() : v;
    report.exact[field] = {
      stored,
      fresh: freshValue,
      agree: normalise(stored) === normalise(freshValue),
    };
  }
  for (const field of PRESENCE_FIELDS) {
    const storedPresent = row[field] !== null && row[field] !== "";
    const freshPresent = fresh[field] !== null && fresh[field] !== "";
    report.presence[field] = {
      stored: storedPresent,
      fresh: freshPresent,
      agree: storedPresent === freshPresent,
    };
  }

  const disagreements = Object.entries(report.exact).filter(([, v]) => !v.agree);
  reports.push(report);

  if (verbose || disagreements.length > 0) {
    const detail = disagreements
      .map(([k, v]) => `${k}: stored=${JSON.stringify(v.stored)} fresh=${JSON.stringify(v.fresh)}`)
      .join(" · ");
    console.log(
      `  [${processed}/${rows.length}] ${row.conversation_id} — ${
        disagreements.length === 0 ? "✓ all exact fields agree" : `⚠ ${detail}`
      }`,
    );
  } else {
    console.log(`  [${processed}/${rows.length}] ${row.conversation_id} — ✓`);
  }
}

// 3. Summary.
const tested = reports.length;
const succeeded = reports.filter((r) => r.extraction === "ok");
const pct = (n: number, d: number) => d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;

console.log(`\n${"=".repeat(64)}`);
console.log(`EXTRACTION RELIABILITY`);
console.log(`  tested            ${tested}`);
console.log(`  produced a result ${succeeded.length}  (${pct(succeeded.length, tested)})`);
const failures = reports.filter((r) => r.extraction === "failed");
if (failures.length > 0) {
  const grouped = new Map<string, number>();
  for (const f of failures) {
    const key = (f.failureOutcome ?? "unknown").split(":")[0];
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  for (const [k, v] of grouped) console.log(`    ✗ ${k}: ${v}`);
}
console.log(`\n  For reference, the OLD extractor produced a usable result on`);
console.log(`  roughly 5% of calls. A healthy run here should be near 100%.`);

console.log(`\nAGREEMENT WITH STORED GROUND TRUTH (exact fields)`);
for (const field of EXACT_FIELDS) {
  const withField = succeeded.filter((r) => r.exact[field]);
  const agreed = withField.filter((r) => r.exact[field].agree).length;
  console.log(`  ${field.padEnd(18)} ${agreed}/${withField.length}  (${pct(agreed, withField.length)})`);
}

console.log(`\nAGREEMENT ON PRESENCE (free-text fields — did both find something?)`);
for (const field of PRESENCE_FIELDS) {
  const withField = succeeded.filter((r) => r.presence[field]);
  const agreed = withField.filter((r) => r.presence[field].agree).length;
  const freshOnly = withField.filter((r) =>
    r.presence[field].fresh && !r.presence[field].stored
  ).length;
  console.log(
    `  ${field.padEnd(20)} ${agreed}/${withField.length} agree  (${
      pct(agreed, withField.length)
    })   fresh-only: ${freshOnly}`,
  );
}

const totalIn = succeeded.reduce((a, r) => a + (r.usage?.inputTokens ?? 0), 0);
const totalOut = succeeded.reduce((a, r) => a + (r.usage?.outputTokens ?? 0), 0);
const cost = totalIn * HAIKU_INPUT_PER_TOKEN + totalOut * HAIKU_OUTPUT_PER_TOKEN;
console.log(`\nCOST`);
console.log(`  tokens  in=${totalIn} out=${totalOut}`);
console.log(`  approx  $${cost.toFixed(4)}   (~$${((cost / Math.max(tested, 1)) * 1349).toFixed(2)} to backfill all 1,349)`);

console.log(`\nHOW TO READ THIS`);
console.log(`  • "produced a result" near 100% = the parse-failure class is gone.`);
console.log(`  • q1_age / q7_email disagreement = investigate; these are factual.`);
console.log(`  • meeting_consented disagreement matters most — it gates handoff.`);
console.log(`  • "fresh-only" > 0 on text fields is usually GOOD: the fixed`);
console.log(`    extractor found something the broken one missed.`);
console.log(`  • Read a few transcripts by hand before promoting anything.`);
console.log(`${"=".repeat(64)}`);

if (outFile) {
  await Deno.writeTextFile(
    outFile,
    JSON.stringify({ model: MEMORY_EXTRACTOR_MODEL, tested, reports }, null, 2),
  );
  console.log(`\n→ Full report written to ${outFile}`);
}
