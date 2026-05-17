import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { ConversationStatusBadge } from "@/components/leads/ConversationStatusBadge";
import { ConversationTagBadge } from "@/components/leads/ConversationTagBadge";
import { FunnelStageBadge } from "@/components/leads/FunnelStageBadge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAgent } from "@/contexts/AgentContext";
import { getLeads } from "@/lib/leads";
import type { ConversationStatus, FunnelStage } from "@/types/conversation";

type FunnelFilter = FunnelStage | "all";
type StatusFilter = ConversationStatus | "all";

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true, locale: he });
}

function maskPhone(phone: string): string {
  // Phones are stored E.164 — keep as-is, just guarantee LTR rendering.
  return phone;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

const Leads = () => {
  const navigate = useNavigate();
  const { activeAgent, isLoading: isAgentLoading } = useAgent();
  const [search, setSearch] = useState("");
  const [funnel, setFunnel] = useState<FunnelFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const debouncedSearch = useDebounced(search, 300);

  const queryKey = useMemo(
    () => ["leads", activeAgent?.id, debouncedSearch, funnel, status] as const,
    [activeAgent?.id, debouncedSearch, funnel, status],
  );

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      getLeads({
        agentId: activeAgent!.id,
        search: debouncedSearch || undefined,
        funnelStage: funnel,
        status,
      }),
    enabled: Boolean(activeAgent?.id),
  });

  if (isAgentLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!activeAgent) {
    return <EmptyState icon={Users} title="לא נבחר סוכן" />;
  }

  const list = data ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4 pb-2">
        <div className="space-y-2">
          <p className="label-mono" dir="ltr">Leads · {activeAgent.name}</p>
          <h1 className="font-display text-3xl font-medium tracking-tight">לידים</h1>
          <p className="text-sm text-muted-foreground">
            <span className="tabular-nums font-medium text-foreground">{list.length}</span> לידים{debouncedSearch ? " (מסונן)" : ""} עבור {activeAgent.display_name}.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="conic-focus relative flex-1 min-w-[260px] rounded-md">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם או טלפון…"
            className="pe-9"
          />
        </div>
        <Select value={funnel} onValueChange={(v) => setFunnel(v as FunnelFilter)}>
          <SelectTrigger className="w-[160px]" aria-label="שלב משפך">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל השלבים</SelectItem>
            <SelectItem value="cold">קר</SelectItem>
            <SelectItem value="mid">אמצע</SelectItem>
            <SelectItem value="done">סגור</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-[160px]" aria-label="סטטוס שיחה">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל הסטטוסים</SelectItem>
            <SelectItem value="active">פעיל</SelectItem>
            <SelectItem value="paused">מושהה</SelectItem>
            <SelectItem value="completed">הושלם</SelectItem>
            <SelectItem value="opted_out">הסיר עצמו</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">שגיאה בטעינת לידים: {error.message}</p>}

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
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">שם</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">טלפון</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">שלב</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">תיוג</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">סטטוס</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">פעילות אחרונה</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
                    {debouncedSearch || funnel !== "all" || status !== "all"
                      ? "אין לידים שתואמים לפילטרים."
                      : "עדיין אין לידים לסוכן הזה. הם יופיעו כאן ברגע שיתחילו להגיע."}
                  </TableCell>
                </TableRow>
              ) : (
                list.map((lead) => (
                  <TableRow
                    key={lead.id}
                    className="group cursor-pointer border-border-subtle transition-colors hover:bg-surface-hover"
                    onClick={() => navigate(`/conversations/${lead.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/conversations/${lead.id}`);
                      }
                    }}
                  >
                    <TableCell className="h-12 font-medium text-foreground transition-colors group-hover:text-primary">
                      {lead.lead_name?.trim() || "—"}
                    </TableCell>
                    <TableCell dir="ltr" className="font-mono text-xs text-muted-foreground tabular-nums">
                      {maskPhone(lead.lead_phone)}
                    </TableCell>
                    <TableCell>
                      <FunnelStageBadge stage={lead.funnel_stage} />
                    </TableCell>
                    <TableCell>
                      <ConversationTagBadge tag={lead.current_tag} />
                    </TableCell>
                    <TableCell>
                      <ConversationStatusBadge status={lead.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(lead.last_interaction_at)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

export default Leads;
