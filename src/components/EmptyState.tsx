import type { LucideIcon } from "lucide-react";
import { useAgent } from "@/contexts/AgentContext";

interface EmptyStateProps {
  icon: LucideIcon;
  title?: string;
}

export function EmptyState({ icon: Icon, title }: EmptyStateProps) {
  const { activeAgent } = useAgent();

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card px-8 py-12 text-center shadow-sm">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <Icon className="h-8 w-8" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-foreground">
            {title ?? "מסך זה ייבנה בשלב הבא של הפיתוח"}
          </h2>
          {!title && (
            <p className="text-sm text-muted-foreground">
              הנתונים יוצגו עבור הסוכן:{" "}
              <span className="font-medium text-foreground">
                {activeAgent?.display_name ?? "—"}
              </span>
            </p>
          )}
          {title && (
            <p className="text-sm text-muted-foreground">
              הסוכן הפעיל:{" "}
              <span className="font-medium text-foreground">
                {activeAgent?.display_name ?? "—"}
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
