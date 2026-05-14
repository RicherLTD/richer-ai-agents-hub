import { format, isSameDay, isToday, isYesterday } from "date-fns";
import { he } from "date-fns/locale";
import { ChevronUp, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Message } from "@/types/message";
import { MessageBubble } from "./MessageBubble";

interface Props {
  messages: Message[];
  isLoading: boolean;
  error: Error | null;
  hasOlder: boolean;
  onLoadOlder: () => void;
  isLoadingOlder: boolean;
}

function dayLabel(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  if (isToday(d)) return "היום";
  if (isYesterday(d)) return "אתמול";
  return format(d, "EEEE, d בMMMM yyyy", { locale: he });
}

export function MessageThread({
  messages,
  isLoading,
  error,
  hasOlder,
  onLoadOlder,
  isLoadingOlder,
}: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef<string | null>(null);

  // Auto-scroll to bottom on first load AND when a new message lands at
  // the end. Don't auto-scroll when older history is prepended (the user
  // is reading older messages — yanking them down would be hostile).
  useEffect(() => {
    if (messages.length === 0) return;
    const lastId = messages[messages.length - 1].id;
    if (lastId !== lastIdRef.current) {
      lastIdRef.current = lastId;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="ms-auto h-12 w-2/3" />
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="ms-auto h-12 w-3/5" />
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

  // Group by day: emit a date pill before the first message of each day.
  const rendered: React.ReactNode[] = [];
  let lastDay: string | null = null;
  for (const m of messages) {
    const ts = m.timestamp;
    const dayKey = ts ? new Date(ts).toDateString() : "no-date";
    if (dayKey !== lastDay) {
      rendered.push(
        <DateDivider key={`div-${dayKey}`} label={dayLabel(ts)} />,
      );
      lastDay = dayKey;
    }
    rendered.push(<MessageBubble key={m.id} message={m} />);
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 p-4",
        // WhatsApp-style chat paper background — soft warm tone with a
        // subtle diagonal grain. Plain bg-muted/40 here keeps it light.
        "bg-[#efeae2]",
      )}
    >
      {hasOlder && (
        <div className="flex justify-center pb-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
            className="gap-1.5"
          >
            {isLoadingOlder ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
            טען 30 הודעות קודמות
          </Button>
        </div>
      )}
      {rendered}
      <div ref={bottomRef} />
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  if (!label) return null;
  return (
    <div className="flex justify-center py-2">
      <span className="rounded-md bg-white/80 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
        {label}
      </span>
    </div>
  );
}

// Helper used to detect whether a freshly-loaded older page added
// anything new. Exported so the parent can compute `hasOlder` from the
// last page size.
export function lastMessageTimestamp(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.timestamp) return m.timestamp;
  }
  return null;
}
