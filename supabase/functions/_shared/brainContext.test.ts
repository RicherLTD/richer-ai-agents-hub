import { describe, expect, it } from "vitest";

import { type BrainRow, buildBrainSection } from "./brainContext.ts";

function row(over: Partial<BrainRow>): BrainRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    source_kind: "note",
    title: "Hebrew title",
    description: null,
    ai_title: null,
    ai_description: null,
    extracted_text: "body",
    tags: [],
    shared_across_agents: false,
    ...over,
  };
}

describe("buildBrainSection", () => {
  it("returns empty when no rows", () => {
    const result = buildBrainSection([]);
    expect(result.text).toBe("");
    expect(result.usedIds).toEqual([]);
  });

  it("emits notes section when only notes present", () => {
    const result = buildBrainSection([
      row({ id: "a", title: "Note A", extracted_text: "first note" }),
      row({ id: "b", title: "Note B", extracted_text: "second note" }),
    ]);
    expect(result.text).toContain("### Notes");
    expect(result.text).toContain("first note");
    expect(result.text).toContain("second note");
    expect(result.usedIds).toEqual(["a", "b"]);
  });

  it("separates notes from documents", () => {
    const result = buildBrainSection([
      row({ id: "n1", source_kind: "note", title: "Note", extracted_text: "fact" }),
      row({ id: "d1", source_kind: "pdf", title: "Brochure", extracted_text: "doc body" }),
    ]);
    expect(result.text).toContain("### Notes");
    expect(result.text).toContain("### Documents");
    expect(result.text).toContain("fact");
    expect(result.text).toContain("doc body");
  });

  it("prefers ai_title when present", () => {
    const result = buildBrainSection([
      row({ id: "x", title: "Hebrew Title", ai_title: "English Title", extracted_text: "x" }),
    ]);
    expect(result.text).toContain("English Title");
    // The Hebrew title may not appear at all because we used the AI override.
  });

  it("escapes quotes in titles for the brain_doc attribute", () => {
    const result = buildBrainSection([
      row({ id: "q", title: 'has "quotes"', extracted_text: "x" }),
    ]);
    // Raw `"` must be backslash-escaped so it doesn't terminate the attribute.
    expect(result.text).toContain('title="has \\"quotes\\""');
  });

  it("includes tags on document blocks", () => {
    const result = buildBrainSection([
      row({
        id: "d",
        source_kind: "pdf",
        title: "Doc",
        tags: ["pricing", "sales"],
        extracted_text: "x",
      }),
    ]);
    expect(result.text).toContain('tags="pricing,sales"');
  });

  it("records every id it included in insertion order (notes then docs)", () => {
    const result = buildBrainSection([
      row({ id: "1", source_kind: "note", extracted_text: "a" }),
      row({ id: "2", source_kind: "pdf", extracted_text: "b" }),
      row({ id: "3", source_kind: "image", extracted_text: "c" }),
    ]);
    expect(result.usedIds).toEqual(["1", "2", "3"]);
  });
});
