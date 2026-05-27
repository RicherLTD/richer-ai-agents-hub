export interface SetModePayload {
  conversation_id: string;
  mode: "manual" | "ai";
}

export function isSetModePayload(value: unknown): value is SetModePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.conversation_id === "string" &&
    v.conversation_id.length > 0 &&
    (v.mode === "manual" || v.mode === "ai")
  );
}
