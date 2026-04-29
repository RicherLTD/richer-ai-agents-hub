/**
 * Sync `prompts/<agent>/<prompt_type>/<version>.md` files into the
 * `public.prompts` table.
 *
 * File layout:
 *
 *   prompts/
 *   ├── affiliate_marketing/        # matches agents.name (slug)
 *   │   ├── _active.json            # { "<prompt_type>": "<version>" }
 *   │   └── <prompt_type>/
 *   │       └── <version>.md
 *
 * Each `.md` may begin with optional YAML-style frontmatter:
 *
 *   ---
 *   notes: First v1 of the affiliate prompt
 *   ---
 *
 * Authoring rules:
 *   - The active version per (agent, prompt_type) is whichever version
 *     is named in `_active.json`. Exactly one active version per type.
 *   - All other versions remain in the table but with `is_active=false`.
 *   - Editing an existing `<version>.md` overwrites the row's content +
 *     notes (keyed on agent_id + prompt_type + version).
 *
 * The script uses the Supabase Management API (same path as
 * scripts/db/apply.ts) — no Docker, no service_role key in code.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "prompts");

function requireEnv(): { projectRef: string; accessToken: string } {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!projectRef) {
    throw new Error("Missing SUPABASE_PROJECT_REF — set it in .env.local.");
  }
  if (!accessToken) {
    throw new Error(
      "Missing SUPABASE_ACCESS_TOKEN — set it in .env.local. " +
        "Generate at https://supabase.com/dashboard/account/tokens",
    );
  }
  return { projectRef, accessToken };
}

interface Frontmatter {
  notes?: string;
}

interface PromptFile {
  agentName: string;
  promptType: string;
  version: string;
  content: string;
  notes: string | null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function parseFrontmatter(raw: string): { meta: Frontmatter; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw.trim() };
  const meta: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "notes") meta.notes = value;
  }
  return { meta, content: match[2].trim() };
}

function listAgents(): string[] {
  if (!isDir(ROOT)) return [];
  return readdirSync(ROOT).filter((n) => !n.startsWith("_") && isDir(join(ROOT, n)));
}

function listPromptTypes(agentName: string): string[] {
  return readdirSync(join(ROOT, agentName)).filter((n) => !n.startsWith("_") && isDir(join(ROOT, agentName, n)));
}

function listVersions(agentName: string, promptType: string): string[] {
  const dir = join(ROOT, agentName, promptType);
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -3));
}

function readActive(agentName: string): Record<string, string> {
  const file = join(ROOT, agentName, "_active.json");
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Missing file is fine — it just means no version is active for this agent.
  }
  return {};
}

export function collectPromptFiles(): PromptFile[] {
  const out: PromptFile[] = [];
  for (const agentName of listAgents()) {
    for (const promptType of listPromptTypes(agentName)) {
      for (const version of listVersions(agentName, promptType)) {
        const filePath = join(ROOT, agentName, promptType, `${version}.md`);
        const raw = readFileSync(filePath, "utf8");
        const { meta, content } = parseFrontmatter(raw);
        out.push({
          agentName,
          promptType,
          version,
          content,
          notes: meta.notes ?? null,
        });
      }
    }
  }
  return out;
}

async function runSql(query: string): Promise<unknown> {
  const { projectRef, accessToken } = requireEnv();
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase Management API ${response.status}: ${text}`);
  }
  return response.json();
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

interface AgentRow {
  id: string;
  name: string;
}

async function loadAgents(): Promise<Map<string, string>> {
  const result = (await runSql("SELECT id, name FROM public.agents")) as AgentRow[];
  const out = new Map<string, string>();
  for (const row of result) {
    out.set(row.name, row.id);
  }
  return out;
}

async function main() {
  const files = collectPromptFiles();
  if (files.length === 0) {
    console.log("→ No prompt files found under prompts/. Nothing to sync.");
    return;
  }

  const agentIds = await loadAgents();
  const missingAgents = new Set<string>();
  const validFiles: Array<PromptFile & { agentId: string }> = [];
  for (const f of files) {
    const id = agentIds.get(f.agentName);
    if (!id) {
      missingAgents.add(f.agentName);
      continue;
    }
    validFiles.push({ ...f, agentId: id });
  }
  if (missingAgents.size > 0) {
    console.warn(
      `⚠ Skipping prompts for unknown agents: ${[...missingAgents].join(", ")}. ` +
        "Add them to the agents table first.",
    );
  }
  if (validFiles.length === 0) {
    console.log("→ No matching agents in DB. Nothing to upsert.");
    return;
  }

  // Build a single SQL statement so the sync is atomic.
  const lines: string[] = [];
  lines.push("BEGIN;");

  // Upsert every prompt row.
  const valuesSql = validFiles
    .map(
      (f) =>
        `('${f.agentId}', '${escapeSqlString(f.promptType)}', '${escapeSqlString(f.version)}', ` +
        `'${escapeSqlString(f.content)}', ${f.notes === null ? "NULL" : `'${escapeSqlString(f.notes)}'`}, false)`,
    )
    .join(",\n  ");
  lines.push(
    `INSERT INTO public.prompts (agent_id, prompt_type, version, content, notes, is_active) VALUES\n  ${valuesSql}\n` +
      `ON CONFLICT (agent_id, prompt_type, version) DO UPDATE SET ` +
      `content = EXCLUDED.content, notes = EXCLUDED.notes;`,
  );

  // Reset is_active for every (agent, prompt_type) we're touching, then set
  // the one named in _active.json.
  const touched = new Map<string, Set<string>>();
  for (const f of validFiles) {
    const set = touched.get(f.agentId) ?? new Set<string>();
    set.add(f.promptType);
    touched.set(f.agentId, set);
  }
  for (const [agentId, types] of touched) {
    for (const promptType of types) {
      lines.push(
        `UPDATE public.prompts SET is_active = false WHERE agent_id = '${agentId}' AND prompt_type = '${escapeSqlString(promptType)}';`,
      );
    }
  }

  let activated = 0;
  for (const [agentName, agentId] of agentIds) {
    const active = readActive(agentName);
    for (const [promptType, version] of Object.entries(active)) {
      lines.push(
        `UPDATE public.prompts SET is_active = true WHERE agent_id = '${agentId}' ` +
          `AND prompt_type = '${escapeSqlString(promptType)}' ` +
          `AND version = '${escapeSqlString(version)}';`,
      );
      activated += 1;
    }
  }

  lines.push("COMMIT;");

  const sql = lines.join("\n");
  const { projectRef } = requireEnv();
  console.log(
    `→ Syncing ${validFiles.length} prompt files (${activated} active markers) ` +
      `to project ${projectRef}…`,
  );
  await runSql(sql);
  console.log("✓ Synced.");
}

// Only run main() when invoked as a script (not from tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error("✗ Sync failed:", err);
    process.exit(1);
  });
}
