// Renders the self-contained Hebrew HTML report (RTL, no external assets,
// readable at phone width). Pure string building.

import type { CriterionGrade } from "./graderSchema.ts";
import type { TranscriptEntry } from "./transcript.ts";
import type { RunReport, ScenarioRun } from "./types.ts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type BadgeKey = "PASS" | "BORDERLINE" | "FAIL" | "ERROR" | "ABORTED";

const BADGE_LABEL: Record<BadgeKey, string> = {
  PASS: "עבר",
  BORDERLINE: "גבולי",
  FAIL: "נכשל",
  ERROR: "שגיאת הרצה",
  ABORTED: "הופסק (תקרת עלות)",
};

const BADGE_ORDER: ReadonlyArray<BadgeKey> = ["FAIL", "ERROR", "ABORTED", "BORDERLINE", "PASS"];

export function badgeOf(run: ScenarioRun): BadgeKey {
  if (run.status === "error") return "ERROR";
  if (run.status === "aborted") return "ABORTED";
  return run.grade?.verdict ?? "ERROR";
}

export function sortRuns(runs: ReadonlyArray<ScenarioRun>): ScenarioRun[] {
  return [...runs].sort(
    (a, b) =>
      BADGE_ORDER.indexOf(badgeOf(a)) - BADGE_ORDER.indexOf(badgeOf(b)) || a.statusSub - b.statusSub || a.id.localeCompare(b.id),
  );
}

export function countByBadge(runs: ReadonlyArray<ScenarioRun>): Record<BadgeKey, number> {
  const counts: Record<BadgeKey, number> = { PASS: 0, BORDERLINE: 0, FAIL: 0, ERROR: 0, ABORTED: 0 };
  runs.forEach((run) => {
    counts[badgeOf(run)] += 1;
  });
  return counts;
}

function renderEntry(entry: TranscriptEntry): string {
  const text = escapeHtml(entry.text);
  switch (entry.kind) {
    case "opener": return `<div class="msg bot opener"><b>הבוט (פתיח)</b>${text}</div>`;
    case "lead": return `<div class="msg lead"><b>הליד</b>${text}</div>`;
    case "bot": return `<div class="msg bot"><b>הבוט${entry.attempts > 1 ? " (ניסיון שני)" : ""}</b>${text}</div>`;
    case "tool": return `<div class="event tool">${text}</div>`;
    case "guard": return `<div class="event guard">${text}</div>`;
    case "silence": return `<div class="event silence">${text}</div>`;
  }
}

function renderCriteria(criteria: ReadonlyArray<CriterionGrade>): string {
  const failing = criteria.filter((c) => c.result === "fail");
  const rest = criteria.filter((c) => c.result !== "fail");
  const row = (c: CriterionGrade): string =>
    `<li class="crit ${c.result}"><span class="res">${c.result === "pass" ? "עבר" : c.result === "fail" ? "נכשל" : "לא רלוונטי"}</span> ${escapeHtml(c.label)}${
      c.evidence ? `<q>${escapeHtml(c.evidence)}</q>` : ""
    }</li>`;
  return `<ul class="crits">${[...failing, ...rest].map(row).join("")}</ul>`;
}

function renderScenarioChecks(run: ScenarioRun): string {
  const checks = run.grade?.scenarioChecks ?? [];
  if (checks.length === 0) return "";
  const rows = checks.map((c) =>
    `<li class="crit ${c.result}"><span class="res">${c.kind === "must_happen" ? "חייב לקרות" : "אסור שיקרה"}: ${c.result === "pass" ? "עבר" : "נכשל"}</span> ${escapeHtml(c.item)}${
      c.evidence ? `<q>${escapeHtml(c.evidence)}</q>` : ""
    }</li>`
  );
  return `<h4>בדיקות התרחיש</h4><ul class="crits">${rows.join("")}</ul>`;
}

function renderCard(run: ScenarioRun): string {
  const badge = badgeOf(run);
  const summary = run.grade ? escapeHtml(run.grade.summaryHe) : escapeHtml(run.note ?? "");
  return `<section class="card ${badge}" id="${escapeHtml(run.id)}">
<header><span class="badge ${badge}">${BADGE_LABEL[badge]}</span><h3>סטטוס ${run.statusSub}: ${escapeHtml(run.title)}</h3>
<div class="meta">${escapeHtml(run.statusLabel)} · ${run.leadTurns} הודעות ליד · שתיקות: ${run.silenceCount} · $${run.cost.costUsd.toFixed(3)}</div></header>
<p class="summary">${summary}</p>
${run.grade ? renderCriteria(run.grade.criteria) + renderScenarioChecks(run) : ""}
<h4>תמלול</h4><div class="transcript">${run.entries.map(renderEntry).join("")}</div>
</section>`;
}

