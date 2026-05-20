import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DISPLAY_STATUSES,
  DISPLAY_STATUS_LABEL,
  type DisplayStatus,
} from "@/lib/conversation-status";

export type StatusFilter = DisplayStatus | "all";

interface Props {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  counts: Record<DisplayStatus, number>;
  totalLabel?: string;
}

export function StatusFilterChips({ value, onChange, counts, totalLabel = "הכל" }: Props) {
  const total = DISPLAY_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const items: Array<{ key: StatusFilter; label: string; count: number }> = [
    { key: "all", label: totalLabel, count: total },
    ...DISPLAY_STATUSES.map((s) => ({
      key: s as StatusFilter,
      label: DISPLAY_STATUS_LABEL[s],
      count: counts[s] ?? 0,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="סינון לפי סטטוס">
      {items.map((item) => {
        const isActive = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <span>{item.label}</span>
            <Badge
              variant={isActive ? "secondary" : "outline"}
              className="h-5 min-w-[1.5rem] px-1.5 text-[10px] tabular-nums"
            >
              {item.count}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
