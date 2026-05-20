import { format, isSameDay, isYesterday } from "date-fns";
import { he } from "date-fns/locale";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DisplayStatusBadge } from "@/components/leads/DisplayStatusBadge";
import { deriveDisplayStatus } from "@/lib/conversation-status";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types/conversation";

/**
 * Pick a stable, pleasant background colour for the avatar. WhatsApp
 * does this — each contact without a photo gets a deterministic colour
 * based on their phone/name so the list is visually distinguishable.
 */
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

/**
 * WhatsApp-style timestamp: today → HH:mm, yesterday → "אתמול",
 * this week → day name, older → dd/MM/yy.
 */
function formatSidebarTime(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (isSameDay(d, now)) return format(d, "HH:mm");
  if (isYesterday(d)) return "אתמול";
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 7) return format(d, "EEEE", { locale: he });
  return format(d, "dd/MM/yy");
}

interface Props {
  conversation: Conversation;
  isActive?: boolean;
  onClick: (conversation: Conversation) => void;
}

export function ConversationListItem({ conversation, isActive, onClick }: Props) {
  const name = conversation.lead_name?.trim() || "ליד ללא שם";
  const avatarSeed = conversation.lead_phone || conversation.id;
  const displayStatus = deriveDisplayStatus(conversation);
  const isLive = displayStatus === "opened" || displayStatus === "zoom_scheduled";
  return (
    <button
      type="button"
      onClick={() => onClick(conversation)}
      className={cn(
        "group/row relative flex w-full items-center gap-3 border-b border-border-subtle px-3 py-3 text-right transition-colors",
        "hover:bg-surface-hover",
        isActive && "bg-surface-hover",
      )}
    >
      {/* Vertical brand bar — visible when active. Linear/Arc signature. */}
      <span
        aria-hidden
        className={cn(
          "absolute right-0 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity",
          isActive ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="relative shrink-0">
        <Avatar className="h-11 w-11 ring-1 ring-border">
          <AvatarFallback className={cn("text-sm font-semibold", colourFor(avatarSeed))}>
            {initials(conversation.lead_name, conversation.lead_phone)}
          </AvatarFallback>
        </Avatar>
        {/* Pulsing presence dot for active conversations */}
        {isLive && (
          <span className="presence-dot absolute -bottom-0.5 -left-0.5" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatSidebarTime(conversation.last_interaction_at)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <p dir="ltr" className="flex-1 truncate text-right font-mono text-[11px] text-muted-foreground tabular-nums">
            {conversation.lead_phone}
          </p>
          <DisplayStatusBadge status={deriveDisplayStatus(conversation)} />
        </div>
      </div>
    </button>
  );
}
