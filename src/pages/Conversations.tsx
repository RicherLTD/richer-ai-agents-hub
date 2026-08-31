import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, MessageCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ConversationDetail } from "@/components/conversations/ConversationDetail";
import { ConversationListItem } from "@/components/conversations/ConversationListItem";
import { DateRangeFilter, type DatePreset, type DateRange } from "@/components/leads/DateRangeFilter";
import { StatusFilterChips, type StatusFilter } from "@/components/leads/StatusFilterChips";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAgent } from "@/contexts/AgentContext";
import { getActiveConversations } from "@/lib/conversations";
import { getNeedsAttentionQueue } from "@/lib/needs-attention";
import { deriveDisplayStatus, statusBreakdown } from "@/lib/conversation-status";
import type { Conversation } from "@/types/conversation";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

const Conversations = () => {
  const navigate = useNavigate();
  const { id: activeConversationId } = useParams();
  const { activeAgent, isLoading: isAgentLoading } = useAgent();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  // When on, the list shows the operator queue instead of the filtered list.
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const debouncedSearch = useDebounced(search, 300);

  const queryKey = useMemo(
    () =>
      [
        "conversations",
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
      getActiveConversations({
        agentId: activeAgent!.id,
        search: debouncedSearch || undefined,
        fromCreatedAt: dateRange.from,
        toCreatedAt: dateRange.to,
      }),
    enabled: Boolean(activeAgent?.id),
  });

  // The queue is fetched separately from the main list: a lead the bot
  // dropped days ago is still waiting now, so it must not be hidden by the
  // page's date filter or the 500-row window.
  const { data: attentionRows } = useQuery({
    queryKey: ["conversations-attention", activeAgent?.id],
    queryFn: () => getNeedsAttentionQueue(activeAgent!.id),
    enabled: Boolean(activeAgent?.id),
    refetchInterval: 60_000,
  });
  const attentionQueue = useMemo(() => attentionRows ?? [], [attentionRows]);

  const rows = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => statusBreakdown(rows), [rows]);
  const filtered = useMemo(() => {
    if (attentionOnly) return attentionQueue;
    if (status === "all") return rows;
    return rows.filter((r) => deriveDisplayStatus(r) === status);
  }, [rows, status, attentionOnly, attentionQueue]);

  if (isAgentLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!activeAgent) {
    return <EmptyState icon={MessageCircle} title="לא נבחר סוכן" />;
  }

  const handleSelect = (c: Conversation) => {
    navigate(`/conversations/${c.id}`);
  };

  const showDetailOnMobile = Boolean(activeConversationId);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <header className="space-y-3">
        <div className="space-y-2">
          <p className="label-mono" dir="ltr">Conversations · {activeAgent.name}</p>
          <h1 className="font-display text-3xl font-medium tracking-tight">שיחות</h1>
          <p className="text-sm text-muted-foreground">
            <span className="tabular-nums font-medium text-foreground">{filtered.length}</span> שיחות
            {attentionOnly
              ? " שממתינות לטיפול נציג"
              : (status !== "all" ? " מסוננות" : "")}
            {!attentionOnly && (dateRange.from || dateRange.to) ? " (לפי תאריך)" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusFilterChips
            value={attentionOnly ? "all" : status}
            onChange={(next) => {
              setAttentionOnly(false);
              setStatus(next);
            }}
            counts={counts}
          />
          {attentionQueue.length > 0 && (
            <button
              type="button"
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                attentionOnly
                  ? "border-destructive bg-destructive text-destructive-foreground"
                  : "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
              )}
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              <span>דרוש טיפול</span>
              <Badge
                variant={attentionOnly ? "secondary" : "outline"}
                className="h-5 min-w-[1.5rem] px-1.5 text-[10px] tabular-nums"
              >
                {attentionQueue.length}
              </Badge>
            </button>
          )}
        </div>
        <DateRangeFilter
          preset={datePreset}
          range={dateRange}
          onChange={({ preset, range }) => {
            setDatePreset(preset);
            setDateRange(range);
          }}
        />
      </header>

      <div className="flex flex-1 gap-3 overflow-hidden rounded-lg border border-border bg-card/40">
        <div
          className={cn(
            "flex w-full flex-col lg:w-[360px] lg:shrink-0",
            showDetailOnMobile && "hidden lg:flex",
          )}
        >
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש לפי שם או טלפון…"
                className="ps-9"
              />
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-1 p-2">
              {isLoading ? (
                <>
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </>
              ) : error ? (
                <p className="p-4 text-sm text-destructive">שגיאה: {error.message}</p>
              ) : filtered.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {attentionOnly
                    ? "אין שיחות שממתינות לטיפול — הכל מטופל 🎉"
                    : debouncedSearch || status !== "all" || dateRange.from || dateRange.to
                    ? "אין שיחות שתואמות לסינון."
                    : "עדיין אין שיחות לסוכן הזה."}
                </p>
              ) : (
                filtered.map((c) => (
                  <ConversationListItem
                    key={c.id}
                    conversation={c}
                    isActive={activeConversationId === c.id}
                    onClick={handleSelect}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        <div
          className={cn(
            "flex flex-1 flex-col overflow-hidden border-l",
            !showDetailOnMobile && "hidden lg:flex",
          )}
        >
          {activeConversationId ? (
            <ConversationDetail conversationId={activeConversationId} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <MessageCircle className="h-8 w-8 text-muted-foreground/60" />
              <p>בחר שיחה מהרשימה כדי לפתוח אותה.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Conversations;
