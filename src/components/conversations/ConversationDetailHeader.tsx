import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ConversationStatusBadge } from "@/components/leads/ConversationStatusBadge";
import { ConversationTagBadge } from "@/components/leads/ConversationTagBadge";
import { FunnelStageBadge } from "@/components/leads/FunnelStageBadge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/types/conversation";

function initials(name: string | null, phone: string): string {
  const base = name?.trim() || phone;
  const parts = base.match(/\p{L}|\d/gu) ?? [];
  return (parts.slice(0, 2).join("") || "?").toUpperCase();
}

export function ConversationDetailHeader({ conversation }: { conversation: Conversation }) {
  const navigate = useNavigate();
  const name = conversation.lead_name?.trim() || "ליד ללא שם";

  return (
    <header className="flex items-start justify-between gap-3 border-b bg-card/40 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={() => navigate("/conversations")}
          aria-label="חזרה לרשימה"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">
            {initials(conversation.lead_name, conversation.lead_phone)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p dir="ltr" className="truncate text-right font-mono text-xs text-muted-foreground">
            {conversation.lead_phone}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <FunnelStageBadge stage={conversation.funnel_stage} />
        <ConversationTagBadge tag={conversation.current_tag} />
        <ConversationStatusBadge status={conversation.status} />
      </div>
    </header>
  );
}
