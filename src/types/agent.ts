/**
 * Agent type — mirrors the Supabase `agents` table schema.
 * Keep this in sync with the database. Used across the app via AgentContext.
 */
export type AgentStatus = "active" | "paused" | "archived";

export interface AgentProductInfo {
  /** Free-form product details — JSONB in DB. */
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  name: string; // e.g. "affiliate_marketing"
  display_name: string; // e.g. "שיווק שותפים — האחים סיטון"
  description: string | null;
  brand_color: string; // hex, e.g. "#451470"
  status: AgentStatus;
  primary_goal: string | null;
  product_info: AgentProductInfo | null;
  whatsapp_number: string | null;
  source_funnels: string[];
}