const STYLE = `
body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;margin:0;background:#f4f5f7;color:#1c1e21;line-height:1.5}
main{max-width:860px;margin:0 auto;padding:12px}
h1{font-size:1.3rem;margin:8px 0}h3{font-size:1.05rem;margin:6px 0}h4{margin:14px 0 6px;font-size:.95rem}
.top,.card{background:#fff;border-radius:10px;padding:12px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.totals{display:flex;flex-wrap:wrap;gap:6px}.totals span,.badge{border-radius:999px;padding:2px 10px;font-size:.85rem;font-weight:600;color:#fff}
.PASS{background:#2e7d32}.BORDERLINE{background:#ef8f00}.FAIL{background:#c62828}.ERROR{background:#6a1b9a}.ABORTED{background:#546e7a}
.card.FAIL{border-inline-start:5px solid #c62828}.card.BORDERLINE{border-inline-start:5px solid #ef8f00}.card.PASS{border-inline-start:5px solid #2e7d32}
.meta,.small{color:#65676b;font-size:.82rem}.summary{font-weight:600}
.crits{list-style:none;padding:0;margin:0}.crit{padding:5px 8px;margin:3px 0;border-radius:6px;background:#f0f2f5;font-size:.9rem}
.crit.fail{background:#fdecea}.crit.pass{background:#edf7ed}.crit .res{font-weight:700;margin-inline-end:6px}
.crit q{display:block;color:#444;font-size:.85rem;margin-top:2px}
.transcript{display:flex;flex-direction:column;gap:6px}
.msg{max-width:88%;padding:7px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.msg b{display:block;font-size:.72rem;color:#65676b;margin-bottom:2px}
.msg.bot{background:#dcf8c6;align-self:flex-start}.msg.opener{background:#e3f2fd}.msg.lead{background:#fff;border:1px solid #ddd;align-self:flex-end}
.event{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;padding:3px 8px;border-radius:6px;align-self:center;direction:ltr;text-align:left}
.event.tool{background:#ede7f6;color:#4527a0}.event.guard{background:#fff3e0;color:#e65100}.event.silence{background:#fdecea;color:#b71c1c;font-weight:700}
.toc a{display:inline-block;margin:2px 4px;text-decoration:none;color:#fff;border-radius:6px;padding:1px 8px;font-size:.8rem}
`;

export function renderHtml(report: RunReport): string {
  const runs = sortRuns(report.scenarios);
  const counts = countByBadge(runs);
  const totals = BADGE_ORDER.map((key) => `<span class="${key}">${BADGE_LABEL[key]}: ${counts[key]}</span>`).join("");
  const toc = runs.map((r) => `<a class="${badgeOf(r)}" href="#${escapeHtml(r.id)}">${r.statusSub}</a>`).join("");
  const { totalCost } = report;
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>סימולטור חימום CRM</title><style>${STYLE}</style></head><body><main>
<div class="top"><h1>סימולטור חימום CRM - ${escapeHtml(report.agentSlug)}</h1>
<div class="totals">${totals}</div>
<p class="small">נוצר: ${escapeHtml(report.generatedAt)} · פרומפט ראשי: ${escapeHtml(report.mainPromptVersion)}<br>
מודלים: בוט ${escapeHtml(report.models.bot)} · ליד ${escapeHtml(report.models.lead)} · שופט ${escapeHtml(report.models.judge)} · מעריך ${escapeHtml(report.models.grader)}<br>
עלות הריצה: $${totalCost.costUsd.toFixed(2)} מתוך תקרה $${report.maxCostUsd.toFixed(2)}${report.budgetExceeded ? " (הריצה נעצרה בגלל התקרה)" : ""} · ${totalCost.calls} קריאות ·
טוקנים: קלט ${totalCost.inputTokens}, פלט ${totalCost.outputTokens}, קריאת מטמון ${totalCost.cacheReadTokens}, כתיבת מטמון ${totalCost.cacheCreationTokens}<br>
מטמון פרומפט (prompt caching) מופעל על בלוק המערכת, כמו בייצור. הכלים של Mooz מדומים, שום הודעה לא נשלחה לוואטסאפ.</p>
<div class="toc">${toc}</div></div>
${runs.map(renderCard).join("\n")}
</main></body></html>`;
}
