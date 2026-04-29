import type { Agent } from "@/types/agent";

/**
 * Static agent list — placeholder until the Supabase client lands in PR 7.
 * Replace `getAgents` with a Supabase query then; the rest of the app stays
 * the same because everything reads from `AgentContext`.
 *
 * Shape mirrors the generated Row type in src/types/database.ts. Fields that
 * are nullable in the DB are present as null here (created_at, etc.) so the
 * mock satisfies strict TypeScript.
 */
const STATIC_AGENTS: Agent[] = [
  {
    id: "affiliate-marketing-siton",
    name: "affiliate_marketing",
    display_name: "שיווק שותפים — האחים סיטון",
    description: "סוכן AI לטיפול בלידים מפאנל שיווק שותפים של האחים סיטון",
    brand_color: "#451470",
    status: "active",
    primary_goal: "סגירת פגישות ייעוץ עם לידים מתעניינים",
    product_info: null,
    whatsapp_number: null,
    whatsapp_provider: null,
    source_funnels: [],
    icon_url: null,
    created_at: null,
    created_by: null,
    updated_at: null,
  },
];

export async function getAgents(): Promise<Agent[]> {
  return STATIC_AGENTS;
}
