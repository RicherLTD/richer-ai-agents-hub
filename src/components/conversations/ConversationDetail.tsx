import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getConversationById } from "@/lib/conversations";
import { getLeadMemory } from "@/lib/lead-memory";
import { getMessagesForConversation, sendOutboundMessage } from "@/lib/messages";
import { supabase } from "@/lib/supabase/client";
import { ConversationDetailHeader } from "./ConversationDetailHeader";
import { LeadMemoryPanel } from "./LeadMemoryPanel";
import { MessageThread } from "./MessageThread";
import { ReplyBox } from "./ReplyBox";

interface Props {
  conversationId: string;
}

export function ConversationDetail({ conversationId }: Props) {
  const queryClient = useQueryClient();

  // Realtime: refetch messages whenever a new row lands for this
  // conversation. Both inbound (Meta → edge function) and outbound
  // (agent reply / dashboard ReplyBox) hit `messages` directly, so this
  // single subscription covers every visible update without polling.
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
            queryKey: ["conversation", conversationId, "messages"],
          });
          void queryClient.invalidateQueries({
            queryKey: ["conversation", conversationId],
          });
          void queryClient.invalidateQueries({
            queryKey: ["conversation", conversationId, "memory"],
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

  return (
    <div className="flex h-full flex-col bg-background">
      <ConversationDetailHeader conversation={conversation} />
      <Tabs defaultValue="thread" dir="rtl" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="mx-4 mt-2 self-start">
          <TabsTrigger value="thread">שיחה</TabsTrigger>
          <TabsTrigger value="memory">סיכום + שאלות</TabsTrigger>
        </TabsList>
        <TabsContent value="thread" className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <MessageThread
              messages={messagesQuery.data ?? []}
              isLoading={messagesQuery.isLoading}
              error={messagesQuery.error as Error | null}
            />
          </div>
          <ReplyBox onSend={(content) => sendMutation.mutateAsync(content).then(() => undefined)} />
        </TabsContent>
        <TabsContent value="memory" className="flex-1 overflow-y-auto">
          <LeadMemoryPanel memory={memoryQuery.data} isLoading={memoryQuery.isLoading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
