/**
 * Agent type — re-exports the generated Supabase Row type.
 *
 * The shape is auto-generated in src/types/database.ts from the live schema
 * via `bunx supabase gen types typescript --linked`. Don't edit by hand —
 * run the codegen after every migration.
 */
import type { Database } from "./database";

// Augmentation: columns added in migrations after database.ts was last
// regenerated. Until `supabase gen types typescript` catches up, these
// locally-declared fields keep the rest of the codebase typed.
interface AgentAugment {
  is_paused?: boolean;
  whatsapp_phone_number_id?: string | null;
}

export type Agent = Database["public"]["Tables"]["agents"]["Row"] & AgentAugment;
export type AgentInsert = Database["public"]["Tables"]["agents"]["Insert"] & AgentAugment;
export type AgentUpdate = Database["public"]["Tables"]["agents"]["Update"] & AgentAugment;
export type AgentStatus = Database["public"]["Enums"]["agent_status_enum"];
