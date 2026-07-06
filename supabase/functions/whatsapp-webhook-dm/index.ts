// whatsapp-webhook-dm/index.ts
//
// Thin entrypoint for the digital_marketing WhatsApp channel (persona: תמיר).
// Shares ../_shared/whatsappWebhookHandler.ts with the affiliate entrypoint.
// Supplies the digital-marketing HookMyApp channel credentials from the
// _DM-suffixed Supabase secrets (separate WABA / access token / verify token).
// agentName is hardcoded because this function IS the digital-marketing channel;
// it is only the routing fallback when phone_number_id lookup misses.
import { handleWhatsappWebhook } from "../_shared/whatsappWebhookHandler.ts";

Deno.serve((req) =>
  handleWhatsappWebhook(req, {
    verifyToken: Deno.env.get("VERIFY_TOKEN_DM"),
    agentName: "digital_marketing",
    whatsappApiUrl: Deno.env.get("WHATSAPP_API_URL_DM"),
    whatsappAccessToken: Deno.env.get("WHATSAPP_ACCESS_TOKEN_DM"),
    whatsappPhoneNumberId: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID_DM"),
  })
);
