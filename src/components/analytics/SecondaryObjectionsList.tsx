import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  counts: Record<string, number>;
  isLoading: boolean;
}

export function SecondaryObjectionsList({ counts, isLoading }: Props) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">התנגדויות משניות</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : entries.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">אין עדיין נתונים.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map(([key, count]) => {
              const pct = total === 0 ? 0 : Math.round((count / total) * 100);
              return (
                <li key={key} className="flex items-center gap-2 text-sm">
                  <div className="min-w-[140px] truncate text-xs text-muted-foreground">{key}</div>
                  <div className="flex-1">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary/70" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {count}
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
