import { useMemo, useState } from "react";
import { useAgent } from "@/contexts/AgentContext";
import { useQuery } from "@tanstack/react-query";
import { listBroadcastTemplates, enqueueBroadcast, type EnqueueResult } from "@/lib/broadcasts";
import { parseBroadcastCsv, type ParsedCsvRecipient } from "@/lib/parseBroadcastCsv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function BroadcastComposer({ onDone }: { onDone: () => void }) {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const [templateName, setTemplateName] = useState("");
  const [title, setTitle] = useState("");
  const [timing, setTiming] = useState<"now" | "scheduled">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [includeExisting, setIncludeExisting] = useState(false);
  const [csv, setCsv] = useState<{ rows: ParsedCsvRecipient[]; errors: string[] }>({ rows: [], errors: [] });
  const [result, setResult] = useState<EnqueueResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["broadcast-templates", agentId],
    queryFn: () => listBroadcastTemplates(agentId),
    enabled: !!agentId,
  });

  const selectedTpl = useMemo(
    () => templates.data?.find((t) => t.name === templateName) ?? null,
    [templates.data, templateName],
  );

  function onCsvFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setCsv(parseBroadcastCsv(String(reader.result ?? "")));
    reader.readAsText(file);
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res = await enqueueBroadcast({
        agent_id: agentId,
        template_name: templateName,
        template_language: selectedTpl?.language ?? "he",
        title,
        scheduled_for: timing === "scheduled" && scheduledFor ? new Date(scheduledFor).toISOString() : null,
        include_existing: includeExisting,
        csv_recipients: csv.rows.map((r) => ({ phone: r.phone, name: r.name, variables: r.variables })),
      });
      setResult(res);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה בשליחת הדיוור");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!agentId && !!templateName && !!title && (csv.rows.length > 0 || includeExisting) && !busy;

  return (
    <div className="space-y-4" dir="rtl">
      <div>
        <label className="mb-1 block text-sm font-medium">שם הדיוור</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="למשל: דיוור מחזור יולי" />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">תבנית (template מאושר)</label>
        <select
          className="w-full rounded-md border p-2"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
        >
          <option value="">בחר תבנית…</option>
          {(templates.data ?? []).map((t) => (
            <option key={t.id} value={t.name}>{t.label} ({t.name})</option>
          ))}
        </select>
        {selectedTpl?.body_preview && (
          <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{selectedTpl.body_preview}</p>
        )}
      </div>

      <div className="rounded-md border p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={includeExisting} onChange={(e) => setIncludeExisting(e.target.checked)} />
          שלח לכל הלידים הרשומים של המוצר (הסוכן הפעיל)
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          מי שביקש הסרה או שכבר קבע זום יסונן אוטומטית. ניתן לשלב עם קובץ CSV למטה.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">קובץ נמענים (CSV: טלפון, שם) — אופציונלי</label>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onCsvFile(e.target.files[0])} />
        <p className="mt-1 text-sm">{csv.rows.length} נמענים נטענו מהקובץ</p>
        {csv.errors.length > 0 && (
          <ul className="mt-1 text-xs text-destructive">
            {csv.errors.slice(0, 5).map((er, i) => <li key={i}>{er}</li>)}
          </ul>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">תזמון</label>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1">
            <input type="radio" checked={timing === "now"} onChange={() => setTiming("now")} /> עכשיו
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={timing === "scheduled"} onChange={() => setTiming("scheduled")} /> בזמן מסוים
          </label>
          {timing === "scheduled" && (
            <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className="w-auto" />
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && (
        <p className="text-sm text-green-700">
          נכנסו לתור: {result.total_recipients} · סוננו: {result.suppressed_count}
        </p>
      )}

      <Button onClick={submit} disabled={!canSubmit}>{busy ? "שולח…" : "שלח דיוור"}</Button>
    </div>
  );
}
