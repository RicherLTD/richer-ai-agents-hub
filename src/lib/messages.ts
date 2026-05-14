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

export const MESSAGE_PAGE_SIZE = 30;

/**
 * Fetch the NEWEST page of messages for a conversation, returned in
 * chat reading order (oldest-first). For pagination, use
 * `getOlderMessages` to load the page that precedes a given timestamp.
 *
 * We fetch newest-first from Postgres, then reverse — this gives us the
 * latest 30 turns without loading the full history. WhatsApp does the
 * same: tail-first, scroll up to load older.
 */
export async function getMessagesForConversation(
  conversationId: string,
  limit: number = MESSAGE_PAGE_SIZE,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("timestamp", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`);
  }
  return (data ?? []).slice().reverse();
}

/**
 * Load the page of messages immediately before `beforeTimestamp`. Used
 * by the "load older messages" button at the top of the chat thread.
 *
 * Returns up to `limit` messages, oldest-first.
 */
export async function getOlderMessages(
  conversationId: string,
  beforeTimestamp: string,
  limit: number = MESSAGE_PAGE_SIZE,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .lt("timestamp", beforeTimestamp)
    .order("timestamp", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load older messages: ${error.message}`);
  }
  return (data ?? []).slice().reverse();
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
