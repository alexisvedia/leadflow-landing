import { createClient } from '@supabase/supabase-js';

// Lazy initialization to avoid build-time errors when env vars are not available
let supabase: ReturnType<typeof createClient> | null = null;

export function getSupabaseServer() {
  if (!supabase && import.meta.env.PUBLIC_SUPABASE_URL && import.meta.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(
      import.meta.env.PUBLIC_SUPABASE_URL,
      import.meta.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}
