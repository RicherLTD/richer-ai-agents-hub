// brainContext.ts
//
// Loads + formats the "brain" knowledge base for the Prompt Coach.
//
// Visibility rule mirrors the client lib (src/lib/brain.ts):
//   rows are visible to an agent iff agent_id matches OR
//   shared_across_agents is true. RLS on the table is admin-only;
//   visibility filter happens here.
//
// Approach A (per product decision): all active rows go into the
// system prompt every turn. Caller adds an Anthropic cache_control
// breakpoint on the returned block so subsequent turns within 5 min
// hit the cache. With ~50K tokens of brain at $3/M cold vs $0.30/M
// cache-read, that's a 10x cost reduction.
//
// Field selection for Claude:
//   - We prefer ai_title / ai_description (English, operator-curated)
//     when present; otherwise fall back to the Hebrew title / description.
//     Sonnet 4.6 handles Hebrew natively, so the bilingual override is
//     just a quality nudge for operators who want tighter phrasing.
//   - We always send extracted_text verbatim (it IS the content).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export interface BrainRow {
  id: string;
  source_kind: string;
  title: string;
  description: string | null;
  ai_title: string | null;
  ai_description: string | null;
  extracted_text: string | null;
  tags: string[];
  shared_across_agents: boolean;
}

/**
 * Load every active brain row visible to `agentId`:
 *   own rows  OR  rows where shared_across_agents = true.
 * Inactive rows are excluded — operators toggle is_active to remove
 * a row from the brain without deleting it.
 */
export async function loadBrainRows(
  admin: SupabaseClient,
  agentId: string,
): Promise<BrainRow[]> {
  const { data, error } = await admin
    .from("brain_documents")
    .select(
      "id, source_kind, title, description, ai_title, ai_description, extracted_text, tags, shared_across_agents",
    )
    .or(`agent_id.eq.${agentId},shared_across_agents.eq.true`)
    .eq("is_active", true)
    .order("uploaded_at", { ascending: true });
  if (error) {
    throw new Error(`Failed to load brain: ${error.message}`);
  }
  return (data ?? []) as BrainRow[];
}

export interface BrainSection {
  /** Markdown body to drop into the system prompt. Empty string if no rows. */
  text: string;
  /** Row ids that were included — used by brain_usage_log for transparency. */
  usedIds: string[];
}

/**
 * Render the brain rows as a single markdown section. Notes come first
 * (operator-authored, highest signal), then documents grouped by tags.
 * Each row is wrapped in a `<brain_doc id="...">` block so Claude can
 * reference it by id in its reply if asked.
 */
export function buildBrainSection(rows: ReadonlyArray<BrainRow>): BrainSection {
  if (rows.length === 0) {
    return { text: "", usedIds: [] };
  }
  const parts: string[] = [
    `## Brain — persistent knowledge for this agent`,
    ``,
    `The operator has curated the following facts and documents. Treat them as authoritative context when answering. Cite by title when relevant.`,
    ``,
  ];

  const notes = rows.filter((r) => r.source_kind === "note");
  const docs = rows.filter((r) => r.source_kind !== "note");
  const usedIds: string[] = [];

  if (notes.length > 0) {
    parts.push(`### Notes (operator-written facts)`);
    for (const n of notes) {
      const title = n.ai_title?.trim() || n.title;
      const body = n.extracted_text?.trim() ?? "";
      parts.push(
        `<brain_doc id="${n.id}" kind="note" title="${escapeAttr(title)}">`,
        body,
        `</brain_doc>`,
        ``,
      );
      usedIds.push(n.id);
    }
  }

  if (docs.length > 0) {
    parts.push(`### Documents (uploaded by the operator)`);
    for (const d of docs) {
      const title = d.ai_title?.trim() || d.title;
      const desc = (d.ai_description ?? d.description)?.trim() ?? "";
      const body = d.extracted_text?.trim() ?? "";
      const tagsLine = d.tags.length > 0 ? `tags="${escapeAttr(d.tags.join(","))}" ` : "";
      parts.push(
        `<brain_doc id="${d.id}" kind="${d.source_kind}" ${tagsLine}title="${escapeAttr(title)}">`,
        desc ? `_${desc}_` : "",
        body,
        `</brain_doc>`,
        ``,
      );
      usedIds.push(d.id);
    }
  }

  return { text: parts.join("\n"), usedIds };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "\\\"").slice(0, 200);
}
