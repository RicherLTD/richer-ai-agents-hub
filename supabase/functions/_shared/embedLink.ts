// Signs / verifies the deterministic, non-expiring embed URL used to show a
// lead's WhatsApp conversation inside the Fireberry card.
//
// The signature is HMAC-SHA256 over the canonical string `${phone}|${product}`.
// It is STABLE (no timestamp) because the URL lives permanently in a Fireberry
// field; access is governed by Fireberry record permissions, and rotating
// EMBED_LINK_SECRET revokes every link at once.
import { toCanonicalPhone } from "./normalizePhone.ts";

const VALID_PRODUCTS = new Set(["B", "R"]);

async function hmacSha256Hex(key: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare (mirrors whatsappWebhookHandler.ts).
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0xffff;
    const cb = i < b.length ? b.charCodeAt(i) : 0xffff;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// Canonical signable payload, or null if inputs are invalid.
function canonicalPayload(phone: string, product: string): string | null {
  const p = toCanonicalPhone(phone);
  if (!p) return null;
  if (!VALID_PRODUCTS.has(product)) return null;
  return `${p}|${product}`;
}

export async function signEmbedToken(
  phone: string,
  product: string,
  secret: string,
): Promise<string | null> {
  const payload = canonicalPayload(phone, product);
  if (!payload) return null;
  return await hmacSha256Hex(secret, payload);
}

export async function verifyEmbedSig(
  phone: string,
  product: string,
  sig: string,
  secret: string,
): Promise<boolean> {
  const payload = canonicalPayload(phone, product);
  if (!payload) return false;
  const expected = await hmacSha256Hex(secret, payload);
  return timingSafeEqual(sig, expected);
}

// Full embed URL: `${base}/embed/c?p=<canonical>&product=<B|R>&sig=<hex>`.
export async function buildEmbedUrl(
  baseUrl: string,
  phone: string,
  product: string,
  secret: string,
): Promise<string | null> {
  const p = toCanonicalPhone(phone);
  const sig = await signEmbedToken(phone, product, secret);
  if (!p || !sig) return null;
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/embed/c?p=${p}&product=${product}&sig=${sig}`;
}
