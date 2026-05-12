import { Check, Copy, Info } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Message } from "@/types/message";

interface Props {
  message: Message;
  /** Background of the bubble — light bubbles need a darker info icon. */
  bubbleTone: "primary" | "muted";
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function formatCostUsd(value: number | string | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `${(n * 100).toFixed(3)}¢`;
  if (n < 1) return `${(n * 100).toFixed(2)}¢`;
  return `$${n.toFixed(4)}`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Whether this message has any trace fields worth showing. Inbound rows
 * and old outbound rows from before Phase B will return false here.
 */
export function hasDebugInfo(message: Message): boolean {
  return Boolean(
    message.langfuse_trace_id
      || message.tokens_used
      || message.tokens_input
      || message.tokens_output
      || message.cost_usd
      || message.ai_processing_time_ms,
  );
}

export function MessageDebugPopover({ message, bubbleTone }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (text: string | null) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — degrade silently.
    }
  };

  const iconClass = bubbleTone === "primary"
    ? "text-primary-foreground/70 hover:text-primary-foreground"
    : "text-muted-foreground hover:text-foreground";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-5 w-5 items-center justify-center rounded transition-colors ${iconClass}`}
          aria-label="פרטי תפעול של ההודעה"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-right" align="start" side="top" sideOffset={6}>
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-semibold">פרטי תפעול</h4>
            <p className="text-xs text-muted-foreground">
              נתוני ה־Claude turn ששלח את ההודעה הזאת.
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">עלות</dt>
            <dd className="tabular-nums">{formatCostUsd(message.cost_usd)}</dd>

            <dt className="text-muted-foreground">Latency</dt>
            <dd className="tabular-nums">{formatMs(message.ai_processing_time_ms)}</dd>

            <dt className="text-muted-foreground">Tokens (in / out)</dt>
            <dd className="tabular-nums">
              {formatNumber(message.tokens_input)} / {formatNumber(message.tokens_output)}
            </dd>

            <dt className="text-muted-foreground">סך הכל tokens</dt>
            <dd className="tabular-nums">{formatNumber(message.tokens_used)}</dd>
          </dl>

          {message.langfuse_trace_id && (
            <div className="space-y-1 border-t pt-3">
              <p className="text-xs text-muted-foreground">Langfuse trace ID</p>
              <div className="flex items-center gap-1">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                  {message.langfuse_trace_id}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy(message.langfuse_trace_id)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border text-muted-foreground hover:bg-muted"
                  aria-label="העתק"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                הדבק את ה־ID בשורת החיפוש ב־cloud.langfuse.com כדי לפתוח את ה־trace המלא.
              </p>
            </div>
          )}

          {message.prompt_version_id && (
            <div className="border-t pt-3 text-xs">
              <p className="text-muted-foreground">Prompt version ID</p>
              <code className="mt-1 block truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                {message.prompt_version_id}
              </code>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
