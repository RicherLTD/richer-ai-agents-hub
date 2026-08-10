import { Flame } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { AdminOnly } from "@/components/auth/AdminOnly";
import { StatusRulesTab } from "@/components/crm-warming/StatusRulesTab";
import { WarmingLeadsTab } from "@/components/crm-warming/WarmingLeadsTab";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgent } from "@/contexts/AgentContext";

const TRIGGER_CLASS =
  "rounded-sm px-3 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none";

/**
 * CRM Warming — the operator's window into leads whose CRM status changed.
 *
 * Two tabs, deliberately on ONE page: the live traffic ("who did the CRM push
 * at us, and what did we do about it") and the rules that drive it ("what
 * should the bot say to that objection"). The operator's loop is
 * observe → tune → observe, so making the rules a Settings tab would put a
 * navigation round-trip in the middle of it. Settings keeps the per-agent
 * infrastructure knobs (kill switch, template, context window) — those are
 * set-and-forget.
 */
const CrmWarming = () => {
  const { activeAgent, isLoading } = useAgent();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!activeAgent) {
    return <EmptyState icon={Flame} title="לא נבחר סוכן" />;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2 pb-2">
        <p className="label-mono" dir="ltr">
          CRM Warming · {activeAgent.name}
        </p>
        <h1 className="font-display text-3xl font-medium tracking-tight">חימום לידים מה-CRM</h1>
        <p className="text-sm text-muted-foreground">
          לידים שנציג שינה להם סטטוס ב-Fireberry, והפנייה החוזרת שנשלחה בעקבות זה — עבור{" "}
          {activeAgent.display_name}.
        </p>
      </header>

      <Tabs defaultValue="leads" dir="rtl">
        <TabsList className="inline-flex h-9 w-auto rounded-md border border-border bg-card/60 p-0.5 backdrop-blur">
          <TabsTrigger value="leads" className={TRIGGER_CLASS}>
            לידים בחימום
          </TabsTrigger>
          <TabsTrigger value="rules" className={TRIGGER_CLASS}>
            כללי סטטוס
          </TabsTrigger>
        </TabsList>

        <TabsContent value="leads" className="pt-4">
          <WarmingLeadsTab agentId={activeAgent.id} />
        </TabsContent>

        {/* RLS on crm_status_rules is admin-only, so non-admins get the
            permission notice instead of a table that would come back empty. */}
        <TabsContent value="rules" className="pt-4">
          <AdminOnly>
            <StatusRulesTab agentId={activeAgent.id} />
          </AdminOnly>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default CrmWarming;
