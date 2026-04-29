/**
 * Queries on `public.messages`.
 *
 * RLS:
 *   - SELECT: any authenticated user (migration 0002).
 *   - INSERT: any authenticated user, but only `direction = 'outbound'`
 *     (migration 0005). Inbound messages flow through service_role
 *     (n8n) and are not affected.
 *
 * The dashboard never inserts inbound messages.
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
 * Insert an outbound message. The row lands in the DB; actual delivery to
 * WhatsApp is handled by n8n (out of scope for this PR).
 */
export async function sendOutboundMessage({
  conversationId,
  content,
}: SendOutboundParams): Promise<Message> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Cannot send an empty message");
  }
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      content: trimmed,
      direction: "outbound",
      message_type: "text",
      timestamp: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to send message: ${error.message}`);
  }
  return data;
}
