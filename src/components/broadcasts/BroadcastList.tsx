import { useAgent } from "@/contexts/AgentContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listBroadcasts, cancelBroadcast } from "@/lib/broadcasts";
import { Button } from "@/components/ui/button";

export function BroadcastList() {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const qc = useQueryClient();
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
          <th className="p-2">שם</th><th className="p-2">תבנית</th><th className="p-2">נמענים</th>
          <th className="p-2">סוננו</th><th className="p-2">סטטוס</th><th className="p-2"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} className="border-t">
            <td className="p-2">{b.title}</td>
            <td className="p-2">{b.template_name}</td>
            <td className="p-2">{b.total_recipients}</td>
            <td className="p-2">{b.suppressed_count}</td>
            <td className="p-2">{b.status}</td>
            <td className="p-2">
              {b.status !== "cancelled" && b.status !== "completed" && (
                <Button variant="ghost" size="sm" onClick={() => cancel.mutate(b.id)} disabled={cancel.isPending}>בטל</Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
