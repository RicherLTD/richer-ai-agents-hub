import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { he } from "date-fns/locale";
import { Eye, FileText } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { PromptViewDialog } from "@/components/prompts/PromptViewDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAgent } from "@/contexts/AgentContext";
import { getDistinctPromptTypes, getPrompts } from "@/lib/prompts";
import type { Prompt } from "@/types/prompt";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d בMMM yyyy", { locale: he });
}

const Prompts = () => {
  const { activeAgent, isLoading: isAgentLoading } = useAgent();
  const [promptType, setPromptType] = useState<string>("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [viewing, setViewing] = useState<Prompt | null>(null);

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

  if (isAgentLoading) return null;
  if (!activeAgent) return <EmptyState icon={FileText} title="לא נבחר סוכן" />;

  const list = promptsQuery.data ?? [];
  const types = typesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">ניהול Prompts</h1>
        <p className="text-sm text-muted-foreground">
          {activeAgent.display_name} — {list.length} prompts
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
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setViewing(p)}
                        aria-label="צפייה"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <PromptViewDialog prompt={viewing} onClose={() => setViewing(null)} />
    </div>
  );
};

export default Prompts;
