// whatsappChannel.ts
//
// Picks which WhatsApp (HookMyApp) channel an outbound message goes out from.
// Each live agent has its own number / WABA: the unsuffixed WHATSAPP_*
// secrets are the global channel (affiliate_marketing), the WHATSAPP_*_DM
// secrets are digital_marketing.
//
// The channel list is built from env ONLY. An agent's
// `whatsapp_phone_number_id` (a DB value) is used purely as a lookup key into
// that list; an id that is not configured in env falls back to the global
// channel. So request / DB data can never become the fetch host or path.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export interface WhatsAppChannel {
  apiUrl: string;
  accessToken: string;
  phoneNumberId: string;
}

export interface WhatsAppChannels {
  /** The global (unsuffixed env) channel, or null when it is not configured. */
  fallback: WhatsAppChannel | null;
  /** Every fully configured channel, keyed by its phone number id. */
  byPhoneId: Map<string, WhatsAppChannel>;
}

/** Env-name suffix per channel: "" = global / affiliate, "_DM" = digital_marketing. */
const CHANNEL_SUFFIXES = ["", "_DM"] as const;

/** Reads every channel from env. A channel missing any of its 3 secrets is skipped. */
export function whatsAppChannelsFromEnv(
  getEnv: (key: string) => string | undefined,
): WhatsAppChannels {
  const byPhoneId = new Map<string, WhatsAppChannel>();
  let fallback: WhatsAppChannel | null = null;
  for (const suffix of CHANNEL_SUFFIXES) {
    const apiUrl = getEnv(`WHATSAPP_API_URL${suffix}`);
    const accessToken = getEnv(`WHATSAPP_ACCESS_TOKEN${suffix}`);
    const phoneNumberId = getEnv(`WHATSAPP_PHONE_NUMBER_ID${suffix}`);
    if (!apiUrl || !accessToken || !phoneNumberId) continue;
    const channel = { apiUrl, accessToken, phoneNumberId };
    byPhoneId.set(phoneNumberId, channel);
    if (suffix === "") fallback = channel;
  }
  return { fallback, byPhoneId };
}

/** The channel whose phone id matches the agent's, else the global channel. */
export function pickWhatsAppChannel(
  channels: WhatsAppChannels,
  agentPhoneId: string | null | undefined,
): WhatsAppChannel | null {
  const match = agentPhoneId ? channels.byPhoneId.get(agentPhoneId) : undefined;
  return match ?? channels.fallback;
}

/**
 * Looks up the agent's phone id and picks its channel. Throws when the
 * `agents` read fails: guessing the global channel there would send a
 * digital_marketing lead a message from the affiliate number.
 */
export async function resolveAgentWhatsAppChannel(
  admin: SupabaseClient,
  agentId: string | null | undefined,
  channels: WhatsAppChannels,
): Promise<WhatsAppChannel | null> {
  if (!agentId) return channels.fallback;
  const { data, error } = await admin
    .from("agents")
    .select("whatsapp_phone_number_id")
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error(`agents lookup failed: ${error.message}`);
  const agentPhoneId =
    (data as { whatsapp_phone_number_id?: string | null } | null)?.whatsapp_phone_number_id ?? null;
  return pickWhatsAppChannel(channels, agentPhoneId);
}
