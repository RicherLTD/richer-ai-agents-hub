import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DisplayStatusBadge } from "@/components/leads/DisplayStatusBadge";
import { deriveDisplayStatus } from "@/lib/conversation-status";
import type { Conversation } from "@/types/conversation";

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true, locale: he });
}

interface Props {
  leads: Conversation[];
  isLoading: boolean;
}

export function RecentLeadsList({ leads, isLoading }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">לידים אחרונים</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : leads.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">עדיין אין לידים.</p>
        ) : (
          <ul className="divide-y">
            {leads.map((lead) => (
              <li key={lead.id}>
                <Link
                  to={`/conversations/${lead.id}`}
                  className="flex items-center justify-between gap-3 py-3 text-sm transition hover:bg-accent/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {lead.lead_name?.trim() || "ליד ללא שם"}
                    </p>
                    <p dir="ltr" className="truncate text-right text-[11px] text-muted-foreground">
                      {lead.lead_phone}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <DisplayStatusBadge status={deriveDisplayStatus(lead)} />
                  </div>
                  <div className="shrink-0 text-[11px] text-muted-foreground">
                    {formatRelative(lead.last_interaction_at)}
                  </div>
                  <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
