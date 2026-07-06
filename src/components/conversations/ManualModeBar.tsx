import { Bot, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/types/conversation";

interface Props {
  conversation: Conversation;
  pending: boolean;
  onSetMode: (mode: "manual" | "ai") => void;
}

export function ManualModeBar({ conversation, pending, onSetMode }: Props) {
  const isManual = conversation.manual_mode_since != null;
  return (
    <div
      className={
        "flex items-center justify-between gap-2 border-t px-3 py-2 text-xs " +
        (isManual ? "bg-amber-50 text-amber-900" : "bg-muted/40 text-muted-foreground")
      }
    >
      <div className="flex items-center gap-1.5">
        {isManual ? <Hand className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        <span>{isManual ? "מצב ידני · ה-AI מושהה" : "AI פעיל · עונה אוטומטית"}</span>
      </div>
      <Button
        size="sm"
        variant={isManual ? "default" : "outline"}
        disabled={pending}
        onClick={() => onSetMode(isManual ? "ai" : "manual")}
      >
        {isManual ? "החזר לניהול AI" : "השתלט (מצב ידני)"}
      </Button>
    </div>
  );
}
