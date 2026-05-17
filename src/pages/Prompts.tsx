import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { he } from "date-fns/locale";
import { Eye, FileText, GitCompare, RotateCcw } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { PromptReplayDialog } from "@/components/prompts/PromptReplayDialog";
import { PromptViewDialog } from "@/components/prompts/PromptViewDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAgent } from "@/contexts/AgentContext";
import { useAuth } from "@/contexts/AuthContext";
import { getDistinctPromptTypes, getPrompts, setActivePromptVersion } from "@/lib/prompts";
import type { Prompt } from "@/types/prompt";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d בMMM yyyy", { locale: he });
}

const Prompts = () => {
  const { activeAgent, isLoading: isAgentLoading } = useAgent();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [promptType, setPromptType] = useState<string>("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [viewing, setViewing] = useState<Prompt | null>(null);
  const [comparing, setComparing] = useState<Prompt | null>(null);
  const [activating, setActivating] = useState<Prompt | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const promptsQuery = useQuery({
    queryKey: ["prompts", activeAgent?.id, promptType, activeOnly] as const,
    queryFn: () =>
      getPrompts({
        agentId: activeAgent!.id,
        promptType,
        activeOnly,
      }),
    enabled: Boolean(activeAgent?.id),
  });

  const typesQuery = useQuery({
    queryKey: ["prompt-types", activeAgent?.id] as const,
    queryFn: () => getDistinctPromptTypes(activeAgent!.id),
    enabled: Boolean(activeAgent?.id),
  });

  const activateMutation = useMutation({
    mutationFn: (promptId: string) => setActivePromptVersion(promptId),
    onSuccess: () => {
      setActivating(null);
      setMutationError(null);
      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
    onError: (err) => {
      setMutationError(err instanceof Error ? err.message : String(err));
    },
  });

  if (isAgentLoading) return null;
  if (!activeAgent) return <EmptyState icon={FileText} title="לא נבחר סוכן" />;

  const list = promptsQuery.data ?? [];
  const types = typesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="label-mono" dir="ltr">Prompts · {activeAgent.name}</p>
        <h1 className="font-display text-3xl font-medium tracking-tight">ניהול Prompts</h1>
        <p className="text-sm text-muted-foreground">
          <span className="tabular-nums font-medium text-foreground">{list.length}</span> prompts לסוכן {activeAgent.display_name}.
        </p>
      </header>

      <Alert>
        <FileText className="h-4 w-4" />
        <AlertTitle>תצוגה בלבד</AlertTitle>
        <AlertDescription>
          Prompts נכתבים כקבצים ב-<code className="font-mono">prompts/</code> בריפו ומסונכרנים
          אוטומטית לטבלה. עריכה ישירה כאן תידרס בסנכרון הבא.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={promptType} onValueChange={setPromptType}>
          <SelectTrigger className="w-[200px]" aria-label="סוג prompt">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל הסוגים</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={activeOnly} onCheckedChange={setActiveOnly} />
          <span className="text-muted-foreground">רק פעילים</span>
        </label>
      </div>

      {promptsQuery.error && (
        <p className="text-sm text-destructive">שגיאה בטעינת prompts: {promptsQuery.error.message}</p>
      )}

      {promptsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>סוג</TableHead>
                <TableHead>גרסה</TableHead>
                <TableHead>סטטוס</TableHead>
                <TableHead>נוצר</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                    {activeOnly || promptType !== "all"
                      ? "אין prompts שתואמים לפילטרים."
                      : "עדיין אין prompts לסוכן הזה. הם יסונכרנו מהקבצים בריפו."}
                  </TableCell>
                </TableRow>
              ) : (
                list.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell dir="ltr" className="font-mono text-xs">
                      {p.prompt_type}
                    </TableCell>
                    <TableCell dir="ltr" className="font-mono text-xs">
                      {p.version}
                    </TableCell>
                    <TableCell>
                      {p.is_active ? <Badge>פעיל</Badge> : <Badge variant="outline">לא פעיל</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(p.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setViewing(p)}
                          aria-label="צפייה"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setComparing(p)}
                            aria-label="השווה לשיחת עבר"
                            title="השווה לשיחת עבר"
                          >
                            <GitCompare className="h-4 w-4" />
                          </Button>
                        )}
                        {isAdmin && !p.is_active && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setMutationError(null);
                              setActivating(p);
                            }}
                            aria-label="הפעל גרסה זו"
                            title="הפעל גרסה זו"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <PromptViewDialog prompt={viewing} onClose={() => setViewing(null)} />
      <PromptReplayDialog prompt={comparing} onClose={() => setComparing(null)} />

      <AlertDialog
        open={activating !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActivating(null);
            setMutationError(null);
          }
        }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להפעיל גרסה זו של ה־prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              {activating && (
                <>
                  הבוט יעבור לעבוד עם{" "}
                  <code dir="ltr" className="font-mono text-xs">
                    {activating.prompt_type} / {activating.version}
                  </code>{" "}
                  בתור הבא. הגרסה הפעילה הקודמת תסומן כלא פעילה אך תישאר בהיסטוריה.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mutationError && (
            <p className="text-sm text-destructive" dir="rtl">
              {mutationError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activateMutation.isPending}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              disabled={activateMutation.isPending}
              onClick={(e) => {
                // Prevent the dialog from closing immediately so we can
                // show the error if the mutation fails.
                e.preventDefault();
                if (!activating) return;
                activateMutation.mutate(activating.id);
              }}
            >
              {activateMutation.isPending ? "מפעיל…" : "כן, הפעל"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Prompts;
