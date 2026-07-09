import { describe, expect, it } from "vitest";

import { buildRecipientSet } from "./broadcastRecipients.ts";

describe("buildRecipientSet", () => {
  const base = { optedOutPhones: new Set<string>(), blockedPhones: new Set<string>() };

  it("keeps a valid recipient and canonicalizes its phone", () => {
    const r = buildRecipientSet({ ...base, recipients: [{ phone: "0528524113", name: "דנה" }] });
    expect(r.toSend).toEqual([
      { phone: "972528524113", name: "דנה", variables: null, conversationId: null },
    ]);
    expect(r.suppressedCount).toBe(0);
  });

  it("suppresses an opted-out phone", () => {
    const r = buildRecipientSet({
      ...base,
      optedOutPhones: new Set(["972528524113"]),
      recipients: [{ phone: "+972528524113" }],
    });
    expect(r.toSend).toHaveLength(0);
    expect(r.breakdown.opt_out).toBe(1);
    expect(r.suppressedCount).toBe(1);
  });

  it("suppresses a phone whose conversation carries a blocking tag", () => {
    const r = buildRecipientSet({
      ...base,
      blockedPhones: new Set(["972528524113"]),
      recipients: [{ phone: "972528524113" }],
    });
    expect(r.toSend).toHaveLength(0);
    expect(r.breakdown.blocking_tag).toBe(1);
  });

  it("suppresses a duplicate phone (keeps the first only)", () => {
    const r = buildRecipientSet({
      ...base,
      recipients: [{ phone: "0528524113" }, { phone: "+972528524113" }],
    });
    expect(r.toSend).toHaveLength(1);
    expect(r.breakdown.duplicate).toBe(1);
  });

  it("suppresses an invalid phone", () => {
    const r = buildRecipientSet({ ...base, recipients: [{ phone: "hello" }] });
    expect(r.toSend).toHaveLength(0);
    expect(r.breakdown.invalid_phone).toBe(1);
  });

  it("passes per-recipient variables through when non-empty", () => {
    const r = buildRecipientSet({ ...base, recipients: [{ phone: "0528524113", variables: ["X"] }] });
    expect(r.toSend[0].variables).toEqual(["X"]);
  });
});
