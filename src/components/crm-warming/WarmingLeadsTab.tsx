import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { AlertTriangle, MessageSquareReply, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CopyPhoneButton } from "@/components/leads/CopyPhoneButton";
import {
  DateRangeFilter,
  type DatePreset,
  type DateRange,
} from "@/components/leads/DateRangeFilter";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebounced } from "@/hooks/use-debounced";
import {
  buildStatusRuleIndex,
  filterWarmingRows,
  getCrmWarmingRows,
  hasNoHistory,
  hasReplied,
  listCrmStatusRules,
  resolveStatusDisplay,
  summarizeWarming,
  warmingFilterCounts,
  type CrmWarmingFilter,
} from "@/lib/crm-warming";
import { CrmWarmingFilterChips } from "./CrmWarmingFilterChips";
import { CrmWarmingStateBadge } from "./CrmWarmingStateBadge";
import { CrmWarmingSummaryStrip } from "./CrmWarmingSummaryStrip";

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true, locale: he });
}

export function WarmingLeadsTab({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CrmWarmingFilter>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const debouncedSearch = useDebounced(search, 300);

  const { data, isLoading, error } = useQuery({
    queryKey: ["crm-warming", agentId, debouncedSearch, dateRange.from, dateRange.to] as const,
    queryFn: () =>
      getCrmWarmingRows({
        agentId,
        search: debouncedSearch || undefined,
        fromEventAt: dateRange.from,
        toEventAt: dateRange.to,
      }),
    enabled: Boolean(agentId),
  });

  // Rules carry the Hebrew status label + objection slug for each status_sub.
  // Cheap (~33 rows) and shared with the rules tab via the query cache.
  const rulesQuery = useQuery({
    queryKey: ["crm-status-rules", agentId] as const,
    queryFn: () => listCrmStatusRules(agentId),
    enabled: Boolean(agentId),
  });

  const rows = useMemo(() => data ?? [], [data]);
  const ruleIndex = useMemo(
    () => buildStatusRuleIndex(rulesQuery.data ?? []),
    [rulesQuery.data],
  );
  const summary = useMemo(() => summarizeWarming(rows), [rows]);
  const counts = useMemo(() => warmingFilterCounts(rows), [rows]);
  const list = useMemo(() => filterWarmingRows(rows, filter), [rows, filter]);

  const isFiltered =
    Boolean(debouncedSearch) || filter !== "all" || Boolean(dateRange.from) || Boolean(dateRange.to);

  return (
    <div className="space-y-4">
      <CrmWarmingSummaryStrip summary={summary} isLoading={isLoading} />

      <div className="space-y-3">
        <CrmWarmingFilterChips value={filter} onChange={setFilter} counts={counts} />
        <DateRangeFilter
          preset={datePreset}
          range={dateRange}
          onChange={({ preset, range }) => {
            setDatePreset(preset);
            setDateRange(range);
          }}
        />
        <div className="conic-focus relative rounded-md">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם או טלפון…"
            className="pe-9"
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive">שגיאה בטעינת לידים בחימום: {error.message}</p>
      )}
      {rulesQuery.error && (
        <p className="text-sm text-muted-foreground">
          לא ניתן לטעון את כללי הסטטוס — מוצגים קודי סטטוס גולמיים.
        </p>
      )}

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
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">ליד</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">סטטוס CRM</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">התנגדות</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">מצב חימום</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">אירוע סטטוס</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">חומם לאחרונה</TableHead>
                <TableHead className="label-mono !text-[10px] !text-muted-foreground/80 h-10">דגלים</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                    {isFiltered
                      ? "אין לידים שתואמים לסינון."
                      : "עדיין לא נרשמו אירועי סטטוס מה-CRM לסוכן הזה."}
                  </TableCell>
                </TableRow>
              ) : (
                list.map((row) => {
                  const status = resolveStatusDisplay(row, ruleIndex);
                  const noHistory = hasNoHistory(row);
                  const replied = hasReplied(row);
                  return (
                    <TableRow
                      key={row.id}
                      className="group cursor-pointer border-border-subtle transition-colors hover:bg-surface-hover"
                      onClick={() => navigate(`/conversations/${row.id}`)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/conversations/${row.id}`);
                        }
                      }}
                    >
                      <TableCell className="h-12">
                        <div className="font-medium text-foreground transition-colors group-hover:text-primary">
                          {row.lead_name?.trim() || "—"}
                        </div>
                        <div
                          dir="ltr"
                          className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          <span>{row.lead_phone}</span>
                          <CopyPhoneButton
                            phone={row.lead_phone}
                            className="sm:group-hover:opacity-100"
                          />
                        </div>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm">{status.label}</span>
                          {status.unmapped && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  ללא כלל פעיל
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                אין כלל פעיל לסטטוס {row.crm_status_sub} (חסר או כבוי) — הבוט מקבל
                                הנחיית ברירת מחדל במקום הנחיה ייעודית.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        {/* The rep's free-text note from the CRM — the only
                            per-lead context on this screen that a human wrote. */}
                        {row.crm_rep_note?.trim() && (
                          <div className="line-clamp-2 text-[11px] text-muted-foreground">
                            {row.crm_rep_note}
                          </div>
                        )}
                      </TableCell>

                      <TableCell dir="ltr" className="font-mono text-xs text-muted-foreground">
                        {status.objection ?? "—"}
                      </TableCell>

                      <TableCell>
                        <CrmWarmingStateBadge status={row.crm_warming_status} />
                      </TableCell>

                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelative(row.crm_status_event_at)}
                      </TableCell>

                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelative(row.crm_last_warmed_at)}
                      </TableCell>

                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {noHistory && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="outline"
                                  className="gap-1 border-amber-500/40 bg-amber-500/5 text-[10px] text-amber-700 dark:text-amber-400"
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  ללא היסטוריה
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                הליד מעולם לא שלח לנו הודעה — פנייה יזומה ללא שיחה קודמת.
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {replied && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="secondary" className="gap-1 text-[10px]">
                                  <MessageSquareReply className="h-3 w-3" />
                                  ענה
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                ענה {formatRelative(row.crm_warming_replied_at)}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {list.length > 0 && (
        <p className="text-xs text-muted-foreground">
          מוצגים <span className="tabular-nums font-medium text-foreground">{list.length}</span>{" "}
          מתוך {rows.length} אירועי סטטוס (עד 500 האחרונים).
        </p>
      )}
    </div>
  );
}
