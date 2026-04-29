/**
 * CORS headers shared by all edge functions.
 * Browsers will preflight (OPTIONS) before any non-GET request that includes
 * an Authorization header — handle those uniformly.
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
