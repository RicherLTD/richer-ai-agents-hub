import { describe, expect, it } from "vitest";
import { truncate } from "./truncate.ts";

describe("truncate", () => {
  it("returns the input unchanged when shorter than max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the input unchanged when exactly at max", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("returns the truncation marker for empty input", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("truncates and appends the marker when longer than max", () => {
    const out = truncate("a".repeat(100), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("handles Hebrew content without corrupting characters", () => {
    const hebrew = "שלום עולם, זה ניסיון של טקסט בעברית עם הרבה תוכן ארוך מאוד";
    const out = truncate(hebrew, 30);
    expect(out.length).toBe(30);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});
