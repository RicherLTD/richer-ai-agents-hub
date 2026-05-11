/**
 * Message + LeadMemory type re-exports from the generated Supabase types.
 *
 * Run `bun run db:types` after every migration that touches `messages`
 * or `lead_memory`.
 */
import type { Database } from "./database";

export type Message = Database["public"]["Tables"]["messages"]["Row"];
export type MessageInsert = Database["public"]["Tables"]["messages"]["Insert"];
export type MessageDirection = Database["public"]["Enums"]["message_direction_enum"];
export type MessageType = Database["public"]["Enums"]["message_type_enum"];

export type LeadMemory = Database["public"]["Tables"]["lead_memory"]["Row"];
