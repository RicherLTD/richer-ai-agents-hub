import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { DateRangeFilter, type DatePreset, type DateRange } from "@/components/leads/DateRangeFilter";
import { DisplayStatusBadge } from "@/components/leads/DisplayStatusBadge";
import { FunnelStageBadge } from "@/components/leads/FunnelStageBadge";
import { StatusFilterChips, type StatusFilter } from "@/components/leads/StatusFilterChips";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAgent } from "@/contexts/AgentContext";
import { deriveDisplayStatus, statusBreakdown } from "@/lib/conversation-status";
import { getLeads } from "@/lib/leads";
import type { FunnelStage } from "@/types/conversation";

type FunnelFilter = FunnelStage | "all";

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true, locale: he });
}

function maskPhone(phone: string): string {
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
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const debouncedSearch = useDebounced(search, 300);

  const queryKey = useMemo(
    () =>
      [
        "leads",
        activeAgent?.id,
        debouncedSearch,
        dateRange.from,
        dateRange.to,
      ] as const,
    [activeAgent?.id, debouncedSearch, dateRange.from, dateRange.to],
  );

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      getLeads({
        agentId: activeAgent!.id,
        search: debouncedSearch || undefined,
        fromCreatedAt: dateRange.from,
        toCreatedAt: dateRange.to,
      }),
    enabled: Boolean(activeAgent?.id),
  });

  const rows = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => statusBreakdown(rows), [rows]);
  const list = useMemo(() => {
    return rows.filter((lead) => {
      if (funnel !== "all" && lead.funnel_stage !== funnel) return false;
      if (status !== "all" && deriveDisplayStatus(lead) !== status) return false;
      return true;
    });
  }, [rows, funnel, status]);

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

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4 pb-2">
        <div className="space-y-2">
          <p className="label-mono" dir="ltr">Leads · {activeAgent.name}</p>
          <h1 className="font-display text-3xl font-medium tracking-tight">לידים</h1>
          <p className="text-sm text-muted-foreground">
            <span className="tabular-nums font-medium text-foreground">{list.length}</span> לידים
            {debouncedSearch ? " (מסונן)" : ""} עבור {activeAgent.display_name}.
          </p>
        </div>
      </header>

      <div className="space-y-3">
        <StatusFilterChips value={status} onChange={setStatus} counts={counts} />
        <DateRangeFilter
          preset={datePreset}
          range={dateRange}
          onChange={({ preset, range }) => {
            setDatePreset(preset);
            setDateRange(range);
          }}
        />
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
        </div>
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
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">סטטוס</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">שלב</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">פעילות אחרונה</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-16 text-center text-sm text-muted-foreground">
                    {debouncedSearch || funnel !== "all" || status !== "all" || dateRange.from || dateRange.to
                      ? "אין לידים שתואמים לסינון."
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
                      <DisplayStatusBadge status={deriveDisplayStatus(lead)} />
                    </TableCell>
                    <TableCell>
                      <FunnelStageBadge stage={lead.funnel_stage} />
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
