/**
 * Brain — persistent knowledge layer for the Prompt Coach.
 *
 * Visibility rule: a row is "visible to agent X" when either its
 * `agent_id` equals X OR `shared_across_agents` is true. The DB does
 * not enforce that visibility on SELECT (RLS is admin-only); the
 * filter is applied here so the UI shows the right set per active
 * agent.
 *
 * Uploads:
 *   PDFs/images → Supabase Storage (`brain-uploads` bucket) → then call
 *   the `brain-ingest` edge function which extracts plain text (via
 *   Claude vision/document blocks) and inserts the `brain_documents`
 *   row server-side. The client never writes extracted_text directly.
 *
 *   Notes (free text) → inserted client-side, no extraction needed.
 */
import { supabase } from "@/lib/supabase/client";
import { assertUuid } from "@/lib/validation";
import type { BrainDocument, BrainSourceKind } from "@/types/brain";

// 10MB — matches the server cap in brain-ingest. We can't safely go
// higher even at the client level because dense text PDFs blow past
// Claude's 1M-token input window beyond this size.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_PDF_MIMES = ["application/pdf"] as const;
export const SUPPORTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/**
 * Brain rows visible to a given agent: own rows + globally-shared rows.
 * Server-side RLS already restricts to admins; we add the agent visibility
 * filter on top so a normal Coach page shows the right subset.
 */
// Columns we render in the brain list. We intentionally omit
// `extracted_text` here — it can be up to 200 KB per row and is only
// shown when the operator opens the "show extracted text" panel inside
// the editor. Fetching it on the list view wasted ~10 MB of bandwidth
// at 50 docs.
const BRAIN_LIST_COLUMNS =
  "id, agent_id, source_kind, title, description, ai_title, ai_description, storage_path, tags, page_count, file_size_bytes, token_count, is_active, shared_across_agents, uploaded_by, uploaded_at, updated_at, extraction_status, extraction_error";

export async function getBrainForAgent(agentId: string): Promise<BrainDocument[]> {
  // PostgREST .or() filter is built by string interpolation; a non-UUID
  // agentId could contain commas/parens that escape the or-group and
  // return rows from other agents. Validate at the boundary.
  assertUuid(agentId, "agentId");
  const { data, error } = await supabase
    .from("brain_documents")
    .select(BRAIN_LIST_COLUMNS)
    .or(`agent_id.eq.${agentId},shared_across_agents.eq.true`)
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(`Failed to load brain: ${error.message}`);
  // `extracted_text` is missing from the list rows; null it out explicitly
  // so consumers see a known shape rather than `undefined`.
  return (data ?? []).map((r) => ({
    ...(r as Omit<BrainDocument, "extracted_text">),
    extracted_text: null,
  })) as BrainDocument[];
}

/**
 * Lazily fetch the full extracted text for a single brain document.
 * Used by the editor's "show extracted text" panel — kept out of the
 * list query so the page load stays small.
 */
export async function getBrainDocumentText(id: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("brain_documents")
    .select("extracted_text")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load extracted text: ${error.message}`);
  return (data?.extracted_text as string | null) ?? null;
}

export interface BrainStats {
  documentCount: number;
  noteCount: number;
  totalTokens: number;
  activeTokens: number;
}

/** Aggregate stats shown in the "how big is my brain" header. */
export function summariseBrain(rows: ReadonlyArray<BrainDocument>): BrainStats {
  let docs = 0;
  let notes = 0;
  let total = 0;
  let active = 0;
  for (const row of rows) {
    if (row.source_kind === "note") notes++;
    else docs++;
    const tokens = row.token_count ?? 0;
    total += tokens;
    if (row.is_active) active += tokens;
  }
  return {
    documentCount: docs,
    noteCount: notes,
    totalTokens: total,
    activeTokens: active,
  };
}

export interface CreateNoteArgs {
  agentId: string;
  title: string;
  description?: string | null;
  aiTitle?: string | null;
  aiDescription?: string | null;
  body: string;
  tags?: string[];
  sharedAcrossAgents?: boolean;
}

/**
 * Note rows live in the same table as files but have `source_kind='note'`
 * and store the body directly in extracted_text. token_count is estimated
 * client-side (rough 4 chars ≈ 1 token heuristic — close enough for the
 * UI's cost preview, the real ingest function recomputes for PDFs).
 */
export async function createNote(args: CreateNoteArgs): Promise<BrainDocument> {
  const body = args.body.trim();
  if (body.length === 0) throw new Error("Note body is empty");
  const tokens = Math.ceil(body.length / 4);
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error("Not authenticated");
  const { data, error } = await supabase
    .from("brain_documents")
    .insert({
      agent_id: args.agentId,
      source_kind: "note",
      title: args.title,
      description: args.description ?? null,
      ai_title: args.aiTitle ?? null,
      ai_description: args.aiDescription ?? null,
      extracted_text: body,
      token_count: tokens,
      tags: args.tags ?? [],
      shared_across_agents: args.sharedAcrossAgents ?? false,
      uploaded_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create note: ${error.message}`);
  return data as BrainDocument;
}

