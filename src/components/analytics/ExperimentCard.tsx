import { format } from "date-fns";
import { he } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExperimentSummary } from "@/lib/analytics";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d בMMM yyyy", { locale: he });
}

export function ExperimentCard({ summary }: { summary: ExperimentSummary }) {
  const { experiment, variants } = summary;
  const totalAcrossVariants = variants.reduce((s, v) => s + v.total, 0);
  const bestPct = variants.reduce((max, v) => Math.max(max, v.conversionPct), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{experiment.name}</CardTitle>
            {experiment.description && (
              <p className="mt-1 text-xs text-muted-foreground">{experiment.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {experiment.is_active ? <Badge>פעיל</Badge> : <Badge variant="outline">הסתיים</Badge>}
            <span className="text-[11px] text-muted-foreground">
              {formatDate(experiment.started_at)}
              {experiment.ended_at && ` ← ${formatDate(experiment.ended_at)}`}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {variants.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            עדיין אין תוצאות לוואריאנטים של הניסוי.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>וואריאנט</TableHead>
                <TableHead className="text-end">לידים</TableHead>
                <TableHead className="text-end">זום נקבע</TableHead>
                <TableHead className="text-end">המרה</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => {
                const isBest = totalAcrossVariants > 0 && v.conversionPct === bestPct && v.total > 0;
                return (
                  <TableRow key={v.variant}>
                    <TableCell dir="ltr" className="font-mono text-xs">
                      {v.variant}
                      {isBest && <Badge className="ms-2" variant="secondary">מוביל</Badge>}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{v.total}</TableCell>
                    <TableCell className="text-end tabular-nums">{v.zoomScheduled}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {v.total === 0 ? "—" : `${v.conversionPct.toFixed(1)}%`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
