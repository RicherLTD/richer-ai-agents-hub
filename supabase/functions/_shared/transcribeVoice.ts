// transcribeVoice.ts
//
// Hebrew voice-note transcription pipeline for WhatsApp inbound.
//
//   Meta payload arrives with `audio.id` (or `voice.id` for OPUS voice
//   notes) → we resolve the media URL via the WhatsApp Cloud API → we
//   download the raw OGG bytes → we POST them to OpenAI Whisper which
//   returns Hebrew text. The transcript then replaces the `[audio]`
//   placeholder so the rest of the agent loop treats the message as a
//   regular text turn.
//
// Why Whisper instead of Anthropic? As of 2026-05, Anthropic\'s audio
// support is still beta and Hebrew quality is mixed. Whisper has been
// state-of-the-art for Hebrew STT for two years at $0.006/min — for a
// typical 15-sec voice note that\'s $0.0015 per call. Cheap.
//
// All entry points are best-effort: every failure returns null so the
// caller can fall back to the canned "please type in text" reply.

const META_API_VERSION = "v22.0";

interface MediaBytes {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Two-step download from the WhatsApp / HookMyApp media API:
 *   1. GET /<media_id>      → JSON with the signed download URL.
 *   2. GET <signed url>     → raw audio bytes (requires Bearer token).
 *
 * Returns null on any failure — the caller falls back to canned reply.
 */
export async function downloadWhatsAppMedia(args: {
  mediaId: string;
  /** Base URL of the WhatsApp / HookMyApp API (e.g. graph.facebook.com/v22.0). */
  apiUrl: string;
  /** Same access token used for the send endpoint. */
  accessToken: string;
}): Promise<MediaBytes | null> {
  try {
    // Step 1: resolve the media URL. The endpoint is /<media_id> with
    // no path prefix beyond the version — strip the version if it\'s
    // already in apiUrl so we don\'t double it.
    const baseUrl = args.apiUrl.replace(new RegExp(`/${META_API_VERSION}/?$`), "");
    const metaUrl = `${baseUrl}/${META_API_VERSION}/${args.mediaId}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return null;

    // Step 2: download the bytes.
    const bytesRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    });
    if (!bytesRes.ok) return null;
    const arrayBuf = await bytesRes.arrayBuffer();
    return {
      bytes: new Uint8Array(arrayBuf),
      mimeType: meta.mime_type ?? "audio/ogg",
    };
  } catch {
    return null;
  }
}

/**
 * Transcribe Hebrew audio via OpenAI Whisper. Returns null on any
 * failure (missing key, API error, empty transcript). Caller is
 * expected to fall back gracefully.
 */
export async function transcribeWithWhisper(args: {
  audio: MediaBytes;
  openaiApiKey: string;
}): Promise<string | null> {
  try {
    const form = new FormData();
    const ext = args.audio.mimeType.includes("ogg") ? "ogg" : "mp3";
    form.append(
      "file",
      new Blob([args.audio.bytes], { type: args.audio.mimeType }),
      `voice.${ext}`,
    );
    form.append("model", "whisper-1");
    // Bias Whisper towards Hebrew — improves accuracy on short clips.
    form.append("language", "he");
    form.append("response_format", "text");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${args.openaiApiKey}` },
      body: form,
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (text.length < 2) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Convenience: full pipeline. Returns the Hebrew transcript or null on
 * any failure. Caller stays oblivious to whether it was a download
 * issue, a Whisper outage, or a missing env var.
 */
export async function transcribeVoiceNote(args: {
  mediaId: string;
  apiUrl: string;
  accessToken: string;
  openaiApiKey: string;
}): Promise<string | null> {
  const audio = await downloadWhatsAppMedia({
    mediaId: args.mediaId,
    apiUrl: args.apiUrl,
    accessToken: args.accessToken,
  });
  if (!audio) return null;
  return await transcribeWithWhisper({ audio, openaiApiKey: args.openaiApiKey });
}
