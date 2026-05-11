import { Badge } from "@/components/ui/badge";
import type { ConversationTag } from "@/types/conversation";

const LABEL: Record<ConversationTag, string> = {
  not_hotlist: "לא רשימה חמה",
  hotlist: "רשימה חמה",
  hotlist_plus: "רשימה חמה+",
  questionnaire: "שאלון",
  zoom_scheduled: "זום נקבע",
  ghosted: "נעלם",
  opted_out: "הסיר עצמו",
  requires_human: "דורש נציג",
  underage: "מתחת לגיל",
  block_risk: "סיכון חסימה",
};

const VARIANT: Record<ConversationTag, "default" | "secondary" | "outline" | "destructive"> = {
  not_hotlist: "secondary",
  hotlist: "default",
  hotlist_plus: "default",
  questionnaire: "secondary",
  zoom_scheduled: "default",
  ghosted: "outline",
  opted_out: "outline",
  requires_human: "destructive",
  underage: "destructive",
  block_risk: "destructive",
};

export function ConversationTagBadge({ tag }: { tag: ConversationTag | null }) {
  if (!tag) return <Badge variant="outline">—</Badge>;
  return <Badge variant={VARIANT[tag]}>{LABEL[tag]}</Badge>;
}
