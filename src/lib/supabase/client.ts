/**
 * Supabase client singleton.
 *
 * Reads the URL and publishable/anon key from Vite env. The anon key is safe
 * in client code — its only power is what RLS allows. After login, the
 * client uses the user's authenticated session for queries; RLS policies
 * (see `supabase/migrations/0002_auth_rls_update.sql`) restrict reads to
 * the `authenticated` role.
 *
 * For server-side scripts (db:apply, prompts sync) we use the access token
 * + Management API directly — never the service_role key in client code.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase credentials. Copy .env.example to .env.local and fill in the values.",
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
