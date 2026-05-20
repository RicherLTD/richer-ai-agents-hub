import { Badge } from "@/components/ui/badge";
import {
  DISPLAY_STATUS_LABEL,
  DISPLAY_STATUS_VARIANT,
  type DisplayStatus,
} from "@/lib/conversation-status";

export function DisplayStatusBadge({ status }: { status: DisplayStatus }) {
  return <Badge variant={DISPLAY_STATUS_VARIANT[status]}>{DISPLAY_STATUS_LABEL[status]}</Badge>;
}
