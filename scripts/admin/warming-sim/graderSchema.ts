// What the grader is asked to judge and how its structured answer is parsed.
// Pure: no model calls here, so it is testable under vitest.

export type CriterionResult = "pass" | "fail" | "na";
export type Verdict = "PASS" | "BORDERLINE" | "FAIL";

export interface Criterion {
  id: string;
  /** Hebrew label for the report. */
  label: string;
  /** English rubric line for the grader. */
  rubric: string;
}

export const CROSS_STATUS_CRITERIA: ReadonlyArray<Criterion> = [
  { id: "answers_last_message", label: "עונה קודם להודעה האחרונה של הליד", rubric: "Each bot reply first reacts to what the lead's last message actually said, before steering anywhere." },
  { id: "no_fresh_lead_script", label: "לא משתמש בתסריט של ליד טרי", rubric: "Never falls back to the new-lead qualification script (e.g. 'מה משך אותך להירשם', 'מה אתה רוצה לשנות')." },
  { id: "no_crm_reveal", label: "לא חושף CRM, סטטוס או מה שהנציג כתב", rubric: "Never reveals or hints at a CRM, a status, a rep's notes, or that the college 'knows' something internal. Acknowledging that the lead registered or was in touch before is allowed." },
  { id: "no_unraised_objection", label: "לא מנקב התנגדות שהליד לא העלה", rubric: "Never names or hints at an objection the lead did not raise first (price, time, trust...)." },
  { id: "no_fold_on_lukewarm", label: "לא מתקפל על תשובה פושרת", rubric: "A lukewarm reply ('סבבה', 'הכל טוב') is not a 'no'. The bot must not release the lead, say goodbye, or offer to stop on a lukewarm reply. Only an explicit, repeated refusal releases." },
  { id: "neutralize_before_zoom", label: "מנטרל את ההתנגדות לפני הצעת זום", rubric: "If a zoom with an advisor is offered, the lead's raised objection was addressed first. 'na' when no zoom was offered or no objection was raised." },
  { id: "no_technique_announcement", label: "לא מכריז על טכניקה", rubric: "Never announces its own technique, e.g. 'בלי לחץ', 'אני לא פה למכור', 'אני לא פה לחקור', 'תגיד לי ישר'. Quoting the instruction text is also a failure." },
  { id: "clear_not_vague", label: "ברור ולא מעורפל", rubric: "Messages are clear and concrete. Cryptic hints, coy phrasing or riddles fail." },
  { id: "no_dash", label: "בלי מקף ארוך", rubric: "No em dash or en dash characters in the bot's messages." },
  { id: "no_invented_references", label: "בלי שמות מומצאים או הפניה להודעות שהליד לא ראה", rubric: "No invented names, facts, links, or references to messages the lead never saw (for example 'the four options')." },
  { id: "no_money_claims", label: "בלי מחירים, סכומים, תשלומים, הנחות או הבטחות הכנסה", rubric: "No prices, sums, payment plans, discounts or income promises." },
  { id: "no_silence", label: "אין שתיקה", rubric: "The bot answered every lead message. Any silence event is a failure." },
];

const VERDICTS: ReadonlyArray<Verdict> = ["PASS", "BORDERLINE", "FAIL"];
const RESULTS: ReadonlyArray<CriterionResult> = ["pass", "fail", "na"];

export interface CriterionGrade {
  id: string;
  label: string;
  result: CriterionResult;
  evidence: string;
}

export interface ScenarioCheck {
  kind: "must_happen" | "must_not_happen";
  item: string;
  result: "pass" | "fail";
  evidence: string;
}

export interface GraderResult {
  criteria: CriterionGrade[];
  scenarioChecks: ScenarioCheck[];
  verdict: Verdict;
  summaryHe: string;
}

export class GraderParseError extends Error {}

