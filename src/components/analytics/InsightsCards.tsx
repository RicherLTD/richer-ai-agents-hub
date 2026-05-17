/**
 * InsightsCards — three Round-2 analytics widgets shown on the
 * "Advanced Analytics" admin tab of the home dashboard:
 *
 *   • FunnelDropoffCard   — at which qualifying question do leads stop?
 *   • CampaignCohortsCard — which `source_campaign` converts to zoom best?
 *   • HealthStatusCard    — error counts per service in the last 24h.
 *
 * All three are pure-display; the data shaping happens in src/lib/insights.ts.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronsDown,
  Megaphone,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getCampaignCohorts,
  getFunnelDropoff,
  getSystemHealth,
  type HealthLevel,
} from "@/lib/insights";

// ───────── Funnel drop-off ─────────

export function FunnelDropoffCard({ agentId }: { agentId: string }) {
  const q = useQuery({
    queryKey: ["insights", "funnel-dropoff", agentId] as const,
    queryFn: () => getFunnelDropoff(agentId),
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ChevronsDown className="h-4 w-4 text-muted-foreground" />
          איפה לידים נושרים מהמשפך
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : q.error ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : !q.data || q.data.total === 0 ? (
          <p className="text-sm text-muted-foreground">אין עדיין מספיק לידים לניתוח.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              מתוך {q.data.total} לידים — אחוז שענו על כל שאלה
            </p>
            {(["q1", "q2", "q3", "q4", "q5"] as const).map((q1to5) => {
              const pct = q.data.percent[q1to5];
              const n = q.data.answered[q1to5];
              const labels: Record<typeof q1to5, string> = {
                q1: "גיל",
                q2: "מוטיבציה",
                q3: "חלום",
                q4: "חסם",
                q5: "דחיפות",
              };
              return (
                <div key={q1to5} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{labels[q1to5]}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {n} / {q.data.total} · {pct}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────── Campaign cohorts ─────────

export function CampaignCohortsCard({ agentId }: { agentId: string }) {
  const q = useQuery({
    queryKey: ["insights", "campaign-cohorts", agentId] as const,
    queryFn: () => getCampaignCohorts(agentId),
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="h-4 w-4 text-muted-foreground" />
          המרה לפי קמפיין
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : q.error ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : !q.data || q.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">אין עדיין נתוני קמפיינים.</p>
        ) : (
          <div className="space-y-1.5">
            {q.data.slice(0, 8).map((c) => (
              <div
                key={c.campaign}
                className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="max-w-[55%] truncate font-medium" title={c.campaign}>
                  {c.campaign}
                </span>
                <span className="flex items-center gap-3 tabular-nums text-muted-foreground">
                  <span>{c.total} לידים</span>
                  <span className="font-semibold text-primary">{c.conversionPct}%</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────── Health status ─────────

const HEALTH_COLORS: Record<HealthLevel, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  error: "text-destructive",
};

const HEALTH_ICONS: Record<HealthLevel, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: ShieldAlert,
};

export function HealthStatusCard() {
  const q = useQuery({
    queryKey: ["insights", "system-health"] as const,
    queryFn: () => getSystemHealth(),
    refetchInterval: 60_000, // refresh every minute
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-muted-foreground" />
          תקינות שירותים (24 שעות אחרונות)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : q.error ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : !q.data ? null : (
          <div className="space-y-1.5">
            {q.data.map((s) => {
              const Icon = HEALTH_ICONS[s.level];
              return (
                <div
                  key={s.source}
                  className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <Icon className={`h-3.5 w-3.5 ${HEALTH_COLORS[s.level]}`} />
                    <span className="font-medium" dir="ltr">{s.source}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {s.errorCount24h === 0 ? "תקין" : `${s.errorCount24h} שגיאות`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
