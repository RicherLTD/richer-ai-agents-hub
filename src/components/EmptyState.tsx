import type { LucideIcon } from "lucide-react";
import { useAgent } from "@/contexts/AgentContext";

interface EmptyStateProps {
  icon: LucideIcon;
  title?: string;
}

export function EmptyState({ icon: Icon, title }: EmptyStateProps) {
  const { activeAgent } = useAgent();

  return (
    <div className="relative flex min-h-[60vh] items-center justify-center overflow-hidden">
      {/* Dot grid texture — "data lives here" feel */}
      <div
        aria-hidden
        className="absolute inset-0 dot-bg opacity-30 [mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,black,transparent)]"
      />
      <div className="relative flex max-w-md flex-col items-center gap-4 rounded-lg border border-border bg-card/80 px-8 py-12 text-center backdrop-blur">
        <div className="flex h-14 w-14 items-center justify-center rounded-md border border-border bg-card text-primary">
          <Icon className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <h2 className="font-display text-xl font-medium text-foreground">
            {title ?? "מסך זה ייבנה בשלב הבא"}
          </h2>
          <p className="text-sm text-muted-foreground">
            הסוכן הפעיל:{" "}
            <span className="font-medium text-foreground">
              {activeAgent?.display_name ?? "—"}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
