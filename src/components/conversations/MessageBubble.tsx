import { format } from "date-fns";
import { he } from "date-fns/locale";
import { cn } from "@/lib/utils";
import type { Message } from "@/types/message";
import { hasDebugInfo, MessageDebugPopover } from "./MessageDebugPopover";

function formatTime(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return format(d, "HH:mm", { locale: he });
}

/**
 * One chat bubble in WhatsApp Desktop's style:
 *   - Outbound (us / the bot) → light-green bubble, right-aligned (in RTL,
 *     "right" is the speaker side; matches WhatsApp's behaviour).
 *   - Inbound (the lead) → white bubble, left-aligned.
 *   - Rounded corners, sharp tail-corner on the speaker side.
 *   - Timestamp inside the bubble at the bottom-end, tiny and subtle.
 */
export function MessageBubble({ message }: { message: Message }) {
  const isOutbound = message.direction === "outbound";
  const content = message.content?.trim() || "(הודעה ריקה)";
  const showDebug = isOutbound && hasDebugInfo(message);

  return (
    <div className={cn("flex w-full px-2", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm",
          isOutbound
            ? "rounded-br-sm bg-[#d9fdd3] text-foreground"
            : "rounded-bl-sm bg-white text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">{content}</p>
        <div
          className={cn(
            "mt-0.5 flex items-center justify-end gap-1.5 text-[10px] tabular-nums text-muted-foreground",
          )}
        >
          <span>{formatTime(message.timestamp)}</span>
          {showDebug && <MessageDebugPopover message={message} bubbleTone="muted" />}
        </div>
      </div>
    </div>
  );
}
