import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ATTENTION_DESCRIPTION,
  ATTENTION_LABEL,
  isAttentionReason,
} from "@/lib/needs-attention";

/**
 * Marks a lead that is waiting on a human. Distinct from ConversationTagBadge
 * on purpose: a tag says what the lead IS, this says what the operator has to
 * DO — and unlike a blocking tag it does not mean the bot has stopped.
 */
export function NeedsAttentionBadge({ reason }: { reason: string | null }) {
  if (!isAttentionReason(reason)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {ATTENTION_LABEL[reason]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{ATTENTION_DESCRIPTION[reason]}</TooltipContent>
    </Tooltip>
  );
}
