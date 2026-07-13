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
import { getTemplateFunnel } from "@/lib/template-funnel";
import { TemplateFunnelRowView } from "./TemplateFunnelRowView";

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
              <TemplateFunnelRowView key={row.templateName} row={row} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
