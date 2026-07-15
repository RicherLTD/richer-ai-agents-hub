import { supabase } from "@/lib/supabase/client";

export interface EmbedMessage {
  direction: "inbound" | "outbound";
  content: string | null;
  message_type: string | null;
  timestamp: string | null;
}

export interface EmbedConversation {
  lead: { name: string | null; phone: string } | null;
  messages: EmbedMessage[];
}

export interface EmbedParams {
  p: string;
  product: string;
  sig: string;
}

export async function fetchEmbedConversation(params: EmbedParams): Promise<EmbedConversation> {
  const { data, error } = await supabase.functions.invoke<EmbedConversation>("conversation-view", {
    body: { p: params.p, product: params.product, sig: params.sig },
  });
  if (error) throw new Error(`Failed to load conversation: ${error.message}`);
  if (!data) throw new Error("No conversation data returned");
  return data;
}
