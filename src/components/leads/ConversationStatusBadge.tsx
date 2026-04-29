import { Badge } from "@/components/ui/badge";
import type { ConversationStatus } from "@/types/conversation";

const LABEL: Record<ConversationStatus, string> = {
  active: "פעיל",
  paused: "מושהה",
  completed: "הושלם",
  opted_out: "הסיר עצמו",
};

const VARIANT: Record<ConversationStatus, "default" | "secondary" | "outline"> = {
  active: "default",
  paused: "secondary",
  completed: "outline",
  opted_out: "outline",
};

export function ConversationStatusBadge({ status }: { status: ConversationStatus | null }) {
  if (!status) return <Badge variant="outline">—</Badge>;
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>;
}
