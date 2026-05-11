/**
 * Conversation type aliases — re-exports the generated Supabase Row types
 * for the `public.conversations` table and its enums. A "lead" in the
 * dashboard is just a `Conversation` row scoped by lead_phone + agent_id.
 *
 * Run `bun run db:types` to regenerate the source `database.ts` file.
 */
import type { Database } from "./database";

export type Conversation = Database["public"]["Tables"]["conversations"]["Row"];
export type ConversationInsert = Database["public"]["Tables"]["conversations"]["Insert"];
export type ConversationUpdate = Database["public"]["Tables"]["conversations"]["Update"];

export type FunnelStage = Database["public"]["Enums"]["funnel_stage_enum"];
export type ConversationTag = Database["public"]["Enums"]["tag_enum"];
export type ConversationStatus = Database["public"]["Enums"]["conversation_status_enum"];
export type Objection = Database["public"]["Enums"]["objection_enum"];
