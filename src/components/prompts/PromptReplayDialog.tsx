import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { AlertCircle, Loader2, Play } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgent } from "@/contexts/AgentContext";
import { getActiveConversations } from "@/lib/conversations";
import { runPromptReplay, type PromptReplayResult } from "@/lib/prompt-replay";
import type { Prompt } from "@/types/prompt";

interface Props {
  prompt: Prompt | null;
  onClose: () => void;
}

function formatCost(value: number | string | null): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n) || n === 0) return "$0";
  if (n < 0.01) return `${(n * 100).toFixed(2)}¢`;
  return `$${n.toFixed(4)}`;
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function PromptReplayDialog({ prompt, onClose }: Props) {
  const { activeAgent } = useAgent();
  const [selectedConvId, setSelectedConvId] = useState<string>("");

  const conversationsQuery = useQuery({
    queryKey: ["prompt-replay-conversations", activeAgent?.id] as const,
    queryFn: () =>
      getActiveConversations({
        agentId: activeAgent!.id,
        includeInactive: true,
        limit: 30,
      }),
    enabled: Boolean(prompt && activeAgent?.id),
  });

  const replayMutation = useMutation({
    mutationFn: (params: { promptId: string; conversationId: string }) =>
      runPromptReplay(params),
  });

  const handleClose = () => {
    setSelectedConvId("");
    replayMutation.reset();
    onClose();
  };

  const handleRun = () => {
    if (!prompt || !selectedConvId) return;
    replayMutation.mutate({ promptId: prompt.id, conversationId: selectedConvId });
  };

  const result = replayMutation.data;
  const conversations = conversationsQuery.data ?? [];

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        dir="rtl"
        className="flex max-h-[90vh] flex-col gap-4 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>
            השוואת prompt — <code dir="ltr" className="font-mono text-sm">{prompt?.prompt_type}/{prompt?.version}</code>
          </DialogTitle>
          <DialogDescription>
            בוחר שיחה מהעבר → ה־prompt הזה ייעבור על כל ההודעות של הליד וייצר תגובות אלטרנטיביות.
            הבוט לא מקבל מאום — זה רק להשוואה.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedConvId} onValueChange={setSelectedConvId}>
            <SelectTrigger className="w-[360px]" aria-label="בחר שיחה">
              <SelectValue placeholder="בחר שיחה להשוואה…" />
            </SelectTrigger>
            <SelectContent>
              {conversationsQuery.isLoading
                ? (
                  <div className="p-2 text-sm text-muted-foreground">טוען…</div>
                )
                : conversations.length === 0
                ? (
                  <div className="p-2 text-sm text-muted-foreground">אין שיחות זמינות.</div>
                )
                : (
                  conversations.map((c) => {
                    const label = c.lead_name?.trim() || c.lead_phone;
                    const when = c.last_interaction_at
                      ? formatDistanceToNow(new Date(c.last_interaction_at), {
                        locale: he,
                        addSuffix: true,
                      })
                      : "";
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        {label} · {when}
                      </SelectItem>
                    );
                  })
                )}
            </SelectContent>
          </Select>
          <Button
            onClick={handleRun}
            disabled={!selectedConvId || replayMutation.isPending}
          >
            {replayMutation.isPending
              ? (
                <>
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                  מריץ…
                </>
              )
              : (
                <>
                  <Play className="me-2 h-4 w-4" />
                  הרץ השוואה
                </>
              )}
          </Button>
        </div>

        {replayMutation.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{(replayMutation.error as Error).message}</p>
          </div>
        )}

        {replayMutation.isPending && (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {result && <ReplayResults result={result} />}
      </DialogContent>
    </Dialog>
  );
}

function ReplayResults({ result }: { result: PromptReplayResult }) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 p-3 text-xs">
        <div>
          <strong>{result.turnCount}</strong> תגובות הומצאו · עלות כוללת:{" "}
          <strong>{formatCost(result.totalCostUsd)}</strong>
          {result.truncated && (
            <span className="ms-2 text-amber-600">
              ⚠ שיחה ארוכה — נחתכה אחרי 30 תורות
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto">
        {result.turns.map((turn) => (
          <div
            key={turn.turnIndex}
            className="space-y-2 rounded-lg border bg-card p-3"
          >
            <div className="rounded-md bg-muted/40 p-2 text-sm">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                ליד אמר
              </div>
              <p className="whitespace-pre-wrap break-words">{turn.userMessage}</p>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="rounded-md border bg-muted/20 p-2 text-sm">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Prompt הפעיל אמר (בפועל)
                </div>
                <p className="whitespace-pre-wrap break-words">
                  {turn.originalReply ?? "(אין תגובה — השיחה נגמרה כאן)"}
                </p>
              </div>
              <div className="rounded-md border-2 border-primary/40 bg-primary/5 p-2 text-sm">
                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide">
                  <span className="text-primary">Prompt המועמד אמר</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatCost(turn.candidateCostUsd)} · {formatMs(turn.candidateLatencyMs)}
                  </span>
                </div>
                {turn.error
                  ? (
                    <p className="text-destructive">⚠ שגיאה: {turn.error}</p>
                  )
                  : (
                    <p className="whitespace-pre-wrap break-words">
                      {turn.candidateReply ?? "(תגובה ריקה)"}
                    </p>
                  )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
