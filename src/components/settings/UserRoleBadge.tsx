import { Badge } from "@/components/ui/badge";
import type { AppRole } from "@/types/user";

const LABEL: Record<AppRole, string> = {
  admin: "אדמין",
  user: "משתמש",
};

const VARIANT: Record<AppRole, "default" | "secondary"> = {
  admin: "default",
  user: "secondary",
};

export function UserRoleBadge({ role }: { role: AppRole }) {
  return <Badge variant={VARIANT[role]}>{LABEL[role]}</Badge>;
}
