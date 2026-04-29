/**
 * AppUser type — re-exports the generated Supabase Row type for the
 * `public.app_users` table that mirrors `auth.users` with role + profile.
 *
 * The shape is auto-generated in src/types/database.ts from the live schema.
 * Run `bun run db:types` after every migration touching app_users.
 */
import type { Database } from "./database";

export type AppUser = Database["public"]["Tables"]["app_users"]["Row"];
export type AppUserInsert = Database["public"]["Tables"]["app_users"]["Insert"];
export type AppUserUpdate = Database["public"]["Tables"]["app_users"]["Update"];
export type AppRole = Database["public"]["Enums"]["app_role"];
