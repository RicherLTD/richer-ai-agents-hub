/**
 * BroadcastTemplatesTab — admin CRUD for the `broadcast_templates` registry.
 *
 * These are the templates offered in the broadcast composer dropdown.
 * The name must match a template approved in Meta Business Manager exactly.
 * RLS on broadcast_templates is admin-only FOR ALL, so mutations go straight
 * through the supabase client — no edge function needed.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAgent } from "@/contexts/AgentContext";
import {
  createBroadcastTemplate,
  deleteBroadcastTemplate,
  listAllBroadcastTemplates,
  setBroadcastTemplateActive,
  type BroadcastTemplateFull,
} from "@/lib/broadcasts";

export function BroadcastTemplatesTab() {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [language, setLanguage] = useState("he");
  const [label, setLabel] = useState("");
  const [variableCount, setVariableCount] = useState("0");
  const [bodyPreview, setBodyPreview] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<BroadcastTemplateFull | null>(null);

  const queryKey = ["broadcast-templates-admin", agentId] as const;

  const listQuery = useQuery({
    queryKey,
    queryFn: () => listAllBroadcastTemplates(agentId),
    enabled: !!agentId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const createMutation = useMutation({
    mutationFn: createBroadcastTemplate,
    onSuccess: () => {
      toast.success("התבנית נוספה");
      setName("");
      setLanguage("he");
      setLabel("");
      setVariableCount("0");
      setBodyPreview("");
      void invalidate();
    },
    onError: (err: unknown) =>
      toast.error("הוספת תבנית נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      setBroadcastTemplateActive(id, isActive),
    onSuccess: () => void invalidate(),
    onError: (err: unknown) =>
      toast.error("עדכון הסטטוס נכשל", {
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBroadcastTemplate(id),
    onSuccess: () => {
      toast.success("התבנית נמחקה");
      setConfirmingDelete(null);
      void invalidate();
    },
    onError: (err: unknown) =>
      toast.error("מחיקת תבנית נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId) return;
    const trimmedName = name.trim();
    const trimmedLabel = label.trim();
    if (!trimmedName || !trimmedLabel) {
      toast.error("שם וכותרת הם שדות חובה");
      return;
    }
    const parsedCount = Number.parseInt(variableCount, 10);
    createMutation.mutate({
      agent_id: agentId,
      name: trimmedName,
      language: language.trim() || "he",
      label: trimmedLabel,
      variable_count: Number.isNaN(parsedCount) || parsedCount < 0 ? 0 : parsedCount,
      body_preview: bodyPreview.trim() || null,
    });
  };

  const rows = listQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">תבניות דיוור</h2>
        <p className="text-sm text-muted-foreground">
          התבניות שמופיעות בבורר הדיוור. התבנית חייבת להיות מאושרת ב-Meta Business Manager. השם כאן
          חייב להתאים בדיוק לשם המאושר.
        </p>
      </div>

      {/* Add template form */}
      <Card>
        <CardContent className="p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bt-label">כותרת (תצוגה)</Label>
                <Input
                  id="bt-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="למשל: מבצע חג"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-name">שם התבנית ב-Meta</Label>
                <Input
                  id="bt-name"
                  dir="ltr"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="holiday_promo_2026"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-language">שפה</Label>
                <Input
                  id="bt-language"
                  dir="ltr"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="he"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-vars">מספר משתנים</Label>
                <Input
                  id="bt-vars"
                  type="number"
                  min={0}
                  dir="ltr"
                  value={variableCount}
                  onChange={(e) => setVariableCount(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bt-body">תצוגה מקדימה של הטקסט (אופציונלי)</Label>
              <Textarea
                id="bt-body"
                value={bodyPreview}
                onChange={(e) => setBodyPreview(e.target.value)}
                placeholder="היי {{1}}, יש לנו עדכון בשבילך..."
                rows={3}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={createMutation.isPending || !agentId}>
                {createMutation.isPending ? (
                  <Loader2 className="ms-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="ms-2 h-4 w-4" />
                )}
                הוסף תבנית
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Templates list */}
      {!agentId ? (
        <p className="text-sm text-muted-foreground">בחר סוכן כדי לנהל תבניות.</p>
      ) : listQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : listQuery.error ? (
        <p className="text-sm text-destructive">
          שגיאה בטעינת תבניות: {(listQuery.error as Error).message}
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>כותרת</TableHead>
                <TableHead>שם ב-Meta</TableHead>
                <TableHead className="w-16">שפה</TableHead>
                <TableHead className="w-20">משתנים</TableHead>
                <TableHead className="w-28">פעילה</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    אין תבניות. הוסף את הראשונה באמצעות הטופס למעלה.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell dir="ltr" className="text-xs text-muted-foreground">
                      {row.name}
                    </TableCell>
                    <TableCell dir="ltr" className="text-xs">
                      {row.language}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs">{row.variable_count}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={row.is_active}
                          disabled={toggleMutation.isPending}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: row.id, isActive: checked })
                          }
                          aria-label="הפעל/כבה תבנית"
                        />
                        {row.is_active ? (
                          <Badge variant="default" className="gap-1 text-[10px]">
                            <CheckCircle2 className="h-3 w-3" />
                            פעילה
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            כבויה
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="מחק תבנית"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setConfirmingDelete(row)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={Boolean(confirmingDelete)}
        onOpenChange={(open) => !open && setConfirmingDelete(null)}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את "{confirmingDelete?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              התבנית תוסר מהרשימה ולא תופיע יותר בבורר הדיוור. הפעולה אינה משפיעה על התבנית המאושרת
              ב-Meta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmingDelete && deleteMutation.mutate(confirmingDelete.id)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "מוחק..." : "מחק"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
