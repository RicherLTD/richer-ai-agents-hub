/**
 * Queries on `public.messages`.
 *
 * RLS:
 *   - SELECT: any authenticated user (migration 0002).
 *   - INSERT: any authenticated user, but only `direction = 'outbound'`
 *     (migration 0005). Inbound messages flow through service_role
 *     (n8n / whatsapp-webhook edge function) and are not affected.
 *
 * Outbound flow: the dashboard calls the `whatsapp-send` edge function,
 * which sends via HookMyApp and only then inserts the row — so no orphan
 * outbound rows from failed sends.
 */
import { supabase } from "./supabase/client";
import type { Message } from "@/types/message";

/**
 * Fetch every message for a conversation, oldest-first (chat reading order).
 */
export async function getMessagesForConversation(conversationId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("timestamp", { ascending: true, nullsFirst: false })
    .limit(500);

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`);
  }
  return data ?? [];
}

export interface SendOutboundParams {
  conversationId: string;
  content: string;
}

/**
 * Send an outbound WhatsApp message via the `whatsapp-send` edge function.
 * The function calls HookMyApp (sandbox or production), and on a 2xx
 * inserts a `direction='outbound'` row into `messages`.
 */
export async function sendOutboundMessage({
  conversationId,
  content,
}: SendOutboundParams): Promise<Message> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Cannot send an empty message");
  }
  const { data, error } = await supabase.functions.invoke<Message>("whatsapp-send", {
    body: { conversation_id: conversationId, content: trimmed },
  });
  if (error) {
    throw new Error(`Failed to send message: ${error.message}`);
  }
  if (!data) {
    throw new Error("Send succeeded but no message returned");
  }
  return data;
}
