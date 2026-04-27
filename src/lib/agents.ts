import type { Agent } from "@/types/agent";

/**
 * Static agent list — placeholder until Lovable Cloud / Supabase is wired up.
 * Replace `getAgents` with a Supabase query later; the rest of the app stays the same.
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
    source_funnels: [],
  },
];

export async function getAgents(): Promise<Agent[]> {
  return STATIC_AGENTS;
}
