-- PullLeads Database Migration
-- Run this in Supabase SQL Editor to update existing installations

-- ============================================
-- 1. Add new providers to integrations table
-- ============================================

-- Drop existing constraint
ALTER TABLE public.integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;

-- Add new constraint with all providers
ALTER TABLE public.integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('hubspot', 'google_sheets', 'webhook', 'salesforce', 'airtable'));

-- ============================================
-- 2. Add index for faster webhook lookups
-- ============================================

CREATE INDEX IF NOT EXISTS idx_extractions_apify_run_id
  ON public.extractions(apify_run_id)
  WHERE apify_run_id IS NOT NULL;

-- ============================================
-- 3. Add rate limiting table (optional, for Redis-free deployments)
-- ============================================

CREATE TABLE IF NOT EXISTS public.rate_limits (
  id TEXT PRIMARY KEY, -- format: "prefix:user_id"
  count INTEGER DEFAULT 1,
  reset_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-cleanup old rate limit entries
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON public.rate_limits(reset_at);

-- Function to clean up expired entries (run via cron or pg_cron)
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS void AS $$
BEGIN
  DELETE FROM public.rate_limits WHERE reset_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 4. Add extraction results caching
-- ============================================

-- Add column to cache lead count for faster dashboard queries
ALTER TABLE public.extractions
  ADD COLUMN IF NOT EXISTS cached_email_count INTEGER,
  ADD COLUMN IF NOT EXISTS cached_phone_count INTEGER,
  ADD COLUMN IF NOT EXISTS cached_owner_count INTEGER;

-- Function to update cached counts
CREATE OR REPLACE FUNCTION public.update_extraction_cache(p_extraction_id UUID)
RETURNS void AS $$
DECLARE
  v_leads JSONB;
  v_email_count INTEGER;
  v_phone_count INTEGER;
  v_owner_count INTEGER;
BEGIN
  SELECT result_data INTO v_leads
  FROM public.extractions
  WHERE id = p_extraction_id;

  IF v_leads IS NULL THEN
    RETURN;
  END IF;

  -- Count leads with email
  SELECT COUNT(*) INTO v_email_count
  FROM jsonb_array_elements(COALESCE(v_leads->'leads', v_leads)) AS lead
  WHERE lead->>'email' IS NOT NULL AND lead->>'email' != '';

  -- Count leads with phone
  SELECT COUNT(*) INTO v_phone_count
  FROM jsonb_array_elements(COALESCE(v_leads->'leads', v_leads)) AS lead
  WHERE lead->>'phone' IS NOT NULL AND lead->>'phone' != '';

  -- Count leads with owner name
  SELECT COUNT(*) INTO v_owner_count
  FROM jsonb_array_elements(COALESCE(v_leads->'leads', v_leads)) AS lead
  WHERE (lead->>'ownerName' IS NOT NULL AND lead->>'ownerName' != '')
     OR (lead->>'owner_name' IS NOT NULL AND lead->>'owner_name' != '');

  -- Update cache
  UPDATE public.extractions
  SET cached_email_count = v_email_count,
      cached_phone_count = v_phone_count,
      cached_owner_count = v_owner_count
  WHERE id = p_extraction_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. Usage analytics table
-- ============================================

CREATE TABLE IF NOT EXISTS public.usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users ON DELETE SET NULL,
  action TEXT NOT NULL, -- 'extraction', 'export', 'sync'
  provider TEXT, -- 'hubspot', 'salesforce', etc.
  count INTEGER DEFAULT 1,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON public.usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON public.usage_logs(created_at);

-- Enable RLS
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own logs
CREATE POLICY "Users can view own usage logs"
  ON public.usage_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert
CREATE POLICY "Service role can insert usage logs"
  ON public.usage_logs FOR INSERT
  WITH CHECK (true);

-- ============================================
-- DONE!
-- ============================================
