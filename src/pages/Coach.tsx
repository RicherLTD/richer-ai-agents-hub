import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  Eye,
  ImagePlus,
  Loader2,
  RefreshCw,
  ShieldCheck,
  User as UserIcon,
  X as XIcon,
} from "lucide-react";

import { AdminOnly } from "@/components/auth/AdminOnly";
import { BrainPanel } from "@/components/coach/BrainPanel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgent } from "@/contexts/AgentContext";
import { supabase } from "@/lib/supabase/client";
import {
  applyCoachEdit,
  getCoachHistory,
  resignCoachAttachment,
  sendCoachMessage,
  uploadCoachAttachment,
  type CoachMessageRow,
  type UploadCoachAttachmentResult,
} from "@/lib/coach";

export default function CoachPage() {
  return (
    <AdminOnly>
      <CoachInner />
    </AdminOnly>
  );
}

function CoachInner() {
  const { activeAgent } = useAgent();
  const queryClient = useQueryClient();
  const agentId = activeAgent?.id ?? null;

  const [activeTab, setActiveTab] = useState<"chat" | "brain">("chat");
  const [draft, setDraft] = useState("");
  const [reviewing, setReviewing] = useState<CoachMessageRow | null>(null);
  const [attachment, setAttachment] = useState<UploadCoachAttachmentResult | null>(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const historyQuery = useQuery({
    queryKey: ["coach", "history", agentId],
    queryFn: () => getCoachHistory(agentId as string),
    enabled: !!agentId,
  });

  // The Coach edge function returns 202 immediately after persisting the
  // user row, then inserts the assistant row from a background task.
  // We subscribe to INSERTs on `coach_messages` so the reply lands in
  // the UI as soon as the background task finishes — no polling, no
  // sync-response timeout to fight.
  useEffect(() => {
    if (!agentId) return;
    const channel = supabase
      .channel(`coach_messages:${agentId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "coach_messages",
          filter: `agent_id=eq.${agentId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["coach", "history", agentId],
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [agentId, queryClient]);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      if (!agentId) throw new Error("בחר סוכן לפני שליחה");
      return sendCoachMessage({
        agentId,
        userMessage: text,
        attachmentUrl: attachment?.storagePath,
        attachmentBase64: attachment?.base64DataUrl,
        attachmentMediaType: attachment?.mediaType,
      });
    },
    onSuccess: () => {
      setDraft("");
      setAttachment(null);
      // The user row is already persisted server-side; Realtime will
      // refresh history when the background task lands the assistant
      // row. A manual invalidate here just shortens the visible lag.
      void queryClient.invalidateQueries({ queryKey: ["coach", "history", agentId] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "שליחת ההודעה נכשלה";
      toast.error("המאמן לא הגיב", { description: msg });
    },
  });

  const handleFileSelect = async (file: File) => {
    if (!agentId) {
      toast.error("בחר סוכן לפני העלאת תמונה");
      return;
    }
    setAttachmentUploading(true);
    try {
      const result = await uploadCoachAttachment(agentId, file);
      setAttachment(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ההעלאה נכשלה";
      toast.error("בעיה בהעלאת התמונה", { description: msg });
    } finally {
      setAttachmentUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const applyMutation = useMutation({
    mutationFn: (msgId: string) => applyCoachEdit(msgId),
    onSuccess: (result) => {
      toast.success("ה־prompt עודכן", {
        description: `גרסה חדשה: ${result.newVersion}. הבוט יענה לפיו מההודעה הבאה.`,
      });
      setReviewing(null);
      void queryClient.invalidateQueries({ queryKey: ["coach", "history", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "החלת השינוי נכשלה";
      toast.error("השינוי לא נשמר", { description: msg });
    },
  });

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historyQuery.data, sendMutation.isPending]);

  // Called by the Brain panel when the operator clicks "update the bot"
  // on a brain item. Sends a pre-formatted message that asks the Coach
  // to propose a prompt edit incorporating the new knowledge, then
  // switches to the chat tab so the operator can see the proposal land.
  const handleUpdateBotForBrain = (item: {
    id: string;
    title: string;
    source_kind: string;
  }) => {
    const kindLabel = item.source_kind === "note"
      ? "הערה חדשה"
      : item.source_kind === "pdf"
      ? "מסמך PDF חדש"
      : "תמונה חדשה";
    const message = `${kindLabel} נוספה למוח: "${item.title}".\n\nתקרא את התוכן שלה ב־<brain_doc id="${item.id}"> במוח, ותציע עדכון ל־prompt של הבוט שיכיר את העובדות הרלוונטיות מתוכה. אל תכניס את כל הטקסט — תזקק רק את מה שהבוט באמת צריך לדעת בשיחה עם ליד.`;
    setActiveTab("chat");
    sendMutation.mutate(message);
  };

  const messages = historyQuery.data ?? [];
  // The Coach is "thinking" whenever (a) the send mutation is still
  // in flight (rare — the function returns 202 in <1s) OR (b) the
  // latest history row is a user turn awaiting a server-side reply.
  // History-based detection means the indicator survives a page reload
  // mid-turn instead of disappearing the moment the mutation resolves.
  const lastMessage = messages[messages.length - 1];
  const isAwaitingAssistant =
    sendMutation.isPending || (!!lastMessage && lastMessage.role === "user");

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as "chat" | "brain")}
      className="flex h-full flex-col"
      dir="rtl"
    >
      <header className="border-b border-border px-6 py-5">
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <p className="label-mono" dir="ltr">Coach · Prompt Editor</p>
            <h1 className="font-display text-2xl font-medium tracking-tight">מאמן הבוט</h1>
            <p className="text-sm text-muted-foreground">
              משוב חופשי לבוט. Coach יקרא את ההיסטוריה והמוח ויציע שינוי ל־prompt — אתה מאשר.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TabsList className="inline-flex h-9 rounded-md border border-border bg-card/60 p-0.5 backdrop-blur">
              <TabsTrigger value="chat" className="rounded-sm px-3 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none">שיחה</TabsTrigger>
              <TabsTrigger value="brain" className="rounded-sm px-3 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none">המוח</TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => historyQuery.refetch()}
              disabled={historyQuery.isRefetching}
            >
              <RefreshCw className={`me-2 h-4 w-4 ${historyQuery.isRefetching ? "animate-spin" : ""}`} />
              רענון
            </Button>
          </div>
        </div>
      </header>

      <TabsContent value="chat" className="flex flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {!agentId && (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                בחר סוכן מהסיידבר כדי להתחיל
              </CardContent>
            </Card>
          )}
          {agentId && historyQuery.isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="me-2 h-5 w-5 animate-spin" />
              טוען היסטוריה...
            </div>
          )}
          {agentId && !historyQuery.isLoading && messages.length === 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4" />
                  ברוך הבא למאמן
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>
                  כתוב כאן משוב על איך הבוט מדבר עם הלידים. דוגמאות:
                </p>
                <ul className="ms-5 list-disc space-y-1">
                  <li>"הבוט יוצא יותר מדי שיווקי בהודעה הראשונה"</li>
                  <li>"שאל את הליד את שאלת הגיל בעדינות יותר"</li>
                  <li>"כשליד אומר שיש לו פחות מ-3 שעות בשבוע, תעצור לו ותציע לחזור פעם אחרת"</li>
                </ul>
                <p>
                  המאמן יקרא את ה־prompt הנוכחי + ההיסטוריה, יציע שינוי ממוקד, ואתם תאשרו או תבטלו.
                </p>
              </CardContent>
            </Card>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              onReview={() => setReviewing(m)}
            />
          ))}
          {isAwaitingAssistant && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              המאמן חושב...
            </div>
          )}
        </div>
      </div>

      <footer className="border-t px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {attachment && (
            <div className="mb-2 flex items-center gap-3 rounded-md border bg-muted/40 p-2">
              <img
                src={attachment.base64DataUrl}
                alt="תמונה מצורפת"
                className="h-14 w-14 rounded object-cover"
              />
              <span className="flex-1 text-xs text-muted-foreground">
                התמונה תישלח עם ההודעה הבאה
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setAttachment(null)}
                disabled={isAwaitingAssistant}
                aria-label="הסר תמונה"
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text || isAwaitingAssistant) return;
              sendMutation.mutate(text);
            }}
            className="flex items-end gap-2"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileSelect(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={!agentId || attachmentUploading || isAwaitingAssistant || !!attachment}
              aria-label="צרף תמונה"
              title="צרף תמונה"
            >
              {attachmentUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="h-4 w-4" />
              )}
            </Button>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                agentId
                  ? "כתוב משוב או שאלה למאמן..."
                  : "בחר סוכן מהסיידבר תחילה"
              }
              disabled={!agentId || isAwaitingAssistant}
              className="min-h-[60px] resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  const text = draft.trim();
                  if (text && !isAwaitingAssistant) sendMutation.mutate(text);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              disabled={!agentId || !draft.trim() || isAwaitingAssistant}
              aria-label="שלח"
            >
              {isAwaitingAssistant ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          </form>
          <p className="mt-2 text-[11px] text-muted-foreground">
            רמז: Cmd/Ctrl+Enter לשליחה מהירה. ניתן לצרף תמונה (עד 5MB).
          </p>
        </div>
      </footer>

      </TabsContent>

      <TabsContent
        value="brain"
        className="flex-1 overflow-y-auto px-6 py-4 data-[state=inactive]:hidden"
      >
        <BrainPanel onUpdateBot={handleUpdateBotForBrain} />
      </TabsContent>

      <ReviewProposalDialog
        message={reviewing}
        onClose={() => setReviewing(null)}
        onApply={(id) => applyMutation.mutate(id)}
        isApplying={applyMutation.isPending}
      />
    </Tabs>
  );
}

