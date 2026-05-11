/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL — e.g. https://abcdefghijklmnop.supabase.co */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase publishable / anon key — safe to expose in client. */
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
