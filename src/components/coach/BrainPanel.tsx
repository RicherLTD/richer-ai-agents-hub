/**
 * BrainPanel — the "what does the Coach know?" view.
 *
 * Three logical sections (no nested tabs — operators want to see
 * everything at once and scan):
 *   1. Stats bar  → size of the brain + estimated per-turn cost.
 *   2. Notes      → short freeform facts the operator typed.
 *   3. Documents  → uploaded PDFs/images with title + tags + toggles.
 *
 * Visibility: every row shown here is either owned by the active agent
 * OR shared across all agents. The list comes pre-filtered from
 * getBrainForAgent.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  PencilLine,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Upload,
  X as XIcon,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/contexts/AgentContext";
import {
  createNote,
  deleteBrainDocument,
  getBrainForAgent,
  ingestBrainFile,
  MAX_UPLOAD_BYTES,
  summariseBrain,
  updateBrainDocument,
} from "@/lib/brain";
import type { BrainDocument } from "@/types/brain";

const SONNET_COLD_PER_TOKEN = 3 / 1_000_000;
const SONNET_CACHED_PER_TOKEN = 0.3 / 1_000_000;

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

interface BrainPanelProps {
  /** Called when the operator clicks "update the bot" on a brain item.
   *  Parent decides what to do — typically: send a Coach message asking
   *  for a prompt edit and switch to the chat tab. */
  onUpdateBot?: (item: { id: string; title: string; source_kind: string }) => void;
}

