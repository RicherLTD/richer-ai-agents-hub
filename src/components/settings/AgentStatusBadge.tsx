import { Badge } from "@/components/ui/badge";
import type { AgentStatus } from "@/types/agent";

const STATUS_LABEL: Record<AgentStatus, string> = {
  active: "פעיל",
  paused: "מושהה",
  archived: "בארכיון",
};

const STATUS_VARIANT: Record<AgentStatus, "default" | "secondary" | "outline"> = {
  active: "default",
  paused: "secondary",
  archived: "outline",
};

export function AgentStatusBadge({ status }: { status: AgentStatus | null }) {
  if (!status) return <Badge variant="outline">—</Badge>;
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}
