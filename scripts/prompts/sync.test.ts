import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./sync";

describe("parseFrontmatter", () => {
  it("returns empty meta + trimmed content when no frontmatter", () => {
    const { meta, content } = parseFrontmatter("Hello\n\nworld\n");
    expect(meta).toEqual({});
    expect(content).toBe("Hello\n\nworld");
  });

  it("parses a simple notes block", () => {
    const raw = "---\nnotes: First v1\n---\nbody";
    const { meta, content } = parseFrontmatter(raw);
    expect(meta.notes).toBe("First v1");
    expect(content).toBe("body");
  });

  it("strips wrapping quotes from values", () => {
    const raw = '---\nnotes: "quoted value"\n---\nbody';
    const { meta } = parseFrontmatter(raw);
    expect(meta.notes).toBe("quoted value");
  });

  it("handles CRLF line endings", () => {
    const raw = "---\r\nnotes: with crlf\r\n---\r\nbody";
    const { meta, content } = parseFrontmatter(raw);
    expect(meta.notes).toBe("with crlf");
    expect(content).toBe("body");
  });

  it("ignores keys we don't recognise", () => {
    const raw = "---\nnotes: ok\nrandom: ignored\n---\nbody";
    const { meta } = parseFrontmatter(raw);
    expect(meta.notes).toBe("ok");
    expect((meta as Record<string, unknown>).random).toBeUndefined();
  });

  it("keeps content as-is when frontmatter delimiters are missing", () => {
    const raw = "notes: just text, no fences\nbody";
    const { meta, content } = parseFrontmatter(raw);
    expect(meta).toEqual({});
    expect(content).toBe(raw);
  });

  it("preserves colons inside values", () => {
    const raw = "---\nnotes: see ticket: ABC-123\n---\nbody";
    const { meta } = parseFrontmatter(raw);
    expect(meta.notes).toBe("see ticket: ABC-123");
  });
});
