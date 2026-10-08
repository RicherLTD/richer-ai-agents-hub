import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeVoiceNote, type TranscriptionFailure } from "./transcribeVoice.ts";

const ARGS = {
  mediaId: "MEDIA123",
  apiUrl: "https://gateway.hookmyapp.com/meta/v22.0",
  accessToken: "hmat_secret_token",
  openaiApiKey: "sk-secret",
};
const SIGNED_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA123&hash=SIGNATURE";

function stubFetch(responses: Array<() => Response>) {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runCapturingFailure(): Promise<{ text: string | null; failure: TranscriptionFailure | null }> {
  let failure: TranscriptionFailure | null = null;
  const text = await transcribeVoiceNote({ ...ARGS, onFailure: (f) => { failure = f; } });
  return { text, failure };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeVoiceNote failure reporting", () => {
  it("reports a failed media lookup with its status", async () => {
    stubFetch([() => new Response("{}", { status: 404 })]);
    const { text, failure } = await runCapturingFailure();
    expect(text).toBeNull();
    expect(failure).toEqual({ step: "media_lookup", status: 404, detail: "gateway.hookmyapp.com" });
  });

  it("reports a failed download by host only, never the signed URL or a token", async () => {
    stubFetch([
      () => Response.json({ url: SIGNED_URL, mime_type: "audio/ogg" }),
      () => new Response("unauthorized", { status: 401 }),
    ]);
    const { failure } = await runCapturingFailure();
    expect(failure).toEqual({ step: "media_download", status: 401, detail: "lookaside.fbsbx.com" });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("SIGNATURE");
    expect(serialized).not.toContain("hmat_secret_token");
  });

  it("reports a Whisper rejection with its status", async () => {
    stubFetch([
      () => Response.json({ url: SIGNED_URL, mime_type: "audio/ogg" }),
      () => new Response(new Uint8Array([1, 2, 3])),
      () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }),
    ]);
    const { failure } = await runCapturingFailure();
    expect(failure?.step).toBe("whisper");
    expect(failure?.status).toBe(429);
    expect(failure?.detail).toContain("insufficient_quota");
  });

  it("returns the transcript and reports nothing on success", async () => {
    stubFetch([
      () => Response.json({ url: SIGNED_URL, mime_type: "audio/ogg" }),
      () => new Response(new Uint8Array([1, 2, 3])),
      () => new Response("  כן, עדיין מעניין אותי  "),
    ]);
    const { text, failure } = await runCapturingFailure();
    expect(text).toBe("כן, עדיין מעניין אותי");
    expect(failure).toBeNull();
  });
});
