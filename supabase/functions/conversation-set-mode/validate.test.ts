import { describe, it, expect } from "vitest";
import { isSetModePayload } from "./validate.ts";

describe("isSetModePayload", () => {
  it("accepts a valid manual payload", () => {
    expect(isSetModePayload({ conversation_id: "abc", mode: "manual" })).toBe(true);
  });
  it("accepts a valid ai payload", () => {
    expect(isSetModePayload({ conversation_id: "abc", mode: "ai" })).toBe(true);
  });
  it("rejects an unknown mode", () => {
    expect(isSetModePayload({ conversation_id: "abc", mode: "auto" })).toBe(false);
  });
  it("rejects a missing/empty conversation_id", () => {
    expect(isSetModePayload({ mode: "manual" })).toBe(false);
    expect(isSetModePayload({ conversation_id: "", mode: "manual" })).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(isSetModePayload(null)).toBe(false);
    expect(isSetModePayload("manual")).toBe(false);
  });
});