export interface UpdateBrainArgs {
  id: string;
  title?: string;
  description?: string | null;
  aiTitle?: string | null;
  aiDescription?: string | null;
  tags?: string[];
  isActive?: boolean;
  sharedAcrossAgents?: boolean;
  /** Only valid for source_kind='note' — updates the body and recomputes tokens. */
  body?: string;
}

export async function updateBrainDocument(args: UpdateBrainArgs): Promise<BrainDocument> {
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.description !== undefined) patch.description = args.description;
  if (args.aiTitle !== undefined) patch.ai_title = args.aiTitle;
  if (args.aiDescription !== undefined) patch.ai_description = args.aiDescription;
  if (args.tags !== undefined) patch.tags = args.tags;
  if (args.isActive !== undefined) patch.is_active = args.isActive;
  if (args.sharedAcrossAgents !== undefined) patch.shared_across_agents = args.sharedAcrossAgents;
  if (args.body !== undefined) {
    patch.extracted_text = args.body;
    patch.token_count = Math.ceil(args.body.length / 4);
  }
  const { data, error } = await supabase
    .from("brain_documents")
    .update(patch)
    .eq("id", args.id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update brain row: ${error.message}`);
  return data as BrainDocument;
}

export async function deleteBrainDocument(id: string): Promise<void> {
  // Read first so we know whether to delete the storage object too.
  const { data: existing, error: readErr } = await supabase
    .from("brain_documents")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw new Error(`Failed to read brain row: ${readErr.message}`);

  const { error: deleteErr } = await supabase
    .from("brain_documents")
    .delete()
    .eq("id", id);
  if (deleteErr) throw new Error(`Failed to delete brain row: ${deleteErr.message}`);

  // Best-effort storage cleanup. If the file was already gone or the
  // bucket policy rejects (shouldn't), don't block the operator.
  if (existing?.storage_path) {
    await supabase.storage.from("brain-uploads").remove([existing.storage_path]);
  }
}

export interface IngestFileArgs {
  agentId: string;
  title: string;
  description: string | null;
  aiTitle: string | null;
  aiDescription: string | null;
  tags: string[];
  sharedAcrossAgents: boolean;
  file: File;
}

/**
 * Two-step upload:
 *   1. Push the raw bytes into `brain-uploads/<agent>/<uuid>.<ext>`.
 *   2. Call `brain-ingest` edge function with the storage path. The
 *      function downloads via service_role, extracts text, and inserts
 *      the `brain_documents` row.
 *
 * Why edge-function instead of doing extraction in the browser?
 *   We use Claude's document/vision API for extraction which needs the
 *   Anthropic API key — that key cannot live client-side. The edge
 *   function holds the key and runs the extraction once at upload.
 */
export async function ingestBrainFile(args: IngestFileArgs): Promise<BrainDocument> {
  if (args.file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`קובץ גדול מ־${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
  }
  const isPdf = SUPPORTED_PDF_MIMES.includes(
    args.file.type as (typeof SUPPORTED_PDF_MIMES)[number],
  );
  const isImage = SUPPORTED_IMAGE_MIMES.includes(
    args.file.type as (typeof SUPPORTED_IMAGE_MIMES)[number],
  );
  if (!isPdf && !isImage) {
    throw new Error(`סוג קובץ לא נתמך: ${args.file.type || "לא ידוע"}`);
  }

  const sourceKind: BrainSourceKind = isPdf ? "pdf" : "image";
  const ext = args.file.name.split(".").pop() ?? (isPdf ? "pdf" : "png");
  const pathFolder = args.sharedAcrossAgents ? "_shared" : args.agentId;
  const storagePath = `${pathFolder}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadErr } = await supabase
    .storage
    .from("brain-uploads")
    .upload(storagePath, args.file, {
      cacheControl: "3600",
      upsert: false,
      contentType: args.file.type,
    });
  if (uploadErr) throw new Error(`העלאה לאחסון נכשלה: ${uploadErr.message}`);

  const { data, error: fnErr } = await supabase.functions.invoke("brain-ingest", {
    body: {
      agent_id: args.agentId,
      source_kind: sourceKind,
      storage_path: storagePath,
      file_size_bytes: args.file.size,
      title: args.title,
      description: args.description,
      ai_title: args.aiTitle,
      ai_description: args.aiDescription,
      tags: args.tags,
      shared_across_agents: args.sharedAcrossAgents,
    },
  });
  if (fnErr) {
    // Best-effort: try to clean up the orphan storage object so we don't
    // leave dangling files when extraction fails.
    await supabase.storage.from("brain-uploads").remove([storagePath]);
    throw new Error(`חילוץ הטקסט נכשל: ${fnErr.message}`);
  }
  return (data as { document: BrainDocument }).document;
}
