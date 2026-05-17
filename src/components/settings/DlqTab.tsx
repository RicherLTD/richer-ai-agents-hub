/**
 * DlqTab — admin view of failed_messages with retry controls.
 *
 * Two action modes:
 *   1. Per-row "נסה שוב" button
 *   2. Bulk "נסה את כל ה־<X>" buttons grouped by error_type
 *
 * Rows already resolved (resolved_at not null) are hidden by default;
 * toggle "כלול תקלות פתורות" surfaces them for the audit view.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ZapOff,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listFailedMessages,
  replayBatch,
  replayFailedMessage,
  type FailedMessageRow,
} from "@/lib/dlq";

const MAX_RETRIES = 3;

const ERROR_TYPE_LABELS: Record<string, string> = {
  hookmyapp_send_failed: "שליחה ל־WhatsApp נכשלה",
  handoff_webhook_failed: "Webhook ליועצים נכשל",
  send_succeeded_insert_failed: "נשלח אבל לא נשמר",
  claude_invalid_reply: "תגובת AI לא תקינה",
  claude_api_error: "שגיאת API של Claude",
  judge_rejected_reply: "Haiku חסם תגובה",
  missing_active_prompt: "אין prompt פעיל",
  history_load_failed: "טעינת היסטוריה נכשלה",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `${mins}ד׳`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}ש׳`;
  return `${Math.floor(h / 24)}י׳`;
}

function labelFor(errorType: string): string {
  return ERROR_TYPE_LABELS[errorType] ?? errorType;
}

const REPLAYABLE: ReadonlySet<string> = new Set([
  "hookmyapp_send_failed",
  "handoff_webhook_failed",
]);

export function DlqTab() {
  const queryClient = useQueryClient();
  const [includeResolved, setIncludeResolved] = useState(false);

  const listQuery = useQuery({
    queryKey: ["dlq", "list", includeResolved] as const,
    queryFn: () => listFailedMessages({ includeResolved }),
    refetchInterval: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["dlq"] });

  const retryOne = useMutation({
    mutationFn: (id: string) => replayFailedMessage(id),
    onSuccess: (result) => {
      const r = result.results[0];
      if (r?.success) {
        toast.success("נשלח שוב בהצלחה", { description: r.reason });
      } else {
        toast.error("ניסיון נוסף נכשל", { description: r?.reason ?? "" });
      }
      refresh();
    },
    onError: (err: unknown) => {
      toast.error("שגיאה בניסיון חוזר", {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const retryBatch = useMutation({
    mutationFn: (errorType?: string) => replayBatch({ errorType }),
    onSuccess: (result) => {
      toast.success(`ניסיון חוזר: ${result.succeeded} הצליחו, ${result.failed} נכשלו`, {
        description: `${result.attempted} שורות מתוך התור.`,
      });
      refresh();
    },
    onError: (err: unknown) => {
      toast.error("ניסיון חוזר נכשל", {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const rows = listQuery.data ?? [];
  const openRows = rows.filter((r) => !r.resolved_at);
  const groupedOpen = new Map<string, number>();
  for (const r of openRows) {
    if (REPLAYABLE.has(r.error_type) && r.retry_count < MAX_RETRIES) {
      groupedOpen.set(r.error_type, (groupedOpen.get(r.error_type) ?? 0) + 1);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">תקלות (DLQ)</h2>
          <p className="text-sm text-muted-foreground">
            הודעות שנכשלו ולא הגיעו ליעד. ניתן לנסות שוב.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={includeResolved} onCheckedChange={setIncludeResolved} />
          <span className="text-muted-foreground">כלול תקלות פתורות</span>
        </label>
      </div>

      {/* Bulk retry buttons per error_type */}
      {groupedOpen.size > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <span className="text-xs text-muted-foreground me-2">פעולות מהירות:</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => retryBatch.mutate(undefined)}
              disabled={retryBatch.isPending}
              className="gap-1.5"
            >
              {retryBatch.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              נסה שוב את הכל
            </Button>
            {Array.from(groupedOpen.entries()).map(([type, count]) => (
              <Button
                key={type}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => retryBatch.mutate(type)}
                disabled={retryBatch.isPending}
                className="gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {labelFor(type)} ({count})
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      {listQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : listQuery.error ? (
        <p className="text-sm text-destructive">
          שגיאה בטעינת תקלות: {(listQuery.error as Error).message}
        </p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm font-medium">אין תקלות פתוחות</p>
            <p className="text-xs text-muted-foreground">
              כל ההודעות נשלחו בהצלחה. שגיאות יופיעו כאן אוטומטית.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>סוג התקלה</TableHead>
                <TableHead>פרטים</TableHead>
                <TableHead className="w-20">ניסיונות</TableHead>
                <TableHead className="w-24">לפני</TableHead>
                <TableHead className="w-32">סטטוס</TableHead>
                <TableHead className="w-32">פעולה</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <DlqRowDisplay
                  key={row.id}
                  row={row}
                  onRetry={() => retryOne.mutate(row.id)}
                  isPending={retryOne.isPending && retryOne.variables === row.id}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function DlqRowDisplay({
  row,
  onRetry,
  isPending,
}: {
  row: FailedMessageRow;
  onRetry: () => void;
  isPending: boolean;
}) {
  const isResolved = !!row.resolved_at;
  const canRetry =
    !isResolved && REPLAYABLE.has(row.error_type) && row.retry_count < MAX_RETRIES;
  const retriesLeft = MAX_RETRIES - row.retry_count;

  return (
    <TableRow className={isResolved ? "opacity-50" : ""}>
      <TableCell>
        <div className="flex items-center gap-2">
          {isResolved ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className="text-xs font-medium">{labelFor(row.error_type)}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground" dir="ltr">
          {row.source}
        </p>
      </TableCell>
      <TableCell>
        <p className="line-clamp-2 max-w-[36ch] text-xs text-muted-foreground" dir="ltr">
          {row.error_detail ?? row.resolution_note ?? "—"}
        </p>
      </TableCell>
      <TableCell className="tabular-nums text-xs">
        {row.retry_count}/{MAX_RETRIES}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{timeAgo(row.created_at)}</TableCell>
      <TableCell>
        {isResolved ? (
          <Badge variant="default" className="gap-1 text-[10px]">
            <CheckCircle2 className="h-3 w-3" />
            פתורה
          </Badge>
        ) : row.retry_count >= MAX_RETRIES ? (
          <Badge variant="destructive" className="gap-1 text-[10px]">
            <ZapOff className="h-3 w-3" />
            סופי
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            {retriesLeft} ניסיונות נשארו
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {canRetry ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={isPending}
            className="gap-1.5"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            נסה שוב
          </Button>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
