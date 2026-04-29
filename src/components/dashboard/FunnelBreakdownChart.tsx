import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { FunnelBreakdown } from "@/lib/kpis";

const STAGE_LABEL: Record<keyof FunnelBreakdown, string> = {
  cold: "קר",
  mid: "אמצע",
  done: "סגור",
};

interface Props {
  breakdown: FunnelBreakdown;
  isLoading: boolean;
}

export function FunnelBreakdownChart({ breakdown, isLoading }: Props) {
  const data = (Object.keys(STAGE_LABEL) as Array<keyof FunnelBreakdown>).map((stage) => ({
    stage: STAGE_LABEL[stage],
    count: breakdown[stage],
  }));
  const total = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">פירוק לפי שלב משפך</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : total === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">אין עדיין לידים להצגה.</p>
        ) : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="stage" reversed tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="count" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
