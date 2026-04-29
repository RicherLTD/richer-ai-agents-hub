import { Badge } from "@/components/ui/badge";
import type { FunnelStage } from "@/types/conversation";

const LABEL: Record<FunnelStage, string> = {
  cold: "קר",
  mid: "אמצע",
  done: "סגור",
};

const VARIANT: Record<FunnelStage, "secondary" | "default" | "outline"> = {
  cold: "secondary",
  mid: "default",
  done: "outline",
};

export function FunnelStageBadge({ stage }: { stage: FunnelStage | null }) {
  if (!stage) return <Badge variant="outline">—</Badge>;
  return <Badge variant={VARIANT[stage]}>{LABEL[stage]}</Badge>;
}
