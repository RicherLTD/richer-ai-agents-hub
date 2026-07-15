import { describe, expect, it } from "vitest";
import { buildEmbedUrl, signEmbedToken, verifyEmbedSig } from "./embedLink.ts";

const SECRET = "test-secret-123";

describe("signEmbedToken", () => {
  it("returns a stable hex signature for the same phone+product", async () => {
    const a = await signEmbedToken("0525188599", "B", SECRET);
    const b = await signEmbedToken("+972525188599", "B", SECRET);
    expect(a).not.toBeNull();
    expect(a).toBe(b); // phone is normalized before signing
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null for an invalid phone", async () => {
    expect(await signEmbedToken("hello", "B", SECRET)).toBeNull();
  });

  it("returns null for an unknown product", async () => {
    expect(await signEmbedToken("0525188599", "X", SECRET)).toBeNull();
  });
});

describe("verifyEmbedSig", () => {
  it("accepts a signature it produced", async () => {
    const sig = await signEmbedToken("972525188599", "R", SECRET);
    expect(await verifyEmbedSig("972525188599", "R", sig!, SECRET)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const sig = await signEmbedToken("972525188599", "R", SECRET);
    const bad = sig!.slice(0, -1) + (sig!.endsWith("0") ? "1" : "0");
    expect(await verifyEmbedSig("972525188599", "R", bad, SECRET)).toBe(false);
  });

  it("rejects when the product is swapped", async () => {
    const sig = await signEmbedToken("972525188599", "B", SECRET);
    expect(await verifyEmbedSig("972525188599", "R", sig!, SECRET)).toBe(false);
  });

  it("rejects an invalid phone outright", async () => {
    expect(await verifyEmbedSig("nope", "B", "deadbeef", SECRET)).toBe(false);
  });
});

describe("buildEmbedUrl", () => {
  it("builds a canonical URL with normalized phone", async () => {
    const url = await buildEmbedUrl("https://app.example.com/", "0525188599", "B", SECRET);
    expect(url).not.toBeNull();
    expect(url).toMatch(
      /^https:\/\/app\.example\.com\/embed\/c\?p=972525188599&product=B&sig=[0-9a-f]{64}$/,
    );
  });

  it("returns null for an invalid phone", async () => {
    expect(await buildEmbedUrl("https://x.com", "bad", "B", SECRET)).toBeNull();
  });
});
