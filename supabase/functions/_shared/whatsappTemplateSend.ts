// whatsappTemplateSend.ts
//
// Send a Meta-approved WhatsApp Template message via HookMyApp (which
// proxies to Meta Cloud API). Templates are the only way to INITIATE a
// conversation with a lead — outside the 24h customer-service window
// Meta requires a pre-approved template.
//
// Variable substitution:
//   Template body uses {{1}}, {{2}}, ... placeholders. We pass them as
//   an ordered array of strings; index 0 → {{1}}, index 1 → {{2}}, ...
//
// Why a separate helper from whatsappSend.ts?
//   The payload shape is fundamentally different (type=template with
//   nested components) and the error surface is different — bad template
//   name, bad variables count, unapproved category all surface as 400s
//   that need different logging.
//
// Retry policy: same as whatsappSend.ts — 3 attempts, 1s/2s backoff,
// 8s per-attempt timeout, no retry on non-429 4xx.

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000];
const FETCH_TIMEOUT_MS = 8000;
const ERROR_BODY_MAX_CHARS = 300;

if (RETRY_DELAYS_MS.length !== MAX_ATTEMPTS - 1) {
  throw new Error(
    `whatsappTemplateSend: RETRY_DELAYS_MS length must equal MAX_ATTEMPTS - 1`,
  );
}

export interface SendWhatsAppTemplateArgs {
  apiUrl: string;
  accessToken: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  languageCode: string;
  /** Ordered array of body variable values. variables[0] → {{1}}. */
  variables: ReadonlyArray<string>;
}

export type TemplateSendResult =
  | {
    ok: true;
    /** Meta wamid for the outbound template (when HookMyApp returns it). */
    metaMessageId: string | null;
    /** Rendered body text — useful for inserting an outbound row in DB. */
    renderedBody: string;
    attempts: number;
    status: number;
  }
  | {
    ok: false;
    status: number;
    errorBody: string;
    attempts: number;
    terminal: boolean;
  };

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitiseErrorBody(raw: string): string {
  const redacted = raw.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return redacted.length > ERROR_BODY_MAX_CHARS
    ? redacted.slice(0, ERROR_BODY_MAX_CHARS - 14) + "…[truncated]"
    : redacted;
}

interface MetaSendResponseShape {
  messages?: Array<{ id?: unknown }>;
}

function extractMetaMessageId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const shaped = parsed as MetaSendResponseShape;
  const first = shaped.messages?.[0];
  if (first && typeof first.id === "string") return first.id;
  return null;
}

/**
 * Render a Meta template body locally so we can store an outbound row
 * that matches what the lead actually saw. We don't have the template's
 * source text from Meta at runtime, so the rendered body here is a
 * best-effort "Template <name> sent with vars [x, y, ...]" string —
 * the source of truth for the actual message is Meta's record.
 *
 * If the operator needs the exact body in the dashboard they should
 * keep a copy of the approved template text and we can wire it in
 * later via agents.first_touch_template_body once we ship the
 * template-management dashboard.
 */
export function renderTemplatePreview(
  templateName: string,
  variables: ReadonlyArray<string>,
): string {
  if (variables.length === 0) return `[template:${templateName}]`;
  const parts = variables.map((v, i) => `{{${i + 1}}}=${v}`).join(" ");
  return `[template:${templateName}] ${parts}`;
}

export async function sendWhatsAppTemplate(
  args: SendWhatsAppTemplateArgs,
): Promise<TemplateSendResult> {
  const sendUrl = `${args.apiUrl}/${args.phoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: args.to,
    type: "template",
    template: {
      name: args.templateName,
      language: { code: args.languageCode },
      components: args.variables.length === 0
        ? []
        : [
          {
            type: "body",
            parameters: args.variables.map((v) => ({ type: "text", text: v })),
          },
        ],
    },
  };
  const payload = JSON.stringify(body);

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(sendUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });

      if (res.ok) {
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // 2xx with non-JSON body — successful send, just no id.
        }
        return {
          ok: true,
          metaMessageId: extractMetaMessageId(parsed),
          renderedBody: renderTemplatePreview(args.templateName, args.variables),
          attempts: attempt,
          status: res.status,
        };
      }

      lastStatus = res.status;
      const raw = await res.text().catch(() => "");
      lastBody = sanitiseErrorBody(raw);

      if (!isRetryableStatus(res.status)) {
        return {
          ok: false,
          status: res.status,
          errorBody: lastBody,
          attempts: attempt,
          terminal: true,
        };
      }
    } catch (networkErr) {
      lastStatus = 0;
      const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
      lastBody = sanitiseErrorBody(detail);
    } finally {
      clearTimeout(timeoutId);
    }

    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (attempt < MAX_ATTEMPTS && delay != null) await sleep(delay);
  }

  return {
    ok: false,
    status: lastStatus,
    errorBody: lastBody,
    attempts: MAX_ATTEMPTS,
    terminal: false,
  };
}
