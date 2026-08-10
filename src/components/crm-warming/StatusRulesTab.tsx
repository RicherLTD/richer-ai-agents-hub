import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  draftToPatch,
  listCrmStatusRules,
  updateCrmStatusRule,
  type CrmStatusRulePatch,
  type CrmStatusRuleRow,
  type StatusRuleDraft,
} from "@/lib/crm-warming";
import { StatusRuleDialog } from "./StatusRuleDialog";

/**
 * The operator's tuning surface: one row per CRM sub-status (~33), each holding
 * the instructions the bot gets when a lead from that status replies. Changes
 * take effect on the next turn — no deploy, no Meta approval.
 *
 * `crm_status_rules` is admin-only FOR ALL under RLS, so mutations go straight
 * through the supabase client (same shape as BroadcastTemplatesTab).
 */
export function StatusRulesTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CrmStatusRuleRow | null>(null);
  const [search, setSearch] = useState("");

  const queryKey = ["crm-status-rules", agentId] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => listCrmStatusRules(agentId),
    enabled: Boolean(agentId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CrmStatusRulePatch }) =>
      updateCrmStatusRule(id, patch),
    onSuccess: () => {
      toast.success("הכלל עודכן");
      setEditing(null);
      void invalidate();
    },
    onError: (err: unknown) =>
      toast.error("עדכון הכלל נכשל", {
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const rules = useMemo(() => data ?? [], [data]);
  const list = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rules;
    return rules.filter((rule) =>
      [
        rule.status_label,
        rule.objection_key,
        String(rule.status_sub),
        rule.warming_instructions,
      ].some((v) => v.toLowerCase().includes(term)),
    );
  }, [rules, search]);

  const activeCount = rules.filter((rule) => rule.is_active).length;

  const handleSave = async (draft: StatusRuleDraft) => {
    if (!editing) return;
    await updateMutation.mutateAsync({ id: editing.id, patch: draftToPatch(draft) });
  };

  if (error) {
    return <p className="text-sm text-destructive">שגיאה בטעינת כללי סטטוס: {error.message}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">כללי סטטוס</h2>
          <p className="text-sm text-muted-foreground">
            לכל סטטוס ב-CRM יש הנחיות משלו לבוט. שינוי כאן נכנס לתוקף מיד.{" "}
            <span className="tabular-nums font-medium text-foreground">{activeCount}</span> מתוך{" "}
            <span className="tabular-nums">{rules.length}</span> כללים פעילים.
          </p>
        </div>
        <div className="conic-focus relative min-w-[240px] rounded-md">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש בסטטוס, התנגדות או הנחיות…"
            className="pe-9"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card/40">
          <Table>
            <TableHeader className="bg-surface-subtle">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10 w-16">קוד</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">סטטוס</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">התנגדות</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">הנחיות לבוט</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10 w-20">השהיה</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10 w-20">צינון</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10 w-24">פעיל</TableHead>
                <TableHead className="h-10 w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="py-16 text-center text-sm text-muted-foreground">
                    {search.trim()
                      ? "אין כללים שתואמים לחיפוש."
                      : "עדיין לא הוגדרו כללי סטטוס לסוכן הזה."}
                  </TableCell>
                </TableRow>
              ) : (
                list.map((rule) => (
                  <TableRow key={rule.id} className="border-border-subtle">
                    <TableCell dir="ltr" className="font-mono text-xs tabular-nums text-muted-foreground">
                      {rule.status_sub}
                    </TableCell>
                    <TableCell className="font-medium">{rule.status_label.trim() || "—"}</TableCell>
                    <TableCell dir="ltr" className="font-mono text-xs text-muted-foreground">
                      {rule.objection_key.trim() || "—"}
                    </TableCell>
                    <TableCell className="max-w-[420px]">
                      {rule.warming_instructions.trim() ? (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {rule.warming_instructions}
                        </p>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          ללא הנחיות
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell dir="ltr" className="text-xs tabular-nums text-muted-foreground">
                      {rule.delay_hours}ש׳
                    </TableCell>
                    <TableCell dir="ltr" className="text-xs tabular-nums text-muted-foreground">
                      {rule.cooldown_days}י׳
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={rule.is_active}
                        disabled={updateMutation.isPending}
                        onCheckedChange={(checked) =>
                          updateMutation.mutate({ id: rule.id, patch: { is_active: checked } })
                        }
                        aria-label={`הפעל או כבה את הכלל לסטטוס ${rule.status_sub}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`ערוך את הכלל לסטטוס ${rule.status_sub}`}
                        onClick={() => setEditing(rule)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <StatusRuleDialog
        rule={editing}
        onClose={() => setEditing(null)}
        onSave={handleSave}
        isSaving={updateMutation.isPending}
      />
    </div>
  );
}
