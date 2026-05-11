import { format } from "date-fns";
import { he } from "date-fns/locale";
import { cn } from "@/lib/utils";
import type { Message } from "@/types/message";

function formatTime(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return format(d, "HH:mm", { locale: he });
}

export function MessageBubble({ message }: { message: Message }) {
  const isOutbound = message.direction === "outbound";
  const content = message.content?.trim() || "(הודעה ריקה)";

  return (
    <div className={cn("flex w-full", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow-sm",
          isOutbound
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
        <div
          className={cn(
            "mt-1 text-[10px] tabular-nums",
            isOutbound ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}
