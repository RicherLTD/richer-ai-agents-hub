import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Flame, Home, MessageCircle, Users } from "lucide-react";
import { FunnelBreakdownChart } from "@/components/dashboard/FunnelBreakdownChart";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { RecentLeadsList } from "@/components/dashboard/RecentLeadsList";
import { TagBreakdownList } from "@/components/dashboard/TagBreakdownList";
import { EmptyState } from "@/components/EmptyState";
import { useAgent } from "@/contexts/AgentContext";
import { getKpis } from "@/lib/kpis";

const Index = () => {
  const { activeAgent, isLoading: isAgentLoading } = useAgent();

  const kpiQuery = useQuery({
    queryKey: ["kpis", activeAgent?.id] as const,
    queryFn: () => getKpis(activeAgent!.id),
    enabled: Boolean(activeAgent?.id),
  });

  if (isAgentLoading) {
    return null;
  }
  if (!activeAgent) {
    return <EmptyState icon={Home} title="לא נבחר סוכן" />;
  }

  const k = kpiQuery.data;
  const isLoading = kpiQuery.isLoading;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">דף הבית</h1>
        <p className="text-sm text-muted-foreground">
          {activeAgent.display_name} — סקירה כללית
        </p>
      </header>

      {kpiQuery.error && (
        <p className="text-sm text-destructive">שגיאה בטעינת מטריקות: {kpiQuery.error.message}</p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="סה״כ לידים"
          value={k?.totalLeads ?? 0}
          icon={Users}
          isLoading={isLoading}
        />
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
    </div>
  );
};

export default Index;
