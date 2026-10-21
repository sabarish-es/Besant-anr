export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY?: string;
  ADMIN_EMAIL: string;
}

export type AuthUser = {
  id: string;
  email: string;
  email_confirmed_at?: string;
  user_metadata?: { full_name?: string; name?: string };
};

export type Session = { user: AuthUser | null; cookies: string[] };
