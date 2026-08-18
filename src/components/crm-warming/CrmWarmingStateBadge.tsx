import { Badge } from "@/components/ui/badge";
import {
  CRM_NOT_WARMING_LABEL,
  CRM_WARMING_STATUS_LABEL,
  CRM_WARMING_STATUS_VARIANT,
  type CrmWarmingStatus,
} from "@/lib/crm-warming";

/**
 * The warming state of one lead. NULL is a real, meaningful state here — the
 * CRM fired a status event but nothing was warmed (kill switch off, no rule,
 * cooldown), so it gets a muted badge instead of an em dash.
 */
export function CrmWarmingStateBadge({ status }: { status: CrmWarmingStatus | null }) {
  if (status === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {CRM_NOT_WARMING_LABEL}
      </Badge>
    );
  }
  return (
    <Badge variant={CRM_WARMING_STATUS_VARIANT[status]}>{CRM_WARMING_STATUS_LABEL[status]}</Badge>
  );
}
