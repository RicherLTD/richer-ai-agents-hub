import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUp, Bot, CheckCircle2, Eye, Loader2, RefreshCw, ShieldCheck, User as UserIcon } from "lucide-react";

import { AdminOnly } from "@/components/auth/AdminOnly";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgent } from "@/contexts/AgentContext";
import {
  applyCoachEdit,
  getCoachHistory,
  sendCoachMessage,
  type CoachMessageRow,
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

  const [draft, setDraft] = useState("");
  const [reviewing, setReviewing] = useState<CoachMessageRow | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const historyQuery = useQuery({
    queryKey: ["coach", "history", agentId],
    queryFn: () => getCoachHistory(agentId as string),
    enabled: !!agentId,
  });

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      if (!agentId) throw new Error("בחר סוכן לפני שליחה");
      return sendCoachMessage({ agentId, userMessage: text });
    },
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["coach", "history", agentId] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "שליחת ההודעה נכשלה";
      toast.error("המאמן לא הגיב", { description: msg });
    },
  });

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

  const messages = historyQuery.data ?? [];

  return (
    <div className="flex h-full flex-col" dir="rtl">
      <header className="border-b px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">מאמן הבוט</h1>
            <p className="text-sm text-muted-foreground">
              כתבו פה משוב על הבוט. המאמן יציע שינוי ל־prompt, ואתם מאשרים בלחיצה.
            </p>
          </div>
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
      </header>

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
            <MessageBubble key={m.id} message={m} onReview={() => setReviewing(m)} />
          ))}
          {sendMutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              המאמן חושב...
            </div>
          )}
        </div>
      </div>

      <footer className="border-t px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text || sendMutation.isPending) return;
              sendMutation.mutate(text);
            }}
            className="flex items-end gap-2"
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                agentId
                  ? "כתוב משוב או שאלה למאמן..."
                  : "בחר סוכן מהסיידבר תחילה"
              }
              disabled={!agentId || sendMutation.isPending}
              className="min-h-[60px] resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  const text = draft.trim();
                  if (text && !sendMutation.isPending) sendMutation.mutate(text);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              disabled={!agentId || !draft.trim() || sendMutation.isPending}
              aria-label="שלח"
            >
              {sendMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          </form>
          <p className="mt-2 text-[11px] text-muted-foreground">
            רמז: Cmd/Ctrl+Enter לשליחה מהירה
          </p>
        </div>
      </footer>

      <ReviewProposalDialog
        message={reviewing}
        onClose={() => setReviewing(null)}
        onApply={(id) => applyMutation.mutate(id)}
        isApplying={applyMutation.isPending}
      />
    </div>
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
  return (
    <Dialog open={!!message} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" dir="rtl">
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
          <div className="mt-2 space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">סיכום המאמן</p>
              <div className="rounded border bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                {message.content}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">ה־prompt המוצע (החלפה מלאה)</p>
              <pre
                className="max-h-[420px] overflow-auto rounded border bg-background p-3 text-xs leading-relaxed"
                dir="ltr"
              >
                {message.proposed_prompt_content ?? ""}
              </pre>
            </div>
          </div>
        )}
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => message && onApply(message.id)}
            disabled={!message || isApplying}
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
