import { describe, expect, it } from "vitest";

import { summariseBrain } from "./brain";
import type { BrainDocument } from "@/types/brain";

function row(over: Partial<BrainDocument>): BrainDocument {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    agent_id: "agent-1",
    source_kind: "note",
    title: "title",
    description: null,
    ai_title: null,
    ai_description: null,
    storage_path: null,
    extracted_text: null,
    tags: [],
    page_count: null,
    file_size_bytes: null,
    token_count: 0,
    is_active: true,
    shared_across_agents: false,
    uploaded_by: "user-1",
    uploaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

describe("summariseBrain", () => {
  it("returns zeros for an empty brain", () => {
    expect(summariseBrain([])).toEqual({
      documentCount: 0,
      noteCount: 0,
      totalTokens: 0,
      activeTokens: 0,
    });
  });

  it("counts notes and documents separately", () => {
    const rows = [
      row({ source_kind: "note", token_count: 100 }),
      row({ source_kind: "note", token_count: 50 }),
      row({ source_kind: "pdf", token_count: 1000 }),
      row({ source_kind: "image", token_count: 200 }),
    ];
    const s = summariseBrain(rows);
    expect(s.noteCount).toBe(2);
    expect(s.documentCount).toBe(2);
    expect(s.totalTokens).toBe(1350);
    expect(s.activeTokens).toBe(1350);
  });

  it("excludes inactive rows from activeTokens but includes them in totals", () => {
    const rows = [
      row({ source_kind: "pdf", token_count: 1000, is_active: true }),
      row({ source_kind: "pdf", token_count: 500, is_active: false }),
    ];
    const s = summariseBrain(rows);
    expect(s.totalTokens).toBe(1500);
    expect(s.activeTokens).toBe(1000);
  });

  it("treats missing token_count as zero", () => {
    const rows = [
      row({ source_kind: "note", token_count: null as unknown as number }),
      row({ source_kind: "pdf", token_count: 200 }),
    ];
    const s = summariseBrain(rows);
    expect(s.totalTokens).toBe(200);
    expect(s.activeTokens).toBe(200);
  });
});
