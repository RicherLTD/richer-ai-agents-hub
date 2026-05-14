export type BrainSourceKind = "pdf" | "image" | "note";

export interface BrainDocument {
  id: string;
  agent_id: string;
  source_kind: BrainSourceKind;
  title: string;
  description: string | null;
  ai_title: string | null;
  ai_description: string | null;
  storage_path: string | null;
  extracted_text: string | null;
  tags: string[];
  page_count: number | null;
  file_size_bytes: number | null;
  token_count: number | null;
  is_active: boolean;
  shared_across_agents: boolean;
  uploaded_by: string;
  uploaded_at: string;
  updated_at: string;
}

export interface BrainDocumentSummary {
  id: string;
  source_kind: BrainSourceKind;
  title: string;
  shared_across_agents: boolean;
}
