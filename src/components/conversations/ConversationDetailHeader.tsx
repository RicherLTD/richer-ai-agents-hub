import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { ArrowRight, Info } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { DisplayStatusBadge } from "@/components/leads/DisplayStatusBadge";
import { deriveDisplayStatus } from "@/lib/conversation-status";
import { FunnelStageBadge } from "@/components/leads/FunnelStageBadge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types/conversation";

const AVATAR_PALETTE = [
  "bg-rose-200 text-rose-900",
  "bg-amber-200 text-amber-900",
  "bg-emerald-200 text-emerald-900",
  "bg-sky-200 text-sky-900",
  "bg-violet-200 text-violet-900",
  "bg-fuchsia-200 text-fuchsia-900",
  "bg-teal-200 text-teal-900",
  "bg-orange-200 text-orange-900",
];

function hashStringToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function colourFor(seed: string): string {
  return AVATAR_PALETTE[hashStringToInt(seed) % AVATAR_PALETTE.length];
}

function initials(name: string | null, phone: string): string {
  const base = name?.trim() || phone;
  const parts = base.match(/\p{L}|\d/gu) ?? [];
  return (parts.slice(0, 2).join("") || "?").toUpperCase();
}

function lastSeenLabel(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `נראה לאחרונה ${formatDistanceToNow(d, { addSuffix: true, locale: he })}`;
}

interface Props {
  conversation: Conversation;
  onOpenDetails: () => void;
}

/**
 * WhatsApp-style chat header. Reduced metadata (just the badges that
 * matter for at-a-glance routing) and a "i" button that opens the
 * lead-memory side panel for the operator to drill in.
 */
export function ConversationDetailHeader({ conversation, onOpenDetails }: Props) {
  const navigate = useNavigate();
  const name = conversation.lead_name?.trim() || "ליד ללא שם";
  const avatarSeed = conversation.lead_phone || conversation.id;

  return (
    <header className="flex items-center justify-between gap-3 border-b bg-card/60 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={() => navigate("/conversations")}
          aria-label="חזרה לרשימה"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <button
          type="button"
          onClick={onOpenDetails}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-right transition hover:opacity-80"
        >
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarFallback className={cn("text-sm font-semibold", colourFor(avatarSeed))}>
              {initials(conversation.lead_name, conversation.lead_phone)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {lastSeenLabel(conversation.last_interaction_at)}
            </p>
          </div>
        </button>
      </div>
      <div className="flex items-center gap-2">
        <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
          <DisplayStatusBadge status={deriveDisplayStatus(conversation)} />
          <FunnelStageBadge stage={conversation.funnel_stage} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onOpenDetails}
          aria-label="פרטי ליד"
          title="פרטי ליד"
        >
          <Info className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
