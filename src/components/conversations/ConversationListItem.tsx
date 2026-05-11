import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ConversationStatusBadge } from "@/components/leads/ConversationStatusBadge";
import { ConversationTagBadge } from "@/components/leads/ConversationTagBadge";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types/conversation";

function initials(name: string | null, phone: string): string {
  const base = name?.trim() || phone;
  // Strip non-letters, take first two letters / digits.
  const parts = base.match(/\p{L}|\d/gu) ?? [];
  return (parts.slice(0, 2).join("") || "?").toUpperCase();
}

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true, locale: he });
}

interface Props {
  conversation: Conversation;
  isActive?: boolean;
  onClick: (conversation: Conversation) => void;
}

export function ConversationListItem({ conversation, isActive, onClick }: Props) {
  const name = conversation.lead_name?.trim() || "ליד ללא שם";
  return (
    <button
      type="button"
      onClick={() => onClick(conversation)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-right transition",
        "hover:bg-accent/40",
        isActive ? "border-primary bg-primary-soft/40" : "border-transparent",
      )}
    >
      <Avatar className="h-10 w-10 shrink-0">
        <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">
          {initials(conversation.lead_name, conversation.lead_phone)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium">{name}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatRelative(conversation.last_interaction_at)}
          </span>
        </div>
        <p dir="ltr" className="truncate text-right font-mono text-[11px] text-muted-foreground">
          {conversation.lead_phone}
        </p>
        <div className="flex flex-wrap gap-1">
          <ConversationTagBadge tag={conversation.current_tag} />
          {conversation.status && conversation.status !== "active" && (
            <ConversationStatusBadge status={conversation.status} />
          )}
        </div>
      </div>
    </button>
  );
}
