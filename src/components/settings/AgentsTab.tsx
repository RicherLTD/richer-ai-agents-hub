import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Pencil, Play, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAgent } from "@/contexts/AgentContext";
import { useAuth } from "@/contexts/AuthContext";
import { createAgent, getAllAgentsForAdmin, updateAgent } from "@/lib/agents-admin";
import type { Agent, AgentInsert, AgentUpdate } from "@/types/agent";
import { AgentForm } from "./AgentForm";
import { AgentStatusBadge } from "./AgentStatusBadge";

const QUERY_KEY = ["admin", "agents"] as const;

export function AgentsTab() {
  const { isAdmin } = useAuth();
  const { refresh: refreshAgentContext } = useAgent();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getAllAgentsForAdmin,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    void refreshAgentContext();
  };

  const createMutation = useMutation({
    mutationFn: (input: AgentInsert) => createAgent(input),
    onSuccess: () => {
      toast.success("הסוכן נוצר בהצלחה");
      setCreating(false);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AgentUpdate }) => updateAgent(id, patch),
    onSuccess: () => {
      toast.success("הסוכן עודכן בהצלחה");
      setEditing(null);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Kill switch: toggle agent.is_paused. Confirmation dialog before pausing
  // so the operator can't tap the button by accident and silently take
  // the bot offline for live leads.
  const [confirmPause, setConfirmPause] = useState<Agent | null>(null);
  const pauseToggle = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      updateAgent(id, { is_paused: paused }),
    onSuccess: (_data, vars) => {
      toast.success(vars.paused ? "הסוכן הושהה" : "הסוכן הופעל מחדש", {
        description: vars.paused
          ? "הבוט לא יענה ללידים עד שתפעיל מחדש."
          : "הבוט חזר לפעולה.",
      });
      setConfirmPause(null);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">שגיאה בטעינת סוכנים: {error.message}</p>;
  }

  const list = agents ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">סוכנים</h2>
          <p className="text-sm text-muted-foreground">{list.length} סוכנים במערכת</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="ms-2 h-4 w-4" />
            סוכן חדש
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>שם תצוגה</TableHead>
              <TableHead>מזהה</TableHead>
              <TableHead>WhatsApp</TableHead>
              <TableHead>סטטוס</TableHead>
              <TableHead className="w-32">בוט</TableHead>
              {isAdmin && <TableHead className="w-16"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isAdmin ? 6 : 5} className="text-center text-sm text-muted-foreground">
                  אין סוכנים. {isAdmin && 'לחץ על "סוכן חדש" כדי להוסיף.'}
                </TableCell>
              </TableRow>
            ) : (
              list.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell className="font-medium">{agent.display_name}</TableCell>
                  <TableCell dir="ltr" className="font-mono text-xs text-muted-foreground">
                    {agent.name}
                  </TableCell>
                  <TableCell dir="ltr">{agent.whatsapp_number ?? "—"}</TableCell>
                  <TableCell>
                    <AgentStatusBadge status={agent.status} />
                  </TableCell>
                  <TableCell>
                    {isAdmin ? (
                      agent.is_paused ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => pauseToggle.mutate({ id: agent.id, paused: false })}
                          disabled={pauseToggle.isPending}
                          className="gap-1.5 text-amber-700"
                        >
                          <Play className="h-3.5 w-3.5" />
                          הפעל מחדש
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmPause(agent)}
                          disabled={pauseToggle.isPending}
                          className="gap-1.5"
                        >
                          <Pause className="h-3.5 w-3.5" />
                          השהה
                        </Button>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {agent.is_paused ? "מושהה" : "פעיל"}
                      </span>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => setEditing(agent)} aria-label="ערוך">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={creating} onOpenChange={(open) => !open && setCreating(false)}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>סוכן חדש</DialogTitle>
            <DialogDescription>הוסף סוכן חדש למערכת. שדות חובה מסומנים ב-*.</DialogDescription>
          </DialogHeader>
          <AgentForm
            onSubmit={(values) => createMutation.mutateAsync(values as AgentInsert)}
            onCancel={() => setCreating(false)}
            submitLabel="צור סוכן"
          />
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmPause)} onOpenChange={(open) => !open && setConfirmPause(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>להשהות את הסוכן?</DialogTitle>
            <DialogDescription>
              הבוט יפסיק לענות ללידים חדשים מיד. הודעות נכנסות עדיין יישמרו ויופיעו בדף שיחות,
              אבל לא ייענו אוטומטית עד שתפעיל מחדש.
            </DialogDescription>
          </DialogHeader>
          {confirmPause && (
            <p className="rounded border bg-muted/40 p-2 text-sm font-medium">
              {confirmPause.display_name}
            </p>
          )}
          <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
            <Button
              type="button"
              variant="destructive"
              onClick={() =>
                confirmPause && pauseToggle.mutate({ id: confirmPause.id, paused: true })
              }
              disabled={pauseToggle.isPending}
              className="gap-1.5"
            >
              <Pause className="h-4 w-4" />
              השהה את הבוט
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmPause(null)}
              disabled={pauseToggle.isPending}
            >
              ביטול
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>עריכת סוכן</DialogTitle>
            <DialogDescription>{editing?.display_name}</DialogDescription>
          </DialogHeader>
          {editing && (
            <AgentForm
              agent={editing}
              onSubmit={(values) =>
                updateMutation.mutateAsync({ id: editing.id, patch: values as AgentUpdate })
              }
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
