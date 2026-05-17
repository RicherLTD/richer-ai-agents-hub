import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  label: string;
  value: number | string;
  icon: LucideIcon;
  hint?: string;
  /** Optional delta vs previous period (e.g. "+12%" or "−3"). */
  delta?: { value: string; trend: "up" | "down" | "neutral" };
  isLoading?: boolean;
}

const TREND_COLORS: Record<NonNullable<Props["delta"]>["trend"], string> = {
  up: "text-success",
  down: "text-destructive",
  neutral: "text-muted-foreground",
};

/**
 * KPI card — the hero of the dashboard. Number is the focus.
 *
 * Restraint markers:
 *   - No drop shadow.
 *   - Number uses tabular-nums + display-size font so columns of cards
 *     align visually.
 *   - Brand color shows up ONLY in the small icon medallion — never as
 *     a fill on the whole card.
 *   - Hover lifts the icon medallion subtly (depth via tone, not shadow).
 */
export function KpiCard({ label, value, icon: Icon, hint, delta, isLoading }: Props) {
  return (
    <Card className="group/kpi relative overflow-hidden border-border bg-card transition-colors hover:border-border-strong">
      {/* Top-edge hairline highlight — gives a faint sense of being a
          floating panel without using a heavy shadow. */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/15 to-transparent opacity-0 transition-opacity group-hover/kpi:opacity-100" />

      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          {isLoading ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
              {value}
            </p>
          )}
          {(hint || delta) && (
            <div className="flex items-center gap-1.5 text-2xs">
              {delta && (
                <span className={`font-medium tabular-nums ${TREND_COLORS[delta.trend]}`}>
                  {delta.value}
                </span>
              )}
              {hint && <span className="text-muted-foreground">{hint}</span>}
            </div>
          )}
        </div>
        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary transition-transform group-hover/kpi:scale-105">
          <Icon className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}
