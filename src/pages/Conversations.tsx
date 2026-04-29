import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ConversationListItem } from "@/components/conversations/ConversationListItem";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAgent } from "@/contexts/AgentContext";
import { getActiveConversations } from "@/lib/conversations";
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
  const [includeInactive, setIncludeInactive] = useState(false);
  const debouncedSearch = useDebounced(search, 300);

  const queryKey = useMemo(
    () => ["conversations", activeAgent?.id, debouncedSearch, includeInactive] as const,
    [activeAgent?.id, debouncedSearch, includeInactive],
  );

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      getActiveConversations({
        agentId: activeAgent!.id,
        search: debouncedSearch || undefined,
        includeInactive,
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
    return <EmptyState icon={MessageCircle} title="לא נבחר סוכן" />;
  }

  const list = data ?? [];

  const handleSelect = (c: Conversation) => {
    navigate(`/conversations/${c.id}`);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">שיחות פעילות</h1>
          <p className="text-sm text-muted-foreground">
            {activeAgent.display_name} — {list.length} שיחות{includeInactive ? " (כולל לא פעילות)" : ""}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
          <span className="text-muted-foreground">הצג גם לא פעילות</span>
        </label>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש לפי שם או טלפון…"
          className="ps-9"
        />
      </div>

      {error && <p className="text-sm text-destructive">שגיאה בטעינת שיחות: {error.message}</p>}

      <ScrollArea className="h-[calc(100vh-260px)] rounded-md border">
        <div className="space-y-1 p-2">
          {isLoading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : list.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {debouncedSearch
                ? "אין שיחות שתואמות לחיפוש."
                : includeInactive
                  ? "עדיין אין שיחות לסוכן הזה."
                  : "אין שיחות פעילות. הפעל את המתג שלמעלה כדי לראות גם שיחות לא פעילות."}
            </p>
          ) : (
            list.map((c) => (
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
  );
};

export default Conversations;
