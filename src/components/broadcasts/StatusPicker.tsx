import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { StatusCount } from "@/lib/broadcasts";

const NONE_LABEL = "ללא סטטוס";

/**
 * Multi-select of Fireberry statuses with lead counts. An empty selection
 * means "no filter"; `null` in the selection is the "no status" bucket.
 */
export function StatusPicker({
  label,
  options,
  selected,
  onChange,
  loading,
}: {
  label: string;
  options: StatusCount[];
  selected: Array<number | null>;
  onChange: (next: Array<number | null>) => void;
  loading: boolean;
}) {
  // Biggest buckets first, "no status" last.
  const sorted = options.slice().sort((a, b) => {
    if (a.code === null) return 1;
    if (b.code === null) return -1;
    return b.leads - a.leads;
  });
  const isSelected = (code: number | null) => selected.includes(code);
  const toggle = (code: number | null) =>
    onChange(isSelected(code) ? selected.filter((c) => c !== code) : [...selected, code]);

  const summary =
    selected.length === 0
      ? "הכל"
      : selected.length === 1
      ? options.find((o) => o.code === selected[0])?.name ?? (selected[0] === null ? NONE_LABEL : String(selected[0]))
      : `${selected.length} נבחרו`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="justify-between gap-2">
          <span className="text-muted-foreground">{label}:</span>
          <span className="max-w-[12rem] truncate">{summary}</span>
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent dir="rtl" align="start" className="w-80 p-2">
        {loading ? (
          <p className="p-2 text-sm text-muted-foreground">טוען סטטוסים…</p>
        ) : sorted.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">אין לידים בטווח שנבחר.</p>
        ) : (
          <>
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {sorted.map((o) => (
                <label
                  key={o.code ?? "none"}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                >
                  <Checkbox checked={isSelected(o.code)} onCheckedChange={() => toggle(o.code)} />
                  <span className="flex-1 truncate">{o.code === null ? NONE_LABEL : o.name ?? String(o.code)}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{o.leads.toLocaleString("he-IL")}</span>
                </label>
              ))}
            </div>
            {selected.length > 0 && (
              <Button type="button" variant="ghost" size="sm" className="mt-1 w-full" onClick={() => onChange([])}>
                נקה בחירה (הכל)
              </Button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