function MessageBubble({
  message,
  onReview,
}: {
  message: CoachMessageRow;
  onReview: () => void;
}) {
  const isUser = message.role === "user";
  const hasProposal = !!message.proposed_prompt_content;
  const isApplied = !!message.applied_prompt_id;
  const [attachmentSrc, setAttachmentSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!message.attachment_url) {
      setAttachmentSrc(null);
      return;
    }
    let cancelled = false;
    void resignCoachAttachment(message.attachment_url).then((url) => {
      if (!cancelled) setAttachmentSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [message.attachment_url]);

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-primary text-primary-foreground" : "bg-secondary"
        }`}
      >
        {isUser ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={`flex max-w-[80%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {attachmentSrc && (
          <a
            href={attachmentSrc}
            target="_blank"
            rel="noreferrer"
            className="block max-w-full overflow-hidden rounded-lg border"
          >
            <img
              src={attachmentSrc}
              alt="תמונה מצורפת"
              className="max-h-64 max-w-full object-contain"
            />
          </a>
        )}
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            isUser ? "bg-primary text-primary-foreground" : "bg-muted"
          }`}
        >
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>
        {hasProposal && (
          <div className="flex items-center gap-2">
            {isApplied ? (
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                הוחל
              </Badge>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={onReview}>
                <Eye className="me-1.5 h-3 w-3" />
                בדוק שינוי מוצע
              </Button>
            )}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          {new Date(message.created_at).toLocaleString("he-IL", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}

function ReviewProposalDialog({
  message,
  onClose,
  onApply,
  isApplying,
}: {
  message: CoachMessageRow | null;
  onClose: () => void;
  onApply: (id: string) => void;
  isApplying: boolean;
}) {
  // Acknowledgment gate: a tired operator at 11pm should not be able to
  // flip the bot\'s system prompt by accident. They must explicitly check
  // "I read the diff" before the Apply button activates. Resets when
  // the dialog opens for a new proposal.
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [message?.id]);

  return (
    <Dialog open={!!message} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            סקירת שינוי מוצע
          </DialogTitle>
          <DialogDescription>
            זה ה־prompt החדש שהמאמן מציע. אם תאשר — הבוט יתחיל לפעול לפיו מההודעה
            הבאה. אפשר תמיד לבטל דרך כפתור ה־Rollback בדף Prompts.
          </DialogDescription>
        </DialogHeader>
        {message && (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto pe-1">
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">סיכום המאמן</p>
              <div className="rounded border bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                {message.content}
              </div>
            </div>
            <div className="flex flex-1 flex-col">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">ה־prompt המוצע (החלפה מלאה)</p>
              <pre
                className="flex-1 min-h-[200px] overflow-auto rounded border bg-background p-3 text-xs leading-relaxed"
                dir="ltr"
              >
                {message.proposed_prompt_content ?? ""}
              </pre>
            </div>
          </div>
        )}
        <label className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 h-4 w-4"
            disabled={isApplying}
          />
          <span className="text-xs leading-relaxed">
            <strong>קראתי את ה־prompt המוצע במלואו</strong> ואני מאשר שהוא לא מסיר גבולות
            בטיחות (אסור לציין מחירים, אסור להבטיח הכנסות, אסור שהבוט יחשוף שהוא AI).
          </span>
        </label>
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => message && onApply(message.id)}
            disabled={!message || isApplying || !acknowledged}
          >
            {isApplying && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            אשר ופרסם
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={isApplying}>
            סגור בלי לשנות
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
