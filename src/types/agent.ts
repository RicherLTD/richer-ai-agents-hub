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
  // CRM warming (migration 0046, not yet applied). Drop these four once
  // `bun run db:types` has been re-run against the migrated schema.
  /** Kill switch for CRM warming. When false, status events are still recorded
   *  on the conversation but nothing is warmed. Independent of `is_paused`. */
  crm_warming_enabled?: boolean;
  /** Meta-approved template used for the generic warming opener. Nullable. */
  warming_template_name?: string | null;
  /** NOT NULL, defaults to 'he' — never write null here. */
  warming_template_language?: string;
  /** NOT NULL, CHECK > 0. How many days of prior conversation the bot gets. */
  warming_context_days?: number;
}

export type Agent = Database["public"]["Tables"]["agents"]["Row"] & AgentAugment;
export type AgentInsert = Database["public"]["Tables"]["agents"]["Insert"] & AgentAugment;
export type AgentUpdate = Database["public"]["Tables"]["agents"]["Update"] & AgentAugment;
export type AgentStatus = Database["public"]["Enums"]["agent_status_enum"];
