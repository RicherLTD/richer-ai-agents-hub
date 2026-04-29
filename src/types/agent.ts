/**
 * Agent type — re-exports the generated Supabase Row type.
 *
 * The shape is auto-generated in src/types/database.ts from the live schema
 * via `bunx supabase gen types typescript --linked`. Don't edit by hand —
 * run the codegen after every migration.
 */
import type { Database } from "./database";

export type Agent = Database["public"]["Tables"]["agents"]["Row"];
export type AgentInsert = Database["public"]["Tables"]["agents"]["Insert"];
export type AgentUpdate = Database["public"]["Tables"]["agents"]["Update"];
export type AgentStatus = Database["public"]["Enums"]["agent_status_enum"];
