import { describe, expect, it } from "vitest";
import {
  ATTENTION_DESCRIPTION,
  ATTENTION_LABEL,
  ATTENTION_REASONS,
  isAttentionReason,
} from "./needs-attention";

// The reason strings are written by the edge functions (needsAttention.ts) and
// constrained by the CHECK on conversations.needs_attention (migration 0046).
// If a new reason is added on either side without a label here, the badge
// renders `undefined` to an operator — so assert the maps stay complete.
describe("attention reason maps", () => {
  it("labels and describes every reason", () => {
    for (const reason of ATTENTION_REASONS) {
      expect(ATTENTION_LABEL[reason], `missing label for ${reason}`).toBeTruthy();
      expect(ATTENTION_DESCRIPTION[reason], `missing description for ${reason}`).toBeTruthy();
    }
  });

  it("matches the reasons the edge functions can write", () => {
    // Keep in sync with AttentionReason in supabase/functions/_shared/needsAttention.ts
    expect([...ATTENTION_REASONS].sort()).toEqual([
      "bot_failed",
      "calendar_closed",
      "existing_student",
      "red_flag",
    ]);
  });
});

describe("isAttentionReason", () => {
  it("accepts known reasons", () => {
    expect(isAttentionReason("bot_failed")).toBe(true);
    expect(isAttentionReason("calendar_closed")).toBe(true);
  });

  it("rejects null and unknown values so the badge stays hidden", () => {
    expect(isAttentionReason(null)).toBe(false);
    expect(isAttentionReason("something_else")).toBe(false);
    // A stale value left by an older deploy must not crash the row.
    expect(isAttentionReason("")).toBe(false);
  });
});
