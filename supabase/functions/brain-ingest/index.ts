// brain-ingest/index.ts
//
// Admin-only ingestion endpoint. The Brain page uploads a PDF/image
// to `brain-uploads` storage, then calls this function with the
// resulting path + the metadata the operator entered. We:
//
//   1. Re-verify admin role (defense in depth on top of bucket RLS).
//   2. Download the file using service_role.
//   3. Extract plain text via Claude:
//        - PDF → document content block (Claude reads the bytes
//          directly, handles OCR for scanned pages).
//        - Image → image content block (vision-capable Sonnet 4.6
//          captions / OCRs the contents).
//   4. Estimate token count (chars/4 heuristic — close enough; we'd
//      need a real tokeniser for an exact number and that's overkill).
//   5. Insert the `brain_documents` row.
//
// Returns the created row. On any failure between storage upload and
// row insert the function does NOT clean up the storage object — the
// client retries by calling delete on the orphan path. (Best-effort
// cleanup belongs in the client which knows the path.)
//
// Why not extract on the client? The Anthropic API key cannot live in
// the browser bundle. The server holds it.

import "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";

const MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 16000;
const MAX_EXTRACTED_CHARS = 200_000;
const PDF_BUCKET = "brain-uploads";

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
    if (v == null) return null;
    if (typeof v !== "string") return null;
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
  return {
    agentId: asString(body.agent_id, "agent_id"),
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
  // chunked btoa to avoid call-stack overflow on multi-MB files.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

interface AnthropicContentBlock {
  type: string;
  text?: unknown;
}
interface AnthropicMessageResponse {
  content: ReadonlyArray<AnthropicContentBlock>;
}

function firstTextBlock(response: AnthropicMessageResponse): string {
  const block = response.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") return "";
  return block.text;
}

/**
 * One-shot extraction prompt. The agent is told to output ONLY the
 * plain text — no commentary, no markdown headers, no "I extracted:"
 * prefix. We feed the result back as the canonical brain content.
 */
const EXTRACTION_SYSTEM = `You are an extraction worker. Read the attached document or image and return the plain-text content verbatim.

Rules:
- Output ONLY the extracted text. No preface, no commentary, no markdown fences.
- Preserve original language (Hebrew, English, etc).
- For PDFs with multiple pages, separate pages with two newlines.
- For tables, output each row on its own line, columns separated by " | ".
- For images that are diagrams/screenshots, transcribe any visible text plus a one-line caption in parentheses describing what the image is.
- If the document is empty or unreadable, output the literal string: (no extractable content)`;

async function extractFromPdf(anthropic: Anthropic, base64Bytes: string): Promise<string> {
  const raw = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Bytes,
            },
          },
          { type: "text", text: "Extract the full text of this document." },
        ],
      },
    ],
    // deno-lint-ignore no-explicit-any
  } as any);
  return firstTextBlock(raw as unknown as AnthropicMessageResponse);
}

async function extractFromImage(
  anthropic: Anthropic,
  base64Bytes: string,
  mediaType: string,
): Promise<string> {
  const raw = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Bytes,
            },
          },
          { type: "text", text: "Transcribe any text in this image." },
        ],
      },
    ],
    // deno-lint-ignore no-explicit-any
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

    // Download the file from storage via service_role.
    const { data: fileBlob, error: dlErr } = await ctx.admin
      .storage
      .from(PDF_BUCKET)
      .download(input.storagePath);
    if (dlErr || !fileBlob) {
      throw new HttpError(404, `Storage download failed: ${dlErr?.message ?? "no body"}`);
    }
    const arrayBuf = await fileBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const base64Bytes = uint8ToBase64(bytes);
    const mediaType = inferMediaTypeFromPath(input.storagePath, input.sourceKind);

    // Run extraction.
    let extracted: string;
    try {
      extracted = input.sourceKind === "pdf"
        ? await extractFromPdf(anthropic, base64Bytes)
        : await extractFromImage(anthropic, base64Bytes, mediaType);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Claude extraction failed: ${detail}`);
    }
    const text = (extracted ?? "").slice(0, MAX_EXTRACTED_CHARS);
    const tokens = Math.ceil(text.length / 4);
    // Rough page count for PDFs from the extracted text (double-newline
    // separator as per the extraction prompt). Falls back to null if
    // extraction returned an empty body.
    const pageCount = input.sourceKind === "pdf" && text.length > 0
      ? text.split(/\n\n/).length
      : null;

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
        extracted_text: text,
        file_size_bytes: input.fileSizeBytes,
        page_count: pageCount,
        token_count: tokens,
        tags: input.tags,
        shared_across_agents: input.sharedAcrossAgents,
        uploaded_by: ctx.callerId,
      })
      .select("*")
      .single();
    if (insErr || !inserted) {
      throw new HttpError(500, `Insert failed: ${insErr?.message ?? "no row"}`);
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
