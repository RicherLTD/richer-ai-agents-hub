import { useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Message } from "@/types/message";
import { MessageBubble } from "./MessageBubble";

interface Props {
  messages: Message[];
  isLoading: boolean;
  error: Error | null;
}

export function MessageThread({ messages, isLoading, error }: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Pin the scroll to the latest message whenever the list grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="ms-auto h-12 w-1/2" />
        <Skeleton className="h-12 w-3/5" />
      </div>
    );
  }

  if (error) {
    return <p className="p-4 text-sm text-destructive">שגיאה בטעינת ההודעות: {error.message}</p>;
  }

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        אין עדיין הודעות בשיחה הזו.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