export function BrainPanel({ onUpdateBot }: BrainPanelProps) {
  const { activeAgent } = useAgent();
  const queryClient = useQueryClient();
  const agentId = activeAgent?.id ?? null;

  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<BrainDocument | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BrainDocument | null>(null);

  const brainQuery = useQuery({
    queryKey: ["coach", "brain", agentId] as const,
    queryFn: () => getBrainForAgent(agentId as string),
    enabled: !!agentId,
    // Poll every 4 seconds while any row is still processing — the
    // brain-ingest function extracts in background and we want the UI
    // to flip from "מעבד..." to ready without a manual refresh.
    refetchInterval: (q) => {
      const data = q.state.data as BrainDocument[] | undefined;
      const hasPending = data?.some((r) => r.extraction_status === "pending");
      return hasPending ? 4000 : false;
    },
  });

  const rows = brainQuery.data ?? [];
  const stats = useMemo(() => summariseBrain(rows), [rows]);
  const allTags = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) for (const t of r.tags) seen.add(t);
    return Array.from(seen).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeTag && !r.tags.includes(activeTag)) return false;
      if (!q) return true;
      const hay = [r.title, r.description ?? "", r.ai_title ?? "", r.ai_description ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, activeTag]);

  const notes = filtered.filter((r) => r.source_kind === "note");
  const docs = filtered.filter((r) => r.source_kind !== "note");

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["coach", "brain", agentId] });

  // Track pending toggles by id rather than relying on mutation.variables.
  // Two rapid clicks on different rows would otherwise overwrite the
  // mutation's variables — the second row's spinner showed on the first
  // row, both rows could be toggled simultaneously, etc.
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const toggleActive = useMutation({
    mutationFn: async (row: BrainDocument) => {
      setTogglingIds((s) => {
        const n = new Set(s);
        n.add(row.id);
        return n;
      });
      try {
        return await updateBrainDocument({ id: row.id, isActive: !row.is_active });
      } finally {
        setTogglingIds((s) => {
          const n = new Set(s);
          n.delete(row.id);
          return n;
        });
      }
    },
    onSuccess: () => void refresh(),
    onError: (err: unknown) => {
      toast.error("שינוי המצב נכשל", {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (row: BrainDocument) => deleteBrainDocument(row.id),
    onSuccess: () => {
      setConfirmDelete(null);
      toast.success("נמחק מהמוח");
      void refresh();
    },
    onError: (err: unknown) => {
      toast.error("המחיקה נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  if (!agentId) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          בחר סוכן מהסיידבר כדי לראות את המוח שלו
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <BrainStatsBar
        activeTokens={stats.activeTokens}
        totalTokens={stats.totalTokens}
        documentCount={stats.documentCount}
        noteCount={stats.noteCount}
      />

      {brainQuery.isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="me-2 h-5 w-5 animate-spin" />
          טוען את המוח...
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי כותרת או תיאור..."
            className="pe-9"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setCreatingNote(true)}
        >
          <StickyNote className="me-2 h-4 w-4" />
          הוסף הערה
        </Button>
        <Button type="button" onClick={() => setUploading(true)}>
          <Upload className="me-2 h-4 w-4" />
          העלה PDF / תמונה
        </Button>
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">תגיות:</span>
          <Badge
            variant={activeTag === null ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setActiveTag(null)}
          >
            הכל
          </Badge>
          {allTags.map((t) => (
            <Badge
              key={t}
              variant={activeTag === t ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setActiveTag((p) => (p === t ? null : t))}
            >
              {t}
            </Badge>
          ))}
        </div>
      )}

      {/* Notes section */}
      <section className="space-y-2">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">
            הערות ({notes.length})
          </h2>
        </header>
        {notes.length === 0 ? (
          <Card>
            <CardContent className="py-4 text-center text-sm text-muted-foreground">
              אין הערות עדיין. הערות הן עובדות קצרות שתרצה ש־Coach תמיד יזכור.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {notes.map((n) => (
              <BrainNoteRow
                key={n.id}
                row={n}
                onEdit={() => setEditing(n)}
                onToggleActive={() => toggleActive.mutate(n)}
                onDelete={() => setConfirmDelete(n)}
                onUpdateBot={
                  onUpdateBot
                    ? () => onUpdateBot({ id: n.id, title: n.title, source_kind: n.source_kind })
                    : undefined
                }
                isToggling={togglingIds.has(n.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Documents section */}
      <section className="space-y-2">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">
            מסמכים ({docs.length})
          </h2>
        </header>
        {docs.length === 0 ? (
          <Card>
            <CardContent className="py-4 text-center text-sm text-muted-foreground">
              אין מסמכים. העלה PDF או תמונה ו־Coach יזכור אותם בכל שיחה.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {docs.map((d) => (
              <BrainDocCard
                key={d.id}
                row={d}
                onEdit={() => setEditing(d)}
                onToggleActive={() => toggleActive.mutate(d)}
                onDelete={() => setConfirmDelete(d)}
                onUpdateBot={
                  onUpdateBot
                    ? () => onUpdateBot({ id: d.id, title: d.title, source_kind: d.source_kind })
                    : undefined
                }
                isToggling={togglingIds.has(d.id)}
              />
            ))}
          </div>
        )}
      </section>

      <NoteEditorDialog
        open={creatingNote || !!(editing && editing.source_kind === "note")}
        existing={editing && editing.source_kind === "note" ? editing : null}
        agentId={agentId}
        onClose={() => {
          setCreatingNote(false);
          if (editing?.source_kind === "note") setEditing(null);
        }}
        onSaved={refresh}
      />

      <DocumentEditorDialog
        open={!!(editing && editing.source_kind !== "note")}
        existing={editing && editing.source_kind !== "note" ? editing : null}
        onClose={() => editing?.source_kind !== "note" && setEditing(null)}
        onSaved={refresh}
      />

      <UploadDialog
        open={uploading}
        agentId={agentId}
        onClose={() => setUploading(false)}
        onSaved={refresh}
      />

      <ConfirmDeleteDialog
        target={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={(row) => deleteMutation.mutate(row)}
        isDeleting={deleteMutation.isPending}
      />
    </div>
  );
}

function BrainStatsBar({
  activeTokens,
  totalTokens,
  documentCount,
  noteCount,
}: {
  activeTokens: number;
  totalTokens: number;
  documentCount: number;
  noteCount: number;
}) {
  const coldCost = activeTokens * SONNET_COLD_PER_TOKEN;
  const warmCost = activeTokens * SONNET_CACHED_PER_TOKEN;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">המוח של הסוכן</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="מסמכים" value={String(documentCount)} />
        <Stat label="הערות" value={String(noteCount)} />
        <Stat
          label="טוקנים פעילים"
          value={formatTokens(activeTokens)}
          sub={
            activeTokens === totalTokens
              ? undefined
              : `מתוך ${formatTokens(totalTokens)}`
          }
        />
        <Stat
          label="עלות לשיחה"
          value={formatCost(coldCost)}
          sub={`חם: ${formatCost(warmCost)}`}
        />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

interface RowActionsProps {
  row: BrainDocument;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onUpdateBot?: () => void;
  isToggling: boolean;
}

function BrainNoteRow({
  row,
  onEdit,
  onToggleActive,
  onDelete,
  onUpdateBot,
  isToggling,
}: RowActionsProps) {
  return (
    <Card className={row.is_active ? "" : "opacity-60"}>
      <CardContent className="flex items-start gap-3 p-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
          <StickyNote className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{row.title}</p>
            {row.shared_across_agents && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <Globe className="h-3 w-3" />
                משותף
              </Badge>
            )}
            {!row.is_active && (
              <Badge variant="outline" className="text-[10px]">
                כבוי
              </Badge>
            )}
          </div>
          {row.extracted_text && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground whitespace-pre-wrap">
              {row.extracted_text}
            </p>
          )}
          {row.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.tags.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={row.is_active}
            onCheckedChange={onToggleActive}
            disabled={isToggling}
            aria-label={row.is_active ? "כבה הערה" : "הפעל הערה"}
          />
          {onUpdateBot && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onUpdateBot}
              aria-label="עדכן את הבוט"
              title="עדכן את הבוט עם ההערה הזו"
            >
              <Zap className="h-4 w-4 text-amber-500" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" onClick={onEdit} aria-label="ערוך">
            <PencilLine className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onDelete}
            aria-label="מחק"
            className="text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BrainDocCard({
  row,
  onEdit,
  onToggleActive,
  onDelete,
  onUpdateBot,
  isToggling,
}: RowActionsProps) {
  const Icon = row.source_kind === "pdf" ? FileText : ImageIcon;
  const isPending = row.extraction_status === "pending";
  const isFailed = row.extraction_status === "failed";
  return (
    <Card className={row.is_active && !isFailed ? "" : "opacity-60"}>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={row.title}>
              {row.title}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {isPending
                ? "מעבד את התוכן..."
                : isFailed
                  ? "החילוץ נכשל"
                  : (row.page_count ? `${row.page_count} עמודים · ` : "") +
                    (row.token_count ? `${formatTokens(row.token_count)} טוקנים` : "")}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Switch
              checked={row.is_active}
              onCheckedChange={onToggleActive}
              disabled={isToggling || isPending}
              aria-label={row.is_active ? "כבה מסמך" : "הפעל מסמך"}
            />
          </div>
        </div>
        {isFailed && row.extraction_error && (
          <p className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
            {row.extraction_error}
          </p>
        )}
        {!isFailed && row.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {isPending && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Loader2 className="h-3 w-3 animate-spin" />
              מעבד
            </Badge>
          )}
          {isFailed && (
            <Badge variant="destructive" className="gap-1 text-[10px]">
              נכשל
            </Badge>
          )}
          {row.shared_across_agents && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Globe className="h-3 w-3" />
              משותף
            </Badge>
          )}
          {row.tags.map((t) => (
            <Badge key={t} variant="outline" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
        <div className="flex items-center justify-between gap-1 pt-1">
          {onUpdateBot && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onUpdateBot}
              title="שלח את התוכן הזה ל־Coach שיעדכן את ה־prompt של הבוט"
            >
              <Zap className="me-1 h-3.5 w-3.5 text-amber-500" />
              עדכן את הבוט
            </Button>
          )}
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
              <PencilLine className="me-1 h-3.5 w-3.5" />
              ערוך
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-destructive"
            >
              <Trash2 className="me-1 h-3.5 w-3.5" />
              מחק
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface NoteFields {
  title: string;
  description: string;
  body: string;
  tags: string;
  shared: boolean;
  aiTitle: string;
  aiDescription: string;
}

function parseTagsInput(s: string): string[] {
  return s
    .split(/[,،]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function NoteEditorDialog({
  open,
  existing,
  agentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  existing: BrainDocument | null;
  agentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<NoteFields>({
    title: "",
    description: "",
    body: "",
    tags: "",
    shared: false,
    aiTitle: "",
    aiDescription: "",
  });
  const [showAi, setShowAi] = useState(false);

  // Sync from existing on open.
  useEffect(() => {
    if (!open) return;
    setFields({
      title: existing?.title ?? "",
      description: existing?.description ?? "",
      body: existing?.extracted_text ?? "",
      tags: existing?.tags.join(", ") ?? "",
      shared: existing?.shared_across_agents ?? false,
      aiTitle: existing?.ai_title ?? "",
      aiDescription: existing?.ai_description ?? "",
    });
    setShowAi(!!(existing?.ai_title || existing?.ai_description));
  }, [open, existing]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const tags = parseTagsInput(fields.tags);
      if (existing) {
        return updateBrainDocument({
          id: existing.id,
          title: fields.title,
          description: fields.description || null,
          body: fields.body,
          tags,
          aiTitle: showAi ? fields.aiTitle || null : null,
          aiDescription: showAi ? fields.aiDescription || null : null,
          sharedAcrossAgents: fields.shared,
        });
      }
      return createNote({
        agentId,
        title: fields.title,
        description: fields.description || null,
        body: fields.body,
        tags,
        aiTitle: showAi ? fields.aiTitle || null : null,
        aiDescription: showAi ? fields.aiDescription || null : null,
        sharedAcrossAgents: fields.shared,
      });
    },
    onSuccess: () => {
      toast.success(existing ? "ההערה עודכנה" : "ההערה נוספה");
      onSaved();
      onClose();
    },
    onError: (err: unknown) => {
      toast.error("השמירה נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const valid = fields.title.trim().length > 0 && fields.body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle>{existing ? "ערוך הערה" : "הערה חדשה"}</DialogTitle>
          <DialogDescription>
            הערות הן עובדות קצרות. הן תמיד יוזרקו ל־Coach בכל שיחה.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-3 overflow-y-auto pe-1">
          <div>
            <label className="text-xs font-medium">כותרת (לעין שלך)</label>
            <Input
              value={fields.title}
              onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
              placeholder="לדוגמה: שמות היועצים"
            />
          </div>
          <div>
            <label className="text-xs font-medium">תיאור (אופציונלי)</label>
            <Input
              value={fields.description}
              onChange={(e) => setFields((f) => ({ ...f, description: e.target.value }))}
              placeholder="תיאור קצר למה זה משמש"
            />
          </div>
          <div>
            <label className="text-xs font-medium">תוכן ההערה</label>
            <Textarea
              value={fields.body}
              onChange={(e) => setFields((f) => ({ ...f, body: e.target.value }))}
              placeholder="זה הטקסט ש־Coach יראה. כתוב בעברית רגילה."
              className="min-h-[120px]"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              ~{Math.ceil(fields.body.length / 4)} טוקנים
            </p>
          </div>
          <div>
            <label className="text-xs font-medium">תגיות (מופרדות בפסיק)</label>
            <Input
              value={fields.tags}
              onChange={(e) => setFields((f) => ({ ...f, tags: e.target.value }))}
              placeholder="לדוגמה: מחיר, התנגדויות, מכירות"
            />
          </div>
          <label className="flex items-center justify-between gap-2 rounded-md border p-2">
            <div>
              <p className="text-sm font-medium">שתף עם כל הסוכנים</p>
              <p className="text-[11px] text-muted-foreground">
                כשפעיל, כל סוכן יראה את ההערה הזו (לא רק {`"${agentId.slice(0, 8)}…"`}).
              </p>
            </div>
            <Switch
              checked={fields.shared}
              onCheckedChange={(v) => setFields((f) => ({ ...f, shared: v }))}
            />
          </label>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setShowAi((p) => !p)}
          >
            {showAi ? "הסתר שדות אנגלית ל־AI" : "הוסף תיאור אנגלית ל־AI (אופציונלי)"}
          </button>
          {showAi && (
            <>
              <div>
                <label className="text-xs font-medium">Title (English, for AI)</label>
                <Input
                  value={fields.aiTitle}
                  onChange={(e) => setFields((f) => ({ ...f, aiTitle: e.target.value }))}
                  dir="ltr"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Description (English, for AI)</label>
                <Input
                  value={fields.aiDescription}
                  onChange={(e) => setFields((f) => ({ ...f, aiDescription: e.target.value }))}
                  dir="ltr"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!valid || saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            שמור
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DocumentEditorDialog({
  open,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  existing: BrainDocument | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [aiTitle, setAiTitle] = useState("");
  const [aiDescription, setAiDescription] = useState("");
  const [tags, setTags] = useState("");
  const [shared, setShared] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    if (!open || !existing) return;
    setTitle(existing.title);
    setDescription(existing.description ?? "");
    setAiTitle(existing.ai_title ?? "");
    setAiDescription(existing.ai_description ?? "");
    setTags(existing.tags.join(", "));
    setShared(existing.shared_across_agents);
    setShowAi(!!(existing.ai_title || existing.ai_description));
    setShowText(false);
  }, [open, existing]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateBrainDocument({
        id: existing!.id,
        title,
        description: description || null,
        aiTitle: showAi ? aiTitle || null : null,
        aiDescription: showAi ? aiDescription || null : null,
        tags: parseTagsInput(tags),
        sharedAcrossAgents: shared,
      }),
    onSuccess: () => {
      toast.success("המסמך עודכן");
      onSaved();
      onClose();
    },
    onError: (err: unknown) =>
      toast.error("השמירה נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  if (!existing) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle>ערוך מסמך</DialogTitle>
          <DialogDescription>
            {existing.source_kind === "pdf" ? "PDF" : "תמונה"} · {formatTokens(existing.token_count ?? 0)} טוקנים
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-3 overflow-y-auto pe-1">
          <div>
            <label className="text-xs font-medium">כותרת</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium">תיאור</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="מה יש במסמך הזה? למה הוא נכנס למוח?"
              className="min-h-[80px]"
            />
          </div>
          <div>
            <label className="text-xs font-medium">תגיות (מופרדות בפסיק)</label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <label className="flex items-center justify-between gap-2 rounded-md border p-2">
            <div>
              <p className="text-sm font-medium">שתף עם כל הסוכנים</p>
              <p className="text-[11px] text-muted-foreground">
                כשפעיל, המסמך יוצג ב־Coach של כל סוכן.
              </p>
            </div>
            <Switch checked={shared} onCheckedChange={setShared} />
          </label>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setShowAi((p) => !p)}
          >
            {showAi ? "הסתר שדות אנגלית ל־AI" : "הוסף תיאור אנגלית ל־AI (אופציונלי)"}
          </button>
          {showAi && (
            <>
              <div>
                <label className="text-xs font-medium">Title (English, for AI)</label>
                <Input value={aiTitle} onChange={(e) => setAiTitle(e.target.value)} dir="ltr" />
              </div>
              <div>
                <label className="text-xs font-medium">Description (English, for AI)</label>
                <Input
                  value={aiDescription}
                  onChange={(e) => setAiDescription(e.target.value)}
                  dir="ltr"
                />
              </div>
            </>
          )}
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setShowText((p) => !p)}
          >
            {showText ? "הסתר טקסט מחולץ" : "הצג טקסט שחולץ מהמסמך"}
          </button>
          {showText && (
            <pre
              className="max-h-64 overflow-auto rounded border bg-muted/30 p-2 text-[11px] leading-relaxed whitespace-pre-wrap"
            >
              {existing.extracted_text ?? "(אין טקסט מחולץ)"}
            </pre>
          )}
        </div>
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || title.trim().length === 0}
          >
            {saveMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            שמור
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            סגור
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({
  open,
  agentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  agentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [aiTitle, setAiTitle] = useState("");
  const [aiDescription, setAiDescription] = useState("");
  const [tags, setTags] = useState("");
  const [shared, setShared] = useState(false);
  const [showAi, setShowAi] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setTitle("");
    setDescription("");
    setAiTitle("");
    setAiDescription("");
    setTags("");
    setShared(false);
    setShowAi(false);
  }, [open]);

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("לא נבחר קובץ");
      return ingestBrainFile({
        agentId,
        title,
        description: description || null,
        aiTitle: showAi ? aiTitle || null : null,
        aiDescription: showAi ? aiDescription || null : null,
        tags: parseTagsInput(tags),
        sharedAcrossAgents: shared,
        file,
      });
    },
    onSuccess: () => {
      toast.success("המסמך עלה למוח", {
        description: "חילצנו את הטקסט. Coach יזכור אותו בשיחה הבאה.",
      });
      onSaved();
      onClose();
    },
    onError: (err: unknown) =>
      toast.error("ההעלאה נכשלה", {
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const handleFile = (f: File | null) => {
    setFile(f);
    if (f && !title) {
      // Pre-fill title from filename (strip extension).
      const dot = f.name.lastIndexOf(".");
      setTitle(dot > 0 ? f.name.slice(0, dot) : f.name);
    }
  };

  const valid = !!file && title.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle>העלה למוח</DialogTitle>
          <DialogDescription>
            PDF או תמונה (עד {MAX_UPLOAD_BYTES / 1024 / 1024}MB / ~80 עמודים). חילוץ הטקסט אוטומטי. PDF גדול יותר — פצל לקבצים נפרדים.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-3 overflow-y-auto pe-1">
          <div>
            <label className="text-xs font-medium">קובץ</label>
            <Input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)}MB
              </p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium">כותרת</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="לדוגמה: תסריט מכירות 2025"
            />
          </div>
          <div>
            <label className="text-xs font-medium">תיאור (מומלץ)</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="מה יש במסמך הזה? למה Coach צריך לזכור אותו?"
              className="min-h-[80px]"
            />
          </div>
          <div>
            <label className="text-xs font-medium">תגיות (מופרדות בפסיק)</label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="לדוגמה: מכירות, מחיר, FAQ"
            />
          </div>
          <label className="flex items-center justify-between gap-2 rounded-md border p-2">
            <div>
              <p className="text-sm font-medium">שתף עם כל הסוכנים</p>
              <p className="text-[11px] text-muted-foreground">
                כשפעיל, המסמך יישמר תחת תיקיה משותפת ויוצג ב־Coach של כל סוכן.
              </p>
            </div>
            <Switch checked={shared} onCheckedChange={setShared} />
          </label>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setShowAi((p) => !p)}
          >
            {showAi ? "הסתר שדות אנגלית ל־AI" : "הוסף תיאור אנגלית ל־AI (אופציונלי)"}
          </button>
          {showAi && (
            <>
              <div>
                <label className="text-xs font-medium">Title (English, for AI)</label>
                <Input value={aiTitle} onChange={(e) => setAiTitle(e.target.value)} dir="ltr" />
              </div>
              <div>
                <label className="text-xs font-medium">Description (English, for AI)</label>
                <Input
                  value={aiDescription}
                  onChange={(e) => setAiDescription(e.target.value)}
                  dir="ltr"
                />
              </div>
            </>
          )}
          {uploadMutation.isPending && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>מעלה ומחלץ טקסט... זה לוקח 10-30 שניות תלוי בגודל</span>
            </div>
          )}
        </div>
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => uploadMutation.mutate()}
            disabled={!valid || uploadMutation.isPending}
          >
            {uploadMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            <Plus className="me-1 h-4 w-4" />
            העלה למוח
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={uploadMutation.isPending}>
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDeleteDialog({
  target,
  onCancel,
  onConfirm,
  isDeleting,
}: {
  target: BrainDocument | null;
  onCancel: () => void;
  onConfirm: (row: BrainDocument) => void;
  isDeleting: boolean;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>מחיקה — האם אתה בטוח?</DialogTitle>
          <DialogDescription>
            {target?.shared_across_agents
              ? "המסמך הזה משותף לכל הסוכנים. מחיקה תסיר אותו מכל ה־Coach-ים."
              : "המסמך יוסר מהמוח של הסוכן הזה. הפעולה לא הפיכה."}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <p className="rounded border bg-muted/40 p-2 text-sm">{target.title}</p>
        )}
        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            variant="destructive"
            onClick={() => target && onConfirm(target)}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="me-2 h-4 w-4" />
            )}
            מחק
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isDeleting}>
            <XIcon className="me-2 h-4 w-4" />
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
