import { format } from "date-fns";
import { he } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface DateRange {
  /** Inclusive lower bound (UTC ISO) or null for unbounded. */
  from: string | null;
  /** Inclusive upper bound (UTC ISO) or null for unbounded. */
  to: string | null;
}

export type DatePreset = "all" | "today" | "7d" | "30d" | "month" | "custom";

const PRESET_LABEL: Record<DatePreset, string> = {
  all: "כל הזמן",
  today: "היום",
  "7d": "7 ימים אחרונים",
  "30d": "30 יום אחרונים",
  month: "מתחילת החודש",
  custom: "טווח מותאם…",
};

const PRESETS: DatePreset[] = ["all", "today", "7d", "30d", "month", "custom"];

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function resolvePreset(preset: DatePreset): DateRange {
  if (preset === "all") return { from: null, to: null };
  if (preset === "custom") return { from: null, to: null };
  const start = startOfToday();
  if (preset === "today") return { from: start.toISOString(), to: null };
  if (preset === "7d") {
    const d = new Date(start);
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString(), to: null };
  }
  if (preset === "30d") {
    const d = new Date(start);
    d.setDate(d.getDate() - 29);
    return { from: d.toISOString(), to: null };
  }
  if (preset === "month") {
    const d = new Date(start);
    d.setDate(1);
    return { from: d.toISOString(), to: null };
  }
  return { from: null, to: null };
}

interface Props {
  preset: DatePreset;
  range: DateRange;
  onChange: (next: { preset: DatePreset; range: DateRange }) => void;
}

export function DateRangeFilter({ preset, range, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const handlePreset = (next: DatePreset) => {
    if (next === "custom") {
      onChange({ preset: "custom", range });
      setOpen(true);
      return;
    }
    onChange({ preset: next, range: resolvePreset(next) });
  };

  const customLabel = (() => {
    if (preset !== "custom") return null;
    const from = range.from ? format(new Date(range.from), "dd/MM/yy", { locale: he }) : "—";
    const to = range.to ? format(new Date(range.to), "dd/MM/yy", { locale: he }) : "היום";
    return `${from} – ${to}`;
  })();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESETS.map((p) => {
        const isActive = preset === p;
        return (
          <button
            key={p}
            type="button"
            onClick={() => handlePreset(p)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {PRESET_LABEL[p]}
          </button>
        );
      })}

      {preset === "custom" && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
              <CalendarIcon className="h-3.5 w-3.5" />
              {customLabel ?? "בחר טווח"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={{
                from: range.from ? new Date(range.from) : undefined,
                to: range.to ? new Date(range.to) : undefined,
              }}
              onSelect={(r) => {
                onChange({
                  preset: "custom",
                  range: {
                    from: r?.from ? new Date(r.from.setHours(0, 0, 0, 0)).toISOString() : null,
                    to: r?.to ? new Date(r.to.setHours(23, 59, 59, 999)).toISOString() : null,
                  },
                });
              }}
              locale={he}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
