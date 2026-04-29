/**
 * Prompt type re-exports from the generated Supabase types.
 *
 * Prompts are read-only in the dashboard — they're authored as files in
 * `prompts/` and synced to the DB via a server-side script. Editing in
 * the dashboard would be overwritten on the next sync (see CLAUDE.md
 * decision #5).
 */
import type { Database } from "./database";

export type Prompt = Database["public"]["Tables"]["prompts"]["Row"];
