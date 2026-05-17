import type { LucideIcon } from "lucide-react";
import { AnimatedNumber } from "@/components/effects/AnimatedNumber";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSpotlight } from "@/hooks/use-spotlight";
import { cn } from "@/lib/utils";

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
 * KPI card — the hero of the dashboard.
 *
 * Effects stack:
 *  - Spotlight follows the cursor (brand-tinted radial gradient).
 *  - Number is Instrument Serif at display size (Mercury / Resend signature).
 *  - Animated count-up on numeric values (respects prefers-reduced-motion).
 *  - Top-edge hairline highlight on hover.
 *  - Icon medallion scales 1.05× and brightens on hover.
 */
export function KpiCard({ label, value, icon: Icon, hint, delta, isLoading }: Props) {
  const ref = useSpotlight<HTMLDivElement>();
  const numericValue = typeof value === "number" ? value : null;

  return (
    <Card
      ref={ref}
      className="spotlight group/kpi relative overflow-hidden border-border bg-card transition-colors hover:border-border-strong"
    >
      {/* Top-edge highlight — appears on hover, depth without shadow */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent opacity-0 transition-opacity group-hover/kpi:opacity-100" />

      <CardContent className="relative flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          {isLoading ? (
            <Skeleton className="h-10 w-24" />
          ) : (
            <p
              className={cn(
                "text-3xl font-bold tabular-nums leading-none tracking-tight text-foreground",
                "transition-colors group-hover/kpi:text-primary",
              )}
            >
              {numericValue !== null ? <AnimatedNumber value={numericValue} /> : value}
            </p>
          )}
          {(hint || delta) && (
            <div className="flex items-center gap-1.5 text-xs">
              {delta && (
                <span className={cn("font-medium tabular-nums", TREND_COLORS[delta.trend])}>
                  {delta.value}
                </span>
              )}
              {hint && <span className="text-muted-foreground">{hint}</span>}
            </div>
          )}
        </div>
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-card transition-all group-hover/kpi:scale-105 group-hover/kpi:border-primary/40 group-hover/kpi:text-primary">
          <Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover/kpi:text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}
