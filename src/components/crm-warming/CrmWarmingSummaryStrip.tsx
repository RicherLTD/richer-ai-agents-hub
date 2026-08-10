import { AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CrmWarmingSummary } from "@/lib/crm-warming";

interface Props {
  summary: CrmWarmingSummary;
  isLoading?: boolean;
}

interface Tile {
  label: string;
  value: number;
  hint?: string;
  accent?: boolean;
}

/**
 * Compact stat strip above the table. Deliberately lighter than the dashboard
 * KpiCard — this is an at-a-glance sanity check while scanning rows, not the
 * hero of the screen.
 */
export function CrmWarmingSummaryStrip({ summary, isLoading }: Props) {
  const tiles: Tile[] = [
    { label: "בחימום", value: summary.warming },
    { label: "ענו", value: summary.replied, hint: "מתוך כלל האירועים" },
    { label: "הומרו", value: summary.converted },
    { label: "לא בחימום", value: summary.notWarming, hint: "אירוע נרשם, לא חומם" },
    {
      label: "ללא היסטוריה",
      value: summary.noHistory,
      hint: "מעולם לא כתבו לנו",
      accent: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <Card
          key={tile.label}
          className={cn(
            "border-border bg-card/60 p-3",
            tile.accent && "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <div className="flex items-center gap-1.5">
            {tile.accent && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />}
            <p className="label-mono !text-[10px] !text-muted-foreground/80">{tile.label}</p>
          </div>
          {isLoading ? (
            <Skeleton className="mt-1.5 h-7 w-12" />
          ) : (
            <p
              className={cn(
                "mt-1 text-2xl font-semibold tabular-nums leading-none tracking-tight",
                tile.accent ? "text-amber-700 dark:text-amber-400" : "text-foreground",
              )}
            >
              {tile.value}
            </p>
          )}
          {tile.hint && <p className="mt-1 text-[11px] text-muted-foreground">{tile.hint}</p>}
        </Card>
      ))}
    </div>
  );
}
