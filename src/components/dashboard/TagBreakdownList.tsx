import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationTagBadge } from "@/components/leads/ConversationTagBadge";
import type { TagBreakdown } from "@/lib/kpis";
import type { ConversationTag } from "@/types/conversation";

interface Props {
  breakdown: TagBreakdown;
  isLoading: boolean;
}

export function TagBreakdownList({ breakdown, isLoading }: Props) {
  const entries = (Object.entries(breakdown) as Array<[ConversationTag, number]>)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">פירוק לפי תיוג</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : entries.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">אין עדיין נתונים.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map(([tag, count]) => {
              const pct = total === 0 ? 0 : Math.round((count / total) * 100);
              return (
                <li key={tag} className="flex items-center gap-2 text-sm">
                  <div className="min-w-[120px]">
                    <ConversationTagBadge tag={tag} />
                  </div>
                  <div className="flex-1">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
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
