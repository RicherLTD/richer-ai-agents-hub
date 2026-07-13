import { Fragment, useState } from "react";
import { useAgent } from "@/contexts/AgentContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { listBroadcasts, cancelBroadcast } from "@/lib/broadcasts";
import { getBroadcastFunnel } from "@/lib/template-funnel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TemplateFunnelRowView } from "@/components/analytics/TemplateFunnelRowView";

const COL_COUNT = 6;

function BroadcastFunnelDetail({
  agentId,
  broadcastId,
}: {
  agentId: string;
  broadcastId: string;
}) {
  const q = useQuery({
    queryKey: ["broadcast-funnel", agentId, broadcastId],
    queryFn: () => getBroadcastFunnel(agentId, broadcastId),
    enabled: !!agentId && !!broadcastId,
  });

  return (
    <div className="space-y-2 p-2">
      <p className="text-xs text-muted-foreground">
        משפך הדיוור (נשלח → נמסר → נקרא → נענו → זום)
      </p>
      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">אין עדיין נתונים</p>
      ) : (
        <div className="space-y-3">
          {q.data.map((row) => (
            <TemplateFunnelRowView key={row.templateName} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BroadcastList() {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["broadcasts", agentId],
    queryFn: () => listBroadcasts(agentId),
    enabled: !!agentId,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelBroadcast(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["broadcasts", agentId] }),
  });

  if (q.isLoading) return <p>טוען…</p>;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="text-muted-foreground">אין דיוורים עדיין.</p>;

  return (
    <table className="w-full text-sm" dir="rtl">
      <thead>
        <tr className="text-right">
          <th className="p-2"></th>
          <th className="p-2">שם</th><th className="p-2">תבנית</th><th className="p-2">נמענים</th>
          <th className="p-2">סוננו</th><th className="p-2">סטטוס</th><th className="p-2"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => {
          const expanded = expandedId === b.id;
          return (
            <Fragment key={b.id}>
              <tr
                className="cursor-pointer border-t hover:bg-muted/40"
                onClick={() => setExpandedId(expanded ? null : b.id)}
              >
                <td className="p-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={expanded ? "כווץ" : "הרחב"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedId(expanded ? null : b.id);
                    }}
                  >
                    {expanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronLeft className="h-4 w-4" />
                    )}
                  </Button>
                </td>
                <td className="p-2">{b.title}</td>
                <td className="p-2">{b.template_name}</td>
                <td className="p-2">{b.total_recipients}</td>
                <td className="p-2">{b.suppressed_count}</td>
                <td className="p-2">{b.status}</td>
                <td className="p-2">
                  {b.status !== "cancelled" && b.status !== "completed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancel.mutate(b.id);
                      }}
                      disabled={cancel.isPending}
                    >
                      בטל
                    </Button>
                  )}
                </td>
              </tr>
              {expanded && (
                <tr className="border-t bg-muted/20">
                  <td colSpan={COL_COUNT + 1}>
                    <BroadcastFunnelDetail agentId={agentId} broadcastId={b.id} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
