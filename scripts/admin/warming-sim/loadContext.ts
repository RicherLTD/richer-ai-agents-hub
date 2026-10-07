// Loads, read-only, everything the production handler would read for a
// warming turn: the active main prompt, the status rules, the opener text and
// the brain. The queries mirror whatsappWebhookHandler.ts (loadAgentTurnContext,
// loadActiveWarmingRule, buildWarmingBlock) and brainContext.loadBrainRows.

import type { BrainRow } from "../../../supabase/functions/_shared/brainContext.ts";
import type { ReadOnlyDb } from "./db.ts";

export const AGENT_SLUG = "affiliate_marketing";

const SLUG_PATTERN = /^[a-z_]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StatusRule {
  status_sub: number;
  status_label: string;
  objection_key: string;
  warming_instructions: string;
}

export interface SimulationContext {
  agentId: string;
  agentSlug: string;
  mainPrompt: { content: string; version: string };
  openerTemplateName: string;
  openerText: string | null;
  rules: StatusRule[];
  brainRows: BrainRow[];
}

interface AgentRow {
  id: string;
  warming_template_name: string | null;
}

interface PromptRow {
  content: string;
  version: string;
}

export function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) throw new Error("agent slug must be lowercase letters and underscores");
}

function assertUuidValue(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error("expected a uuid");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function loadAgent(db: ReadOnlyDb, slug: string): Promise<AgentRow> {
  assertSlug(slug);
  const [agent] = await db.query<AgentRow>(
    `select id, warming_template_name from agents where name = ${sqlString(slug)} limit 1`,
  );
  if (!agent) throw new Error(`agent '${slug}' not found`);
  if (!agent.warming_template_name) throw new Error(`agent '${slug}' has no warming_template_name`);
  return agent;
}

async function loadMainPrompt(db: ReadOnlyDb, agentId: string): Promise<PromptRow> {
  assertUuidValue(agentId);
  const [prompt] = await db.query<PromptRow>(
    `select content, version from prompts where agent_id = ${sqlString(agentId)} and prompt_type = 'main' and is_active = true order by created_at desc limit 1`,
  );
  if (!prompt?.content) throw new Error("no active main prompt for the agent");
  return prompt;
}

async function loadRules(db: ReadOnlyDb, agentId: string): Promise<StatusRule[]> {
  assertUuidValue(agentId);
  return db.query<StatusRule>(
    `select status_sub, status_label, objection_key, warming_instructions from crm_status_rules where agent_id = ${sqlString(agentId)} and is_active = true order by status_sub`,
  );
}

async function loadOpenerText(db: ReadOnlyDb, agentId: string, name: string): Promise<string | null> {
  assertUuidValue(agentId);
  const [template] = await db.query<{ body_preview: string | null }>(
    `select body_preview from broadcast_templates where agent_id = ${sqlString(agentId)} and name = ${sqlString(name)} limit 1`,
  );
  return template?.body_preview ?? null;
}

/** Same visibility and order as brainContext.loadBrainRows. */
async function loadBrain(db: ReadOnlyDb, agentId: string): Promise<BrainRow[]> {
  assertUuidValue(agentId);
  return db.query<BrainRow>(
    `select id, source_kind, title, description, ai_title, ai_description, extracted_text, tags, shared_across_agents from brain_documents where (agent_id = ${sqlString(agentId)} or shared_across_agents = true) and is_active = true order by uploaded_at asc`,
  );
}

export async function loadSimulationContext(
  db: ReadOnlyDb,
  slug: string = AGENT_SLUG,
): Promise<SimulationContext> {
  const agent = await loadAgent(db, slug);
  const openerTemplateName = agent.warming_template_name ?? "";
  const [mainPrompt, rules, openerText, brainRows] = await Promise.all([
    loadMainPrompt(db, agent.id),
    loadRules(db, agent.id),
    loadOpenerText(db, agent.id, openerTemplateName),
    loadBrain(db, agent.id),
  ]);
  return {
    agentId: agent.id,
    agentSlug: slug,
    mainPrompt,
    openerTemplateName,
    openerText,
    rules,
    brainRows: brainRows.map((row) => ({ ...row, tags: row.tags ?? [] })),
  };
}
