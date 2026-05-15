/**
 * AddToBrainDialog — converts one chat message into a brain note.
 *
 * Workflow: operator sees a problematic exchange in a lead conversation,
 * clicks the bookmark+ icon on the bubble, this dialog opens with the
 * message pre-quoted, operator types the lesson ("the bot should say X
 * instead"), saves. The result is a brain note that Coach will see on
 * every future turn — exactly the Klarna feedback-loop pattern.
 *
 * Self-contained: pulls the active agent + query client from context so
 * the call site (MessageBubble) just passes the message.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, StickyNote } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/contexts/AgentContext";
import { createNote } from "@/lib/brain";
import type { Message } from "@/types/message";

interface AddToBrainDialogProps {
  message: Message | null;
  /** Lead phone/name for the auto-generated title context. */
  leadLabel?: string | null;
  onClose: () => void;
}

function buildBody(message: Message, operatorNote: string, leadLabel: string | null): string {
  const speaker = message.direction === "inbound" ? `ליד${leadLabel ? ` (${leadLabel})` : ""}` : "הבוט";
  const messageQuote = (message.content ?? "").trim() || "(הודעה ריקה)";
  return [
    `דוגמה מתוך שיחה אמיתית:`,
    ``,
    `**${speaker} כתב:** "${messageQuote}"`,
    ``,
    `**מה הבוט צריך לדעת:**`,
    operatorNote.trim(),
  ].join("\n");
}

function buildDefaultTitle(message: Message, leadLabel: string | null): string {
  const dateLabel = message.timestamp
    ? new Date(message.timestamp).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" })
    : "";
  const speaker = message.direction === "inbound" ? "ליד" : "בוט";
  return `${speaker} (${leadLabel || "—"}) ${dateLabel}`.trim();
}

export function AddToBrainDialog({ message, leadLabel, onClose }: AddToBrainDialogProps) {
  const { activeAgent } = useAgent();
  const queryClient = useQueryClient();
  const agentId = activeAgent?.id ?? null;

  const [operatorNote, setOperatorNote] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (!message) return;
    setOperatorNote("");
    setTitle(buildDefaultTitle(message, leadLabel ?? null));
    setTags("");
    setShared(false);
  }, [message, leadLabel]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!agentId) throw new Error("בחר סוכן");
      if (!message) throw new Error("אין הודעה נבחרת");
      const body = buildBody(message, operatorNote, leadLabel ?? null);
      return createNote({
        agentId,
        title: title.trim() || buildDefaultTitle(message, leadLabel ?? null),
        body,
        tags: tags.split(/[,،]/).map((t) => t.trim()).filter(Boolean),
        sharedAcrossAgents: shared,
      });
    },
    onSuccess: () => {
      toast.success("הוסף למוח", {
        description: "Coach יזכור את זה בשיחה הבאה. אפשר לבדוק בטאב 'המוח'.",
      });
      void queryClient.invalidateQueries({ queryKey: ["coach", "brain", agentId] });
      onClose();
    },
    onError: (err: unknown) => {
      toast.error("השמירה נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const valid = operatorNote.trim().length > 0;

  return (
    <Dialog open={!!message} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StickyNote className="h-5 w-5" />
            הוסף למוח של הבוט
          </DialogTitle>
          <DialogDescription>
            תכתוב מה הבוט היה צריך לדעת או לעשות אחרת. זה ייכנס למוח כהערה
            קבועה, ו־Coach ישתמש בזה בעדכון ה־prompt הבא.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-3 overflow-y-auto pe-1">
          {message && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs">
              <p className="mb-1 font-medium text-muted-foreground">ההודעה המקורית</p>
              <p className="whitespace-pre-wrap text-foreground">
                {(message.content ?? "").trim() || "(ריקה)"}
              </p>
            </div>
          )}
          <div>
            <label className="text-xs font-medium">מה הבוט צריך לדעת? (חובה)</label>
            <Textarea
              value={operatorNote}
              onChange={(e) => setOperatorNote(e.target.value)}
              placeholder={
                message?.direction === "inbound"
                  ? "לדוגמה: כשליד שואל על משך התוכנית, הבוט צריך לענות 12 שבועות."
                  : "לדוגמה: הבוט ענה רע. התשובה הנכונה היא: …"
              }
              className="min-h-[100px]"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              ~{Math.ceil(operatorNote.length / 4)} טוקנים
            </p>
          </div>
          <div>
            <label className="text-xs font-medium">כותרת (אופציונלי)</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="כותרת לזיהוי ההערה במוח"
            />
          </div>
          <div>
            <label className="text-xs font-medium">תגיות (אופציונלי)</label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="לדוגמה: תיקון, מחיר, משך התוכנית"
            />
          </div>
          <label className="flex items-center justify-between gap-2 rounded-md border p-2">
            <div>
              <p className="text-sm font-medium">שתף עם כל הסוכנים</p>
              <p className="text-[11px] text-muted-foreground">
                כשפעיל, כל סוכן אחר יראה את ההערה הזו ב־Coach שלו.
              </p>
            </div>
            <Switch checked={shared} onCheckedChange={setShared} />
          </label>
        </div>
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!valid || saveMutation.isPending || !agentId}
          >
            {saveMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            הוסף למוח
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saveMutation.isPending}
          >
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
