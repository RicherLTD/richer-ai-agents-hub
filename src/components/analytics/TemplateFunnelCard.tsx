/**
 * TemplateFunnelCard — the per-template cohort funnel:
 *   sent → delivered → read → answered → zoom (agent-booked)
 *
 * Admin-only data (RLS-gated). Owns its own date-range state via the shared
 * `DateRangeFilter` so it can be mounted as a one-liner on any analytics
 * surface. Data shaping lives in src/lib/template-funnel.ts.
 *
 * Only AGENT-booked zooms count toward the conversion rate; self-service and
 * consent-handoff bookings are surfaced separately so nothing is hidden.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DateRangeFilter,
  type DatePreset,
  type DateRange,
} from "@/components/leads/DateRangeFilter";
import { getTemplateFunnel, type TemplateFunnelRow } from "@/lib/template-funnel";

export function TemplateFunnelCard({ agentId }: { agentId: string }) {
  const [preset, setPreset] = useState<DatePreset>("all");
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const q = useQuery({
    queryKey: ["insights", "template-funnel", agentId, range.from, range.to] as const,
    queryFn: () => getTemplateFunnel(agentId, range),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4 text-muted-foreground" />
          משפך לפי טמפלייט
        </CardTitle>
        <div className="pt-2">
          <DateRangeFilter
            preset={preset}
            range={range}
            onChange={({ preset: p, range: r }) => {
              setPreset(p);
              setRange(r);
            }}
          />
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : q.error ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : !q.data || q.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            אין עדיין נתוני טמפלייטים בטווח שנבחר.
          </p>
        ) : (
          <div className="space-y-3">
            {q.data.map((row) => (
              <TemplateRow key={row.templateName} row={row} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface Step {
  label: string;
  n: number;
  pct: number | null;
  width: number;
  strong?: boolean;
}

function TemplateRow({ row }: { row: TemplateFunnelRow }) {
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