/** JSON schema of the forced `submit_grade` tool call. */
export const SUBMIT_GRADE_TOOL = {
  name: "submit_grade",
  description: "Submit the grade for the transcript.",
  input_schema: {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        description: "One entry per cross-status criterion id.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: CROSS_STATUS_CRITERIA.map((c) => c.id) },
            result: { type: "string", enum: [...RESULTS] },
            evidence: { type: "string", description: "Short Hebrew quote from the transcript, or a short Hebrew reason for na." },
          },
          required: ["id", "result", "evidence"],
        },
      },
      scenario_checks: {
        type: "array",
        description: "One entry per mustHappen and mustNotHappen item of the scenario.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["must_happen", "must_not_happen"] },
            item: { type: "string" },
            result: { type: "string", enum: ["pass", "fail"] },
            evidence: { type: "string" },
          },
          required: ["kind", "item", "result", "evidence"],
        },
      },
      verdict: { type: "string", enum: [...VERDICTS] },
      summary_he: { type: "string", description: "One line in Hebrew." },
    },
    required: ["criteria", "scenario_checks", "verdict", "summary_he"],
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCriteria(raw: unknown): CriterionGrade[] {
  if (!Array.isArray(raw)) throw new GraderParseError("criteria is not an array");
  const byId = new Map<string, CriterionGrade>();
  for (const item of raw) {
    if (!isRecord(item)) throw new GraderParseError("criterion entry is not an object");
    const criterion = CROSS_STATUS_CRITERIA.find((c) => c.id === item.id);
    if (!criterion) throw new GraderParseError(`unknown criterion id '${String(item.id)}'`);
    const result = RESULTS.find((r) => r === item.result);
    if (!result) throw new GraderParseError(`bad result for ${criterion.id}`);
    byId.set(criterion.id, {
      id: criterion.id,
      label: criterion.label,
      result,
      evidence: typeof item.evidence === "string" ? item.evidence : "",
    });
  }
  const missing = CROSS_STATUS_CRITERIA.filter((c) => !byId.has(c.id)).map((c) => c.id);
  if (missing.length > 0) throw new GraderParseError(`missing criteria: ${missing.join(", ")}`);
  return CROSS_STATUS_CRITERIA.flatMap((c) => {
    const grade = byId.get(c.id);
    return grade ? [grade] : [];
  });
}

function parseScenarioChecks(raw: unknown): ScenarioCheck[] {
  if (!Array.isArray(raw)) throw new GraderParseError("scenario_checks is not an array");
  return raw.map((item) => {
    if (!isRecord(item)) throw new GraderParseError("scenario check is not an object");
    const kind = item.kind === "must_happen" || item.kind === "must_not_happen" ? item.kind : null;
    const result = item.result === "pass" || item.result === "fail" ? item.result : null;
    if (!kind || !result || typeof item.item !== "string") throw new GraderParseError("malformed scenario check");
    return { kind, item: item.item, result, evidence: typeof item.evidence === "string" ? item.evidence : "" };
  });
}

/** Validates the tool input the grader returned. Throws GraderParseError. */
export function parseGraderOutput(input: unknown): GraderResult {
  if (!isRecord(input)) throw new GraderParseError("grader output is not an object");
  const verdict = VERDICTS.find((v) => v === input.verdict);
  if (!verdict) throw new GraderParseError("verdict must be PASS, BORDERLINE or FAIL");
  if (typeof input.summary_he !== "string" || input.summary_he.trim() === "") {
    throw new GraderParseError("summary_he is missing");
  }
  return {
    criteria: parseCriteria(input.criteria),
    scenarioChecks: parseScenarioChecks(input.scenario_checks),
    verdict,
    summaryHe: input.summary_he.trim(),
  };
}

const VERDICT_RANK: Record<Verdict, number> = { PASS: 0, BORDERLINE: 1, FAIL: 2 };

export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/**
 * Facts the simulator knows for certain override the grader: a silence is a
 * failure whatever the grader said, and no failed check can sit under PASS.
 */
export function reconcileGrade(grade: GraderResult, facts: { silenceCount: number }): GraderResult {
  const criteria = grade.criteria.map((criterion) =>
    criterion.id === "no_silence" && facts.silenceCount > 0
      ? { ...criterion, result: "fail" as const, evidence: `הבוט שתק ${facts.silenceCount} פעמים (guard)` }
      : criterion
  );
  const hasFailure =
    criteria.some((c) => c.result === "fail") || grade.scenarioChecks.some((c) => c.result === "fail");
  let verdict = hasFailure ? worstVerdict(grade.verdict, "BORDERLINE") : grade.verdict;
  if (facts.silenceCount > 0) verdict = "FAIL";
  return { ...grade, criteria, verdict };
}
