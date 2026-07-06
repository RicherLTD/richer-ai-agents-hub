// whatsapp-webhook/index.ts
//
// Thin entrypoint for the affiliate_marketing WhatsApp channel.
// All logic lives in ../_shared/whatsappWebhookHandler.ts and is shared
// with the digital_marketing channel (whatsapp-webhook-dm). This entrypoint
// only supplies the per-channel HookMyApp credentials from the (unsuffixed)
// Supabase secrets that already back the affiliate number.
import { handleWhatsappWebhook } from "../_shared/whatsappWebhookHandler.ts";

Deno.serve((req) =>
  handleWhatsappWebhook(req, {
    verifyToken: Deno.env.get("VERIFY_TOKEN"),
    agentName: Deno.env.get("HOOKMYAPP_AGENT_NAME"),
    whatsappApiUrl: Deno.env.get("WHATSAPP_API_URL"),
    whatsappAccessToken: Deno.env.get("WHATSAPP_ACCESS_TOKEN"),
    whatsappPhoneNumberId: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID"),
  })
);
