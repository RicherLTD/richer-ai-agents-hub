import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  label: string;
  value: number | string;
  icon: LucideIcon;
  hint?: string;
  isLoading?: boolean;
}

export function KpiCard({ label, value, icon: Icon, hint, isLoading }: Props) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {isLoading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <p className="text-2xl font-bold tabular-nums">{value}</p>
          )}
          {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}
