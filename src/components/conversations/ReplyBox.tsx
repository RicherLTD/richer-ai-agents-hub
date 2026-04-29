import { Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  disabled?: boolean;
  onSend: (content: string) => Promise<void>;
}

export function ReplyBox({ disabled, onSend }: Props) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const content = text.trim();
    if (!content || pending) return;
    setPending(true);
    try {
      await onSend(content);
      setText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשליחה");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="border-t bg-background/80 p-3 backdrop-blur">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="הקלד תגובה (Enter לשליחה, Shift+Enter לשורה חדשה)"
          disabled={disabled || pending}
          className="flex-1 resize-none"
        />
        <Button
          onClick={() => void submit()}
          disabled={disabled || pending || !text.trim()}
          size="icon"
          aria-label="שלח"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        ההודעה תירשם ב-DB. שליחה לוואטסאפ תופעל אחרי חיבור n8n.
      </p>
    </div>
  );
}
