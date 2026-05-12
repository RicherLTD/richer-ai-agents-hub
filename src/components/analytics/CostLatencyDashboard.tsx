import { Activity, Banknote, Gauge, Hash } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { OperationsMetrics } from "@/lib/operations";

interface Props {
  metrics: OperationsMetrics | undefined;
  isLoading: boolean;
}

/** "$0.0077" → "0.77¢"; "$1.23" stays "$1.23". Most agent turns cost cents. */
function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 1) {
    const cents = amount * 100;
    if (cents < 0.1) {
      return `<0.1¢`;
    }
    return `${cents.toFixed(cents < 1 ? 2 : 1)}¢`;
  }
  return `$${amount.toFixed(2)}`;
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  isLoading,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Banknote;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading
          ? <Skeleton className="h-7 w-24" />
          : <div className="text-2xl font-bold tabular-nums">{value}</div>}
        {hint && !isLoading && (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function CostLatencyDashboard({ metrics, isLoading }: Props) {
  // Cards: today / week / month / latency P50 / latency P95 / avg tokens
  const m = metrics;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Banknote className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          עלויות וביצועי בוט
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          icon={Banknote}
          label="עלות היום"
          value={m ? formatUsd(m.costToday) : "$0"}
          hint={m ? `${m.repliesToday} תגובות` : undefined}
          isLoading={isLoading}
        />
        <MetricCard
          icon={Banknote}
          label="עלות השבוע"
          value={m ? formatUsd(m.costThisWeek) : "$0"}
          hint={m ? `${m.repliesThisWeek} תגובות` : undefined}
          isLoading={isLoading}
        />
        <MetricCard
          icon={Banknote}
          label="עלות החודש"
          value={m ? formatUsd(m.costThisMonth) : "$0"}
          hint={m ? `${m.repliesThisMonth} תגובות` : undefined}
          isLoading={isLoading}
        />
        <MetricCard
          icon={Gauge}
          label="Latency P50 (שבוע)"
          value={formatMs(m?.latencyP50Ms ?? null)}
          hint="זמן תגובה ממוצע"
          isLoading={isLoading}
        />
        <MetricCard
          icon={Activity}
          label="Latency P95 (שבוע)"
          value={formatMs(m?.latencyP95Ms ?? null)}
          hint="95% מהתגובות מתחת לזה"
          isLoading={isLoading}
        />
        <MetricCard
          icon={Hash}
          label="טוקנים בתגובה (שבוע)"
          value={m?.avgTokensOutThisWeek != null ? `~${m.avgTokensOutThisWeek}` : "—"}
          hint="ממוצע output"
          isLoading={isLoading}
        />
      </div>
    </section>
  );
}
