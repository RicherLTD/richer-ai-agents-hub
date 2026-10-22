import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useAgent } from "@/contexts/AgentContext";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listBroadcastTemplates,
  enqueueBroadcast,
  describeSuppression,
  fetchStatusCounts,
  fetchStatusSyncState,
  previewBroadcastAudience,
  registrationWindow,
  triggerStatusSync,
  type EnqueueResult,
} from "@/lib/broadcasts";
import { parseBroadcastCsv, type ParsedCsvRecipient } from "@/lib/parseBroadcastCsv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPicker } from "./StatusPicker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Cheap stable fingerprint of the CSV audience for the preview query key. */
function csvFingerprint(phones: string[]): string {
  let hash = 0;
  for (const phone of phones) {
    for (let i = 0; i < phone.length; i++) hash = (hash * 31 + phone.charCodeAt(i)) | 0;
  }
  return `${phones.length}:${hash}`;
}

export function BroadcastComposer({ onDone }: { onDone: () => void }) {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const [templateName, setTemplateName] = useState("");
  const [title, setTitle] = useState("");
  const [timing, setTiming] = useState<"now" | "scheduled">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [includeExisting, setIncludeExisting] = useState(false);
  const [regFrom, setRegFrom] = useState("");
  const [regTo, setRegTo] = useState("");
  const [statusMains, setStatusMains] = useState<Array<number | null>>([]);
  const [statusSubs, setStatusSubs] = useState<Array<number | null>>([]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [csv, setCsv] = useState<{ rows: ParsedCsvRecipient[]; errors: string[] }>({ rows: [], errors: [] });
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
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

  // Dates only narrow "all registered leads"; ignored when that box is off.
  const regWindow = useMemo(
    () => (includeExisting ? registrationWindow(regFrom, regTo) : { registered_from: null, registered_before: null }),
    [includeExisting, regFrom, regTo],
  );
  // Status filters also only narrow "all registered leads".
  const statusFilters = useMemo(
    () => (includeExisting ? { status_mains: statusMains, status_subs: statusSubs } : { status_mains: [], status_subs: [] }),
    [includeExisting, statusMains, statusSubs],
  );

  const statusCounts = useQuery({
    queryKey: ["broadcast-status-counts", agentId, regWindow.registered_from, regWindow.registered_before],
    queryFn: () => fetchStatusCounts(agentId, regWindow),
    enabled: !!agentId && includeExisting,
    staleTime: 60_000,
  });
  const syncState = useQuery({
    queryKey: ["fireberry-sync-state", agentId],
    queryFn: () => fetchStatusSyncState(agentId),
    enabled: !!agentId && includeExisting,
    refetchInterval: 30_000,
  });
  const syncNow = useMutation({
    mutationFn: triggerStatusSync,
    onSuccess: () => {
      toast.success("הסנכרון מ-Fireberry התחיל — הסטטוסים יתעדכנו תוך כ-2 דקות");
      // The run continues in the background; refresh what depends on it after.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["broadcast-status-counts", agentId] });
        void queryClient.invalidateQueries({ queryKey: ["fireberry-sync-state", agentId] });
        void queryClient.invalidateQueries({ queryKey: ["broadcast-preview", agentId] });
      }, 120_000);
    },
    onError: (err: unknown) =>
      toast.error("הפעלת הסנכרון נכשלה", { description: err instanceof Error ? err.message : undefined }),
  });

  const csvKey = useMemo(() => csvFingerprint(csv.rows.map((r) => r.phone)), [csv.rows]);
  const hasAudience = includeExisting || csv.rows.length > 0;

  // Same server path as the real send, with dry_run — so the number shown is
  // the number that will be queued, after opt-outs and blocking tags.
  const preview = useQuery({
    queryKey: [
      "broadcast-preview",
      agentId,
      includeExisting,
      regWindow.registered_from,
      regWindow.registered_before,
      statusFilters.status_mains.join(","),
      statusFilters.status_subs.join(","),
      csvKey,
    ],
    queryFn: () =>
      previewBroadcastAudience({
        agent_id: agentId,
        include_existing: includeExisting,
        ...regWindow,
        ...statusFilters,
        csv_recipients: csv.rows.map((r) => ({ phone: r.phone, name: r.name, variables: r.variables })),
      }),
    enabled: !!agentId && hasAudience,
    staleTime: 30_000,
  });
  const previewCount = hasAudience ? preview.data?.total_recipients ?? null : 0;

  function onCsvFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setCsvFileName(file.name);
      setCsv(parseBroadcastCsv(String(reader.result ?? "")));
    };
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
        ...regWindow,
        ...statusFilters,
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

  const canSubmit =
    !!agentId && !!templateName && !!title && hasAudience && !busy && previewCount !== null && previewCount > 0;

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
        {includeExisting && (
          <div className="mt-3 space-y-1">
            <p className="text-sm font-medium">רק מי שנרשם בין התאריכים (אופציונלי)</p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>מתאריך</span>
              <Input type="date" value={regFrom} onChange={(e) => setRegFrom(e.target.value)} className="w-auto" />
              <span>עד תאריך</span>
              <Input type="date" value={regTo} onChange={(e) => setRegTo(e.target.value)} className="w-auto" />
              {(regFrom || regTo) && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setRegFrom(""); setRegTo(""); }}>
                  נקה
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              לפי התאריך שבו הליד נכנס למערכת. שני התאריכים כלולים. שדה ריק = בלי הגבלה מאותו צד.
            </p>

            <p className="pt-2 text-sm font-medium">רק סטטוסים מסוימים ב-Fireberry (אופציונלי)</p>
            <div className="flex flex-wrap gap-2">
              <StatusPicker
                label="סטטוס ראשי"
                options={(statusCounts.data ?? []).filter((c) => c.kind === "main")}
                selected={statusMains}
                onChange={setStatusMains}
                loading={statusCounts.isLoading}
              />
              <StatusPicker
                label="סטטוס משני"
                options={(statusCounts.data ?? []).filter((c) => c.kind === "sub")}
                selected={statusSubs}
                onChange={setStatusSubs}
                loading={statusCounts.isLoading}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {syncState.data?.last_run_at
                  ? `הסטטוסים עודכנו מ-Fireberry: ${new Date(syncState.data.last_run_at).toLocaleString("he-IL")}`
                  : "הסטטוסים עוד לא סונכרנו מ-Fireberry"}
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                disabled={syncNow.isPending}
                onClick={() => syncNow.mutate()}
              >
                {syncNow.isPending ? "מפעיל…" : "רענן עכשיו"}
              </Button>
            </div>
            {syncState.data && !syncState.data.full_sync_done_at && (
              <p className="text-xs text-amber-700">
                הסנכרון הראשון מ-Fireberry עדיין רץ — חלק מהלידים מופיעים כרגע כ"ללא סטטוס".
              </p>
            )}
            {syncState.data?.last_error && (
              <p className="text-xs text-destructive">הסנכרון האחרון נכשל: {syncState.data.last_error}</p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">קובץ נמענים (CSV: טלפון, שם) — אופציונלי</label>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onCsvFile(e.target.files[0])} />
        <p className="mt-1 text-sm">{csv.rows.length} נמענים נטענו מהקובץ</p>
        {csvFileName && csv.rows.length === 0 && (
          <p className="mt-1 text-sm font-medium text-destructive">
            אף מספר בקובץ לא תקין — אם הקובץ נשמר מאקסל, ודא שעמודה A היא הטלפון ושהמספר
            מלא (למשל 0528524113). ראה פירוט למטה.
          </p>
        )}
        {csv.errors.length > 0 && (
          <ul className="mt-1 text-xs text-destructive">
            {csv.errors.slice(0, 10).map((er, i) => <li key={i}>{er}</li>)}
            {csv.errors.length > 10 && <li>…ועוד {csv.errors.length - 10} שורות</li>}
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

      {hasAudience && !result && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          {preview.isFetching && !preview.data ? (
            <p className="text-muted-foreground">מחשב לכמה לידים יישלח…</p>
          ) : preview.error ? (
            <p className="text-destructive">לא הצלחתי לחשב את מספר הנמענים — נסה שוב.</p>
          ) : preview.data ? (
            <>
              <p className={preview.data.total_recipients === 0 ? "font-medium text-destructive" : "font-medium"}>
                {preview.data.total_recipients === 0
                  ? "אף ליד לא עומד בתנאים — הדיוור לא יישלח לאף אחד."
                  : `הדיוור יישלח ל-${preview.data.total_recipients.toLocaleString("he-IL")} לידים`}
                {preview.isFetching && <span className="ms-2 text-xs text-muted-foreground">(מתעדכן…)</span>}
              </p>
              {preview.data.suppressed_count > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  סוננו {preview.data.suppressed_count.toLocaleString("he-IL")} —{" "}
                  {describeSuppression(preview.data.suppressed_breakdown)}
                </p>
              )}
            </>
          ) : null}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && (
        <div className="text-sm">
          <p className={result.total_recipients === 0 ? "font-medium text-destructive" : "text-green-700"}>
            {result.total_recipients === 0
              ? "לא נכנס אף נמען לתור — הדיוור לא יישלח לאף אחד."
              : `נכנסו לתור: ${result.total_recipients}`}
            {" · "}סוננו: {result.suppressed_count}
          </p>
          {result.suppressed_count > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              סיבות סינון — {describeSuppression(result.suppressed_breakdown)}
            </p>
          )}
        </div>
      )}

      <Button onClick={() => setConfirmOpen(true)} disabled={!canSubmit}>
        {busy
          ? "שולח…"
          : previewCount
          ? `שלח דיוור ל-${previewCount.toLocaleString("he-IL")} לידים`
          : "שלח דיוור"}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              לשלוח את "{selectedTpl?.label ?? templateName}" ל-{(previewCount ?? 0).toLocaleString("he-IL")} לידים?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {timing === "scheduled" && scheduledFor
                ? `הדיוור ייצא ב-${new Date(scheduledFor).toLocaleString("he-IL")}.`
                : "הדיוור ייצא עכשיו."}{" "}
              ההודעות יוצאות בהדרגה (כ-50 בדקה), כך שדיוור גדול נמשך זמן.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                void submit();
              }}
            >
              שלח
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
