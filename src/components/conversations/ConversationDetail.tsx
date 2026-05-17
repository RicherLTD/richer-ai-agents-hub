import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { getConversationById } from "@/lib/conversations";
import { getLeadMemory } from "@/lib/lead-memory";
import {
  getMessagesForConversation,
  getOlderMessages,
  MESSAGE_PAGE_SIZE,
  sendOutboundMessage,
} from "@/lib/messages";
import { supabase } from "@/lib/supabase/client";
import type { Message } from "@/types/message";
import { ConversationDetailHeader } from "./ConversationDetailHeader";
import { LeadMemoryPanel } from "./LeadMemoryPanel";
import { MessageThread } from "./MessageThread";
import { ReplyBox } from "./ReplyBox";

interface Props {
  conversationId: string;
}

export function ConversationDetail({ conversationId }: Props) {
  const queryClient = useQueryClient();
  const [olderPages, setOlderPages] = useState<Message[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Reset pagination state when switching conversations.
  useEffect(() => {
    setOlderPages([]);
    setHasOlder(true);
    setIsLoadingOlder(false);
  }, [conversationId]);

  // Realtime: refetch the freshest page when a new message lands. One
  // predicate-based invalidation refreshes all three keys (messages,
  // conversation, memory) in a single pass instead of three parallel
  // network calls per inbound message.
  useEffect(() => {
    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            predicate: (q) =>
              Array.isArray(q.queryKey) &&
              q.queryKey[0] === "conversation" &&
              q.queryKey[1] === conversationId,
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId, queryClient]);

  const conversationQuery = useQuery({
    queryKey: ["conversation", conversationId] as const,
    queryFn: () => getConversationById(conversationId),
  });

  const messagesQuery = useQuery({
    queryKey: ["conversation", conversationId, "messages"] as const,
    queryFn: () => getMessagesForConversation(conversationId),
  });

  const memoryQuery = useQuery({
    queryKey: ["conversation", conversationId, "memory"] as const,
    queryFn: () => getLeadMemory(conversationId),
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) => sendOutboundMessage({ conversationId, content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId, "messages"],
      });
    },
  });

  const handleLoadOlder = useCallback(async () => {
    const freshest = messagesQuery.data?.[0];
    if (!freshest?.timestamp) return;
    // Use the oldest message we currently have (across freshest + already-loaded
    // older pages) as the cursor for the next page.
    const oldestInLoaded = olderPages[0]?.timestamp ?? freshest.timestamp;
    setIsLoadingOlder(true);
    try {
      const next = await getOlderMessages(conversationId, oldestInLoaded);
      setOlderPages((prev) => [...next, ...prev]);
      if (next.length < MESSAGE_PAGE_SIZE) setHasOlder(false);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [conversationId, messagesQuery.data, olderPages]);

  if (conversationQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <Skeleton className="h-16 w-full" />
        <div className="flex-1 space-y-3 p-4">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="ms-auto h-12 w-1/2" />
        </div>
      </div>
    );
  }

  if (conversationQuery.error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        שגיאה: {conversationQuery.error.message}
      </div>
    );
  }

  const conversation = conversationQuery.data;
  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <MessageCircle className="h-6 w-6 text-muted-foreground/60" />
        <p>השיחה לא נמצאה או שאין לך גישה אליה.</p>
      </div>
    );
  }

  const messagesForThread = [...olderPages, ...(messagesQuery.data ?? [])];
  const isAtFirstPage =
    !messagesQuery.data || messagesQuery.data.length < MESSAGE_PAGE_SIZE;

  return (
    <div className="flex h-full flex-col bg-background">
      <ConversationDetailHeader
        conversation={conversation}
        onOpenDetails={() => setDetailsOpen(true)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <MessageThread
            messages={messagesForThread}
            isLoading={messagesQuery.isLoading}
            error={messagesQuery.error as Error | null}
            hasOlder={hasOlder && !isAtFirstPage}
            onLoadOlder={() => void handleLoadOlder()}
            isLoadingOlder={isLoadingOlder}
            leadLabel={conversation.lead_name?.trim() || conversation.lead_phone}
          />
        </div>
        <ReplyBox onSend={(content) => sendMutation.mutateAsync(content).then(() => undefined)} />
      </div>

      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent side="left" className="w-full sm:max-w-md" dir="rtl">
          <SheetHeader>
            <SheetTitle>פרטי הליד</SheetTitle>
            <SheetDescription>
              סיכום AI + תשובות 5 השאלות. מתעדכן אוטומטית אחרי כל תור של הבוט.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 overflow-y-auto pe-1">
            <LeadMemoryPanel memory={memoryQuery.data} isLoading={memoryQuery.isLoading} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
