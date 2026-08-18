import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CRM_WARMING_FILTERS,
  CRM_WARMING_FILTER_LABEL,
  type CrmWarmingFilter,
} from "@/lib/crm-warming";

interface Props {
  value: CrmWarmingFilter;
  onChange: (next: CrmWarmingFilter) => void;
  counts: Record<CrmWarmingFilter, number>;
}

/**
 * Chip row, mirroring `StatusFilterChips` on the Leads screen. These chips are
 * views rather than a partition — "ענו" and "ללא היסטוריה" deliberately overlap
 * the state chips, because the operator asks both "what state is it in?" and
 * "who did we message cold?".
 */
export function CrmWarmingFilterChips({ value, onChange, counts }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="סינון חימום">
      {CRM_WARMING_FILTERS.map((filter) => {
        const isActive = filter === value;
        const isRisk = filter === "no_history";
        return (
          <button
            key={filter}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(filter)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : isRisk
                  ? "border-amber-500/40 bg-amber-500/5 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                  : "border-border bg-card text-muted-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <span>{CRM_WARMING_FILTER_LABEL[filter]}</span>
            <Badge
              variant={isActive ? "secondary" : "outline"}
              className="h-5 min-w-[1.5rem] px-1.5 text-[10px] tabular-nums"
            >
              {counts[filter] ?? 0}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
