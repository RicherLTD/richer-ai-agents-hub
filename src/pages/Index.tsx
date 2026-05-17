import { useQuery } from "@tanstack/react-query";
import { BarChart3, CalendarCheck, Flame, FlaskConical, Home, LayoutDashboard, MessageCircle, Users } from "lucide-react";
import { AiProviderBreakdown } from "@/components/analytics/AiProviderBreakdown";
import { CostLatencyDashboard } from "@/components/analytics/CostLatencyDashboard";
import { ExperimentCard } from "@/components/analytics/ExperimentCard";
import { ObjectionBreakdownChart } from "@/components/analytics/ObjectionBreakdown";
import { SecondaryObjectionsList } from "@/components/analytics/SecondaryObjectionsList";
import { FunnelBreakdownChart } from "@/components/dashboard/FunnelBreakdownChart";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { RecentLeadsList } from "@/components/dashboard/RecentLeadsList";
import { TagBreakdownList } from "@/components/dashboard/TagBreakdownList";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgent } from "@/contexts/AgentContext";
import { useAuth } from "@/contexts/AuthContext";
import { getAnalytics } from "@/lib/analytics";
import {
  CampaignCohortsCard,
  FunnelDropoffCard,
  HealthStatusCard,
} from "@/components/analytics/InsightsCards";
import { getKpis } from "@/lib/kpis";
import { getOperationsMetrics } from "@/lib/operations";

const Index = () => {
  const { activeAgent, isLoading: isAgentLoading } = useAgent();
  const { isAdmin } = useAuth();

  const kpiQuery = useQuery({
    queryKey: ["kpis", activeAgent?.id] as const,
    queryFn: () => getKpis(activeAgent!.id),
    enabled: Boolean(activeAgent?.id),
  });

  if (isAgentLoading) return null;
  if (!activeAgent) return <EmptyState icon={Home} title="לא נבחר סוכן" />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">דף הבית</h1>
          <p className="text-sm text-muted-foreground">
            {activeAgent.display_name} — סקירה כללית
          </p>
        </div>
      </header>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid w-full max-w-md grid-cols-2" dir="rtl">
          <TabsTrigger value="overview" className="gap-1.5">
            <LayoutDashboard className="h-3.5 w-3.5" />
            סקירה
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="advanced" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" />
              ניתוחים מתקדמים
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <OverviewTab kpiQuery={kpiQuery} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="advanced" className="space-y-6">
            <AdvancedAnalyticsTab agentId={activeAgent.id} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};

interface KpiQuery {
  data: Awaited<ReturnType<typeof getKpis>> | undefined;
  error: Error | null;
  isLoading: boolean;
}

function OverviewTab({ kpiQuery }: { kpiQuery: KpiQuery }) {
  const k = kpiQuery.data;
  const isLoading = kpiQuery.isLoading;

  return (
    <>
      {kpiQuery.error && (
        <p className="text-sm text-destructive">שגיאה בטעינת מטריקות: {kpiQuery.error.message}</p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="סה״כ לידים" value={k?.totalLeads ?? 0} icon={Users} isLoading={isLoading} />
        <KpiCard
          label="חדשים השבוע"
          value={k?.newThisWeek ?? 0}
          icon={Flame}
          hint="7 הימים האחרונים"
          isLoading={isLoading}
        />
        <KpiCard
          label="שיחות פעילות"
          value={k?.activeConversations ?? 0}
          icon={MessageCircle}
          isLoading={isLoading}
        />
        <KpiCard
          label="זום נקבע"
          value={k?.zoomScheduled ?? 0}
          icon={CalendarCheck}
          hint={
            k && k.totalLeads > 0
              ? `${Math.round((k.zoomScheduled / k.totalLeads) * 100)}% המרה`
              : undefined
          }
          isLoading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FunnelBreakdownChart
          breakdown={k?.funnelBreakdown ?? { cold: 0, mid: 0, done: 0 }}
          isLoading={isLoading}
        />
        <TagBreakdownList breakdown={k?.tagBreakdown ?? {}} isLoading={isLoading} />
      </div>

      <RecentLeadsList leads={k?.recentLeads ?? []} isLoading={isLoading} />
    </>
  );
}

function AdvancedAnalyticsTab({ agentId }: { agentId: string }) {
  const analyticsQuery = useQuery({
    queryKey: ["analytics", agentId] as const,
    queryFn: () => getAnalytics(agentId),
  });
  const operationsQuery = useQuery({
    queryKey: ["operations", agentId] as const,
    queryFn: () => getOperationsMetrics(agentId),
  });

  const a = analyticsQuery.data;
  const isLoading = analyticsQuery.isLoading;

  return (
    <>
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

      <div className="grid gap-3 md:grid-cols-2">
        <FunnelDropoffCard agentId={agentId} />
        <CampaignCohortsCard agentId={agentId} />
      </div>
      <HealthStatusCard />

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
    </>
  );
}

export default Index;
