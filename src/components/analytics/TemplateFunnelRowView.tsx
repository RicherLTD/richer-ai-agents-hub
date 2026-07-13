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
