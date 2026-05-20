import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Search } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useAgent } from "@/contexts/AgentContext";
import { getActiveConversations } from "@/lib/conversations";
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

  const rows = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => statusBreakdown(rows), [rows]);
  const filtered = useMemo(() => {
    if (status === "all") return rows;
    return rows.filter((r) => deriveDisplayStatus(r) === status);
  }, [rows, status]);

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
            {status !== "all" ? " מסוננות" : ""}
            {dateRange.from || dateRange.to ? " (לפי תאריך)" : ""}
          </p>
        </div>
        <StatusFilterChips value={status} onChange={setStatus} counts={counts} />
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
                  {debouncedSearch || status !== "all" || dateRange.from || dateRange.to
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
