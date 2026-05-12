import { useQuery } from "@tanstack/react-query";
import { BarChart3, FlaskConical } from "lucide-react";
import { AiProviderBreakdown } from "@/components/analytics/AiProviderBreakdown";
import { CostLatencyDashboard } from "@/components/analytics/CostLatencyDashboard";
import { ExperimentCard } from "@/components/analytics/ExperimentCard";
import { ObjectionBreakdownChart } from "@/components/analytics/ObjectionBreakdown";
import { SecondaryObjectionsList } from "@/components/analytics/SecondaryObjectionsList";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgent } from "@/contexts/AgentContext";
import { getAnalytics } from "@/lib/analytics";
import { getOperationsMetrics } from "@/lib/operations";

const Analytics = () => {
  const { activeAgent, isLoading: isAgentLoading } = useAgent();

  const analyticsQuery = useQuery({
    queryKey: ["analytics", activeAgent?.id] as const,
    queryFn: () => getAnalytics(activeAgent!.id),
    enabled: Boolean(activeAgent?.id),
  });

  const operationsQuery = useQuery({
    queryKey: ["operations", activeAgent?.id] as const,
    queryFn: () => getOperationsMetrics(activeAgent!.id),
    enabled: Boolean(activeAgent?.id),
  });

  if (isAgentLoading) return null;
  if (!activeAgent) return <EmptyState icon={BarChart3} title="לא נבחר סוכן" />;

  const a = analyticsQuery.data;
  const isLoading = analyticsQuery.isLoading;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">ניתוחים</h1>
        <p className="text-sm text-muted-foreground">
          {activeAgent.display_name} — A/B testing והתפלגות התנגדויות
        </p>
      </header>

      {analyticsQuery.error && (
        <p className="text-sm text-destructive">שגיאה בטעינה: {analyticsQuery.error.message}</p>
      )}
      {operationsQuery.error && (
        <p className="text-sm text-destructive">
          שגיאה בטעינת מטריקות תפעול: {operationsQuery.error.message}
        </p>
      )}

      <CostLatencyDashboard
        metrics={operationsQuery.data}
        isLoading={operationsQuery.isLoading}
      />

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            ניסויי A/B
          </h2>
        </div>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !a || a.experiments.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              אין עדיין ניסויים פעילים.{" "}
              {a && a.unattributedTotal > 0 && (
                <>({a.unattributedTotal} שיחות ללא וואריאנט.)</>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {a.experiments.map((s) => (
              <ExperimentCard key={s.experiment.id} summary={s} />
            ))}
            {a.unattributedTotal > 0 && (
              <p className="text-xs text-muted-foreground">
                {a.unattributedTotal} שיחות לא משויכות לוואריאנט (לא משתתפות בחישוב המרה).
              </p>
            )}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ObjectionBreakdownChart
          title="התנגדות ראשית"
          breakdown={a?.primaryObjections ?? {}}
          isLoading={isLoading}
        />
        <SecondaryObjectionsList
          counts={a?.secondaryObjectionCounts ?? {}}
          isLoading={isLoading}
        />
      </section>

      <section>
        <AiProviderBreakdown breakdown={a?.aiProviders ?? {}} isLoading={isLoading} />
      </section>
    </div>
  );
};

export default Analytics;
