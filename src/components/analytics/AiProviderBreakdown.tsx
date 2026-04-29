import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AiProviderBreakdown as Breakdown } from "@/lib/analytics";

const LABEL: Record<string, string> = {
  claude: "Claude",
  gpt: "GPT",
  manual: "ידני",
  pending: "ממתין",
};

interface Props {
  breakdown: Breakdown;
  isLoading: boolean;
}

export function AiProviderBreakdown({ breakdown, isLoading }: Props) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">פירוק לפי ספק AI</CardTitle>
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
                  <div className="min-w-[100px] text-xs">{LABEL[key] ?? key}</div>
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
