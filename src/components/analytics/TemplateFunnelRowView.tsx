/**
 * TemplateFunnelRowView — the funnel-bar visual for a single template cohort:
 *   sent → delivered → read → answered → zoom (agent-booked)
 *
 * Extracted verbatim from TemplateFunnelCard so it can be reused elsewhere
 * (e.g. the per-broadcast funnel in the Broadcasts page).
 */
import type { TemplateFunnelRow } from "@/lib/template-funnel";

interface Step {
  label: string;
  n: number;
  pct: number | null;
  width: number;
  strong?: boolean;
}

type RefusedTone = "muted" | "warning" | "danger";

const REFUSED_TONE_CLASS: Record<RefusedTone, string> = {
  muted: "text-muted-foreground",
  warning: "text-amber-700",
  danger: "font-semibold text-destructive",
};

/**
 * How loudly to show the "refused by Meta" line. A baseline of refusals is
 * normal (invalid numbers, people not on WhatsApp, some per-user marketing
 * limit), so only a clear jump above it turns amber or red — a line that is
 * always red gets ignored.
 *
 *   - Under 20 sends a couple of bad numbers swing the % wildly → never shout.
 *   - Total refused ≥ 40% → danger; ≥ 25% → warning (normal sits below that).
 *   - The 131049 share escalates on its own (≥ 30% danger, ≥ 15% warning):
 *     it is the one refusal Meta says gets WORSE if you keep sending.
 */
function refusedTone(row: TemplateFunnelRow): RefusedTone {
  if (row.sent < 20) return "muted";
  const limitPct = (row.refusedMarketingLimit / row.sent) * 100;
  if (row.refusedRatePct >= 40 || limitPct >= 30) return "danger";
  if (row.refusedRatePct >= 25 || limitPct >= 15) return "warning";
  return "muted";
}

export function TemplateFunnelRowView({ row }: { row: TemplateFunnelRow }) {
  const steps: Step[] = [
    { label: "נשלח", n: row.sent, pct: null, width: 100 },
    { label: "נמסר", n: row.delivered, pct: row.deliveredRatePct, width: row.deliveredRatePct },
    { label: "נקרא", n: row.read, pct: row.readRatePct, width: row.readRatePct },
    { label: "נענו", n: row.answered, pct: row.answeredRatePct, width: row.answeredRatePct },
    {
      label: 'זום ע"י הסוכן',
      n: row.agentZoom,
      pct: row.agentZoomPerSentPct,
      width: row.agentZoomPerSentPct,
      strong: true,
    },
  ];

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="max-w-[55%] truncate text-xs font-semibold"
          dir="ltr"
          title={row.templateName}
        >
          {row.templateName}
        </span>
        <span className="text-xs text-muted-foreground">
          המרה לזום (סוכן):{" "}
          <span className="font-semibold tabular-nums text-primary">
            {row.agentZoomPerAnsweredPct}%
          </span>{" "}
          מנענו
        </span>
      </div>

      <div className="space-y-1.5">
        {steps.map((s) => (
          <div key={s.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className={s.strong ? "font-semibold text-primary" : "font-medium"}>
                {s.label}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {s.n}
                {s.pct !== null ? ` · ${s.pct}%` : ""}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div
                className={`h-full rounded transition-all ${s.strong ? "bg-primary" : "bg-primary/60"}`}
                style={{ width: `${Math.min(s.width, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {row.refused > 0 && (
        <div
          className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${REFUSED_TONE_CLASS[refusedTone(row)]}`}
          title="Meta קיבלה את השליחה ואז סירבה למסור אותה לליד. מכסת שיווק (131049) = Meta מגבילה כמה הודעות שיווק משתמש מקבל — שליחה חוזרת לפני 24 שעות רק מחמירה."
        >
          <span>
            נחסם ע״י Meta:{" "}
            <span className="tabular-nums">
              {row.refused} · {row.refusedRatePct}%
            </span>
          </span>
          {row.refusedMarketingLimit > 0 && (
            <span>
              מתוכם מכסת שיווק: <span className="tabular-nums">{row.refusedMarketingLimit}</span>
            </span>
          )}
        </div>
      )}

      {(row.selfZoom > 0 || row.consentHandoff > 0 || row.legacyZoom > 0 || row.failed > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {row.selfZoom > 0 && (
            <span>
              קבע עצמאית: <span className="tabular-nums">{row.selfZoom}</span>
            </span>
          )}
          {row.consentHandoff > 0 && (
            <span>
              הסכים+הועבר: <span className="tabular-nums">{row.consentHandoff}</span>
            </span>
          )}
          {row.legacyZoom > 0 && (
            <span title="זומים שנקבעו לפני הוספת מדידת הייחוס — לא משוייכים לסוכן/עצמאי">
              זום היסטורי: <span className="tabular-nums">{row.legacyZoom}</span>
            </span>
          )}
          {row.failed > 0 && (
            <span className="text-destructive">
              נכשלו: <span className="tabular-nums">{row.failed}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
