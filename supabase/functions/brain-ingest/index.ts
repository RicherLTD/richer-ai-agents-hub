// brain-ingest/index.ts
//
// Admin-only ingestion endpoint with ASYNC extraction.
//
// Why async: Claude PDF extraction can take >120s for large documents.
// Supabase Edge Functions are capped at 150s wall-clock. Synchronous
// extraction was returning 504 to the client and the upload appeared
// to hang.
//
// Flow:
//   1. Verify admin.
//   2. Validate request + UUID + size.
//   3. Insert brain_documents row with extraction_status=\'pending\'.
//   4. Return 200 immediately with the pending row.
//   5. Background task (EdgeRuntime.waitUntil):
//        - Download file from storage.
//        - Base64 + send to Claude for extraction.
//        - Run prompt-injection scan.
//        - Update row to status=\'ready\' + extracted_text + token_count,
//          OR status=\'failed\' + extraction_error.
//        - On failure, clean up the storage object.
//
// UI polls the brain list while any row is \'pending\'.

import "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { detectPromptInjection } from "../_shared/injectionScan.ts";
import { isUuid } from "../_shared/validation.ts";

const MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 16000;
const MAX_EXTRACTED_CHARS = 200_000;
const PDF_BUCKET = "brain-uploads";
const MAX_INGEST_BYTES = 20 * 1024 * 1024;

interface IngestRequestBody {
  agent_id?: unknown;
  source_kind?: unknown;
  storage_path?: unknown;
  file_size_bytes?: unknown;
  title?: unknown;
  description?: unknown;
  ai_title?: unknown;
  ai_description?: unknown;
  tags?: unknown;
  shared_across_agents?: unknown;
}

interface ParsedIngest {
  agentId: string;
  sourceKind: "pdf" | "image";
  storagePath: string;
  fileSizeBytes: number | null;
  title: string;
  description: string | null;
  aiTitle: string | null;
  aiDescription: string | null;
  tags: string[];
  sharedAcrossAgents: boolean;
}

function parseRequest(body: IngestRequestBody): ParsedIngest {
  function asString(v: unknown, field: string): string {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new HttpError(400, `Missing or invalid field: ${field}`);
    }
    return v.trim();
  }
  function asNullableString(v: unknown): string | null {
    if (v == null || typeof v !== "string") return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  }
  const sourceKindRaw = asString(body.source_kind, "source_kind");
  if (sourceKindRaw !== "pdf" && sourceKindRaw !== "image") {
    throw new HttpError(400, `Invalid source_kind: ${sourceKindRaw} (expected pdf|image)`);
  }
  const agentIdValue = asString(body.agent_id, "agent_id");
  if (!isUuid(agentIdValue)) {
    throw new HttpError(400, "agent_id must be a UUID");
  }
  return {
    agentId: agentIdValue,
    sourceKind: sourceKindRaw,
    storagePath: asString(body.storage_path, "storage_path"),
    fileSizeBytes:
      typeof body.file_size_bytes === "number" && body.file_size_bytes >= 0
        ? body.file_size_bytes
        : null,
    title: asString(body.title, "title").slice(0, 200),
    description: asNullableString(body.description),
    aiTitle: asNullableString(body.ai_title),
    aiDescription: asNullableString(body.ai_description),
    tags: asStringArray(body.tags),
    sharedAcrossAgents: body.shared_across_agents === true,
  };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

interface AnthropicContentBlock { type: string; text?: unknown; }
interface AnthropicMessageResponse { content: ReadonlyArray<AnthropicContentBlock>; }

function firstTextBlock(response: AnthropicMessageResponse): string {
  const block = response.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") return "";
  return block.text;
}

const EXTRACTION_SYSTEM = `You are an extraction worker. Read the attached document or image and return the plain-text content verbatim.

Rules:
- Output ONLY the extracted text. No preface, no commentary, no markdown fences.
- Preserve original language (Hebrew, English, etc).
- For PDFs with multiple pages, separate pages with two newlines.
- For tables, output each row on its own line, columns separated by " | ".
- For images that are diagrams/screenshots, transcribe any visible text plus a one-line caption in parentheses describing what the image is.
- If the document is empty or unreadable, output the literal string: (no extractable content)`;

async function extractFromPdf(anthropic: Anthropic, base64Bytes: string): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const raw = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: EXTRACTION_SYSTEM,
    messages: [
      { role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Bytes } },
        { type: "text", text: "Extract the full text of this document." },
      ]},
    ],
  } as any);
  return firstTextBlock(raw as unknown as AnthropicMessageResponse);
}

