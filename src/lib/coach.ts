/**
 * Client wrapper for the Prompt Coach edge functions.
 *
 * Two endpoints:
 *   - `prompt-coach`       — POST a chat turn, get back the Coach's reply
 *                            (text + optional proposed prompt content).
 *   - `prompt-coach-apply` — apply a proposed edit, creating a new active
 *                            prompt row and deactivating the old one.
 *
 * History rows live in `public.coach_messages` and are queryable directly
 * via Supabase (admin-only RLS).
 */
import { supabase } from "./supabase/client";

export interface CoachMessageRow {
  id: string;
  agent_id: string;
  role: "user" | "assistant";
  user_id: string;
  content: string;
  proposed_prompt_content: string | null;
  applied_prompt_id: string | null;
  applied_at: string | null;
  applied_by: string | null;
  referenced_conversation_id: string | null;
  attachment_url: string | null;
  created_at: string;
}

const COACH_BUCKET = "coach-uploads";
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface UploadCoachAttachmentResult {
  storagePath: string;
  signedUrl: string;
  base64DataUrl: string;
  mediaType: string;
}

export async function uploadCoachAttachment(
  agentId: string,
  file: File,
): Promise<UploadCoachAttachmentResult> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error("\u05e0\u05d9\u05ea\u05df \u05dc\u05d4\u05e2\u05dc\u05d5\u05ea \u05e8\u05e7 \u05ea\u05de\u05d5\u05e0\u05d5\u05ea (PNG / JPG / WebP / GIF)");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("\u05d4\u05ea\u05de\u05d5\u05e0\u05d4 \u05d2\u05d3\u05d5\u05dc\u05d4 \u05de\u05d3\u05d9 (\u05de\u05e7\u05e1\u05d9\u05de\u05d5\u05dd 5MB)");
  }

  const extension = file.name.includes(".")
    ? file.name.split(".").pop()!.toLowerCase()
    : "png";
  const safeAgentId = agentId.replace(/[^a-z0-9-]/gi, "");
  const uid = crypto.randomUUID();
  const storagePath = `${safeAgentId}/${uid}.${extension}`;

  const { error: uploadErr } = await supabase.storage
    .from(COACH_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadErr) {
    throw new Error(`\u05d4\u05d4\u05e2\u05dc\u05d0\u05d4 \u05e0\u05db\u05e9\u05dc\u05d4: ${uploadErr.message}`);
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from(COACH_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 30);
  if (signErr || !signed) {
    throw new Error(`\u05dc\u05d0 \u05e0\u05d9\u05ea\u05df \u05dc\u05d9\u05e6\u05d5\u05e8 URL \u05de\u05d7\u05d5\u05ea\u05dd: ${signErr?.message ?? "unknown"}`);
  }

  const base64DataUrl = await fileToDataUrl(file);
  return {
    storagePath,
    signedUrl: signed.signedUrl,
    base64DataUrl,
    mediaType: file.type,
  };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export async function resignCoachAttachment(storagePath: string): Promise<string | null> {
  if (!storagePath) return null;
  const { data, error } = await supabase.storage
    .from(COACH_BUCKET)
    .createSignedUrl(storagePath, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

export async function getCoachHistory(
  agentId: string,
  limit = 100,
): Promise<CoachMessageRow[]> {
  const { data, error } = await supabase
    .from("coach_messages")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Failed to load coach history: ${error.message}`);
  return (data ?? []) as CoachMessageRow[];
}

export interface SendCoachMessageInput {
  agentId: string;
  userMessage: string;
  referencedConversationId?: string;
  attachmentUrl?: string;
  attachmentBase64?: string;
  attachmentMediaType?: string;
}

export interface CoachReplyAssistant {
  id: string;
  content: string;
  proposedPromptContent: string | null;
  proposalReason: string | null;
  createdAt: string;
}

export interface BrainDocUsed {
  id: string;
  title: string;
  source_kind: string;
}

export interface SendCoachMessageResult {
  userMessageId: string;
  assistantMessage: CoachReplyAssistant;
  /** Brain rows that were injected as system context for this turn. */
  brainDocsUsed?: BrainDocUsed[];
}

export async function sendCoachMessage(
  input: SendCoachMessageInput,
): Promise<SendCoachMessageResult> {
  const { data, error } = await supabase.functions.invoke<SendCoachMessageResult>(
    "prompt-coach",
    { body: input },
  );
  if (error) {
    // supabase-js wraps non-2xx as FunctionsHttpError with a `context`
    // Response we need to read to surface the real server-side message.
    // Note: we do NOT nest the throw inside try/catch — that swallowed
    // the resolved server message and re-threw the wrapper text.
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx) {
      const body = await ctx.json().catch(() => null);
      const msg =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : error.message;
      throw new Error(msg);
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Coach returned no data");
  return data;
}

export interface ApplyCoachEditResult {
  newPromptId: string;
  newVersion: string;
  previousPromptId: string | null;
  previousVersion: string | null;
}

export async function applyCoachEdit(coachMessageId: string): Promise<ApplyCoachEditResult> {
  const { data, error } = await supabase.functions.invoke<ApplyCoachEditResult>(
    "prompt-coach-apply",
    { body: { coachMessageId } },
  );
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx) {
      const body = await ctx.json().catch(() => null);
      const msg =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : error.message;
      throw new Error(msg);
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Apply returned no data");
  return data;
}
