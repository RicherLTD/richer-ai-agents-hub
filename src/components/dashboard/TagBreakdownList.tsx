import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DisplayStatusBadge } from "@/components/leads/DisplayStatusBadge";
import {
  DISPLAY_STATUSES,
  type DisplayStatus,
} from "@/lib/conversation-status";
import type { DisplayStatusBreakdown } from "@/lib/kpis";

interface Props {
  breakdown: DisplayStatusBreakdown;
  isLoading: boolean;
}

// Renamed conceptually from "tag" to "status" — kept the component
// filename for now to avoid churning import paths across the dashboard.
export function TagBreakdownList({ breakdown, isLoading }: Props) {
  const entries: Array<[DisplayStatus, number]> = DISPLAY_STATUSES.map((s) => [
    s,
    breakdown[s] ?? 0,
  ]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">פירוק לפי סטטוס</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : total === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">אין עדיין נתונים.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map(([status, count]) => {
              const pct = total === 0 ? 0 : Math.round((count / total) * 100);
              return (
                <li key={status} className="flex items-center gap-2 text-sm">
                  <div className="min-w-[120px]">
                    <DisplayStatusBadge status={status} />
                  </div>
                  <div className="flex-1">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {count} ({pct}%)
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