async function extractFromImage(anthropic: Anthropic, base64Bytes: string, mediaType: string): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const raw = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: EXTRACTION_SYSTEM,
    messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Bytes } },
        { type: "text", text: "Transcribe any text in this image." },
      ]},
    ],
  } as any);
  return firstTextBlock(raw as unknown as AnthropicMessageResponse);
}

function inferMediaTypeFromPath(path: string, sourceKind: "pdf" | "image"): string {
  if (sourceKind === "pdf") return "application/pdf";
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

interface EdgeRuntimeShape { waitUntil(p: Promise<unknown>): void; }

/**
 * Background extraction — runs after the 200 response goes out. Never
 * throws; reports outcome by updating extraction_status on the row.
 */
async function runExtraction(args: {
  admin: SupabaseClient;
  anthropic: Anthropic;
  documentId: string;
  storagePath: string;
  sourceKind: "pdf" | "image";
}): Promise<void> {
  const { admin, anthropic, documentId, storagePath, sourceKind } = args;
  const markFailed = async (errMsg: string) => {
    await admin
      .from("brain_documents")
      .update({ extraction_status: "failed", extraction_error: errMsg.slice(0, 500) })
      .eq("id", documentId);
    await admin.storage.from(PDF_BUCKET).remove([storagePath]);
  };

  try {
    const { data: fileBlob, error: dlErr } = await admin
      .storage
      .from(PDF_BUCKET)
      .download(storagePath);
    if (dlErr || !fileBlob) {
      await markFailed(`Storage download failed: ${dlErr?.message ?? "no body"}`);
      return;
    }
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    if (bytes.length > MAX_INGEST_BYTES) {
      await markFailed(`File exceeds ingest limit (${bytes.length} bytes > 20MB)`);
      return;
    }
    const base64 = uint8ToBase64(bytes);
    const mediaType = inferMediaTypeFromPath(storagePath, sourceKind);

    let extracted: string;
    try {
      extracted = sourceKind === "pdf"
        ? await extractFromPdf(anthropic, base64)
        : await extractFromImage(anthropic, base64, mediaType);
    } catch (err) {
      await markFailed(`Claude extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const text = (extracted ?? "").slice(0, MAX_EXTRACTED_CHARS);

    const injection = detectPromptInjection(text);
    if (injection) {
      await markFailed(`Prompt-injection rejected (${injection.reason}): ${injection.excerpt}`);
      return;
    }

    const tokens = Math.ceil(text.length / 4);
    const pageCount = sourceKind === "pdf" && text.length > 0 ? text.split(/\n\n/).length : null;

    await admin
      .from("brain_documents")
      .update({
        extraction_status: "ready",
        extraction_error: null,
        extracted_text: text,
        token_count: tokens,
        page_count: pageCount,
      })
      .eq("id", documentId);
  } catch (err) {
    await markFailed(`Unexpected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const ctx = await requireAdmin(req);

    let rawBody: IngestRequestBody;
    try {
      rawBody = (await req.json()) as IngestRequestBody;
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    const input = parseRequest(rawBody);

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      throw new HttpError(500, "ANTHROPIC_API_KEY is not configured");
    }
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });

    // Insert with pending status — UI immediately renders a card with
    // "מעבד..." badge while extraction runs in the background.
    const { data: inserted, error: insErr } = await ctx.admin
      .from("brain_documents")
      .insert({
        agent_id: input.agentId,
        source_kind: input.sourceKind,
        title: input.title,
        description: input.description,
        ai_title: input.aiTitle,
        ai_description: input.aiDescription,
        storage_path: input.storagePath,
        extracted_text: "",
        file_size_bytes: input.fileSizeBytes,
        page_count: null,
        token_count: 0,
        tags: input.tags,
        shared_across_agents: input.sharedAcrossAgents,
        uploaded_by: ctx.callerId,
        extraction_status: "pending",
      })
      .select("*")
      .single();
    if (insErr || !inserted) {
      throw new HttpError(500, `Insert failed: ${insErr?.message ?? "no row"}`);
    }

    const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeShape }).EdgeRuntime;
    const task = runExtraction({
      admin: ctx.admin,
      anthropic,
      documentId: inserted.id as string,
      storagePath: input.storagePath,
      sourceKind: input.sourceKind,
    });
    if (runtime && typeof runtime.waitUntil === "function") {
      runtime.waitUntil(task);
    } else {
      // Local dev fallback
      await task;
    }

    return jsonResponse({ document: inserted }, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[brain-ingest] unexpected error", detail);
    return jsonResponse(
      { error: `Internal error: ${detail}` },
      { status: 500, headers: corsHeaders },
    );
  }
});
